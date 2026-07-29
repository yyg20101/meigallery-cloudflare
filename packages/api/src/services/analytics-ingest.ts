import type {
  AnalyticsBatchResponse,
  AnalyticsDeviceType,
  AnalyticsEntityType,
  AnalyticsEventName,
  AnalyticsPropValue,
  AnalyticsSourceChannel,
} from '@meigallery/shared'
import { ANALYTICS_LIMITS } from '@meigallery/shared/constants'
import { normalizeAnalyticsCampaignToken } from '@meigallery/shared/utils'
import type { Bindings } from '../index'
import {
  isAnalyticsEntityType,
  isAnalyticsEventName,
  isAnalyticsSourceChannel,
  sanitizeAnalyticsProps,
  truncateAnalyticsString,
} from '../utils/analytics-events'
import { mergeD1Usage, readD1UsageMeta, type D1Usage } from '../utils/analytics-cost'
import { safeAnalyticsSampleRate } from '../utils/analytics-settings'
import { clampActiveSeconds, toOperationDateShanghai } from '../utils/analytics-time'
import { deriveSourceAttribution, sanitizeAnalyticsPath, sanitizeReferrer } from '../utils/analytics-url'
import { normalizeBooleanSetting } from '../utils/setting-normalization'
import { parseStoredSettingValue } from '../utils/stored-setting-value'

type AnalyticsDb = Pick<D1Database, 'prepare'>

export interface AnalyticsIngestContext {
  body: unknown
  bodySizeBytes: number
  userId: number | null
  now?: Date
  currentHost?: string | null
  country?: string | null
  appEnv?: string | null
}

interface AnalyticsSettings {
  enabled: boolean
  sampleRate: number
}

interface NormalizedAnalyticsBatch {
  visitorId: string
  sessionId: string
  events: Array<Record<string, unknown>>
}

interface NormalizedAnalyticsEvent {
  eventId: string
  eventName: AnalyticsEventName
  occurredAt: string
  date: string
  routeName: string
  path: string
  pageTitle: string
  referrerHost: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  trackingSourceSlug: string
  sourceChannel: AnalyticsSourceChannel
  sourceName: string
  deviceType: AnalyticsDeviceType
  entityType: AnalyticsEntityType
  entityId: string
  props: Record<string, AnalyticsPropValue>
  value: number | null
  activeSeconds: number
  maxScrollDepth: number
  isBounce: boolean
  isEntry: boolean
  dedupeKey: string
  sampled: boolean
}

interface AcceptedAnalyticsEvent {
  event: NormalizedAnalyticsEvent
  storedRaw: boolean
}

export class AnalyticsIngestError extends Error {
  constructor(
    public status: 400 | 413 | 415,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message)
  }
}

const ANALYTICS_SETTING_KEYS = ['analytics_enabled', 'analytics_sample_rate'] as const

const EVENT_ID_RE = /^[A-Za-z0-9:_-]{8,140}$/
const VISITOR_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,120}$/
const CLICK_EVENTS = new Set<AnalyticsEventName>([
  'home_ad_click',
  'outbound_link_click',
  'gallery_card_click',
  'filter_selected',
  'filter_removed',
  'sort_changed',
  'load_more',
  'contact_qr_expand',
  'rules_page_click',
  'membership_cta_click',
])
const CRITICAL_RAW_EVENTS = new Set<AnalyticsEventName>([
  'invite_landed',
  'invite_code_checked',
  'register_submit',
  'register_failed',
  'membership_granted_conversion',
  'media_access_granted',
  'media_access_denied',
  'login_success',
  'login_failed',
])

export async function ingestAnalyticsBatch(
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET'>,
  context: AnalyticsIngestContext,
): Promise<AnalyticsBatchResponse & { usage: D1Usage }> {
  if (context.bodySizeBytes > ANALYTICS_LIMITS.BATCH_BODY_LIMIT_BYTES) {
    throw new AnalyticsIngestError(413, 'ANALYTICS_PAYLOAD_TOO_LARGE', '分析上报内容不能超过 16KB')
  }

  const settings = await readAnalyticsSettings(env.DB)
  if (!settings.enabled) {
    return { accepted: 0, rejected: 0, duplicate: 0, disabled: true, usage: emptyUsage() }
  }

  const batch = normalizeAnalyticsBatch(context.body)
  const response: AnalyticsBatchResponse & { usage: D1Usage } = {
    accepted: 0,
    rejected: 0,
    duplicate: 0,
    errors: [],
    usage: emptyUsage(),
  }
  const candidates: AcceptedAnalyticsEvent[] = []

  for (const rawEvent of batch.events) {
    try {
      const event = normalizeAnalyticsEvent(rawEvent, batch, context)
      const storedRaw = shouldStoreRawEvent(event.eventName, event.eventId, settings.sampleRate)
      event.sampled = storedRaw && !CRITICAL_RAW_EVENTS.has(event.eventName)
      candidates.push({ event, storedRaw })
    } catch (error) {
      response.rejected += 1
      const normalized = normalizeEventError(error, readOptionalString(rawEvent, 'eventId', 'event_id'))
      response.errors?.push(normalized)
    }
  }

  const acceptedEvents = await reserveStoredEvents(env.DB, batch, candidates, context, response)
  const sampledCount = acceptedEvents.filter(item => item.event.sampled).length
  response.accepted = acceptedEvents.length

  if (acceptedEvents.length > 0) {
    await persistAcceptedEvents(env.DB, batch, acceptedEvents, context, response)
  }

  await writeIngestHealth(env.DB, {
    date: toOperationDateShanghai(context.now ?? new Date()),
    accepted: response.accepted,
    rejected: response.rejected,
    duplicate: response.duplicate,
    sensitiveBlocked: response.errors?.filter(error => error.code === 'ANALYTICS_URL_SENSITIVE').length ?? 0,
    sampled: sampledCount,
    dropped: 0,
    maxDurationMs: 0,
    usage: response.usage,
  }, response)

  if (response.errors?.length === 0) delete response.errors
  return response
}

