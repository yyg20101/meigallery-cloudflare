import type { AppSessionPrincipal } from './app-account-access'
import type { Bindings } from '../index'
import {
  APP_REALTIME_EVENT_SCHEMA_VERSION,
  APP_REALTIME_PROTOCOL,
  type AppRealtimeHub,
  type AppRealtimeRefreshScope,
} from '../durable-objects/app-realtime-hub'

export const APP_REALTIME_POLICY_ID = 'rtp_app_1_0_message_4_dev_1'
export const APP_REALTIME_TICKET_PATH = '/api/v2/realtime/tickets' as const
export const APP_REALTIME_CONNECT_PATH = '/api/v2/realtime/connect' as const
export const APP_REALTIME_TRANSPORT = 'websocket_refresh' as const

type RealtimeBindings = Pick<Bindings,
  | 'DB'
  | 'APP_ENV'
  | 'APP_REALTIME_ENABLED'
  | 'APP_REALTIME_POLICY_VERSION'
  | 'APP_REALTIME_PRODUCTION_READY'
  | 'APP_REALTIME_HUB'
>

type RealtimePolicyRow = {
  id: string
  version_code: string
  state: string
  enabled: number
  production_ready: number
  capacity_decision_status: string
  governance_reference: string | null
  ticket_ttl_seconds: number
  max_pending_tickets_per_account: number
  max_connections_per_account: number
  replay_event_limit: number
  retained_event_limit: number
  reconnect_min_delay_ms: number
  reconnect_max_delay_ms: number
}

type ConsumedTicketRow = {
  id: string
  account_id: number
  session_id: string
  device_id: string
}

export interface AppRealtimeCapability {
  enabled: boolean
  policyId: string
  transport: typeof APP_REALTIME_TRANSPORT
  protocol: typeof APP_REALTIME_PROTOCOL
  ticketPath: typeof APP_REALTIME_TICKET_PATH
  connectPath: typeof APP_REALTIME_CONNECT_PATH
  eventSchemaVersion: typeof APP_REALTIME_EVENT_SCHEMA_VERSION
  ticketTtlSeconds: number
  reconnectMinDelayMs: number
  reconnectMaxDelayMs: number
  maxConnectionsPerAccount: number
  reasonCode: string | null
}

export interface AppRealtimeTicket {
  ticket: string
  protocol: typeof APP_REALTIME_PROTOCOL
  connectPath: typeof APP_REALTIME_CONNECT_PATH
  expiresAt: string
}

export class AppRealtimeError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppRealtimeError'
  }
}

export async function resolveAppRealtimeCapability(
  env: RealtimeBindings,
  businessEligible: boolean,
): Promise<AppRealtimeCapability> {
  const requestedPolicyId = normalizePolicyId(env.APP_REALTIME_POLICY_VERSION)
  const base = disabledCapability(requestedPolicyId ?? APP_REALTIME_POLICY_ID)
  if (env.APP_REALTIME_ENABLED !== 'true') return { ...base, reasonCode: 'runtime_disabled' }
  if (!env.APP_REALTIME_HUB) return { ...base, reasonCode: 'binding_unavailable' }
  if (!businessEligible) return { ...base, reasonCode: 'business_capability_unavailable' }
  if (!requestedPolicyId) return { ...base, reasonCode: 'policy_id_invalid' }

  let row: RealtimePolicyRow | null
  try {
    row = await readRealtimePolicy(env.DB, requestedPolicyId)
  }
  catch {
    return { ...base, reasonCode: 'policy_storage_unavailable' }
  }
  if (!row) return { ...base, reasonCode: 'policy_missing' }
  if (!isPolicyShapeValid(row)) return { ...base, reasonCode: 'policy_invalid' }
  if (
    row.state !== 'published'
    || row.enabled !== 1
    || row.capacity_decision_status !== 'approved'
    || !row.governance_reference?.trim()
  ) return { ...base, reasonCode: 'governance_gate_closed' }
  if (
    env.APP_ENV === 'production'
    && (env.APP_REALTIME_PRODUCTION_READY !== 'true' || row.production_ready !== 1)
  ) return { ...base, reasonCode: 'production_gate_closed' }

  return {
    enabled: true,
    policyId: row.id,
    transport: APP_REALTIME_TRANSPORT,
    protocol: APP_REALTIME_PROTOCOL,
    ticketPath: APP_REALTIME_TICKET_PATH,
    connectPath: APP_REALTIME_CONNECT_PATH,
    eventSchemaVersion: APP_REALTIME_EVENT_SCHEMA_VERSION,
    ticketTtlSeconds: row.ticket_ttl_seconds,
    reconnectMinDelayMs: row.reconnect_min_delay_ms,
    reconnectMaxDelayMs: row.reconnect_max_delay_ms,
    maxConnectionsPerAccount: row.max_connections_per_account,
    reasonCode: null,
  }
}

