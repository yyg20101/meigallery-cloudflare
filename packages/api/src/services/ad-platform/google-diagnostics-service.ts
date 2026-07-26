import type { CanonicalConversionEvent } from '@meigallery/shared'
import { readAttributionCredential } from './credential-vault'
import { retrieveGoogleRequestStatus, type GoogleDiagnosticResult } from './adapters/google-diagnostics'

const FIRST_CHECK_MS = 30 * 60 * 1_000
const MAX_CHECK_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_BACKOFF_MS = 60 * 60 * 1_000
const BACKOFF_MULTIPLIER = 1.3
// Workers Free 每次调用最多 50 个外部 subrequest，保留 10 个给 OAuth、重定向和维护调用。
const MAX_LIMIT = 40
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

type DiagnosticsEnv = {
  APP_ENV?: string
  DB: D1Database
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
}

type DiagnosticRow = {
  delivery_id: string
  connection_id: string
  canonical_event: string
  public_config_json: string
  encryption_context: string
  accepted_at: string
  receipt_json: string | null
  diagnostic_count: number
  last_diagnostic_at: string | null
}

type Dependencies = {
  retrieveStatus?: typeof retrieveGoogleRequestStatus
  readCredential?: typeof readAttributionCredential
}

export type GoogleDiagnosticsReport = {
  scanned: number
  processed: number
  rejected: number
  processing: number
  retryable: number
  timedOut: number
  skipped: number
}

export async function reconcileGoogleDeliveryDiagnostics(
  env: DiagnosticsEnv,
  now = new Date(),
  limit = MAX_LIMIT,
  dependencies: Dependencies = {},
): Promise<GoogleDiagnosticsReport> {
  const report = emptyReport()
  if (env.APP_ENV !== 'production' || !Number.isFinite(now.getTime())) return report
  const rows = await listAcceptedGoogleDeliveries(env.DB, now, normalizeLimit(limit))
  report.scanned = rows.length
  for (const row of rows) {
    const acceptedAt = timestamp(row.accepted_at)
    if (acceptedAt === null) {
      if (await finalize(env.DB, row, now, 'rejected', 'google_accepted_at_invalid', emptyDiagnostic('rejected'))) report.rejected += 1
      continue
    }
    const age = now.getTime() - acceptedAt
    if (age > MAX_CHECK_AGE_MS) {
      if (await finalize(env.DB, row, now, 'rejected', 'google_diagnostic_timeout', emptyDiagnostic('rejected'), true)) {
        report.rejected += 1
        report.timedOut += 1
      }
      continue
    }
    if (!due(row, now.getTime(), acceptedAt)) {
      report.skipped += 1
      continue
    }

    const requestId = requestIdFromReceipt(row.receipt_json)
    if (!requestId) {
      if (await finalize(env.DB, row, now, 'rejected', 'google_request_id_missing', emptyDiagnostic('rejected'))) report.rejected += 1
      continue
    }
    const config = googleConfig(row.public_config_json)
    if (!config) {
      if (await finalize(env.DB, row, now, 'rejected', 'google_destination_invalid', emptyDiagnostic('rejected'))) report.rejected += 1
      continue
    }

    let diagnostic: GoogleDiagnosticResult
    try {
      const credential = await (dependencies.readCredential ?? readAttributionCredential)(env, {
        connectionId: row.connection_id,
        provider: 'google',
        credentialType: 'service_account_json',
        encryptionContext: row.encryption_context,
      })
      diagnostic = await (dependencies.retrieveStatus ?? retrieveGoogleRequestStatus)({
        requestId,
        cloudProjectId: config.cloudProjectId,
        serviceAccount: credential,
      })
    }
    catch {
      diagnostic = emptyDiagnostic('retryable')
    }

    if (diagnostic.classification === 'processed') {
      if (await finalize(env.DB, row, now, 'processed', '', diagnostic)) report.processed += 1
      continue
    }
    if (diagnostic.classification === 'rejected' || diagnostic.classification === 'credential_invalid') {
      const code = diagnostic.classification === 'credential_invalid' ? 'google_diagnostic_credential_invalid' : 'google_processing_failed'
      if (await finalize(env.DB, row, now, 'rejected', code, diagnostic, diagnostic.classification === 'credential_invalid')) report.rejected += 1
      continue
    }

    await recordPendingDiagnostic(env.DB, row, now, diagnostic)
    if (diagnostic.classification === 'processing') report.processing += 1
    else report.retryable += 1
  }
  return report
}

