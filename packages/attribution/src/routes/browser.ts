import {
  ATTRIBUTION_CONTEXT_COOKIE_NAME,
  ATTRIBUTION_PRIVACY_COOKIE_NAME,
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
  type AttributionProvider,
} from '@meigallery/shared'
import {
  digestAttributionContactDestination,
} from '@meigallery/shared/utils'
import { Hono } from 'hono'
import { getProviderAdapter } from '../adapters/registry'
import {
  resolveAttributionRoute,
  type AttributionRouteCandidate,
} from '../domain/routing'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import { sha256Hex } from '../security/digest'
import {
  signAttributionToken,
  verifyAttributionToken,
} from '../security/signed-token'
import {
  issueAttributionContextResponse,
  resolveAttributionContext,
  type AttributionContextIdentifiers,
} from '../services/context-service'
import {
  recordBrowserReceipt,
} from '../services/browser-receipt'
import {
  verifyContactCapability,
} from '../services/contact-capability'
import {
  recordCanonicalFact,
} from '../services/fact-service'
import {
  createManagedSourceRoutingRepository,
} from '../services/managed-source-service'
import {
  issuePrivacyChoiceToken,
  PRIVACY_CHOICE_MAX_AGE_SECONDS,
  readPrivacyChoiceToken,
} from '../services/privacy-choice'
import {
  readPrivacyPolicy,
  resolvePrivacyDecision,
  type AttributionPrivacyPolicy,
  type AttributionPrivacyChoice,
  type AttributionPrivacyDecision,
} from '../services/privacy-policy'
import {
  issueRuntimeLease,
  RUNTIME_LEASE_SECONDS,
} from '../services/runtime-lease'

export interface BrowserAttributionVariables {
  attributionEnvironment: AttributionEnvironment
}

export interface BrowserAttributionRouteOptions {
  now?: () => Date
  country?: (request: Request) => string | null
  gpc?: (request: Request) => boolean
  idFactory?: (prefix: string) => string
}

interface RuntimeConfigRow {
  provider: string
  connection_id: string
  version_id: string
  public_config_json: string
}

interface ManagedSourceRow {
  id: string
}

const BROWSER_INSTRUCTION_LIFETIME_SECONDS = 30 * 60
const EVENT_MAX_AGE_SECONDS = 24 * 60 * 60
const IDENTIFIER_KEYS = [
  'fbclid',
  'ttclid',
  'gclid',
  'gbraid',
  'wbraid',
] as const
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/
const DESTINATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/