export async function issueAppRealtimeTicket(
  env: RealtimeBindings,
  principal: AppSessionPrincipal,
  requestId: string,
  businessEligible: boolean,
  now = new Date(),
): Promise<AppRealtimeTicket> {
  const capability = await requireRealtimeCapability(env, businessEligible)
  const policy = await requireRealtimePolicy(env.DB, capability.policyId)
  const nowIso = now.toISOString()
  await env.DB.prepare(`
    UPDATE app_realtime_tickets
    SET cancelled_at = ?, cancellation_reason = 'expired_before_use'
    WHERE account_id = ?
      AND consumed_at IS NULL
      AND cancelled_at IS NULL
      AND datetime(expires_at) <= datetime(?)
  `).bind(nowIso, principal.accountInternalId, nowIso).run()

  const pending = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM app_realtime_tickets
    WHERE account_id = ?
      AND consumed_at IS NULL
      AND cancelled_at IS NULL
      AND datetime(expires_at) > datetime(?)
  `).bind(principal.accountInternalId, nowIso).first<{ count: number }>()
  if (Number(pending?.count ?? 0) >= policy.max_pending_tickets_per_account) {
    throw new AppRealtimeError(
      429,
      'REALTIME_TICKET_RATE_LIMITED',
      '实时连接请求过于频繁，请稍后重试',
      true,
    )
  }

  const ticket = randomOpaqueToken('mrt')
  const ticketId = randomRecordId('rtk')
  const tokenHash = await sha256Hex(ticket)
  const expiresAt = new Date(now.getTime() + policy.ticket_ttl_seconds * 1000).toISOString()
  try {
    await env.DB.prepare(`
      INSERT INTO app_realtime_tickets (
        id, token_hash, policy_id, account_id, session_id, device_id,
        request_id, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ticketId,
      tokenHash,
      policy.id,
      principal.accountInternalId,
      principal.sessionId,
      principal.deviceId,
      normalizeRequestId(requestId),
      nowIso,
      expiresAt,
    ).run()
  }
  catch {
    throw new AppRealtimeError(
      503,
      'REALTIME_TICKET_UNAVAILABLE',
      '实时连接票据暂时无法签发',
      true,
    )
  }
  return {
    ticket,
    protocol: APP_REALTIME_PROTOCOL,
    connectPath: APP_REALTIME_CONNECT_PATH,
    expiresAt,
  }
}