export async function recordTrustedAnalyticsEvent(
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET'>,
  input: {
    eventName: AnalyticsEventName
    userId: number | null
    routeName: string
    path: string
    entityType: AnalyticsEntityType
    entityId: string
    props?: Record<string, AnalyticsPropValue>
    visitorId?: string | null
    sessionId?: string | null
    now?: Date
    country?: string | null
  },
) {
  const now = input.now ?? new Date()
  const visitorId = normalizeTrustedExternalId(input.visitorId) || `visitor_user_${input.userId ?? 'anonymous'}`
  const sessionId = normalizeTrustedExternalId(input.sessionId) || `session_server_${input.userId ?? 'anonymous'}_${toOperationDateShanghai(now).replace(/-/g, '')}`
  const eventId = `server_${input.eventName}_${simpleHash(`${input.entityId}:${now.getTime()}:${Math.random()}`)}`

  return ingestAnalyticsBatch(env, {
    body: {
      visitorId,
      sessionId,
      events: [
        {
          eventId,
          eventName: input.eventName,
          occurredAt: now.toISOString(),
          routeName: input.routeName,
          path: input.path,
          entityType: input.entityType,
          entityId: input.entityId,
          props: input.props ?? {},
        },
      ],
    },
    bodySizeBytes: 1024,
    userId: input.userId,
    now,
    country: input.country,
    appEnv: env.APP_ENV,
  })
}

export function normalizeSessionEndPayload(body: unknown, now = new Date()): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const record = body as Record<string, unknown>
  if (Array.isArray(record.events)) return body

  const visitorId = readOptionalString(record, 'visitorId', 'visitor_id')
  const sessionId = readOptionalString(record, 'sessionId', 'session_id')
  if (!visitorId || !sessionId) return body

  const occurredAt = readOptionalString(record, 'occurredAt', 'occurred_at') || now.toISOString()
  const eventId = readOptionalString(record, 'eventId', 'event_id') || `session_end_${sessionId}_${Date.parse(occurredAt) || now.getTime()}`
  const activeSeconds = readOptionalNumber(record, 'activeSeconds', 'active_seconds')
  const pageViewCount = readOptionalNumber(record, 'pageViewCount', 'page_view_count')
  return {
    visitorId,
    sessionId,
    events: [
      {
        eventId,
        eventName: 'session_end',
        occurredAt,
        routeName: readOptionalString(record, 'routeName', 'route_name') || 'session',
        path: readOptionalString(record, 'path') || '/',
        props: {
          active_seconds: activeSeconds ?? 0,
          page_view_count: pageViewCount ?? 0,
        },
      },
    ],
  }
}

export function shouldSampleAnalyticsEvent(eventId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false
  if (sampleRate >= 1) return true
  return hashToUnitInterval(eventId) < sampleRate
}

async function readAnalyticsSettings(db: AnalyticsDb): Promise<AnalyticsSettings> {
  const placeholders = ANALYTICS_SETTING_KEYS.map(() => '?').join(',')
  const result = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...ANALYTICS_SETTING_KEYS)
    .all<{ key: string; value: string }>()

  const values = new Map(result.results.map(row => [row.key, parseStoredSettingValue(row.value)]))
  return {
    enabled: normalizeBooleanSetting(values.get('analytics_enabled')),
    sampleRate: safeAnalyticsSampleRate(values.get('analytics_sample_rate')),
  }
}

function normalizeAnalyticsBatch(body: unknown): NormalizedAnalyticsBatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_BODY_INVALID', '分析上报内容必须是 JSON 对象')
  }

  const record = body as Record<string, unknown>
  const visitorId = normalizeExternalId(readRequiredString(record, 'visitorId', 'visitor_id'), 'visitorId')
  const sessionId = normalizeExternalId(readRequiredString(record, 'sessionId', 'session_id'), 'sessionId')
  const rawEvents = record.events
  if (!Array.isArray(rawEvents)) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_EVENTS_INVALID', 'events 必须是数组')
  }
  if (rawEvents.length === 0) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_EVENTS_EMPTY', 'events 不能为空')
  }
  if (rawEvents.length > ANALYTICS_LIMITS.BATCH_EVENT_LIMIT) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_EVENTS_TOO_MANY', '单次最多上报 20 个分析事件')
  }

  return {
    visitorId,
    sessionId,
    events: rawEvents.map((event) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new AnalyticsIngestError(400, 'ANALYTICS_EVENT_INVALID', '事件必须是对象')
      }
      return event as Record<string, unknown>
    }),
  }
}

