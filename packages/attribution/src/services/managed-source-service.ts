import type { AttributionProvider } from '@meigallery/shared'
import type {
  AttributionRouteCandidate,
  AttributionRoutingRepository,
} from '../domain/routing'
import { AttributionDomainError } from '../domain/errors'
import { sha256Hex } from '../security/digest'

export interface ManagedSourceEnvironment {
  db: D1Database
  now?: () => Date
  idFactory?: (prefix: string) => string
  randomBytes?: () => Uint8Array
  resolveFirstPartyContext?: (
    token: string,
  ) => Promise<AttributionRouteCandidate | null>
}

export interface CreateManagedSourceInput {
  connectionId: string
  campaign: string
  medium: string
  content: string
  expiresAt?: string
}

export interface ManagedSourceProof {
  id: string
  provider: AttributionProvider
  connectionId: string
  proof: string
}

export interface AdminManagedSourceView {
  id: string
  provider: AttributionProvider
  connectionId: string
  campaign: string
  medium: string
  content: string
  expiresAt: string | null
  enabled: boolean
  createdAt: string
}

export interface CreateAdminManagedSourceInput extends CreateManagedSourceInput {
  actorId: number
  idempotencyKey: string
}

export interface CreateAdminManagedSourceResult {
  source: AdminManagedSourceView
  proof: string | null
  proofDelivery: 'issued_once' | 'not_recoverable'
  replayed: boolean
}

export interface DisableAdminManagedSourceInput {
  connectionId: string
  sourceId: string
  actorId: number
  idempotencyKey: string
}

export interface DisableAdminManagedSourceResult {
  source: AdminManagedSourceView
  disabled: true
}

export interface ListAdminManagedSourcesInput {
  connectionId: string
}

export interface ListAdminManagedSourcesResult {
  connectionId: string
  sources: AdminManagedSourceView[]
}

interface EligibleConnectionRow {
  provider: string
  connection_id: string
}

interface ManagedSourceRow {
  id: string
  provider: string
  connection_id: string
  campaign: string
  medium: string
  content: string
  expires_at: string | null
  enabled: number
  created_at: string
}

interface CommandReceiptRow {
  command_type: string
  request_hash: string
  result_json: string
}

interface CreateAdminManagedSourceReceipt {
  source: AdminManagedSourceView
  proofRecovery: 'unavailable'
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])

const CREATE_ADMIN_SOURCE = 'create_managed_source'
const DISABLE_ADMIN_SOURCE = 'disable_managed_source'