export function createBrowserAttributionRoutes(
  options: BrowserAttributionRouteOptions = {},
) {
  const routes = new Hono<{
    Bindings: AttributionBindings
    Variables: BrowserAttributionVariables
  }>()

  routes.use('/v1/*', async (c, next) => {
    const origin = c.req.header('Origin')
    const runtime = c.get('attributionEnvironment')
    if (!isAllowedOrigin(origin, runtime.publicOrigins)) {
      return browserError(c, 403, 'ATTRIBUTION_ORIGIN_FORBIDDEN')
    }
    if (c.req.method === 'OPTIONS') return corsResponse(origin)
    await next()
    applyCors(c.res.headers, origin)
  })

  routes.options('/v1/*', c => corsResponse(c.req.header('Origin')!))

  routes.put('/v1/context', async (c) => {
    const body = await readJson(c.req.raw)
    const input = parseContextRequest(body)
    if (!input) {
      return browserError(c, 400, 'ATTRIBUTION_CONTEXT_REQUEST_INVALID')
    }

    const runtime = c.get('attributionEnvironment')
    const privacy = await resolveRequestPrivacySnapshot(
      c.req.raw,
      c.env.DB,
      runtime,
      options,
    )
    if (privacy.decision.state !== 'granted') {
      return c.json({ data: { issued: false } })
    }

    try {
      const existingContextToken = cookieValue(
        c.req.header('Cookie'),
        ATTRIBUTION_CONTEXT_COOKIE_NAME,
      )
      let existingSourceId: string | null = null
      const repository = createManagedSourceRoutingRepository({
        db: c.env.DB,
        now: () => trustedNow(options.now),
        idFactory: options.idFactory,
        resolveFirstPartyContext: async token => {
          try {
            const context = await resolveAttributionContext({
              db: c.env.DB,
              signingKeys: runtime.signingKeys,
              encryptionKeys: runtime.dataEncryptionKeys,
              nowSeconds: () => nowSeconds(options.now),
            }, token)
            existingSourceId = context.sourceId
            return context
          } catch {
            return null
          }
        },
      })
      const route = await resolveAttributionRoute(repository, {
        ...(input.proof === undefined ? {} : { proof: input.proof }),
        ...(existingContextToken === null
          ? {}
          : { contextToken: existingContextToken }),
        identifiers: input.identifiers,
      })
      if (route.resolution !== 'resolved') {
        return c.json({ data: { issued: false } })
      }
      const sourceId = input.proof === undefined
        ? existingSourceId
        : await readManagedSourceId(c.env.DB, input.proof, route)
      if (input.proof !== undefined && sourceId === null) {
        return c.json({ data: { issued: false } })
      }
      const response = await issueAttributionContextResponse({
        db: c.env.DB,
        signingKeys: runtime.signingKeys,
        encryptionKeys: runtime.dataEncryptionKeys,
        cookieDomain: runtime.cookieDomain ?? undefined,
        nowSeconds: () => nowSeconds(options.now),
        idFactory: options.idFactory,
      }, {
        privacyDecision: privacy.decision,
        route: {
          provider: route.provider!,
          connectionId: route.connectionId!,
        },
        sourceId,
        identifiers: input.identifiers,
        idempotencyKey: input.idempotencyKey,
      })
      return response
    } catch {
      return browserError(c, 400, 'ATTRIBUTION_CONTEXT_UNAVAILABLE')
    }
  })

  routes.get('/v1/privacy-decision', async (c) => {
    const runtime = c.get('attributionEnvironment')
    const snapshot = await resolveRequestPrivacySnapshot(
      c.req.raw,
      c.env.DB,
      runtime,
      options,
    )
    return c.json({ data: publicPrivacyDecision(snapshot) })
  })

  routes.put('/v1/privacy-decision', async (c) => {
    const body = await readJson(c.req.raw)
    const input = parsePrivacyDecisionRequest(body)
    if (!input) {
      return browserError(c, 400, 'ATTRIBUTION_PRIVACY_DECISION_INVALID')
    }
    const runtime = c.get('attributionEnvironment')
    try {
      const token = await issuePrivacyChoiceToken({
        signingKeys: runtime.signingKeys,
        nowSeconds: () => nowSeconds(options.now),
      }, input.choice)
      const policy = await readPrivacyPolicy(c.env.DB)
      const decision = resolvePrivacyDecision(policy, {
        country: requestCountry(c.req.raw, options),
        choice: input.choice,
        gpc: requestGpc(c.req.raw, options),
      })
      const response = c.json({
        data: publicPrivacyDecision({ policy, decision }),
      })
      response.headers.set('Set-Cookie', privacyCookie(
        token,
        runtime.cookieDomain,
      ))
      return response
    } catch {
      return browserError(c, 503, 'ATTRIBUTION_PRIVACY_DECISION_UNAVAILABLE')
    }
  })

  routes.get('/v1/runtime-config', async (c) => {
    const runtime = c.get('attributionEnvironment')
    const privacy = await resolveRequestPrivacySnapshot(
      c.req.raw,
      c.env.DB,
      runtime,
      options,
    )
    if (privacy.decision.state !== 'granted') {
      return c.json({ data: null })
    }

    const token = cookieValue(
      c.req.header('Cookie'),
      ATTRIBUTION_CONTEXT_COOKIE_NAME,
    )
    if (token === null) return c.json({ data: null })
    try {
      const context = await resolveAttributionContext({
        db: c.env.DB,
        signingKeys: runtime.signingKeys,
        encryptionKeys: runtime.dataEncryptionKeys,
        nowSeconds: () => nowSeconds(options.now),
      }, token)
      const runtimeLeaseToken = await issueRuntimeLease({
        db: c.env.DB,
        signingKeys: runtime.signingKeys,
        now: () => trustedNow(options.now),
      }, {
        connectionId: context.connectionId,
        provider: context.provider,
        privacyState: privacy.decision.state,
      })
      const snapshot = await readBrowserRuntimeConfig(
        c.env.DB,
        context,
      )
      if (!snapshot) return c.json({ data: null })
      return c.json({
        data: {
          provider: snapshot.provider,
          connectionId: snapshot.connectionId,
          versionId: snapshot.versionId,
          publicConfig: {
            provider: snapshot.provider,
            ...snapshot.publicConfig,
          },
          runtimeLeaseToken,
          expiresAt: nowSeconds(options.now) + RUNTIME_LEASE_SECONDS,
        },
      })
    } catch {
      return c.json({ data: null })
    }
  })

  routes.post('/v1/events/contact', async (c) => {
    const body = await readJson(c.req.raw)
    const input = parseContactRequest(body)
    if (!input) {
      return browserError(c, 400, 'ATTRIBUTION_CONTACT_REQUEST_INVALID')
    }
    if (
      !validDestination(input.destination.value)
      || (
        input.destination.linkUrl !== null
        && !validDestination(input.destination.linkUrl)
      )
      || (
        input.event.payload.contactAction === 'open_link'
        && (
          input.destination.linkUrl === null
          || !isSafeOpenLink(input.destination.linkUrl)
        )
      )
    ) {
      return browserError(c, 400, 'ATTRIBUTION_CONTACT_DESTINATION_INVALID')
    }

    const runtime = c.get('attributionEnvironment')
    const capability = await verifyContactCapability({
      signingKeys: runtime.signingKeys,
      nowSeconds: () => nowSeconds(options.now),
    }, input.attributionCapability)
    if (
      !capability
      || capability.contactMethodId !== input.event.payload.contactMethodId
      || capability.platform !== input.event.payload.contactPlatform
      || capability.destinationDigest !== input.destinationDigest
      || await digestAttributionContactDestination(input.destination)
        !== input.destinationDigest
    ) {
      return browserError(c, 400, 'ATTRIBUTION_CONTACT_CAPABILITY_INVALID')
    }

    const privacy = await resolveRequestPrivacySnapshot(
      c.req.raw,
      c.env.DB,
      runtime,
      options,
    )
    const event: AttributionBusinessEventV1 = {
      ...input.event,
      sourceContextToken: privacy.decision.state === 'granted'
        ? cookieValue(
            c.req.header('Cookie'),
            ATTRIBUTION_CONTEXT_COOKIE_NAME,
          )
        : null,
      consent: {
        marketingAllowed: privacy.decision.state === 'granted',
        adUserDataAllowed: privacy.decision.state === 'granted',
        adPersonalizationAllowed: privacy.decision.state === 'granted',
      },
    }
    try {
      const result = await recordCanonicalFact({
        db: c.env.DB,
        signingKeys: runtime.signingKeys,
        encryptionKeys: runtime.dataEncryptionKeys,
        now: () => trustedNow(options.now),
        idFactory: options.idFactory,
      }, event, {
        runtimeLeaseToken: privacy.decision.state === 'granted'
          ? input.runtimeLeaseToken
          : null,
      })
      const browserDelivery = result.deliveries.filter(
        item => item.transport === 'browser',
      )
      if (browserDelivery.length > 1) throw new Error()
      const instruction = browserDelivery[0]
        ? await browserInstruction(
          runtime,
          input.event.eventId,
          input.event.occurredAt,
          browserDelivery[0],
          options,
        )
        : null
      return c.json({ accepted: true, eventId: input.event.eventId, instruction }, 202)
    } catch {
      return browserError(c, 400, 'ATTRIBUTION_CONTACT_UNAVAILABLE')
    }
  })

  routes.post('/v1/browser-receipts', async (c) => {
    const body = await readJson(c.req.raw)
    const input = parseBrowserReceiptRequest(body)
    if (!input) {
      return browserError(c, 400, 'ATTRIBUTION_BROWSER_RECEIPT_INVALID')
    }
    const runtime = c.get('attributionEnvironment')
    try {
      const payload = await verifyAttributionToken(
        runtime.signingKeys,
        'browser-receipt',
        input.receiptToken,
      )
      if (!validReceiptPayload(payload, input.attemptedAt, nowSeconds(options.now))) {
        return browserError(c, 400, 'ATTRIBUTION_BROWSER_RECEIPT_INVALID')
      }
      await recordBrowserReceipt({
        db: c.env.DB,
        now: () => trustedNow(options.now),
      }, {
        deliveryId: payload.deliveryId,
        attemptedAt: input.attemptedAt,
      })
      return c.json({ accepted: true }, 202)
    } catch {
      return browserError(c, 400, 'ATTRIBUTION_BROWSER_RECEIPT_INVALID')
    }
  })

  return routes
}

