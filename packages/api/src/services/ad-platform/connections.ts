import type { AdAttributionProvider, CanonicalConversionEvent } from '@meigallery/shared'
import { getAdPlatformDefinition } from './registry'

export interface AttributionConnectionSnapshotReady {
  state: 'ready'
  connection: {
    id: string
    provider: AdAttributionProvider
    enabled: boolean
    mode: 'disabled' | 'test' | 'production'
    browserEnabled: boolean
    serverEnabled: boolean
    publicConfig: Record<string, string>
    connectionRevision: string
    credentialRevision: string
    rolloutTargetPercentage: number
    rolloutEffectivePercentage: number
  }
  bindings: Map<CanonicalConversionEvent, { enabled: boolean; browserDestination: string; serverDestination: string }>
  credential: { type: 'access_token' | 'service_account_json'; schemaVersion: number; credentialRevision: string }
}

export type AttributionConnectionSnapshot = AttributionConnectionSnapshotReady | { state: 'connection_invalid'; reason: 'not_found' | 'provider_unknown' | 'schema_invalid' | 'revision_mismatch' | 'provider_mismatch' }

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
  binding_id: string | null
  canonical_event: string | null
  binding_provider: string | null
  binding_enabled: number | null
  browser_destination: string | null
  server_destination: string | null
  mapping_revision: string | null
  credential_id: string | null
  credential_provider: string | null
  credential_type: string | null
  schema_version: number | null
  credential_row_revision: string | null
  key_id: string | null
}

/** 一条快照查询同时锁定 connection、binding 和 credential metadata。 */
export async function readAttributionConnectionSnapshot(db: D1Database, provider: unknown): Promise<AttributionConnectionSnapshot> {
  const definition = getAdPlatformDefinition(provider)
  if (!definition) return invalid('provider_unknown')
  const result = await db.prepare(`
    SELECT connection.id AS connection_id, connection.provider, connection.enabled, connection.mode,
      connection.browser_enabled, connection.server_enabled, connection.public_config_json,
      connection.rollout_target_percentage, connection.rollout_effective_percentage,
      connection.connection_revision, connection.credential_revision,
      binding.id AS binding_id, binding.canonical_event, binding.provider AS binding_provider,
      binding.enabled AS binding_enabled, binding.browser_destination, binding.server_destination, binding.mapping_revision,
      credential.id AS credential_id, credential.provider AS credential_provider, credential.credential_type,
      credential.schema_version, credential.credential_revision AS credential_row_revision, credential.key_id
    FROM attribution_platform_connections AS connection
    LEFT JOIN attribution_event_bindings AS binding ON binding.connection_id = connection.id
    LEFT JOIN attribution_credentials AS credential ON credential.connection_id = connection.id
    WHERE connection.provider = ?
    ORDER BY binding.id, credential.id
  `).bind(provider).all<SnapshotRow>()
  const first = result.results[0]
  if (!first) return invalid('not_found')
  if (!result.results.every(row => same(row.connection_id, first.connection_id)
    && same(row.provider, first.provider) && same(row.connection_revision, first.connection_revision)
    && same(row.credential_revision, first.credential_revision))) return invalid('revision_mismatch')
  if (!same(first.provider, definition.provider)) return invalid('provider_mismatch')
  if (!validConnection(first)) return invalid('schema_invalid')
  let publicConfig: unknown
  try { publicConfig = JSON.parse(first.public_config_json) } catch { return invalid('schema_invalid') }
  const parsedConfig = definition.publicConfigSchema.parse(publicConfig)
  if (!parsedConfig) return invalid('schema_invalid')
  const bindings = new Map<string, SnapshotRow>()
  const credentials = new Map<string, SnapshotRow>()
  for (const row of result.results) {
    if (!validBindingRow(row, first) || !validCredentialRow(row, first)) return invalid(bindingMismatch(row, first) ? 'provider_mismatch' : 'revision_mismatch')
    const existingBinding = bindings.get(String(row.canonical_event))
    const existingCredential = credentials.get(String(row.credential_id))
    if ((existingBinding && !same(existingBinding.binding_id, row.binding_id))
      || (existingCredential && (!same(existingCredential.credential_type, row.credential_type)
        || !same(existingCredential.credential_row_revision, row.credential_row_revision)
        || !same(existingCredential.key_id, row.key_id)))) return invalid('schema_invalid')
    bindings.set(String(row.canonical_event), row)
    credentials.set(String(row.credential_id), row)
  }
  const expectedEvents = ['Contact', 'CompleteRegistration'] as const
  if (bindings.size !== expectedEvents.length || !expectedEvents.every(event => bindings.has(event)) || credentials.size !== 1) return invalid('schema_invalid')
  const credential = [...credentials.values()][0]!
  if (!same(credential.credential_type, definition.credentialSchema.type) || credential.schema_version !== definition.credentialSchema.version) return invalid('schema_invalid')
  return {
    state: 'ready',
    connection: { id: first.connection_id, provider: definition.provider, enabled: first.enabled === 1, mode: first.mode as AttributionConnectionSnapshotReady['connection']['mode'], browserEnabled: first.browser_enabled === 1, serverEnabled: first.server_enabled === 1, publicConfig: parsedConfig, connectionRevision: first.connection_revision, credentialRevision: first.credential_revision, rolloutTargetPercentage: first.rollout_target_percentage, rolloutEffectivePercentage: first.rollout_effective_percentage },
    bindings: new Map(expectedEvents.map(event => {
      const row = bindings.get(event)!
      return [event, { enabled: row.binding_enabled === 1, browserDestination: String(row.browser_destination), serverDestination: String(row.server_destination) }]
    })),
    credential: { type: definition.credentialSchema.type, schemaVersion: credential.schema_version!, credentialRevision: String(credential.credential_row_revision) },
  }
}

