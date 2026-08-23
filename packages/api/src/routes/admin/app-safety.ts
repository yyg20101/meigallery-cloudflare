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
  type AdminSafetyAppealDecisionInput,
} from '../../services/admin-app-safety-appeals'
import {
  getAdminAppealQueueSummary,
  listAdminAppealQueue,
  parseAdminAppealQueueQuery,
} from '../../services/admin-app-appeal-queue'
import {
  updateAdminAppealReviewWorkflow,
  type AdminAppealReviewWorkflowInput,
} from '../../services/admin-app-appeal-review-workflow'
import {
  claimAdminServiceAppeal,
  decideAdminServiceAppeal,
  getAdminServiceAppeal,
} from '../../services/admin-app-service-appeals'
import {
  claimAdminConversationSafetyEscalation,
  decideAdminConversationSafetyEscalation,
  getAdminConversationSafetyEscalation,
  listAdminConversationSafetyEscalations,
  parseAdminConversationSafetyEscalationListQuery,
  type AdminConversationSafetyEscalationDecisionInput,
} from '../../services/admin-app-conversation-safety-escalations'
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

adminAppSafetyRoutes.get('/escalations', async (c) => {
  try {
    enabledConfig(c.env)
    const query = parseAdminConversationSafetyEscalationListQuery({
      status: c.req.query('status'),
      priority: c.req.query('priority'),
      limit: c.req.query('limit'),
    })
    return c.json({ data: await listAdminConversationSafetyEscalations(c.env.DB, c.get('userId')!, query) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/escalations/:escalationId/claim', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await claimAdminConversationSafetyEscalation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('escalationId'),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ message: data.replayed ? '已返回原领取结果' : '内部升级案件已领取', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.get('/escalations/:escalationId', async (c) => {
  try {
    enabledConfig(c.env)
    requireEscalationAccessReason(c.req.query('accessReason'))
    return c.json({ data: await getAdminConversationSafetyEscalation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('escalationId'),
      c.get('appRequestId') || crypto.randomUUID(),
    ) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/escalations/:escalationId/decision', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await decideAdminConversationSafetyEscalation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('escalationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminConversationSafetyEscalationDecisionInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原审核结论' : '内部升级案件结论已记录', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.get('/appeals', async (c) => {
  try {
    const config = appealsEnabledConfig(c.env)
    const query = parseAdminAppealQueueQuery({
      status: c.req.query('status'),
      sourceType: c.req.query('sourceType'),
      assignment: c.req.query('assignment'),
      query: c.req.query('query'),
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
    })
    return c.json({
      data: await listAdminAppealQueue(c.env.DB, c.get('userId')!, query),
      policyId: config.appealPolicyId,
    })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.get('/appeals/:appealId/summary', async (c) => {
  try {
    appealsEnabledConfig(c.env)
    return c.json({ data: await getAdminAppealQueueSummary(
      c.env.DB,
      c.get('userId')!,
      c.req.param('appealId'),
    ) })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/appeals/:appealId/claim', async (c) => {
  try {
    const config = appealsEnabledConfig(c.env)
    const appealId = c.req.param('appealId')
    const data = appealId.startsWith('bap_')
      ? await claimAdminServiceAppeal(
          c.env.DB,
          c.get('userId')!,
          appealId,
          config.appealPolicyId,
          c.req.header('Idempotency-Key') ?? null,
          new Date(),
          config.requireAppealsProductionReady,
        )
      : await claimAdminSafetyAppeal(
          c.env.DB,
          c.get('userId')!,
          appealId,
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
    const appealId = c.req.param('appealId')
    const requestId = c.get('appRequestId') || crypto.randomUUID()
    const data = appealId.startsWith('bap_')
      ? await getAdminServiceAppeal(c.env.DB, c.get('userId')!, appealId, requestId)
      : await getAdminSafetyAppeal(c.env.DB, c.get('userId')!, appealId, requestId)
    return c.json({ data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/appeals/:appealId/decision', async (c) => {
  try {
    const config = appealsEnabledConfig(c.env)
    const appealId = c.req.param('appealId')
    const input = await c.req.json<AdminSafetyAppealDecisionInput>()
    const data = appealId.startsWith('bap_')
      ? await decideAdminServiceAppeal(
          c.env.DB,
          c.get('userId')!,
          appealId,
          config.appealPolicyId,
          c.req.header('Idempotency-Key') ?? null,
          input,
          new Date(),
          config.requireAppealsProductionReady,
        )
      : await decideAdminSafetyAppeal(
          c.env.DB,
          c.get('userId')!,
          appealId,
          config.appealPolicyId,
          c.req.header('Idempotency-Key') ?? null,
          input,
          new Date(),
          config.requireAppealsProductionReady,
        )
    return c.json({ message: data.replayed ? '已返回原复核结论' : '复核结论已记录', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/appeals/:appealId/request-supplement', async (c) => {
  try {
    appealsEnabledConfig(c.env)
    const data = await updateAdminAppealReviewWorkflow(
      c.env.DB,
      c.get('userId')!,
      c.req.param('appealId'),
      'request_supplement',
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppealReviewWorkflowInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原补充请求' : '已请求用户补充必要说明', data })
  }
  catch (error) {
    return handleSafetyError(c, error)
  }
})

adminAppSafetyRoutes.post('/appeals/:appealId/escalate', async (c) => {
  try {
    appealsEnabledConfig(c.env)
    const data = await updateAdminAppealReviewWorkflow(
      c.env.DB,
      c.get('userId')!,
      c.req.param('appealId'),
      'escalate',
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppealReviewWorkflowInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原升级结果' : '申诉已进入升级复核', data })
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

function requireEscalationAccessReason(value: string | undefined) {
  if (value !== 'safety_escalation_review') {
    throw new AppSafetyError(400, 'ACCESS_REASON_REQUIRED', '查看内部升级说明和证据必须声明 safety_escalation_review')
  }
}

function handleSafetyError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppSafetyError || error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
