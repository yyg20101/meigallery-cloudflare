import type { AdAttributionProvider, CanonicalConversionEvent } from '@meigallery/shared'
import { getAdPlatformDefinition } from './registry'

const CANONICAL_EVENTS = ['Contact', 'CompleteRegistration'] as const

export interface AttributionConnectionSnapshotReady {
  state: 'ready'
  connection: {
    id: string
    provider: AdAttributionProvider
    enabled: boolean
    browserEnabled: boolean
    serverEnabled: boolean
    publicConfig: Record<string, string>
    outboxScope: string
  }
  bindings: Map<CanonicalConversionEvent, {
    enabled: boolean
    browserDestination: string
    serverDestination: string
  }>
  credential: {
    type: 'access_token' | 'service_account_json'
    schemaVersion: number
    revision: string
  }
}

export type AttributionConnectionSnapshot = AttributionConnectionSnapshotReady | {
  state: 'connection_invalid'
  reason: 'not_found' | 'provider_unknown' | 'schema_invalid' | 'provider_mismatch'
}

type ConnectionRow = {
  id: string
  provider: string
  enabled: number
  browser_enabled: number
  server_enabled: number
  public_config_json: string
  connection_revision: string
}

type BindingRow = {
  id: string
  provider: string
  canonical_event: string
  enabled: number
  browser_destination: string
  server_destination: string
}

type CredentialRow = {
  id: string
  provider: string
  credential_type: string
  schema_version: number
  credential_revision: string
  key_id: string
}

/**
 * 连接、事件映射和凭证元数据分别读取。
 * 管理员保存配置不会改变 outboxScope，因此不会使已入队事件失效。
 */
export async function readAttributionConnectionSnapshot(
  db: D1Database,
  provider: unknown,
): Promise<AttributionConnectionSnapshot> {
  const definition = getAdPlatformDefinition(provider)
  if (!definition) return invalid('provider_unknown')

  const connection = await db.prepare(`
    SELECT id, provider, enabled, browser_enabled, server_enabled,
      public_config_json, connection_revision
    FROM attribution_platform_connections
    WHERE provider = ?
    LIMIT 1
  `).bind(definition.provider).first<ConnectionRow>()
  if (!connection) return invalid('not_found')
  if (connection.provider !== definition.provider) return invalid('provider_mismatch')
  if (!validConnection(connection)) return invalid('schema_invalid')

  let publicConfig: unknown
  try {
    publicConfig = JSON.parse(connection.public_config_json)
  }
  catch {
    return invalid('schema_invalid')
  }
  const parsedConfig = definition.publicConfigSchema.parse(publicConfig)
  if (!parsedConfig) return invalid('schema_invalid')

  const [bindingResult, credentialResult] = await Promise.all([
    db.prepare(`
      SELECT id, provider, canonical_event, enabled,
        browser_destination, server_destination
      FROM attribution_event_bindings
      WHERE connection_id = ?
      ORDER BY canonical_event
    `).bind(connection.id).all<BindingRow>(),
    db.prepare(`
      SELECT id, provider, credential_type, schema_version,
        credential_revision, key_id
      FROM attribution_credentials
      WHERE connection_id = ?
      ORDER BY updated_at DESC, id
    `).bind(connection.id).all<CredentialRow>(),
  ])

  if (bindingResult.results.length !== CANONICAL_EVENTS.length
    || credentialResult.results.length !== 1) return invalid('schema_invalid')

  const bindings = new Map<CanonicalConversionEvent, AttributionConnectionSnapshotReady['bindings'] extends Map<CanonicalConversionEvent, infer V> ? V : never>()
  for (const row of bindingResult.results) {
    if (row.provider !== definition.provider) return invalid('provider_mismatch')
    if (!validBinding(row) || bindings.has(row.canonical_event as CanonicalConversionEvent)) {
      return invalid('schema_invalid')
    }
    bindings.set(row.canonical_event as CanonicalConversionEvent, {
      enabled: row.enabled === 1,
      browserDestination: row.browser_destination,
      serverDestination: row.server_destination,
    })
  }
  if (!CANONICAL_EVENTS.every(event => bindings.has(event))) return invalid('schema_invalid')

  const credential = credentialResult.results[0]!
  if (credential.provider !== definition.provider) return invalid('provider_mismatch')
  if (!validCredential(credential)
    || credential.credential_type !== definition.credentialSchema.type
    || credential.schema_version !== definition.credentialSchema.version) {
    return invalid('schema_invalid')
  }

  return {
    state: 'ready',
    connection: {
      id: connection.id,
      provider: definition.provider,
      enabled: connection.enabled === 1,
      browserEnabled: connection.browser_enabled === 1,
      serverEnabled: connection.server_enabled === 1,
      publicConfig: parsedConfig,
      outboxScope: connection.connection_revision,
    },
    bindings,
    credential: {
      type: definition.credentialSchema.type,
      schemaVersion: credential.schema_version,
      revision: credential.credential_revision,
    },
  }
}

function validConnection(row: ConnectionRow) {
  return validId(row.id)
    && (row.enabled === 0 || row.enabled === 1)
    && (row.browser_enabled === 0 || row.browser_enabled === 1)
    && (row.server_enabled === 0 || row.server_enabled === 1)
    && validId(row.connection_revision)
}

function validBinding(row: BindingRow) {
  return validId(row.id)
    && (row.canonical_event === 'Contact' || row.canonical_event === 'CompleteRegistration')
    && (row.enabled === 0 || row.enabled === 1)
    && validText(row.browser_destination)
    && validText(row.server_destination)
}

function validCredential(row: CredentialRow) {
  return validId(row.id)
    && validText(row.credential_type)
    && Number.isInteger(row.schema_version)
    && row.schema_version > 0
    && validId(row.credential_revision)
    && /^[0-9a-f]{16}$/.test(row.key_id)
}

function invalid(reason: Extract<AttributionConnectionSnapshot, { state: 'connection_invalid' }>['reason']): AttributionConnectionSnapshot {
  return { state: 'connection_invalid', reason }
}

function validId(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

function validText(value: unknown) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 1_000
    && !/\p{Cc}/u.test(value)
}
