import type { Bindings } from '../index'
import { META_GRAPH_API_VERSION, metaGraphRequestInit } from './meta-graph'

const CONTRACT_VERSION = 1
const CONTRACT_DIGEST = 'sha256:28ec95b732afb273bd67c96d3e2780ce4ac1ebf40f206db5be2843fa72a685b4'
const ACTIVE_EVENTS = new Set(['Contact', 'CompleteRegistration'])
const IDENTIFIER_METRICS = new Map([
  ['ip_address', 'ip_address_coverage'],
  ['user_agent', 'user_agent_coverage'],
  ['fbp', 'fbp_coverage'],
  ['fbc', 'fbc_coverage'],
])

type DatasetQualityEnv = Pick<Bindings, 'APP_ENV' | 'DB' | 'META_CAPI_ACCESS_TOKEN'>
type DatasetQualityMetric = { eventName: string; metricKey: string; value: number }

export type DatasetQualityCollectionResult = {
  status: 'success' | 'skipped' | 'error'
  metricCount: number
  errorCategory: string
}

export async function collectMetaDatasetQuality(
  env: DatasetQualityEnv,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<DatasetQualityCollectionResult> {
  if (env.APP_ENV !== 'production') {
    return { status: 'skipped', metricCount: 0, errorCategory: 'environment_not_supported' }
  }

  const datasetId = await readDatasetId(env.DB)
  const accessToken = configuredValue(env.META_CAPI_ACCESS_TOKEN)
  if (!datasetId || !accessToken) {
    await persistError(env.DB, datasetId, now, 'not_configured')
    return { status: 'error', metricCount: 0, errorCategory: 'not_configured' }
  }

  let response: Response
  try {
    const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/dataset_quality`)
    url.searchParams.set('dataset_id', datasetId)
    url.searchParams.set('fields', 'web{event_match_quality,event_name}')
    response = await fetcher(url.toString(), metaGraphRequestInit(accessToken, { method: 'GET' }))
  } catch {
    await persistError(env.DB, datasetId, now, 'network_error')
    await updateConnectionQualityStatus(env.DB, 'error')
    return { status: 'error', metricCount: 0, errorCategory: 'network_error' }
  }

  if (!response.ok) {
    const category = classifyHttpError(response.status)
    await persistError(env.DB, datasetId, now, category)
    await updateConnectionQualityStatus(env.DB, category === 'permission_denied' ? 'permission_denied' : 'error')
    return { status: 'error', metricCount: 0, errorCategory: category }
  }

  const metrics = parseQualityResponse(await response.json().catch(() => null))
  if (metrics.length === 0) {
    await persistError(env.DB, datasetId, now, 'invalid_response')
    await updateConnectionQualityStatus(env.DB, 'error')
    return { status: 'error', metricCount: 0, errorCategory: 'invalid_response' }
  }

  await env.DB.batch(metrics.map(metric => qualityInsert(env.DB, datasetId, now, metric)))
  await updateConnectionQualityStatus(env.DB, 'available')
  return { status: 'success', metricCount: metrics.length, errorCategory: '' }
}

export function parseQualityResponse(input: unknown): DatasetQualityMetric[] {
  if (!isRecord(input) || !Array.isArray(input.web)) return []
  const metrics: DatasetQualityMetric[] = []
  for (const event of input.web) {
    if (!isRecord(event) || typeof event.event_name !== 'string' || !ACTIVE_EVENTS.has(event.event_name)) continue
    const quality = event.event_match_quality
    if (!isRecord(quality)) continue
    if (isFiniteNumber(quality.composite_score)) {
      metrics.push({ eventName: event.event_name, metricKey: 'emq_score', value: quality.composite_score })
    }
    if (!Array.isArray(quality.match_key_feedback)) continue
    for (const feedback of quality.match_key_feedback) {
      if (!isRecord(feedback) || typeof feedback.identifier !== 'string') continue
      const metricKey = IDENTIFIER_METRICS.get(feedback.identifier)
      const percentage = isRecord(feedback.coverage) ? feedback.coverage.percentage : null
      if (metricKey && isFiniteNumber(percentage) && percentage >= 0 && percentage <= 100) {
        metrics.push({ eventName: event.event_name, metricKey, value: percentage })
      }
    }
  }
  return metrics
}

async function readDatasetId(db: D1Database) {
  const row = await db.prepare("SELECT destination_id FROM ad_platform_connections WHERE provider = 'meta'")
    .first<{ destination_id: string }>()
  const datasetId = String(row?.destination_id ?? '').trim()
  return /^\d{5,30}$/.test(datasetId) ? datasetId : ''
}

function qualityInsert(db: D1Database, datasetId: string, now: Date, metric: DatasetQualityMetric) {
  return db.prepare(`
    INSERT INTO meta_dataset_quality_snapshots (
      id, environment, dataset_id, event_name, metric_key, metric_value,
      collection_status, error_category, collected_at, contract_version, contract_digest
    ) VALUES (?, 'production', ?, ?, ?, ?, 'success', '', ?, ?, ?)
  `).bind(
    crypto.randomUUID(), datasetId, metric.eventName, metric.metricKey, metric.value,
    now.toISOString(), CONTRACT_VERSION, CONTRACT_DIGEST,
  )
}

async function persistError(db: D1Database, datasetId: string, now: Date, category: string) {
  if (!datasetId) return
  await db.batch(['Contact', 'CompleteRegistration'].map(eventName => db.prepare(`
    INSERT INTO meta_dataset_quality_snapshots (
      id, environment, dataset_id, event_name, metric_key, metric_value,
      collection_status, error_category, collected_at, contract_version, contract_digest
    ) VALUES (?, 'production', ?, ?, 'emq_score', NULL, 'error', ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), datasetId, eventName, category, now.toISOString(), CONTRACT_VERSION, CONTRACT_DIGEST)))
}

async function updateConnectionQualityStatus(
  db: D1Database,
  status: 'available' | 'permission_denied' | 'error',
) {
  await db.prepare(`
    UPDATE meta_connection_verifications
    SET dataset_quality_status = ?, updated_at = datetime('now')
    WHERE environment = 'production' AND invalidated_at IS NULL
  `).bind(status).run()
}

function classifyHttpError(status: number) {
  if (status === 401) return 'authentication_failed'
  if (status === 403) return 'permission_denied'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'invalid_request'
}

function configuredValue(value: unknown) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
