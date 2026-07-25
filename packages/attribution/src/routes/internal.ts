import {
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
  type AttributionProvider,
  type CanonicalConversionEvent,
} from '@meigallery/shared'
import { Hono, type Context } from 'hono'
import { getProviderAdapter } from '../adapters/registry'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import {
  signAttributionToken,
} from '../security/signed-token'
import {
  issueAttributionContextToken,
  type AttributionContextIdentifiers,
} from '../services/context-service'
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
  assertAttributionRuntimeBridgeReadable,
  assertAttributionRuntimeWriteOwnership,
  readAttributionRuntimeWriteOwnership,
  type AttributionRuntimeWriteOwnership,
} from '../services/runtime-activation'
import {
  readAttributionRuntimeReadiness,
} from '../services/runtime-state'
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

interface DefaultConnectionRow {
  connection_id: string
  provider: string
}

interface ContactBridgeRequest {
  event: AttributionBusinessEventV1
  requestMetadata: {
    clientIp?: string
    userAgent?: string
  }
}

interface LegacyContextRequest {
  provider: AttributionProvider
  identifiers: AttributionContextIdentifiers
  idempotencyKey: string
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
const PROVIDER_IDENTIFIER_KEYS: Readonly<
  Record<AttributionProvider, readonly string[]>
> = {
  meta: ['fbclid'],
  tiktok: ['ttclid'],
  google: ['gclid', 'gbraid', 'wbraid'],
}

type InternalRouteEnvironment = {
  Bindings: AttributionBindings
  Variables: InternalAttributionVariables
}

export function createInternalAttributionRoutes(
  options: InternalAttributionRouteOptions = {},
) {
  const routes = new Hono<InternalRouteEnvironment>()

  routes.get('/runtime-state', async (c) => {
    try {
      return c.json(await readAttributionRuntimeReadiness(c.env.DB))
    } catch {
      return c.json({
        statusCode: 503,
        message: '归因运行状态暂时不可用',
        code: 'ATTRIBUTION_RUNTIME_STATE_UNAVAILABLE',
      }, 503)
    }
  })

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
    let ownership
    try {
      ownership = readAttributionRuntimeWriteOwnership(c.req.raw)
      await assertAttributionRuntimeWriteOwnership(c.env.DB, ownership)
    } catch {
      return runtimeOwnershipUnavailable(c)
    }

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
      }, body, {
        runtimeWriteOwnership: ownership,
      })
      await enqueuePlannedServerDeliveries(
        c.env.DB,
        runtime,
        now,
        result.deliveries,
      )
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

  routes.post('/contact-events', async (c) => {
    let ownership: AttributionRuntimeWriteOwnership
    try {
      ownership = readAttributionRuntimeWriteOwnership(c.req.raw)
      await assertAttributionRuntimeWriteOwnership(c.env.DB, ownership)
    } catch {
      return runtimeOwnershipUnavailable(c)
    }

    const body = parseContactBridgeRequest(await readJson(c.req.raw))
    if (!body) {
      return c.json({
        statusCode: 400,
        message: '联系归因事件格式无效',
        code: 'ATTRIBUTION_CONTACT_EVENT_INVALID',
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
      }, body.event, {
        allowImplicitContactLease: true,
        runtimeWriteOwnership: ownership,
        requestMetadata: body.requestMetadata,
      })
      await enqueuePlannedServerDeliveries(
        c.env.DB,
        runtime,
        now,
        result.deliveries,
      )
      return c.json({
        accepted: true as const,
        eventId: body.event.eventId,
      }, 202)
    } catch {
      return c.json({
        statusCode: 503,
        message: '联系归因事件暂时无法接收',
        code: 'ATTRIBUTION_CONTACT_EVENT_UNAVAILABLE',
      }, 503)
    }
  })

  routes.post('/legacy-context', async (c) => {
    try {
      await assertAttributionRuntimeBridgeReadable(c.env.DB)
    } catch {
      return c.json({
        statusCode: 503,
        message: '归因上下文桥接尚未就绪',
        code: 'ATTRIBUTION_CONTEXT_BRIDGE_NOT_READY',
      }, 503)
    }

    const input = parseLegacyContextRequest(await readJson(c.req.raw))
    if (!input) {
      return c.json({
        statusCode: 400,
        message: '归因上下文桥接请求格式无效',
        code: 'ATTRIBUTION_LEGACY_CONTEXT_INVALID',
      }, 400)
    }

    try {
      const runtime = c.get('attributionEnvironment')
      const route = await readDefaultConnectionRoute(
        c.env.DB,
        input.provider,
      )
      const issued = await issueAttributionContextToken({
        db: c.env.DB,
        signingKeys: runtime.signingKeys,
        encryptionKeys: runtime.dataEncryptionKeys,
        nowSeconds: () => Math.floor(
          trustedNow(options.now).getTime() / 1_000,
        ),
      }, {
        privacyDecision: {
          state: 'granted',
          reason: 'regional_default',
        },
        route,
        sourceId: null,
        identifiers: input.identifiers,
        idempotencyKey: input.idempotencyKey,
      })
      return c.json({ sourceContextToken: issued.token })
    } catch {
      return c.json({
        statusCode: 503,
        message: '归因上下文暂时无法桥接',
        code: 'ATTRIBUTION_LEGACY_CONTEXT_UNAVAILABLE',
      }, 503)
    }
  })

  routes.get(
    '/events/:eventId/browser-instruction',
    async (c) => {
      try {
        const ownership = readAttributionRuntimeWriteOwnership(c.req.raw)
        await assertAttributionRuntimeWriteOwnership(c.env.DB, ownership)
      } catch {
        return runtimeOwnershipUnavailable(c)
      }

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

async function enqueuePlannedServerDeliveries(
  db: D1Database,
  runtime: AttributionEnvironment,
  now: Date,
  deliveries: Awaited<
    ReturnType<typeof recordCanonicalFact>
  >['deliveries'],
): Promise<void> {
  for (const delivery of deliveries) {
    if (
      delivery.transport !== 'server'
      || delivery.status !== 'planned'
    ) {
      continue
    }
    await enqueueServerDelivery({
      db,
      queues: runtime.queues,
      now: () => now,
    }, {
      provider: delivery.provider,
      deliveryId: delivery.id,
    })
  }
}

function runtimeOwnershipUnavailable(
  c: Context<InternalRouteEnvironment>,
) {
  return c.json({
    statusCode: 503,
    message: '归因运行所有权无效',
    code: 'ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED',
  }, 503)
}

function parseContactBridgeRequest(
  value: unknown,
): ContactBridgeRequest | null {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, ['event', 'requestMetadata'])
    || !isAttributionBusinessEventV1(value.event)
    || value.event.eventName !== 'Contact'
    || !isPlainRecord(value.requestMetadata)
  ) {
    return null
  }
  const metadata = value.requestMetadata
  if (
    !Object.keys(metadata).every(
      key => key === 'clientIp' || key === 'userAgent',
    )
    || !Object.values(metadata).every(
      item => isSafeText(item, 1_024),
    )
  ) {
    return null
  }
  return {
    event: value.event,
    requestMetadata: {
      ...(typeof metadata.clientIp === 'string'
        ? { clientIp: metadata.clientIp }
        : {}),
      ...(typeof metadata.userAgent === 'string'
        ? { userAgent: metadata.userAgent }
        : {}),
    },
  }
}

