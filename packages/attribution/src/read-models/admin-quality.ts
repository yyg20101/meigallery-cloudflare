import type {
  AttributionProvider,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionQualityQuery {
  dateFrom?: string
  dateTo?: string
  provider?: AttributionProvider
  connectionId?: string
  limit?: number
}

export interface AdminAttributionQualityView {
  date: string
  provider: AttributionProvider
  connectionId: string
  connectionName: string
  metricKey: string
  numerator: number | null
  denominator: number | null
  value: number | null
  availability: 'available' | 'unavailable' | 'error'
}

interface QualityRow {
  date: string
  provider: string
  connection_id: string
  connection_name: string
  metric_key: string
  numerator: number | null
  denominator: number | null
  value: number | null
  availability: string
}

export async function listAdminAttributionQuality(
  db: D1Database,
  input: AdminAttributionQualityQuery,
): Promise<AdminAttributionQualityView[]> {
  const filters = normalizeQualityQuery(input)
  const rows = await db.prepare(`
    SELECT
      quality.date,
      quality.provider,
      quality.connection_id,
      connection.name AS connection_name,
      quality.metric_key,
      quality.numerator,
      quality.denominator,
      quality.value,
      quality.availability
    FROM attribution_quality_daily AS quality
    INNER JOIN attribution_connections AS connection
      ON connection.id = quality.connection_id
     AND connection.provider = quality.provider
    WHERE (? IS NULL OR quality.date >= ?)
      AND (? IS NULL OR quality.date <= ?)
      AND (? IS NULL OR quality.provider = ?)
      AND (? IS NULL OR quality.connection_id = ?)
    ORDER BY quality.date DESC, quality.provider,
             connection.name, quality.metric_key
    LIMIT ?
  `).bind(
    filters.dateFrom ?? null,
    filters.dateFrom ?? null,
    filters.dateTo ?? null,
    filters.dateTo ?? null,
    filters.provider ?? null,
    filters.provider ?? null,
    filters.connectionId ?? null,
    filters.connectionId ?? null,
    filters.limit,
  ).all<QualityRow>()

  return rows.results.map(row => ({
    date: row.date,
    provider: getProviderAdapter(row.provider).provider,
    connectionId: row.connection_id,
    connectionName: row.connection_name,
    metricKey: row.metric_key,
    numerator: nullableNumber(row.numerator),
    denominator: nullableNumber(row.denominator),
    value: nullableNumber(row.value),
    availability: asAvailability(row.availability),
  }))
}

function normalizeQualityQuery(
  input: AdminAttributionQualityQuery,
): Required<Pick<AdminAttributionQualityQuery, 'limit'>> & Omit<
  AdminAttributionQualityQuery,
  'limit'
> {
  if (!input || typeof input !== 'object') throw queryInvalid()
  const dateFrom = normalizeDate(input.dateFrom)
  const dateTo = normalizeDate(input.dateTo)
  if (dateFrom && dateTo && dateFrom > dateTo) throw queryInvalid()
  const provider = input.provider === undefined
    ? undefined
    : getProviderAdapter(input.provider).provider
  const connectionId = normalizeText(input.connectionId)
  const limit = input.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw queryInvalid()
  }
  return { dateFrom, dateTo, provider, connectionId, limit }
}

function normalizeDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw queryInvalid()
  return value
}

function normalizeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 160) throw queryInvalid()
  return normalized
}

function nullableNumber(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) throw queryInvalid()
  return value
}

function asAvailability(
  value: string,
): 'available' | 'unavailable' | 'error' {
  if (
    value === 'available'
    || value === 'unavailable'
    || value === 'error'
  ) {
    return value
  }
  throw queryInvalid()
}

function queryInvalid(): AttributionDomainError {
  return new AttributionDomainError(
    'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
  )
}
