import { DurableObject } from 'cloudflare:workers'

export const APP_REALTIME_PROTOCOL = 'meigallery.realtime.v1' as const
export const APP_REALTIME_EVENT_SCHEMA_VERSION = 1 as const

export const APP_REALTIME_REFRESH_SCOPES = [
  'account',
  'conversations',
  'messages',
  'notifications',
  'membership',
  'wallet',
] as const

export type AppRealtimeRefreshScope = (typeof APP_REALTIME_REFRESH_SCOPES)[number]

export interface AppRealtimeHubInitializeCommand {
  accountKey: string
  maxConnections: number
  replayEventLimit: number
  retainedEventLimit: number
}

export interface AppRealtimeHubPublishCommand {
  dedupeHash: string
  scopes: AppRealtimeRefreshScope[]
  occurredAt: string
}

export interface AppRealtimeHubPublishResult {
  published: boolean
  replayed: boolean
  cursor: number
}

type HubIdentityRow = {
  account_key: string
  max_connections: number
  replay_event_limit: number
  retained_event_limit: number
}

type StoredRefreshEventRow = {
  cursor: number
  event_id: string
  refresh_scopes_json: string
  occurred_at: string
}

type ConnectionAttachment = {
  connectionId: string
  sessionId: string
  deviceId: string
  ticketId: string
  connectedAt: string
  helloReceived: boolean
}

type ClientHello = {
  type: 'client.hello'
  schemaVersion: 1
  lastCursor: number
}

const ACCOUNT_KEY_PATTERN = /^account:[1-9][0-9]{0,18}$/u
const CONNECTION_ID_PATTERN = /^rtc_[A-Za-z0-9_-]{12,88}$/u
const SESSION_ID_PATTERN = /^aps_[A-Za-z0-9_-]{8,88}$/u
const DEVICE_ID_PATTERN = /^apd_[A-Za-z0-9_-]{8,88}$/u
const TICKET_ID_PATTERN = /^rtk_[A-Za-z0-9_-]{12,88}$/u
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_CLIENT_FRAME_BYTES = 2048
const CLIENT_HELLO_TIMEOUT_MS = 15_000
const CLOSE_POLICY_VIOLATION = 4000
const CLOSE_SESSION_REVOKED = 4001
const CLOSE_DEVICE_REVOKED = 4002
const CLOSE_ACCOUNT_REVOKED = 4003

/**
 * 账号级最小实时刷新协调器。
 *
 * D1 仍是消息、通知、会员与钱包的唯一业务权威；本 DO 只持久化无正文、
 * 无账号资料的刷新游标，并通过 Hibernation WebSocket 提示客户端重新走 HTTP 对账。
 */