function parseLegacyContextRequest(
  value: unknown,
): LegacyContextRequest | null {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, [
      'provider',
      'identifiers',
      'idempotencyKey',
    ])
    || !PROVIDERS.has(value.provider as AttributionProvider)
    || !IDENTIFIER_PATTERN.test(String(value.idempotencyKey ?? ''))
    || !isPlainRecord(value.identifiers)
  ) {
    return null
  }
  const provider = value.provider as AttributionProvider
  const allowedKeys = PROVIDER_IDENTIFIER_KEYS[provider]
  if (
    Object.keys(value.identifiers).length > allowedKeys.length
    || !Object.entries(value.identifiers).every(([key, identifier]) =>
      allowedKeys.includes(key)
      && isSafeText(identifier, 1_024))
  ) {
    return null
  }
  return {
    provider,
    identifiers: { ...value.identifiers },
    idempotencyKey: value.idempotencyKey as string,
  }
}

async function readDefaultConnectionRoute(
  db: D1Database,
  provider: AttributionProvider,
): Promise<{
  provider: AttributionProvider
  connectionId: string
}> {
  const row = await db.prepare(`
    SELECT
      connection.id AS connection_id,
      connection.provider
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = connection.active_version_id
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
     AND version.status = 'active'
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
     AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
    WHERE connection.provider = ?
      AND connection.is_default = 1
    LIMIT 1
  `).bind(provider).first<DefaultConnectionRow>()
  if (
    !row
    || row.provider !== provider
    || !IDENTIFIER_PATTERN.test(row.connection_id)
  ) {
    throw new Error('ATTRIBUTION_DEFAULT_CONNECTION_NOT_FOUND')
  }
  return {
    provider,
    connectionId: row.connection_id,
  }
}

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
