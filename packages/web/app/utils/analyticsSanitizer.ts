import type { AnalyticsConsentState, AnalyticsDeviceType, AnalyticsPropValue, AnalyticsSourceChannel } from '@meigallery/shared'
import { hasSensitiveAnalyticsUrl } from './facebookPixel'

const SAFE_QUERY_KEYS = new Set([
  'city',
  'content_type',
  'hair',
  'identity',
  'occupation',
  'page',
  'personality',
  'region',
  'region_group',
  'region_scope',
  'scene',
  'sort',
  'style',
  'tag',
  'tags',
])

const BLOCKED_PATH_PREFIXES = [
  '/admin',
  '/api',
  '/_nuxt',
  '/assets',
  '/images',
  '/media',
]

const RESOURCE_EXT_RE = /\.(?:avif|css|csv|gif|ico|jpeg|jpg|js|json|map|mp4|png|svg|webm|webp|woff2?)$/i
const SOURCE_CHANNELS = new Set<AnalyticsSourceChannel>(['direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown'])
const CONSENT_STATES = new Set<AnalyticsConsentState>(['granted', 'limited', 'denied'])

export function sanitizeAnalyticsPath(input: unknown): string | null {
  const raw = String(input ?? '').trim()
  if (!raw || hasSensitiveAnalyticsUrl(raw)) return null

  let url: URL
  try {
    url = new URL(raw, 'https://meigallery.local')
  } catch {
    return null
  }

  const pathname = normalizePathname(url.pathname)
  if (!pathname || isBlockedAnalyticsPath(pathname)) return null

  const params = new URLSearchParams()
  for (const [key, value] of url.searchParams.entries()) {
    if (!SAFE_QUERY_KEYS.has(key)) continue
      const safeValue = sanitizeAnalyticsTextValue(value, 80)
    if (safeValue) params.append(key, safeValue)
  }
  const qs = params.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

export function sanitizeReferrer(input: unknown, currentHost?: string | null) {
  const raw = String(input ?? '').trim()
  if (!raw || hasSensitiveAnalyticsUrl(raw)) return { referrer: '', referrerHost: '' }

  try {
    const url = new URL(raw)
    const host = url.host.toLowerCase()
    if (!host || host === String(currentHost ?? '').toLowerCase()) return { referrer: '', referrerHost: '' }
    return {
      referrer: `${url.protocol}//${host}${normalizePathname(url.pathname)}`,
      referrerHost: host,
    }
  } catch {
    return { referrer: '', referrerHost: '' }
  }
}

export function sanitizeAnalyticsTitle(input: unknown) {
  return sanitizeAnalyticsTextValue(input, 120)
}

function sanitizeAnalyticsTextValue(input: unknown, maxLength = 120) {
  return String(input ?? '')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted_email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted_phone]')
    .replace(/https?:\/\/\S+/g, '[redacted_url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function sanitizeAnalyticsProps(props: unknown): Record<string, AnalyticsPropValue> {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}
  const output: Record<string, AnalyticsPropValue> = {}
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{2,60}$/.test(key)) continue
    const normalized = normalizeAnalyticsPropValue(value)
    if (normalized !== undefined) output[key] = normalized
  }
  return output
}

export function normalizeAnalyticsSourceChannel(input: unknown): AnalyticsSourceChannel {
  const value = String(input ?? 'unknown').trim().toLowerCase() as AnalyticsSourceChannel
  return SOURCE_CHANNELS.has(value) ? value : 'unknown'
}

export function normalizeAnalyticsConsentState(input: unknown): AnalyticsConsentState {
  const value = String(input ?? 'limited').trim().toLowerCase() as AnalyticsConsentState
  return CONSENT_STATES.has(value) ? value : 'limited'
}

export function detectAnalyticsDeviceType(width: number | undefined = getViewportWidth()): AnalyticsDeviceType {
  if (typeof width !== 'number' || !Number.isFinite(width)) return 'unknown'
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

export function getViewportBucket(width: number | undefined = getViewportWidth()) {
  if (typeof width !== 'number' || !Number.isFinite(width)) return 0
  if (width < 768) return 360
  if (width < 1024) return 768
  if (width < 1440) return 1024
  return 1440
}

export function isBlockedAnalyticsPath(pathname: string) {
  const normalized = normalizePathname(pathname)
  if (BLOCKED_PATH_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true
  return RESOURCE_EXT_RE.test(normalized)
}

function normalizePathname(pathname: string) {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
  return normalized.replace(/\/{2,}/g, '/')
}

function normalizeAnalyticsPropValue(value: unknown): AnalyticsPropValue | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return sanitizeAnalyticsTextValue(value, 160)
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map(item => sanitizeAnalyticsTextValue(item, 80))
      .filter(Boolean)
      .slice(0, 20)
    return items.length ? items : undefined
  }
  return undefined
}

function getViewportWidth() {
  return typeof window !== 'undefined' ? window.innerWidth : undefined
}
