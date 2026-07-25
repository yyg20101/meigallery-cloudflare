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
  deliveryResult,
  eventTimeSeconds,
  exactStringConfig,
  isCanonicalEvent,
  isIdentifier,
  isSafeSecret,
  isSafeText,
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
  QualitySignalInput,
  QualitySignalResult,
  ServerDeliveryInput,
  ValidationEvidence,
} from './types'

const TIKTOK_ENDPOINT =
  'https://business-api.tiktok.com/open_api/v1.3/event/track/'
const TIKTOK_IDENTIFIER_KEYS = new Set(['ttclid', 'ttp'])
const FOREIGN_IDENTIFIER_KEYS = new Set([
  'fbclid',
  'fbc',
  'fbp',
  'gclid',
  'gbraid',
  'wbraid',
])
const RETRYABLE_CODES = new Set([40016, 40100, 40133, 40202, 60001])
const PIXEL_CODE_PATTERN = /^[A-Z0-9]{10,30}$/
const TEST_EVENT_CODE_PATTERN = /^[A-Za-z0-9_-]{4,128}$/

export function createTikTokAdapter(
  runtime: AdapterRuntime = {},
): AttributionProviderAdapter {
  return {
    provider: 'tiktok',
    eventName,
    activeTarget,
    normalizeTestEventCode,
    validateCandidate,
    buildBrowserInstruction,
    deliverServerEvent,
    readQualitySignal,
  }

  function eventName(event: CanonicalConversionEvent): string {
    if (!isCanonicalEvent(event)) throw adapterInputInvalid()
    return event
  }

  function activeTarget(
    publicConfig: Record<string, string>,
  ): string {
    return exactStringConfig(publicConfig, {
      pixelCode: PIXEL_CODE_PATTERN,
    }).pixelCode!
  }

  function normalizeTestEventCode(
    value: unknown,
  ): string | undefined | null {
    if (value === undefined || value === null || value === '') {
      return null
    }
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    return TEST_EVENT_CODE_PATTERN.test(normalized)
      ? normalized
      : null
  }

  async function validateCandidate(
    input: CandidateValidationInput,
  ): Promise<ValidationEvidence> {
    assertCandidateBase(input, 'tiktok')
    exactStringConfig(input.publicConfig, {
      pixelCode: PIXEL_CODE_PATTERN,
    })
    assertCanonicalBindings(input, binding =>
      binding.browserDestination === 'tiktok_pixel'
      && binding.serverDestination === 'tiktok_events_api')
    if (
      input.testEventCode !== undefined
      && normalizeTestEventCode(input.testEventCode) !== input.testEventCode
    ) {
      throw adapterInputInvalid()
    }
    return validationEvidence(runtime, input)
  }

  function buildBrowserInstruction(
    input: BrowserInstructionInput,
  ): BrowserInstruction {
    assertBrowserInput(input, 'tiktok')
    if (input.destination !== 'tiktok_pixel') throw adapterInputInvalid()
    return {
      schemaVersion: 1,
      deliveryId: input.deliveryId,
      provider: 'tiktok',
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
    assertServerInput(input, 'tiktok')
    const config = exactStringConfig(input.publicConfig, {
      pixelCode: PIXEL_CODE_PATTERN,
    })
    if (input.destination !== 'tiktok_events_api') {
      throw adapterInputInvalid()
    }
    assertIdentifierKeys(
      input.identifiers,
      TIKTOK_IDENTIFIER_KEYS,
      FOREIGN_IDENTIFIER_KEYS,
    )

    const user = tiktokUser(input)
    if (Object.keys(user).length === 0) throw adapterInputInvalid()
    const testEventCode = normalizeTestEventCode(input.testEventCode)
    if (
      (input.validateOnly && !testEventCode)
      || (!input.validateOnly && input.testEventCode !== undefined)
    ) {
      throw adapterInputInvalid()
    }
    const body = {
      event_source: 'web',
      event_source_id: config.pixelCode,
      ...(testEventCode ? { test_event_code: testEventCode } : {}),
      data: [{
        event: eventName(input.canonicalEvent),
        event_time: eventTimeSeconds(input.occurredAt),
        event_id: input.externalEventId,
        user,
        page: { url: input.pageUrl },
      }],
    }

    let response: Response
    try {
      response = await runtimeFetcher(runtime)(TIKTOK_ENDPOINT, {
        method: 'POST',
        headers: {
          'Access-Token': input.credential,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch {
      return deliveryResult('tiktok', 'retryable')
    }
    return classifyTikTokResponse(response)
  }

  async function readQualitySignal(
    input: QualitySignalInput,
  ): Promise<QualitySignalResult> {
    assertProvider(input?.provider, 'tiktok')
    if (
      !isIdentifier(input.connectionId)
      || !isIdentifier(input.versionId)
      || !isSafeSecret(input.credential)
    ) {
      throw adapterInputInvalid()
    }
    exactStringConfig(input.publicConfig, {
      pixelCode: PIXEL_CODE_PATTERN,
    })
    return unavailableQuality(
      runtime,
      'tiktok',
      'account_quality_api_not_configured',
    )
  }
}

export const tiktokAdapter = createTikTokAdapter()

function tiktokUser(
  input: ServerDeliveryInput,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  if (input.identifiers.ttclid) {
    if (!isSafeText(input.identifiers.ttclid, 1_000)) {
      throw adapterInputInvalid()
    }
    result.ttclid = input.identifiers.ttclid
  }
  if (input.identifiers.ttp) {
    if (!isSafeText(input.identifiers.ttp, 256)) {
      throw adapterInputInvalid()
    }
    result.ttp = input.identifiers.ttp
  }
  if (input.hashedEmail) result.email = [input.hashedEmail]
  if (input.clientIp) result.ip = input.clientIp
  if (input.userAgent) result.user_agent = input.userAgent
  return result
}

async function classifyTikTokResponse(
  response: Response,
): Promise<ProviderDeliveryResult> {
  const parsed = await readTikTokResponse(response)
  const details = {
    requestId: safeRequestId(parsed.requestId),
    ...(parsed.code === null ? {} : { providerCode: parsed.code }),
  }
  if (response.ok && parsed.code === 0) {
    return deliveryResult('tiktok', 'accepted', response, details)
  }
  if (
    response.status === 401
    || response.status === 403
    || (
      parsed.code !== null
      && parsed.code >= 40_101
      && parsed.code <= 40_105
    )
  ) {
    return deliveryResult(
      'tiktok',
      'credential_invalid',
      response,
      details,
    )
  }
  if (
    response.status === 429
    || response.status >= 500
    || (
      parsed.code !== null
      && (
        RETRYABLE_CODES.has(parsed.code)
        || (parsed.code >= 50_000 && parsed.code < 60_000)
      )
    )
    || (response.ok && parsed.code === null)
  ) {
    return deliveryResult('tiktok', 'retryable', response, details)
  }
  if (
    response.status === 400
    || response.status === 404
    || response.status === 422
    || (
      parsed.code !== null
      && parsed.code >= 40_000
      && parsed.code < 50_000
    )
  ) {
    return deliveryResult(
      'tiktok',
      'destination_invalid',
      response,
      details,
    )
  }
  return deliveryResult('tiktok', 'rejected', response, details)
}

async function readTikTokResponse(response: Response): Promise<{
  code: number | null
  requestId: string
}> {
  try {
    const value = await response.clone().json() as Record<string, unknown>
    return {
      code: Number.isSafeInteger(value.code) ? Number(value.code) : null,
      requestId: safeRequestId(value.request_id),
    }
  } catch {
    return { code: null, requestId: '' }
  }
}
