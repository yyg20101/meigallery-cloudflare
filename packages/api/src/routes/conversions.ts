import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import { recordContact } from '../services/conversions'
import { errorJson } from '../utils/api-error'
import { safeContactLinkUrl } from '../utils/contact-link-url'
import { generateContactLink } from '@meigallery/shared/constants'
import { AD_ATTRIBUTION_CONTEXT_COOKIE } from './ad-attribution'
import { buildAdPlatformUserData, readAdPlatformBrowserIdentifiersFromRequest } from '../utils/ad-platform-identifiers'
import { resolveRequestAdAttributionContext } from '../utils/request-ad-attribution-context'

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
  const attributionContext = await resolveRequestAdAttributionContext(
    c.env,
    getCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE),
    isPlainRecord(body.adAttributionSignals) ? body.adAttributionSignals : {},
    body.trackingSourceSlug,
  )
  const adPlatformUserData = attributionContext
    ? buildAdPlatformUserData(c.req.raw, readAdPlatformBrowserIdentifiersFromRequest(c.req.raw))
    : undefined
  const result = await recordContact(c.env, {
    visitorId, sessionId, userId: c.get('userId'), occurredAt: String(body.occurredAt || new Date().toISOString()),
    routeName: text(body.routeName, 120), path: text(body.path, 240), sourceChannel: text(body.sourceChannel, 40) || 'unknown',
    sourceName: text(body.sourceName, 120), trackingSourceSlug: text(body.trackingSourceSlug, 120),
    utmSource: text(body.utmSource, 120), utmMedium: text(body.utmMedium, 120), utmCampaign: text(body.utmCampaign, 120), utmContent: text(body.utmContent, 120),
    attributionContext, attributionSource: attributionContext ? 'context' : 'none', adPlatformUserData,
    contactMethodId: contact.id, contactPlatform: contact.platform, actionType: 'open_link',
    metadata: isPlainRecord(body.metadata) ? body.metadata : {},
  })
  return c.json({ data: result }, result.created ? 201 : 200)
})

function conversionId(value: unknown) { const normalized = typeof value === 'string' ? value.trim() : ''; return CONVERSION_ID_RE.test(normalized) ? normalized : '' }
function text(value: unknown, maximum: number) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum) }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