function normalizeAnalyticsEvent(
  raw: Record<string, unknown>,
  batch: NormalizedAnalyticsBatch,
  context: AnalyticsIngestContext,
): NormalizedAnalyticsEvent {
  const eventId = normalizeEventId(readRequiredString(raw, 'eventId', 'event_id'))
  const eventNameValue = readRequiredString(raw, 'eventName', 'event_name')
  if (!isAnalyticsEventName(eventNameValue)) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_EVENT_NAME_INVALID', '分析事件名不在白名单中')
  }

  const occurredAt = normalizeOccurredAt(readRequiredString(raw, 'occurredAt', 'occurred_at'))
  const path = sanitizeAnalyticsPath(readRequiredString(raw, 'path'))
  if (!path) throw new AnalyticsIngestError(400, 'ANALYTICS_URL_SENSITIVE', '分析路径包含敏感或不允许的 URL')

  const currentHost = context.currentHost || null
  const referrer = sanitizeReferrer(readOptionalString(raw, 'referrer'), currentHost)
  const referrerHost = readOptionalString(raw, 'referrerHost', 'referrer_host') || referrer?.host || ''
  const sourceFromPayload = readOptionalString(raw, 'sourceChannel', 'source_channel')
  const props = sanitizeAnalyticsProps(eventNameValue, raw.props)
  const inviteCodeId = stringProp(props.invite_code_id)
  const trackingSourceSlug = readOptionalString(raw, 'trackingSourceSlug', 'tracking_source_slug') || stringProp(props.tracking_source_slug)
  const utmSource = readOptionalString(raw, 'utmSource', 'utm_source') || stringProp(props.utm_source)
  const utmMedium = readOptionalString(raw, 'utmMedium', 'utm_medium') || stringProp(props.utm_medium)
  const utmCampaign = readOptionalString(raw, 'utmCampaign', 'utm_campaign') || stringProp(props.utm_campaign)
  const utmContent = readOptionalString(raw, 'utmContent', 'utm_content') || stringProp(props.utm_content)
  const sourceNameFromProps = stringProp(props.source_name)
  const derivedSource = deriveSourceAttribution({
    inviteCodeId,
    trackingSourceSlug,
    utmSource,
    utmMedium,
    adId: stringProp(props.ad_id),
    referrerHost,
    currentHost,
  })

  const sourceChannel = isAnalyticsSourceChannel(sourceFromPayload) ? sourceFromPayload : derivedSource.channel
  const deviceTypeValue = readOptionalString(raw, 'deviceType', 'device_type')
  const deviceType = normalizeDeviceType(deviceTypeValue)
  const entityTypeValue = readOptionalString(raw, 'entityType', 'entity_type')
  const entityType = isAnalyticsEntityType(entityTypeValue) ? entityTypeValue : defaultEntityType(eventNameValue)
  const value = normalizeOptionalFiniteNumber(raw.value)
  const activeSeconds = readActiveSeconds(eventNameValue, props, value)
  const maxScrollDepth = readScrollDepth(props, value)

  return {
    eventId,
    eventName: eventNameValue,
    occurredAt,
    date: toOperationDateShanghai(occurredAt),
    routeName: truncateAnalyticsString(readRequiredString(raw, 'routeName', 'route_name'), 120),
    path,
    pageTitle: truncateAnalyticsString(readOptionalString(raw, 'pageTitle', 'page_title') || '', 120),
    referrerHost: truncateAnalyticsString(referrerHost, 120),
    utmSource: truncateAnalyticsString(utmSource, 120),
    utmMedium: truncateAnalyticsString(utmMedium, 120),
    utmCampaign: truncateAnalyticsString(utmCampaign, 120),
    utmContent: normalizeAnalyticsCampaignToken(utmContent),
    trackingSourceSlug: truncateAnalyticsString(trackingSourceSlug, 120),
    sourceChannel,
    sourceName: truncateAnalyticsString(sourceNameFromProps || derivedSource.name, 120),
    deviceType,
    entityType,
    entityId: truncateAnalyticsString(readOptionalString(raw, 'entityId', 'entity_id') || '', 120),
    props,
    value,
    activeSeconds,
    maxScrollDepth,
    isBounce: props.is_bounce === true,
    isEntry: props.is_landing === true,
    dedupeKey: truncateAnalyticsString(readOptionalString(raw, 'dedupeKey', 'dedupe_key') || '', 160),
    sampled: false,
  }
}

