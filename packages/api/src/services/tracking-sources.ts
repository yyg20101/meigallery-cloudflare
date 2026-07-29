import {
  isAdAttributionProvider,
  type AdAttributionProvider,
  type AnalyticsSourceChannel,
} from '@meigallery/shared'
import { normalizeAnalyticsCampaignToken } from '@meigallery/shared/utils'
import { generateId } from '../utils/db'
import { sanitizeAnalyticsPath } from '../utils/analytics-url'
import { mergeD1Usage, readD1UsageMeta } from '../utils/analytics-cost'
import {
  buildAnalyticsConversionIndex,
  readAnalyticsConversionMetrics,
  sourceMetricKey,
} from './analytics-conversion-metrics'

type TrackingSourceDb = Pick<D1Database, 'prepare'>
type TrackingSourceStatus = 'active' | 'disabled'
type TrackingSourceChannel = Exclude<AnalyticsSourceChannel, 'invite'>

export class TrackingSourceError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'TrackingSourceError'
  }
}

export interface CreateTrackingSourceInput {
  name?: string
  sourceLabel?: string
  channel?: string
  slug?: string
  sourceCode?: string
  targetPath?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  adProvider?: string
  note?: string | null
  createdBy: number
}

export interface UpdateTrackingSourceInput {
  name?: string
  sourceLabel?: string
  channel?: string
  slug?: string
  sourceCode?: string
  targetPath?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  adProvider?: string
  status?: TrackingSourceStatus
  note?: string | null
}

export interface TrackingSourceItem {
  id: string
  name: string
  sourceLabel: string
  channel: TrackingSourceChannel
  slug: string
  sourceCode: string
  targetPath: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  adProvider: AdAttributionProvider | ''
  status: TrackingSourceStatus
  note: string
  createdBy: number
  createdAt: string
  updatedAt: string
  trackingPath: string
}

export interface TrackingSourceMetricItem extends TrackingSourceItem {
  visitorCount: number
  sessionCount: number
  pageViewCount: number
  galleryDetailCount: number
  contactClickCount: number
  registerCount: number
  membershipGrantCount: number
  activeSecondsTotal: number
}

interface TrackingSourceRow {
  id: string
  name: string
  channel: TrackingSourceChannel
  slug: string
  target_path: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_content?: string
  ad_provider: string
  status: TrackingSourceStatus
  note: string
  created_by: number
  created_at: string
  updated_at: string
}

interface TrackingSourceMetricRow extends TrackingSourceRow {
  visitor_count: number | null
  session_count: number | null
  page_view_count: number | null
  gallery_detail_count: number | null
  membership_grant_count: number | null
  active_seconds_total: number | null
}

const TRACKING_CHANNELS = new Set<TrackingSourceChannel>(['direct', 'search', 'social', 'referral', 'ad', 'internal', 'unknown'])
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,58}[a-z0-9]$/
const UTM_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/