export async function createManagedSource(
  environment: ManagedSourceEnvironment,
  input: CreateManagedSourceInput,
): Promise<ManagedSourceProof> {
  const now = validNow(environment.now ?? (() => new Date()))
  validateIdentifier(input.connectionId)
  validateMetadata(input.campaign)
  validateMetadata(input.medium)
  validateMetadata(input.content)

  const expiresAt = normalizedExpiry(input.expiresAt, now)
  const connection = await findEligibleConnection(
    environment.db,
    input.connectionId,
  )
  if (!connection) {
    throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
  }

  const proofBytes = (
    environment.randomBytes
    ?? (() => crypto.getRandomValues(new Uint8Array(32)))
  )()
  if (!(proofBytes instanceof Uint8Array) || proofBytes.byteLength !== 32) {
    throw commandInvalid()
  }

  const proof = encodeProof(proofBytes)
  const proofHash = await managedSourceHash(proof)
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const id = idFactory('source')
  validateIdentifier(id)

  let result: D1Result<unknown>
  try {
    result = await environment.db.prepare(`
      INSERT INTO attribution_managed_sources (
        id, provider, connection_id, campaign, medium, content,
        proof_hash, expires_at, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      id,
      connection.provider,
      connection.connectionId,
      input.campaign,
      input.medium,
      input.content,
      proofHash,
      expiresAt,
      now,
    ).run()
  } catch {
    throw commandFailed()
  }
  if (Number(result.meta.changes ?? 0) !== 1) throw commandFailed()

  return {
    id,
    provider: connection.provider,
    connectionId: connection.connectionId,
    proof,
  }
}

export async function createAdminManagedSource(
  environment: ManagedSourceEnvironment,
  input: CreateAdminManagedSourceInput,
): Promise<CreateAdminManagedSourceResult> {
  validateAdminCommand(input)
  validateIdentifier(input.connectionId)
  validateMetadata(input.campaign)
  validateMetadata(input.medium)
  validateMetadata(input.content)

  const now = validNow(environment.now ?? (() => new Date()))
  const expiresAt = normalizedExpiry(input.expiresAt, now)
  const requestHash = await hashAdminCommand(CREATE_ADMIN_SOURCE, {
    actorId: input.actorId,
    connectionId: input.connectionId,
    campaign: input.campaign,
    medium: input.medium,
    content: input.content,
    expiresAt,
  })
  const replay = await readAdminReceipt<CreateAdminManagedSourceReceipt>(
    environment.db,
    input.idempotencyKey,
    CREATE_ADMIN_SOURCE,
    requestHash,
  )
  if (replay) return replayedCreateResult(replay)

  const connection = await findEligibleConnection(
    environment.db,
    input.connectionId,
  )
  if (!connection) {
    throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
  }

  const proofBytes = (
    environment.randomBytes
    ?? (() => crypto.getRandomValues(new Uint8Array(32)))
  )()
  if (!(proofBytes instanceof Uint8Array) || proofBytes.byteLength !== 32) {
    throw commandInvalid()
  }
  const proof = encodeProof(proofBytes)
  const proofHash = await managedSourceHash(proof)
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const sourceId = idFactory('source')
  const auditId = idFactory('audit')
  validateIdentifier(sourceId)
  validateIdentifier(auditId)

  const source: AdminManagedSourceView = {
    id: sourceId,
    provider: connection.provider,
    connectionId: connection.connectionId,
    campaign: input.campaign,
    medium: input.medium,
    content: input.content,
    expiresAt,
    enabled: true,
    createdAt: now,
  }
  const receipt: CreateAdminManagedSourceReceipt = {
    source,
    proofRecovery: 'unavailable',
  }

  try {
    const results = await environment.db.batch([
      environment.db.prepare(`
        INSERT INTO attribution_managed_sources (
          id, provider, connection_id, campaign, medium, content,
          proof_hash, expires_at, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).bind(
        source.id,
        source.provider,
        source.connectionId,
        source.campaign,
        source.medium,
        source.content,
        proofHash,
        source.expiresAt,
        source.createdAt,
      ),
      auditStatement(environment.db, {
        id: auditId,
        actorId: input.actorId,
        commandType: CREATE_ADMIN_SOURCE,
        connectionId: source.connectionId,
        outcome: 'created',
        detail: {
          sourceId: source.id,
          campaign: source.campaign,
          medium: source.medium,
          content: source.content,
          expiresAt: source.expiresAt,
        },
        timestamp: now,
        requirePreviousChange: true,
      }),
      receiptStatement(
        environment.db,
        input.idempotencyKey,
        CREATE_ADMIN_SOURCE,
        requestHash,
        receipt,
        now,
        true,
      ),
    ])
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      throw commandFailed()
    }
  } catch {
    const raced = await readAdminReceipt<CreateAdminManagedSourceReceipt>(
      environment.db,
      input.idempotencyKey,
      CREATE_ADMIN_SOURCE,
      requestHash,
    )
    if (raced) return replayedCreateResult(raced)
    throw commandFailed()
  }

  return {
    source,
    proof,
    proofDelivery: 'issued_once',
    replayed: false,
  }
}

