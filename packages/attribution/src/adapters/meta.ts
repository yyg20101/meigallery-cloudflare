import type {
  CanonicalConversionEvent,
} from '@meigallery/shared'
import {
  adapterInputInvalid,
  assertBrowserInput,
  assertCandidateBase,
  assertCanonicalBindings,
  assertIdentifierKeys,
  assertProvider,
  assertServerInput,
  checkedAt,
  deliveryResult,
  errorQuality,
  eventTimeSeconds,
  exactStringConfig,
  isCanonicalEvent,
  isIdentifier,
  isSafeSecret,
  runtimeFetcher,
  safeRequestId,
  unavailableQuality,
  validationEvidence,
} from './common'
import type {
  AdapterRuntime,
  AttributionProviderAdapter,
  BrowserInstruction,
  BrowserInstructionInput,
  CandidateValidationInput,
  ProviderDeliveryResult,
  QualityMetric,
  QualitySignalInput,
  QualitySignalResult,
  ServerDeliveryInput,
  ValidationEvidence,
} from './types'

const META_GRAPH_API_VERSION = 'v25.0'
const META_ENDPOINT =
  `https://graph.facebook.com/${META_GRAPH_API_VERSION}`
const META_IDENTIFIER_KEYS = new Set(['fbclid', 'fbc', 'fbp'])
const FOREIGN_IDENTIFIER_KEYS = new Set([
  'ttclid',
  'ttp',
  'gclid',
  'gbraid',
  'wbraid',
])
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613])
const PIXEL_ID_PATTERN = /^\d{5,30}$/
const FACEBOOK_COOKIE_PATTERN =
  /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,1000}$/
const ACTIVE_EVENTS = new Set<CanonicalConversionEvent>([
  'Contact',
  'CompleteRegistration',
])
const QUALITY_IDENTIFIERS = new Map([
  ['ip_address', 'ip_address_coverage'],
  ['user_agent', 'user_agent_coverage'],
  ['fbp', 'fbp_coverage'],
  ['fbc', 'fbc_coverage'],
])

export function createMetaAdapter(
  runtime: AdapterRuntime = {},
): AttributionProviderAdapter {
  return {
    provider: 'meta',
    eventName,
    validateCandidate,
    buildBrowserInstruction,
    deliverServerEvent,
    readQualitySignal,
  }

  function eventName(event: CanonicalConversionEvent): string {
    if (!isCanonicalEvent(event)) throw adapterInputInvalid()
    return event
  }

  async function validateCandidate(
    input: CandidateValidationInput,
  ): Promise<ValidationEvidence> {
    assertCandidateBase(input, 'meta')
    exactStringConfig(input.publicConfig, {
      pixelId: PIXEL_ID_PATTERN,
    })
    assertCanonicalBindings(input, binding =>
      binding.browserDestination === 'meta_pixel'
      && binding.serverDestination === 'meta_capi')
    return validationEvidence(runtime, input)
  }

  function buildBrowserInstruction(
    input: BrowserInstructionInput,
  ): BrowserInstruction {
    assertBrowserInput(input, 'meta')
    if (input.destination !== 'meta_pixel') throw adapterInputInvalid()
    return {
      schemaVersion: 1,
      deliveryId: input.deliveryId,
      provider: 'meta',
      canonicalEvent: input.canonicalEvent,
      eventName: eventName(input.canonicalEvent),
      destination: input.destination,
      externalEventId: input.externalEventId,
      receiptToken: input.receiptToken,
      payload: {},
    }
  }

  async function deliverServerEvent(
    input: ServerDeliveryInput,
  ): Promise<ProviderDeliveryResult> {
    assertServerInput(input, 'meta')
    const config = exactStringConfig(input.publicConfig, {
      pixelId: PIXEL_ID_PATTERN,
    })
    if (input.destination !== 'meta_capi') throw adapterInputInvalid()
    assertIdentifierKeys(
      input.identifiers,
      META_IDENTIFIER_KEYS,
      FOREIGN_IDENTIFIER_KEYS,
    )

    const userData = metaUserData(input)
    if (Object.keys(userData).length === 0) throw adapterInputInvalid()
    const body = {
      data: [{
        event_name: eventName(input.canonicalEvent),
        event_time: eventTimeSeconds(input.occurredAt),
        event_id: input.externalEventId,
        action_source: 'website',
        event_source_url: input.pageUrl,
        user_data: userData,
      }],
    }

    let response: Response
    try {
      response = await runtimeFetcher(runtime)(
        `${META_ENDPOINT}/${config.pixelId}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      )
    } catch {
      return deliveryResult('meta', 'retryable')
    }
    return classifyMetaResponse(response)
  }

  async function readQualitySignal(
    input: QualitySignalInput,
  ): Promise<QualitySignalResult> {
    assertProvider(input?.provider, 'meta')
    if (
      !isIdentifier(input.connectionId)
      || !isIdentifier(input.versionId)
      || !isSafeSecret(input.credential)
    ) {
      throw adapterInputInvalid()
    }
    const config = exactStringConfig(input.publicConfig, {
      pixelId: PIXEL_ID_PATTERN,
    })
    const url = new URL(`${META_ENDPOINT}/dataset_quality`)
    url.searchParams.set('dataset_id', config.pixelId!)
    url.searchParams.set(
      'fields',
      'web{event_match_quality,event_name}',
    )

    let response: Response
    try {
      response = await runtimeFetcher(runtime)(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.credential}`,
          Accept: 'application/json',
        },
      })
    } catch {
      return errorQuality(runtime, 'meta', 'network_error')
    }
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? unavailableQuality(runtime, 'meta', 'permission_denied')
        : errorQuality(
            runtime,
            'meta',
            response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'provider_unavailable'
                : 'invalid_request',
          )
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return errorQuality(runtime, 'meta', 'invalid_response')
    }
    const events = extractQualityEvents(body)
    if (events === null) {
      return errorQuality(runtime, 'meta', 'invalid_response')
    }
    const metrics = parseQualityMetrics(events)
    if (metrics === null) {
      return errorQuality(runtime, 'meta', 'invalid_response')
    }
    return metrics.length === 0
      ? unavailableQuality(runtime, 'meta', 'no_recent_metrics')
      : {
          availability: 'available',
          provider: 'meta',
          metrics,
          checkedAt: checkedAt(runtime),
        }
  }
}

