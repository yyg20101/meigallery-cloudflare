import { normalizeHomeAdScheduleRange } from './home-ad-schedule'
import { normalizeHomeAdUrl } from './home-ad-settings'
import { normalizePublicSettingUrl } from './public-setting-url'

export const HOME_AD_PLACEMENT = 'home_after_hero'

const HOME_AD_FIELD_LIMITS: Record<string, { label: string; maxLength: number; required?: boolean }> = {
  eyebrow: { label: '广告眉标', maxLength: 16 },
  title: { label: '广告标题', maxLength: 64, required: true },
  summary: { label: '广告摘要', maxLength: 180 },
  ctaLabel: { label: '按钮文案', maxLength: 16 },
  sponsor: { label: '赞助/来源说明', maxLength: 40 },
}

export interface HomeAdRow {
  id: string
  placement: string
  eyebrow: string
  title: string
  summary: string
  cta_label: string
  target_url: string
  sponsor: string
  image_url: string
  image_key: string | null
  enabled: number
  starts_at: string
  ends_at: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface HomeAdPayload {
  placement?: unknown
  eyebrow?: unknown
  title?: unknown
  summary?: unknown
  ctaLabel?: unknown
  targetUrl?: unknown
  sponsor?: unknown
  imageUrl?: unknown
  enabled?: unknown
  startsAt?: unknown
  endsAt?: unknown
}

export interface NormalizedHomeAd {
  placement: string
  eyebrow: string
  title: string
  summary: string
  ctaLabel: string
  targetUrl: string
  sponsor: string
  imageUrl: string
  enabled: boolean
  startsAt: string
  endsAt: string
}

export function normalizeHomeAdPayload(payload: HomeAdPayload, current?: HomeAdRow): NormalizedHomeAd {
  const merged = {
    placement: payload.placement ?? current?.placement ?? HOME_AD_PLACEMENT,
    eyebrow: payload.eyebrow ?? current?.eyebrow ?? '',
    title: payload.title ?? current?.title ?? '',
    summary: payload.summary ?? current?.summary ?? '',
    ctaLabel: payload.ctaLabel ?? current?.cta_label ?? '查看详情',
    targetUrl: payload.targetUrl ?? current?.target_url ?? '/discover?sort=hot',
    sponsor: payload.sponsor ?? current?.sponsor ?? '',
    imageUrl: payload.imageUrl ?? current?.image_url ?? '',
    enabled: payload.enabled ?? (current ? current.enabled === 1 : true),
    startsAt: payload.startsAt ?? current?.starts_at ?? '',
    endsAt: payload.endsAt ?? current?.ends_at ?? '',
  }

  const placement = normalizePlacement(merged.placement)
  const eyebrow = normalizeTextField('eyebrow', merged.eyebrow)
  const title = normalizeTextField('title', merged.title)
  const summary = normalizeTextField('summary', merged.summary)
  const ctaLabel = normalizeTextField('ctaLabel', merged.ctaLabel) || '查看详情'
  const sponsor = normalizeTextField('sponsor', merged.sponsor)
  const targetUrl = normalizeHomeAdUrl(merged.targetUrl)
  const imageUrl = normalizeHomeAdImageUrl(merged.imageUrl)
  const enabled = normalizeBoolean(merged.enabled)
  const range = normalizeHomeAdScheduleRange(String(merged.startsAt ?? ''), String(merged.endsAt ?? ''))

  if (!targetUrl) {
    throw new Error('广告跳转链接只允许公开前台路径或 https 外链')
  }

  return {
    placement,
    eyebrow,
    title,
    summary,
    ctaLabel,
    targetUrl,
    sponsor,
    imageUrl,
    enabled,
    startsAt: range.startsAt,
    endsAt: range.endsAt,
  }
}

export function serializeHomeAd(row: HomeAdRow) {
  return {
    id: row.id,
    placement: row.placement,
    eyebrow: row.eyebrow,
    title: row.title,
    summary: row.summary,
    ctaLabel: row.cta_label,
    targetUrl: row.target_url,
    sponsor: row.sponsor,
    imageUrl: row.image_url,
    imageKey: row.image_key,
    enabled: row.enabled === 1,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializePublicHomeAd(row: HomeAdRow, now = new Date()) {
  const safeUrl = safeHomeAdUrl(row.target_url)
  const safeTitle = safeTextField('title', row.title)
  if (!row.id || !safeTitle || !safeUrl) return null
  if (!isHomeAdCurrentlyActive(row.enabled === 1, row.starts_at, row.ends_at, now)) return null

  return {
    id: row.id,
    eyebrow: safeTextField('eyebrow', row.eyebrow),
    title: safeTitle,
    summary: safeTextField('summary', row.summary),
    ctaLabel: safeTextField('ctaLabel', row.cta_label) || '查看详情',
    targetUrl: safeUrl,
    sponsor: safeTextField('sponsor', row.sponsor),
    imageUrl: safeHomeAdImageUrl(row.image_url),
    sortOrder: row.sort_order,
  }
}

export function normalizeHomeAdImageUrl(value: unknown) {
  const url = normalizePublicSettingUrl(value, '广告大图 URL')
  if (!url || url.startsWith('https://')) return url
  if (url.startsWith('/api/media/public/home-ads/')) return url
  throw new Error('广告大图 URL 只允许广告公开媒体路径或 https 图片链接')
}

export function safeHomeAdImageUrl(value: unknown) {
  try {
    return normalizeHomeAdImageUrl(value)
  } catch {
    return ''
  }
}

export function safeHomeAdUrl(value: unknown) {
  try {
    return normalizeHomeAdUrl(value)
  } catch {
    return ''
  }
}

export function isExpectedHomeAdImageKey(key: string, adId: string) {
  return key.startsWith(`home-ads/${adId}/`) && !key.includes('..') && !key.includes('\\')
}

export function isHomeAdCurrentlyActive(enabled: boolean, startsAt: unknown, endsAt: unknown, now = new Date()) {
  if (!enabled) return false
  const starts = safeDate(startsAt)
  const ends = safeDate(endsAt)
  if (startsAt && !starts) return false
  if (endsAt && !ends) return false
  if (starts && now < starts) return false
  if (ends && now >= ends) return false
  return true
}

function normalizePlacement(value: unknown) {
  const placement = String(value ?? '').trim()
  if (!placement || placement === HOME_AD_PLACEMENT) return HOME_AD_PLACEMENT
  throw new Error('广告位置暂仅支持首页轮播位')
}

function normalizeTextField(field: string, value: unknown) {
  const config = HOME_AD_FIELD_LIMITS[field]
  if (!config) return String(value ?? '')
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!text && config.required) throw new Error(`${config.label}不能为空`)
  if (hasControlCharacter(text)) throw new Error(`${config.label}不能包含控制字符`)
  if (text.length > config.maxLength) throw new Error(`${config.label}不能超过 ${config.maxLength} 个字符`)
  return text
}

function safeTextField(field: string, value: unknown) {
  try {
    return normalizeTextField(field, value)
  } catch {
    return ''
  }
}

function normalizeBoolean(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function safeDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function hasControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
