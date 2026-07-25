import {
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import type { AdAttributionContext } from '../utils/ad-attribution-context'
import { buildConversionDedupeKey } from '../utils/conversions'
import {
  AttributionRuntimeOwnerError,
  isAttributionForwardingOwner,
  readAttributionRuntimeOwner,
} from './attribution-runtime-owner'
import {
  createAttributionServiceClient,
} from './attribution-service-client'
import {
  recordContact,
  type RecordContactInput,
  type RecordConversionResult,
} from './conversions'

type ContactRouterEnvironment = Pick<
  Bindings,
  | 'DB'
  | 'SITE_URL'
  | 'ATTRIBUTION'
  | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT'
  | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS'
  | 'AD_META_QUEUE'
  | 'AD_TIKTOK_QUEUE'
  | 'AD_GOOGLE_QUEUE'
>

export interface RouteContactConversionInput {
  conversion: RecordContactInput
  sourceContextToken: string | null
  legacyContext: AdAttributionContext | null
  requestMetadata: {
    clientIp?: string
    userAgent?: string
  }
}

export interface RoutedContactConversionResult
  extends RecordConversionResult {
  attributionInstructionToken: string | null
}

export async function routeContactConversion(
  environment: ContactRouterEnvironment,
  input: RouteContactConversionInput,
): Promise<RoutedContactConversionResult> {
  let ownership = await readAttributionRuntimeOwner(environment.DB)
  if (ownership.owner === 'old') {
    try {
      return {
        ...await recordContact(
          environment,
          input.conversion,
          ownership,
        ),
        attributionInstructionToken: null,
      }
    } catch (error) {
      if (
        !(error instanceof AttributionRuntimeOwnerError)
        || error.code !== 'ATTRIBUTION_RUNTIME_OWNER_CHANGED'
      ) {
        throw error
      }
      ownership = await readAttributionRuntimeOwner(environment.DB)
    }
  }

  if (!isAttributionForwardingOwner(ownership)) {
    throw new Error('ATTRIBUTION_RUNTIME_FORWARDING_NOT_READY')
  }

  const client = createAttributionServiceClient(environment.ATTRIBUTION)
  const event = await buildForwardedContactEvent(
    client,
    input,
  )
  await client.ingestContactEvent({
    event,
    requestMetadata: input.requestMetadata,
  }, ownership)

  let attributionInstructionToken: string | null = null
  if (
    event.consent.marketingAllowed
    && event.sourceContextToken !== null
  ) {
    try {
      attributionInstructionToken = (
        await client.getSignedBrowserInstruction({
          eventId: event.eventId,
        }, ownership)
      ).instructionToken
    } catch {
      // Server 投递已被接受时，Browser 指令不可用不得回滚事实。
    }
  }

  return {
    id: event.eventId,
    actionType: 'contact',
    created: true,
    duplicateOf: '',
    trackingInstructions: [],
    attributionInstructionToken,
  }
}

async function buildForwardedContactEvent(
  client: ReturnType<typeof createAttributionServiceClient>,
  input: RouteContactConversionInput,
): Promise<AttributionBusinessEventV1> {
  const conversion = input.conversion
  const occurredAt = canonicalTimestamp(conversion.occurredAt)
  const legacyDedupeKey = buildConversionDedupeKey({
    actionType: 'contact',
    visitorId: conversion.visitorId,
    sessionId: conversion.sessionId,
    occurredDate: occurredAt.slice(0, 10),
    methodType: conversion.contactPlatform,
    actionTarget: conversion.contactMethodId,
  })
  const digest = await sha256Hex(
    `attribution-contact-bridge:v1:${legacyDedupeKey}`,
  )
  let sourceContextToken = conversion.consentSnapshot.marketingAllowed
    ? input.sourceContextToken
    : null
  if (
    sourceContextToken === null
    && conversion.consentSnapshot.marketingAllowed
    && input.legacyContext
  ) {
    sourceContextToken = (
      await client.translateLegacyContext({
        provider: input.legacyContext.provider,
        identifiers: input.legacyContext.identifiers,
        idempotencyKey:
          `legacy_context_${input.legacyContext.contextId}`,
      })
    ).sourceContextToken
  }

  const event: AttributionBusinessEventV1 = {
    schemaVersion: 1,
    eventId: `legacy_contact_${digest}`,
    eventName: 'Contact',
    occurredAt,
    pagePath: canonicalPagePath(conversion.path),
    dedupeKey: `legacy_contact:${digest}`,
    sourceContextToken,
    consent: {
      marketingAllowed:
        conversion.consentSnapshot.marketingAllowed,
      adUserDataAllowed:
        conversion.consentSnapshot.adUserDataAllowed,
      adPersonalizationAllowed:
        conversion.consentSnapshot.adPersonalizationAllowed,
    },
    payload: {
      contactMethodId: conversion.contactMethodId,
      contactPlatform: conversion.contactPlatform,
      contactAction: conversion.actionType,
    },
  }
  if (!isAttributionBusinessEventV1(event)) {
    throw new Error('ATTRIBUTION_CONTACT_BRIDGE_EVENT_INVALID')
  }
  return event
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString()
}

function canonicalPagePath(value: string | undefined): string {
  if (
    typeof value !== 'string'
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('#')
    || value.length > 2_048
    || /\p{Cc}/u.test(value)
  ) {
    return '/'
  }
  try {
    const base = new URL('https://attribution.invalid/')
    const resolved = new URL(value, base)
    return resolved.origin === base.origin
      && `${resolved.pathname}${resolved.search}` === value
      ? value
      : '/'
  } catch {
    return '/'
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}