async function listAcceptedGoogleDeliveries(db: D1Database, now: Date, limit: number) {
  if (limit === 0) return []
  const result = await db.prepare(`
    WITH accepted_google AS (
      SELECT
        delivery.id AS delivery_id,
        delivery.connection_id,
        fact.canonical_event,
        connection.public_config_json,
        credential.encryption_context,
        delivery.accepted_at,
        (
          SELECT receipt.receipt_json
          FROM attribution_provider_receipts AS receipt
          WHERE receipt.delivery_id = delivery.id
            AND receipt.provider = 'google'
            AND receipt.receipt_type = 'server_delivery'
          ORDER BY receipt.received_at DESC, receipt.id DESC
          LIMIT 1
        ) AS receipt_json,
        (
          SELECT COUNT(*)
          FROM attribution_provider_receipts AS diagnostic
          WHERE diagnostic.delivery_id = delivery.id
            AND diagnostic.provider = 'google'
            AND diagnostic.receipt_type = 'google_request_status'
        ) AS diagnostic_count,
        (
          SELECT MAX(diagnostic.received_at)
          FROM attribution_provider_receipts AS diagnostic
          WHERE diagnostic.delivery_id = delivery.id
            AND diagnostic.provider = 'google'
            AND diagnostic.receipt_type = 'google_request_status'
        ) AS last_diagnostic_at
      FROM attribution_deliveries AS delivery
      JOIN attribution_conversion_facts AS fact
        ON fact.id = delivery.fact_id AND fact.attribution_provider = delivery.provider
      JOIN attribution_platform_connections AS connection
        ON connection.id = delivery.connection_id AND connection.provider = delivery.provider
      JOIN attribution_credentials AS credential
        ON credential.connection_id = connection.id
      WHERE delivery.provider = 'google'
        AND delivery.transport = 'server'
        AND delivery.status = 'accepted'
    )
    SELECT *
    FROM accepted_google
    WHERE datetime(accepted_at) IS NULL
      OR datetime(accepted_at) <= datetime(?)
      OR (diagnostic_count = 0 AND datetime(accepted_at) <= datetime(?))
      OR (diagnostic_count > 0 AND (
        datetime(last_diagnostic_at) IS NULL
        OR (diagnostic_count = 1 AND datetime(last_diagnostic_at) <= datetime(?))
        OR (diagnostic_count = 2 AND datetime(last_diagnostic_at) <= datetime(?))
        OR (diagnostic_count >= 3 AND datetime(last_diagnostic_at) <= datetime(?))
      ))
    ORDER BY
      CASE
        WHEN datetime(accepted_at) IS NULL OR datetime(accepted_at) <= datetime(?) THEN 0
        ELSE 1
      END ASC,
      COALESCE(last_diagnostic_at, accepted_at) ASC,
      delivery_id ASC
    LIMIT ?
  `).bind(
    cutoff(now, MAX_CHECK_AGE_MS),
    cutoff(now, FIRST_CHECK_MS),
    cutoff(now, diagnosticBackoffMs(1)),
    cutoff(now, diagnosticBackoffMs(2)),
    cutoff(now, diagnosticBackoffMs(3)),
    cutoff(now, MAX_CHECK_AGE_MS),
    limit,
  ).all<DiagnosticRow>()
  return result.results
}

async function recordPendingDiagnostic(db: D1Database, row: DiagnosticRow, now: Date, diagnostic: GoogleDiagnosticResult) {
  const attempt = Math.max(0, Number(row.diagnostic_count) || 0) + 1
  await db.prepare(`
    INSERT OR IGNORE INTO attribution_provider_receipts (
      id, delivery_id, provider, receipt_type, status, receipt_json, received_at
    )
    SELECT ?, id, provider, 'google_request_status', ?, ?, ?
    FROM attribution_deliveries
    WHERE id = ? AND provider = 'google' AND transport = 'server' AND status = 'accepted'
  `).bind(
    `gdiag_${row.delivery_id}_${attempt}`,
    diagnostic.classification,
    JSON.stringify(safeDiagnostic(diagnostic)),
    now.toISOString(),
    row.delivery_id,
  ).run()
}

