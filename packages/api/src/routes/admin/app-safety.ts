import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import {
  claimAdminSafetyReport,
  decideAdminSafetyReport,
  getAdminSafetyReport,
  listAdminSafetyReports,
  parseAdminSafetyReportListQuery,
  updateAdminMessagingRuntimeControl,
  type AdminMessagingRuntimeControlInput,
  type AdminSafetyReportDecisionInput,
} from '../../services/admin-app-safety'
import { AppMessagingError } from '../../services/app-messaging'
import {
  AppSafetyError,
  getAppMessagingRuntimeControl,
  getAppSafetyRuntimeConfig,
  requireAppSafetyAdminEnabled,
} from '../../services/app-safety'
import { errorJson } from '../../utils/api-error'

export const adminAppSafetyRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppSafetyRoutes.get('/reports', async (c) => {
  try {
    enabledConfig(c.env)
    const query = parseAdminSafetyReportListQuery({
      status: c.req.query('status'),
      priority: c.req.query('priority'),
      targetType: c.req.query('targetType'),
      limit: c.req.query('limit'),
    })
    return c.json({ data: await listAdminSafetyReports(c.env.DB, c.get('userId')!, query) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/reports/:reportId/claim', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await claimAdminSafetyReport(
      c.env.DB,
      c.get('userId')!,
      c.req.param('reportId'),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ message: data.replayed ? '已返回原领取结果' : '举报已领取', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.get('/reports/:reportId', async (c) => {
  try {
    enabledConfig(c.env)
    requireSafetyAccessReason(c.req.query('accessReason'))
    return c.json({ data: await getAdminSafetyReport(
      c.env.DB,
      c.get('userId')!,
      c.req.param('reportId'),
      c.get('appRequestId') || crypto.randomUUID(),
    ) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/reports/:reportId/decision', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await decideAdminSafetyReport(
      c.env.DB,
      c.get('userId')!,
      c.req.param('reportId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminSafetyReportDecisionInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原审核结论' : '审核结论已记录', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.get('/runtime-control', async (c) => {
  try {
    enabledConfig(c.env)
    return c.json({ data: await getAppMessagingRuntimeControl(c.env.DB) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.patch('/runtime-control', requireOwner, async (c) => {
  try {
    enabledConfig(c.env)
    const data = await updateAdminMessagingRuntimeControl(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMessagingRuntimeControlInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原运行控制结果' : '运行控制已更新', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppSafetyRuntimeConfig(env)
  requireAppSafetyAdminEnabled(config)
  return config
}

function requireSafetyAccessReason(value: string | undefined) {
  if (value !== 'safety_review') {
    throw new AppSafetyError(400, 'ACCESS_REASON_REQUIRED', '查看举报证据必须声明 safety_review')
  }
}

function handleSafetyError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppSafetyError || error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
