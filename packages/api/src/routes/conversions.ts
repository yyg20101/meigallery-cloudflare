import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { ATTRIBUTION_CONTEXT_COOKIE_NAME } from '@meigallery/shared'
import type { Bindings, Variables } from '../index'
import { routeContactConversion } from '../services/attribution-contact-router'
import { errorJson } from '../utils/api-error'
import { safeContactLinkUrl } from '../utils/contact-link-url'
import { generateContactLink } from '@meigallery/shared/constants'
import { resolveRequestMarketingConsent } from '../utils/marketing-consent-request'
import { AD_ATTRIBUTION_CONTEXT_COOKIE } from '../utils/ad-attribution-cookie'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import { resolveTrustedAdAttributionContext } from '../utils/ad-attribution-context'
import { buildAdPlatformUserData, readAdPlatformBrowserIdentifiersFromRequest } from '../utils/ad-platform-identifiers'
import { recordBrowserAttemptReceipt } from '../services/ad-platform/browser-attempt-receipt'

const CONVERSION_ID_RE = /^[A-Za-z0-9_-]{8,120}$/

export const conversionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

conversionRoutes.post('/events', async (c) => {
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() }
  catch { return errorJson(c, 400, '转化事件必须是有效 JSON', { code: 'CONVERSION_JSON_INVALID' }) }
  if (body.actionType !== 'open_link') {
    return errorJson(c, 400, '公开转化动作无效', { code: 'PUBLIC_CONVERSION_ACTION_INVALID' })
  }
  const visitorId = conversionId(body.visitorId)
  const sessionId = conversionId(body.sessionId)
  const contactMethodId = conversionId(body.contactMethodId)
  if (!visitorId || !sessionId || !contactMethodId) {
    return errorJson(c, 400, '联系转化上下文无效', { code: 'PUBLIC_CONVERSION_ACTION_INVALID' })
  }
  const contact = await c.env.DB.prepare(`
    SELECT id, platform, value, link_url
    FROM contact_methods
    WHERE id = ? AND enabled = 1
    LIMIT 1
  `).bind(contactMethodId).first<{ id: string, platform: string, value: string, link_url: string | null }>()
  const targetUrl = contact
    ? (contact.link_url ? safeContactLinkUrl(contact.link_url) : safeContactLinkUrl(generateContactLink(contact.platform, contact.value)))
    : null
  if (!contact || !contact.platform.trim() || !targetUrl) {
    return errorJson(c, 400, '公开转化动作无效', { code: 'PUBLIC_CONVERSION_ACTION_INVALID' })
  }
  const { consent: consentSnapshot } = await resolveRequestMarketingConsent(c, body.consentState)
  const attributionContext = consentSnapshot.marketingAllowed ? await trustedAttributionContext(c) : null
  const adPlatformUserData = consentSnapshot.marketingAllowed
    ? buildAdPlatformUserData(c.req.raw, readAdPlatformBrowserIdentifiersFromRequest(c.req.raw))
    : undefined
  const result = await routeContactConversion(c.env, {
    conversion: {
    visitorId, sessionId, userId: c.get('userId'), occurredAt: String(body.occurredAt || new Date().toISOString()),
    routeName: text(body.routeName, 120), path: text(body.path, 240), sourceChannel: text(body.sourceChannel, 40) || 'unknown',
    sourceName: text(body.sourceName, 120), trackingSourceSlug: text(body.trackingSourceSlug, 120),
    utmSource: text(body.utmSource, 120), utmMedium: text(body.utmMedium, 120), utmCampaign: text(body.utmCampaign, 120), utmContent: text(body.utmContent, 120),
    consentSnapshot, attributionContext, attributionSource: attributionContext ? 'context' : 'none', adPlatformUserData,
    contactMethodId: contact.id, contactPlatform: contact.platform, actionType: 'open_link',
    metadata: isPlainRecord(body.metadata) ? body.metadata : {},
    },
    sourceContextToken: consentSnapshot.marketingAllowed
      ? readOpaqueAttributionContextToken(c)
      : null,
    legacyContext: attributionContext,
    requestMetadata: consentSnapshot.adUserDataAllowed
      ? {
          ...(adPlatformUserData?.clientIpAddress
            ? { clientIp: adPlatformUserData.clientIpAddress }
            : {}),
          ...(adPlatformUserData?.clientUserAgent
            ? { userAgent: adPlatformUserData.clientUserAgent }
            : {}),
        }
      : {},
  })
  return c.json({ data: result }, result.created ? 201 : 200)
})

conversionRoutes.post('/browser-attempt', async (c) => {
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() }
  catch { return errorJson(c, 400, 'Browser 回执必须是有效 JSON', { code: 'BROWSER_ATTEMPT_RECEIPT_INVALID' }) }
  const deliveryId = conversionId(body.deliveryId)
  const provider = attributionProvider(body.provider)
  const receiptToken = typeof body.receiptToken === 'string' ? body.receiptToken : ''
  if (!deliveryId || !provider || receiptToken.length < 20 || receiptToken.length > 160) {
    return errorJson(c, 400, 'Browser 回执无效', { code: 'BROWSER_ATTEMPT_RECEIPT_INVALID' })
  }
  let result: Awaited<ReturnType<typeof recordBrowserAttemptReceipt>>
  try {
    result = await recordBrowserAttemptReceipt({
      db: c.env.DB,
      keys: await loadAttributionCryptoKeys(c.env),
      deliveryId,
      provider,
      receiptToken,
    })
  }
  catch {
    return errorJson(c, 400, 'Browser 回执无效', { code: 'BROWSER_ATTEMPT_RECEIPT_INVALID' })
  }
  if (!result.accepted) {
    return errorJson(c, 400, 'Browser 回执无效', { code: 'BROWSER_ATTEMPT_RECEIPT_INVALID' })
  }
  return c.json({ data: { accepted: true } })
})

async function trustedAttributionContext(c: Parameters<typeof getCookie>[0]) {
  try {
    const keys = await loadAttributionCryptoKeys(c.env)
    const context = await resolveTrustedAdAttributionContext(keys, getCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE))
    return context
  } catch { return null }
}

function readOpaqueAttributionContextToken(
  c: Parameters<typeof getCookie>[0],
): string | null {
  const value = getCookie(c, ATTRIBUTION_CONTEXT_COOKIE_NAME)
  return typeof value === 'string'
    && value.length >= 4
    && value.length <= 4_096
    && !/\p{Cc}/u.test(value)
    ? value
    : null
}

function conversionId(value: unknown) { const normalized = typeof value === 'string' ? value.trim() : ''; return CONVERSION_ID_RE.test(normalized) ? normalized : '' }
function text(value: unknown, maximum: number) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum) }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function attributionProvider(value: unknown) { return value === 'meta' || value === 'tiktok' || value === 'google' ? value : null }