function validConnection(row: SnapshotRow) {
  return validId(row.connection_id) && (row.enabled === 0 || row.enabled === 1) && (row.browser_enabled === 0 || row.browser_enabled === 1) && (row.server_enabled === 0 || row.server_enabled === 1)
    && ['disabled', 'test', 'production'].includes(row.mode) && validRevision(row.connection_revision) && validRevision(row.credential_revision)
    && validPercentage(row.rollout_target_percentage) && validPercentage(row.rollout_effective_percentage)
}
function validBindingRow(row: SnapshotRow, connection: SnapshotRow) {
  return validId(row.binding_id) && (row.canonical_event === 'Contact' || row.canonical_event === 'CompleteRegistration')
    && same(row.binding_provider, connection.provider) && (row.binding_enabled === 0 || row.binding_enabled === 1)
    && validText(row.browser_destination) && validText(row.server_destination) && same(row.mapping_revision, connection.connection_revision)
}
function validCredentialRow(row: SnapshotRow, connection: SnapshotRow) {
  return validId(row.credential_id) && same(row.credential_provider, connection.provider) && validText(row.credential_type)
    && Number.isInteger(row.schema_version) && Number(row.schema_version) > 0 && same(row.credential_row_revision, connection.credential_revision)
    && validRevision(String(row.credential_row_revision)) && typeof row.key_id === 'string' && /^[0-9a-f]{16}$/.test(row.key_id)
}
function bindingMismatch(row: SnapshotRow, connection: SnapshotRow) { return !same(row.binding_provider, connection.provider) || !same(row.credential_provider, connection.provider) }
function invalid(reason: 'not_found' | 'provider_unknown' | 'schema_invalid' | 'revision_mismatch' | 'provider_mismatch'): AttributionConnectionSnapshot { return { state: 'connection_invalid', reason } }
function same(left: unknown, right: unknown) { return left === right }
function validId(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validRevision(value: unknown) { return validId(value) }
function validPercentage(value: unknown) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100 }
function validText(value: unknown) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_000 && !/\p{Cc}/u.test(value) }
