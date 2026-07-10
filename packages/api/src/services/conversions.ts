import type { AnalyticsConsentState, AnalyticsSourceChannel, ConversionActionType, MetaPixelInstruction } from '@meigallery/shared'
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
import { createPixelReceiptToken } from '../utils/pixel-receipt'

export interface RecordConversionInput {
  actionType: ConversionActionType
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
  actionType: ConversionActionType
  created: boolean
  duplicateOf: string
  derivedActions: Array<{ id: string; actionType: ConversionActionType }>
  pixelEvents: MetaPixelInstruction[]
}

type PlannedDelivery = {
  deliveryId: string
  channel: 'meta_pixel' | 'meta_capi'
  eventName: NonNullable<ReturnType<typeof metaEventForConversion>>
  eventId: string
  pixelInstruction?: MetaPixelInstruction
  statementIndex: number
}

type MetaDeliverySettings = Awaited<ReturnType<typeof readMetaDeliverySettings>>

export async function recordConversionAction(
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  input: RecordConversionInput,
): Promise<RecordConversionResult> {
  const normalizedInput = normalizeConversionInput(input)
  const occurredAt = normalizeIso(normalizedInput.occurredAt)
  const date = occurredAt.slice(0, 10)
  const dedupeKey = conversionDedupeKey(normalizedInput, date)
  const existing = await findConversionByDedupeKey(env.DB, dedupeKey)
  if (existing) return recordDuplicateResult(env.DB, normalizedInput, occurredAt, date, dedupeKey, existing.id)

  const id = generateId('conv')
  const plan = await buildConversionBatchPlan(env, id, normalizedInput, occurredAt, date, dedupeKey)
  const results = await env.DB.batch(plan.statements)
  if (!d1Changed(results[plan.actionStatementIndex]!)) {
    const concurrent = await findConversionByDedupeKey(env.DB, dedupeKey)
    if (concurrent) return recordDuplicateResult(env.DB, normalizedInput, occurredAt, date, dedupeKey, concurrent.id)
    throw new Error('转化写入未确认')
  }

  const committedDeliveries = plan.deliveries.filter(delivery => d1Changed(results[delivery.statementIndex]!))
  const pixelEvents = committedDeliveries.flatMap(delivery => delivery.pixelInstruction ? [delivery.pixelInstruction] : [])
  const derivedActions = plan.leadAction && plan.leadAction.statementIndex !== undefined && d1Changed(results[plan.leadAction.statementIndex]!)
    ? [{ id: plan.leadAction.id, actionType: 'lead' as const }]
    : []
  await finalizeCapiDeliveries(env, committedDeliveries, date)

  return { id, actionType: normalizedInput.actionType, created: true, duplicateOf: '', derivedActions, pixelEvents }
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
    derivedActions: [],
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
) {
  const statements: D1PreparedStatement[] = []
  const deliveries: PlannedDelivery[] = []
  const settings = await readMetaDeliverySettings(env.DB)
  const actionStatementIndex = statements.push(conversionActionStatement(env.DB, actionId, input, occurredAt, date, dedupeKey)) - 1
  statements.push(conversionDailyStatement(env.DB, input, date, actionId))
  deliveries.push(...await planMetaDeliveries(env, settings, input, date))
  for (const delivery of deliveries) {
    delivery.statementIndex = statements.push(conversionDeliveryStatement(env.DB, delivery, actionId)) - 1
  }

  let leadAction: { id: string; statementIndex?: number } | undefined
  if (input.actionType === 'contact') {
    const leadInput: RecordConversionInput = { ...input, actionType: 'lead', occurredAt }
    const leadId = generateId('conv')
    const leadDedupeKey = conversionDedupeKey(leadInput, date)
    leadAction = { id: leadId }
    leadAction.statementIndex = statements.push(conversionActionStatement(
      env.DB, leadId, leadInput, occurredAt, date, leadDedupeKey, actionId,
    )) - 1
    statements.push(conversionDailyStatement(env.DB, leadInput, date, leadId))
    const leadDeliveries = await planMetaDeliveries(env, settings, leadInput, date)
    for (const delivery of leadDeliveries) {
      delivery.statementIndex = statements.push(conversionDeliveryStatement(env.DB, delivery, leadId)) - 1
      deliveries.push(delivery)
    }
  }
  return { statements, actionStatementIndex, deliveries, leadAction }
}