async function finalize(
  db: D1Database,
  row: DiagnosticRow,
  now: Date,
  status: 'processed' | 'rejected',
  errorCode: string,
  diagnostic: GoogleDiagnosticResult,
  incident = false,
) {
  if (!isCanonicalEvent(row.canonical_event)) return false
  const fence = `google_diagnostic:${crypto.randomUUID()}`
  const receiptId = `gdiag_${row.delivery_id}_final`
  const category = firstReason(diagnostic) || errorCode
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = ?, last_error_code = ?, last_error_message = '',
        processed_at = CASE WHEN ? = 'processed' THEN ? ELSE processed_at END,
        updated_at = ?
      WHERE id = ? AND provider = 'google' AND transport = 'server' AND status = 'accepted'
    `).bind(status, fence, status, now.toISOString(), now.toISOString(), row.delivery_id),
    db.prepare(`
      INSERT OR IGNORE INTO attribution_provider_receipts (
        id, delivery_id, provider, receipt_type, status, receipt_json, received_at
      )
      SELECT ?, id, provider, 'google_request_status', ?, ?, ?
      FROM attribution_deliveries
      WHERE id = ? AND provider = 'google' AND status = ? AND last_error_code = ?
    `).bind(receiptId, status, JSON.stringify(safeDiagnostic(diagnostic)), now.toISOString(), row.delivery_id, status, fence),
    db.prepare(`
      INSERT INTO attribution_quality_snapshots (
        id, connection_id, provider, canonical_event, metric_key, metric_value,
        collection_status, error_category, collected_at
      )
      SELECT ?, connection_id, provider, ?, 'request_processing_success', ?, ?, ?, ?
      FROM attribution_deliveries
      WHERE id = ? AND provider = 'google' AND status = ? AND last_error_code = ?
    `).bind(
      crypto.randomUUID(),
      row.canonical_event,
      status === 'processed' ? '1' : '0',
      status === 'processed' ? 'success' : 'error',
      status === 'processed' ? '' : category,
      now.toISOString(),
      row.delivery_id,
      status,
      fence,
    ),
    ...(incident ? [db.prepare(`
      INSERT INTO attribution_incidents (
        id, connection_id, provider, status, severity, trigger_code, summary, evidence_json, opened_at
      )
      SELECT ?, connection_id, provider, 'open', 'warning', ?, 'Google 异步诊断未完成', '{}', ?
      FROM attribution_deliveries
      WHERE id = ? AND provider = 'google' AND status = ? AND last_error_code = ?
    `).bind(crypto.randomUUID(), errorCode, now.toISOString(), row.delivery_id, status, fence)] : []),
    db.prepare(`
      UPDATE attribution_deliveries
      SET last_error_code = ?
      WHERE id = ? AND provider = 'google' AND status = ? AND last_error_code = ?
    `).bind(errorCode, row.delivery_id, status, fence),
  ])
  return changed(results[0])
}

function due(row: DiagnosticRow, now: number, acceptedAt: number) {
  const count = Math.max(0, Number(row.diagnostic_count) || 0)
  if (count === 0) return now >= acceptedAt + FIRST_CHECK_MS
  const last = timestamp(row.last_diagnostic_at)
  if (last === null) return true
  return now >= last + diagnosticBackoffMs(count)
}

function diagnosticBackoffMs(count: number) {
  return Math.min(MAX_BACKOFF_MS, FIRST_CHECK_MS * BACKOFF_MULTIPLIER ** Math.max(0, count))
}

function cutoff(now: Date, durationMs: number) {
  return new Date(now.getTime() - durationMs).toISOString()
}

function requestIdFromReceipt(value: string | null) {
  try {
    const parsed: unknown = JSON.parse(value ?? '')
    if (!isRecord(parsed) || typeof parsed.requestId !== 'string' || !REQUEST_ID_PATTERN.test(parsed.requestId)) return ''
    return parsed.requestId
  }
  catch { return '' }
}

function googleConfig(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) && typeof parsed.cloudProjectId === 'string' && GCP_PROJECT_ID_PATTERN.test(parsed.cloudProjectId)
      ? { cloudProjectId: parsed.cloudProjectId }
      : null
  }
  catch { return null }
}

function safeDiagnostic(value: GoogleDiagnosticResult) {
  return {
    status: value.status,
    requestStatus: safeText(value.requestStatus),
    errorReasons: safeReasons(value.errorReasons),
    warningReasons: safeReasons(value.warningReasons),
  }
}

function firstReason(value: GoogleDiagnosticResult) {
  return safeReasons(value.errorReasons)[0] ?? safeReasons(value.warningReasons)[0] ?? ''
}

function safeReasons(value: string[] | undefined) {
  return Array.isArray(value) ? value.filter(item => /^(?:PROCESSING_ERROR|PROCESSING_WARNING)_REASON_[A-Z0-9_]{1,120}$/.test(item)).slice(0, 20) : []
}

function safeText(value: unknown) {
  return typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : ''
}

function emptyDiagnostic(classification: GoogleDiagnosticResult['classification']): GoogleDiagnosticResult {
  return { classification, status: 0, requestStatus: '' }
}

function emptyReport(): GoogleDiagnosticsReport {
  return { scanned: 0, processed: 0, rejected: 0, processing: 0, retryable: 0, timedOut: 0, skipped: 0 }
}

function timestamp(value: string | null) {
  if (typeof value !== 'string') return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeLimit(value: number) {
  return Math.min(MAX_LIMIT, Math.max(0, Number.isFinite(value) ? Math.trunc(value) : MAX_LIMIT))
}

function changed(result: D1Result<unknown> | undefined) {
  return (result?.meta?.changes ?? 0) > 0
}

function isCanonicalEvent(value: string): value is CanonicalConversionEvent {
  return value === 'Contact' || value === 'CompleteRegistration'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
