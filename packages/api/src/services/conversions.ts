import type { ActiveConversionActionType, AnalyticsConsentState, AnalyticsSourceChannel, MetaCapiUserData, MetaPixelInstruction, MetaTrackingMode } from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import { parseStoredSettingValue } from '../utils/stored-setting-value'
import { normalizeMetaTrackingMode } from '@meigallery/shared/utils'
import {
  buildConversionDedupeKey,
  buildExternalEventId,
  metaEventForConversion,
  sanitizeConversionMetadata,
} from '../utils/conversions'
import { createPixelReceiptToken, type PixelReceiptClaims } from '../utils/pixel-receipt'
import { normalizeMetaCapiUserData } from '../utils/meta-browser-identifiers'
import { transitionDeliveryStatus } from './meta-capi'
import { enqueueMetaCapiDelivery } from './meta-capi-queue'

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
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

export interface RecordConversionResult {
  id: string
  actionType: ActiveConversionActionType
  created: boolean
  duplicateOf: string
  pixelEvents: MetaPixelInstruction[]
}

type RecordActiveConversionInput = Omit<RecordConversionInput, 'actionType'>

export type RecordContactInput = Omit<RecordActiveConversionInput, 'methodType' | 'actionTarget'> & {
  methodType: string
  actionTarget: string
}

export type RecordRegistrationInput = Omit<RecordActiveConversionInput, 'userId'> & {
  userId: number
}

export interface RecordConversionContext {
  getMetaCapiUserData: () => MetaCapiUserData
}

export interface MarkPixelAttemptedResult {
  deliveryId: string
  attempted: boolean
}

type PlannedDelivery = {
  deliveryId: string
  channel: 'meta_pixel' | 'meta_capi'
  eventName: NonNullable<ReturnType<typeof metaEventForConversion>>
  eventId: string
  pixelInstruction?: MetaPixelInstruction
  userData: MetaCapiUserData
  hasFbp: 0 | 1
  hasFbc: 0 | 1
  trackingMode: MetaTrackingMode
  statementIndex: number
}

type MetaDeliverySettings = Awaited<ReturnType<typeof readMetaDeliverySettings>>

export async function recordContact(
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
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
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  input: RecordRegistrationInput,
  context?: RecordConversionContext,
) {
  return recordActiveConversion(env, { ...input, actionType: 'complete_registration' }, context)
}

async function recordActiveConversion(
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  input: RecordConversionInput,
  context: RecordConversionContext = { getMetaCapiUserData: () => ({}) },
): Promise<RecordConversionResult> {
  const normalizedInput = normalizeConversionInput(input)
  const occurredAt = normalizeIso(normalizedInput.occurredAt)
  const date = occurredAt.slice(0, 10)
  const dedupeKey = conversionDedupeKey(normalizedInput, date)
  const existing = await findConversionByDedupeKey(env.DB, dedupeKey)
  if (existing) return recordDuplicateResult(env.DB, normalizedInput, occurredAt, date, dedupeKey, existing.id)

  const id = generateId('conv')
  const plan = await buildConversionBatchPlan(env, id, normalizedInput, occurredAt, date, dedupeKey, context)
  const results = await env.DB.batch(plan.statements)
  if (!d1Changed(results[plan.actionStatementIndex]!)) {
    const concurrent = await findConversionByDedupeKey(env.DB, dedupeKey)
    if (concurrent) return recordDuplicateResult(env.DB, normalizedInput, occurredAt, date, dedupeKey, concurrent.id)
    throw new Error('转化写入未确认')
  }

  const committedDeliveries = plan.deliveries.filter(delivery => d1Changed(results[delivery.statementIndex]!))
  const pixelEvents = committedDeliveries.flatMap(delivery => delivery.pixelInstruction ? [delivery.pixelInstruction] : [])
  await finalizeCapiDeliveries(env, committedDeliveries)

  return { id, actionType: normalizedInput.actionType, created: true, duplicateOf: '', pixelEvents }
}

