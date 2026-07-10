import { Hono, type Context } from 'hono'
import type { Bindings, Variables } from '../../index'
import { createMetaCapiTestDelivery, sendMetaCapiEvent } from '../../services/meta-capi'
import { errorJson } from '../../utils/api-error'
import { mergeD1Usage, readD1UsageMeta, type D1Usage } from '../../utils/analytics-cost'
import { parseAnalyticsRange, type AnalyticsDateRange } from '../../utils/analytics-time'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'

export const adminAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type AdminAttributionContext = Context<{ Bindings: Bindings; Variables: Variables }>
type QueryResult<T> = { rows: T[]; usage: D1Usage }
type Row = Record<string, unknown>

const EMPTY_USAGE: D1Usage = { rowsRead: 0, rowsWritten: 0, durationMs: 0 }

adminAttributionRoutes.get('/overview', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [totals, trend, metaTotals, metaTrend, lastSentAt, duplicateActions] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN action_count ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'lead' THEN action_count ELSE 0 END), 0) AS lead_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN action_count ELSE 0 END), 0) AS complete_registration_count,
        COALESCE(SUM(CASE WHEN action_type = 'start_trial' THEN action_count ELSE 0 END), 0) AS start_trial_count,
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS membership_grant_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        date,
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN action_count ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'lead' THEN action_count ELSE 0 END), 0) AS lead_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN action_count ELSE 0 END), 0) AS complete_registration_count,
        COALESCE(SUM(CASE WHEN action_type = 'start_trial' THEN action_count ELSE 0 END), 0) AS start_trial_count,
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS membership_grant_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'sent' THEN delivery_count ELSE 0 END), 0) AS sent_count,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN delivery_count ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS skipped_count,
        COALESCE(SUM(CASE WHEN status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS duplicate_suppressed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        date,
        COALESCE(SUM(CASE WHEN status = 'sent' THEN delivery_count ELSE 0 END), 0) AS sent_count,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN delivery_count ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS skipped_count,
        COALESCE(SUM(CASE WHEN status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS duplicate_suppressed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT MAX(sent_at) AS last_sent_at
      FROM analytics_conversion_deliveries
      WHERE sent_at IS NOT NULL
    `, []),
    queryFirst(c.env.DB, `
      SELECT COUNT(*) AS duplicate_action_count
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND duplicate_of != ''
    `, [range.from, range.to]),
  ])

  const totalRow = totals.rows[0] ?? {}
  const metaRow = metaTotals.rows[0] ?? {}
  const duplicateSuppressedCount = numberValue(metaRow.duplicate_suppressed_count)
  const sentCount = numberValue(metaRow.sent_count)
  const failedCount = numberValue(metaRow.failed_count)
  const skippedCount = numberValue(metaRow.skipped_count)
  const duplicateActionCount = numberValue((duplicateActions.rows[0] ?? {}).duplicate_action_count)
  const deliveryTotal = sentCount + failedCount + skippedCount + duplicateSuppressedCount
  const meta = {
    sent_count: sentCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    duplicate_suppressed_count: duplicateSuppressedCount,
    last_sent_at: String((lastSentAt.rows[0] ?? {}).last_sent_at ?? ''),
  }
  const duplicates = {
    duplicate_suppressed_count: duplicateSuppressedCount,
    duplicate_action_count: duplicateActionCount,
    duplicate_rate: deliveryTotal > 0 ? roundRate(duplicateSuppressedCount / deliveryTotal) : 0,
  }

  return c.json({
    range,
    usage: mergeQueryUsage(totals, trend, metaTotals, metaTrend, lastSentAt, duplicateActions),
    data: {
      totals: normalizeTotals(totalRow),
      trend: trend.rows.map(normalizeTrendRow),
      meta,
      metaTrend: metaTrend.rows,
      duplicates,
      risks: buildRisks(normalizeTotals(totalRow), meta, duplicates),
    },
  })
})

adminAttributionRoutes.get('/conversions', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range
  const sourceFilter = readAttributionSourceFilter(c)
  const dailySourceWhere = sourceFilter
    ? 'date BETWEEN ? AND ? AND source_name = ?'
    : 'date BETWEEN ? AND ?'
  const actionSourceWhere = sourceFilter
    ? 'date BETWEEN ? AND ? AND (source_name = ? OR tracking_source_slug = ?)'
    : 'date BETWEEN ? AND ?'
  const dailySourceParams = sourceFilter ? [range.from, range.to, sourceFilter] : [range.from, range.to]
  const actionSourceParams = sourceFilter ? [range.from, range.to, sourceFilter, sourceFilter] : [range.from, range.to]

  const [byAction, bySource, samples] = await Promise.all([
    queryAll(c.env.DB, `
      SELECT action_type, SUM(action_count) AS action_count, SUM(unique_session_count) AS unique_session_count
      FROM analytics_conversion_daily
      WHERE ${dailySourceWhere}
      GROUP BY action_type
      ORDER BY action_count DESC
    `, dailySourceParams),
    queryAll(c.env.DB, `
      SELECT
        source_channel,
        source_name,
        utm_campaign,
        utm_content,
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN action_count ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'lead' THEN action_count ELSE 0 END), 0) AS lead_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN action_count ELSE 0 END), 0) AS complete_registration_count,
        COALESCE(SUM(CASE WHEN action_type = 'start_trial' THEN action_count ELSE 0 END), 0) AS start_trial_count,
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS membership_grant_count
      FROM analytics_conversion_daily
      WHERE ${dailySourceWhere}
      GROUP BY source_channel, source_name, utm_campaign, utm_content
      ORDER BY contact_count DESC, lead_count DESC
      LIMIT 50
    `, dailySourceParams),
    queryAll(c.env.DB, `
      SELECT
        id, action_type, occurred_at, source_channel, source_name, tracking_source_slug,
        utm_campaign, utm_content, method_type, action_target, route_name, path, duplicate_of
      FROM analytics_conversion_actions
      WHERE ${actionSourceWhere}
      ORDER BY occurred_at DESC
      LIMIT 100
    `, actionSourceParams),
  ])

  return c.json({
    range,
    usage: mergeQueryUsage(byAction, bySource, samples),
    data: {
      byAction: byAction.rows,
      bySource: bySource.rows,
      samples: samples.rows,
    },
  })
})

adminAttributionRoutes.get('/links', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range
  const sourceFilter = readAttributionSourceFilter(c)
  const conversionMetricsWhere = sourceFilter
    ? 'date BETWEEN ? AND ? AND source_name = ?'
    : 'date BETWEEN ? AND ?'
  const linksSourceWhere = sourceFilter
    ? 'WHERE ats.slug = ? OR ats.utm_source = ?'
    : ''
  const queryParams = sourceFilter
    ? [range.from, range.to, range.from, range.to, sourceFilter, sourceFilter]
    : [range.from, range.to, range.from, range.to]

  const links = await queryAll(c.env.DB, `
    WITH conversion_metrics AS (
      SELECT
        source_name,
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN action_count ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'lead' THEN action_count ELSE 0 END), 0) AS lead_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN action_count ELSE 0 END), 0) AS complete_registration_count,
        COALESCE(SUM(CASE WHEN action_type = 'start_trial' THEN action_count ELSE 0 END), 0) AS start_trial_count,
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS conversion_membership_grant_count
      FROM analytics_conversion_daily
      WHERE ${conversionMetricsWhere}
      GROUP BY source_name
    )
    SELECT
      ats.id, ats.name, ats.channel, ats.slug, ats.target_path, ats.utm_source,
      ats.utm_medium, ats.utm_campaign, ats.utm_content, ats.status, ats.note,
      ats.created_by, ats.created_at, ats.updated_at,
      COALESCE(SUM(ads.visitor_count), 0) AS visitor_count,
      COALESCE(SUM(ads.session_count), 0) AS session_count,
      COALESCE(SUM(ads.page_view_count), 0) AS page_view_count,
      COALESCE(SUM(ads.gallery_detail_count), 0) AS gallery_detail_count,
      COALESCE(SUM(ads.contact_click_count), 0) AS contact_click_count,
      COALESCE(SUM(ads.register_count), 0) AS register_count,
      COALESCE(SUM(ads.membership_grant_count), 0) AS membership_grant_count,
      COALESCE(SUM(ads.active_seconds_total), 0) AS active_seconds_total,
      COALESCE(MAX(cm.contact_count), 0) AS contact_count,
      COALESCE(MAX(cm.lead_count), 0) AS lead_count,
      COALESCE(MAX(cm.complete_registration_count), 0) AS complete_registration_count,
      COALESCE(MAX(cm.start_trial_count), 0) AS start_trial_count,
      COALESCE(MAX(cm.conversion_membership_grant_count), 0) AS conversion_membership_grant_count
    FROM analytics_tracking_sources ats
    LEFT JOIN analytics_daily_sources ads
      ON ads.date BETWEEN ? AND ?
     AND ads.source_name = ats.utm_source
    LEFT JOIN conversion_metrics cm
      ON cm.source_name = ats.utm_source
    ${linksSourceWhere}
    GROUP BY
      ats.id, ats.name, ats.channel, ats.slug, ats.target_path, ats.utm_source,
      ats.utm_medium, ats.utm_campaign, ats.utm_content, ats.status, ats.note,
      ats.created_by, ats.created_at, ats.updated_at
    ORDER BY contact_count DESC, session_count DESC, ats.created_at DESC
  `, queryParams)

  return c.json({
    range,
    usage: links.usage,
    data: {
      links: links.rows.map(serializeAttributionLink),
    },
  })
})

adminAttributionRoutes.get('/meta', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [totals, rows, lastSentAt, settings] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'sent' THEN delivery_count ELSE 0 END), 0) AS sent_count,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN delivery_count ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS skipped_count,
        COALESCE(SUM(CASE WHEN status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS duplicate_suppressed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT channel, event_name, status, skip_reason, SUM(delivery_count) AS delivery_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY channel, event_name, status, skip_reason
      ORDER BY channel ASC, event_name ASC, status ASC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT MAX(sent_at) AS last_sent_at
      FROM analytics_conversion_deliveries
      WHERE sent_at IS NOT NULL
    `, []),
    queryAll(c.env.DB, `
      SELECT key, value
      FROM site_settings
      WHERE key IN ('facebook_pixel_enabled', 'facebook_pixel_id', 'meta_capi_enabled', 'meta_capi_test_event_enabled', 'meta_tracking_mode')
    `, []),
  ])

  return c.json({
    range,
    usage: mergeQueryUsage(totals, rows, lastSentAt, settings),
    data: {
      totals: totals.rows[0] ?? {},
      deliveries: rows.rows,
      lastSentAt: String((lastSentAt.rows[0] ?? {}).last_sent_at ?? ''),
      secretPresent: Boolean(c.env.META_CAPI_ACCESS_TOKEN),
      settings: serializeSettings(settings.rows),
    },
  })
})

