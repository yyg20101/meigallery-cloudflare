import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  AttributionPrivacyPolicyError,
  readAttributionPrivacyPolicy,
  saveAttributionPrivacyPolicy,
} from '../../services/attribution-privacy-policy'
import { errorJson } from '../../utils/api-error'
import { writeAuditLog } from '../../utils/permission'

const ALLOWED_FIELDS = new Set(['defaultMode', 'priorConsentCountryCodes'])
const MAX_BODY_BYTES = 8 * 1024

export const adminAttributionPrivacyPolicyRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAttributionPrivacyPolicyRoutes.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

adminAttributionPrivacyPolicyRoutes.get('/', async (c) => {
  return c.json({ data: await readAttributionPrivacyPolicy(c.env.DB) })
})

adminAttributionPrivacyPolicyRoutes.patch('/', async (c) => {
  const actorId = c.get('userId')
  if (c.get('userRole') !== 'owner' || !Number.isSafeInteger(actorId) || Number(actorId) <= 0) {
    return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
  }

  try {
    const contentLength = Number(c.req.header('Content-Length') || 0)
    if (contentLength > MAX_BODY_BYTES) return invalidPolicy(c)
    const body = await c.req.json<Record<string, unknown>>()
    if (!isPlainRecord(body)
      || Object.keys(body).some(key => !ALLOWED_FIELDS.has(key))
      || typeof body.defaultMode !== 'string'
      || !Array.isArray(body.priorConsentCountryCodes)) {
      return invalidPolicy(c)
    }
    const before = await readAttributionPrivacyPolicy(c.env.DB)
    const after = await saveAttributionPrivacyPolicy(c.env.DB, {
      defaultMode: body.defaultMode as never,
      priorConsentCountryCodes: body.priorConsentCountryCodes as string[],
      actorId: Number(actorId),
    })
    await writeAuditLog(c.env.DB, {
      adminId: Number(actorId),
      action: 'attribution.privacy_policy.update',
      targetType: 'attribution_privacy_policy',
      targetId: 'global',
      beforeValue: before,
      afterValue: after,
    })
    return c.json({ data: after })
  }
  catch (error) {
    if (error instanceof AttributionPrivacyPolicyError || error instanceof SyntaxError) return invalidPolicy(c)
    return errorJson(c, 503, '地区归因策略暂时不可用', { code: 'ATTRIBUTION_PRIVACY_POLICY_UNAVAILABLE' })
  }
})

function invalidPolicy(c: Parameters<typeof errorJson>[0]) {
  return errorJson(c, 400, '地区归因策略无效', { code: 'ATTRIBUTION_PRIVACY_POLICY_INVALID' })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