export async function connectAppRealtime(
  env: RealtimeBindings,
  authorization: string | undefined,
  upgrade: string | undefined,
  businessEligible: boolean,
  now = new Date(),
): Promise<Response> {
  if (upgrade?.toLowerCase() !== 'websocket') {
    throw new AppRealtimeError(400, 'WEBSOCKET_UPGRADE_REQUIRED', '实时连接必须使用 WebSocket Upgrade')
  }
  const capability = await requireRealtimeCapability(env, businessEligible)
  const ticket = readRealtimeTicket(authorization)
  const tokenHash = await sha256Hex(ticket)
  const nowIso = now.toISOString()
  const connectionId = randomRecordId('rtc')
  const claimed = await env.DB.prepare(`
    UPDATE app_realtime_tickets
    SET consumed_at = ?, connection_id = ?
    WHERE token_hash = ?
      AND policy_id = ?
      AND consumed_at IS NULL
      AND cancelled_at IS NULL
      AND datetime(expires_at) > datetime(?)
      AND EXISTS (
        SELECT 1
        FROM app_sessions session
        JOIN app_devices device
          ON device.id = session.device_id
         AND device.account_id = session.account_id
        JOIN app_account_security security
          ON security.account_id = session.account_id
        JOIN users account
          ON account.id = session.account_id
        WHERE session.id = app_realtime_tickets.session_id
          AND session.account_id = app_realtime_tickets.account_id
          AND session.device_id = app_realtime_tickets.device_id
          AND session.status = 'active'
          AND datetime(session.access_expires_at) > datetime(?)
          AND datetime(session.refresh_expires_at) > datetime(?)
          AND session.account_session_version = security.session_version
          AND session.device_session_version = device.session_version
          AND device.status = 'active'
          AND security.status = 'active'
          AND account.status = 'active'
      )
  `).bind(nowIso, connectionId, tokenHash, capability.policyId, nowIso, nowIso, nowIso).run()
  if (Number(claimed.meta?.changes ?? 0) !== 1) {
    throw new AppRealtimeError(401, 'REALTIME_TICKET_INVALID', '实时连接票据无效或已过期')
  }

  const consumed = await env.DB.prepare(`
    SELECT id, account_id, session_id, device_id
    FROM app_realtime_tickets
    WHERE connection_id = ? AND consumed_at = ?
    LIMIT 1
  `).bind(connectionId, nowIso).first<ConsumedTicketRow>()
  if (!consumed) {
    throw new AppRealtimeError(503, 'REALTIME_CONNECTION_UNAVAILABLE', '实时连接暂不可用', true)
  }

  const policy = await requireRealtimePolicy(env.DB, capability.policyId)
  const namespace = env.APP_REALTIME_HUB
  if (!namespace) {
    throw new AppRealtimeError(503, 'REALTIME_CONNECTION_UNAVAILABLE', '实时连接暂不可用', true)
  }
  const stub = namespace.getByName(accountHubName(consumed.account_id), { locationHint: 'apac' })
  try {
    await stub.initialize({
      accountKey: accountHubName(consumed.account_id),
      maxConnections: policy.max_connections_per_account,
      replayEventLimit: policy.replay_event_limit,
      retainedEventLimit: policy.retained_event_limit,
    })
    return await stub.fetch(new Request('https://app-realtime.internal/connect', {
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        'X-MeiGallery-Realtime-Account-Key': accountHubName(consumed.account_id),
        'X-MeiGallery-Realtime-Connection-Id': connectionId,
        'X-MeiGallery-Realtime-Session-Id': consumed.session_id,
        'X-MeiGallery-Realtime-Device-Id': consumed.device_id,
        'X-MeiGallery-Realtime-Ticket-Id': consumed.id,
        'X-MeiGallery-Realtime-Connected-At': nowIso,
      },
    }))
  }
  catch {
    throw new AppRealtimeError(503, 'REALTIME_CONNECTION_UNAVAILABLE', '实时连接暂不可用', true)
  }
}

export async function publishAppRealtimeRefresh(
  env: RealtimeBindings,
  input: {
    accountId: number
    dedupeKey: string
    scopes: AppRealtimeRefreshScope[]
    occurredAt?: Date
  },
): Promise<{ published: boolean; cursor: number | null }> {
  if (!Number.isInteger(input.accountId) || input.accountId <= 0) return { published: false, cursor: null }
  const normalizedDedupeKey = input.dedupeKey.trim()
  if (normalizedDedupeKey.length < 8 || normalizedDedupeKey.length > 240) {
    return { published: false, cursor: null }
  }
  const allowedScopes = normalizeScopes(input.scopes)
  if (allowedScopes.length === 0) return { published: false, cursor: null }
  const capability = await resolveAppRealtimeCapability(env, true)
  if (!capability.enabled || !env.APP_REALTIME_HUB) return { published: false, cursor: null }
  const policy = await requireRealtimePolicy(env.DB, capability.policyId)
  const stub = env.APP_REALTIME_HUB.getByName(accountHubName(input.accountId), { locationHint: 'apac' })
  await stub.initialize({
    accountKey: accountHubName(input.accountId),
    maxConnections: policy.max_connections_per_account,
    replayEventLimit: policy.replay_event_limit,
    retainedEventLimit: policy.retained_event_limit,
  })
  const result = await stub.publish({
    dedupeHash: await sha256Hex(`${input.accountId}\n${normalizedDedupeKey}\n${allowedScopes.join(',')}`),
    scopes: allowedScopes,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
  })
  return { published: result.published, cursor: result.cursor }
}

