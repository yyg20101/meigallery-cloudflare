import { Hono, type Context } from 'hono'
import { normalizeMetaTrackingMode } from '@meigallery/shared/utils'
import type { Bindings, Variables } from '../../index'
import {
  bootstrapMetaConnectionVerification,
  getMetaConnectionStatus,
  MetaConnectionError,
} from '../../services/meta-connection'
import { errorJson } from '../../utils/api-error'
import { mergeD1Usage, readD1UsageMeta, type D1Usage } from '../../utils/analytics-cost'
import { parseAnalyticsRange, type AnalyticsDateRange } from '../../utils/analytics-time'
import { writeAuditLog } from '../../utils/permission'

export const adminAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type AdminAttributionContext = Context<{ Bindings: Bindings; Variables: Variables }>
type QueryResult<T> = { rows: T[]; usage: D1Usage }
type Row = Record<string, unknown>
type ReadinessCheck = {
  key: string
  label: string
  level: 'blocker' | 'warning'
  ok: boolean
  detail: string
}

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
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS membership_grant_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
        AND action_type IN ('contact', 'lead', 'complete_registration', 'membership_grant')
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        date,
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN action_count ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'lead' THEN action_count ELSE 0 END), 0) AS lead_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN action_count ELSE 0 END), 0) AS complete_registration_count,
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS membership_grant_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
        AND action_type IN ('contact', 'lead', 'complete_registration', 'membership_grant')
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'attempted' THEN delivery_count ELSE 0 END), 0) AS pixel_attempted_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'pending' THEN delivery_count ELSE 0 END), 0) AS pixel_pending_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS pixel_skipped_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'sent' THEN delivery_count ELSE 0 END), 0) AS capi_sent_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'failed' THEN delivery_count ELSE 0 END), 0) AS capi_failed_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS capi_skipped_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS capi_duplicate_suppressed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
        AND event_name IN ('Contact', 'CompleteRegistration')
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        date,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'attempted' THEN delivery_count ELSE 0 END), 0) AS pixel_attempted_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'pending' THEN delivery_count ELSE 0 END), 0) AS pixel_pending_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS pixel_skipped_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'sent' THEN delivery_count ELSE 0 END), 0) AS capi_sent_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'failed' THEN delivery_count ELSE 0 END), 0) AS capi_failed_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS capi_skipped_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS capi_duplicate_suppressed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
        AND event_name IN ('Contact', 'CompleteRegistration')
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT MAX(d.sent_at) AS last_sent_at
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE d.channel = 'meta_capi'
        AND d.status = 'sent'
        AND d.sent_at IS NOT NULL
        AND a.action_type IN ('contact', 'complete_registration')
    `, []),
    queryFirst(c.env.DB, `
      SELECT COUNT(*) AS duplicate_action_count
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND duplicate_of != ''
        AND action_type IN ('contact', 'complete_registration', 'membership_grant')
    `, [range.from, range.to]),
  ])

  const totalRow = totals.rows[0] ?? {}
  const metaRow = metaTotals.rows[0] ?? {}
  const pixelAttemptedCount = numberValue(metaRow.pixel_attempted_count)
  const pixelPendingCount = numberValue(metaRow.pixel_pending_count)
  const pixelSkippedCount = numberValue(metaRow.pixel_skipped_count)
  const capiSentCount = numberValue(metaRow.capi_sent_count)
  const capiFailedCount = numberValue(metaRow.capi_failed_count)
  const capiSkippedCount = numberValue(metaRow.capi_skipped_count)
  const duplicateSuppressedCount = numberValue(metaRow.capi_duplicate_suppressed_count)
  const duplicateActionCount = numberValue((duplicateActions.rows[0] ?? {}).duplicate_action_count)
  const capiDeliveryTotal = capiSentCount + capiFailedCount + capiSkippedCount + duplicateSuppressedCount
  const meta = {
    pixel_attempted_count: pixelAttemptedCount,
    pixel_pending_count: pixelPendingCount,
    pixel_skipped_count: pixelSkippedCount,
    capi_sent_count: capiSentCount,
    capi_failed_count: capiFailedCount,
    capi_skipped_count: capiSkippedCount,
    capi_duplicate_suppressed_count: duplicateSuppressedCount,
    last_sent_at: String((lastSentAt.rows[0] ?? {}).last_sent_at ?? ''),
  }
  const duplicates = {
    duplicate_suppressed_count: duplicateSuppressedCount,
    duplicate_action_count: duplicateActionCount,
    duplicate_rate: capiDeliveryTotal > 0 ? roundRate(duplicateSuppressedCount / capiDeliveryTotal) : 0,
  }

  return c.json({
    range,
    usage: mergeQueryUsage(totals, trend, metaTotals, metaTrend, lastSentAt, duplicateActions),
    data: {
      totals: normalizeTotals(totalRow),
      operations: normalizeOperations(totalRow),
      trend: trend.rows.map(normalizeTrendRow),
      historical: normalizeHistorical(totalRow),
      meta,
      metaTrend: metaTrend.rows.map(normalizeMetaTrendRow),
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
    ? "date BETWEEN ? AND ? AND action_type <> 'start_trial' AND source_name = ?"
    : "date BETWEEN ? AND ? AND action_type <> 'start_trial'"
  const actionSourceWhere = sourceFilter
    ? "date BETWEEN ? AND ? AND action_type <> 'start_trial' AND (source_name = ? OR tracking_source_slug = ?)"
    : "date BETWEEN ? AND ? AND action_type <> 'start_trial'"
  const dailySourceParams = sourceFilter ? [range.from, range.to, sourceFilter] : [range.from, range.to]
  const actionSourceParams = sourceFilter ? [range.from, range.to, sourceFilter, sourceFilter] : [range.from, range.to]

  const [byAction, bySource, samples, historical] = await Promise.all([
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
        COALESCE(SUM(CASE WHEN action_type = 'membership_grant' THEN action_count ELSE 0 END), 0) AS membership_grant_count
      FROM analytics_conversion_daily
      WHERE ${dailySourceWhere}
      GROUP BY source_channel, source_name, utm_campaign, utm_content
      ORDER BY contact_count DESC, complete_registration_count DESC
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
    queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(action_count), 0) AS historical_lead_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
        AND action_type = 'lead'
        ${sourceFilter ? 'AND source_name = ?' : ''}
    `, dailySourceParams),
  ])

  return c.json({
    range,
    usage: mergeQueryUsage(byAction, bySource, samples, historical),
    data: {
      byAction: byAction.rows.filter(isActiveConversionRow),
      bySource: bySource.rows.map(serializeConversionSource),
      samples: samples.rows.filter(isActiveConversionRow),
      historical: {
        leadCount: numberValue((historical.rows[0] ?? {}).historical_lead_count),
      },
      operations: {
        membershipGrantCount: numberValue(byAction.rows.find(row => row.action_type === 'membership_grant')?.action_count),
      },
    },
  })
})

