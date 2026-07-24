import {
  isAttributionBusinessEventV1,
  type AttributionProvider,
  type CanonicalConversionEvent,
} from '@meigallery/shared'
import { Hono } from 'hono'
import { getProviderAdapter } from '../adapters/registry'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import {
  signAttributionToken,
} from '../security/signed-token'
import {
  issueContactCapability,
  type ContactCapabilityInput,
} from '../services/contact-capability'
import {
  recordCanonicalFact,
} from '../services/fact-service'
import {
  readPrivacyChoiceToken,
} from '../services/privacy-choice'
import {
  readPrivacyPolicy,
  resolvePrivacyDecision,
} from '../services/privacy-policy'
import {
  enqueueServerDelivery,
} from '../services/secure-outbox'

export interface InternalAttributionVariables {
  attributionEnvironment: AttributionEnvironment
}

export interface InternalAttributionRouteOptions {
  now?: () => Date
}

export type ContactCapabilityRequestItem = ContactCapabilityInput

export interface ContactCapabilityResponseItem
  extends ContactCapabilityRequestItem {
  attributionCapability: string
}

interface BrowserDeliveryRow {
  delivery_id: string
  connection_id: string
  version_id: string
  provider: string
  destination: string
  external_event_id: string
  event_name: string
  occurred_at: string
}

const MAX_CONTACT_CAPABILITIES = 100
const BROWSER_INSTRUCTION_LIFETIME_SECONDS = 5 * 60
const EVENT_MAX_AGE_SECONDS = 24 * 60 * 60
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const DESTINATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])

type InternalRouteEnvironment = {
  Bindings: AttributionBindings
  Variables: InternalAttributionVariables
}