export const browserAttributionRoutes = createBrowserAttributionRoutes()
export const browserRoutes = browserAttributionRoutes

function parseContextRequest(value: unknown): {
  idempotencyKey: string
  proof?: string
  identifiers: AttributionContextIdentifiers
} | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'idempotencyKey',
    'identifiers',
  ], ['proof'])) return null
  if (!validIdentifier(value.idempotencyKey)) return null
  if (value.proof !== undefined && !validProof(value.proof)) return null
  const identifiers = parseIdentifiers(value.identifiers)
  if (
    !identifiers
    || (
      value.proof === undefined
      && Object.keys(identifiers).length === 0
    )
  ) return null
  return {
    idempotencyKey: value.idempotencyKey,
    ...(value.proof === undefined ? {} : { proof: value.proof }),
    identifiers,
  }
}

function parsePrivacyDecisionRequest(value: unknown): {
  choice: Exclude<AttributionPrivacyChoice, null>
  idempotencyKey: string
} | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'choice',
    'idempotencyKey',
  ])) return null
  if (
    (value.choice !== 'granted' && value.choice !== 'denied')
    || !validIdentifier(value.idempotencyKey)
  ) return null
  return { choice: value.choice, idempotencyKey: value.idempotencyKey }
}

function parseContactRequest(value: unknown): {
  event: AttributionBusinessEventV1 & {
    eventName: 'Contact'
    payload: {
      contactMethodId: string
      contactPlatform: string
      contactAction: 'open_link' | 'copy'
    }
  }
  attributionCapability: string
  destination: {
    value: string
    linkUrl: string | null
  }
  destinationDigest: string
  runtimeLeaseToken: string | null
} | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'event',
    'attributionCapability',
    'destination',
    'destinationDigest',
    'runtimeLeaseToken',
  ])) return null
  if (
    !isAttributionBusinessEventV1(value.event)
    || value.event.eventName !== 'Contact'
    || value.event.sourceContextToken !== null
    || typeof value.attributionCapability !== 'string'
    || value.attributionCapability.length === 0
    || value.attributionCapability.length > 4_096
    || !isPlainRecord(value.destination)
    || !hasExactKeys(value.destination, ['value', 'linkUrl'])
    || typeof value.destination.value !== 'string'
    || (
      value.destination.linkUrl !== null
      && typeof value.destination.linkUrl !== 'string'
    )
    || !DESTINATION_DIGEST_PATTERN.test(String(value.destinationDigest ?? ''))
    || (
      value.runtimeLeaseToken !== null
      && (
        typeof value.runtimeLeaseToken !== 'string'
        || value.runtimeLeaseToken.length === 0
        || value.runtimeLeaseToken.length > 4_096
      )
    )
  ) return null
  const event = value.event as AttributionBusinessEventV1 & {
    eventName: 'Contact'
    payload: {
      contactMethodId: string
      contactPlatform: string
      contactAction: 'open_link' | 'copy'
    }
  }
  return {
    event,
    attributionCapability: value.attributionCapability,
    destination: {
      value: value.destination.value,
      linkUrl: value.destination.linkUrl,
    },
    destinationDigest: value.destinationDigest as string,
    runtimeLeaseToken: value.runtimeLeaseToken,
  }
}

