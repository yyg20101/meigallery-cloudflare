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
    .replace(/(?:token|session|cookie)=[^\s&]+/gi, '[redacted_token]')
    .trim()
    .slice(0, maxLength)
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