export async function markPixelAttempted(
  db: D1Database,
  claims: PixelReceiptClaims,
): Promise<MarkPixelAttemptedResult> {
  const delivery = await db.prepare(`
    SELECT d.id, d.channel, d.external_event_id, d.status, d.event_name, a.date
    FROM analytics_conversion_deliveries d
    JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
    WHERE d.id = ?
    LIMIT 1
  `).bind(claims.deliveryId).first<{
    id: string
    channel: string
    external_event_id: string
    status: string
    event_name: string
    date: string
  }>()

  if (!delivery || delivery.channel !== 'meta_pixel' || delivery.external_event_id !== claims.eventId) {
    throw new Error('Pixel 回执无效')
  }
  if (delivery.status === 'attempted') return { deliveryId: delivery.id, attempted: false }
  if (delivery.status !== 'pending') throw new Error('Pixel 回执无效')

  const transition = await transitionDeliveryStatus(db, {
    id: delivery.id,
    channel: delivery.channel,
    event_name: delivery.event_name,
    status: 'pending',
    skip_reason: '',
    date: delivery.date,
  }, { status: 'attempted' })
  if (!transition.changed) {
    const current = await db.prepare(`
      SELECT channel, external_event_id, status
      FROM analytics_conversion_deliveries
      WHERE id = ?
      LIMIT 1
    `).bind(delivery.id).first<{ channel: string; external_event_id: string; status: string }>()
    if (current?.channel === 'meta_pixel' && current.external_event_id === claims.eventId && current.status === 'attempted') {
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
      metadata, duplicate_of
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    pixelEvents: [],
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

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 1) > 0
}

function conversionDailyStatement(db: D1Database, input: RecordConversionInput, date: string, actionId: string) {
  return db.prepare(`
    INSERT INTO analytics_conversion_daily (
      date, action_type, source_channel, source_name, utm_campaign, utm_content,
      action_count, unique_session_count, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 1, 1, datetime('now')
    WHERE EXISTS (SELECT 1 FROM analytics_conversion_actions WHERE id = ?)
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
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  actionId: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
  context: RecordConversionContext,
) {
  const statements: D1PreparedStatement[] = []
  const deliveries: PlannedDelivery[] = []
  const settings = await readMetaDeliverySettings(env.DB)
  const metaCapiUserData = shouldCreateMetaCapiDelivery(settings, input)
    ? normalizeMetaCapiUserData(context.getMetaCapiUserData())
    : {}
  const actionStatementIndex = statements.push(conversionActionStatement(env.DB, actionId, input, occurredAt, date, dedupeKey)) - 1
  statements.push(conversionDailyStatement(env.DB, input, date, actionId))
  deliveries.push(...await planMetaDeliveries(env, settings, input, date, metaCapiUserData))
  for (const delivery of deliveries) {
    delivery.statementIndex = statements.push(conversionDeliveryStatement(env.DB, delivery, actionId)) - 1
    statements.push(pendingDeliveryDailyStatement(env.DB, delivery, date))
  }

  return { statements, actionStatementIndex, deliveries }
}

function conversionActionStatement(
  db: D1Database,
  id: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
) {
  const values = [
    id, input.actionType, dedupeKey, occurredAt, date, input.visitorId || '', input.sessionId || '', input.userId ?? null,
    input.sourceChannel || 'unknown', input.sourceName || '', input.trackingSourceSlug || '', input.utmSource || '',
    input.utmMedium || '', input.utmCampaign || '', input.utmContent || '', input.methodType || '', input.actionTarget || '',
    input.routeName || '', input.path || '', JSON.stringify(sanitizeConversionMetadata(input.metadata || {})), '',
  ]
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
      source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
      utm_campaign, utm_content, method_type, action_target, route_name, path,
      metadata, duplicate_of
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...values)
}

async function planMetaDeliveries(
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  settings: MetaDeliverySettings,
  input: RecordConversionInput,
  date: string,
  metaCapiUserData: MetaCapiUserData,
): Promise<PlannedDelivery[]> {
  if (input.consentState !== 'granted' || settings.mode === 'disabled' || !settings.pixelId) return []
  const eventName = metaEventForConversion(input.actionType)
  if (!eventName) return []
  const eventId = buildExternalEventId({
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate: date,
    userId: input.userId ?? undefined,
    methodType: input.methodType,
    actionTarget: input.actionTarget,
    metaEventName: eventName,
  })
  const channels = [
    ...(settings.pixelEnabled ? ['meta_pixel' as const] : []),
    ...(settings.capiEnabled ? ['meta_capi' as const] : []),
  ]
  return Promise.all(channels.map(async channel => {
    const deliveryId = generateId('cdlv')
    const pixelInstruction = channel === 'meta_pixel'
      ? {
          deliveryId,
          eventName,
          eventId,
          payload: sanitizeConversionMetadata(input.metadata || {}),
          receiptToken: await createPixelReceiptToken(env.SESSION_SECRET, {
            deliveryId,
            eventId,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          }),
        }
      : undefined
    const capiUserData = channel === 'meta_capi' ? metaCapiUserData : {}
    return {
      deliveryId,
      channel,
      eventName,
      eventId,
      pixelInstruction,
      userData: capiUserData,
      hasFbp: capiUserData.fbp ? 1 : 0,
      hasFbc: capiUserData.fbc ? 1 : 0,
      trackingMode: settings.mode,
      statementIndex: -1,
    }
  }))
}

function conversionDeliveryStatement(db: D1Database, delivery: PlannedDelivery, actionId: string) {
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_deliveries (
      id, conversion_action_id, channel, external_event_id, event_name,
      status, skip_reason, has_fbp, has_fbc, tracking_mode, updated_at
    )
    SELECT ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, datetime('now')
    WHERE EXISTS (SELECT 1 FROM analytics_conversion_actions WHERE id = ?)
  `).bind(
    delivery.deliveryId,
    actionId,
    delivery.channel,
    delivery.eventId,
    delivery.eventName,
    delivery.hasFbp,
    delivery.hasFbc,
    delivery.trackingMode,
    actionId,
  )
}

async function finalizeCapiDeliveries(
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  deliveries: PlannedDelivery[],
) {
  for (const delivery of deliveries) {
    if (delivery.channel !== 'meta_capi') continue
    try {
      await enqueueMetaCapiDelivery(env, delivery.deliveryId, metaCapiQueueUserData(delivery))
    } catch {
      // Queue 是提交后的外部副作用，账本提交不得因补记失败而回滚或重试。
    }
  }
}

function shouldCreateMetaCapiDelivery(settings: MetaDeliverySettings, input: RecordConversionInput) {
  return input.consentState === 'granted'
    && (settings.mode === 'test' || settings.mode === 'production')
    && Boolean(settings.pixelId)
    && settings.capiEnabled
    && Boolean(metaEventForConversion(input.actionType))
}

function metaCapiQueueUserData(delivery: PlannedDelivery): MetaCapiUserData {
  const { fbp, fbc, clientIpAddress, clientUserAgent } = delivery.userData
  return {
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(clientIpAddress ? { clientIpAddress } : {}),
    ...(clientUserAgent ? { clientUserAgent } : {}),
  }
}

async function readMetaDeliverySettings(db: D1Database) {
  const [modeRow, pixelEnabledRow, pixelIdRow, capiEnabledRow] = await Promise.all([
    db.prepare("SELECT value FROM site_settings WHERE key = 'meta_tracking_mode' LIMIT 1").first<{ value: string }>(),
    db.prepare("SELECT value FROM site_settings WHERE key = 'facebook_pixel_enabled' LIMIT 1").first<{ value: string }>(),
    db.prepare("SELECT value FROM site_settings WHERE key = 'facebook_pixel_id' LIMIT 1").first<{ value: string }>(),
    db.prepare("SELECT value FROM site_settings WHERE key = 'meta_capi_enabled' LIMIT 1").first<{ value: string }>(),
  ])
  const pixelId = String(parseStoredSettingValue(pixelIdRow?.value || '""', '') || '').trim()
  return {
    mode: normalizeMetaTrackingMode(parseStoredSettingValue(modeRow?.value || '"disabled"', 'disabled')),
    pixelEnabled: parseStoredSettingValue(pixelEnabledRow?.value || 'false', false) === true,
    pixelId: /^\d{5,30}$/.test(pixelId) ? pixelId : '',
    capiEnabled: parseStoredSettingValue(capiEnabledRow?.value || 'false', false) === true,
  }
}

function pendingDeliveryDailyStatement(
  db: D1Database,
  delivery: PlannedDelivery,
  date: string,
) {
  return db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, channel, event_name, status, skip_reason, delivery_count, updated_at
    )
    SELECT ?, ?, ?, 'pending', '', 1, datetime('now')
    WHERE changes() = 1
    ON CONFLICT(date, channel, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(date, delivery.channel, delivery.eventName)
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

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