export function createInternalAttributionRoutes(
  options: InternalAttributionRouteOptions = {},
) {
  const routes = new Hono<InternalRouteEnvironment>()

  routes.post('/privacy-decision', async (c) => {
    const body = await readJson(c.req.raw)
    const input = parsePrivacyDecisionRequest(body)
    if (!input) {
      return c.json({
        statusCode: 400,
        message: '归因隐私判定请求格式无效',
        code: 'ATTRIBUTION_PRIVACY_DECISION_REQUEST_INVALID',
      }, 400)
    }

    try {
      const runtime = c.get('attributionEnvironment')
      const policy = await readPrivacyPolicy(c.env.DB)
      const choice = await readPrivacyChoiceToken({
        signingKeys: runtime.signingKeys,
        nowSeconds: () => Math.floor(
          trustedNow(options.now).getTime() / 1_000,
        ),
      }, input.privacyToken)
      return c.json(resolvePrivacyDecision(policy, {
        country: input.country,
        choice,
        gpc: input.gpc,
      }))
    } catch {
      return c.json({
        statusCode: 503,
        message: '归因隐私判定暂时不可用',
        code: 'ATTRIBUTION_PRIVACY_DECISION_UNAVAILABLE',
      }, 503)
    }
  })

  routes.post('/registration-events', async (c) => {
    const body = await readJson(c.req.raw)
    if (
      !isAttributionBusinessEventV1(body)
      || body.eventName !== 'CompleteRegistration'
    ) {
      return c.json({
        statusCode: 400,
        message: '注册归因事件格式无效',
        code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
      }, 400)
    }

    try {
      const runtime = c.get('attributionEnvironment')
      const now = trustedNow(options.now)
      const result = await recordCanonicalFact({
        db: c.env.DB,
        signingKeys: runtime.signingKeys,
        encryptionKeys: runtime.dataEncryptionKeys,
        now: () => now,
      }, body)
      for (const delivery of result.deliveries) {
        if (
          delivery.transport !== 'server'
          || delivery.status !== 'planned'
        ) {
          continue
        }
        await enqueueServerDelivery({
          db: c.env.DB,
          queues: runtime.queues,
          now: () => now,
        }, {
          provider: delivery.provider,
          deliveryId: delivery.id,
        })
      }
      return c.json({
        accepted: true as const,
        eventId: body.eventId,
      }, 202)
    } catch {
      return c.json({
        statusCode: 503,
        message: '注册归因事件暂时无法接收',
        code: 'ATTRIBUTION_REGISTRATION_EVENT_UNAVAILABLE',
      }, 503)
    }
  })

  routes.get(
    '/events/:eventId/browser-instruction',
    async (c) => {
      const eventId = c.req.param('eventId')
      if (!IDENTIFIER_PATTERN.test(eventId)) {
        return c.json({
          statusCode: 400,
          message: '归因事件 ID 无效',
          code: 'ATTRIBUTION_EVENT_ID_INVALID',
        }, 400)
      }

      try {
        const runtime = c.get('attributionEnvironment')
        const now = trustedNow(options.now)
        const row = await readBrowserDelivery(c.env.DB, eventId)
        if (!row) {
          return c.json({
            statusCode: 404,
            message: '未找到可执行的浏览器归因指令',
            code: 'ATTRIBUTION_BROWSER_INSTRUCTION_NOT_FOUND',
          }, 404)
        }
        const provider = parseProvider(row.provider)
        const canonicalEvent = parseCanonicalEvent(row.event_name)
        const occurredAt = parseCanonicalTimestamp(row.occurred_at)
        const nowSeconds = Math.floor(now.getTime() / 1_000)
        const eventExpiresAt = occurredAt + EVENT_MAX_AGE_SECONDS
        const expiresAt = Math.min(
          nowSeconds + BROWSER_INSTRUCTION_LIFETIME_SECONDS,
          eventExpiresAt,
        )
        if (expiresAt <= nowSeconds) {
          return c.json({
            statusCode: 404,
            message: '未找到可执行的浏览器归因指令',
            code: 'ATTRIBUTION_BROWSER_INSTRUCTION_NOT_FOUND',
          }, 404)
        }
        const receiptToken = await signAttributionToken(
          runtime.signingKeys.current,
          'browser-receipt',
          {
            schemaVersion: 1,
            deliveryId: row.delivery_id,
            eventId,
            issuedAt: nowSeconds,
            expiresAt,
          },
        )
        const instruction = getProviderAdapter(
          provider,
        ).buildBrowserInstruction({
          provider,
          connectionId: row.connection_id,
          versionId: row.version_id,
          deliveryId: row.delivery_id,
          canonicalEvent,
          externalEventId: row.external_event_id,
          destination: row.destination,
          receiptToken,
        })
        const instructionToken = await signAttributionToken(
          runtime.signingKeys.current,
          'browser-instruction',
          {
            schemaVersion: 1,
            eventId,
            issuedAt: nowSeconds,
            expiresAt,
            instruction,
          },
        )
        return c.json({ instructionToken })
      } catch {
        return c.json({
          statusCode: 503,
          message: '浏览器归因指令暂时不可用',
          code: 'ATTRIBUTION_BROWSER_INSTRUCTION_UNAVAILABLE',
        }, 503)
      }
    },
  )

  routes.post('/contact-capabilities', async (c) => {
    const body = await readJson(c.req.raw)
    const contacts = parseContactCapabilityRequest(body)
    if (!contacts) {
      return c.json({
        statusCode: 400,
        message: '联系人 capability 请求格式无效',
        code: 'ATTRIBUTION_CONTACT_CAPABILITY_REQUEST_INVALID',
      }, 400)
    }

    try {
      const runtime = c.get('attributionEnvironment')
      const nowSeconds = Math.floor(
        trustedNow(options.now).getTime() / 1_000,
      )
      const capabilities: ContactCapabilityResponseItem[] = []
      for (const contact of contacts) {
        capabilities.push({
          ...contact,
          attributionCapability: await issueContactCapability({
            signingKeys: runtime.signingKeys,
            nowSeconds: () => nowSeconds,
          }, contact),
        })
      }
      return c.json({ capabilities })
    } catch {
      return c.json({
        statusCode: 503,
        message: '联系人 capability 暂时不可用',
        code: 'ATTRIBUTION_CONTACT_CAPABILITY_UNAVAILABLE',
      }, 503)
    }
  })

  return routes
}