adminAttributionRoutes.get('/links', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range
  const sourceFilter = readAttributionSourceFilter(c)
  const conversionMetricsWhere = sourceFilter
    ? "date BETWEEN ? AND ? AND action_type <> 'start_trial' AND source_name = ?"
    : "date BETWEEN ? AND ? AND action_type <> 'start_trial'"
  const linksSourceWhere = sourceFilter
    ? 'WHERE ats.slug = ? OR ats.utm_source = ?'
    : ''
  const queryParams = sourceFilter
    ? [range.from, range.to, sourceFilter, range.from, range.to, sourceFilter, sourceFilter]
    : [range.from, range.to, range.from, range.to]

  const links = await queryAll(c.env.DB, `
    WITH conversion_metrics AS (
      SELECT
        source_name,
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN action_count ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'lead' THEN action_count ELSE 0 END), 0) AS lead_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN action_count ELSE 0 END), 0) AS complete_registration_count,
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
    ORDER BY contact_count DESC, complete_registration_count DESC, session_count DESC, ats.created_at DESC
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

  const [totals, rows, lastSentAt, settings, retryExhausted, matchQuality, connection] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'attempted' THEN delivery_count ELSE 0 END), 0) AS pixel_attempted_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'pending' THEN delivery_count ELSE 0 END), 0) AS pixel_pending_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS pixel_skipped_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'sent' THEN delivery_count ELSE 0 END), 0) AS capi_sent_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'failed' THEN delivery_count ELSE 0 END), 0) AS capi_failed_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS capi_skipped_count,
        COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'duplicate_suppressed' THEN delivery_count ELSE 0 END), 0) AS duplicate_suppressed_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
        AND event_name IN ('Contact', 'CompleteRegistration')
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT channel, event_name, status, skip_reason, SUM(delivery_count) AS delivery_count
      FROM analytics_conversion_delivery_daily
      WHERE date BETWEEN ? AND ?
        AND event_name IN ('Contact', 'CompleteRegistration')
      GROUP BY channel, event_name, status, skip_reason
      ORDER BY channel ASC, event_name ASC, status ASC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT MAX(d.sent_at) AS last_sent_at
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE d.channel = 'meta_capi'
        AND d.status = 'sent'
        AND d.sent_at IS NOT NULL
        AND a.action_type IN ('contact', 'complete_registration')
    `, []),
    queryAll(c.env.DB, `
      SELECT key, value
      FROM site_settings
      WHERE key IN ('facebook_pixel_enabled', 'facebook_pixel_id', 'meta_capi_enabled', 'meta_tracking_mode')
    `, []),
    queryFirst(c.env.DB, `
      SELECT COUNT(*) AS retry_exhausted_count
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE d.channel = 'meta_capi'
        AND d.status = 'failed'
        AND d.error_code = 'retry_exhausted'
        AND a.date BETWEEN ? AND ?
        AND a.action_type IN ('contact', 'complete_registration')
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(CASE
          WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed') THEN 1 ELSE 0
        END), 0) AS fbp_sample_count,
        COALESCE(SUM(CASE
          WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed') AND d.has_fbp = 1 THEN 1 ELSE 0
        END), 0) AS fbp_matched_count,
        COALESCE(SUM(CASE
          WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed')
            AND a.source_channel = 'ad'
            AND lower(a.utm_source) IN ('facebook', 'fb', 'meta', 'instagram')
          THEN 1 ELSE 0
        END), 0) AS fbc_sample_count,
        COALESCE(SUM(CASE
          WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed')
            AND a.source_channel = 'ad'
            AND lower(a.utm_source) IN ('facebook', 'fb', 'meta', 'instagram')
            AND d.has_fbc = 1
          THEN 1 ELSE 0
        END), 0) AS fbc_matched_count
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE d.channel = 'meta_capi'
        AND a.date >= date('now', '-6 days')
        AND a.action_type IN ('contact', 'complete_registration')
    `, []),
    getMetaConnectionStatus(c.env),
  ])

  const totalRow = totals.rows[0] ?? {}
  const retryRow = retryExhausted.rows[0] ?? {}
  const matchRow = matchQuality.rows[0] ?? {}
  const fbpSampleCount = numberValue(matchRow.fbp_sample_count)
  const fbcSampleCount = numberValue(matchRow.fbc_sample_count)
  const fbpMatchedCount = numberValue(matchRow.fbp_matched_count)
  const fbcMatchedCount = numberValue(matchRow.fbc_matched_count)
  const serializedSettings = serializeSettings(settings.rows)
  const { facebook_pixel_id: _pixelId, ...publicSettings } = serializedSettings

  return c.json({
    range,
    usage: mergeQueryUsage(totals, rows, lastSentAt, settings, retryExhausted, matchQuality),
    data: {
      totals: {
        pixel_attempted_count: numberValue(totalRow.pixel_attempted_count),
        pixel_pending_count: numberValue(totalRow.pixel_pending_count),
        pixel_skipped_count: numberValue(totalRow.pixel_skipped_count),
        capi_sent_count: numberValue(totalRow.capi_sent_count),
        capi_failed_count: numberValue(totalRow.capi_failed_count),
        capi_skipped_count: numberValue(totalRow.capi_skipped_count),
        retry_exhausted_count: numberValue(retryRow.retry_exhausted_count),
        duplicate_suppressed_count: numberValue(totalRow.duplicate_suppressed_count),
      },
      deliveries: rows.rows,
      lastSentAt: String((lastSentAt.rows[0] ?? {}).last_sent_at ?? ''),
      queueBindingPresent: Boolean(c.env.META_CAPI_QUEUE),
      connection,
      matchQuality: {
        fbpCoverage: coverageRate(fbpMatchedCount, fbpSampleCount),
        fbpSampleCount,
        fbcCoverage: coverageRate(fbcMatchedCount, fbcSampleCount),
        fbcSampleCount,
      },
      settings: publicSettings,
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
        AND event_name IN ('Contact', 'CompleteRegistration')
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT COUNT(*) AS duplicate_action_count
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND duplicate_of != ''
        AND action_type IN ('contact', 'complete_registration', 'membership_grant')
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        id, action_type, occurred_at, source_channel, source_name, tracking_source_slug,
        utm_campaign, utm_content, method_type, action_target, duplicate_of
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND duplicate_of != ''
        AND action_type IN ('contact', 'complete_registration', 'membership_grant')
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

  const [schema, settings] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT COUNT(*) AS table_count
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'analytics_conversion_actions',
          'analytics_conversion_deliveries',
          'analytics_conversion_delivery_daily',
          'analytics_release_verifications'
        )
    `, []),
    queryAll(c.env.DB, `
      SELECT key, value
      FROM site_settings
      WHERE key IN ('analytics_enabled', 'facebook_pixel_enabled', 'facebook_pixel_id', 'meta_capi_enabled', 'meta_tracking_mode')
    `, []),
  ])
  const schemaReady = numberValue((schema.rows[0] ?? {}).table_count) === 4
  const releaseCommitValue = String(c.env.RELEASE_COMMIT || '').trim()
  const releaseCommit = /^[0-9a-f]{40}$/i.test(releaseCommitValue) ? releaseCommitValue : ''
  const releaseEnvironment = c.env.APP_ENV === 'production' ? 'production' : 'dev'

  const [conversions, retryExhausted, externalIdMismatch, pendingTooLong, permanentFailures, matchQuality, channelTotals, releaseVerifications, manualConfirmation] = schemaReady
    ? await Promise.all([
      queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(action_count), 0) AS action_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
        AND action_type IN ('contact', 'complete_registration')
    `, [range.from, range.to]),
      queryFirst(c.env.DB, `
        SELECT COUNT(*) AS retry_exhausted_count
        FROM analytics_conversion_deliveries d
        JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
        WHERE d.channel = 'meta_capi'
          AND d.status = 'failed'
          AND d.error_code = 'retry_exhausted'
          AND datetime(d.last_attempt_at) >= datetime('now', '-24 hours')
          AND a.action_type IN ('contact', 'complete_registration')
      `, []),
      queryFirst(c.env.DB, `
        SELECT COUNT(*) AS external_event_id_mismatch_count
        FROM (
          SELECT
            d.conversion_action_id,
            d.event_name
          FROM analytics_conversion_deliveries d
          JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
          WHERE datetime(d.created_at) >= datetime('now', '-7 days')
            AND a.source_channel <> 'internal'
            AND a.action_type IN ('contact', 'complete_registration')
          GROUP BY d.conversion_action_id, d.event_name
          HAVING COUNT(DISTINCT CASE WHEN d.channel = 'meta_pixel' THEN d.external_event_id END) > 0
            AND COUNT(DISTINCT CASE WHEN d.channel = 'meta_capi' THEN d.external_event_id END) > 0
            AND (
              COUNT(DISTINCT CASE WHEN d.channel = 'meta_pixel' THEN d.external_event_id END) <> 1
              OR COUNT(DISTINCT CASE WHEN d.channel = 'meta_capi' THEN d.external_event_id END) <> 1
              OR COUNT(DISTINCT d.external_event_id) <> 1
            )
        ) mismatches
      `, []),
      queryFirst(c.env.DB, `
        SELECT COUNT(*) AS pending_too_long_count
        FROM analytics_conversion_deliveries d
        JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
        WHERE d.channel = 'meta_capi'
          AND d.status = 'pending'
          AND datetime(d.created_at) < datetime('now', '-10 minutes')
          AND a.action_type IN ('contact', 'complete_registration')
      `, []),
      queryFirst(c.env.DB, `
        SELECT COUNT(*) AS permanent_failure_count
        FROM analytics_conversion_deliveries d
        JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
        WHERE d.channel = 'meta_capi'
          AND d.status = 'failed'
          AND d.error_code GLOB 'meta_http_4*'
          AND d.error_code <> 'meta_http_429'
          AND datetime(d.updated_at) >= datetime('now', '-7 days')
          AND a.action_type IN ('contact', 'complete_registration')
      `, []),
      queryFirst(c.env.DB, `
        SELECT
          COALESCE(SUM(CASE
            WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed') THEN 1 ELSE 0
          END), 0) AS fbp_sample_count,
          COALESCE(SUM(CASE
            WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed') AND d.has_fbp = 1 THEN 1 ELSE 0
          END), 0) AS fbp_matched_count,
          COALESCE(SUM(CASE
            WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed')
              AND a.source_channel = 'ad'
              AND lower(a.utm_source) IN ('facebook', 'fb', 'meta', 'instagram')
            THEN 1 ELSE 0
          END), 0) AS fbc_sample_count,
          COALESCE(SUM(CASE
            WHEN d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed')
              AND a.source_channel = 'ad'
              AND lower(a.utm_source) IN ('facebook', 'fb', 'meta', 'instagram')
              AND d.has_fbc = 1
            THEN 1 ELSE 0
          END), 0) AS fbc_matched_count
        FROM analytics_conversion_deliveries d
        JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
        WHERE d.channel = 'meta_capi'
          AND a.date >= date('now', '-6 days')
          AND a.action_type IN ('contact', 'complete_registration')
      `, []),
      queryFirst(c.env.DB, `
        SELECT
          COALESCE(SUM(CASE WHEN channel = 'meta_pixel' AND status = 'attempted' THEN delivery_count ELSE 0 END), 0) AS pixel_attempted_count,
          COALESCE(SUM(CASE WHEN channel = 'meta_capi' AND status = 'sent' THEN delivery_count ELSE 0 END), 0) AS capi_sent_count
        FROM analytics_conversion_delivery_daily
        WHERE date >= date('now', '-6 days')
          AND event_name IN ('Contact', 'CompleteRegistration')
      `, []),
      releaseCommit
        ? queryAll(c.env.DB, `
          SELECT verification_type, verified_at, expires_at
          FROM analytics_release_verifications
          WHERE commit_sha = ?
            AND environment = ?
            AND verification_type IN ('meta_live', 'meta_resources')
            AND status = 'passed'
            AND datetime(expires_at) > datetime('now')
          GROUP BY verification_type
          ORDER BY verified_at DESC
        `, [releaseCommit, releaseEnvironment])
        : emptyQueryResult(),
      queryFirst(c.env.DB, `
        SELECT MAX(verified_at) AS last_manual_confirmation_at
        FROM analytics_release_verifications
        WHERE verification_type = 'meta_live'
          AND status = 'passed'
      `, []),
    ])
    : [
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
      emptyQueryResult(),
    ]

  const settingMap = serializeSettings(settings.rows)
  const mode = normalizeMetaTrackingMode(settingMap.meta_tracking_mode)
  const modeRequiresMeta = mode === 'test' || mode === 'production'
  const secretPresent = hasConfiguredValue(c.env.META_CAPI_ACCESS_TOKEN)
  const testEventCodePresent = hasConfiguredValue(c.env.META_CAPI_TEST_EVENT_CODE)
  const pixelEnabled = settingMap.facebook_pixel_enabled === true
  const capiEnabled = settingMap.meta_capi_enabled === true
  const pixelIdPresent = /^\d{5,30}$/.test(String(settingMap.facebook_pixel_id || '').trim())
  const verificationMap = Object.fromEntries(releaseVerifications.rows.map(row => [String(row.verification_type || ''), row]))
  const liveVerification = verificationMap.meta_live
  const resourcesVerification = verificationMap.meta_resources
  const retryExhaustedCount = numberValue((retryExhausted.rows[0] ?? {}).retry_exhausted_count)
  const externalEventIdMismatchCount = numberValue((externalIdMismatch.rows[0] ?? {}).external_event_id_mismatch_count)
  const pendingTooLongCount = numberValue((pendingTooLong.rows[0] ?? {}).pending_too_long_count)
  const permanentFailureCount = numberValue((permanentFailures.rows[0] ?? {}).permanent_failure_count)
  const matchRow = matchQuality.rows[0] ?? {}
  const fbpSampleCount = numberValue(matchRow.fbp_sample_count)
  const fbpCoverage = coverageRate(numberValue(matchRow.fbp_matched_count), fbpSampleCount)
  const fbcSampleCount = numberValue(matchRow.fbc_sample_count)
  const fbcCoverage = coverageRate(numberValue(matchRow.fbc_matched_count), fbcSampleCount)
  const channelRow = channelTotals.rows[0] ?? {}
  const pixelAttemptedCount = numberValue(channelRow.pixel_attempted_count)
  const capiSentCount = numberValue(channelRow.capi_sent_count)
  const capiDeliveryRatio = coverageRate(capiSentCount, pixelAttemptedCount)
  const lastManualConfirmationAt = String((manualConfirmation.rows[0] ?? {}).last_manual_confirmation_at || '')
  const manualConfirmationCurrent = isWithinDays(lastManualConfirmationAt, 30)
  const pixelModeConsistent = mode === 'disabled'
    ? !pixelEnabled && !capiEnabled
    : pixelEnabled && pixelIdPresent

  const checks: ReadinessCheck[] = [
    blockerCheck('conversion_schema', '归因迁移表已应用', schemaReady, schemaReady ? '所需归因表均存在' : '归因迁移表不完整'),
    blockerCheck('analytics_enabled', '站内分析已开启', settingMap.analytics_enabled === true, settingMap.analytics_enabled === true ? 'analytics_enabled 已开启' : 'analytics_enabled 未开启'),
    blockerCheck('conversion_ledger', '转化账本有近期数据', schemaReady && numberValue((conversions.rows[0] ?? {}).action_count) > 0, schemaReady ? `当前范围记录 ${numberValue((conversions.rows[0] ?? {}).action_count)} 次转化` : '归因迁移表不可用'),
    blockerCheck('pixel_mode_consistency', 'Pixel ID 与运行模式一致', pixelModeConsistent, pixelModeDetail(mode, pixelEnabled, capiEnabled, pixelIdPresent)),
    blockerCheck('capi_secret', 'CAPI token 已配置', !modeRequiresMeta || secretPresent, presenceDetail(modeRequiresMeta, secretPresent)),
    blockerCheck('test_event_code', 'Test Event Code 已配置', !modeRequiresMeta || testEventCodePresent, presenceDetail(modeRequiresMeta, testEventCodePresent)),
    blockerCheck('queue_binding', 'CAPI Queue binding 已配置', !modeRequiresMeta || Boolean(c.env.META_CAPI_QUEUE), presenceDetail(modeRequiresMeta, Boolean(c.env.META_CAPI_QUEUE))),
    blockerCheck('meta_live_verification', '当前发布已通过 Meta live 验证', Boolean(releaseCommit && liveVerification), verificationDetail(releaseCommit, liveVerification)),
    blockerCheck('meta_resources_verification', '当前发布已通过 Meta 资源验证', Boolean(releaseCommit && resourcesVerification), verificationDetail(releaseCommit, resourcesVerification)),
    blockerCheck('retry_exhausted', '最近 24 小时无重试耗尽', schemaReady && retryExhaustedCount === 0, schemaReady ? `发现 ${retryExhaustedCount} 条 retry_exhausted` : '归因迁移表不可用'),
    blockerCheck('external_event_id_consistency', 'Pixel/CAPI 事件 ID 一致', schemaReady && externalEventIdMismatchCount === 0, schemaReady ? `发现 ${externalEventIdMismatchCount} 组事件 ID 不一致` : '归因迁移表不可用'),
    warningCheck('pending_too_long', '无超过 10 分钟的 CAPI pending', schemaReady && pendingTooLongCount === 0, schemaReady ? `发现 ${pendingTooLongCount} 条超时 pending` : '归因迁移表不可用'),
    warningCheck('permanent_failure', '近期无 Meta 永久 4xx', schemaReady && permanentFailureCount === 0, schemaReady ? `发现 ${permanentFailureCount} 条永久 4xx` : '归因迁移表不可用'),
    qualityWarning('fbp_coverage', '近 7 天 fbp 覆盖率', fbpSampleCount, fbpCoverage, 0.8),
    qualityWarning('fbc_coverage', '近 7 天 Meta 付费样本 fbc 覆盖率', fbcSampleCount, fbcCoverage, 0.7),
    qualityWarning('capi_delivery_ratio', 'CAPI 成功与 Pixel 尝试比例', pixelAttemptedCount, capiDeliveryRatio, 0.8),
    warningCheck('manual_confirmation', '人工去重确认在 30 天内', manualConfirmationCurrent, lastManualConfirmationAt ? `最近确认：${lastManualConfirmationAt}` : '尚无人工确认记录'),
  ]

  return c.json({
    range,
    usage: mergeQueryUsage(
      schema,
      settings,
      conversions,
      retryExhausted,
      externalIdMismatch,
      pendingTooLong,
      permanentFailures,
      matchQuality,
      channelTotals,
      releaseVerifications,
      manualConfirmation,
    ),
    data: {
      ready: checks.filter(check => check.level === 'blocker').every(check => check.ok),
      checks,
      settings: settingMap,
      verifications: {
        environment: releaseEnvironment,
        releaseCommitPresent: Boolean(releaseCommit),
        metaLive: serializeVerification(liveVerification),
        metaResources: serializeVerification(resourcesVerification),
      },
    },
  })
})

