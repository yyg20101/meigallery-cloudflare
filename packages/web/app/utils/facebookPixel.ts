interface PixelRuntimeConfig {
  public: {
    appEnv?: string
    facebookPixelAllowDev?: string
    facebookPixelDevId?: string
  }
}

interface PixelSiteSettings {
  enabled: boolean
  pixelId: string
  debugEnabled: boolean
}

export const FACEBOOK_PIXEL_SCRIPT_SRC = 'https://connect.facebook.net/en_US/fbevents.js'

const BLOCKED_ANALYTICS_PARAM_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authtoken',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'jwt',
  'password',
  'passwd',
  'pwd',
  'refreshtoken',
  'secret',
  'securitytoken',
  'session',
  'sessionid',
  'sig',
  'signature',
  'signed',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
])

export function normalizePixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  return /^\d{5,30}$/.test(pixelId) ? pixelId : ''
}

export function isAdminPath(path: string) {
  return path === '/admin' || path.startsWith('/admin/')
}

export function sanitizeAnalyticsText(value: unknown, maxLength = 80) {
  return String(value ?? '')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted_email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted_phone]')
    .replace(/https?:\/\/\S+/g, '[redacted_url]')
    .replace(/(?:^|[?\s&#;])([^=\s&?#;]+)=([^\s&?#;]+)/g, (match, rawName: string) => {
      return isBlockedAnalyticsParamName(rawName) ? match.replace(/=.*/, '=[redacted_credential]') : match
    })
    .trim()
    .slice(0, maxLength)
}

export function hasSensitiveAnalyticsUrl(value: unknown, depth = 0) {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  if (depth > 3) return true

  let parsed: URL
  try {
    parsed = new URL(raw, 'https://meigallery.local')
  } catch {
    return false
  }

  for (const [name, target] of parsed.searchParams.entries()) {
    if (isBlockedAnalyticsParamName(name)) return true
    if (hasBlockedParamAssignment(target)) return true
    if (hasSensitiveAnalyticsUrl(target, depth + 1)) return true
  }
  if (hasBlockedParamAssignment(parsed.hash)) return true
  for (const name of getFragmentParamNames(parsed.hash)) {
    if (isBlockedAnalyticsParamName(name)) return true
  }
  return false
}

export function createFacebookPixelScript(documentRef: Document = document) {
  const script = documentRef.createElement('script')
  script.async = true
  script.referrerPolicy = 'no-referrer'
  script.src = FACEBOOK_PIXEL_SCRIPT_SRC
  return script
}

export function resolveFacebookPixelConfig(settings: PixelSiteSettings, runtimeConfig: PixelRuntimeConfig) {
  const appEnv = runtimeConfig.public.appEnv || 'development'
  const debugEnabled = settings.debugEnabled

  if (appEnv === 'production') {
    return {
      enabled: settings.enabled && !!normalizePixelId(settings.pixelId),
      pixelId: normalizePixelId(settings.pixelId),
      debugEnabled,
    }
  }

  const allowDev = runtimeConfig.public.facebookPixelAllowDev === 'true'
  const devPixelId = normalizePixelId(runtimeConfig.public.facebookPixelDevId)
  return {
    enabled: allowDev && !!devPixelId,
    pixelId: devPixelId,
    debugEnabled,
  }
}

function isBlockedAnalyticsParamName(name: string) {
  return BLOCKED_ANALYTICS_PARAM_NAMES.has(name.toLowerCase().replace(/[-_]/g, ''))
}

function hasBlockedParamAssignment(value: string) {
  const variants = new Set([value, safeDecodeURIComponent(value)])
  for (const variant of variants) {
    for (const match of variant.matchAll(/(?:^|[?#&;\s])([^=\s&?#;]+)=/g)) {
      if (isBlockedAnalyticsParamName(match[1] ?? '')) return true
    }
  }
  return false
}

function getFragmentParamNames(hash: string) {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment) return []

  const variants = new Set([fragment, safeDecodeURIComponent(fragment)])
  const names: string[] = []
  for (const variant of variants) {
    for (const match of variant.matchAll(/(?:^|[?#&;])([^=&#?;/]+)=/g)) {
      names.push(match[1] ?? '')
    }
  }
  return names
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
