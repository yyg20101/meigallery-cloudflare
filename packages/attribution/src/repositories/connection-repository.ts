import type {
  AttributionProvider,
  CanonicalConversionEvent,
  ConnectionVersionStatus,
} from '@meigallery/shared'
import type {
  AttributionConnectionAggregate,
  AttributionConnectionVersion,
  AttributionCredentialMetadata,
  AttributionRuntimePolicy,
  AttributionVersionBinding,
} from '../domain/connection'
import { AttributionDomainError } from '../domain/errors'

interface ConnectionSnapshotRow {
  connection_id: string
  connection_provider: string
  connection_name: string
  is_default: number
  active_version_id: string | null
  connection_created_at: string
  connection_updated_at: string
  policy_enabled: number
  browser_enabled: number
  server_enabled: number
  server_target_percentage: number
  server_effective_percentage: number
  circuit_state: string
  runtime_generation: number
  policy_updated_by: number
  policy_updated_at: string
  versions_json: string
  bindings_json: string
  credentials_json: string
}

interface VersionRow {
  id: string
  connection_id: string
  provider: string
  base_active_version_id: string | null
  status: string
  public_config_json: string
  config_hash: string
  created_by: number
  created_at: string
  validated_at: string | null
  activated_at: string | null
  draining_at: string | null
  retired_at: string | null
  failure_code: string
}

interface BindingRow {
  version_id: string
  canonical_event: string
  enabled: number
  browser_destination: string
  server_destination: string
}

interface CredentialRow {
  version_id: string
  provider: string
  schema_version: number
  key_id: string
  credential_fingerprint: string
  destroy_after: string | null
}

const LIVE_CANDIDATE_STATUSES = new Set<ConnectionVersionStatus>([
  'candidate',
  'validating',
  'ready',
])
const PROVIDERS = new Set<AttributionProvider>(['meta', 'tiktok', 'google'])
const PERCENTAGES = new Set([0, 10, 50, 100])

export async function readConnectionAggregate(
  db: D1Database,
  connectionId: string,
): Promise<AttributionConnectionAggregate | null> {
  if (!isText(connectionId)) throw snapshotInvalid()

  const row = await db.prepare(`
    SELECT
      connection.id AS connection_id,
      connection.provider AS connection_provider,
      connection.name AS connection_name,
      connection.is_default,
      connection.active_version_id,
      connection.created_at AS connection_created_at,
      connection.updated_at AS connection_updated_at,
      policy.enabled AS policy_enabled,
      policy.browser_enabled,
      policy.server_enabled,
      policy.server_target_percentage,
      policy.server_effective_percentage,
      policy.circuit_state,
      policy.runtime_generation,
      policy.updated_by AS policy_updated_by,
      policy.updated_at AS policy_updated_at,
      (
        SELECT json_group_array(json_object(
          'id', version.id,
          'connection_id', version.connection_id,
          'provider', version.provider,
          'base_active_version_id', version.base_active_version_id,
          'status', version.status,
          'public_config_json', version.public_config_json,
          'config_hash', version.config_hash,
          'created_by', version.created_by,
          'created_at', version.created_at,
          'validated_at', version.validated_at,
          'activated_at', version.activated_at,
          'draining_at', version.draining_at,
          'retired_at', version.retired_at,
          'failure_code', version.failure_code
        ))
        FROM attribution_connection_versions AS version
        WHERE version.connection_id = connection.id
          AND (
            version.id = connection.active_version_id
            OR version.status IN ('candidate','validating','ready')
          )
      ) AS versions_json,
      (
        SELECT json_group_array(json_object(
          'version_id', binding.version_id,
          'canonical_event', binding.canonical_event,
          'enabled', binding.enabled,
          'browser_destination', binding.browser_destination,
          'server_destination', binding.server_destination
        ))
        FROM attribution_version_bindings AS binding
        INNER JOIN attribution_connection_versions AS version
          ON version.id = binding.version_id
        WHERE version.connection_id = connection.id
          AND (
            version.id = connection.active_version_id
            OR version.status IN ('candidate','validating','ready')
          )
      ) AS bindings_json,
      (
        SELECT json_group_array(json_object(
          'version_id', credential.version_id,
          'provider', credential.provider,
          'schema_version', credential.schema_version,
          'key_id', credential.key_id,
          'credential_fingerprint', credential.credential_fingerprint,
          'destroy_after', credential.destroy_after
        ))
        FROM attribution_version_credentials AS credential
        INNER JOIN attribution_connection_versions AS version
          ON version.id = credential.version_id
        WHERE version.connection_id = connection.id
          AND (
            version.id = connection.active_version_id
            OR version.status IN ('candidate','validating','ready')
          )
      ) AS credentials_json
    FROM attribution_connections AS connection
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
    WHERE connection.id = ?
  `).bind(connectionId).first<ConnectionSnapshotRow>()

  if (!row) return null

  try {
    return parseConnectionAggregate(row)
  } catch {
    throw snapshotInvalid()
  }
}