export async function createTrackingSource(db: TrackingSourceDb, input: CreateTrackingSourceInput): Promise<TrackingSourceItem> {
  const name = normalizeRequiredText(input.sourceLabel ?? input.name, '来源自定义文案', 80)
  const channel = normalizeChannel(input.channel)
  const id = generateId('ats')
  if (input.sourceCode !== undefined || input.slug !== undefined) {
    throw new TrackingSourceError(400, '来源 code 由后台自动生成，创建时不需要填写')
  }
  if (input.utmSource !== undefined) {
    throw new TrackingSourceError(400, 'utm_source 与自动生成的来源 code 绑定，创建时不需要填写')
  }
  const slug = generateTrackingSourceCode(channel, id)
  const targetPath = normalizeTargetPath(input.targetPath)
  const utmSource = slug
  const utmMedium = normalizeUtmValue(input.utmMedium || defaultUtmMedium(channel), 'utm_medium')
  const utmCampaign = normalizeOptionalUtmValue(input.utmCampaign || slug, 'utm_campaign')
  const utmContent = normalizeOptionalUtmContent(input.utmContent)
  const adProvider = normalizeAdProvider(channel, input.adProvider)
  const note = normalizeOptionalText(input.note, 500)

  await assertUniqueTrackingSource(db, slug, utmSource)
  await db.prepare(`
    INSERT INTO analytics_tracking_sources (
      id, name, channel, slug, target_path, utm_source, utm_medium,
      utm_campaign, utm_content, ad_provider, note, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, name, channel, slug, targetPath, utmSource, utmMedium, utmCampaign, utmContent, adProvider, note, input.createdBy).run()

  return {
    id,
    name,
    sourceLabel: name,
    channel,
    slug,
    sourceCode: slug,
    targetPath,
    utmSource,
    utmMedium,
    utmCampaign,
    utmContent,
    adProvider,
    status: 'active',
    note,
    createdBy: input.createdBy,
    createdAt: '',
    updatedAt: '',
    trackingPath: buildTrackingPath({
      targetPath,
      slug,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
    }),
  }
}

export async function listTrackingSources(db: TrackingSourceDb): Promise<TrackingSourceItem[]> {
  const rows = await db.prepare(`
    SELECT id, name, channel, slug, target_path, utm_source, utm_medium,
           utm_campaign, utm_content, ad_provider, status, note, created_by, created_at, updated_at
    FROM analytics_tracking_sources
    ORDER BY created_at DESC
  `).all<TrackingSourceRow>()

  return rows.results.map(serializeTrackingSource)
}

export async function listTrackingSourcesWithMetrics(
  db: TrackingSourceDb,
  range: { from: string; to: string },
): Promise<TrackingSourceMetricItem[]> {
  return (await queryTrackingSourcesWithMetrics(db, range)).items
}

export async function queryTrackingSourcesWithMetrics(
  db: TrackingSourceDb,
  range: { from: string; to: string },
) {
  const [result, conversions] = await Promise.all([
    db.prepare(`
      SELECT
        ats.id, ats.name, ats.channel, ats.slug, ats.target_path, ats.utm_source,
        ats.utm_medium, ats.utm_campaign, ats.utm_content, ats.ad_provider, ats.status, ats.note, ats.created_by,
        ats.created_at, ats.updated_at,
        COALESCE(SUM(ads.visitor_count), 0) AS visitor_count,
        COALESCE(SUM(ads.session_count), 0) AS session_count,
        COALESCE(SUM(ads.page_view_count), 0) AS page_view_count,
        COALESCE(SUM(ads.gallery_detail_count), 0) AS gallery_detail_count,
        COALESCE(SUM(ads.membership_grant_count), 0) AS membership_grant_count,
        COALESCE(SUM(ads.active_seconds_total), 0) AS active_seconds_total
      FROM analytics_tracking_sources ats
      LEFT JOIN analytics_daily_sources ads
        ON ads.date BETWEEN ? AND ?
       AND ads.source_name = ats.slug
       AND ads.source_channel = ats.channel
      GROUP BY
        ats.id, ats.name, ats.channel, ats.slug, ats.target_path, ats.utm_source,
        ats.utm_medium, ats.utm_campaign, ats.utm_content, ats.ad_provider, ats.status, ats.note, ats.created_by,
        ats.created_at, ats.updated_at
      ORDER BY session_count DESC, ats.created_at DESC
    `).bind(range.from, range.to).all<TrackingSourceMetricRow>(),
    readAnalyticsConversionMetrics(db, range),
  ])
  const conversionIndex = buildAnalyticsConversionIndex(conversions.rows)

  return {
    items: result.results.map(row => {
      const counts = conversionIndex.bySource.get(sourceMetricKey(row.channel, row.slug, ''))
      return {
        ...serializeTrackingSource(row),
        visitorCount: Number(row.visitor_count ?? 0),
        sessionCount: Number(row.session_count ?? 0),
        pageViewCount: Number(row.page_view_count ?? 0),
        galleryDetailCount: Number(row.gallery_detail_count ?? 0),
        contactClickCount: counts?.contact_click_count ?? 0,
        registerCount: counts?.register_count ?? 0,
        membershipGrantCount: Number(row.membership_grant_count ?? 0),
        activeSecondsTotal: Number(row.active_seconds_total ?? 0),
      }
    }),
    usage: mergeD1Usage(readD1UsageMeta(result), conversions.usage),
  }
}

export async function updateTrackingSource(db: TrackingSourceDb, id: string, input: UpdateTrackingSourceInput) {
  const beforeRow = await getTrackingSourceRowById(db, id)
  const before = serializeTrackingSource(beforeRow)
  const requestedCode = input.sourceCode ?? input.slug
  if (requestedCode !== undefined && normalizeSlug(requestedCode) !== before.slug) {
    throw new TrackingSourceError(400, '来源 code 创建后不能修改；如需新 code，请创建新来源并停用旧来源')
  }
  if (input.utmSource !== undefined && normalizeUtmValue(input.utmSource, 'utm_source') !== before.utmSource) {
    throw new TrackingSourceError(400, 'utm_source 与来源 code 绑定，创建后不能修改')
  }
  if (input.channel !== undefined && normalizeChannel(input.channel) !== before.channel) {
    throw new TrackingSourceError(400, '来源渠道创建后不能修改；如需更换渠道，请创建新来源并停用旧来源')
  }
  if (input.adProvider !== undefined && normalizeAdProvider(before.channel, input.adProvider) !== before.adProvider) {
    throw new TrackingSourceError(400, '广告平台创建后不能修改；如需更换平台，请创建新来源并停用旧来源')
  }
  const next = {
    name: input.sourceLabel === undefined && input.name === undefined
      ? before.name
      : normalizeRequiredText(input.sourceLabel ?? input.name, '来源自定义文案', 80),
    channel: before.channel,
    slug: before.slug,
    targetPath: input.targetPath === undefined ? before.targetPath : normalizeTargetPath(input.targetPath),
    utmSource: before.utmSource,
    utmMedium: input.utmMedium === undefined ? before.utmMedium : normalizeUtmValue(input.utmMedium, 'utm_medium'),
    utmCampaign: input.utmCampaign === undefined ? before.utmCampaign : normalizeOptionalUtmValue(input.utmCampaign, 'utm_campaign'),
    utmContent: input.utmContent === undefined ? before.utmContent : normalizeOptionalUtmContent(input.utmContent),
    adProvider: before.adProvider,
    status: input.status ?? before.status,
    note: input.note === undefined ? before.note : normalizeOptionalText(input.note, 500),
  }
  if (!['active', 'disabled'].includes(next.status)) throw new TrackingSourceError(400, '推广来源状态无效')
  await assertUniqueTrackingSource(db, next.slug, next.utmSource, id)

  await db.prepare(`
    UPDATE analytics_tracking_sources
    SET name = ?, channel = ?, slug = ?, target_path = ?, utm_source = ?,
        utm_medium = ?, utm_campaign = ?, utm_content = ?, ad_provider = ?, status = ?, note = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    next.name,
    next.channel,
    next.slug,
    next.targetPath,
    next.utmSource,
    next.utmMedium,
    next.utmCampaign,
    next.utmContent,
    next.adProvider,
    next.status,
    next.note,
    id,
  ).run()

  return {
    before,
    after: {
      ...before,
      ...next,
      sourceLabel: next.name,
      sourceCode: next.slug,
      trackingPath: buildTrackingPath({
        targetPath: next.targetPath,
        slug: next.slug,
        utmSource: next.utmSource,
        utmMedium: next.utmMedium,
        utmCampaign: next.utmCampaign,
        utmContent: next.utmContent,
      }),
    },
  }
}

