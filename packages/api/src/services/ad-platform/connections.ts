import type { AdAttributionProvider, CanonicalConversionEvent } from '@meigallery/shared'
import { getAdPlatformDefinition, hasAdPlatformAdapter } from './registry'

export interface AttributionConnectionSnapshotReady {
  state: 'ready'
  connection: {
    id: string
    provider: AdAttributionProvider
    enabled: boolean
    mode: 'disabled' | 'test' | 'production'
    browserEnabled: boolean
    serverEnabled: boolean
    publicConfig: Record<string, unknown>
    connectionRevision: string
    credentialRevision: string
    rolloutTargetPercentage: number
    rolloutEffectivePercentage: number
  }
  bindings: Map<CanonicalConversionEvent, {
    enabled: boolean
    browserDestination: string
    serverDestination: string
  }>
  credential: {
    type: 'access_token' | 'service_account_json'
    schemaVersion: number
    credentialRevision: string
  }
}

export type AttributionConnectionSnapshot = AttributionConnectionSnapshotReady | {
  state: 'connection_invalid'
  reason: 'not_found' | 'provider_unknown' | 'schema_invalid' | 'revision_mismatch' | 'provider_mismatch'
}

type SnapshotRow = {
  connection_id: string
  provider: string
  enabled: number
  mode: string
  browser_enabled: number
  server_enabled: number
  public_config_json: string
  rollout_target_percentage: number
  rollout_effective_percentage: number
  connection_revision: string
  credential_revision: string
  canonical_event: string | null
  binding_provider: string | null
  binding_enabled: number | null
  browser_destination: string | null
  server_destination: string | null
  mapping_revision: string | null
  credential_provider: string | null
  credential_type: string | null
  schema_version: number | null
  credential_row_revision: string | null
  key_id: string | null
}

/** 连接、事件绑定和凭据元数据必须在同一快照查询中读取。 */
export async function readAttributionConnectionSnapshot(
  db: D1Database,
  provider: unknown,
): Promise<AttributionConnectionSnapshot> {
  const definition = getAdPlatformDefinition(provider)
  if (!definition) return { state: 'connection_invalid', reason: 'provider_unknown' }
  const result = await db.prepare(`
    SELECT
      connection.id AS connection_id, connection.provider, connection.enabled, connection.mode,
      connection.browser_enabled, connection.server_enabled, connection.public_config_json,
      connection.rollout_target_percentage, connection.rollout_effective_percentage,
      connection.connection_revision, connection.credential_revision,
      binding.canonical_event, binding.provider AS binding_provider, binding.enabled AS binding_enabled,
      binding.browser_destination, binding.server_destination, binding.mapping_revision,
      credential.provider AS credential_provider, credential.credential_type, credential.schema_version,
      credential.credential_revision AS credential_row_revision, credential.key_id
    FROM attribution_platform_connections AS connection
    LEFT JOIN attribution_event_bindings AS binding ON binding.connection_id = connection.id
    LEFT JOIN attribution_credentials AS credential ON credential.connection_id = connection.id
    WHERE connection.provider = ?
    ORDER BY binding.canonical_event, credential.updated_at DESC
  `).bind(provider).all<SnapshotRow>()
  const rows = result.results
  const first = rows[0]
  if (!first) return { state: 'connection_invalid', reason: 'not_found' }
  if (rows.some(row => !sameValue(row.provider, first.provider) || !sameValue(row.connection_id, first.connection_id)
    || row.connection_revision !== first.connection_revision || row.credential_revision !== first.credential_revision)) {
    return { state: 'connection_invalid', reason: 'revision_mismatch' }
  }
  if (!hasAdPlatformAdapter(first.provider)) return { state: 'connection_invalid', reason: 'provider_unknown' }
  if (!isConnectionRow(first)) return { state: 'connection_invalid', reason: 'schema_invalid' }
  let publicConfig: unknown
  try { publicConfig = JSON.parse(first.public_config_json) } catch { return { state: 'connection_invalid', reason: 'schema_invalid' } }
  const parsedConfig = definition.publicConfigSchema.parse(publicConfig)
  if (!parsedConfig) return { state: 'connection_invalid', reason: 'schema_invalid' }
  const bindings = new Map<CanonicalConversionEvent, AttributionConnectionSnapshotReady['bindings'] extends Map<CanonicalConversionEvent, infer V> ? V : never>()
  const credentials = new Map<string, SnapshotRow>()
  for (const row of rows) {
    if (row.canonical_event !== null) {
      if (!isBindingRow(row, first) || bindings.has(row.canonical_event)) return invalidBinding(row, first)
      bindings.set(row.canonical_event, {
        enabled: row.binding_enabled === 1,
        browserDestination: row.browser_destination,
        serverDestination: row.server_destination,
      })
    }
    if (row.credential_type !== null) {
      const previous = credentials.get(row.credential_type)
      if (!isCredentialRow(row, first)
        || (previous && (previous.credential_row_revision !== row.credential_row_revision
          || previous.schema_version !== row.schema_version || previous.key_id !== row.key_id))) return invalidCredential(row, first)
      credentials.set(row.credential_type, row)
    }
  }
  const credential = credentials.get(definition.credentialSchema.type)
  if (!credential || credential.schema_version !== definition.credentialSchema.version) {
    return { state: 'connection_invalid', reason: 'schema_invalid' }
  }
  return {
    state: 'ready',
    connection: {
      id: first.connection_id, provider: first.provider, enabled: first.enabled === 1,
      mode: first.mode, browserEnabled: first.browser_enabled === 1, serverEnabled: first.server_enabled === 1,
      publicConfig: parsedConfig, connectionRevision: first.connection_revision,
      credentialRevision: first.credential_revision, rolloutTargetPercentage: first.rollout_target_percentage,
      rolloutEffectivePercentage: first.rollout_effective_percentage,
    },
    bindings,
    credential: {
      type: definition.credentialSchema.type, schemaVersion: credential.schema_version,
      credentialRevision: String(credential.credential_row_revision),
    },
  }
}

