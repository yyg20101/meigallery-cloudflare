import type { AnalyticsRangeQuery } from '@meigallery/shared'
import { ANALYTICS_RETENTION } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import { parseAnalyticsRange, type AnalyticsDateRange } from '../utils/analytics-time'
import {
  buildAnalyticsContactClickRows,
  buildAnalyticsConversionIndex,
  dateSourceMetricKey,
  readAnalyticsConversionMetrics,
  sourceMetricKey,
  sourcePageMetricKey,
} from './analytics-conversion-metrics'

export type AnalyticsExportKind =
  | 'overview'
  | 'sources'
  | 'pages'
  | 'paths'
  | 'clicks'
  | 'source-pages'
  | 'source-clicks'
  | 'durations'
  | 'invites'
  | 'sessions'

const EXPORT_KINDS = new Set<AnalyticsExportKind>([
  'overview',
  'sources',
  'pages',
  'paths',
  'clicks',
  'source-pages',
  'source-clicks',
  'durations',
  'invites',
  'sessions',
])

export interface CreateAnalyticsExportInput {
  kind: AnalyticsExportKind | string
  rangeQuery: AnalyticsRangeQuery
  filters?: Record<string, unknown>
  createdBy: number
  now?: Date
}

export interface AnalyticsExportJob {
  id: string
  status: string
  kind: string
  rangeFrom: string
  rangeTo: string
  filters: Record<string, unknown>
  r2Key: string | null
  expiresAt: string | null
  createdBy: number
  createdAt: string
  completedAt: string | null
  errorMessage: string
}

export async function createAnalyticsExportJob(
  env: Pick<Bindings, 'DB' | 'R2'>,
  input: CreateAnalyticsExportInput,
): Promise<AnalyticsExportJob> {
  const kind = normalizeExportKind(input.kind)
  const range = parseAnalyticsRange(input.rangeQuery, input.now)
  const now = input.now ?? new Date()
  const id = generateId('aexp')
  const createdAt = now.toISOString()
  const expiresAt = addDaysIso(now, ANALYTICS_RETENTION.EXPORT_EXPIRES_DAYS)
  const filters = input.filters ?? {}

  await env.DB.prepare(`
    INSERT INTO analytics_export_jobs (
      id, status, kind, range_from, range_to, filters_json,
      created_by, created_at, updated_at, expires_at
    )
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, kind, range.from, range.to, JSON.stringify(filters), input.createdBy, createdAt, createdAt, expiresAt).run()

  try {
    await env.DB.prepare(`
      UPDATE analytics_export_jobs
      SET status = 'processing', updated_at = datetime('now')
      WHERE id = ?
    `).bind(id).run()

    const csv = await buildAnalyticsExportCsv(env.DB, kind, range)
    const r2Key = `analytics/exports/${id}.csv`
    await env.R2.put(r2Key, csv, {
      httpMetadata: { contentType: 'text/csv;charset=utf-8' },
    })

    await env.DB.prepare(`
      UPDATE analytics_export_jobs
      SET status = 'completed',
          r2_key = ?,
          expires_at = ?,
          completed_at = datetime('now'),
          updated_at = datetime('now'),
          error_message = ''
      WHERE id = ?
    `).bind(r2Key, expiresAt, id).run()
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : '导出失败'
    await env.DB.prepare(`
      UPDATE analytics_export_jobs
      SET status = 'failed',
          error_message = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(message, id).run()
  }

  return readAnalyticsExportJob(env.DB, id)
}

export async function readAnalyticsExportJob(db: Pick<D1Database, 'prepare'>, id: string): Promise<AnalyticsExportJob> {
  const row = await db.prepare(`
    SELECT id, status, kind, range_from, range_to, filters_json, r2_key,
           expires_at, created_by, created_at, completed_at, error_message
    FROM analytics_export_jobs
    WHERE id = ?
  `).bind(id).first<{
    id: string
    status: string
    kind: string
    range_from: string
    range_to: string
    filters_json: string
    r2_key: string | null
    expires_at: string | null
    created_by: number
    created_at: string
    completed_at: string | null
    error_message: string
  }>()

  if (!row) throw new Error('导出任务不存在')
  return serializeExportJob(row)
}

export async function buildAnalyticsExportCsv(
  db: Pick<D1Database, 'prepare'>,
  kind: AnalyticsExportKind,
  range: AnalyticsDateRange,
) {
  const rows = await queryExportRows(db, kind, range)
  const firstRow = rows[0]
  const headers = firstRow ? Object.keys(firstRow) : defaultHeaders(kind)
  return [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvCell(row[header])).join(',')),
  ].join('\n')
}

