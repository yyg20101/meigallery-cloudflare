import type { AdAttributionProvider, AdBrowserInstruction, AdPlatformSensitiveContext, AnalyticsSourceChannel, CanonicalConversionEvent } from '@meigallery/shared'
import { normalizeAnalyticsCampaignToken } from '@meigallery/shared/utils'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import { buildConversionDedupeKey, sanitizeConversionMetadata } from '../utils/conversions'
import { encryptAttributionValue, loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import type { AdAttributionContext } from '../utils/ad-attribution-context'
import { normalizeAdPlatformUserData } from '../utils/ad-platform-identifiers'
import { readAttributionConnectionSnapshot } from './ad-platform/connections'
import { buildAttributionDeliveryPlan } from './ad-platform/planner'
import { getAdPlatformDefinition } from './ad-platform/registry'
import { enqueueAttributionDelivery, getAttributionQueue } from './ad-platform/secure-outbox'

type ConversionEnv = Pick<Bindings, 'DB' | 'SITE_URL' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS' | 'AD_META_QUEUE' | 'AD_TIKTOK_QUEUE' | 'AD_GOOGLE_QUEUE'>
type ConversionBaseInput = {
  visitorId: string; sessionId: string; userId?: number | null; occurredAt: string; routeName?: string; path?: string
  sourceChannel?: AnalyticsSourceChannel | string; sourceName?: string; trackingSourceSlug?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string; utmContent?: string
  attributionContext?: AdAttributionContext | null; attributionSource?: 'context' | 'none' | 'conflict'; adPlatformUserData?: AdPlatformSensitiveContext; metadata?: Record<string, unknown>
}
export type RecordContactInput = ConversionBaseInput & { contactMethodId: string; contactPlatform: string; actionType: 'open_link' }
export type RecordRegistrationInput = ConversionBaseInput & { userId: number; hashedEmail?: string }
export type RecordRegistrationFactOnlyInput = Pick<RecordRegistrationInput, 'userId' | 'visitorId' | 'sessionId' | 'occurredAt' | 'sourceChannel' | 'sourceName' | 'trackingSourceSlug' | 'utmSource' | 'utmMedium' | 'utmCampaign' | 'utmContent' | 'metadata'>
export interface RecordConversionResult { id: string; actionType: 'contact' | 'complete_registration'; created: boolean; duplicateOf: string; trackingInstructions: AdBrowserInstruction[] }

export async function recordContact(env: ConversionEnv, input: RecordContactInput): Promise<RecordConversionResult> {
  if (input.actionType !== 'open_link' || !identifier(input.contactMethodId) || !input.contactPlatform.trim()) throw new Error('PUBLIC_CONVERSION_ACTION_INVALID')
  return recordLiveFact(env, { ...input, canonicalEvent: 'Contact', actionType: 'contact', methodType: input.contactPlatform, actionTarget: input.contactMethodId })
}
export async function recordRegistration(env: ConversionEnv, input: RecordRegistrationInput): Promise<RecordConversionResult> {
  return recordLiveFact(env, { ...input, canonicalEvent: 'CompleteRegistration', actionType: 'complete_registration', methodType: 'email', actionTarget: `user_${input.userId}` })
}

/** 历史补偿只创建不可变站内事实，不触发广告平台投递。 */
export async function recordRegistrationFactOnly(db: D1Database, input: RecordRegistrationFactOnlyInput): Promise<RecordConversionResult> {
  const occurredAt = iso(input.occurredAt)
  const dedupeKey = buildConversionDedupeKey({ actionType: 'complete_registration', userId: input.userId, visitorId: input.visitorId, sessionId: input.sessionId, occurredDate: occurredAt.slice(0, 10) })
  const existing = await findFact(db, dedupeKey)
  if (existing) return duplicate(existing.id, 'complete_registration', [])
  const id = generateId('fact')
  try {
    await db.batch([factStatement(db, { id, canonicalEvent: 'CompleteRegistration', factOrigin: 'historical_backfill', externalEventId: null, provider: null, source: 'none', contextId: null, occurredAt, dedupeKey, dimensions: dimensions(input, {}) })])
  } catch (error) {
    const concurrent = await findFact(db, dedupeKey)
    if (concurrent) return duplicate(concurrent.id, 'complete_registration', [])
    throw error
  }
  return { id, actionType: 'complete_registration', created: true, duplicateOf: '', trackingInstructions: [] }
}

async function recordLiveFact(env: ConversionEnv, input: ConversionBaseInput & { actionType: 'contact' | 'complete_registration'; canonicalEvent: CanonicalConversionEvent; methodType: string; actionTarget: string; hashedEmail?: string }) {
  const occurredAt = iso(input.occurredAt)
  const eventTime = unixSeconds(occurredAt)
  const dedupeKey = buildConversionDedupeKey({ actionType: input.actionType, userId: input.userId ?? undefined, visitorId: input.visitorId, sessionId: input.sessionId, occurredDate: occurredAt.slice(0, 10), methodType: input.methodType, actionTarget: input.actionTarget })
  const keys = await loadAttributionCryptoKeys(env)
  const existing = await findFact(env.DB, dedupeKey)
  if (existing) return duplicate(existing.id, input.actionType, await existingBrowserInstructions(env.DB, existing))
  const id = generateId('fact')
  const context = trustedContext(input.attributionContext, input.attributionSource)
  const snapshot = context.provider ? await readAttributionConnectionSnapshot(env.DB, context.provider) : { state: 'connection_invalid' as const, reason: 'not_found' as const }
  const definition = getAdPlatformDefinition(context.provider)
  const pageUrl = absolutePageUrl(env.SITE_URL, input.path)
  const adPlatformUserData = normalizeAdPlatformUserData(input.adPlatformUserData)
  const matchSignals = definition && context.context ? definition.matchSignals({ contextIdentifiers: context.context.identifiers, contextIssuedAt: context.context.issuedAt, browserIdentifiers: adPlatformUserData }) : {}
  const plan = await buildAttributionDeliveryPlan({
    factId: id, provider: context.provider, canonicalEvent: input.canonicalEvent,
    sourceAvailable: context.sourceAvailable, cryptoKeys: keys, matchSignals,
    serverAllowed: Boolean(pageUrl) && serverMatchAvailable(definition, matchSignals, input.hashedEmail, adPlatformUserData), connection: snapshot,
  })
  const statements: D1PreparedStatement[] = [
    factStatement(env.DB, { id, canonicalEvent: input.canonicalEvent, factOrigin: 'live', externalEventId: plan.externalEventId, provider: context.provider, source: context.source, contextId: context.context?.contextId ?? null, occurredAt, dedupeKey, dimensions: dimensions(input, { methodType: input.methodType, actionTarget: input.actionTarget }) }),
    ...plan.deliveries.map(delivery => deliveryStatement(env.DB, id, snapshot, delivery)),
    ...await outboxStatements(env.DB, keys, id, input.canonicalEvent, eventTime, pageUrl, input.hashedEmail, adPlatformUserData, snapshot, plan.deliveries),
  ]
  try { await env.DB.batch(statements) } catch (error) {
    const concurrent = await findFact(env.DB, dedupeKey)
    if (concurrent) return duplicate(concurrent.id, input.actionType, await existingBrowserInstructions(env.DB, concurrent))
    throw error
  }
  await Promise.allSettled(plan.deliveries
    .filter(delivery => delivery.transport === 'server')
    .map(async delivery => { await enqueueAttributionDelivery(env, { provider: delivery.provider, deliveryId: delivery.id, queue: getAttributionQueue(env, delivery.provider) }) }))
  return { id, actionType: input.actionType, created: true, duplicateOf: '', trackingInstructions: plan.deliveries.flatMap(delivery => delivery.browserInstruction ? [delivery.browserInstruction] : []) }
}

function trustedContext(context: AdAttributionContext | null | undefined, source: ConversionBaseInput['attributionSource']) {
  const definition = getAdPlatformDefinition(context?.provider)
  const valid = source === 'context' && definition && context && identifier(context.contextId)
  return { provider: valid ? definition.provider : null, context: valid ? context : null, source: valid ? context.source : source === 'conflict' ? 'conflict' : 'none', sourceAvailable: Boolean(valid) }
}

async function outboxStatements(db: D1Database, keys: Awaited<ReturnType<typeof loadAttributionCryptoKeys>>, factId: string, canonicalEvent: CanonicalConversionEvent, eventTime: number, pageUrl: string | null, hashedEmail: string | undefined, adPlatformUserData: AdPlatformSensitiveContext, snapshot: Awaited<ReturnType<typeof readAttributionConnectionSnapshot>>, deliveries: Awaited<ReturnType<typeof buildAttributionDeliveryPlan>>['deliveries']) {
  if (snapshot.state !== 'ready' || !pageUrl) return []
  return Promise.all(deliveries.filter(delivery => delivery.transport === 'server').map(async delivery => {
    const networkContext = providerNetworkContext(delivery.provider, adPlatformUserData)
    const payload = { canonicalEvent, externalEventId: delivery.externalEventId, eventTime, pageUrl, destination: delivery.destination, matchSignals: delivery.matchSignals, ...networkContext, ...(validHash(hashedEmail) ? { hashedEmail } : {}) }
    const envelope = await encryptAttributionValue({ keys, aad: { purpose: 'outbox', provider: delivery.provider, subjectId: factId, scope: snapshot.connection.outboxScope }, plaintext: JSON.stringify(payload) })
    return db.prepare(`INSERT INTO attribution_outbox (delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(delivery.id, delivery.provider, envelope.schemaVersion, envelope.keyId, envelope.iv, envelope.ciphertext, envelope.tag, new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString())
  }))
}

function factStatement(db: D1Database, input: { id: string; canonicalEvent: CanonicalConversionEvent; factOrigin: 'live' | 'historical_backfill'; externalEventId: string | null; provider: AdAttributionProvider | null; source: string; contextId: string | null; occurredAt: string; dedupeKey: string; dimensions: Record<string, unknown> }) {
  return db.prepare(`INSERT INTO attribution_conversion_facts (id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source, attribution_context_id, occurred_at, dedupe_key, analytics_dimensions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(input.id, input.canonicalEvent, input.factOrigin, input.externalEventId, input.provider, input.source, input.contextId, input.occurredAt, input.dedupeKey, JSON.stringify(input.dimensions))
}
function deliveryStatement(db: D1Database, factId: string, snapshot: Awaited<ReturnType<typeof readAttributionConnectionSnapshot>>, delivery: Awaited<ReturnType<typeof buildAttributionDeliveryPlan>>['deliveries'][number]) {
  if (snapshot.state !== 'ready') throw new Error('ATTRIBUTION_CONNECTION_INVALID')
  return db.prepare(`INSERT INTO attribution_deliveries (id, fact_id, connection_id, provider, transport, status, destination, match_signals_json) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)`).bind(delivery.id, factId, snapshot.connection.id, delivery.provider, delivery.transport, delivery.destination, JSON.stringify(Object.keys(delivery.matchSignals).sort()))
}
async function findFact(db: D1Database, dedupeKey: string) { return db.prepare(`SELECT id, canonical_event, external_event_id FROM attribution_conversion_facts WHERE dedupe_key = ? LIMIT 1`).bind(dedupeKey).first<{ id: string; canonical_event: CanonicalConversionEvent; external_event_id: string }>() }
async function existingBrowserInstructions(db: D1Database, fact: { id: string; canonical_event: CanonicalConversionEvent; external_event_id: string }) {
  const rows = await db.prepare(`
    SELECT delivery.id, delivery.provider, delivery.destination, binding.server_destination
    FROM attribution_deliveries AS delivery
    JOIN attribution_event_bindings AS binding
      ON binding.connection_id = delivery.connection_id
      AND binding.canonical_event = ?
    WHERE delivery.fact_id = ?
      AND delivery.transport = 'browser'
      AND delivery.status NOT IN ('cancelled', 'rejected')
  `).bind(fact.canonical_event, fact.id).all<{ id: string; provider: unknown; destination: string; server_destination: string }>()
  const instructions = await Promise.all(rows.results.map(async row => {
    const definition = getAdPlatformDefinition(row.provider)
    const descriptor = definition?.describeEvent({ canonicalEvent: fact.canonical_event })
    return definition && descriptor ? {
      provider: definition.provider,
      canonicalEvent: fact.canonical_event,
      externalEventId: fact.external_event_id,
      descriptor: { ...descriptor, browserDestination: row.destination, serverDestination: row.server_destination },
      payload: {},
    } : null
  }))
  return instructions.filter((instruction): instruction is AdBrowserInstruction => Boolean(instruction))
}
function duplicate(id: string, actionType: RecordConversionResult['actionType'], trackingInstructions: AdBrowserInstruction[]): RecordConversionResult { return { id, actionType, created: false, duplicateOf: id, trackingInstructions } }
function dimensions(input: ConversionBaseInput, extra: Record<string, unknown>) { return { visitorId: input.visitorId, sessionId: input.sessionId, userId: input.userId ?? null, routeName: text(input.routeName), path: text(input.path), sourceChannel: text(input.sourceChannel), sourceName: text(input.sourceName), trackingSourceSlug: text(input.trackingSourceSlug), utmSource: text(input.utmSource), utmMedium: text(input.utmMedium), utmCampaign: text(input.utmCampaign), utmContent: normalizeAnalyticsCampaignToken(input.utmContent), metadata: sanitizeConversionMetadata(input.metadata ?? {}), ...extra } }
function absolutePageUrl(siteUrl: string | undefined, path: string | undefined) { try { if (!siteUrl || !path?.startsWith('/')) return null; const origin = new URL(siteUrl); if (!['http:', 'https:'].includes(origin.protocol)) return null; return new URL(path, origin.origin).toString() } catch { return null } }
function serverMatchAvailable(definition: ReturnType<typeof getAdPlatformDefinition>, matchSignals: Record<string, string>, hashedEmail: string | undefined, userData: AdPlatformSensitiveContext) {
  return Object.keys(matchSignals).length > 0
    || validHash(hashedEmail)
    || Boolean(definition?.capabilities.networkMatching && userData.clientIpAddress && userData.clientUserAgent)
}
function providerNetworkContext(provider: AdAttributionProvider, userData: AdPlatformSensitiveContext) {
  return getAdPlatformDefinition(provider)?.capabilities.networkMatching && userData.clientIpAddress && userData.clientUserAgent
    ? { clientIpAddress: userData.clientIpAddress, clientUserAgent: userData.clientUserAgent }
    : {}
}
function iso(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString() }
function unixSeconds(value: string) { return Math.floor(new Date(value).getTime() / 1_000) }
function text(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) }
function identifier(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validHash(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) }
