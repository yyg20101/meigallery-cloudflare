import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { recordConversionAction } from '../services/conversions'
import { errorJson } from '../utils/api-error'

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
    consentState: String(body.consentState || 'limited'),
    methodType: String(body.methodType || ''),
    actionTarget: String(body.actionTarget || ''),
    metadata: isPlainRecord(body.metadata) ? body.metadata : {},
  })

  return c.json({ data: result }, result.created ? 201 : 200)
})

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