export async function publishAppRealtimeConversationRefresh(
  env: RealtimeBindings,
  input: {
    conversationId: string
    dedupeKey: string
    scopes: Array<Extract<AppRealtimeRefreshScope, 'conversations' | 'messages'>>
    occurredAt?: Date
  },
): Promise<{ published: boolean; cursor: number | null }> {
  if (env.APP_REALTIME_ENABLED !== 'true' || !env.APP_REALTIME_HUB) {
    return { published: false, cursor: null }
  }
  const conversationId = input.conversationId.trim()
  if (!/^cv_[A-Za-z0-9_-]{1,77}$/u.test(conversationId)) {
    return { published: false, cursor: null }
  }
  const conversation = await env.DB.prepare(`
    SELECT account_id
    FROM app_conversations
    WHERE id = ?
    LIMIT 1
  `).bind(conversationId).first<{ account_id: number }>()
  if (!conversation) return { published: false, cursor: null }
  return publishAppRealtimeRefresh(env, {
    accountId: Number(conversation.account_id),
    dedupeKey: input.dedupeKey,
    scopes: input.scopes,
    occurredAt: input.occurredAt,
  })
}

export async function publishAppRealtimePublicAccountRefresh(
  env: RealtimeBindings,
  input: {
    accountPublicId: string
    dedupeKey: string
    scopes: AppRealtimeRefreshScope[]
    occurredAt?: Date
  },
): Promise<{ published: boolean; cursor: number | null }> {
  if (env.APP_REALTIME_ENABLED !== 'true' || !env.APP_REALTIME_HUB) {
    return { published: false, cursor: null }
  }
  const accountPublicId = input.accountPublicId.trim()
  if (!/^acc_[A-Za-z0-9_-]{1,76}$/u.test(accountPublicId)) {
    return { published: false, cursor: null }
  }
  const account = await env.DB.prepare(`
    SELECT account_id
    FROM app_account_security
    WHERE account_public_id = ?
    LIMIT 1
  `).bind(accountPublicId).first<{ account_id: number }>()
  if (!account) return { published: false, cursor: null }
  return publishAppRealtimeRefresh(env, {
    accountId: Number(account.account_id),
    dedupeKey: input.dedupeKey,
    scopes: input.scopes,
    occurredAt: input.occurredAt,
  })
}

export async function disconnectAppRealtimeDevice(
  env: Pick<Bindings, 'APP_REALTIME_HUB'>,
  accountId: number,
  deviceId: string,
) {
  if (!env.APP_REALTIME_HUB || !Number.isInteger(accountId) || accountId <= 0) return { closed: 0 }
  return env.APP_REALTIME_HUB.getByName(accountHubName(accountId), { locationHint: 'apac' })
    .disconnectDevice(deviceId)
}

export async function disconnectAppRealtimeSession(
  env: Pick<Bindings, 'APP_REALTIME_HUB'>,
  accountId: number,
  sessionId: string,
) {
  if (!env.APP_REALTIME_HUB || !Number.isInteger(accountId) || accountId <= 0) return { closed: 0 }
  return env.APP_REALTIME_HUB.getByName(accountHubName(accountId), { locationHint: 'apac' })
    .disconnectSession(sessionId)
}

export async function disconnectAppRealtimeAccount(
  env: Pick<Bindings, 'APP_REALTIME_HUB'>,
  accountId: number,
) {
  if (!env.APP_REALTIME_HUB || !Number.isInteger(accountId) || accountId <= 0) return { closed: 0 }
  return env.APP_REALTIME_HUB.getByName(accountHubName(accountId), { locationHint: 'apac' })
    .disconnectAll()
}

export function scheduleAppRealtimeTask(
  executionCtx: { waitUntil(task: Promise<unknown>): void } | undefined,
  task: Promise<unknown>,
  operation: string,
) {
  const guarded = task.catch(() => {
    console.error('App 实时刷新任务失败', { operation })
  })
  try {
    executionCtx?.waitUntil(guarded)
  }
  catch {
    void guarded
  }
}

function disabledCapability(policyId: string): AppRealtimeCapability {
  return {
    enabled: false,
    policyId,
    transport: APP_REALTIME_TRANSPORT,
    protocol: APP_REALTIME_PROTOCOL,
    ticketPath: APP_REALTIME_TICKET_PATH,
    connectPath: APP_REALTIME_CONNECT_PATH,
    eventSchemaVersion: APP_REALTIME_EVENT_SCHEMA_VERSION,
    ticketTtlSeconds: 60,
    reconnectMinDelayMs: 1000,
    reconnectMaxDelayMs: 30000,
    maxConnectionsPerAccount: 1,
    reasonCode: null,
  }
}