adminAttributionRoutes.post('/meta/test-event', async (c) => {
  const adminId = c.get('userId') ?? 0
  const environment = auditEnvironment(c.env.APP_ENV)
  if (c.get('userRole') !== 'owner') {
    await auditMetaTestEvent(c, adminId, 'meta_connection', {
      code: 'OWNER_REQUIRED',
      success: false,
      environment,
    })
    return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
  }

  try {
    const result = await bootstrapMetaConnectionVerification(c.env, adminId, 'Contact')
    await auditMetaTestEvent(c, adminId, result.deliveryId, {
      code: 'META_CONNECTION_VERIFIED',
      success: true,
      environment: result.connection.environment,
      deliveryId: result.deliveryId,
      eventsReceived: result.eventsReceived,
    })
    return c.json({
      data: {
        status: 'verified',
        eventsReceived: result.eventsReceived,
        connection: result.connection,
      },
    })
  }
  catch (error) {
    const failure = error instanceof MetaConnectionError
      ? error
      : new MetaConnectionError('META_TEST_EVENT_RETRYABLE', 503)
    await auditMetaTestEvent(c, adminId, 'meta_connection', {
      code: failure.code,
      success: false,
      environment,
    })
    return errorJson(c, failure.httpStatus, metaConnectionErrorMessage(failure.code), {
      code: failure.code,
    })
  }
})