async function persistAcceptedEvents(
  db: AnalyticsDb,
  batch: NormalizedAnalyticsBatch,
  accepted: AcceptedAnalyticsEvent[],
  context: AnalyticsIngestContext,
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const events = accepted.map(item => item.event)
  const first = events[0]
  const last = events[events.length - 1]
  if (!first || !last) return

  await runAndTrack(db, response, `
    INSERT INTO analytics_visitors (
      id, first_seen_at, last_seen_at, first_source_channel, first_source_name,
      first_landing_path, first_invite_code_id, user_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      user_id = COALESCE(excluded.user_id, analytics_visitors.user_id),
      updated_at = datetime('now')
  `, [
    batch.visitorId,
    first.occurredAt,
    last.occurredAt,
    first.sourceChannel,
    first.sourceName,
    first.path,
    stringProp(first.props.invite_code_id),
    context.userId,
  ])

  const endedAt = lastSessionEndedAt(events)
  const exitPath = endedAt ? last.path : ''
  const activeSeconds = sumBy(events, event => event.activeSeconds)
  const pageViewCount = events.filter(event => event.eventName === 'page_view').length

  await runAndTrack(db, response, `
    INSERT INTO analytics_sessions (
      id, visitor_id, user_id, started_at, ended_at, entry_path, exit_path,
      source_channel, source_name, referrer_host, utm_source, utm_medium,
      utm_campaign, invite_code_id, device_type, country, active_seconds,
      page_view_count, event_count, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, analytics_sessions.user_id),
      ended_at = COALESCE(excluded.ended_at, analytics_sessions.ended_at),
      exit_path = CASE WHEN excluded.exit_path != '' THEN excluded.exit_path ELSE analytics_sessions.exit_path END,
      active_seconds = analytics_sessions.active_seconds + excluded.active_seconds,
      page_view_count = analytics_sessions.page_view_count + excluded.page_view_count,
      event_count = analytics_sessions.event_count + excluded.event_count,
      updated_at = datetime('now')
  `, [
    batch.sessionId,
    batch.visitorId,
    context.userId,
    first.occurredAt,
    endedAt,
    first.path,
    exitPath,
    first.sourceChannel,
    first.sourceName,
    first.referrerHost,
    first.utmSource,
    first.utmMedium,
    first.utmCampaign,
    stringProp(first.props.invite_code_id),
    first.deviceType,
    context.country || '',
    activeSeconds,
    pageViewCount,
    events.length,
  ])

  await writeSessionSummaryBatch(db, batch, events, context, response)
  await writePageSummaryBatch(db, batch, events, context, response)
  await writeDailyEventsBatch(db, events, response)
  await writeDailySourcesBatch(db, events, response)
  await writeDailyPagesBatch(db, events, response)
  await writeClickDailyBatch(db, events, response)
  await writeSourcePageDailyBatch(db, events, response)
  await writeSourceClickDailyBatch(db, events, response)
}

async function writeSessionSummaryBatch(
  db: AnalyticsDb,
  batch: NormalizedAnalyticsBatch,
  events: NormalizedAnalyticsEvent[],
  context: AnalyticsIngestContext,
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const first = events[0]
  const last = events[events.length - 1]
  if (!first || !last) return

  const endedAt = lastSessionEndedAt(events)
  await runAndTrack(db, response, `
    INSERT INTO analytics_session_summaries (
      session_id, date, visitor_id, user_id, started_at, ended_at, source_channel,
      source_name, invite_code_id, device_type, country, entry_path, exit_path,
      page_view_count, active_seconds, click_count, membership_grant_count,
      is_bounce, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, analytics_session_summaries.user_id),
      ended_at = COALESCE(excluded.ended_at, analytics_session_summaries.ended_at),
      exit_path = CASE WHEN excluded.exit_path != '' THEN excluded.exit_path ELSE analytics_session_summaries.exit_path END,
      page_view_count = analytics_session_summaries.page_view_count + excluded.page_view_count,
      active_seconds = analytics_session_summaries.active_seconds + excluded.active_seconds,
      click_count = analytics_session_summaries.click_count + excluded.click_count,
      membership_grant_count = analytics_session_summaries.membership_grant_count + excluded.membership_grant_count,
      is_bounce = MAX(analytics_session_summaries.is_bounce, excluded.is_bounce),
      updated_at = datetime('now')
  `, [
    batch.sessionId,
    first.date,
    batch.visitorId,
    context.userId,
    first.occurredAt,
    endedAt,
    first.sourceChannel,
    first.sourceName,
    stringProp(first.props.invite_code_id) || '',
    first.deviceType,
    context.country || '',
    first.path,
    endedAt ? last.path : '',
    events.filter(event => event.eventName === 'page_view').length,
    sumBy(events, event => event.activeSeconds),
    events.filter(event => CLICK_EVENTS.has(event.eventName)).length,
    events.filter(event => event.eventName === 'membership_granted_conversion').length,
    events.some(event => event.isBounce) ? 1 : 0,
  ])
}

async function writePageSummaryBatch(
  db: AnalyticsDb,
  batch: NormalizedAnalyticsBatch,
  events: NormalizedAnalyticsEvent[],
  context: AnalyticsIngestContext,
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, NormalizedAnalyticsEvent[]>()
  for (const event of events) {
    if (event.eventName !== 'page_view' && event.eventName !== 'page_leave' && event.eventName !== 'scroll_depth') continue
    const key = [event.routeName, event.path, event.entityType, event.entityId].join('\u001f')
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) continue

    await runAndTrack(db, response, `
      INSERT INTO analytics_page_summaries (
        id, date, visitor_id, session_id, user_id, route_name, path, page_title,
        entity_type, entity_id, first_viewed_at, last_left_at, page_view_count,
        active_seconds, max_scroll_depth, is_entry, is_exit, is_bounce, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id, route_name, path, entity_type, entity_id) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, analytics_page_summaries.user_id),
        page_title = CASE WHEN excluded.page_title != '' THEN excluded.page_title ELSE analytics_page_summaries.page_title END,
        last_left_at = COALESCE(excluded.last_left_at, analytics_page_summaries.last_left_at),
        page_view_count = analytics_page_summaries.page_view_count + excluded.page_view_count,
        active_seconds = analytics_page_summaries.active_seconds + excluded.active_seconds,
        max_scroll_depth = MAX(analytics_page_summaries.max_scroll_depth, excluded.max_scroll_depth),
        is_entry = MAX(analytics_page_summaries.is_entry, excluded.is_entry),
        is_exit = MAX(analytics_page_summaries.is_exit, excluded.is_exit),
        is_bounce = MAX(analytics_page_summaries.is_bounce, excluded.is_bounce),
        updated_at = datetime('now')
    `, [
      `aps_${simpleHash(`${batch.sessionId}:${first.routeName}:${first.path}:${first.entityType}:${first.entityId}`)}`,
      first.date,
      batch.visitorId,
      batch.sessionId,
      context.userId,
      first.routeName,
      first.path,
      last.pageTitle || first.pageTitle,
      first.entityType,
      first.entityId,
      first.occurredAt,
      lastPageLeftAt(group),
      group.filter(event => event.eventName === 'page_view').length,
      sumBy(group, event => event.activeSeconds),
      maxBy(group, event => event.maxScrollDepth),
      group.some(event => event.isEntry) ? 1 : 0,
      group.some(event => event.eventName === 'page_leave') ? 1 : 0,
      group.some(event => event.isBounce) ? 1 : 0,
    ])
  }
}