export class AppRealtimeHub extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.migrateStorage()
    })
  }

  initialize(command: AppRealtimeHubInitializeCommand): { initialized: true } {
    const normalized = normalizeInitializeCommand(command)
    const existing = this.readIdentity()
    if (existing && existing.account_key !== normalized.accountKey) {
      throw new Error('APP_REALTIME_HUB_IDENTITY_CONFLICT')
    }

    if (!existing) {
      this.ctx.storage.sql.exec(`
        INSERT INTO hub_identity (
          singleton, account_key, max_connections, replay_event_limit,
          retained_event_limit, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `,
      normalized.accountKey,
      normalized.maxConnections,
      normalized.replayEventLimit,
      normalized.retainedEventLimit,
      new Date().toISOString(),
      new Date().toISOString())
    }
    else if (
      existing.max_connections !== normalized.maxConnections
      || existing.replay_event_limit !== normalized.replayEventLimit
      || existing.retained_event_limit !== normalized.retainedEventLimit
    ) {
      this.ctx.storage.sql.exec(`
        UPDATE hub_identity
        SET max_connections = ?, replay_event_limit = ?, retained_event_limit = ?, updated_at = ?
        WHERE singleton = 1 AND account_key = ?
      `,
      normalized.maxConnections,
      normalized.replayEventLimit,
      normalized.retainedEventLimit,
      new Date().toISOString(),
      normalized.accountKey)
    }
    return { initialized: true }
  }

  publish(command: AppRealtimeHubPublishCommand): AppRealtimeHubPublishResult {
    const identity = this.requireIdentity()
    const normalized = normalizePublishCommand(command)
    const existing = this.ctx.storage.sql.exec<StoredRefreshEventRow>(`
      SELECT cursor, event_id, refresh_scopes_json, occurred_at
      FROM realtime_refresh_events
      WHERE dedupe_hash = ?
      LIMIT 1
    `, normalized.dedupeHash).toArray()[0]
    if (existing) {
      return { published: false, replayed: true, cursor: existing.cursor }
    }

    const eventId = `rte_${crypto.randomUUID().replace(/-/gu, '')}`
    this.ctx.storage.sql.exec(`
      INSERT INTO realtime_refresh_events (
        event_id, dedupe_hash, refresh_scopes_json, occurred_at
      ) VALUES (?, ?, ?, ?)
    `, eventId, normalized.dedupeHash, JSON.stringify(normalized.scopes), normalized.occurredAt)
    const event = this.ctx.storage.sql.exec<StoredRefreshEventRow>(`
      SELECT cursor, event_id, refresh_scopes_json, occurred_at
      FROM realtime_refresh_events
      WHERE event_id = ?
      LIMIT 1
    `, eventId).one()

    const maximum = event.cursor - identity.retained_event_limit
    if (maximum > 0) {
      this.ctx.storage.sql.exec(
        'DELETE FROM realtime_refresh_events WHERE cursor <= ?',
        maximum,
      )
    }

    const frame = JSON.stringify(toRefreshFrame(event))
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket)
      if (!attachment?.helloReceived) continue
      try {
        socket.send(frame)
      }
      catch {
        safeClose(socket, 1011, 'refresh_delivery_failed')
      }
    }
    return { published: true, replayed: false, cursor: event.cursor }
  }

  disconnectDevice(deviceId: string): { closed: number } {
    if (!DEVICE_ID_PATTERN.test(deviceId)) return { closed: 0 }
    return this.closeMatching(
      attachment => attachment.deviceId === deviceId,
      CLOSE_DEVICE_REVOKED,
      'device_revoked',
    )
  }

  disconnectSession(sessionId: string): { closed: number } {
    if (!SESSION_ID_PATTERN.test(sessionId)) return { closed: 0 }
    return this.closeMatching(
      attachment => attachment.sessionId === sessionId,
      CLOSE_SESSION_REVOKED,
      'session_revoked',
    )
  }

  disconnectAll(): { closed: number } {
    return this.closeMatching(() => true, CLOSE_ACCOUNT_REVOKED, 'account_revoked')
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/connect') {
      return new Response('Not Found', { status: 404 })
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket Upgrade Required', {
        status: 426,
        headers: { Upgrade: 'websocket' },
      })
    }

    const identity = this.requireIdentity()
    const accountKey = request.headers.get('X-MeiGallery-Realtime-Account-Key') ?? ''
    const attachment = readConnectionHeaders(request.headers)
    if (accountKey !== identity.account_key || !attachment) {
      return new Response('Unauthorized', { status: 401 })
    }
    if (this.ctx.getWebSockets().length >= identity.max_connections) {
      return new Response('Too Many Connections', {
        status: 429,
        headers: { 'Retry-After': '5' },
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [
      `device:${attachment.deviceId}`,
      `session:${attachment.sessionId}`,
    ])
    server.serializeAttachment(attachment)
    await this.schedulePendingHelloAlarm()
    try {
      server.send(JSON.stringify({
        type: 'server.ready',
        schemaVersion: APP_REALTIME_EVENT_SCHEMA_VERSION,
        protocol: APP_REALTIME_PROTOCOL,
        serverTime: new Date().toISOString(),
      }))
    }
    catch {
      safeClose(server, 1011, 'ready_delivery_failed')
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_CLIENT_FRAME_BYTES) {
      safeClose(socket, CLOSE_POLICY_VIOLATION, 'invalid_frame')
      return
    }
    let input: unknown
    try {
      input = JSON.parse(message)
    }
    catch {
      safeClose(socket, CLOSE_POLICY_VIOLATION, 'invalid_json')
      return
    }
    if (!isClientHello(input)) {
      safeClose(socket, CLOSE_POLICY_VIOLATION, 'unsupported_command')
      return
    }

    const attachment = readAttachment(socket)
    if (!attachment) {
      safeClose(socket, CLOSE_POLICY_VIOLATION, 'connection_state_missing')
      return
    }
    if (attachment.helloReceived) {
      safeClose(socket, CLOSE_POLICY_VIOLATION, 'duplicate_hello')
      return
    }
    socket.serializeAttachment({ ...attachment, helloReceived: true })
    this.replayAfter(socket, input.lastCursor)
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let nextDeadline: number | null = null
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket)
      if (!attachment || attachment.helloReceived) continue
      const deadline = Date.parse(attachment.connectedAt) + CLIENT_HELLO_TIMEOUT_MS
      if (!Number.isFinite(deadline) || deadline <= now) {
        safeClose(socket, CLOSE_POLICY_VIOLATION, 'client_hello_timeout')
      }
      else {
        nextDeadline = nextDeadline === null ? deadline : Math.min(nextDeadline, deadline)
      }
    }
    if (nextDeadline !== null) await this.ctx.storage.setAlarm(nextDeadline)
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    safeClose(socket, normalizeCloseCode(code), normalizeCloseReason(reason))
  }

  webSocketError(socket: WebSocket): void {
    safeClose(socket, 1011, 'connection_error')
  }

  private migrateStorage(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        account_key TEXT NOT NULL UNIQUE,
        max_connections INTEGER NOT NULL,
        replay_event_limit INTEGER NOT NULL,
        retained_event_limit INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS realtime_refresh_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        dedupe_hash TEXT NOT NULL UNIQUE,
        refresh_scopes_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_realtime_refresh_events_time
        ON realtime_refresh_events(occurred_at DESC, cursor DESC);
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, datetime('now'));
    `)
  }

  private readIdentity(): HubIdentityRow | null {
    return this.ctx.storage.sql.exec<HubIdentityRow>(`
      SELECT account_key, max_connections, replay_event_limit, retained_event_limit
      FROM hub_identity
      WHERE singleton = 1
      LIMIT 1
    `).toArray()[0] ?? null
  }

  private requireIdentity(): HubIdentityRow {
    const identity = this.readIdentity()
    if (!identity) throw new Error('APP_REALTIME_HUB_NOT_INITIALIZED')
    return identity
  }

  private replayAfter(socket: WebSocket, lastCursor: number): void {
    const identity = this.requireIdentity()
    const range = this.ctx.storage.sql.exec<{ minimum: number; maximum: number }>(`
      SELECT COALESCE(MIN(cursor), 0) AS minimum, COALESCE(MAX(cursor), 0) AS maximum
      FROM realtime_refresh_events
    `).one()
    const cannotReplay = lastCursor === 0
      || lastCursor > range.maximum
      || (range.minimum > 0 && lastCursor < range.minimum - 1)
    if (cannotReplay) {
      socket.send(JSON.stringify(toFullSyncFrame(range.maximum)))
      socket.send(JSON.stringify(toSyncedFrame(range.maximum)))
      return
    }

    const rows = this.ctx.storage.sql.exec<StoredRefreshEventRow>(`
      SELECT cursor, event_id, refresh_scopes_json, occurred_at
      FROM realtime_refresh_events
      WHERE cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `, lastCursor, identity.replay_event_limit + 1).toArray()
    if (rows.length > identity.replay_event_limit) {
      socket.send(JSON.stringify(toFullSyncFrame(range.maximum)))
    }
    else {
      for (const row of rows) socket.send(JSON.stringify(toRefreshFrame(row)))
    }
    socket.send(JSON.stringify(toSyncedFrame(range.maximum)))
  }

  private closeMatching(
    predicate: (attachment: ConnectionAttachment) => boolean,
    code: number,
    reason: string,
  ): { closed: number } {
    let closed = 0
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket)
      if (attachment && predicate(attachment)) {
        safeClose(socket, code, reason)
        closed += 1
      }
    }
    return { closed }
  }

  private async schedulePendingHelloAlarm(): Promise<void> {
    const deadline = Date.now() + CLIENT_HELLO_TIMEOUT_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline)
  }
}

function normalizeInitializeCommand(command: AppRealtimeHubInitializeCommand) {
  const accountKey = String(command?.accountKey ?? '').trim()
  const maxConnections = Number(command?.maxConnections)
  const replayEventLimit = Number(command?.replayEventLimit)
  const retainedEventLimit = Number(command?.retainedEventLimit)
  if (
    !ACCOUNT_KEY_PATTERN.test(accountKey)
    || !Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 8
    || !Number.isInteger(replayEventLimit) || replayEventLimit < 16 || replayEventLimit > 256
    || !Number.isInteger(retainedEventLimit) || retainedEventLimit < 32 || retainedEventLimit > 512
    || retainedEventLimit < replayEventLimit
  ) {
    throw new Error('APP_REALTIME_HUB_CONFIG_INVALID')
  }
  return { accountKey, maxConnections, replayEventLimit, retainedEventLimit }
}

function normalizePublishCommand(command: AppRealtimeHubPublishCommand) {
  const dedupeHash = String(command?.dedupeHash ?? '').trim()
  const occurredAt = String(command?.occurredAt ?? '').trim()
  const allowed = new Set<string>(APP_REALTIME_REFRESH_SCOPES)
  const scopes = [...new Set(Array.isArray(command?.scopes) ? command.scopes : [])]
    .filter((scope): scope is AppRealtimeRefreshScope => allowed.has(scope))
    .sort()
  if (
    !SHA256_HEX_PATTERN.test(dedupeHash)
    || !UTC_TIMESTAMP_PATTERN.test(occurredAt)
    || Number.isNaN(Date.parse(occurredAt))
    || scopes.length === 0
  ) {
    throw new Error('APP_REALTIME_EVENT_INVALID')
  }
  return { dedupeHash, occurredAt, scopes }
}

function readConnectionHeaders(headers: Headers): ConnectionAttachment | null {
  const connectionId = headers.get('X-MeiGallery-Realtime-Connection-Id') ?? ''
  const sessionId = headers.get('X-MeiGallery-Realtime-Session-Id') ?? ''
  const deviceId = headers.get('X-MeiGallery-Realtime-Device-Id') ?? ''
  const ticketId = headers.get('X-MeiGallery-Realtime-Ticket-Id') ?? ''
  const connectedAt = headers.get('X-MeiGallery-Realtime-Connected-At') ?? ''
  if (
    !CONNECTION_ID_PATTERN.test(connectionId)
    || !SESSION_ID_PATTERN.test(sessionId)
    || !DEVICE_ID_PATTERN.test(deviceId)
    || !TICKET_ID_PATTERN.test(ticketId)
    || !UTC_TIMESTAMP_PATTERN.test(connectedAt)
    || Number.isNaN(Date.parse(connectedAt))
  ) return null
  return {
    connectionId,
    sessionId,
    deviceId,
    ticketId,
    connectedAt,
    helloReceived: false,
  }
}

function readAttachment(socket: WebSocket): ConnectionAttachment | null {
  const value = socket.deserializeAttachment() as Partial<ConnectionAttachment> | null
  if (!value || typeof value !== 'object') return null
  const attachment = {
    connectionId: String(value.connectionId ?? ''),
    sessionId: String(value.sessionId ?? ''),
    deviceId: String(value.deviceId ?? ''),
    ticketId: String(value.ticketId ?? ''),
    connectedAt: String(value.connectedAt ?? ''),
    helloReceived: value.helloReceived === true,
  }
  return CONNECTION_ID_PATTERN.test(attachment.connectionId)
    && SESSION_ID_PATTERN.test(attachment.sessionId)
    && DEVICE_ID_PATTERN.test(attachment.deviceId)
    && TICKET_ID_PATTERN.test(attachment.ticketId)
    && UTC_TIMESTAMP_PATTERN.test(attachment.connectedAt)
    ? attachment
    : null
}

function isClientHello(value: unknown): value is ClientHello {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return Object.keys(input).every(key => ['type', 'schemaVersion', 'lastCursor'].includes(key))
    && input.type === 'client.hello'
    && input.schemaVersion === APP_REALTIME_EVENT_SCHEMA_VERSION
    && Number.isInteger(input.lastCursor)
    && Number(input.lastCursor) >= 0
    && Number(input.lastCursor) <= Number.MAX_SAFE_INTEGER
}

function toRefreshFrame(row: StoredRefreshEventRow) {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.refresh_scopes_json)
  }
  catch {
    parsed = []
  }
  const allowed = new Set<string>(APP_REALTIME_REFRESH_SCOPES)
  const scopes = Array.isArray(parsed)
    ? parsed.filter((scope): scope is AppRealtimeRefreshScope => typeof scope === 'string' && allowed.has(scope))
    : []
  return {
    type: 'refresh.required' as const,
    schemaVersion: APP_REALTIME_EVENT_SCHEMA_VERSION,
    eventId: row.event_id,
    cursor: row.cursor,
    occurredAt: row.occurred_at,
    scopes,
  }
}

function toFullSyncFrame(cursor: number) {
  return {
    type: 'refresh.required' as const,
    schemaVersion: APP_REALTIME_EVENT_SCHEMA_VERSION,
    eventId: `rte_sync_${crypto.randomUUID().replace(/-/gu, '')}`,
    cursor,
    occurredAt: new Date().toISOString(),
    scopes: [...APP_REALTIME_REFRESH_SCOPES],
  }
}

function toSyncedFrame(cursor: number) {
  return {
    type: 'server.synced' as const,
    schemaVersion: APP_REALTIME_EVENT_SCHEMA_VERSION,
    cursor,
    serverTime: new Date().toISOString(),
  }
}

function safeClose(socket: WebSocket, code: number, reason: string) {
  try {
    socket.close(code, reason.slice(0, 80))
  }
  catch {
    // 连接已关闭时无需再次抛出；业务权威状态仍由 D1/HTTP 保证。
  }
}

function normalizeCloseCode(code: number) {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000
}

function normalizeCloseReason(reason: string) {
  const normalized = String(reason ?? '').replace(/[\u0000-\u001F\u007F]/gu, '').trim()
  return normalized.slice(0, 80) || 'client_closed'
}
