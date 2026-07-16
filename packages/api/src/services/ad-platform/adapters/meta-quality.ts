import { META_GRAPH_API_VERSION } from '../protocol-versions'

const ACTIVE_EVENTS = new Set(['Contact', 'CompleteRegistration'])
const IDENTIFIER_METRICS = new Map([
  ['ip_address', 'ip_address_coverage'],
  ['user_agent', 'user_agent_coverage'],
  ['fbp', 'fbp_coverage'],
  ['fbc', 'fbc_coverage'],
])

export type MetaQualityMetric = {
  canonicalEvent: 'Contact' | 'CompleteRegistration'
  metricKey: string
  value: number
}

export async function fetchMetaQuality(input: {
  datasetId: string
  credential: string
  fetcher?: typeof fetch
}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/dataset_quality`)
  url.searchParams.set('dataset_id', input.datasetId)
  url.searchParams.set('fields', 'web{event_match_quality,event_name}')
  const response = await (input.fetcher ?? fetch)(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${input.credential}`, Accept: 'application/json' },
  })
  if (!response.ok) return { metrics: [], errorCategory: classifyHttpError(response.status) }
  const metrics = parseMetaQualityResponse(await response.json().catch(() => null))
  return metrics.length > 0
    ? { metrics, errorCategory: '' }
    : { metrics: [], errorCategory: 'invalid_response' }
}

export function parseMetaQualityResponse(input: unknown): MetaQualityMetric[] {
  if (!isRecord(input) || !Array.isArray(input.web)) return []
  const metrics: MetaQualityMetric[] = []
  for (const event of input.web) {
    if (!isRecord(event) || !ACTIVE_EVENTS.has(String(event.event_name))) continue
    const canonicalEvent = event.event_name as MetaQualityMetric['canonicalEvent']
    const quality = event.event_match_quality
    if (!isRecord(quality)) continue
    if (isFiniteNumber(quality.composite_score)) {
      metrics.push({ canonicalEvent, metricKey: 'emq_score', value: quality.composite_score })
    }
    if (!Array.isArray(quality.match_key_feedback)) continue
    for (const feedback of quality.match_key_feedback) {
      if (!isRecord(feedback)) continue
      const metricKey = IDENTIFIER_METRICS.get(String(feedback.identifier))
      const percentage = isRecord(feedback.coverage) ? feedback.coverage.percentage : null
      if (metricKey && isFiniteNumber(percentage) && percentage >= 0 && percentage <= 100) {
        metrics.push({ canonicalEvent, metricKey, value: percentage })
      }
    }
  }
  return metrics
}

function classifyHttpError(status: number) {
  if (status === 401) return 'authentication_failed'
  if (status === 403) return 'permission_denied'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'invalid_request'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