function parseBrowserReceiptRequest(value: unknown): {
  receiptToken: string
  attemptedAt: string
} | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'receiptToken',
    'attemptedAt',
  ])) return null
  if (
    typeof value.receiptToken !== 'string'
    || value.receiptToken.length === 0
    || value.receiptToken.length > 4_096
    || !isCanonicalTimestamp(value.attemptedAt)
  ) return null
  return { receiptToken: value.receiptToken, attemptedAt: value.attemptedAt }
}

function parseIdentifiers(value: unknown): AttributionContextIdentifiers | null {
  if (!isPlainRecord(value)) return null
  if (!Object.keys(value).every(key => IDENTIFIER_KEYS.includes(
    key as typeof IDENTIFIER_KEYS[number],
  ))) return null
  const identifiers: AttributionContextIdentifiers = {}
  for (const key of IDENTIFIER_KEYS) {
    const identifier = value[key]
    if (identifier === undefined) continue
    if (
      typeof identifier !== 'string'
      || identifier.length === 0
      || identifier.length > 1_024
      || /\p{Cc}/u.test(identifier)
    ) return null
    identifiers[key] = identifier
  }
  return identifiers
}

async function resolveRequestPrivacySnapshot(
  request: Request,
  db: D1Database,
  runtime: AttributionEnvironment,
  options: BrowserAttributionRouteOptions,
): Promise<{
  policy: AttributionPrivacyPolicy
  decision: AttributionPrivacyDecision
}> {
  const policy = await readPrivacyPolicy(db)
  return {
    policy,
    decision: resolvePrivacyDecision(policy, {
      country: requestCountry(request, options),
      choice: await readPrivacyChoiceToken({
        signingKeys: runtime.signingKeys,
        nowSeconds: () => nowSeconds(options.now),
      },
        cookieValue(
          request.headers.get('Cookie'),
          ATTRIBUTION_PRIVACY_COOKIE_NAME,
        ),
      ),
      gpc: requestGpc(request, options),
    }),
  }
}

