import type {
  AttributionProvider,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionConnectionView {
  id: string
  provider: AttributionProvider
  name: string
  isDefault: boolean
  state: 'not_configured' | 'active' | 'disabled'
  activeTarget: string
  candidate: null | {
    state: 'candidate' | 'validating' | 'ready' | 'failed'
    createdAt: string
    failureCode: string
    productionContinues: true
  }
  runtime: {
    enabled: boolean
    browserEnabled: boolean
    serverEnabled: boolean
    serverTargetPercentage: 0 | 10 | 50 | 100
    serverEffectivePercentage: 0 | 10 | 50 | 100
    circuitState: 'closed' | 'server_open'
  }
  health: {
    level: 'healthy' | 'warning' | 'critical'
    lastDeliveryAt: string
  }
}

interface AdminConnectionRow {
  id: string
  provider: string
  name: string
  is_default: number
  active_public_config_json: string | null
  policy_exists: number
  enabled: number | null
  browser_enabled: number | null
  server_enabled: number | null
  server_target_percentage: number | null
  server_effective_percentage: number | null
  circuit_state: string | null
  live_candidate_status: string | null
  live_candidate_created_at: string | null
  live_candidate_failure_code: string | null
  failed_candidate_status: string | null
  failed_candidate_created_at: string | null
  failed_candidate_failure_code: string | null
  has_critical_incident: number
  has_warning_incident: number
  last_delivery_at: string | null
}

const CONNECTION_QUERY = `
  SELECT
    connection.id,
    connection.provider,
    connection.name,
    connection.is_default,
    active.public_config_json AS active_public_config_json,
    CASE WHEN policy.connection_id IS NULL THEN 0 ELSE 1 END
      AS policy_exists,
    policy.enabled,
    policy.browser_enabled,
    policy.server_enabled,
    policy.server_target_percentage,
    policy.server_effective_percentage,
    policy.circuit_state,
    live_candidate.status AS live_candidate_status,
    live_candidate.created_at AS live_candidate_created_at,
    live_candidate.failure_code AS live_candidate_failure_code,
    failed_candidate.status AS failed_candidate_status,
    failed_candidate.created_at AS failed_candidate_created_at,
    failed_candidate.failure_code AS failed_candidate_failure_code,
    EXISTS (
      SELECT 1
      FROM attribution_incidents AS incident
      WHERE incident.connection_id = connection.id
        AND incident.status = 'open'
        AND incident.severity = 'critical'
    ) AS has_critical_incident,
    EXISTS (
      SELECT 1
      FROM attribution_incidents AS incident
      WHERE incident.connection_id = connection.id
        AND incident.status = 'open'
        AND incident.severity = 'warning'
    ) AS has_warning_incident,
    COALESCE((
      SELECT MAX(delivery.updated_at)
      FROM attribution_deliveries AS delivery
      WHERE delivery.connection_id = connection.id
    ), '') AS last_delivery_at
  FROM attribution_connections AS connection
  LEFT JOIN attribution_runtime_policies AS policy
    ON policy.connection_id = connection.id
  LEFT JOIN attribution_connection_versions AS active
    ON active.id = connection.active_version_id
   AND active.connection_id = connection.id
   AND active.provider = connection.provider
   AND active.status = 'active'
  LEFT JOIN attribution_connection_versions AS live_candidate
    ON live_candidate.id = (
      SELECT version.id
      FROM attribution_connection_versions AS version
      WHERE version.connection_id = connection.id
        AND version.provider = connection.provider
        AND version.status IN ('candidate','validating','ready')
      ORDER BY version.created_at DESC, version.id DESC
      LIMIT 1
    )
  LEFT JOIN attribution_connection_versions AS failed_candidate
    ON failed_candidate.id = (
      SELECT version.id
      FROM attribution_connection_versions AS version
      WHERE version.connection_id = connection.id
        AND version.provider = connection.provider
        AND version.status = 'failed'
      ORDER BY version.created_at DESC, version.id DESC
      LIMIT 1
    )
`

export async function listAdminAttributionConnections(
  db: D1Database,
): Promise<AdminAttributionConnectionView[]> {
  const rows = await db.prepare(`
    ${CONNECTION_QUERY}
    ORDER BY connection.provider, connection.name, connection.id
  `).all<AdminConnectionRow>()
  return rows.results.map(toConnectionView)
}

export async function readAdminAttributionConnection(
  db: D1Database,
  id: string,
): Promise<AdminAttributionConnectionView | null> {
  if (!id.trim()) throw snapshotInvalid()
  const row = await db.prepare(`
    ${CONNECTION_QUERY}
    WHERE connection.id = ?
    LIMIT 1
  `).bind(id).first<AdminConnectionRow>()
  return row ? toConnectionView(row) : null
}

function toConnectionView(
  row: AdminConnectionRow,
): AdminAttributionConnectionView {
  const adapter = getProviderAdapter(row.provider)
  const runtime = {
    enabled: asBoolean(row.enabled),
    browserEnabled: asBoolean(row.browser_enabled),
    serverEnabled: asBoolean(row.server_enabled),
    serverTargetPercentage: asPercentage(
      row.server_target_percentage,
    ),
    serverEffectivePercentage: asPercentage(
      row.server_effective_percentage,
    ),
    circuitState: asCircuitState(row.circuit_state),
  }
  let activeTarget = ''
  if (row.active_public_config_json !== null) {
    try {
      activeTarget = adapter.activeTarget(
        parsePublicConfig(row.active_public_config_json),
      )
    } catch {
      throw snapshotInvalid()
    }
  }
  const candidateState = row.live_candidate_status
    ?? row.failed_candidate_status
  const candidateCreatedAt = row.live_candidate_status
    ? row.live_candidate_created_at
    : row.failed_candidate_created_at
  const candidateFailureCode = row.live_candidate_status
    ? row.live_candidate_failure_code
    : row.failed_candidate_failure_code

  return {
    id: row.id,
    provider: adapter.provider,
    name: row.name,
    isDefault: asBoolean(row.is_default),
    state: !activeTarget
      ? 'not_configured'
      : row.policy_exists === 1 && !runtime.enabled
        ? 'disabled'
        : 'active',
    activeTarget,
    candidate: candidateState === null
      ? null
      : {
          state: asCandidateState(candidateState),
          createdAt: candidateCreatedAt ?? '',
          failureCode: candidateFailureCode ?? '',
          productionContinues: true,
        },
    runtime,
    health: {
      level: row.has_critical_incident === 1
        ? 'critical'
        : row.has_warning_incident === 1
          || runtime.circuitState === 'server_open'
          ? 'warning'
          : 'healthy',
      lastDeliveryAt: row.last_delivery_at ?? '',
    },
  }
}

function parsePublicConfig(value: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw snapshotInvalid()
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || Object.values(parsed).some(item => typeof item !== 'string')
  ) {
    throw snapshotInvalid()
  }
  return parsed as Record<string, string>
}

function asBoolean(value: number | null): boolean {
  if (value === null) return false
  if (value !== 0 && value !== 1) throw snapshotInvalid()
  return value === 1
}

function asPercentage(
  value: number | null,
): 0 | 10 | 50 | 100 {
  if (value === null) return 0
  if (value === 0 || value === 10 || value === 50 || value === 100) {
    return value
  }
  throw snapshotInvalid()
}

function asCircuitState(
  value: string | null,
): 'closed' | 'server_open' {
  if (value === null || value === 'closed') return 'closed'
  if (value === 'server_open') return value
  throw snapshotInvalid()
}

function asCandidateState(
  value: string,
): 'candidate' | 'validating' | 'ready' | 'failed' {
  if (
    value === 'candidate'
    || value === 'validating'
    || value === 'ready'
    || value === 'failed'
  ) {
    return value
  }
  throw snapshotInvalid()
}

function snapshotInvalid(): AttributionDomainError {
  return new AttributionDomainError(
    'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
  )
}