function emptyQueryResult(): QueryResult<Row> {
  return { rows: [], usage: EMPTY_USAGE }
}

function blockerCheck(key: string, label: string, ok: boolean, detail: string): ReadinessCheck {
  return { key, label, level: 'blocker', ok, detail }
}

function warningCheck(key: string, label: string, ok: boolean, detail: string): ReadinessCheck {
  return { key, label, level: 'warning', ok, detail }
}

function qualityWarning(
  key: string,
  label: string,
  sampleCount: number,
  rate: number,
  threshold: number,
): ReadinessCheck {
  if (sampleCount < 20) {
    return warningCheck(key, label, true, `样本不足（${sampleCount}/20）`)
  }
  const ok = rate >= threshold
  return warningCheck(
    key,
    label,
    ok,
    `样本 ${sampleCount}，覆盖率 ${formatPercent(rate)}，阈值 ${formatPercent(threshold)}`,
  )
}

function pixelModeDetail(mode: string, pixelEnabled: boolean, capiEnabled: boolean, pixelIdPresent: boolean) {
  if (mode === 'disabled') {
    return !pixelEnabled && !capiEnabled
      ? '关闭模式下 Pixel 与 CAPI 均已关闭'
      : '关闭模式下 Pixel 与 CAPI 必须保持关闭'
  }
  if (!pixelEnabled) return '测试或生产模式必须开启 Pixel'
  if (!pixelIdPresent) return '测试或生产模式必须配置有效 Pixel ID'
  return `${mode} 模式与 Pixel 配置一致`
}