function publicPrivacyDecision(snapshot: {
  policy: AttributionPrivacyPolicy
  decision: AttributionPrivacyDecision
}) {
  return {
    ...snapshot.decision,
    policyMode: snapshot.policy.defaultMode,
    policyVersion: snapshot.policy.policyVersion,
    requiresChoice: snapshot.decision.state === 'choice_required',
  }
}

async function readManagedSourceId(
  db: D1Database,
  proof: string,
  route: {
    provider: AttributionProvider | null
    connectionId: string | null
  },
): Promise<string | null> {
  if (!route.provider || !route.connectionId) return null
  const proofHash = await sha256Hex(`managed-source:v1:${proof}`)
  const row = await db.prepare(`
    SELECT id
    FROM attribution_managed_sources
    WHERE proof_hash = ?
      AND provider = ?
      AND connection_id = ?
      AND enabled = 1
    LIMIT 1
  `).bind(proofHash, route.provider, route.connectionId)
    .first<ManagedSourceRow>()
  return row?.id !== undefined && validIdentifier(row.id) ? row.id : null
}

async function readBrowserRuntimeConfig(
  db: D1Database,
  context: AttributionRouteCandidate,
): Promise<{
  provider: AttributionProvider
  connectionId: string
  versionId: string
  publicConfig: Record<string, string>
} | null> {
  const row = await db.prepare(`
    SELECT
      connection.provider,
      connection.id AS connection_id,
      version.id AS version_id,
      version.public_config_json
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = connection.active_version_id
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
     AND version.status = 'active'
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
     AND policy.browser_enabled = 1
    WHERE connection.id = ?
      AND connection.provider = ?
    LIMIT 1
  `).bind(context.connectionId, context.provider).first<RuntimeConfigRow>()
  if (
    !row
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || !validIdentifier(row.connection_id)
    || !validIdentifier(row.version_id)
  ) return null
  let publicConfig: unknown
  try {
    publicConfig = JSON.parse(row.public_config_json)
  } catch {
    return null
  }
  if (!isPublicConfig(publicConfig)) return null
  return {
    provider: row.provider as AttributionProvider,
    connectionId: row.connection_id,
    versionId: row.version_id,
    publicConfig,
  }
}

async function browserInstruction(
  runtime: AttributionEnvironment,
  eventId: string,
  occurredAt: string,
  delivery: {
    id: string
    provider: AttributionProvider
    connectionId: string
    versionId: string
    destination: string
    externalEventId: string
  },
  options: BrowserAttributionRouteOptions,
) {
  const now = nowSeconds(options.now)
  const eventSeconds = Math.floor(new Date(occurredAt).getTime() / 1_000)
  const expiresAt = Math.min(
    now + BROWSER_INSTRUCTION_LIFETIME_SECONDS,
    eventSeconds + EVENT_MAX_AGE_SECONDS,
  )
  if (expiresAt <= now) throw new Error()
  const receiptToken = await signAttributionToken(
    runtime.signingKeys.current,
    'browser-receipt',
    {
      schemaVersion: 1,
      deliveryId: delivery.id,
      eventId,
      issuedAt: now,
      expiresAt,
    },
  )
  return getProviderAdapter(delivery.provider).buildBrowserInstruction({
    provider: delivery.provider,
    connectionId: delivery.connectionId,
    versionId: delivery.versionId,
    deliveryId: delivery.id,
    canonicalEvent: 'Contact',
    externalEventId: delivery.externalEventId,
    destination: delivery.destination,
    receiptToken,
  })
}