adminAttributionRoutes.get('/duplicates', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [deliveryTotals, duplicateActions, samples] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS duplicate_suppressed_count,
        COALESCE(SUM(delivery_count), 0) AS delivery_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT COUNT(*) AS duplicate_action_count
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND duplicate_of != ''
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        id, action_type, occurred_at, source_channel, source_name, tracking_source_slug,
        utm_campaign, utm_content, method_type, action_target, duplicate_of
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND duplicate_of != ''
      ORDER BY occurred_at DESC
      LIMIT 100
    `, [range.from, range.to]),
  ])
  const deliveryRow = deliveryTotals.rows[0] ?? {}
  const duplicateSuppressedCount = numberValue(deliveryRow.duplicate_suppressed_count)
  const deliveryCount = numberValue(deliveryRow.delivery_count)

  return c.json({
    range,
    usage: mergeQueryUsage(deliveryTotals, duplicateActions, samples),
    data: {
      duplicateSuppressedCount,
      duplicateActionCount: numberValue((duplicateActions.rows[0] ?? {}).duplicate_action_count),
      duplicateRate: deliveryCount > 0 ? roundRate(duplicateSuppressedCount / deliveryCount) : 0,
      samples: samples.rows,
    },
  })
})

adminAttributionRoutes.get('/readiness', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [settings, conversions, metaFailures] = await Promise.all([
    queryAll(c.env.DB, `
      SELECT key, value
      FROM site_settings
      WHERE key IN ('analytics_enabled', 'facebook_pixel_enabled', 'facebook_pixel_id', 'meta_capi_enabled', 'meta_tracking_mode')
    `, []),
    queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(action_count), 0) AS action_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(CASE WHEN status = 'failed' THEN delivery_count ELSE 0 END), 0) AS failed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
  ])
  const settingMap = serializeSettings(settings.rows)
  const checks = [
    { key: 'analytics_enabled', label: '站内分析已开启', ok: settingMap.analytics_enabled === true },
    { key: 'conversion_ledger', label: '转化账本有近期数据', ok: numberValue((conversions.rows[0] ?? {}).action_count) > 0 },
    { key: 'meta_failures', label: 'Meta 投递无失败堆积', ok: numberValue((metaFailures.rows[0] ?? {}).failed_count) === 0 },
    { key: 'pixel_id', label: 'Pixel ID 已配置或保持关闭态', ok: Boolean(settingMap.facebook_pixel_id) || settingMap.facebook_pixel_enabled !== true },
  ]

  return c.json({
    range,
    usage: mergeQueryUsage(settings, conversions, metaFailures),
    data: {
      ready: checks.every(check => check.ok),
      checks,
      settings: settingMap,
    },
  })
})

adminAttributionRoutes.post('/meta/test-event', async (c) => {
  const ownerError = requireOwner(c)
  if (ownerError) return ownerError

  const adminId = c.get('userId')!
  const now = new Date().toISOString()
  const date = now.slice(0, 10)
  const conversionId = generateId('convtest')
  const deliveryId = generateId('cdlvtest')
  const externalEventId = `meta:Contact:test:${deliveryId}`
  await createMetaCapiTestDelivery(c.env.DB, {
    conversionId,
    deliveryId,
    externalEventId,
    occurredAt: now,
    date,
    adminId,
  })

  let afterValue: Record<string, unknown>
  try {
    const result = await sendMetaCapiEvent(c.env, deliveryId, {
      testEventCode: String(c.env.META_CAPI_TEST_EVENT_CODE || '').trim() || undefined,
    })
    afterValue = {
      ...result,
      channel: 'meta_capi',
      eventName: 'Contact',
      testEventCodePresent: Boolean(c.env.META_CAPI_TEST_EVENT_CODE),
    }
  } catch (error) {
    afterValue = {
      deliveryId,
      status: 'failed',
      reason: error instanceof Error ? error.message : 'Meta CAPI Test Event 失败',
      retryable: true,
      channel: 'meta_capi',
      eventName: 'Contact',
      testEventCodePresent: Boolean(c.env.META_CAPI_TEST_EVENT_CODE),
    }
  }
  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'attribution.meta_test_event',
    targetType: 'attribution',
    targetId: deliveryId,
    afterValue,
  })

  return c.json({
    data: afterValue,
  }, 202)
})

function parseRangeOrError(c: AdminAttributionContext): AnalyticsDateRange | Response {
  try {
    return parseAnalyticsRange({
      range: c.req.query('range'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    })
  } catch (error) {
    return errorJson(c, 400, error instanceof Error ? error.message : '分析日期范围无效', {
      code: 'ANALYTICS_RANGE_INVALID',
    })
  }
}

async function queryAll<T extends Row>(
  db: Pick<D1Database, 'prepare'>,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const result = await db.prepare(sql).bind(...params).all<T>()
  return {
    rows: result.results ?? [],
    usage: readD1UsageMeta(result),
  }
}

async function queryFirst<T extends Row>(
  db: Pick<D1Database, 'prepare'>,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const result = await db.prepare(sql).bind(...params).all<T>()
  const row = result.results?.[0]
  return {
    rows: row ? [row] : [],
    usage: readD1UsageMeta(result),
  }
}

function mergeQueryUsage(...items: Array<QueryResult<Row>>) {
  return mergeD1Usage(EMPTY_USAGE, ...items.map(item => item.usage))
}

function requireOwner(c: AdminAttributionContext): Response | null {
  if (c.get('userRole') === 'owner') return null
  return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
}

function normalizeTotals(row: Row) {
  return {
    contact_count: numberValue(row.contact_count),
    lead_count: numberValue(row.lead_count),
    complete_registration_count: numberValue(row.complete_registration_count),
    start_trial_count: numberValue(row.start_trial_count),
    membership_grant_count: numberValue(row.membership_grant_count),
  }
}

function normalizeTrendRow(row: Row) {
  return {
    date: String(row.date ?? ''),
    ...normalizeTotals(row),
  }
}

function buildRisks(
  totals: ReturnType<typeof normalizeTotals>,
  meta: { failed_count: number; skipped_count: number },
  duplicates: { duplicate_rate: number },
) {
  const risks: Array<{ key: string; level: 'info' | 'warning'; message: string }> = []
  const conversionTotal = Object.values(totals).reduce((sum, value) => sum + value, 0)
  if (conversionTotal === 0) risks.push({ key: 'conversion_empty', level: 'info', message: '当前范围暂无转化数据' })
  if (meta.failed_count > 0) risks.push({ key: 'meta_failed', level: 'warning', message: 'Meta 投递存在失败记录' })
  if (meta.skipped_count > 0) risks.push({ key: 'meta_skipped', level: 'info', message: '部分 Meta 投递被跳过' })
  if (duplicates.duplicate_rate >= 0.1) risks.push({ key: 'duplicate_high', level: 'warning', message: '重复抑制比例偏高' })
  return risks
}

function serializeAttributionLink(row: Row) {
  const item = {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    sourceLabel: String(row.name ?? ''),
    channel: String(row.channel ?? ''),
    slug: String(row.slug ?? ''),
    sourceCode: String(row.slug ?? ''),
    targetPath: String(row.target_path ?? '/'),
    utmSource: String(row.utm_source ?? ''),
    utmMedium: String(row.utm_medium ?? ''),
    utmCampaign: String(row.utm_campaign ?? ''),
    utmContent: String(row.utm_content ?? ''),
    status: String(row.status ?? 'active'),
    note: String(row.note ?? ''),
    createdBy: numberValue(row.created_by),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    visitorCount: numberValue(row.visitor_count),
    sessionCount: numberValue(row.session_count),
    pageViewCount: numberValue(row.page_view_count),
    galleryDetailCount: numberValue(row.gallery_detail_count),
    contactClickCount: numberValue(row.contact_click_count),
    registerCount: numberValue(row.register_count),
    membershipGrantCount: numberValue(row.membership_grant_count),
    activeSecondsTotal: numberValue(row.active_seconds_total),
    contactCount: numberValue(row.contact_count),
    leadCount: numberValue(row.lead_count),
    completeRegistrationCount: numberValue(row.complete_registration_count),
    startTrialCount: numberValue(row.start_trial_count),
    conversionMembershipGrantCount: numberValue(row.conversion_membership_grant_count),
  }
  return {
    ...item,
    trackingPath: buildTrackingPath(item),
  }
}

function buildTrackingPath(input: { targetPath: string; slug: string; utmSource: string; utmMedium: string; utmCampaign: string; utmContent: string }) {
  const url = new URL(input.targetPath || '/', 'https://site.local')
  url.searchParams.set('mg_source', input.slug)
  url.searchParams.set('utm_source', input.utmSource)
  url.searchParams.set('utm_medium', input.utmMedium)
  if (input.utmCampaign) url.searchParams.set('utm_campaign', input.utmCampaign)
  if (input.utmContent) url.searchParams.set('utm_content', input.utmContent)
  return `${url.pathname}${url.search}`
}

function serializeSettings(rows: Row[]) {
  return Object.fromEntries(rows.map(row => [String(row.key ?? ''), parseSettingValue(row.value)]).filter(([key]) => key))
}

function parseSettingValue(value: unknown) {
  const text = String(value ?? '').trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('[') && text.endsWith(']'))
  ) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function readAttributionSourceFilter(c: AdminAttributionContext) {
  return (
    normalizedQueryValue(c.req.query('sourceCode')) ||
    normalizedQueryValue(c.req.query('sourceName')) ||
    normalizedQueryValue(c.req.query('source'))
  )
}

function normalizedQueryValue(value: string | undefined) {
  const text = String(value ?? '').trim()
  return text && text !== 'all' ? text : ''
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function roundRate(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10000) / 10000
}