function hasConfiguredValue(value: unknown) {
  return String(value ?? '').trim().length > 0
}

function presenceDetail(required: boolean, present: boolean) {
  if (!required) return '关闭模式无需配置'
  return present ? '已配置，仅返回存在状态' : '尚未配置'
}

function verificationDetail(releaseCommit: string, row: Row | undefined) {
  if (!releaseCommit) return '当前 Worker 未提供 RELEASE_COMMIT'
  if (!row) return '当前 commit 没有未过期的通过记录'
  return `验证时间：${String(row.verified_at || '')}；有效期至：${String(row.expires_at || '')}`
}

function serializeVerification(row: Row | undefined) {
  return {
    present: Boolean(row),
    verifiedAt: String(row?.verified_at || ''),
    expiresAt: String(row?.expires_at || ''),
  }
}

function isWithinDays(value: string, days: number) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return false
  const age = Date.now() - timestamp
  return age >= 0 && age <= days * 24 * 60 * 60 * 1000
}

function coverageRate(numerator: number, denominator: number) {
  return denominator > 0 ? roundRate(numerator / denominator) : 0
}

function formatPercent(rate: number) {
  return `${Math.round(rate * 10000) / 100}%`
}

async function auditMetaTestEvent(
  c: AdminAttributionContext,
  adminId: number,
  deliveryId: string,
  outcome: Record<string, unknown>,
) {
  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'attribution.meta_test_event',
    targetType: 'attribution',
    targetId: deliveryId,
    afterValue: outcome,
  })
}

