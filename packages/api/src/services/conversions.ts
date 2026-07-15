import type {
  AdAttributionProvider,
  AdBrowserInstruction,
  AnalyticsConsentState,
  AnalyticsSourceChannel,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import { buildConversionDedupeKey, sanitizeConversionMetadata } from '../utils/conversions'
import { encryptAttributionValue, loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import { readAttributionConnectionSnapshot } from './ad-platform/connections'
import { buildAttributionDeliveryPlan } from './ad-platform/planner'
import { getAdPlatformDefinition } from './ad-platform/registry'

type ConversionEnv = Pick<Bindings, 'DB' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS'>

type AttributionContextInput = {
  provider: AdAttributionProvider
  contextId: string
  source: 'click_id' | 'managed_link' | 'utm_alias'
}

type ConversionBaseInput = {
  visitorId: string
  sessionId: string
  userId?: number | null
  occurredAt: string
  routeName?: string
  path?: string
  sourceChannel?: AnalyticsSourceChannel | string
  sourceName?: string
  trackingSourceSlug?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  consentState?: AnalyticsConsentState | string
  attributionContext?: AttributionContextInput | null
  attributionSource?: 'context' | 'none' | 'conflict'
  metadata?: Record<string, unknown>
}

export type RecordContactInput = ConversionBaseInput & {
  contactMethodId: string
  contactPlatform: string
  actionType: 'open_link'
}

export type RecordRegistrationInput = ConversionBaseInput & { userId: number }

export type RecordRegistrationFactOnlyInput = Pick<RecordRegistrationInput,
  'userId' | 'visitorId' | 'sessionId' | 'occurredAt' | 'sourceChannel' | 'sourceName' | 'trackingSourceSlug'
  | 'utmSource' | 'utmMedium' | 'utmCampaign' | 'utmContent' | 'metadata'
>

export interface RecordConversionResult {
  id: string
  actionType: 'contact' | 'complete_registration'
  created: boolean
  duplicateOf: string
  trackingInstructions: AdBrowserInstruction[]
}

export class ConversionInProgressError extends Error {
  readonly code = 'CONVERSION_IN_PROGRESS'
  constructor() { super('CONVERSION_IN_PROGRESS'); this.name = 'ConversionInProgressError' }
}

export async function recordContact(env: ConversionEnv, input: RecordContactInput): Promise<RecordConversionResult> {
  if (input.actionType !== 'open_link' || !identifier(input.contactMethodId) || !input.contactPlatform.trim()) {
    throw new Error('PUBLIC_CONVERSION_ACTION_INVALID')
  }
  return recordLiveFact(env, {
    ...input,
    canonicalEvent: 'Contact', actionType: 'contact', methodType: input.contactPlatform, actionTarget: input.contactMethodId,
  })
}

export async function recordRegistration(env: ConversionEnv, input: RecordRegistrationInput): Promise<RecordConversionResult> {
  return recordLiveFact(env, {
    ...input,
    canonicalEvent: 'CompleteRegistration', actionType: 'complete_registration', methodType: 'email', actionTarget: `user_${input.userId}`,
  })
}

/** 历史补偿只写新事实表，不创建广告 Delivery。 */
export async function recordRegistrationFactOnly(db: D1Database, input: RecordRegistrationFactOnlyInput): Promise<RecordConversionResult> {
  const occurredAt = iso(input.occurredAt)
  const dedupeKey = buildConversionDedupeKey({
    actionType: 'complete_registration', userId: input.userId, visitorId: input.visitorId,
    sessionId: input.sessionId, occurredDate: occurredAt.slice(0, 10),
  })
  const existing = await findFact(db, dedupeKey)
  if (existing) return duplicate(existing, 'complete_registration')
  const id = generateId('fact')
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO attribution_conversion_facts (
          id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source,
          attribution_context_id, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
        ) VALUES (?, 'CompleteRegistration', 'historical_backfill', NULL, NULL, 'none', NULL, ?, ?, ?, ?)
      `).bind(id, occurredAt, dedupeKey, JSON.stringify(consentSnapshot('limited')), JSON.stringify(dimensions(input, {}))),
      auditStatement(db, id, 'historical_backfill'),
    ])
  } catch (error) {
    const concurrent = await findFact(db, dedupeKey)
    if (concurrent) return duplicate(concurrent, 'complete_registration')
    throw error
  }
  return { id, actionType: 'complete_registration', created: true, duplicateOf: '', trackingInstructions: [] }
}

async function recordLiveFact(env: ConversionEnv, input: ConversionBaseInput & {
  actionType: 'contact' | 'complete_registration'
  canonicalEvent: CanonicalConversionEvent
  methodType: string
  actionTarget: string
}): Promise<RecordConversionResult> {
  const occurredAt = iso(input.occurredAt)
  const dedupeKey = buildConversionDedupeKey({
    actionType: input.actionType, userId: input.userId ?? undefined, visitorId: input.visitorId,
    sessionId: input.sessionId, occurredDate: occurredAt.slice(0, 10), methodType: input.methodType, actionTarget: input.actionTarget,
  })
  const existing = await findFact(env.DB, dedupeKey)
  if (existing) return duplicate(existing, input.actionType)
  const id = generateId('fact')
  const consent = consentSnapshot(input.consentState)
  const context = trustedContext(input.attributionContext, input.attributionSource, consent.marketingAllowed)
  const keys = await loadAttributionCryptoKeys(env)
  const snapshot = context.provider
    ? await readAttributionConnectionSnapshot(env.DB, context.provider)
    : { state: 'connection_invalid' as const, reason: 'not_found' as const }
  const plan = await buildAttributionDeliveryPlan({
    factId: id, provider: context.provider, canonicalEvent: input.canonicalEvent,
    consentGranted: consent.marketingAllowed, sourceAvailable: context.sourceAvailable,
    stableId: stableId(input), cryptoKeys: keys, connection: snapshot,
  })
  const factProvider = plan.deliveries[0]?.provider ?? context.provider
  const statements: D1PreparedStatement[] = [
    factStatement(env.DB, {
      id, canonicalEvent: input.canonicalEvent, externalEventId: plan.externalEventId, provider: factProvider,
      source: context.source, contextId: context.contextId, occurredAt, dedupeKey, consent,
      dimensions: dimensions(input, { methodType: input.methodType, actionTarget: input.actionTarget }),
    }),
    ...plan.deliveries.map(delivery => deliveryStatement(env.DB, id, snapshot, delivery)),
    ...await outboxStatements(env.DB, keys, id, input.canonicalEvent, snapshot, plan.deliveries),
    auditStatement(env.DB, id, 'fact_created'),
  ]
  try {
    await env.DB.batch(statements)
  } catch (error) {
    const concurrent = await findFact(env.DB, dedupeKey)
    if (concurrent) return duplicate(concurrent, input.actionType)
    throw error
  }
  return {
    id, actionType: input.actionType, created: true, duplicateOf: '',
    trackingInstructions: plan.deliveries.flatMap(delivery => delivery.browserInstruction ? [delivery.browserInstruction] : []),
  }
}

function trustedContext(context: AttributionContextInput | null | undefined, source: ConversionBaseInput['attributionSource'], consentGranted: boolean) {
  const definition = getAdPlatformDefinition(context?.provider)
  const valid = consentGranted && source === 'context' && definition && context && identifier(context.contextId)
  return {
    provider: valid ? definition.provider : null,
    contextId: valid ? context.contextId : null,
    source: valid ? context.source : source === 'conflict' ? 'conflict' : 'none',
    sourceAvailable: Boolean(valid),
  }
}

async function outboxStatements(
  db: D1Database,
  keys: Awaited<ReturnType<typeof loadAttributionCryptoKeys>>,
  factId: string,
  canonicalEvent: CanonicalConversionEvent,
  snapshot: Awaited<ReturnType<typeof readAttributionConnectionSnapshot>>,
  deliveries: Awaited<ReturnType<typeof buildAttributionDeliveryPlan>>['deliveries'],
) {
  if (snapshot.state !== 'ready') return []
  const serverDeliveries = deliveries.filter(delivery => delivery.transport === 'server')
  return Promise.all(serverDeliveries.map(async delivery => {
    const envelope = await encryptAttributionValue({
      keys,
      aad: { purpose: 'outbox', provider: delivery.provider, subjectId: factId, revision: snapshot.connection.connectionRevision },
      plaintext: JSON.stringify({ factId, canonicalEvent, externalEventId: delivery.externalEventId, destination: delivery.destination }),
    })
    return db.prepare(`
      INSERT INTO attribution_outbox (delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(delivery.id, delivery.provider, envelope.schemaVersion, envelope.keyId, envelope.iv, envelope.ciphertext, envelope.tag,
      new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString())
  }))
}