function invalidBinding(row: SnapshotRow, first: SnapshotRow): AttributionConnectionSnapshot {
  return { state: 'connection_invalid', reason: !sameValue(row.binding_provider, first.provider) ? 'provider_mismatch' : 'revision_mismatch' }
}

function invalidCredential(row: SnapshotRow, first: SnapshotRow): AttributionConnectionSnapshot {
  return { state: 'connection_invalid', reason: !sameValue(row.credential_provider, first.provider) ? 'provider_mismatch' : 'revision_mismatch' }
}

function isConnectionRow(row: SnapshotRow): row is SnapshotRow & { provider: AdAttributionProvider, mode: 'disabled' | 'test' | 'production' } {
  return typeof row.connection_id === 'string' && row.connection_id.length > 0
    && row.enabled >= 0 && row.enabled <= 1 && row.browser_enabled >= 0 && row.browser_enabled <= 1 && row.server_enabled >= 0 && row.server_enabled <= 1
    && (row.mode === 'disabled' || row.mode === 'test' || row.mode === 'production')
    && validRevision(row.connection_revision) && validRevision(row.credential_revision)
    && validPercentage(row.rollout_target_percentage) && validPercentage(row.rollout_effective_percentage)
}

function isBindingRow(row: SnapshotRow, connection: SnapshotRow): row is SnapshotRow & { canonical_event: CanonicalConversionEvent, binding_enabled: number, browser_destination: string, server_destination: string, mapping_revision: string } {
  return (row.canonical_event === 'Contact' || row.canonical_event === 'CompleteRegistration')
    && sameValue(row.binding_provider, connection.provider) && (row.binding_enabled === 0 || row.binding_enabled === 1)
    && typeof row.browser_destination === 'string' && typeof row.server_destination === 'string'
    && row.browser_destination.length > 0 && row.server_destination.length > 0
    && row.mapping_revision === connection.connection_revision
}

function isCredentialRow(row: SnapshotRow, connection: SnapshotRow): row is SnapshotRow & { credential_type: string, schema_version: number, credential_row_revision: string, key_id: string } {
  return sameValue(row.credential_provider, connection.provider) && typeof row.credential_type === 'string'
    && Number.isInteger(row.schema_version) && Number(row.schema_version) > 0
    && row.credential_row_revision === connection.credential_revision && validRevision(row.credential_row_revision)
    && typeof row.key_id === 'string' && /^[0-9a-f]{16}$/.test(row.key_id)
}

function validRevision(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validPercentage(value: unknown) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100 }
function sameValue(left: unknown, right: unknown) { return left === right }