function auditEnvironment(value: unknown) {
  return value === 'dev' || value === 'production' ? value : 'invalid'
}

function metaConnectionErrorMessage(code: string) {
  if (code === 'META_PRODUCTION_TEST_GATE_PENDING') return 'production 验证门禁尚未开放'
  if (code === 'META_TEST_MODE_REQUIRED') return '仅 dev 测试模式可验证 MetaConnection'
  if (code === 'META_TEST_EVENT_NOT_CONFIGURED' || code === 'META_RELEASE_COMMIT_INVALID') {
    return 'MetaConnection 验证配置不完整'
  }
  if (code === 'META_TEST_EVENT_REJECTED') return 'Meta 未确认接收测试事件'
  return 'MetaConnection 验证暂时不可用'
}

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

function normalizeTotals(row: Row) {
  return {
    contact_count: numberValue(row.contact_count),
    complete_registration_count: numberValue(row.complete_registration_count),
  }
}

function normalizeOperations(row: Row) {
  return { membershipGrantCount: numberValue(row.membership_grant_count) }
}

function normalizeHistorical(row: Row) {
  return { leadCount: numberValue(row.lead_count) }
}

function normalizeTrendRow(row: Row) {
  return {
    date: String(row.date ?? ''),
    ...normalizeTotals(row),
  }
}