export const metaAdapter = createMetaAdapter()

function metaUserData(
  input: ServerDeliveryInput,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  const fbc = input.identifiers.fbc
    ?? (
      input.identifiers.fbclid
        ? `fb.1.${input.contextIssuedAt * 1_000}.${input.identifiers.fbclid}`
        : ''
    )
  if (fbc) {
    if (!FACEBOOK_COOKIE_PATTERN.test(fbc)) throw adapterInputInvalid()
    result.fbc = fbc
  }
  if (input.identifiers.fbp) {
    if (!FACEBOOK_COOKIE_PATTERN.test(input.identifiers.fbp)) {
      throw adapterInputInvalid()
    }
    result.fbp = input.identifiers.fbp
  }
  if (input.hashedEmail) result.em = [input.hashedEmail]
  if (input.clientIp) result.client_ip_address = input.clientIp
  if (input.userAgent) result.client_user_agent = input.userAgent
  return result
}

async function classifyMetaResponse(
  response: Response,
): Promise<ProviderDeliveryResult> {
  const parsed = await readMetaResponse(response)
  const details = {
    requestId: safeRequestId(
      response.headers.get('x-fb-trace-id'),
    ),
    ...(parsed.code === null ? {} : { providerCode: parsed.code }),
  }
  if (
    response.ok
    && parsed.eventsReceived !== null
    && parsed.eventsReceived >= 1
  ) {
    return deliveryResult('meta', 'accepted', response, details)
  }
  if (
    response.status === 401
    || response.status === 403
    || parsed.code === 190
    || parsed.code === 102
  ) {
    return deliveryResult('meta', 'credential_invalid', response, details)
  }
  if (
    response.status === 429
    || response.status >= 500
    || parsed.isTransient
    || (parsed.code !== null && TRANSIENT_CODES.has(parsed.code))
    || response.ok
  ) {
    return deliveryResult('meta', 'retryable', response, details)
  }
  if (
    response.status === 400
    || response.status === 404
    || response.status === 422
  ) {
    return deliveryResult('meta', 'destination_invalid', response, details)
  }
  return deliveryResult('meta', 'rejected', response, details)
}

async function readMetaResponse(response: Response): Promise<{
  eventsReceived: number | null
  code: number | null
  isTransient: boolean
}> {
  try {
    const value = await response.clone().json() as Record<string, unknown>
    const error = isRecord(value.error) ? value.error : {}
    return {
      eventsReceived: Number.isSafeInteger(value.events_received)
        ? Number(value.events_received)
        : null,
      code: Number.isSafeInteger(error.code) ? Number(error.code) : null,
      isTransient: error.is_transient === true,
    }
  } catch {
    return {
      eventsReceived: null,
      code: null,
      isTransient: false,
    }
  }
}

function extractQualityEvents(value: unknown): unknown[] | null {
  if (!isRecord(value)) return null
  const direct = connectionData(value.web)
  if (direct) return direct
  if (!Array.isArray(value.data)) return null
  const events: unknown[] = []
  for (const item of value.data) {
    if (!isRecord(item)) return null
    if (typeof item.event_name === 'string') {
      events.push(item)
      continue
    }
    const nested = connectionData(item.web)
    if (!nested) return null
    events.push(...nested)
  }
  return events
}

function connectionData(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  return isRecord(value) && Array.isArray(value.data)
    ? value.data
    : null
}

function parseQualityMetrics(events: unknown[]): QualityMetric[] | null {
  const metrics: QualityMetric[] = []
  for (const item of events) {
    if (!isRecord(item) || typeof item.event_name !== 'string') {
      return null
    }
    if (!ACTIVE_EVENTS.has(item.event_name as CanonicalConversionEvent)) {
      continue
    }
    if (!isRecord(item.event_match_quality)) return null
    const canonicalEvent = item.event_name as CanonicalConversionEvent
    const quality = item.event_match_quality
    if (
      quality.composite_score !== undefined
      && !isFiniteNumber(quality.composite_score)
    ) {
      return null
    }
    if (quality.composite_score !== undefined) {
      metrics.push({
        canonicalEvent,
        key: 'emq_score',
        value: quality.composite_score,
      })
    }
    if (quality.match_key_feedback === undefined) continue
    if (!Array.isArray(quality.match_key_feedback)) return null
    for (const feedback of quality.match_key_feedback) {
      if (!isRecord(feedback) || typeof feedback.identifier !== 'string') {
        return null
      }
      const key = QUALITY_IDENTIFIERS.get(feedback.identifier)
      if (!key) continue
      const coverage = isRecord(feedback.coverage)
        ? feedback.coverage.percentage
        : null
      if (
        !isFiniteNumber(coverage)
        || coverage < 0
        || coverage > 100
      ) {
        return null
      }
      metrics.push({
        canonicalEvent,
        key,
        value: coverage,
      })
    }
  }
  return metrics
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