async function writeDailyEventsBatch(
  db: AnalyticsDb,
  events: NormalizedAnalyticsEvent[],
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, { event: NormalizedAnalyticsEvent; count: number; valueTotal: number }>()
  for (const event of events) {
    const key = [event.date, event.eventName, event.entityType, event.entityId].join('\u001f')
    const group = groups.get(key) ?? { event, count: 0, valueTotal: 0 }
    group.count += 1
    group.valueTotal += event.value ?? 0
    groups.set(key, group)
  }

  for (const { event, count, valueTotal } of groups.values()) {
    await runAndTrack(db, response, `
      INSERT INTO analytics_daily_events (
        date, event_name, entity_type, entity_id, event_count, visitor_count,
        session_count, user_count, value_total, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?, datetime('now'))
      ON CONFLICT(date, event_name, entity_type, entity_id) DO UPDATE SET
        event_count = analytics_daily_events.event_count + excluded.event_count,
        value_total = analytics_daily_events.value_total + excluded.value_total,
        updated_at = datetime('now')
    `, [event.date, event.eventName, event.entityType, event.entityId, count, valueTotal])
  }
}

async function writeDailySourcesBatch(
  db: AnalyticsDb,
  events: NormalizedAnalyticsEvent[],
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, { event: NormalizedAnalyticsEvent; events: NormalizedAnalyticsEvent[] }>()
  for (const event of events) {
    const key = [event.date, event.sourceChannel, event.sourceName, stringProp(event.props.invite_code_id) || ''].join('\u001f')
    const group = groups.get(key) ?? { event, events: [] }
    group.events.push(event)
    groups.set(key, group)
  }

  for (const { event, events: groupEvents } of groups.values()) {
    const sessionStarts = groupEvents.filter(item => item.eventName === 'session_start').length
    const pageViews = groupEvents.filter(item => item.eventName === 'page_view').length
    const galleryDetails = groupEvents.filter(item => item.eventName === 'gallery_detail_view' || item.routeName === '/gallery/:slug').length
    const memberships = groupEvents.filter(item => item.eventName === 'membership_granted_conversion').length
    await runAndTrack(db, response, `
      INSERT INTO analytics_daily_sources (
        date, source_channel, source_name, invite_code_id, visitor_count, session_count,
        page_view_count, gallery_detail_count, membership_grant_count,
        active_seconds_total, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(date, source_channel, source_name, invite_code_id) DO UPDATE SET
        visitor_count = analytics_daily_sources.visitor_count + excluded.visitor_count,
        session_count = analytics_daily_sources.session_count + excluded.session_count,
        page_view_count = analytics_daily_sources.page_view_count + excluded.page_view_count,
        gallery_detail_count = analytics_daily_sources.gallery_detail_count + excluded.gallery_detail_count,
        membership_grant_count = analytics_daily_sources.membership_grant_count + excluded.membership_grant_count,
        active_seconds_total = analytics_daily_sources.active_seconds_total + excluded.active_seconds_total,
        updated_at = datetime('now')
    `, [
      event.date,
      event.sourceChannel,
      event.sourceName,
      stringProp(event.props.invite_code_id) || '',
      sessionStarts,
      sessionStarts,
      pageViews,
      galleryDetails,
      memberships,
      sumBy(groupEvents, item => item.activeSeconds),
    ])
  }
}

async function writeDailyPagesBatch(
  db: AnalyticsDb,
  events: NormalizedAnalyticsEvent[],
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, NormalizedAnalyticsEvent[]>()
  for (const event of events) {
    const key = [event.date, event.routeName, event.path, event.entityType, event.entityId].join('\u001f')
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) continue
    await runAndTrack(db, response, `
      INSERT INTO analytics_daily_pages (
        date, route_name, path, entity_type, entity_id, page_title, page_view_count,
        visitor_count, session_count, entry_count, exit_count, bounce_count,
        active_seconds_total, max_scroll_depth, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(date, route_name, path, entity_type, entity_id) DO UPDATE SET
        page_title = CASE WHEN excluded.page_title != '' THEN excluded.page_title ELSE analytics_daily_pages.page_title END,
        page_view_count = analytics_daily_pages.page_view_count + excluded.page_view_count,
        visitor_count = analytics_daily_pages.visitor_count + excluded.visitor_count,
        session_count = analytics_daily_pages.session_count + excluded.session_count,
        entry_count = analytics_daily_pages.entry_count + excluded.entry_count,
        exit_count = analytics_daily_pages.exit_count + excluded.exit_count,
        bounce_count = analytics_daily_pages.bounce_count + excluded.bounce_count,
        active_seconds_total = analytics_daily_pages.active_seconds_total + excluded.active_seconds_total,
        max_scroll_depth = MAX(analytics_daily_pages.max_scroll_depth, excluded.max_scroll_depth),
        updated_at = datetime('now')
    `, [
      first.date,
      first.routeName,
      first.path,
      first.entityType,
      first.entityId,
      last.pageTitle || first.pageTitle,
      group.filter(event => event.eventName === 'page_view').length,
      group.some(event => event.eventName === 'page_view') ? 1 : 0,
      group.some(event => event.eventName === 'page_view') ? 1 : 0,
      group.some(event => event.isEntry) ? 1 : 0,
      group.some(event => event.eventName === 'page_leave') ? 1 : 0,
      group.some(event => event.isBounce) ? 1 : 0,
      sumBy(group, event => event.activeSeconds),
      maxBy(group, event => event.maxScrollDepth),
    ])
  }
}