function isActiveConversionRow(row: Row) {
  return row.action_type === 'contact' || row.action_type === 'complete_registration'
}

function serializeConversionSource(row: Row) {
  const {
    lead_count: _leadCount,
    membership_grant_count: _membershipGrantCount,
    ...active
  } = row
  return {
    ...active,
    historical: normalizeHistorical(row),
    operations: normalizeOperations(row),
  }
}

function normalizeMetaTrendRow(row: Row) {
  return {
    date: String(row.date ?? ''),
    pixel_attempted_count: numberValue(row.pixel_attempted_count),
    pixel_pending_count: numberValue(row.pixel_pending_count),
    pixel_skipped_count: numberValue(row.pixel_skipped_count),
    capi_sent_count: numberValue(row.capi_sent_count),
    capi_failed_count: numberValue(row.capi_failed_count),
    capi_skipped_count: numberValue(row.capi_skipped_count),
    capi_duplicate_suppressed_count: numberValue(row.capi_duplicate_suppressed_count),
    // 现有趋势组件读取该键；值只来自上面的 CAPI failed 聚合。
    failed_count: numberValue(row.capi_failed_count),
  }
}

function buildRisks(
  totals: ReturnType<typeof normalizeTotals>,
  meta: { capi_failed_count: number; pixel_skipped_count: number; capi_skipped_count: number },
  duplicates: { duplicate_rate: number },
) {
  const risks: Array<{ key: string; level: 'info' | 'warning'; message: string }> = []
  const conversionTotal = Object.values(totals).reduce((sum, value) => sum + value, 0)
  if (conversionTotal === 0) risks.push({ key: 'conversion_empty', level: 'info', message: '当前范围暂无转化数据' })
  if (meta.capi_failed_count > 0) risks.push({ key: 'meta_failed', level: 'warning', message: 'Meta CAPI 投递存在失败记录' })
  if (meta.pixel_skipped_count + meta.capi_skipped_count > 0) risks.push({ key: 'meta_skipped', level: 'info', message: '部分 Meta 投递被跳过' })
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
    activeSecondsTotal: numberValue(row.active_seconds_total),
    contactCount: numberValue(row.contact_count),
    completeRegistrationCount: numberValue(row.complete_registration_count),
    operations: {
      membershipGrantCount: numberValue(row.conversion_membership_grant_count),
    },
    historical: normalizeHistorical(row),
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
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
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