export function safeTrackingSourceAuditValue(source: Partial<TrackingSourceItem>) {
  return {
    id: source.id,
    name: source.name,
    sourceLabel: source.sourceLabel ?? source.name,
    channel: source.channel,
    slug: source.slug,
    sourceCode: source.sourceCode ?? source.slug,
    targetPath: source.targetPath,
    utmSource: source.utmSource,
    utmMedium: source.utmMedium,
    utmCampaign: source.utmCampaign,
    utmContent: source.utmContent,
    adProvider: source.adProvider,
    status: source.status,
    note: source.note,
  }
}

function serializeTrackingSource(row: TrackingSourceRow): TrackingSourceItem {
  return {
    id: row.id,
    name: row.name,
    sourceLabel: row.name,
    channel: row.channel,
    slug: row.slug,
    sourceCode: row.slug,
    targetPath: row.target_path,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content ?? '',
    adProvider: normalizeStoredAdProvider(row.ad_provider),
    status: row.status,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trackingPath: buildTrackingPath({
      targetPath: row.target_path,
      slug: row.slug,
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      utmContent: row.utm_content ?? '',
    }),
  }
}

async function getTrackingSourceRowById(db: TrackingSourceDb, id: string): Promise<TrackingSourceRow> {
  const row = await db.prepare(`
    SELECT id, name, channel, slug, target_path, utm_source, utm_medium,
           utm_campaign, utm_content, ad_provider, status, note, created_by, created_at, updated_at
    FROM analytics_tracking_sources
    WHERE id = ?
  `).bind(id).first<TrackingSourceRow>()
  if (!row) throw new TrackingSourceError(404, '推广来源不存在')
  return row
}