async function writeClickDailyBatch(
  db: AnalyticsDb,
  events: NormalizedAnalyticsEvent[],
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, { event: NormalizedAnalyticsEvent; count: number }>()
  for (const event of events) {
    if (!CLICK_EVENTS.has(event.eventName)) continue
    const elementId = stringProp(event.props.element_id) || event.eventName
    const location = stringProp(event.props.location) || event.routeName
    const targetType = stringProp(event.props.target_type) || event.entityType
    const targetId = stringProp(event.props.target_id) || event.entityId
    const key = [event.date, elementId, location, targetType, targetId].join('\u001f')
    const group = groups.get(key) ?? { event, count: 0 }
    group.count += 1
    groups.set(key, group)
  }

  for (const { event, count } of groups.values()) {
    await runAndTrack(db, response, `
      INSERT INTO analytics_click_daily (
        date, element_id, element_type, location, target_type, target_id,
        raw_click_count, effective_click_count, duplicate_click_count,
        visitor_count, session_count, user_count, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, datetime('now'))
      ON CONFLICT(date, element_id, location, target_type, target_id) DO UPDATE SET
        raw_click_count = analytics_click_daily.raw_click_count + excluded.raw_click_count,
        effective_click_count = analytics_click_daily.effective_click_count + excluded.effective_click_count,
        visitor_count = analytics_click_daily.visitor_count + 1,
        session_count = analytics_click_daily.session_count + 1,
        user_count = analytics_click_daily.user_count + excluded.user_count,
        updated_at = datetime('now')
    `, [
      event.date,
      stringProp(event.props.element_id) || event.eventName,
      stringProp(event.props.element_type) || event.eventName,
      stringProp(event.props.location) || event.routeName,
      stringProp(event.props.target_type) || event.entityType,
      stringProp(event.props.target_id) || event.entityId,
      count,
      count,
      0,
    ])
  }
}

async function writeSourcePageDailyBatch(
  db: AnalyticsDb,
  events: NormalizedAnalyticsEvent[],
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, NormalizedAnalyticsEvent[]>()
  for (const event of events) {
    const inviteCodeId = stringProp(event.props.invite_code_id) || ''
    if (!hasSourceDimensionAttribution(event, inviteCodeId)) continue
    const key = [
      event.date,
      event.sourceChannel,
      event.sourceName,
      inviteCodeId,
      event.routeName,
      event.path,
      event.entityType,
      event.entityId,
    ].join('\u001f')
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) continue
    await runAndTrack(db, response, `
      INSERT INTO analytics_source_page_daily (
        date, source_channel, source_name, invite_code_id,
        route_name, path, entity_type, entity_id, page_title,
        visitor_count, session_count, page_view_count, entry_count, exit_count,
        bounce_count, active_seconds_total, max_scroll_depth, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(date, source_channel, source_name, invite_code_id, route_name, path, entity_type, entity_id) DO UPDATE SET
        page_title = CASE WHEN excluded.page_title != '' THEN excluded.page_title ELSE analytics_source_page_daily.page_title END,
        visitor_count = analytics_source_page_daily.visitor_count + excluded.visitor_count,
        session_count = analytics_source_page_daily.session_count + excluded.session_count,
        page_view_count = analytics_source_page_daily.page_view_count + excluded.page_view_count,
        entry_count = analytics_source_page_daily.entry_count + excluded.entry_count,
        exit_count = analytics_source_page_daily.exit_count + excluded.exit_count,
        bounce_count = analytics_source_page_daily.bounce_count + excluded.bounce_count,
        active_seconds_total = analytics_source_page_daily.active_seconds_total + excluded.active_seconds_total,
        max_scroll_depth = MAX(analytics_source_page_daily.max_scroll_depth, excluded.max_scroll_depth),
        updated_at = datetime('now')
    `, [
      first.date,
      first.sourceChannel,
      first.sourceName,
      stringProp(first.props.invite_code_id) || '',
      first.routeName,
      first.path,
      first.entityType,
      first.entityId,
      last.pageTitle || first.pageTitle,
      group.some(event => event.eventName === 'page_view') ? 1 : 0,
      group.some(event => event.eventName === 'page_view') ? 1 : 0,
      group.filter(event => event.eventName === 'page_view').length,
      group.some(event => event.isEntry) ? 1 : 0,
      group.some(event => event.eventName === 'page_leave') ? 1 : 0,
      group.some(event => event.isBounce) ? 1 : 0,
      sumBy(group, event => event.activeSeconds),
      maxBy(group, event => event.maxScrollDepth),
    ])
  }
}