function parseConnectionAggregate(
  row: ConnectionSnapshotRow,
): AttributionConnectionAggregate {
  const provider = parseProvider(row.connection_provider)
  const versions = parseArray<VersionRow>(row.versions_json)
  const bindingRows = parseArray<BindingRow>(row.bindings_json)
  const credentialRows = parseArray<CredentialRow>(row.credentials_json)

  assertUnique(versions.map(version => version.id))
  assertUnique(credentialRows.map(credential => credential.version_id))
  assertUnique(bindingRows.map(binding =>
    `${binding.version_id}:${binding.canonical_event}`))

  const versionIds = new Set(versions.map(version => version.id))
  if (
    bindingRows.some(binding => !versionIds.has(binding.version_id))
    || credentialRows.some(credential => !versionIds.has(credential.version_id))
  ) {
    throw snapshotInvalid()
  }

  const hydrated = versions.map(version => hydrateVersion(
    version,
    provider,
    row.connection_id,
    bindingRows.filter(binding => binding.version_id === version.id),
    credentialRows.filter(credential => credential.version_id === version.id),
  ))

  const activeVersion = row.active_version_id === null
    ? null
    : hydrated.find(version => version.id === row.active_version_id) ?? null
  if (
    (row.active_version_id !== null
      && (!activeVersion || activeVersion.status !== 'active'))
    || (row.active_version_id === null
      && hydrated.some(version => version.status === 'active'))
  ) {
    throw snapshotInvalid()
  }

  const candidates = hydrated.filter(version =>
    LIVE_CANDIDATE_STATUSES.has(version.status))
  if (candidates.length > 1) throw snapshotInvalid()
  const liveCandidate = candidates[0] ?? null
  if (
    liveCandidate
    && liveCandidate.baseActiveVersionId !== row.active_version_id
  ) {
    throw snapshotInvalid()
  }

  if (hydrated.some(version =>
    version !== activeVersion && version !== liveCandidate)) {
    throw snapshotInvalid()
  }

  return {
    connection: {
      id: requireText(row.connection_id),
      provider,
      name: requireText(row.connection_name),
      isDefault: parseBoolean(row.is_default),
      activeVersionId: nullableText(row.active_version_id),
      createdAt: requireText(row.connection_created_at),
      updatedAt: requireText(row.connection_updated_at),
    },
    activeVersion,
    liveCandidate,
    runtimePolicy: parseRuntimePolicy(row),
  }
}

function hydrateVersion(
  row: VersionRow,
  provider: AttributionProvider,
  connectionId: string,
  bindingRows: readonly BindingRow[],
  credentialRows: readonly CredentialRow[],
): AttributionConnectionVersion {
  if (
    row.connection_id !== connectionId
    || parseProvider(row.provider) !== provider
    || credentialRows.length !== 1
    || bindingRows.length === 0
  ) {
    throw snapshotInvalid()
  }

  return {
    id: requireText(row.id),
    connectionId,
    provider,
    baseActiveVersionId: nullableText(row.base_active_version_id),
    status: parseVersionStatus(row.status),
    publicConfig: parsePublicConfig(row.public_config_json),
    configHash: requireText(row.config_hash),
    createdBy: parsePositiveInteger(row.created_by),
    createdAt: requireText(row.created_at),
    validatedAt: nullableText(row.validated_at),
    activatedAt: nullableText(row.activated_at),
    drainingAt: nullableText(row.draining_at),
    retiredAt: nullableText(row.retired_at),
    failureCode: typeof row.failure_code === 'string'
      ? row.failure_code
      : failSnapshot(),
    bindings: bindingRows
      .map(parseBinding)
      .sort((first, second) =>
        first.canonicalEvent.localeCompare(second.canonicalEvent)),
    credential: parseCredential(credentialRows[0]!, provider),
  }
}