async function queryExportRows(
  db: Pick<D1Database, 'prepare'>,
  kind: AnalyticsExportKind,
  range: AnalyticsDateRange,
): Promise<Record<string, unknown>[]> {
  const sql = exportSql(kind)
  const [result, conversions] = await Promise.all([
    db.prepare(sql).bind(range.from, range.to).all<Record<string, unknown>>(),
    readAnalyticsConversionMetrics(db, range),
  ])
  const index = buildAnalyticsConversionIndex(conversions.rows)
  if (kind === 'clicks') {
    return mergeExportClickRows(
      result.results ?? [],
      buildAnalyticsContactClickRows(conversions.rows),
    )
  }
  if (kind === 'source-clicks') {
    return mergeExportClickRows(
      result.results ?? [],
      buildAnalyticsContactClickRows(conversions.rows, { bySource: true }),
    )
  }
  return (result.results ?? []).map(row => {
    if (kind === 'overview') {
      return exportRowWithConversions(row, index.byDateSource.get(dateSourceMetricKey(
        row.date,
        row.source_channel,
        row.source_name,
        row.invite_code_id,
      )))
    }
    if (kind === 'sources') {
      return exportRowWithConversions(row, index.bySource.get(sourceMetricKey(
        row.source_channel,
        row.source_name,
        row.invite_code_id,
      )))
    }
    if (kind === 'source-pages') {
      return exportRowWithConversions(row, index.bySourcePage.get(sourcePageMetricKey(
        row.source_channel,
        row.source_name,
        row.invite_code_id,
        row.route_name,
        row.path,
      )))
    }
    if (kind === 'sessions') {
      const counts = index.bySession.get(String(row.session_id ?? ''))
      return {
        ...row,
        contact_click_count: counts?.contact_click_count ?? 0,
        register_count: counts?.register_count ?? 0,
      }
    }
    if (kind === 'invites') {
      const counts = index.byInvite.get(String(row.invite_code_id ?? ''))
      return {
        ...row,
        contact_click_count: counts?.contact_click_count ?? 0,
        register_count: counts?.register_count ?? 0,
      }
    }
    return row
  })
}

function mergeExportClickRows(
  ...groups: Array<readonly Record<string, unknown>[]>
): Record<string, unknown>[] {
  return groups
    .flat()
    .map(row => ({ ...row }))
    .sort((a, b) => (
      Number(b.effective_click_count ?? 0) - Number(a.effective_click_count ?? 0)
      || Number(b.raw_click_count ?? 0) - Number(a.raw_click_count ?? 0)
    ))
}

function exportRowWithConversions(
  row: Record<string, unknown>,
  counts: { contact_click_count: number; register_count: number } | undefined,
) {
  return {
    ...row,
    contact_click_count: counts?.contact_click_count ?? 0,
    register_count: counts?.register_count ?? 0,
  }
}

