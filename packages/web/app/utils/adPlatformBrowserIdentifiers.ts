const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBCLID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const TIKTOK_CLICK_COOKIE = 'mg_ttclid'
const TIKTOK_CLICK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export type AdPlatformBrowserIdentifiers = {
  fbp?: string
  fbc?: string
  ttclid?: string
  ttp?: string
}

export function readAdPlatformBrowserIdentifiers(
  cookie: string,
  clickIds: { fbclid?: unknown; ttclid?: unknown },
  now = Date.now(),
): AdPlatformBrowserIdentifiers {
  const fbp = readCookie(cookie, '_fbp')
  const storedFbc = readCookie(cookie, '_fbc')
  const fbclid = firstText(clickIds.fbclid)
  const generatedFbc = FBCLID_PATTERN.test(fbclid) && Number.isFinite(now)
    ? `fb.1.${Math.trunc(now)}.${fbclid}`
    : ''
  const ttclid = safeIdentifier(firstText(clickIds.ttclid), 1_000)
    || safeIdentifier(readCookie(cookie, TIKTOK_CLICK_COOKIE, true), 1_000)
  const ttp = safeIdentifier(readCookie(cookie, '_ttp', true), 256)

  return {
    ...(FBP_PATTERN.test(fbp) ? { fbp } : {}),
    ...(FBC_PATTERN.test(generatedFbc) ? { fbc: generatedFbc } : FBC_PATTERN.test(storedFbc) ? { fbc: storedFbc } : {}),
    ...(ttclid ? { ttclid } : {}),
    ...(ttp ? { ttp } : {}),
  }
}

export function tikTokClickIdCookie(ttclid: unknown) {
  const value = safeIdentifier(firstText(ttclid), 1_000)
  return value
    ? `${TIKTOK_CLICK_COOKIE}=${encodeURIComponent(value)}; Max-Age=${TIKTOK_CLICK_MAX_AGE_SECONDS}; Path=/; SameSite=Lax; Secure`
    : ''
}

export function clearTikTokClickIdCookie() {
  return `${TIKTOK_CLICK_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`
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
