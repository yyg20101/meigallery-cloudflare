import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { markPixelAttempted, recordContact } from '../services/conversions'
import { errorJson } from '../utils/api-error'
import { buildMetaCapiUserData } from '../utils/meta-browser-identifiers'
import { verifyPixelReceiptToken } from '../utils/pixel-receipt'

const PUBLIC_CONVERSION_ACTIONS = new Set(['contact'])
const CONVERSION_ID_RE = /^[A-Za-z0-9_-]{8,120}$/

export const conversionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

conversionRoutes.post('/events', async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json<Record<string, unknown>>()
  } catch {
    return errorJson(c, 400, '转化事件必须是有效 JSON', { code: 'CONVERSION_JSON_INVALID' })
  }

  const actionType = String(body.actionType || '')
  if (!PUBLIC_CONVERSION_ACTIONS.has(actionType)) {
    return errorJson(c, 400, '转化动作无效', { code: 'CONVERSION_ACTION_INVALID' })
  }

  const visitorId = normalizeConversionId(body.visitorId)
  const sessionId = normalizeConversionId(body.sessionId)
  if (!visitorId || !sessionId) {
    return errorJson(c, 400, '转化身份格式无效', { code: 'CONVERSION_ID_INVALID' })
  }

  const methodType = String(body.methodType || '').trim()
  const actionTarget = String(body.actionTarget || '').trim()
  if (!methodType || !actionTarget) {
    return errorJson(c, 400, '联系事件缺少必要上下文', { code: 'CONVERSION_CONTACT_CONTEXT_INVALID' })
  }

  const consentState = String(body.consentState || 'limited')
  const result = await recordContact(c.env, {
    visitorId,
    sessionId,
    userId: c.get('userId'),
    occurredAt: String(body.occurredAt || new Date().toISOString()),
    routeName: String(body.routeName || ''),
    path: String(body.path || ''),
    sourceChannel: String(body.sourceChannel || 'unknown'),
    sourceName: String(body.sourceName || ''),
    trackingSourceSlug: String(body.trackingSourceSlug || ''),
    utmSource: String(body.utmSource || ''),
    utmMedium: String(body.utmMedium || ''),
    utmCampaign: String(body.utmCampaign || ''),
    utmContent: String(body.utmContent || ''),
    consentState,
    methodType,
    actionTarget,
    metadata: isPlainRecord(body.metadata) ? body.metadata : {},
  }, {
    getMetaCapiUserData: () => buildMetaCapiUserData(c.req.raw, body.browserIdentifiers),
  })

  return c.json({ data: result }, result.created ? 201 : 200)
})

conversionRoutes.post('/pixel-receipts', async (c) => {
  try {
    const body = await c.req.json<{ deliveryId?: string; attempted?: boolean; receiptToken?: string }>()
    const claims = await verifyPixelReceiptToken(c.env.SESSION_SECRET, String(body.receiptToken || ''))
    if (body.attempted !== true || claims.deliveryId !== body.deliveryId) {
      return errorJson(c, 400, 'Pixel 回执无效', { code: 'PIXEL_RECEIPT_INVALID' })
    }
    const result = await markPixelAttempted(c.env.DB, claims)
    return c.json({ data: result })
  } catch {
    return errorJson(c, 400, 'Pixel 回执无效', { code: 'PIXEL_RECEIPT_INVALID' })
  }
})

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeConversionId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return CONVERSION_ID_RE.test(normalized) ? normalized : ''
}