async function requireRealtimeCapability(
  env: RealtimeBindings,
  businessEligible: boolean,
): Promise<AppRealtimeCapability & { enabled: true }> {
  const capability = await resolveAppRealtimeCapability(env, businessEligible)
  if (!capability.enabled) {
    throw new AppRealtimeError(403, 'FEATURE_DISABLED', '实时刷新通道当前未开放')
  }
  return capability as AppRealtimeCapability & { enabled: true }
}

async function readRealtimePolicy(db: D1Database, policyId: string) {
  return db.prepare(`
    SELECT id, version_code, state, enabled, production_ready,
           capacity_decision_status, governance_reference,
           ticket_ttl_seconds, max_pending_tickets_per_account,
           max_connections_per_account, replay_event_limit, retained_event_limit,
           reconnect_min_delay_ms, reconnect_max_delay_ms
    FROM app_realtime_policies
    WHERE id = ? AND version_code = ?
    LIMIT 1
  `).bind(policyId, policyId).first<RealtimePolicyRow>()
}

async function requireRealtimePolicy(db: D1Database, policyId: string): Promise<RealtimePolicyRow> {
  const row = await readRealtimePolicy(db, policyId)
  if (!row || !isPolicyShapeValid(row)) {
    throw new AppRealtimeError(503, 'REALTIME_POLICY_UNAVAILABLE', '实时刷新策略暂不可用', true)
  }
  return row
}

function isPolicyShapeValid(row: RealtimePolicyRow) {
  return row.id === row.version_code
    && /^rtp_[A-Za-z0-9._-]{1,96}$/u.test(row.id)
    && Number.isInteger(row.ticket_ttl_seconds) && row.ticket_ttl_seconds >= 30 && row.ticket_ttl_seconds <= 120
    && Number.isInteger(row.max_pending_tickets_per_account)
    && row.max_pending_tickets_per_account >= 1 && row.max_pending_tickets_per_account <= 16
    && Number.isInteger(row.max_connections_per_account)
    && row.max_connections_per_account >= 1 && row.max_connections_per_account <= 8
    && Number.isInteger(row.replay_event_limit) && row.replay_event_limit >= 16 && row.replay_event_limit <= 256
    && Number.isInteger(row.retained_event_limit)
    && row.retained_event_limit >= row.replay_event_limit && row.retained_event_limit <= 512
    && Number.isInteger(row.reconnect_min_delay_ms)
    && row.reconnect_min_delay_ms >= 500 && row.reconnect_min_delay_ms <= 5000
    && Number.isInteger(row.reconnect_max_delay_ms)
    && row.reconnect_max_delay_ms >= 5000
    && row.reconnect_max_delay_ms >= row.reconnect_min_delay_ms
    && row.reconnect_max_delay_ms <= 60000
}

function normalizePolicyId(value: string | undefined) {
  const normalized = value?.trim() ?? ''
  return /^rtp_[A-Za-z0-9._-]{1,96}$/u.test(normalized) ? normalized : null
}

function normalizeRequestId(value: string) {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 128) {
    throw new AppRealtimeError(400, 'REQUEST_ID_INVALID', '请求标识无效')
  }
  return normalized
}

function readRealtimeTicket(authorization: string | undefined) {
  const match = authorization?.match(/^Realtime\s+(mrt_[A-Za-z0-9_-]{40,96})$/iu)
  if (!match?.[1]) {
    throw new AppRealtimeError(401, 'REALTIME_TICKET_REQUIRED', '缺少实时连接票据')
  }
  return match[1]
}

function accountHubName(accountId: number) {
  return `account:${accountId}`
}

function randomRecordId(prefix: 'rtk' | 'rtc') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function randomOpaqueToken(prefix: 'mrt') {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '')
  return `${prefix}_${encoded}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeScopes(scopes: AppRealtimeRefreshScope[]) {
  const allowed = new Set<string>([
    'account',
    'conversations',
    'messages',
    'notifications',
    'membership',
    'wallet',
  ])
  return [...new Set(scopes)]
    .filter((scope): scope is AppRealtimeRefreshScope => allowed.has(scope))
    .sort()
}

// 只用于让 Bindings 的 DurableObjectNamespace 保留 RPC 类型，不在运行时读取类值。
export type AppRealtimeHubNamespace = DurableObjectNamespace<AppRealtimeHub>