export async function disableAdminManagedSource(
  environment: ManagedSourceEnvironment,
  input: DisableAdminManagedSourceInput,
): Promise<DisableAdminManagedSourceResult> {
  validateAdminCommand(input)
  validateIdentifier(input.connectionId)
  validateIdentifier(input.sourceId)

  const requestHash = await hashAdminCommand(DISABLE_ADMIN_SOURCE, {
    actorId: input.actorId,
    connectionId: input.connectionId,
    sourceId: input.sourceId,
  })
  const replay = await readAdminReceipt<DisableAdminManagedSourceResult>(
    environment.db,
    input.idempotencyKey,
    DISABLE_ADMIN_SOURCE,
    requestHash,
  )
  if (replay) return replay

  const row = await findManagedSource(
    environment.db,
    input.connectionId,
    input.sourceId,
  )
  if (!row) {
    throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
  }

  const now = validNow(environment.now ?? (() => new Date()))
  const source = managedSourceView(row, false)
  const result: DisableAdminManagedSourceResult = {
    source,
    disabled: true,
  }
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const auditId = idFactory('audit')
  validateIdentifier(auditId)

  try {
    const results = await environment.db.batch([
      environment.db.prepare(`
        UPDATE attribution_managed_sources
        SET enabled = 0
        WHERE id = ?
          AND connection_id = ?
      `).bind(input.sourceId, input.connectionId),
      auditStatement(environment.db, {
        id: auditId,
        actorId: input.actorId,
        commandType: DISABLE_ADMIN_SOURCE,
        connectionId: input.connectionId,
        outcome: 'disabled',
        detail: { sourceId: input.sourceId },
        timestamp: now,
        requirePreviousChange: true,
      }),
      receiptStatement(
        environment.db,
        input.idempotencyKey,
        DISABLE_ADMIN_SOURCE,
        requestHash,
        result,
        now,
        true,
      ),
    ])
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      throw commandFailed()
    }
  } catch {
    const raced = await readAdminReceipt<DisableAdminManagedSourceResult>(
      environment.db,
      input.idempotencyKey,
      DISABLE_ADMIN_SOURCE,
      requestHash,
    )
    if (raced) return raced
    throw commandFailed()
  }
  return result
}

export async function listAdminManagedSources(
  environment: ManagedSourceEnvironment,
  input: ListAdminManagedSourcesInput,
): Promise<ListAdminManagedSourcesResult> {
  validateIdentifier(input.connectionId)

  const connection = await findConnection(
    environment.db,
    input.connectionId,
  )
  if (!connection) {
    throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
  }
  const rows = await environment.db.prepare(`
    SELECT id, provider, connection_id, campaign, medium, content,
           expires_at, enabled, created_at
    FROM attribution_managed_sources
    WHERE connection_id = ?
      AND provider = ?
    ORDER BY created_at DESC, id ASC
  `).bind(
    connection.connectionId,
    connection.provider,
  ).all<ManagedSourceRow>()
  const result: ListAdminManagedSourcesResult = {
    connectionId: connection.connectionId,
    sources: rows.results.map(row => managedSourceView(row)),
  }
  return result
}

