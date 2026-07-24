import type { AttributionProvider } from '@meigallery/shared'
import type {
  AttributionRouteCandidate,
  AttributionRoutingIncident,
  AttributionRoutingRepository,
} from '../domain/routing'
import { AttributionDomainError } from '../domain/errors'
import { sha256Hex } from '../security/digest'
import { encodeBase64Url } from '../security/signed-token'

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

interface EligibleConnectionRow {
  provider: string
  connection_id: string
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])

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

  const proof = encodeBase64Url(proofBytes)
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

function isOpaqueProof(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === 43
    && /^[A-Za-z0-9_-]{43}$/.test(value)
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
