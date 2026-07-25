import type {
  AttributionProvider,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionVerificationsQuery {
  dateFrom?: string
  dateTo?: string
  provider?: AttributionProvider
  connectionId?: string
  limit?: number
}

export interface AdminAttributionVerificationView {
  provider: AttributionProvider
  connectionId: string
  connectionName: string
  status: 'queued' | 'running' | 'verified' | 'failed' | 'timed_out'
  failureCode: string
  candidateChecked: boolean
  pairedEventCount: number
  createdAt: string
  startedAt: string
  completedAt: string
}

interface VerificationRow {
  provider: string
  connection_id: string
  connection_name: string
  status: string
  failure_code: string
  candidate_checked: number
  paired_event_count: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

const VERIFICATION_SELECT = `
  SELECT
    validation.provider,
    connection.id AS connection_id,
    connection.name AS connection_name,
    validation.status,
    validation.failure_code,
    CASE
      WHEN json_type(validation.evidence_json, '$.candidate') IS NULL
      THEN 0 ELSE 1
    END AS candidate_checked,
    json_extract(
      validation.evidence_json,
      '$.browserPairing.pairedEvents'
    ) AS paired_event_count,
    validation.created_at,
    validation.started_at,
    validation.completed_at
  FROM attribution_validations AS validation
  INNER JOIN attribution_connection_versions AS version
    ON version.id = validation.candidate_version_id
   AND version.provider = validation.provider
  INNER JOIN attribution_connections AS connection
    ON connection.id = version.connection_id
   AND connection.provider = validation.provider
`

export async function listAdminAttributionVerifications(
  db: D1Database,
  input: AdminAttributionVerificationsQuery,
): Promise<AdminAttributionVerificationView[]> {
  const query = normalizeQuery(input)
  const rows = await db.prepare(`
    ${VERIFICATION_SELECT}
    WHERE (? IS NULL OR date(
      datetime(validation.created_at, '+8 hours')
    ) >= ?)
      AND (? IS NULL OR date(
        datetime(validation.created_at, '+8 hours')
      ) <= ?)
      AND (? IS NULL OR validation.provider = ?)
      AND (? IS NULL OR connection.id = ?)
    ORDER BY validation.created_at DESC
    LIMIT ?
  `).bind(
    query.dateFrom ?? null,
    query.dateFrom ?? null,
    query.dateTo ?? null,
    query.dateTo ?? null,
    query.provider ?? null,
    query.provider ?? null,
    query.connectionId ?? null,
    query.connectionId ?? null,
    query.limit,
  ).all<VerificationRow>()

  return rows.results.map(toVerificationView)
}

export async function readAdminAttributionVerificationByIdempotencyKey(
  db: D1Database,
  input: {
    connectionId: string
    idempotencyKey: string
  },
): Promise<AdminAttributionVerificationView | null> {
  const connectionId = identifier(input.connectionId)
  const idempotencyKey = identifier(input.idempotencyKey)
  const row = await db.prepare(`
    ${VERIFICATION_SELECT}
    WHERE connection.id = ?
      AND validation.idempotency_key = ?
    LIMIT 1
  `).bind(connectionId, idempotencyKey).first<VerificationRow>()
  return row ? toVerificationView(row) : null
}

function toVerificationView(
  row: VerificationRow,
): AdminAttributionVerificationView {
  return {
    provider: getProviderAdapter(row.provider).provider,
    connectionId: identifier(row.connection_id),
    connectionName: text(row.connection_name),
    status: status(row.status),
    failureCode: text(row.failure_code, true),
    candidateChecked: booleanValue(row.candidate_checked),
    pairedEventCount: count(row.paired_event_count ?? 0),
    createdAt: timestamp(row.created_at),
    startedAt: row.started_at === null ? '' : timestamp(row.started_at),
    completedAt: row.completed_at === null
      ? ''
      : timestamp(row.completed_at),
  }
}

function normalizeQuery(
  input: AdminAttributionVerificationsQuery,
): Required<Pick<AdminAttributionVerificationsQuery, 'limit'>>
  & Omit<AdminAttributionVerificationsQuery, 'limit'> {
  if (!input || typeof input !== 'object') throw invalid()
  const dateFrom = optionalDate(input.dateFrom)
  const dateTo = optionalDate(input.dateTo)
  if (dateFrom && dateTo && dateFrom > dateTo) throw invalid()
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw invalid()
  }
  return {
    dateFrom,
    dateTo,
    provider: input.provider === undefined
      ? undefined
      : getProviderAdapter(input.provider).provider,
    connectionId: input.connectionId === undefined
      ? undefined
      : identifier(input.connectionId),
    limit,
  }
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid()
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    throw invalid()
  }
  return value
}

function status(
  value: string,
): AdminAttributionVerificationView['status'] {
  if (
    value === 'queued'
    || value === 'running'
    || value === 'verified'
    || value === 'failed'
    || value === 'timed_out'
  ) {
    return value
  }
  throw invalid()
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9:_-]{1,240}$/.test(value)
  ) {
    throw invalid()
  }
  return value
}

function text(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string'
    || value.length > 1024
    || (!allowEmpty && value.trim().length === 0)
  ) {
    throw invalid()
  }
  return value
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
  ) {
    throw invalid()
  }
  return value
}

function booleanValue(value: number): boolean {
  if (value !== 0 && value !== 1) throw invalid()
  return value === 1
}

function count(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid()
  return parsed
}

function invalid(): AttributionDomainError {
  return new AttributionDomainError(
    'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
  )
}
