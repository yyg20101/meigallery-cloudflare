import type {
  AttributionProvider,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionIncidentQuery {
  provider?: AdminAttributionIncidentProvider
  connectionId?: string
  severity?: 'warning' | 'critical'
  status?: 'open' | 'resolved'
  limit?: number
}

export type AdminAttributionIncidentProvider =
  | AttributionProvider
  | 'cloudflare'
  | 'system'

export interface AdminAttributionIncidentView {
  id: string
  provider: AdminAttributionIncidentProvider
  connectionId: string
  connectionName: string
  severity: 'warning' | 'critical'
  code: string
  affectedChannel: string
  affectedEvent: string
  openedAt: string
  detectedAt: string
  recoveredAt: string
  affectedFactCount: number
  affectedDeliveryCount: number
  automaticAction: string
  recoveryStatus: 'active' | 'recovered'
}

interface IncidentRow {
  id: string
  provider: string
  connection_id: string | null
  connection_name: string | null
  severity: string
  status: string
  code: string
  affected_transport: string
  affected_fact_count: number
  affected_delivery_count: number
  opened_at: string
  detected_at: string
  resolved_at: string | null
  resolution: string
}

export async function listAdminAttributionIncidents(
  db: D1Database,
  input: AdminAttributionIncidentQuery,
): Promise<AdminAttributionIncidentView[]> {
  const filters = normalizeIncidentQuery(input)
  const rows = await db.prepare(`
    SELECT
      incident.id,
      incident.provider,
      incident.connection_id,
      connection.name AS connection_name,
      incident.severity,
      incident.status,
      incident.code,
      incident.affected_transport,
      incident.affected_fact_count,
      incident.affected_delivery_count,
      incident.opened_at,
      incident.detected_at,
      incident.resolved_at,
      incident.resolution
    FROM attribution_incidents AS incident
    LEFT JOIN attribution_connections AS connection
      ON connection.id = incident.connection_id
     AND connection.provider = incident.provider
    WHERE (? IS NULL OR incident.provider = ?)
      AND (? IS NULL OR incident.connection_id = ?)
      AND (? IS NULL OR incident.severity = ?)
      AND (? IS NULL OR incident.status = ?)
    ORDER BY incident.detected_at DESC, incident.id DESC
    LIMIT ?
  `).bind(
    filters.provider ?? null,
    filters.provider ?? null,
    filters.connectionId ?? null,
    filters.connectionId ?? null,
    filters.severity ?? null,
    filters.severity ?? null,
    filters.status ?? null,
    filters.status ?? null,
    filters.limit,
  ).all<IncidentRow>()

  return rows.results.map(row => ({
    id: row.id,
    provider: parseAdminAttributionIncidentProvider(row.provider),
    connectionId: row.connection_id ?? '',
    connectionName: row.connection_name ?? '',
    severity: asSeverity(row.severity),
    code: row.code,
    affectedChannel: row.affected_transport,
    affectedEvent: '',
    openedAt: row.opened_at,
    detectedAt: row.detected_at,
    recoveredAt: row.resolved_at ?? '',
    affectedFactCount: row.affected_fact_count,
    affectedDeliveryCount: row.affected_delivery_count,
    automaticAction: row.resolution,
    recoveryStatus: asRecoveryStatus(row.status),
  }))
}

function normalizeIncidentQuery(
  input: AdminAttributionIncidentQuery,
): Required<Pick<AdminAttributionIncidentQuery, 'limit'>> & Omit<
  AdminAttributionIncidentQuery,
  'limit'
> {
  if (!input || typeof input !== 'object') throw queryInvalid()
  const provider = input.provider === undefined
    ? undefined
    : parseAdminAttributionIncidentProvider(input.provider)
  const connectionId = normalizeText(input.connectionId)
  if (
    input.severity !== undefined
    && input.severity !== 'warning'
    && input.severity !== 'critical'
  ) {
    throw queryInvalid()
  }
  if (
    input.status !== undefined
    && input.status !== 'open'
    && input.status !== 'resolved'
  ) {
    throw queryInvalid()
  }
  const limit = input.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw queryInvalid()
  }
  return {
    provider,
    connectionId,
    severity: input.severity,
    status: input.status,
    limit,
  }
}

export function parseAdminAttributionIncidentProvider(
  value: string,
): AdminAttributionIncidentProvider {
  if (value === 'cloudflare' || value === 'system') return value
  return getProviderAdapter(value).provider
}

function normalizeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 160) throw queryInvalid()
  return normalized
}

function asSeverity(
  value: string,
): 'warning' | 'critical' {
  if (value === 'warning' || value === 'critical') return value
  throw queryInvalid()
}

function asRecoveryStatus(
  value: string,
): 'active' | 'recovered' {
  if (value === 'open') return 'active'
  if (value === 'resolved') return 'recovered'
  throw queryInvalid()
}

function queryInvalid(): AttributionDomainError {
  return new AttributionDomainError(
    'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
  )
}