function validReceiptPayload(
  value: Record<string, unknown> | null,
  attemptedAt: string,
  now: number,
): value is {
  schemaVersion: 1
  deliveryId: string
  eventId: string
  issuedAt: number
  expiresAt: number
} {
  const raw = value as {
    schemaVersion?: unknown
    deliveryId?: unknown
    eventId?: unknown
    issuedAt?: unknown
    expiresAt?: unknown
  } | null
  if (
    !raw
    || !hasExactKeys(raw as Record<string, unknown>, [
      'schemaVersion',
      'deliveryId',
      'eventId',
      'issuedAt',
      'expiresAt',
    ])
    || raw.schemaVersion !== 1
    || !validIdentifier(raw.deliveryId)
    || !validIdentifier(raw.eventId)
    || !Number.isSafeInteger(raw.issuedAt)
    || !Number.isSafeInteger(raw.expiresAt)
    || Number(raw.issuedAt) > now
    || Number(raw.expiresAt) < now
    || Number(raw.expiresAt) <= Number(raw.issuedAt)
  ) return false
  const payload = value as {
    schemaVersion: 1
    deliveryId: string
    eventId: string
    issuedAt: number
    expiresAt: number
  }
  const attemptedAtSeconds = Math.floor(
    new Date(attemptedAt).getTime() / 1_000,
  )
  return attemptedAtSeconds >= payload.issuedAt
    && attemptedAtSeconds <= payload.expiresAt
}

function requestCountry(
  request: Request,
  options: BrowserAttributionRouteOptions,
): string | null {
  return options.country?.(request)
    ?? request.headers.get('CF-IPCountry')
}

function requestGpc(
  request: Request,
  options: BrowserAttributionRouteOptions,
): boolean {
  return options.gpc?.(request) ?? request.headers.get('Sec-GPC') === '1'
}

function privacyCookie(token: string, domain: string | null): string {
  const attributes = [
    `${ATTRIBUTION_PRIVACY_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${PRIVACY_CHOICE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ]
  if (domain) attributes.push(`Domain=${domain}`)
  return attributes.join('; ')
}

function cookieValue(
  header: string | null | undefined,
  name: string,
): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name && value.length > 0) return value.join('=')
  }
  return null
}

function isAllowedOrigin(
  origin: string | undefined,
  publicOrigins: readonly string[],
): origin is string {
  return typeof origin === 'string' && publicOrigins.includes(origin)
}

function corsResponse(origin: string): Response {
  const headers = new Headers()
  applyCors(headers, origin)
  return new Response(null, { status: 204, headers })
}

function applyCors(headers: Headers, origin: string): void {
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type')
  headers.set('Vary', 'Origin')
}

function browserError(
  c: { json: (value: unknown, status: number) => Response },
  status: number,
  code: string,
): Response {
  return c.json({
    statusCode: status,
    message: '浏览器归因请求无效',
    code,
  }, status)
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value)
    && Object.keys(value).every(key => allowed.has(key))
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

function validProof(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function validDestination(value: string): boolean {
  return value.length > 0
    && value.length <= 2_048
    && !/\p{Cc}/u.test(value)
}

function isSafeOpenLink(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function isPublicConfig(value: unknown): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.keys(value).length > 0
    && Object.keys(value).length <= 16
    && Object.entries(value).every(([key, item]) => (
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)
      && typeof item === 'string'
      && item.length > 0
      && item.length <= 1_024
      && !/\p{Cc}/u.test(item)
    ))
}

function trustedNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw new Error()
  return value
}

function nowSeconds(now: (() => Date) | undefined): number {
  return Math.floor(trustedNow(now).getTime() / 1_000)
}
