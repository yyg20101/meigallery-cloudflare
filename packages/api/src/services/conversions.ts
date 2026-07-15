import type {
  ActiveConversionActionType,
  AdAttributionProvider,
  AdDeliveryTransport,
  AdPlatformConversionEventName,
  AdPlatformEncryptedEnvelope,
  AdPlatformProvider,
  AdPlatformTrackingMode,
  AnalyticsConsentState,
  AnalyticsSourceChannel,
  AdPlatformSensitiveContext,
  ConversionSkipReason,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import {
  buildConversionDedupeKey,
  buildExternalEventId,
  sanitizeConversionMetadata,
} from '../utils/conversions'
import { createPixelReceiptToken, type PixelReceiptClaims } from '../utils/pixel-receipt'
import {
  hashAdPlatformEmail,
  hashAdPlatformExternalId,
  normalizeAdPlatformUserData,
} from '../utils/ad-platform-identifiers'
import {
  encryptMetaCapiContext,
  loadMetaCapiCryptoKeys,
  type MetaCapiCryptoKeys,
  type MetaCapiSensitiveContext,
} from '../utils/meta-capi-crypto'
import {
  encryptTikTokEventsContext,
  loadTikTokEventsCryptoKeys,
  type TikTokEventsCryptoKeys,
  type TikTokEventsSensitiveContext,
} from '../utils/tiktok-events-crypto'
import { transitionDeliveryStatus } from './ad-platform/delivery-store'
import { hasAdPlatformAdapter, mapConversionToPlatformEvent } from './ad-platform/registry'
import { readAdPlatformConnection } from './ad-platform/connections'
import {
  createAdPlatformSecureOutboxStatement,
  enqueueAdPlatformSecureDelivery,
} from './ad-platform/secure-outbox'
import { requireVerifiedMetaConnection } from './meta-connection'
import {
  decideMetaCapiRollout,
  type MetaCapiRolloutDecision,
} from './meta-capi-rollout'
import { requireVerifiedTikTokConnection } from './tiktok-connection'
import {
  decideAdPlatformRollout,
  type AdPlatformRolloutDecision,
} from './ad-platform/rollout'
import {
  acquireConversionDedupeClaim,
  conversionDedupeClaimSnapshotParams,
  d1Changed,
  digestConversionDedupeKey,
  releaseConversionDedupeClaim,
  releaseConversionDedupeClaimStatement,
  renewConversionDedupeClaim,
  type ConversionDedupeClaim,
} from './conversion-dedupe-claim'

const SECURE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000

type ConversionEnv = Pick<
  Bindings,
  | 'DB'
  | 'APP_ENV'
  | 'SESSION_SECRET'
  | 'META_CAPI_QUEUE'
  | 'META_CAPI_DATA_KEY_CURRENT'
  | 'META_CAPI_DATA_KEY_PREVIOUS'
  | 'META_CAPI_ACCESS_TOKEN'
  | 'TIKTOK_EVENTS_QUEUE'
  | 'TIKTOK_EVENTS_DATA_KEY_CURRENT'
  | 'TIKTOK_EVENTS_DATA_KEY_PREVIOUS'
  | 'TIKTOK_EVENTS_ACCESS_TOKEN'
  | 'RELEASE_COMMIT'
>

export interface RecordConversionInput {
  actionType: ActiveConversionActionType
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
  attributionProvider?: AdAttributionProvider | string
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

export interface RecordConversionResult {
  id: string
  actionType: ActiveConversionActionType
  created: boolean
  duplicateOf: string
  trackingInstructions: LegacyAdBrowserInstruction[]
}

type RecordActiveConversionInput = Omit<RecordConversionInput, 'actionType'>

export type RecordContactInput = Omit<RecordActiveConversionInput, 'methodType' | 'actionTarget'> & {
  methodType: string
  actionTarget: string
}

export type RecordRegistrationInput = Omit<RecordActiveConversionInput, 'userId'> & {
  userId: number
}

export type RecordRegistrationFactOnlyInput = Pick<
  RecordRegistrationInput,
  | 'userId'
  | 'visitorId'
  | 'sessionId'
  | 'occurredAt'
  | 'sourceChannel'
  | 'sourceName'
  | 'trackingSourceSlug'
  | 'utmSource'
  | 'utmMedium'
  | 'utmCampaign'
  | 'utmContent'
  | 'metadata'
>

export interface RecordConversionContext {
  getAdPlatformUserData: () => AdPlatformSensitiveContext | Promise<AdPlatformSensitiveContext>
}

interface RecordRegistrationSensitiveInput {
  email: string
  externalId: string
}

interface RecordRegistrationContext extends RecordConversionContext {
  getRegistrationSensitiveInput: () => RecordRegistrationSensitiveInput | Promise<RecordRegistrationSensitiveInput>
}

export interface MarkPixelAttemptedResult {
  deliveryId: string
  attempted: boolean
}

/** 任务 1 之前已投放的 Meta/TikTok 浏览器指令，待后续任务迁移。 */
interface LegacyAdBrowserInstruction {
  provider: Extract<AdPlatformProvider, 'meta' | 'tiktok'>
  deliveryId: string
  eventName: AdPlatformConversionEventName
  eventId: string
  payload: Record<string, string | number | boolean>
  receiptToken: string
}

type PlannedDelivery = {
  deliveryId: string
  provider: AdPlatformProvider
  transport: AdDeliveryTransport
  eventName: AdPlatformConversionEventName
  eventId: string
  browserInstruction?: LegacyAdBrowserInstruction
  status: 'pending' | 'skipped'
  skipReason: '' | Extract<ConversionSkipReason,
    | 'connection_unverified'
    | 'missing_data_key'
    | 'invalid_data_key'
    | 'invalid_sensitive_context'
    | 'rollout_excluded'
    | 'circuit_open'
    | 'missing_stable_id'
  >
  envelope?: Omit<AdPlatformEncryptedEnvelope, 'expiresAt'> & { schemaVersion: 2 }
  expiresAt?: string
  hasFbp: 0 | 1
  hasFbc: 0 | 1
  hasTtclid: 0 | 1
  hasTtp: 0 | 1
  hasEmail: 0 | 1
  hasExternalId: 0 | 1
  encryptionKeyId: string
  trackingMode: AdPlatformTrackingMode
  connectionRevision: string | null
  rolloutTargetPercentage: number
  rolloutEffectivePercentage: number
  rolloutBucket: number | null
  statementIndex: number
}

type ServerEncryptionPlan<Keys, Context, Rollout extends AdPlatformRolloutDecision> =
  | { state: 'disabled'; connectionRevision?: string }
  | {
      state: 'skipped'
      reason: Extract<ConversionSkipReason,
        | 'connection_unverified'
        | 'missing_data_key'
        | 'invalid_data_key'
        | 'invalid_sensitive_context'
        | 'rollout_excluded'
        | 'circuit_open'
        | 'missing_stable_id'
      >
      connectionRevision?: string
      rollout: Rollout | null
    }
  | {
      state: 'ready'
      keys: Keys
      context: Context
      connectionRevision: string
      rollout: Rollout
    }

type CapiEncryptionPlan = ServerEncryptionPlan<
  MetaCapiCryptoKeys,
  MetaCapiSensitiveContext,
  MetaCapiRolloutDecision
>

type TikTokEncryptionPlan = ServerEncryptionPlan<
  TikTokEventsCryptoKeys,
  TikTokEventsSensitiveContext,
  AdPlatformRolloutDecision
>

type MetaDeliverySettings = Awaited<ReturnType<typeof readMetaDeliverySettings>>

export class ConversionInProgressError extends Error {
  readonly code = 'CONVERSION_IN_PROGRESS'

  constructor() {
    super('CONVERSION_IN_PROGRESS')
    this.name = 'ConversionInProgressError'
  }
}

export async function recordContact(
  env: ConversionEnv,
  input: RecordContactInput,
  context?: RecordConversionContext,
) {
  const methodType = input.methodType.trim()
  const actionTarget = input.actionTarget.trim()
  if (!methodType || !actionTarget) {
    throw new Error('联系转化必须包含非空 methodType 和 actionTarget')
  }
  return recordActiveConversion(env, { ...input, methodType, actionTarget, actionType: 'contact' }, context)
}

export async function recordRegistration(
  env: ConversionEnv,
  input: RecordRegistrationInput,
  context?: RecordRegistrationContext,
) {
  return recordActiveConversion(
    env,
    { ...input, actionType: 'complete_registration' },
    context ? registrationConversionContext(context) : undefined,
  )
}

export async function recordRegistrationFactOnly(
  db: D1Database,
  input: RecordRegistrationFactOnlyInput,
): Promise<RecordConversionResult> {
  const normalizedInput = normalizeConversionInput({
    ...input,
    actionType: 'complete_registration',
    consentState: 'limited',
  })
  const occurredAt = normalizeIso(normalizedInput.occurredAt)
  const date = occurredAt.slice(0, 10)
  const dedupeKey = conversionDedupeKey(normalizedInput, date)
  const existing = await findConversionByDedupeKey(db, dedupeKey)
  if (existing) {
    return {
      id: existing.id,
      actionType: 'complete_registration',
      created: false,
      duplicateOf: existing.id,
      trackingInstructions: [],
    }
  }

  const id = generateId('conv')
  const results = await db.batch([
    conversionActionStatement(db, id, normalizedInput, occurredAt, date, dedupeKey),
    conversionDailyStatement(db, normalizedInput, date, id),
  ])
  if (!d1Changed(results[0]!)) {
    const concurrent = await findConversionByDedupeKey(db, dedupeKey)
    if (concurrent) {
      return {
        id: concurrent.id,
        actionType: 'complete_registration',
        created: false,
        duplicateOf: concurrent.id,
        trackingInstructions: [],
      }
    }
    throw new Error('注册转化事实写入未确认')
  }

  return {
    id,
    actionType: 'complete_registration',
    created: true,
    duplicateOf: '',
    trackingInstructions: [],
  }
}

async function recordActiveConversion(
  env: ConversionEnv,
  input: RecordConversionInput,
  context: RecordConversionContext = { getAdPlatformUserData: () => ({}) },
): Promise<RecordConversionResult> {
  const normalizedInput = normalizeConversionInput(input)
  const occurredAt = normalizeIso(normalizedInput.occurredAt)
  const date = occurredAt.slice(0, 10)
  const dedupeKey = conversionDedupeKey(normalizedInput, date)
  const existing = await findConversionByDedupeKey(env.DB, dedupeKey)
  if (existing) return recordDuplicateResult(env.DB, normalizedInput, occurredAt, date, dedupeKey, existing.id)

  const id = generateId('conv')
  const dedupeDigest = await digestConversionDedupeKey(dedupeKey)
  const acquired = await acquireConversionDedupeClaim(
    env.DB,
    dedupeDigest,
    id,
    async () => (await findConversionByDedupeKey(env.DB, dedupeKey))?.id ?? null,
  )
  if (acquired.state === 'duplicate') {
    return committedDuplicateResult(normalizedInput.actionType, acquired.existingId)
  }
  if (acquired.state === 'unavailable') throw new ConversionInProgressError()

  let claim = acquired.claim
  let ownsClaim = true
  try {
    const plan = await buildConversionBatchPlan(
      env,
      id,
      normalizedInput,
      date,
      dedupeKey,
      context,
      async () => {
        const renewed = await renewConversionDedupeClaim(env.DB, claim)
        if (!renewed) throw new ConversionInProgressError()
        claim = renewed
      },
    )
    const renewedBeforeCommit = await renewConversionDedupeClaim(env.DB, claim)
    if (!renewedBeforeCommit) {
      await releaseConversionDedupeClaim(env.DB, claim)
      ownsClaim = false
      return resolveLostDedupeClaim(env.DB, normalizedInput.actionType, dedupeKey)
    }
    claim = renewedBeforeCommit
    plan.statements.unshift(fencedConversionActionStatement(
      env.DB,
      id,
      normalizedInput,
      occurredAt,
      date,
      dedupeKey,
      claim,
    ))
    for (const delivery of plan.deliveries) delivery.statementIndex += 1
    plan.statements.push(releaseConversionDedupeClaimStatement(env.DB, claim))
    const results = await env.DB.batch(plan.statements)
    ownsClaim = false
    if (!d1Changed(results[0]!)) {
      const concurrent = await findConversionByDedupeKey(env.DB, dedupeKey)
      if (concurrent) return committedDuplicateResult(normalizedInput.actionType, concurrent.id)
      throw new ConversionInProgressError()
    }

    const committedDeliveries = plan.deliveries.filter(delivery => d1Changed(results[delivery.statementIndex]!))
    const trackingInstructions = committedDeliveries.flatMap(
      delivery => delivery.browserInstruction ? [delivery.browserInstruction] : [],
    )
    await finalizeCapiDeliveries(env, committedDeliveries)

    return {
      id,
      actionType: normalizedInput.actionType,
      created: true,
      duplicateOf: '',
      trackingInstructions,
    }
  }
  catch (error) {
    if (ownsClaim) await releaseConversionDedupeClaim(env.DB, claim)
    if (error instanceof ConversionInProgressError) {
      return resolveLostDedupeClaim(env.DB, normalizedInput.actionType, dedupeKey)
    }
    throw error
  }
}

async function resolveLostDedupeClaim(
  db: D1Database,
  actionType: ActiveConversionActionType,
  dedupeKey: string,
) {
  const existing = await findConversionByDedupeKey(db, dedupeKey)
  if (existing) return committedDuplicateResult(actionType, existing.id)
  throw new ConversionInProgressError()
}

function registrationConversionContext(context: RecordRegistrationContext): RecordConversionContext {
  return {
    getAdPlatformUserData: async () => {
      try {
        const browser = await context.getAdPlatformUserData()
        const sensitive = await context.getRegistrationSensitiveInput()
        const [emailSha256, externalIdSha256] = await Promise.all([
          hashAdPlatformEmail(sensitive.email),
          hashAdPlatformExternalId(sensitive.externalId),
        ])
        return { ...browser, emailSha256, externalIdSha256 }
      }
      catch {
        throw new Error('META_CAPI_CONTEXT_BUILD_FAILED')
      }
    },
  }
}

export async function markPixelAttempted(
  db: D1Database,
  claims: PixelReceiptClaims,
): Promise<MarkPixelAttemptedResult> {
  const delivery = await db.prepare(`
    SELECT d.id, d.provider, d.transport, d.external_event_id, d.status, d.event_name, a.date
    FROM analytics_conversion_deliveries d
    JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
    WHERE d.id = ?
    LIMIT 1
  `).bind(claims.deliveryId).first<{
    id: string
    provider: string
    transport: string
    external_event_id: string
    status: string
    event_name: string
    date: string
  }>()

  if (!delivery
    || !hasAdPlatformAdapter(delivery.provider)
    || delivery.transport !== 'browser'
    || delivery.external_event_id !== claims.eventId) {
    throw new Error('Pixel 回执无效')
  }
  if (delivery.status === 'attempted') return { deliveryId: delivery.id, attempted: false }
  if (delivery.status !== 'pending') throw new Error('Pixel 回执无效')

  const transition = await transitionDeliveryStatus(db, {
    id: delivery.id,
    provider: delivery.provider,
    transport: delivery.transport,
    event_name: delivery.event_name,
    status: 'pending',
    skip_reason: '',
    date: delivery.date,
  }, { status: 'attempted' })
  if (!transition.changed) {
    const current = await db.prepare(`
      SELECT provider, transport, external_event_id, status
      FROM analytics_conversion_deliveries
      WHERE id = ?
      LIMIT 1
    `).bind(delivery.id).first<{ provider: string; transport: string; external_event_id: string; status: string }>()
    if (hasAdPlatformAdapter(current?.provider)
      && current.transport === 'browser'
      && current.external_event_id === claims.eventId
      && current.status === 'attempted') {
      return { deliveryId: delivery.id, attempted: false }
    }
    throw new Error('Pixel 回执无效')
  }

  return { deliveryId: delivery.id, attempted: true }
}

function normalizeConversionInput(input: RecordConversionInput): RecordConversionInput {
  return {
    ...input,
    visitorId: normalizeText(input.visitorId, 120),
    sessionId: normalizeText(input.sessionId, 120),
    sourceChannel: normalizeText(input.sourceChannel || 'unknown', 40) || 'unknown',
    sourceName: normalizeText(input.sourceName || input.utmSource || input.trackingSourceSlug || '', 120),
    trackingSourceSlug: normalizeText(input.trackingSourceSlug || '', 120),
    utmSource: normalizeText(input.utmSource || '', 120),
    utmMedium: normalizeText(input.utmMedium || '', 120),
    utmCampaign: normalizeText(input.utmCampaign || '', 120),
    utmContent: normalizeText(input.utmContent || '', 120),
    methodType: normalizeText(input.methodType || '', 80),
    actionTarget: normalizeText(input.actionTarget || '', 120),
    routeName: normalizeText(input.routeName || '', 120),
    path: normalizeText(input.path || '', 240),
    consentState: normalizeText(input.consentState || 'limited', 20) || 'limited',
    attributionProvider: normalizeAttributionProvider(input.attributionProvider),
  }
}

function normalizeIso(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

async function insertConversion(
  db: D1Database,
  id: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
  duplicateOf: string,
) {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
      source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
      utm_campaign, utm_content, method_type, action_target, route_name, path,
      attribution_provider, metadata, duplicate_of
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.actionType,
    dedupeKey,
    occurredAt,
    date,
    input.visitorId || '',
    input.sessionId || '',
    input.userId ?? null,
    input.sourceChannel || 'unknown',
    input.sourceName || '',
    input.trackingSourceSlug || '',
    input.utmSource || '',
    input.utmMedium || '',
    input.utmCampaign || '',
    input.utmContent || '',
    input.methodType || '',
    input.actionTarget || '',
    input.routeName || '',
    input.path || '',
    input.attributionProvider || '',
    JSON.stringify(sanitizeConversionMetadata(input.metadata || {})),
    duplicateOf,
  ).run()
  return d1Changed(result)
}

async function recordDuplicateResult(
  db: D1Database,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
  existingId: string,
): Promise<RecordConversionResult> {
  const duplicateId = await recordDuplicateConversion(db, input, occurredAt, date, dedupeKey, existingId)
  return {
    id: duplicateId || existingId,
    actionType: input.actionType,
    created: false,
    duplicateOf: existingId,
    trackingInstructions: [],
  }
}

function committedDuplicateResult(
  actionType: ActiveConversionActionType,
  existingId: string,
): RecordConversionResult {
  return {
    id: existingId,
    actionType,
    created: false,
    duplicateOf: existingId,
    trackingInstructions: [],
  }
}

async function findConversionByDedupeKey(db: D1Database, dedupeKey: string) {
  return db
    .prepare('SELECT id FROM analytics_conversion_actions WHERE dedupe_key = ? LIMIT 1')
    .bind(dedupeKey)
    .first<{ id: string }>()
}

async function recordDuplicateConversion(
  db: D1Database,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  originalDedupeKey: string,
  duplicateOf: string,
) {
  const duplicateId = generateId('convdup')
  const duplicateDedupeKey = `duplicate:${originalDedupeKey}:${duplicateId}`
  const created = await insertConversion(db, duplicateId, input, occurredAt, date, duplicateDedupeKey, duplicateOf)
  return created ? duplicateId : ''
}

function conversionDailyStatement(db: D1Database, input: RecordConversionInput, date: string, actionId: string) {
  return db.prepare(`
    INSERT INTO analytics_conversion_daily (
      date, action_type, source_channel, source_name, utm_campaign, utm_content,
      action_count, unique_session_count, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 1, 1, datetime('now')
    WHERE changes() = 1
      AND EXISTS (SELECT 1 FROM analytics_conversion_actions WHERE id = ?)
    ON CONFLICT(date, action_type, source_channel, source_name, utm_campaign, utm_content)
    DO UPDATE SET
      action_count = analytics_conversion_daily.action_count + 1,
      unique_session_count = analytics_conversion_daily.unique_session_count + 1,
      updated_at = datetime('now')
  `).bind(
    date,
    input.actionType,
    input.sourceChannel || 'unknown',
    input.sourceName || '',
    input.utmCampaign || '',
    input.utmContent || '',
    actionId,
  )
}

async function buildConversionBatchPlan(
  env: ConversionEnv,
  actionId: string,
  input: RecordConversionInput,
  date: string,
  dedupeKey: string,
  context: RecordConversionContext,
  beforeSensitiveAccess: () => Promise<void>,
) {
  const statements: D1PreparedStatement[] = [conversionDailyStatement(env.DB, input, date, actionId)]
  const deliveries: PlannedDelivery[] = []
  const provider = normalizeAttributionProvider(input.attributionProvider)
  if (!provider) return { statements, deliveries }

  let sensitiveContextPromise: Promise<AdPlatformSensitiveContext> | undefined
  const loadSensitiveContext = () => {
    sensitiveContextPromise ??= (async () => {
      await beforeSensitiveAccess()
      return normalizeSensitiveContext(await context.getAdPlatformUserData())
    })()
    return sensitiveContextPromise
  }
  if (provider === 'meta') {
    const settings = await readMetaDeliverySettings(env.DB)
    const capiEncryption = await buildCapiEncryptionPlan(env, settings, input, loadSensitiveContext)
    deliveries.push(...await planMetaDeliveries(env, settings, input, date, capiEncryption))
  }
  else {
    const connection = await readAdPlatformConnection(env.DB, 'tiktok')
    const encryption = await buildTikTokEncryptionPlan(env, connection, input, loadSensitiveContext)
    deliveries.push(...await planTikTokDeliveries(env, connection, input, date, encryption))
  }
  for (const delivery of deliveries) {
    delivery.statementIndex = statements.push(conversionDeliveryStatement(env.DB, delivery, actionId)) - 1
    statements.push(deliveryDailyStatement(env.DB, delivery, date))
    if (delivery.transport === 'server' && delivery.envelope && delivery.expiresAt) {
      statements.push(createAdPlatformSecureOutboxStatement(env.DB, {
        provider: delivery.provider,
        deliveryId: delivery.deliveryId,
        envelope: delivery.envelope,
        expiresAt: delivery.expiresAt,
      }))
    }
  }

  return { statements, deliveries }
}

function fencedConversionActionStatement(
  db: D1Database,
  id: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
  claim: ConversionDedupeClaim,
) {
  const values = conversionActionValues(id, input, occurredAt, date, dedupeKey)
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
      source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
      utm_campaign, utm_content, method_type, action_target, route_name, path,
      attribution_provider, metadata, duplicate_of
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analytics_conversion_dedupe_claims
      WHERE dedupe_digest = ?
        AND owner_action_id = ?
        AND claim_token = ?
        AND claimed_at = ?
        AND expires_at = ?
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  `).bind(
    ...values,
    ...conversionDedupeClaimSnapshotParams(claim),
  )
}

function conversionActionStatement(
  db: D1Database,
  id: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
) {
  const values = conversionActionValues(id, input, occurredAt, date, dedupeKey)
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
      source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
      utm_campaign, utm_content, method_type, action_target, route_name, path,
      attribution_provider, metadata, duplicate_of
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...values)
}

function conversionActionValues(
  id: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
) {
  return [
    id, input.actionType, dedupeKey, occurredAt, date, input.visitorId || '', input.sessionId || '', input.userId ?? null,
    input.sourceChannel || 'unknown', input.sourceName || '', input.trackingSourceSlug || '', input.utmSource || '',
    input.utmMedium || '', input.utmCampaign || '', input.utmContent || '', input.methodType || '', input.actionTarget || '',
    input.routeName || '', input.path || '', input.attributionProvider || '',
    JSON.stringify(sanitizeConversionMetadata(input.metadata || {})), '',
  ]
}

async function planMetaDeliveries(
  env: ConversionEnv,
  settings: MetaDeliverySettings,
  input: RecordConversionInput,
  date: string,
  capiEncryption: CapiEncryptionPlan,
): Promise<PlannedDelivery[]> {
  if (input.attributionProvider !== 'meta'
    || input.consentState !== 'granted'
    || settings.mode === 'disabled'
    || !settings.pixelId) return []
  const descriptor = mapConversionToPlatformEvent('meta', input.actionType)
  const eventName = descriptor.canonicalEvent
  const eventId = await buildExternalEventId(env.SESSION_SECRET, {
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate: date,
    userId: input.userId ?? undefined,
    methodType: input.methodType,
    actionTarget: input.actionTarget,
    eventName,
  })
  const transports = [
    ...(settings.pixelEnabled ? ['browser' as const] : []),
    ...(settings.capiEnabled ? ['server' as const] : []),
  ]
  const connectionBlocked = capiEncryption.state === 'skipped' && capiEncryption.reason === 'connection_unverified'
  const connectionRevision = 'connectionRevision' in capiEncryption
    ? capiEncryption.connectionRevision ?? null
    : null
  return Promise.all(transports.map(async transport => {
    const deliveryId = generateId('cdlv')
    const serverSkipped = transport === 'server' && capiEncryption.state === 'skipped'
    const deliverySkipped = connectionBlocked || serverSkipped
    const skipReason = deliverySkipped && capiEncryption.state === 'skipped' ? capiEncryption.reason : ''
    const browserInstruction = transport === 'browser' && !deliverySkipped
      ? {
          provider: 'meta' as const,
          payload: sanitizeConversionMetadata(input.metadata || {}),
          deliveryId,
          eventName,
          eventId,
          receiptToken: await createPixelReceiptToken(env.SESSION_SECRET, {
            deliveryId,
            eventId,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          }),
        }
      : undefined
    const secureContext = transport === 'server' && capiEncryption.state === 'ready'
      ? contextForEvent(eventName, capiEncryption.context)
      : {}
    const expiresAt = transport === 'server' && capiEncryption.state === 'ready'
      ? new Date(Date.now() + SECURE_CONTEXT_TTL_MS).toISOString()
      : undefined
    const envelope = transport === 'server' && capiEncryption.state === 'ready'
      ? await encryptMetaCapiContext({
          keys: capiEncryption.keys,
          aad: { deliveryId, externalEventId: eventId, eventName },
          value: secureContext,
        })
      : undefined
    return {
      deliveryId,
      provider: 'meta',
      transport,
      eventName,
      eventId,
      browserInstruction,
      status: deliverySkipped ? 'skipped' : 'pending',
      skipReason,
      envelope,
      expiresAt,
      hasFbp: secureContext.fbp ? 1 : 0,
      hasFbc: secureContext.fbc ? 1 : 0,
      hasTtclid: 0,
      hasTtp: 0,
      hasEmail: secureContext.emailSha256 ? 1 : 0,
      hasExternalId: secureContext.externalIdSha256 ? 1 : 0,
      encryptionKeyId: envelope?.keyId ?? '',
      trackingMode: settings.mode,
      connectionRevision,
      rolloutTargetPercentage: transport === 'server' && capiEncryption.state !== 'disabled'
        ? capiEncryption.rollout?.targetPercentage ?? 0
        : 0,
      rolloutEffectivePercentage: transport === 'server' && capiEncryption.state !== 'disabled'
        ? capiEncryption.rollout?.effectivePercentage ?? 0
        : 0,
      rolloutBucket: transport === 'server' && capiEncryption.state !== 'disabled'
        ? capiEncryption.rollout?.bucket ?? null
        : null,
      statementIndex: -1,
    }
  }))
}

async function planTikTokDeliveries(
  env: ConversionEnv,
  connection: Awaited<ReturnType<typeof readAdPlatformConnection>>,
  input: RecordConversionInput,
  date: string,
  encryption: TikTokEncryptionPlan,
): Promise<PlannedDelivery[]> {
  if (!connection
    || connection.provider !== 'tiktok'
    || input.attributionProvider !== 'tiktok'
    || input.consentState !== 'granted'
    || !connection.enabled
    || connection.mode === 'disabled'
    || !connection.destinationId
    || (!connection.browserEnabled && !connection.serverEnabled)) return []

  const descriptor = mapConversionToPlatformEvent('tiktok', input.actionType)
  const eventName = descriptor.canonicalEvent
  const eventId = await buildExternalEventId(env.SESSION_SECRET, {
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate: date,
    userId: input.userId ?? undefined,
    methodType: input.methodType,
    actionTarget: input.actionTarget,
    eventName,
  })
  const transports = [
    ...(connection.browserEnabled ? ['browser' as const] : []),
    ...(connection.serverEnabled ? ['server' as const] : []),
  ]
  return Promise.all(transports.map(async transport => {
    const deliveryId = generateId('cdlv')
    const serverSkipped = transport === 'server' && encryption.state === 'skipped'
    const skipReason = serverSkipped && encryption.state === 'skipped' ? encryption.reason : ''
    const secureContext = transport === 'server' && encryption.state === 'ready'
      ? contextForTikTokEvent(eventName, encryption.context)
      : {}
    const expiresAt = transport === 'server' && encryption.state === 'ready'
      ? new Date(Date.now() + SECURE_CONTEXT_TTL_MS).toISOString()
      : undefined
    const envelope = transport === 'server' && encryption.state === 'ready'
      ? await encryptTikTokEventsContext({
          keys: encryption.keys,
          aad: { deliveryId, externalEventId: eventId, eventName },
          value: secureContext,
        })
      : undefined
    const browserInstruction = transport === 'browser'
      ? {
          provider: 'tiktok' as const,
          payload: sanitizeConversionMetadata(input.metadata || {}),
          deliveryId,
          eventName,
          eventId,
          receiptToken: await createPixelReceiptToken(env.SESSION_SECRET, {
            deliveryId,
            eventId,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          }),
        }
      : undefined
    return {
      deliveryId,
      provider: 'tiktok',
      transport,
      eventName,
      eventId,
      browserInstruction,
      status: serverSkipped ? 'skipped' : 'pending',
      skipReason,
      envelope,
      expiresAt,
      hasFbp: 0,
      hasFbc: 0,
      hasTtclid: secureContext.ttclid ? 1 : 0,
      hasTtp: secureContext.ttp ? 1 : 0,
      hasEmail: secureContext.emailSha256 ? 1 : 0,
      hasExternalId: secureContext.externalIdSha256 ? 1 : 0,
      encryptionKeyId: envelope?.keyId ?? '',
      trackingMode: connection.mode,
      connectionRevision: transport === 'server' && 'connectionRevision' in encryption
        ? encryption.connectionRevision ?? null
        : connection.revision,
      rolloutTargetPercentage: transport === 'server' && encryption.state !== 'disabled'
        ? encryption.rollout?.targetPercentage ?? 0
        : 0,
      rolloutEffectivePercentage: transport === 'server' && encryption.state !== 'disabled'
        ? encryption.rollout?.effectivePercentage ?? 0
        : 0,
      rolloutBucket: transport === 'server' && encryption.state !== 'disabled'
        ? encryption.rollout?.bucket ?? null
        : null,
      statementIndex: -1,
    } satisfies PlannedDelivery
  }))
}

function conversionDeliveryStatement(db: D1Database, delivery: PlannedDelivery, actionId: string) {
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_deliveries (
      id, conversion_action_id, provider, transport, external_event_id, event_name,
      status, skip_reason, has_fbp, has_fbc, has_ttclid, has_ttp, has_email, has_external_id,
      encryption_key_id, tracking_mode, connection_revision,
      rollout_target_percentage, rollout_effective_percentage, rollout_bucket, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    WHERE EXISTS (
      SELECT 1
      FROM analytics_conversion_actions
      WHERE id = ? AND attribution_provider = ?
    )
  `).bind(
    delivery.deliveryId,
    actionId,
    delivery.provider,
    delivery.transport,
    delivery.eventId,
    delivery.eventName,
    delivery.status,
    delivery.skipReason,
    delivery.hasFbp,
    delivery.hasFbc,
    delivery.hasTtclid,
    delivery.hasTtp,
    delivery.hasEmail,
    delivery.hasExternalId,
    delivery.encryptionKeyId,
    delivery.trackingMode,
    delivery.connectionRevision,
    delivery.rolloutTargetPercentage,
    delivery.rolloutEffectivePercentage,
    delivery.rolloutBucket,
    actionId,
    delivery.provider,
  )
}

async function finalizeCapiDeliveries(
  env: ConversionEnv,
  deliveries: PlannedDelivery[],
) {
  for (const delivery of deliveries) {
    if (delivery.transport !== 'server' || delivery.status !== 'pending' || !delivery.envelope) continue
    try {
      if (delivery.provider === 'meta') {
        await enqueueAdPlatformSecureDelivery(env, {
          provider: 'meta',
          queue: env.META_CAPI_QUEUE,
          deliveryId: delivery.deliveryId,
          queueLabel: 'Meta CAPI',
        })
      }
      else if (delivery.provider === 'tiktok') {
        await enqueueAdPlatformSecureDelivery(env, {
          provider: 'tiktok',
          queue: env.TIKTOK_EVENTS_QUEUE,
          deliveryId: delivery.deliveryId,
          queueLabel: 'TikTok Events',
        })
      }
    } catch {
      // Queue 是提交后的外部副作用，账本提交不得因补记失败而回滚或重试。
    }
  }
}

function shouldCreateMetaDelivery(settings: MetaDeliverySettings, input: RecordConversionInput) {
  return input.attributionProvider === 'meta'
    && input.consentState === 'granted'
    && (settings.mode === 'test' || settings.mode === 'production')
    && Boolean(settings.pixelId)
    && (settings.pixelEnabled || settings.capiEnabled)
}

function shouldCreateMetaCapiDelivery(settings: MetaDeliverySettings, input: RecordConversionInput) {
  return shouldCreateMetaDelivery(settings, input) && settings.capiEnabled
}

async function buildCapiEncryptionPlan(
  env: ConversionEnv,
  settings: MetaDeliverySettings,
  input: RecordConversionInput,
  loadSensitiveContext: () => Promise<AdPlatformSensitiveContext>,
): Promise<CapiEncryptionPlan> {
  if (!shouldCreateMetaDelivery(settings, input)) return { state: 'disabled' }
  let connection: Awaited<ReturnType<typeof requireVerifiedMetaConnection>>
  try {
    connection = await requireVerifiedMetaConnection(env)
  }
  catch {
    return { state: 'skipped', reason: 'connection_unverified', rollout: null }
  }
  if (connection.pixelId !== settings.pixelId || connection.trackingMode !== settings.mode) {
    return { state: 'skipped', reason: 'connection_unverified', rollout: null }
  }
  if (!shouldCreateMetaCapiDelivery(settings, input)) {
    return { state: 'disabled', connectionRevision: connection.revision }
  }
  if (!settings.rolloutSettingAvailable) {
    return {
      state: 'skipped',
      reason: 'rollout_excluded',
      connectionRevision: connection.revision,
      rollout: {
        targetPercentage: 0,
        effectivePercentage: 0,
        bucket: null,
        included: false,
        reason: 'rollout_excluded',
      },
    }
  }

  let rollout: MetaCapiRolloutDecision
  try {
    const stableId = await readAdPlatformStableId(env.DB, input)
    const circuitOpen = await hasOpenCriticalMetaCapiIncident(env.DB, env.APP_ENV)
    rollout = await decideMetaCapiRollout({
      targetPercentage: settings.rolloutPercentage,
      stableId,
      circuitOpen,
    })
  }
  catch {
    rollout = {
      targetPercentage: 0,
      effectivePercentage: 0,
      bucket: null,
      included: false,
      reason: 'rollout_excluded',
    }
  }
  if (!rollout.included) {
    return {
      state: 'skipped',
      reason: rollout.reason === 'included' ? 'rollout_excluded' : rollout.reason,
      connectionRevision: connection.revision,
      rollout,
    }
  }
  if (!String(env.META_CAPI_DATA_KEY_CURRENT ?? '').trim()) {
    return { state: 'skipped', reason: 'missing_data_key', connectionRevision: connection.revision, rollout }
  }

  let keys: MetaCapiCryptoKeys
  try {
    keys = await loadMetaCapiCryptoKeys(env)
  } catch {
    return { state: 'skipped', reason: 'invalid_data_key', connectionRevision: connection.revision, rollout }
  }
  let sensitiveContext: MetaCapiSensitiveContext
  try {
    sensitiveContext = contextForMeta(await loadSensitiveContext())
  }
  catch {
    return {
      state: 'skipped',
      reason: 'invalid_sensitive_context',
      connectionRevision: connection.revision,
      rollout,
    }
  }
  return {
    state: 'ready',
    keys,
    context: sensitiveContext,
    connectionRevision: connection.revision,
    rollout,
  }
}

async function buildTikTokEncryptionPlan(
  env: ConversionEnv,
  connection: Awaited<ReturnType<typeof readAdPlatformConnection>>,
  input: RecordConversionInput,
  loadSensitiveContext: () => Promise<AdPlatformSensitiveContext>,
): Promise<TikTokEncryptionPlan> {
  if (!connection
    || connection.provider !== 'tiktok'
    || input.consentState !== 'granted'
    || !connection.enabled
    || !connection.destinationId
    || connection.mode === 'disabled'
    || !connection.serverEnabled) {
    return { state: 'disabled', connectionRevision: connection?.revision ?? undefined }
  }

  let verified: Awaited<ReturnType<typeof requireVerifiedTikTokConnection>>
  try {
    verified = await requireVerifiedTikTokConnection(env)
  }
  catch {
    return { state: 'skipped', reason: 'connection_unverified', rollout: null }
  }
  if (verified.pixelId !== connection.destinationId || verified.trackingMode !== connection.mode) {
    return { state: 'skipped', reason: 'connection_unverified', rollout: null }
  }

  let rollout: AdPlatformRolloutDecision
  try {
    rollout = await decideAdPlatformRollout({
      namespace: 'tiktok-events-rollout-v1',
      targetPercentage: connection.rolloutPercentage,
      stableId: await readAdPlatformStableId(env.DB, input),
      circuitOpen: false,
    })
  }
  catch {
    rollout = {
      targetPercentage: 0,
      effectivePercentage: 0,
      bucket: null,
      included: false,
      reason: 'rollout_excluded',
    }
  }
  if (!rollout.included) {
    return {
      state: 'skipped',
      reason: rollout.reason === 'included' ? 'rollout_excluded' : rollout.reason,
      connectionRevision: verified.revision,
      rollout,
    }
  }
  if (!String(env.TIKTOK_EVENTS_DATA_KEY_CURRENT ?? '').trim()) {
    return { state: 'skipped', reason: 'missing_data_key', connectionRevision: verified.revision, rollout }
  }

  let keys: TikTokEventsCryptoKeys
  try {
    keys = await loadTikTokEventsCryptoKeys(env)
  }
  catch {
    return { state: 'skipped', reason: 'invalid_data_key', connectionRevision: verified.revision, rollout }
  }
  try {
    return {
      state: 'ready',
      keys,
      context: contextForTikTok(await loadSensitiveContext()),
      connectionRevision: verified.revision,
      rollout,
    }
  }
  catch {
    return {
      state: 'skipped',
      reason: 'invalid_sensitive_context',
      connectionRevision: verified.revision,
      rollout,
    }
  }
}

async function readAdPlatformStableId(db: D1Database, input: RecordConversionInput) {
  const visitorId = input.visitorId.trim()
  if (input.actionType === 'contact' || visitorId) return visitorId
  if (input.actionType !== 'complete_registration' || !Number.isSafeInteger(input.userId) || Number(input.userId) <= 0) {
    return ''
  }
  const row = await db.prepare(`
    SELECT conversion_external_id
    FROM users
    WHERE id = ?
    LIMIT 1
  `).bind(input.userId).first<{ conversion_external_id: string | null }>()
  return String(row?.conversion_external_id ?? '').trim()
}

async function hasOpenCriticalMetaCapiIncident(db: D1Database, environment: string) {
  if (environment !== 'dev' && environment !== 'production') return false
  const row = await db.prepare(`
    SELECT id
    FROM meta_capi_incidents
    WHERE environment = ?
      AND status = 'open'
      AND severity = 'critical'
    LIMIT 1
  `).bind(environment).first<{ id: string }>()
  return Boolean(row)
}

function normalizeSensitiveContext(value: unknown): AdPlatformSensitiveContext {
  const browser = normalizeAdPlatformUserData(value)
  if (!isPlainRecord(value)) return browser
  const emailSha256 = validSha256(value.emailSha256)
  const externalIdSha256 = validSha256(value.externalIdSha256)
  return {
    ...browser,
    ...(emailSha256 ? { emailSha256 } : {}),
    ...(externalIdSha256 ? { externalIdSha256 } : {}),
  }
}

function contextForEvent(
  eventName: PlannedDelivery['eventName'],
  context: MetaCapiSensitiveContext,
): MetaCapiSensitiveContext {
  const { fbp, fbc, clientIpAddress, clientUserAgent } = context
  const browser = {
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(clientIpAddress ? { clientIpAddress } : {}),
    ...(clientUserAgent ? { clientUserAgent } : {}),
  }
  if (eventName === 'Contact') return browser
  return {
    ...browser,
    ...(context.emailSha256 ? { emailSha256: context.emailSha256 } : {}),
    ...(context.externalIdSha256 ? { externalIdSha256: context.externalIdSha256 } : {}),
  }
}

function contextForMeta(context: AdPlatformSensitiveContext): MetaCapiSensitiveContext {
  const { fbp, fbc, clientIpAddress, clientUserAgent, emailSha256, externalIdSha256 } = context
  return compactSensitiveContext({ fbp, fbc, clientIpAddress, clientUserAgent, emailSha256, externalIdSha256 })
}

function contextForTikTok(context: AdPlatformSensitiveContext): TikTokEventsSensitiveContext {
  const { ttclid, ttp, clientIpAddress, clientUserAgent, emailSha256, externalIdSha256 } = context
  return compactSensitiveContext({ ttclid, ttp, clientIpAddress, clientUserAgent, emailSha256, externalIdSha256 })
}

function contextForTikTokEvent(
  eventName: PlannedDelivery['eventName'],
  context: TikTokEventsSensitiveContext,
): TikTokEventsSensitiveContext {
  const { ttclid, ttp, clientIpAddress, clientUserAgent } = context
  const matching = compactSensitiveContext({ ttclid, ttp, clientIpAddress, clientUserAgent })
  if (eventName === 'Contact') return matching
  return compactSensitiveContext({
    ...matching,
    emailSha256: context.emailSha256,
    externalIdSha256: context.externalIdSha256,
  })
}

function compactSensitiveContext<T extends AdPlatformSensitiveContext>(context: T): T {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => Boolean(value))) as T
}

