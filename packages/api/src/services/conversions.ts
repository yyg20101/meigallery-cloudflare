import type { AnalyticsConsentState, AnalyticsSourceChannel, ConversionActionType } from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import {
  buildConversionDedupeKey,
  buildExternalEventId,
  metaEventForConversion,
  sanitizeConversionMetadata,
} from '../utils/conversions'

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
}

export async function recordConversionAction(
  env: Pick<Bindings, 'DB' | 'APP_ENV'>,
  input: RecordConversionInput,
): Promise<RecordConversionResult> {
  const normalizedInput = normalizeConversionInput(input)
  const occurredAt = normalizeIso(normalizedInput.occurredAt)
  const date = occurredAt.slice(0, 10)
  const dedupeKey = conversionDedupeKey(normalizedInput, date)
  const id = generateId('conv')
  const created = await insertConversion(env.DB, id, normalizedInput, occurredAt, date, dedupeKey, '')
  if (!created) {
    const existing = await findConversionByDedupeKey(env.DB, dedupeKey)
    return {
      id: existing?.id ?? id,
      actionType: normalizedInput.actionType,
      created: false,
      duplicateOf: existing?.id ?? '',
      derivedActions: [],
    }
  }

  await upsertConversionDaily(env.DB, normalizedInput, date)
  await createMetaDeliveries(env.DB, id, normalizedInput, date)

  const derivedActions: Array<{ id: string; actionType: ConversionActionType }> = []
  if (normalizedInput.actionType === 'contact') {
    const lead = await recordDerivedLead(env, normalizedInput, occurredAt, date)
    if (lead) derivedActions.push(lead)
  }

  return { id, actionType: normalizedInput.actionType, created: true, duplicateOf: '', derivedActions }
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

async function findConversionByDedupeKey(db: D1Database, dedupeKey: string) {
  return db
    .prepare('SELECT id FROM analytics_conversion_actions WHERE dedupe_key = ? LIMIT 1')
    .bind(dedupeKey)
    .first<{ id: string }>()
}

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 1) > 0
}

async function upsertConversionDaily(db: D1Database, input: RecordConversionInput, date: string) {
  await db.prepare(`
    INSERT INTO analytics_conversion_daily (
      date, action_type, source_channel, source_name, utm_campaign, utm_content,
      action_count, unique_session_count, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))
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
  ).run()
}

async function createMetaDeliveries(
  db: D1Database,
  conversionActionId: string,
  input: RecordConversionInput,
  date: string,
) {
  if (input.consentState === 'denied') return

  const metaEventName = metaEventForConversion(input.actionType)
  if (!metaEventName) return

  const externalEventId = buildExternalEventId({
    actionType: input.actionType,
    sessionId: input.sessionId || '',
    visitorId: input.visitorId || '',
    occurredDate: date,
    methodType: input.methodType,
    actionTarget: input.actionTarget,
    metaEventName,
  })

  for (const channel of ['meta_pixel', 'meta_capi'] as const) {
    await db.prepare(`
      INSERT OR IGNORE INTO analytics_conversion_deliveries (
        id, conversion_action_id, channel, external_event_id, event_name,
        status, skip_reason, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', '', datetime('now'))
    `).bind(
      generateId('cdlv'),
      conversionActionId,
      channel,
      externalEventId,
      metaEventName,
    ).run()
  }
}

async function recordDerivedLead(
  env: Pick<Bindings, 'DB' | 'APP_ENV'>,
  input: RecordConversionInput,
  occurredAt: string,
  date: string,
) {
  const existingLead = await env.DB
    .prepare("SELECT id FROM analytics_conversion_actions WHERE session_id = ? AND action_type = 'lead' LIMIT 1")
    .bind(input.sessionId || '')
    .first<{ id: string }>()
  if (existingLead) return null

  const leadInput: RecordConversionInput = {
    ...input,
    actionType: 'lead',
    occurredAt,
  }
  const dedupeKey = conversionDedupeKey(leadInput, date)
  const id = generateId('conv')
  const created = await insertConversion(env.DB, id, leadInput, occurredAt, date, dedupeKey, '')
  if (!created) return null

  await upsertConversionDaily(env.DB, leadInput, date)
  await createMetaDeliveries(env.DB, id, leadInput, date)
  return { id, actionType: 'lead' as const }
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
