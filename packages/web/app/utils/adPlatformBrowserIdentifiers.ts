import type { AdAttributionProvider } from '@meigallery/shared'
import { ATTRIBUTION_LIMITS } from '@meigallery/shared/constants'

const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = new RegExp(
  `^fb\\.1\\.\\d{10,16}\\.[A-Za-z0-9._-]{1,${ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH}}$`,
)
const FBCLID_PATTERN = new RegExp(
  `^[A-Za-z0-9._-]{1,${ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH}}$`,
)
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const TIKTOK_CLICK_COOKIE = 'mg_ttclid'
const TIKTOK_CLICK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export type AdPlatformBrowserIdentifiers = {
  fbp?: string
  fbc?: string
  ttclid?: string
  ttp?: string
}

type BrowserClickIds = {
  fbclid?: unknown
  ttclid?: unknown
  gclid?: unknown
  gbraid?: unknown
  wbraid?: unknown
}

export function readAdPlatformBrowserIdentifiers(
  provider: AdAttributionProvider,
  cookie: string,
  clickIds: BrowserClickIds,
  now = Date.now(),
): AdPlatformBrowserIdentifiers {
  if (provider === 'meta') return readMetaIdentifiers(cookie, clickIds.fbclid, now)
  if (provider === 'tiktok') return readTikTokIdentifiers(cookie, clickIds.ttclid)
  return {}
}

export function projectAdClickCookie(provider: AdAttributionProvider, clickIds: BrowserClickIds) {
  if (provider !== 'tiktok') return ''
  const value = safeIdentifier(firstText(clickIds.ttclid), ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
  return value
    ? `${TIKTOK_CLICK_COOKIE}=${encodeURIComponent(value)}; Max-Age=${TIKTOK_CLICK_MAX_AGE_SECONDS}; Path=/; SameSite=Lax; Secure`
    : ''
}

export function clearProjectAdClickCookies() {
  return [`${TIKTOK_CLICK_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`]
}

function readMetaIdentifiers(cookie: string, value: unknown, now: number) {
  const fbp = readCookie(cookie, '_fbp')
  const storedFbc = readCookie(cookie, '_fbc')
  const fbclid = firstText(value)
  const generatedFbc = FBCLID_PATTERN.test(fbclid) && Number.isFinite(now)
    ? `fb.1.${Math.trunc(now)}.${fbclid}`
    : ''
  return {
    ...(FBP_PATTERN.test(fbp) ? { fbp } : {}),
    ...(FBC_PATTERN.test(generatedFbc) ? { fbc: generatedFbc } : FBC_PATTERN.test(storedFbc) ? { fbc: storedFbc } : {}),
  }
}

function readTikTokIdentifiers(cookie: string, value: unknown) {
  const ttclid = safeIdentifier(firstText(value), ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
    || safeIdentifier(
      readCookie(cookie, TIKTOK_CLICK_COOKIE, true),
      ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH,
    )
  const ttp = safeIdentifier(readCookie(cookie, '_ttp', true), 256)
  return {
    ...(ttclid ? { ttclid } : {}),
    ...(ttp ? { ttp } : {}),
  }
}

function readCookie(cookie: string, name: string, decode = false) {
  for (const item of String(cookie || '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue
    const value = item.slice(separator + 1).trim()
    if (!decode) return value
    try { return decodeURIComponent(value) }
    catch { return '' }
  }
  return ''
}

function safeIdentifier(value: string, maxLength: number) {
  return value && value.length <= maxLength && !CONTROL_CHARACTER_PATTERN.test(value) ? value : ''
}

function firstText(value: unknown) {
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '')
}