export const internalAttributionRoutes = createInternalAttributionRoutes()
export const internalRoutes = internalAttributionRoutes

function parsePrivacyDecisionRequest(value: unknown): {
  privacyToken: string | null
  country: string | null
  gpc: boolean
} | null {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, ['privacyToken', 'country', 'gpc'])
    || !(
      value.privacyToken === null
      || (
        typeof value.privacyToken === 'string'
        && value.privacyToken.length > 0
        && value.privacyToken.length <= 4_096
        && !/\p{Cc}/u.test(value.privacyToken)
      )
    )
    || !(
      value.country === null
      || (
        typeof value.country === 'string'
        && /^[A-Z]{2}$/.test(value.country)
      )
    )
    || typeof value.gpc !== 'boolean'
  ) return null

  return {
    privacyToken: value.privacyToken,
    country: value.country,
    gpc: value.gpc,
  }
}

async function readBrowserDelivery(
  db: D1Database,
  eventId: string,
): Promise<BrowserDeliveryRow | null> {
  return db.prepare(`
    SELECT
      delivery.id AS delivery_id,
      delivery.connection_id,
      delivery.version_id,
      delivery.provider,
      delivery.destination,
      delivery.external_event_id,
      fact.event_name,
      fact.occurred_at
    FROM attribution_facts AS fact
    INNER JOIN attribution_deliveries AS delivery
      ON delivery.fact_id = fact.id
     AND delivery.transport = 'browser'
     AND delivery.status IN ('planned','accepted')
    WHERE fact.event_id = ?
      AND fact.fact_origin = 'live'
    LIMIT 1
  `).bind(eventId).first<BrowserDeliveryRow>()
}

function parseContactCapabilityRequest(
  value: unknown,
): ContactCapabilityRequestItem[] | null {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, ['contacts'])
    || !Array.isArray(value.contacts)
    || value.contacts.length === 0
    || value.contacts.length > MAX_CONTACT_CAPABILITIES
  ) {
    return null
  }
  const keys = new Set<string>()
  const result: ContactCapabilityRequestItem[] = []
  for (const item of value.contacts) {
    if (
      !isPlainRecord(item)
      || !hasExactKeys(item, [
        'contactMethodId',
        'platform',
        'destinationDigest',
      ])
      || !IDENTIFIER_PATTERN.test(String(item.contactMethodId ?? ''))
      || !isSafeText(item.platform, 80)
      || !DESTINATION_DIGEST_PATTERN.test(
        String(item.destinationDigest ?? ''),
      )
    ) {
      return null
    }
    const contact = {
      contactMethodId: item.contactMethodId as string,
      platform: item.platform,
      destinationDigest: item.destinationDigest as string,
    }
    const key = [
      contact.contactMethodId,
      contact.platform,
      contact.destinationDigest,
    ].join('\u001f')
    if (keys.has(key)) return null
    keys.add(key)
    result.push(contact)
  }
  return result
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type') ?? ''
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) return null
  try {
    return await request.json()
  } catch {
    return null
  }
}

function parseProvider(value: string): AttributionProvider {
  if (!PROVIDERS.has(value as AttributionProvider)) throw new Error()
  return value as AttributionProvider
}

function parseCanonicalEvent(value: string): CanonicalConversionEvent {
  if (value !== 'Contact' && value !== 'CompleteRegistration') {
    throw new Error()
  }
  return value
}

function parseCanonicalTimestamp(value: string): number {
  const date = new Date(value)
  if (
    !Number.isFinite(date.getTime())
    || date.toISOString() !== value
  ) {
    throw new Error()
  }
  return Math.floor(date.getTime() / 1_000)
}

function trustedNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw new Error()
  return value
}

function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every(key => key in value)
}