function exportSql(kind: AnalyticsExportKind) {
  if (kind === 'overview') {
    return `
      SELECT date, source_channel, source_name, invite_code_id,
             visitor_count, session_count, page_view_count, gallery_detail_count,
             invite_register_count, membership_grant_count, active_seconds_total
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
      ORDER BY date DESC, session_count DESC
    `
  }
  if (kind === 'sources') {
    return `
      SELECT source_channel, source_name, invite_code_id,
             SUM(visitor_count) AS visitor_count,
             SUM(session_count) AS session_count,
             SUM(page_view_count) AS page_view_count,
             SUM(gallery_detail_count) AS gallery_detail_count,
             SUM(membership_grant_count) AS membership_grant_count,
             SUM(active_seconds_total) AS active_seconds_total
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
      GROUP BY source_channel, source_name, invite_code_id
      ORDER BY session_count DESC
    `
  }
  if (kind === 'pages' || kind === 'durations') {
    return `
      SELECT route_name, path, entity_type, entity_id, page_title,
             SUM(page_view_count) AS page_view_count,
             SUM(visitor_count) AS visitor_count,
             SUM(session_count) AS session_count,
             SUM(entry_count) AS entry_count,
             SUM(exit_count) AS exit_count,
             SUM(bounce_count) AS bounce_count,
             SUM(active_seconds_total) AS active_seconds_total,
             MAX(max_scroll_depth) AS max_scroll_depth
      FROM analytics_daily_pages
      WHERE date BETWEEN ? AND ?
      GROUP BY route_name, path, entity_type, entity_id, page_title
      ORDER BY page_view_count DESC
    `
  }
  if (kind === 'paths') {
    return `
      SELECT from_route, to_route, from_path, to_path,
             SUM(transition_count) AS transition_count,
             SUM(visitor_count) AS visitor_count,
             SUM(session_count) AS session_count,
             SUM(conversion_count) AS conversion_count
      FROM analytics_path_edges
      WHERE date BETWEEN ? AND ?
      GROUP BY from_route, to_route, from_path, to_path
      ORDER BY transition_count DESC
    `
  }
  if (kind === 'clicks') {
    return `
      SELECT element_id, element_type, location, target_type, target_id,
             SUM(raw_click_count) AS raw_click_count,
             SUM(effective_click_count) AS effective_click_count,
             SUM(duplicate_click_count) AS duplicate_click_count,
             SUM(visitor_count) AS visitor_count,
             SUM(session_count) AS session_count
      FROM analytics_click_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY element_id, element_type, location, target_type, target_id
      ORDER BY raw_click_count DESC
    `
  }
  if (kind === 'source-pages') {
    return `
      SELECT aspd.source_channel, aspd.source_name, COALESCE(ats.name, '') AS source_label,
             aspd.invite_code_id, aspd.route_name, aspd.path, aspd.entity_type,
             aspd.entity_id, aspd.page_title,
             SUM(aspd.page_view_count) AS page_view_count,
             SUM(aspd.visitor_count) AS visitor_count,
             SUM(aspd.session_count) AS session_count,
             SUM(aspd.entry_count) AS entry_count,
             SUM(aspd.exit_count) AS exit_count,
             SUM(aspd.bounce_count) AS bounce_count,
             SUM(aspd.active_seconds_total) AS active_seconds_total,
             MAX(aspd.max_scroll_depth) AS max_scroll_depth
      FROM analytics_source_page_daily aspd
      LEFT JOIN analytics_tracking_sources ats ON ats.slug = aspd.source_name
      WHERE aspd.date BETWEEN ? AND ?
      GROUP BY aspd.source_channel, aspd.source_name, ats.name, aspd.invite_code_id,
               aspd.route_name, aspd.path, aspd.entity_type, aspd.entity_id, aspd.page_title
      ORDER BY page_view_count DESC
    `
  }
  if (kind === 'source-clicks') {
    return `
      SELECT ascd.source_channel, ascd.source_name, COALESCE(ats.name, '') AS source_label,
             ascd.invite_code_id, ascd.element_id, ascd.element_type, ascd.location,
             ascd.target_type, ascd.target_id,
             SUM(ascd.raw_click_count) AS raw_click_count,
             SUM(ascd.effective_click_count) AS effective_click_count,
             SUM(ascd.duplicate_click_count) AS duplicate_click_count,
             SUM(ascd.visitor_count) AS visitor_count,
             SUM(ascd.session_count) AS session_count
      FROM analytics_source_click_daily ascd
      LEFT JOIN analytics_tracking_sources ats ON ats.slug = ascd.source_name
      WHERE ascd.date BETWEEN ? AND ?
      GROUP BY ascd.source_channel, ascd.source_name, ats.name, ascd.invite_code_id,
               ascd.element_id, ascd.element_type, ascd.location, ascd.target_type, ascd.target_id
      ORDER BY raw_click_count DESC
    `
  }
  if (kind === 'invites') {
    return `
      SELECT aid.invite_code_id, COALESCE(ic.name, '') AS invite_name,
             aid.channel,
             SUM(aid.landing_count) AS landing_count,
             SUM(aid.visitor_count) AS visitor_count,
             SUM(aid.session_count) AS session_count,
             SUM(aid.membership_grant_count) AS membership_grant_count
      FROM analytics_invite_daily aid
      LEFT JOIN invite_codes ic ON ic.id = aid.invite_code_id
      WHERE aid.date BETWEEN ? AND ?
      GROUP BY aid.invite_code_id, ic.name, aid.channel
      ORDER BY register_count DESC
    `
  }
  return `
    SELECT session_id, date, source_channel, source_name, invite_code_id,
           device_type, country, entry_path, exit_path, page_view_count,
           active_seconds, click_count, membership_grant_count, is_bounce
    FROM analytics_session_summaries
    WHERE date BETWEEN ? AND ?
    ORDER BY started_at DESC
  `
}

function normalizeExportKind(kind: string): AnalyticsExportKind {
  if (EXPORT_KINDS.has(kind as AnalyticsExportKind)) return kind as AnalyticsExportKind
  throw new Error('不支持的分析导出类型')
}

function serializeExportJob(row: {
  id: string
  status: string
  kind: string
  range_from: string
  range_to: string
  filters_json: string
  r2_key: string | null
  expires_at: string | null
  created_by: number
  created_at: string
  completed_at: string | null
  error_message: string
}): AnalyticsExportJob {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    filters: safeJson(row.filters_json),
    r2Key: row.r2_key,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
  }
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function defaultHeaders(kind: AnalyticsExportKind) {
  if (kind === 'paths') return ['from_route', 'to_route', 'transition_count']
  if (kind === 'clicks') return ['element_id', 'raw_click_count', 'effective_click_count']
  if (kind === 'source-pages') return ['source_channel', 'source_name', 'route_name', 'page_view_count']
  if (kind === 'source-clicks') return ['source_channel', 'source_name', 'element_id', 'raw_click_count']
  if (kind === 'invites') return ['invite_code_id', 'landing_count', 'register_count']
  if (kind === 'sessions') return ['session_id', 'date', 'source_channel']
  if (kind === 'pages' || kind === 'durations') return ['route_name', 'path', 'page_view_count']
  return ['date', 'source_channel', 'session_count']
}

function addDaysIso(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString()
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