export function createManagedSourceRoutingRepository(
  environment: ManagedSourceEnvironment,
): AttributionRoutingRepository {
  const now = environment.now ?? (() => new Date())
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)

  return {
    async resolveManagedSource(proof) {
      if (!isOpaqueProof(proof)) return null
      const proofHash = await managedSourceHash(proof)
      const timestamp = validNow(now)
      const row = await environment.db.prepare(`
        SELECT source.provider, source.connection_id
        FROM attribution_managed_sources AS source
        INNER JOIN attribution_connections AS connection
          ON connection.id = source.connection_id
         AND connection.provider = source.provider
        INNER JOIN attribution_connection_versions AS version
          ON version.id = connection.active_version_id
         AND version.connection_id = connection.id
         AND version.provider = connection.provider
         AND version.status = 'active'
        INNER JOIN attribution_runtime_policies AS policy
          ON policy.connection_id = connection.id
         AND policy.enabled = 1
         AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
        WHERE source.proof_hash = ?
          AND source.enabled = 1
          AND (
            source.expires_at IS NULL
            OR julianday(source.expires_at) > julianday(?)
          )
        LIMIT 1
      `).bind(proofHash, timestamp).first<EligibleConnectionRow>()
      return routeCandidate(row)
    },

    async resolveFirstPartyContext(token) {
      return environment.resolveFirstPartyContext
        ? environment.resolveFirstPartyContext(token)
        : null
    },

    async listEligibleConnections(provider) {
      if (!PROVIDERS.has(provider)) return []
      const rows = await environment.db.prepare(`
        SELECT connection.provider, connection.id AS connection_id
        FROM attribution_connections AS connection
        INNER JOIN attribution_connection_versions AS version
          ON version.id = connection.active_version_id
         AND version.connection_id = connection.id
         AND version.provider = connection.provider
         AND version.status = 'active'
        INNER JOIN attribution_runtime_policies AS policy
          ON policy.connection_id = connection.id
         AND policy.enabled = 1
         AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
        WHERE connection.provider = ?
        ORDER BY connection.id
      `).bind(provider).all<EligibleConnectionRow>()
      return rows.results
        .map(row => routeCandidate(row))
        .filter(candidate => candidate !== null)
        .map(candidate => candidate.connectionId)
    },

    async recordRoutingIncident(incident) {
      const timestamp = validNow(now)
      const provider = incident.provider ?? 'system'
      const severity = incident.code === 'ATTRIBUTION_PROVIDER_CONFLICT'
        ? 'critical'
        : 'warning'
      const id = idFactory('incident')
      validateIdentifier(id)
      try {
        await environment.db.prepare(`
          INSERT INTO attribution_incidents (
            id, provider, connection_id, severity, status, code,
            affected_transport, opened_at, detected_at
          )
          SELECT ?, ?, NULL, ?, 'open', ?, 'all', ?, ?
          WHERE NOT EXISTS (
            SELECT 1
            FROM attribution_incidents
            WHERE provider = ?
              AND connection_id IS NULL
              AND code = ?
              AND status = 'open'
          )
        `).bind(
          id,
          provider,
          severity,
          incident.code,
          timestamp,
          timestamp,
          provider,
          incident.code,
        ).run()
      } catch {
        throw commandFailed()
      }
    },
  }
}

async function findEligibleConnection(
  db: D1Database,
  connectionId: string,
): Promise<AttributionRouteCandidate | null> {
  const row = await db.prepare(`
    SELECT connection.provider, connection.id AS connection_id
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = connection.active_version_id
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
     AND version.status = 'active'
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
     AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
    WHERE connection.id = ?
    LIMIT 1
  `).bind(connectionId).first<EligibleConnectionRow>()
  return routeCandidate(row)
}

async function findConnection(
  db: D1Database,
  connectionId: string,
): Promise<AttributionRouteCandidate | null> {
  const row = await db.prepare(`
    SELECT provider, id AS connection_id
    FROM attribution_connections
    WHERE id = ?
    LIMIT 1
  `).bind(connectionId).first<EligibleConnectionRow>()
  return routeCandidate(row)
}

async function findManagedSource(
  db: D1Database,
  connectionId: string,
  sourceId: string,
): Promise<ManagedSourceRow | null> {
  return db.prepare(`
    SELECT source.id, source.provider, source.connection_id,
           source.campaign, source.medium, source.content,
           source.expires_at, source.enabled, source.created_at
    FROM attribution_managed_sources AS source
    INNER JOIN attribution_connections AS connection
      ON connection.id = source.connection_id
     AND connection.provider = source.provider
    WHERE source.id = ?
      AND source.connection_id = ?
    LIMIT 1
  `).bind(sourceId, connectionId).first<ManagedSourceRow>()
}

function routeCandidate(
  row: EligibleConnectionRow | null,
): AttributionRouteCandidate | null {
  if (
    !row
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || !isIdentifier(row.connection_id)
  ) {
    return null
  }
  return {
    provider: row.provider as AttributionProvider,
    connectionId: row.connection_id,
  }
}

async function managedSourceHash(proof: string): Promise<string> {
  return sha256Hex(`managed-source:v1:${proof}`)
}