async function writeSourceClickDailyBatch(
  db: AnalyticsDb,
  events: NormalizedAnalyticsEvent[],
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const groups = new Map<string, { event: NormalizedAnalyticsEvent; count: number }>()
  for (const event of events) {
    if (!CLICK_EVENTS.has(event.eventName)) continue
    const elementId = stringProp(event.props.element_id) || event.eventName
    const location = stringProp(event.props.location) || event.routeName
    const targetType = stringProp(event.props.target_type) || event.entityType
    const targetId = stringProp(event.props.target_id) || event.entityId
    const inviteCodeId = stringProp(event.props.invite_code_id) || ''
    if (!hasSourceDimensionAttribution(event, inviteCodeId)) continue
    const key = [
      event.date,
      event.sourceChannel,
      event.sourceName,
      inviteCodeId,
      elementId,
      location,
      targetType,
      targetId,
    ].join('\u001f')
    const group = groups.get(key) ?? { event, count: 0 }
    group.count += 1
    groups.set(key, group)
  }

  for (const { event, count } of groups.values()) {
    await runAndTrack(db, response, `
      INSERT INTO analytics_source_click_daily (
        date, source_channel, source_name, invite_code_id,
        element_id, element_type, location, target_type, target_id,
        raw_click_count, effective_click_count, duplicate_click_count,
        visitor_count, session_count, user_count, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, 0, datetime('now'))
      ON CONFLICT(date, source_channel, source_name, invite_code_id, element_id, location, target_type, target_id) DO UPDATE SET
        raw_click_count = analytics_source_click_daily.raw_click_count + excluded.raw_click_count,
        effective_click_count = analytics_source_click_daily.effective_click_count + excluded.effective_click_count,
        visitor_count = analytics_source_click_daily.visitor_count + 1,
        session_count = analytics_source_click_daily.session_count + 1,
        user_count = analytics_source_click_daily.user_count + excluded.user_count,
        updated_at = datetime('now')
    `, [
      event.date,
      event.sourceChannel,
      event.sourceName,
      stringProp(event.props.invite_code_id) || '',
      stringProp(event.props.element_id) || event.eventName,
      stringProp(event.props.element_type) || event.eventName,
      stringProp(event.props.location) || event.routeName,
      stringProp(event.props.target_type) || event.entityType,
      stringProp(event.props.target_id) || event.entityId,
      count,
      count,
    ])
  }
}