async function assertUniqueTrackingSource(db: TrackingSourceDb, slug: string, utmSource: string, excludeId?: string) {
  const existing = await db.prepare(`
    SELECT id, slug, utm_source
    FROM analytics_tracking_sources
    WHERE (slug = ? OR utm_source = ?)
      AND (? IS NULL OR id != ?)
    LIMIT 1
  `).bind(slug, utmSource, excludeId ?? null, excludeId ?? null).first<{ id: string; slug: string; utm_source: string }>()
  if (!existing) return
  if (existing.slug === slug) throw new TrackingSourceError(409, '来源短标识已存在')
  throw new TrackingSourceError(409, 'utm_source 已被其他推广来源使用')
}

function buildTrackingPath(input: {
  targetPath: string
  slug: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
}) {
  const url = new URL(input.targetPath, 'https://site.local')
  url.searchParams.set('mg_source', input.slug)
  url.searchParams.set('utm_source', input.utmSource)
  url.searchParams.set('utm_medium', input.utmMedium)
  if (input.utmCampaign) url.searchParams.set('utm_campaign', input.utmCampaign)
  if (input.utmContent) url.searchParams.set('utm_content', input.utmContent)
  return `${url.pathname}${url.search}`
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) throw new TrackingSourceError(400, `请填写${label}`)
  if (text.length > maxLength) throw new TrackingSourceError(400, `${label}不能超过 ${maxLength} 个字符`)
  return text
}

function normalizeOptionalText(value: unknown, maxLength: number) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.slice(0, maxLength)
}

function normalizeSlug(value: unknown) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (!SLUG_RE.test(slug)) {
    throw new TrackingSourceError(400, '来源 code 需为 3-60 位小写字母、数字、中划线或下划线')
  }
  return slug
}

function generateTrackingSourceCode(channel: TrackingSourceChannel, id: string) {
  const suffix = id
    .replace(/^ats_/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 14)
  return normalizeSlug(`${channel}-${suffix}`)
}

function normalizeChannel(value: unknown): TrackingSourceChannel {
  const raw = String(value ?? 'referral').trim().toLowerCase()
  if (raw === 'invite') throw new TrackingSourceError(400, '推广来源不能使用 invite 渠道')
  const channel = raw as TrackingSourceChannel
  if (!TRACKING_CHANNELS.has(channel)) throw new TrackingSourceError(400, '推广来源渠道无效')
  return channel
}

function normalizeAdProvider(channel: TrackingSourceChannel, value: unknown): AdAttributionProvider | '' {
  const provider = String(value ?? '').trim().toLowerCase()
  if (channel !== 'ad') {
    if (provider) throw new TrackingSourceError(400, '仅广告渠道可以绑定广告平台')
    return ''
  }
  if (isAdAttributionProvider(provider)) return provider
  throw new TrackingSourceError(400, '广告渠道必须明确绑定 Meta、TikTok 或 Google')
}

function normalizeStoredAdProvider(value: unknown): AdAttributionProvider | '' {
  return isAdAttributionProvider(value) ? value : ''
}

function normalizeTargetPath(value: unknown) {
  const path = sanitizeAnalyticsPath(String(value ?? '').trim() || '/')
  if (!path) throw new TrackingSourceError(400, '落地页路径无效')
  return path
}

function normalizeUtmValue(value: unknown, label: string) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  if (!UTM_RE.test(text)) {
    throw new TrackingSourceError(400, `${label} 需为 1-80 位小写字母、数字、点、中划线或下划线`)
  }
  return text
}

function normalizeOptionalUtmValue(value: unknown, label: string) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return normalizeUtmValue(text, label)
}

function normalizeOptionalUtmContent(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const normalized = normalizeAnalyticsCampaignToken(text, 80)
  if (!normalized) {
    throw new TrackingSourceError(400, 'utm_content 只能使用不含个人信息的字母、数字、点、中划线或下划线')
  }
  return normalized
}

function defaultUtmMedium(channel: TrackingSourceChannel) {
  if (channel === 'ad') return 'ad'
  if (channel === 'search') return 'search'
  if (channel === 'social') return 'social'
  if (channel === 'direct') return 'direct'
  if (channel === 'internal') return 'internal'
  return 'referral'
}