function managedSourceView(
  row: ManagedSourceRow,
  enabled = row.enabled === 1,
): AdminManagedSourceView {
  const candidate = routeCandidate({
    provider: row.provider,
    connection_id: row.connection_id,
  })
  if (!candidate || !isIdentifier(row.id)) throw commandFailed()
  return {
    id: row.id,
    provider: candidate.provider,
    connectionId: candidate.connectionId,
    campaign: row.campaign,
    medium: row.medium,
    content: row.content,
    expiresAt: row.expires_at,
    enabled,
    createdAt: row.created_at,
  }
}

function replayedCreateResult(
  receipt: CreateAdminManagedSourceReceipt,
): CreateAdminManagedSourceResult {
  if (receipt.proofRecovery !== 'unavailable') throw commandFailed()
  return {
    source: receipt.source,
    proof: null,
    proofDelivery: 'not_recoverable',
    replayed: true,
  }
}

async function readAdminReceipt<T>(
  db: D1Database,
  idempotencyKey: string,
  commandType: string,
  requestHash: string,
): Promise<T | null> {
  const row = await db.prepare(`
    SELECT command_type, request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(idempotencyKey).first<CommandReceiptRow>()
  if (!row) return null
  if (
    row.command_type !== commandType
    || row.request_hash !== requestHash
  ) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  try {
    return JSON.parse(row.result_json) as T
  } catch {
    throw commandFailed()
  }
}

interface AuditStatementInput {
  id: string
  actorId: number
  commandType: string
  connectionId: string
  outcome: string
  detail: Record<string, unknown>
  timestamp: string
  requirePreviousChange?: boolean
}

function auditStatement(
  db: D1Database,
  input: AuditStatementInput,
): D1PreparedStatement {
  const condition = input.requirePreviousChange ? ' WHERE changes() = 1' : ''
  return db.prepare(`
    INSERT INTO attribution_audit_logs (
      id, actor_id, command_type, connection_id,
      outcome, detail_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?${condition}
  `).bind(
    input.id,
    input.actorId,
    input.commandType,
    input.connectionId,
    input.outcome,
    JSON.stringify(input.detail),
    input.timestamp,
  )
}

function receiptStatement(
  db: D1Database,
  idempotencyKey: string,
  commandType: string,
  requestHash: string,
  result: unknown,
  timestamp: string,
  requirePreviousChange = false,
): D1PreparedStatement {
  const condition = requirePreviousChange ? ' WHERE changes() = 1' : ''
  return db.prepare(`
    INSERT INTO attribution_command_receipts (
      idempotency_key, command_type, request_hash, result_json, created_at
    )
    SELECT ?, ?, ?, ?, ?${condition}
  `).bind(
    idempotencyKey,
    commandType,
    requestHash,
    JSON.stringify(result),
    timestamp,
  )
}

async function hashAdminCommand(
  commandType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(JSON.stringify({ commandType, payload }))
}

function validateAdminCommand(input: {
  actorId: number
  idempotencyKey: string
}): void {
  if (
    !Number.isSafeInteger(input.actorId)
    || input.actorId < 1
    || !isIdentifier(input.idempotencyKey)
  ) {
    throw commandInvalid()
  }
}

function isOpaqueProof(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-f0-9]{64}$/.test(value)
}

function encodeProof(value: Uint8Array): string {
  return [...value]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function normalizedExpiry(
  value: string | undefined,
  now: string,
): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw commandInvalid()
  }
  const expiresAt = new Date(value)
  if (
    !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= new Date(now).getTime()
  ) {
    throw commandInvalid()
  }
  return expiresAt.toISOString()
}

function validNow(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw commandInvalid()
  return value.toISOString()
}

function validateIdentifier(value: unknown): asserts value is string {
  if (!isIdentifier(value)) throw commandInvalid()
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function validateMetadata(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > 1024
  ) {
    throw commandInvalid()
  }
}

function commandInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_INVALID')
}

function commandFailed(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
}