function conversionActionStatement(
  db: D1Database,
  id: string,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
  dedupeKey: string,
  requiredActionId?: string,
) {
  const values = [
    id, input.actionType, dedupeKey, occurredAt, date, input.visitorId || '', input.sessionId || '', input.userId ?? null,
    input.sourceChannel || 'unknown', input.sourceName || '', input.trackingSourceSlug || '', input.utmSource || '',
    input.utmMedium || '', input.utmCampaign || '', input.utmContent || '', input.methodType || '', input.actionTarget || '',
    input.routeName || '', input.path || '', JSON.stringify(sanitizeConversionMetadata(input.metadata || {})), '',
  ]
  const condition = requiredActionId ? 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM analytics_conversion_actions WHERE id = ?)' : 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
      source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
      utm_campaign, utm_content, method_type, action_target, route_name, path,
      metadata, duplicate_of
    )
    ${condition}
  `).bind(...values, ...(requiredActionId ? [requiredActionId] : []))
}

async function planMetaDeliveries(
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  settings: MetaDeliverySettings,
  input: RecordConversionInput,
  date: string,
): Promise<PlannedDelivery[]> {
  if (input.consentState !== 'granted' || settings.mode === 'disabled' || !settings.pixelId) return []
  const eventName = metaEventForConversion(input.actionType)
  if (!eventName) return []
  const eventId = buildExternalEventId({
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate: date,
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
    return { deliveryId, channel, eventName, eventId, pixelInstruction, statementIndex: -1 }
  }))
}

function conversionDeliveryStatement(db: D1Database, delivery: PlannedDelivery, actionId: string) {
  return db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_deliveries (
      id, conversion_action_id, channel, external_event_id, event_name,
      status, skip_reason, updated_at
    )
    SELECT ?, ?, ?, ?, ?, 'pending', '', datetime('now')
    WHERE EXISTS (SELECT 1 FROM analytics_conversion_actions WHERE id = ?)
  `).bind(delivery.deliveryId, actionId, delivery.channel, delivery.eventId, delivery.eventName, actionId)
}

async function finalizeCapiDeliveries(
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>,
  deliveries: PlannedDelivery[],
  date: string,
) {
  for (const delivery of deliveries) {
    if (delivery.channel !== 'meta_capi') continue
    try {
      if (!env.META_CAPI_QUEUE) {
        await markDeliveryTerminal(env.DB, delivery.deliveryId, date, 'meta_capi', delivery.eventName, 'skipped', 'missing_queue')
        continue
      }
      await env.META_CAPI_QUEUE.send({ schemaVersion: 1, deliveryId: delivery.deliveryId, userData: {} })
    } catch (error) {
      try {
        await markDeliveryTerminal(
          env.DB,
          delivery.deliveryId,
          date,
          'meta_capi',
          delivery.eventName,
          'failed',
          '',
          'queue_send_failed',
          error instanceof Error ? error.message : 'Queue 发送失败',
        )
      } catch {
        // Queue 是提交后的外部副作用，账本提交不得因补记失败而回滚或重试。
      }
    }
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

async function markDeliveryTerminal(
  db: D1Database,
  deliveryId: string,
  date: string,
  channel: 'meta_capi',
  eventName: string,
  status: 'failed' | 'skipped',
  skipReason = '',
  errorCode = '',
  errorMessage = '',
) {
  await db.prepare(`
    UPDATE analytics_conversion_deliveries
    SET
      status = ?,
      skip_reason = ?,
      error_code = ?,
      error_message = ?,
      attempt_count = attempt_count + 1,
      last_attempt_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(status, skipReason, errorCode, normalizeText(errorMessage, 500), deliveryId).run()
  await upsertDeliveryDaily(db, date, channel, eventName, status, skipReason)
}

async function upsertDeliveryDaily(
  db: D1Database,
  date: string,
  channel: 'meta_capi',
  eventName: string,
  status: 'failed' | 'skipped',
  skipReason: string,
) {
  await db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, channel, event_name, status, skip_reason, delivery_count, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(date, channel, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(date, channel, eventName, status, skipReason).run()
}

function conversionDedupeKey(input: RecordConversionInput, occurredDate: string) {
  return buildConversionDedupeKey({
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate,
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