function validSha256(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function readMetaDeliverySettings(db: D1Database) {
  const connection = await readAdPlatformConnection(db, 'meta')
  return {
    mode: connection?.mode ?? 'disabled',
    pixelEnabled: connection?.enabled === true && connection.browserEnabled,
    pixelId: connection?.destinationId ?? '',
    capiEnabled: connection?.enabled === true && connection.serverEnabled,
    rolloutPercentage: connection?.rolloutPercentage ?? 0,
    rolloutSettingAvailable: Boolean(connection),
  }
}

function deliveryDailyStatement(
  db: D1Database,
  delivery: PlannedDelivery,
  date: string,
) {
  return db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, provider, transport, event_name, status, skip_reason, delivery_count, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 1, datetime('now')
    WHERE changes() = 1
    ON CONFLICT(date, provider, transport, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(
    date,
    delivery.provider,
    delivery.transport,
    delivery.eventName,
    delivery.status,
    delivery.skipReason,
  )
}

function conversionDedupeKey(input: RecordConversionInput, occurredDate: string) {
  return buildConversionDedupeKey({
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate,
    userId: input.userId ?? undefined,
    methodType: input.methodType,
    actionTarget: input.actionTarget,
  })
}

function normalizeAttributionProvider(value: unknown): AdAttributionProvider | '' {
  return value === 'meta' || value === 'tiktok' ? value : ''
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