function factStatement(db: D1Database, input: {
  id: string
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  provider: AdAttributionProvider | null
  source: string
  contextId: string | null
  occurredAt: string
  dedupeKey: string
  consent: ReturnType<typeof consentSnapshot>
  dimensions: Record<string, unknown>
}) {
  return db.prepare(`
    INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source,
      attribution_context_id, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
    ) VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(input.id, input.canonicalEvent, input.externalEventId, input.provider, input.source, input.contextId,
    input.occurredAt, input.dedupeKey, JSON.stringify(input.consent), JSON.stringify(input.dimensions))
}

function deliveryStatement(
  db: D1Database,
  factId: string,
  snapshot: Awaited<ReturnType<typeof readAttributionConnectionSnapshot>>,
  delivery: Awaited<ReturnType<typeof buildAttributionDeliveryPlan>>['deliveries'][number],
) {
  if (snapshot.state !== 'ready') throw new Error('ATTRIBUTION_CONNECTION_INVALID')
  return db.prepare(`
    INSERT INTO attribution_deliveries (id, fact_id, connection_id, provider, transport, status, destination, match_signals_json)
    VALUES (?, ?, ?, ?, ?, 'planned', ?, '[]')
  `).bind(delivery.id, factId, snapshot.connection.id, delivery.provider, delivery.transport, delivery.destination)
}

function auditStatement(db: D1Database, factId: string, eventType: string) {
  return db.prepare(`INSERT INTO attribution_fact_audit_logs (id, fact_id, event_type, detail_json) VALUES (?, ?, ?, ?)`)
    .bind(generateId('afa'), factId, eventType, JSON.stringify({ schemaVersion: 1 }))
}

async function findFact(db: D1Database, dedupeKey: string) {
  const row = await db.prepare(`SELECT id FROM attribution_conversion_facts WHERE dedupe_key = ? LIMIT 1`).bind(dedupeKey).first<{ id: string }>()
  return row?.id ?? null
}

function duplicate(id: string, actionType: RecordConversionResult['actionType']): RecordConversionResult {
  return { id, actionType, created: false, duplicateOf: id, trackingInstructions: [] }
}

function consentSnapshot(state: unknown) {
  const marketingAllowed = state === 'granted'
  return { version: 1, marketingAllowed, adUserDataAllowed: marketingAllowed, adPersonalizationAllowed: marketingAllowed }
}

function dimensions(input: ConversionBaseInput, extra: Record<string, unknown>) {
  return {
    visitorId: input.visitorId, sessionId: input.sessionId, userId: input.userId ?? null,
    routeName: text(input.routeName), path: text(input.path), sourceChannel: text(input.sourceChannel),
    sourceName: text(input.sourceName), trackingSourceSlug: text(input.trackingSourceSlug),
    utmSource: text(input.utmSource), utmMedium: text(input.utmMedium), utmCampaign: text(input.utmCampaign),
    utmContent: text(input.utmContent), metadata: sanitizeConversionMetadata(input.metadata ?? {}), ...extra,
  }
}

function stableId(input: ConversionBaseInput) { return input.userId ? `user_${input.userId}` : input.visitorId }
function iso(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString() }
function text(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) }
function identifier(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