async function reserveStoredEvents(
  db: AnalyticsDb,
  batch: NormalizedAnalyticsBatch,
  candidates: AcceptedAnalyticsEvent[],
  context: AnalyticsIngestContext,
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  const accepted: AcceptedAnalyticsEvent[] = []
  for (const item of candidates) {
    const { event, storedRaw } = item
    if (!storedRaw) {
      accepted.push(item)
      continue
    }
    const result = await runAndTrack(db, response, `
      INSERT OR IGNORE INTO analytics_events (
        id, event_name, occurred_at, received_at, visitor_id, session_id, user_id,
        route_name, path, page_title, referrer_host, source_channel, device_type,
        country, app_env, entity_type, entity_id, event_props,
        value, dedupe_key, sampled
      )
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.eventId,
      event.eventName,
      event.occurredAt,
      batch.visitorId,
      batch.sessionId,
      context.userId,
      event.routeName,
      event.path,
      event.pageTitle,
      event.referrerHost,
      event.sourceChannel,
      event.deviceType,
      context.country || '',
      context.appEnv || 'production',
      event.entityType,
      event.entityId,
      JSON.stringify(event.props),
      event.value,
      event.dedupeKey,
      event.sampled ? 1 : 0,
    ])
    if ((result.meta?.changes ?? 1) === 0) {
      response.duplicate += 1
    } else {
      accepted.push(item)
    }
  }
  return accepted
}

function lastSessionEndedAt(events: NormalizedAnalyticsEvent[]) {
  return [...events].reverse()
    .find(event => event.eventName === 'session_end' || event.eventName === 'page_leave')
    ?.occurredAt ?? null
}

function lastPageLeftAt(events: NormalizedAnalyticsEvent[]) {
  return [...events].reverse()
    .find(event => event.eventName === 'page_leave')
    ?.occurredAt ?? null
}

function sumBy(events: NormalizedAnalyticsEvent[], mapper: (event: NormalizedAnalyticsEvent) => number) {
  return events.reduce((total, event) => total + mapper(event), 0)
}

function maxBy(events: NormalizedAnalyticsEvent[], mapper: (event: NormalizedAnalyticsEvent) => number) {
  return events.reduce((max, event) => Math.max(max, mapper(event)), 0)
}

function hasSourceDimensionAttribution(event: NormalizedAnalyticsEvent, inviteCodeId: string) {
  return event.sourceChannel !== 'direct' || Boolean(inviteCodeId || (event.sourceName && event.sourceName !== 'direct'))
}

async function writeIngestHealth(
  db: AnalyticsDb,
  input: {
    date: string
    accepted: number
    rejected: number
    duplicate: number
    sensitiveBlocked: number
    sampled: number
    dropped: number
    maxDurationMs: number
    usage: D1Usage
  },
  response: AnalyticsBatchResponse & { usage: D1Usage },
) {
  await runAndTrack(db, response, `
    INSERT INTO analytics_ingest_health_daily (
      date, accepted_count, rejected_count, duplicate_count, sensitive_blocked_count,
      sampled_count, dropped_count, estimated_rows_read, estimated_rows_written,
      max_duration_ms, last_ingested_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      accepted_count = analytics_ingest_health_daily.accepted_count + excluded.accepted_count,
      rejected_count = analytics_ingest_health_daily.rejected_count + excluded.rejected_count,
      duplicate_count = analytics_ingest_health_daily.duplicate_count + excluded.duplicate_count,
      sensitive_blocked_count = analytics_ingest_health_daily.sensitive_blocked_count + excluded.sensitive_blocked_count,
      sampled_count = analytics_ingest_health_daily.sampled_count + excluded.sampled_count,
      dropped_count = analytics_ingest_health_daily.dropped_count + excluded.dropped_count,
      estimated_rows_read = analytics_ingest_health_daily.estimated_rows_read + excluded.estimated_rows_read,
      estimated_rows_written = analytics_ingest_health_daily.estimated_rows_written + excluded.estimated_rows_written,
      max_duration_ms = MAX(analytics_ingest_health_daily.max_duration_ms, excluded.max_duration_ms),
      last_ingested_at = excluded.last_ingested_at,
      updated_at = datetime('now')
  `, [
    input.date,
    input.accepted,
    input.rejected,
    input.duplicate,
    input.sensitiveBlocked,
    input.sampled,
    input.dropped,
    input.usage.rowsRead,
    input.usage.rowsWritten,
    input.maxDurationMs,
  ])
}

async function runAndTrack(
  db: AnalyticsDb,
  response: AnalyticsBatchResponse & { usage: D1Usage },
  sql: string,
  params: unknown[],
) {
  const statement = db.prepare(sql).bind(...params.map(param => param === undefined ? null : param))
  const result = await statement.run()
  response.usage = mergeD1Usage(response.usage, readD1UsageMeta(result))
  return result
}

function shouldStoreRawEvent(eventName: AnalyticsEventName, eventId: string, sampleRate: number) {
  return CRITICAL_RAW_EVENTS.has(eventName) || shouldSampleAnalyticsEvent(eventId, sampleRate)
}

function normalizeEventError(error: unknown, eventId: string | null): NonNullable<AnalyticsBatchResponse['errors']>[number] {
  if (error instanceof AnalyticsIngestError) {
    return { eventId, code: error.code, message: error.message }
  }
  return { eventId, code: 'ANALYTICS_EVENT_INVALID', message: '分析事件无效' }
}

function readRequiredString(record: Record<string, unknown>, ...keys: string[]): string {
  const value = readOptionalString(record, ...keys)
  if (!value) throw new AnalyticsIngestError(400, 'ANALYTICS_FIELD_REQUIRED', `缺少字段 ${keys[0]}`)
  return value
}

function readOptionalString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value.trim()
  }
  return null
}

function readOptionalNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function normalizeExternalId(value: string, field: string) {
  if (!VISITOR_SESSION_ID_RE.test(value)) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_ID_INVALID', `${field} 格式无效`)
  }
  return value
}

function normalizeTrustedExternalId(value: string | null | undefined) {
  const normalized = String(value ?? '').trim()
  return VISITOR_SESSION_ID_RE.test(normalized) ? normalized : ''
}

function normalizeEventId(value: string) {
  if (!EVENT_ID_RE.test(value)) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_EVENT_ID_INVALID', 'eventId 格式无效')
  }
  return value
}

function normalizeOccurredAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new AnalyticsIngestError(400, 'ANALYTICS_OCCURRED_AT_INVALID', 'occurredAt 必须是有效时间')
  }
  return date.toISOString()
}

function normalizeDeviceType(value: string | null): AnalyticsDeviceType {
  if (value === 'desktop' || value === 'tablet' || value === 'mobile' || value === 'unknown') return value
  return 'unknown'
}

function defaultEntityType(eventName: AnalyticsEventName): AnalyticsEntityType {
  if (eventName.includes('gallery')) return 'gallery'
  if (eventName.includes('media')) return 'media'
  if (eventName.includes('invite')) return 'invite'
  if (eventName.includes('login') || eventName.includes('register') || eventName.includes('logout')) return 'auth'
  if (eventName.includes('contact')) return 'contact'
  if (eventName.includes('ad')) return 'ad'
  return 'page'
}

function normalizeOptionalFiniteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function readActiveSeconds(eventName: AnalyticsEventName, props: Record<string, AnalyticsPropValue>, value: number | null) {
  if (eventName !== 'page_leave' && eventName !== 'session_end' && eventName !== 'engagement_ping') return 0
  return clampActiveSeconds(numberProp(props.active_seconds) ?? numberProp(props.active_seconds_delta) ?? value ?? 0)
}

function readScrollDepth(props: Record<string, AnalyticsPropValue>, value: number | null) {
  const depth = numberProp(props.max_scroll_depth) ?? numberProp(props.depth_percent) ?? value ?? 0
  return Math.max(0, Math.min(100, Math.floor(depth)))
}

function stringProp(value: AnalyticsPropValue | undefined) {
  return typeof value === 'string' ? value : ''
}

function numberProp(value: AnalyticsPropValue | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hashToUnitInterval(value: string) {
  return simpleHash(value) / 0xffffffff
}

function simpleHash(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function emptyUsage(): D1Usage {
  return { rowsRead: 0, rowsWritten: 0, durationMs: 0 }
}
