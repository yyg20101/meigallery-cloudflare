export interface ConversionIdentity {
  visitorId: string
  sessionId: string
}

export const CONVERSION_IDENTITY_SESSION_KEY = 'mg_necessary_conversion_identity_v1'

const CONVERSION_ID_RE = /^[A-Za-z0-9_-]{8,120}$/

export function resolveConversionIdentity(analyticsIdentity: Partial<ConversionIdentity>): ConversionIdentity {
  const visitorId = normalizeConversionId(analyticsIdentity.visitorId)
  const sessionId = normalizeConversionId(analyticsIdentity.sessionId)
  if (visitorId && sessionId) return { visitorId, sessionId }

  const stored = readStoredIdentity()
  const fallback = stored ?? createNecessaryIdentity()
  if (!stored) persistIdentity(fallback)

  return {
    visitorId: visitorId || fallback.visitorId,
    sessionId: sessionId || fallback.sessionId,
  }
}

function readStoredIdentity(): ConversionIdentity | null {
  try {
    const raw = window.sessionStorage.getItem(CONVERSION_IDENTITY_SESSION_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<ConversionIdentity>
    const visitorId = normalizeConversionId(value.visitorId)
    const sessionId = normalizeConversionId(value.sessionId)
    return visitorId && sessionId ? { visitorId, sessionId } : null
  } catch {
    return null
  }
}

function persistIdentity(identity: ConversionIdentity) {
  try {
    window.sessionStorage.setItem(CONVERSION_IDENTITY_SESSION_KEY, JSON.stringify(identity))
  } catch {
    // 无可用 sessionStorage 时仍返回本次随机身份，不写长期存储。
  }
}

function createNecessaryIdentity(): ConversionIdentity {
  return {
    visitorId: `conversion_visitor_${randomId()}`,
    sessionId: `conversion_session_${randomId()}`,
  }
}

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '_')
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function normalizeConversionId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return CONVERSION_ID_RE.test(normalized) ? normalized : ''
}
