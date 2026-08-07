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
import {
  claimAdminSafetyAppeal,
  decideAdminSafetyAppeal,
  getAdminSafetyAppeal,
  listAdminSafetyAppeals,
  parseAdminSafetyAppealListQuery,
  type AdminSafetyAppealDecisionInput,
} from '../../services/admin-app-safety-appeals'
import { AppMessagingError } from '../../services/app-messaging'
import {
  AppSafetyError,
  getAppMessagingRuntimeControl,
  getAppSafetyRuntimeConfig,
  requireAppSafetyAdminEnabled,
  requireAppSafetyAdminAppealsEnabled,
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

adminAppSafetyRoutes.get('/appeals', async (c) => {
  try {
    const config = appealsEnabledConfig(c.env)
    const query = parseAdminSafetyAppealListQuery({
      status: c.req.query('status'),
      limit: c.req.query('limit'),
    })
    return c.json({
      data: await listAdminSafetyAppeals(c.env.DB, c.get('userId')!, query),
      policyId: config.appealPolicyId,
    })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/appeals/:appealId/claim', async (c) => {
  try {
    const config = appealsEnabledConfig(c.env)
    const data = await claimAdminSafetyAppeal(
      c.env.DB,
      c.get('userId')!,
      c.req.param('appealId'),
      config.appealPolicyId,
      c.req.header('Idempotency-Key') ?? null,
      new Date(),
      config.requireAppealsProductionReady,
    )
    return c.json({ message: data.replayed ? '已返回原领取结果' : '申诉已领取', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.get('/appeals/:appealId', async (c) => {
  try {
    appealsEnabledConfig(c.env)
    requireAppealAccessReason(c.req.query('accessReason'))
    return c.json({ data: await getAdminSafetyAppeal(
      c.env.DB,
      c.get('userId')!,
      c.req.param('appealId'),
      c.get('appRequestId') || crypto.randomUUID(),
    ) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/appeals/:appealId/decision', async (c) => {
  try {
    const config = appealsEnabledConfig(c.env)
    const data = await decideAdminSafetyAppeal(
      c.env.DB,
      c.get('userId')!,
      c.req.param('appealId'),
      config.appealPolicyId,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminSafetyAppealDecisionInput>(),
      new Date(),
      config.requireAppealsProductionReady,
    )
    return c.json({ message: data.replayed ? '已返回原复核结论' : '复核结论已记录', data })
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

function appealsEnabledConfig(env: Bindings) {
  const config = getAppSafetyRuntimeConfig(env)
  requireAppSafetyAdminAppealsEnabled(config)
  return config
}

function requireSafetyAccessReason(value: string | undefined) {
  if (value !== 'safety_review') {
    throw new AppSafetyError(400, 'ACCESS_REASON_REQUIRED', '查看举报证据必须声明 safety_review')
  }
}

function requireAppealAccessReason(value: string | undefined) {
  if (value !== 'appeal_review') {
    throw new AppSafetyError(400, 'ACCESS_REASON_REQUIRED', '查看申诉说明和证据必须声明 appeal_review')
  }
}

function handleSafetyError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppSafetyError || error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
