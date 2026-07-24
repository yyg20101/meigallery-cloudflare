import type {
  AttributionProvider,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionOperationsQuery {
  dateFrom: string
  dateTo: string
  provider?: AttributionProvider
  connectionId?: string
}

export interface AdminAttributionOperationView {
  date: string
  provider: AttributionProvider | null
  connectionId: string
  connectionName: string
  contactCount: number
  completeRegistrationCount: number
  factCount: number
  attributedFactCount: number
  unattributedFactCount: number
  browserAttempted: number
  serverPlanned: number
  serverQueued: number
  serverProcessed: number
  serverRejected: number
  serverDeadLetter: number
}

interface OperationRow {
  date: string
  provider: string | null
  connection_id: string | null
  connection_name: string | null
  contact_count: number
  complete_registration_count: number
  fact_count: number
  attributed_fact_count: number
  unattributed_fact_count: number
  browser_attempted: number
  server_planned: number
  server_queued: number
  server_processed: number
  server_rejected: number
  server_dead_letter: number
}

export async function listAdminAttributionOperations(
  db: D1Database,
  input: AdminAttributionOperationsQuery,
): Promise<AdminAttributionOperationView[]> {
  const query = normalizeOperationsQuery(input)
  const rows = await db.prepare(`
    SELECT
      date(datetime(fact.occurred_at, '+8 hours')) AS date,
      fact.provider,
      fact.connection_id,
      connection.name AS connection_name,
      SUM(CASE WHEN fact.event_name = 'Contact' THEN 1 ELSE 0 END)
        AS contact_count,
      SUM(CASE
        WHEN fact.event_name = 'CompleteRegistration' THEN 1
        ELSE 0
      END) AS complete_registration_count,
      COUNT(*) AS fact_count,
      SUM(CASE WHEN fact.connection_id IS NOT NULL THEN 1 ELSE 0 END)
        AS attributed_fact_count,
      SUM(CASE WHEN fact.connection_id IS NULL THEN 1 ELSE 0 END)
        AS unattributed_fact_count,
      SUM(CASE WHEN browser_receipt.delivery_id IS NOT NULL THEN 1 ELSE 0 END)
        AS browser_attempted,
      SUM(CASE WHEN server_delivery.id IS NOT NULL THEN 1 ELSE 0 END)
        AS server_planned,
      SUM(CASE
        WHEN server_delivery.queue_attempt_count > 0 THEN 1
        ELSE 0
      END) AS server_queued,
      SUM(CASE
        WHEN server_delivery.status IN ('accepted','processed') THEN 1
        ELSE 0
      END) AS server_processed,
      SUM(CASE WHEN server_delivery.status = 'rejected' THEN 1 ELSE 0 END)
        AS server_rejected,
      SUM(CASE WHEN server_delivery.status = 'dead_letter' THEN 1 ELSE 0 END)
        AS server_dead_letter
    FROM attribution_facts AS fact
    LEFT JOIN attribution_connections AS connection
      ON connection.id = fact.connection_id
     AND connection.provider = fact.provider
    LEFT JOIN attribution_deliveries AS browser_delivery
      ON browser_delivery.fact_id = fact.id
     AND browser_delivery.connection_id = fact.connection_id
     AND browser_delivery.transport = 'browser'
    LEFT JOIN attribution_browser_receipts AS browser_receipt
      ON browser_receipt.delivery_id = browser_delivery.id
    LEFT JOIN attribution_deliveries AS server_delivery
      ON server_delivery.fact_id = fact.id
     AND server_delivery.connection_id = fact.connection_id
     AND server_delivery.transport = 'server'
    WHERE fact.fact_origin = 'live'
      AND date(datetime(fact.occurred_at, '+8 hours')) BETWEEN ? AND ?
      AND (? IS NULL OR fact.provider = ?)
      AND (? IS NULL OR fact.connection_id = ?)
    GROUP BY
      date(datetime(fact.occurred_at, '+8 hours')),
      fact.provider,
      fact.connection_id,
      connection.name
    ORDER BY
      date ASC,
      CASE WHEN fact.connection_id IS NULL THEN 1 ELSE 0 END,
      fact.provider,
      connection.name,
      fact.connection_id
  `).bind(
    query.dateFrom,
    query.dateTo,
    query.provider ?? null,
    query.provider ?? null,
    query.connectionId ?? null,
    query.connectionId ?? null,
  ).all<OperationRow>()

  return rows.results.map(row => ({
    date: validDate(row.date),
    provider: row.provider === null
      ? null
      : getProviderAdapter(row.provider).provider,
    connectionId: row.connection_id ?? '',
    connectionName: row.connection_name ?? '',
    contactCount: count(row.contact_count),
    completeRegistrationCount: count(
      row.complete_registration_count,
    ),
    factCount: count(row.fact_count),
    attributedFactCount: count(row.attributed_fact_count),
    unattributedFactCount: count(row.unattributed_fact_count),
    browserAttempted: count(row.browser_attempted),
    serverPlanned: count(row.server_planned),
    serverQueued: count(row.server_queued),
    serverProcessed: count(row.server_processed),
    serverRejected: count(row.server_rejected),
    serverDeadLetter: count(row.server_dead_letter),
  }))
}

function normalizeOperationsQuery(
  input: AdminAttributionOperationsQuery,
): AdminAttributionOperationsQuery {
  if (!input || typeof input !== 'object') throw invalid()
  const dateFrom = validDate(input.dateFrom)
  const dateTo = validDate(input.dateTo)
  if (dateFrom > dateTo) throw invalid()
  const provider = input.provider === undefined
    ? undefined
    : getProviderAdapter(input.provider).provider
  const connectionId = input.connectionId === undefined
    ? undefined
    : identifier(input.connectionId)
  return { dateFrom, dateTo, provider, connectionId }
}

function validDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid()
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    throw invalid()
  }
  return value
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
