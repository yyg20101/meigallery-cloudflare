import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { markPixelAttempted, recordConversionAction } from '../services/conversions'
import { errorJson } from '../utils/api-error'
import { buildMetaCapiUserData } from '../utils/meta-browser-identifiers'
import { verifyPixelReceiptToken } from '../utils/pixel-receipt'

const PUBLIC_CONVERSION_ACTIONS = new Set(['contact', 'complete_registration'])

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

  const consentState = String(body.consentState || 'limited')
  const result = await recordConversionAction(c.env, {
    actionType: actionType as 'contact' | 'complete_registration',
    visitorId: String(body.visitorId || ''),
    sessionId: String(body.sessionId || ''),
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
    methodType: String(body.methodType || ''),
    actionTarget: String(body.actionTarget || ''),
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