function parseBinding(row: BindingRow): AttributionVersionBinding {
  return {
    canonicalEvent: parseCanonicalEvent(row.canonical_event),
    enabled: parseBoolean(row.enabled),
    browserDestination: requireText(row.browser_destination),
    serverDestination: requireText(row.server_destination),
  }
}

function parseCredential(
  row: CredentialRow,
  provider: AttributionProvider,
): AttributionCredentialMetadata {
  if (parseProvider(row.provider) !== provider) throw snapshotInvalid()
  return {
    provider,
    schemaVersion: parsePositiveInteger(row.schema_version),
    keyId: requireText(row.key_id),
    fingerprint: requireText(row.credential_fingerprint),
    destroyAfter: nullableText(row.destroy_after),
  }
}

function parseRuntimePolicy(
  row: ConnectionSnapshotRow,
): AttributionRuntimePolicy {
  if (
    !PERCENTAGES.has(row.server_target_percentage)
    || !PERCENTAGES.has(row.server_effective_percentage)
    || !['closed', 'server_open'].includes(row.circuit_state)
  ) {
    throw snapshotInvalid()
  }

  return {
    enabled: parseBoolean(row.policy_enabled),
    browserEnabled: parseBoolean(row.browser_enabled),
    serverEnabled: parseBoolean(row.server_enabled),
    serverTargetPercentage: row.server_target_percentage as 0 | 10 | 50 | 100,
    serverEffectivePercentage:
      row.server_effective_percentage as 0 | 10 | 50 | 100,
    circuitState: row.circuit_state as 'closed' | 'server_open',
    runtimeGeneration: parsePositiveInteger(row.runtime_generation),
    updatedBy: parsePositiveInteger(row.policy_updated_by),
    updatedAt: requireText(row.policy_updated_at),
  }
}

function parsePublicConfig(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value)
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Object.values(parsed).every(item => typeof item === 'string')
  ) {
    throw snapshotInvalid()
  }
  return parsed as Record<string, string>
}

function parseArray<T>(value: string): T[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw snapshotInvalid()
  return parsed as T[]
}

function parseProvider(value: string): AttributionProvider {
  if (!PROVIDERS.has(value as AttributionProvider)) throw snapshotInvalid()
  return value as AttributionProvider
}

function parseVersionStatus(value: string): ConnectionVersionStatus {
  const statuses: ConnectionVersionStatus[] = [
    'candidate',
    'validating',
    'ready',
    'active',
    'draining',
    'failed',
    'superseded',
    'retired',
  ]
  if (!statuses.includes(value as ConnectionVersionStatus)) {
    throw snapshotInvalid()
  }
  return value as ConnectionVersionStatus
}

function parseCanonicalEvent(value: string): CanonicalConversionEvent {
  if (value !== 'Contact' && value !== 'CompleteRegistration') {
    throw snapshotInvalid()
  }
  return value
}

function parseBoolean(value: number): boolean {
  if (value !== 0 && value !== 1) throw snapshotInvalid()
  return value === 1
}

function parsePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw snapshotInvalid()
  return value
}

function nullableText(value: string | null): string | null {
  if (value === null) return null
  return requireText(value)
}

function requireText(value: string): string {
  if (!isText(value)) throw snapshotInvalid()
  return value
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw snapshotInvalid()
}

function failSnapshot(): never {
  throw snapshotInvalid()
}

function snapshotInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID')
}
