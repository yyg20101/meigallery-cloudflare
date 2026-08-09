import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  claimAdminConversationQualitySample,
  createAdminConversationQualitySelectionRun,
  decideAdminConversationQualitySample,
  getAdminConversationQualitySample,
  getAdminConversationQualitySnapshot,
  parseAdminConversationQualityListQuery,
  updateAdminConversationQualityTask,
  voidAdminConversationQualitySample,
  type ClaimQualitySampleInput,
  type CreateQualitySelectionRunInput,
  type DecideQualitySampleInput,
  type UpdateQualityTaskInput,
  type VoidQualitySampleInput,
} from '../../services/admin-app-conversation-quality'
import {
  AppMessagingError,
  getAppMessagingRuntimeConfig,
  requireAppMessagingAdminEnabled,
} from '../../services/app-messaging'
import { errorJson } from '../../utils/api-error'

export const adminAppConversationQualityRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

adminAppConversationQualityRoutes.get('/', async (c) => {
  try {
    enabledConfig(c.env)
    const query = parseAdminConversationQualityListQuery({
      status: c.req.query('status'),
      groupId: c.req.query('groupId'),
      limit: c.req.query('limit'),
    })
    return c.json({
      data: await getAdminConversationQualitySnapshot(c.env.DB, actor(c), query),
    })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationQualityRoutes.post('/selection-runs', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await createAdminConversationQualitySelectionRun(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateQualitySelectionRunInput>(),
    )
    return c.json({
      message: data.replayed ? '已返回原抽样批次' : `抽样完成，已创建 ${data.sampleIds.length} 个样本`,
      data,
    }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationQualityRoutes.post('/samples/:sampleId/claim', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await claimAdminConversationQualitySample(
      c.env.DB,
      actor(c),
      c.req.param('sampleId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<ClaimQualitySampleInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原领取结果' : '样本已领取，正文授权限时生效', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationQualityRoutes.get('/samples/:sampleId', async (c) => {
  try {
    enabledConfig(c.env)
    return c.json({
      data: await getAdminConversationQualitySample(
        c.env.DB,
        actor(c),
        c.req.param('sampleId'),
        c.req.query('accessReason') ?? '',
        c.get('appRequestId') || crypto.randomUUID(),
      ),
    })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationQualityRoutes.post('/samples/:sampleId/decision', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await decideAdminConversationQualitySample(
      c.env.DB,
      actor(c),
      c.req.param('sampleId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<DecideQualitySampleInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原抽检结论' : '抽检结论已记录', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationQualityRoutes.post('/samples/:sampleId/void', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await voidAdminConversationQualitySample(
      c.env.DB,
      actor(c),
      c.req.param('sampleId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<VoidQualitySampleInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原作废结果' : '样本已作废并保留审计', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationQualityRoutes.patch('/tasks/:taskId', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await updateAdminConversationQualityTask(
      c.env.DB,
      actor(c),
      c.req.param('taskId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpdateQualityTaskInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原任务结果' : '改进任务已更新', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppMessagingRuntimeConfig(env)
  requireAppMessagingAdminEnabled(config)
  return config
}

function actor(c: { get(name: 'userId'): number | null; get(name: 'userRole'): string | null }) {
  return {
    adminId: c.get('userId')!,
    role: c.get('userRole')!,
  }
}

function handleError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
