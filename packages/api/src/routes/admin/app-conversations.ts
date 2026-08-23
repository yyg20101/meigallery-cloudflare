import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  auditAdminAppConversationAccess,
  claimAdminAppConversation,
  closeAdminAppConversation,
  getAdminAppConversation,
  listAdminAppConversationMessages,
  listAdminAppConversations,
  markAdminAppConversationRead,
  parseAdminAppConversationListQuery,
  parseAdminAppConversationMessageQuery,
  releaseAdminAppConversation,
  sendAdminAppConversationMessage,
  type AdminSendAppMessageInput,
} from '../../services/admin-app-messaging'
import {
  createAdminConversationInternalNote,
  listAdminConversationInternalNotes,
  listAdminConversationOperators,
  parseAdminConversationInternalNoteLimit,
  transferAdminConversation,
  type AdminCreateConversationInternalNoteInput,
  type AdminTransferConversationInput,
} from '../../services/admin-app-conversation-collaboration'
import {
  createAdminConversationSafetyEscalation,
  type AdminCreateConversationSafetyEscalationInput,
} from '../../services/admin-app-conversation-safety-escalations'
import {
  AppMessagingError,
  getAppMessagingRuntimeConfig,
  requireAppMessagingAdminEnabled,
} from '../../services/app-messaging'
import {
  AppSafetyError,
  getAppSafetyRuntimeConfig,
  requireAppSafetyAdminEnabled,
} from '../../services/app-safety'
import { AppMessageModerationError } from '../../services/app-message-moderation'
import { errorJson } from '../../utils/api-error'
import {
  publishAppRealtimeConversationRefresh,
  scheduleAppRealtimeTask,
} from '../../services/app-realtime'

export const adminAppConversationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppConversationRoutes.get('/', async (c) => {
  try {
    enabledConfig(c.env)
    const query = parseAdminAppConversationListQuery({
      queueStatus: c.req.query('queueStatus'),
      limit: c.req.query('limit'),
    })
    return c.json({ data: await listAdminAppConversations(c.env.DB, c.get('userId')!, query) })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.get('/operators', async (c) => {
  try {
    enabledConfig(c.env)
    return c.json({ data: await listAdminConversationOperators(c.env.DB, c.get('userId')!) })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.get('/:conversationId', async (c) => {
  try {
    enabledConfig(c.env)
    requireAccessReason(c.req.query('accessReason'))
    const conversationId = c.req.param('conversationId')
    const data = await getAdminAppConversation(c.env.DB, c.get('userId')!, conversationId)
    await auditAdminAppConversationAccess(
      c.env.DB,
      c.get('userId')!,
      conversationId,
      requestId(c),
    )
    return c.json({ data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.get('/:conversationId/messages', async (c) => {
  try {
    enabledConfig(c.env)
    requireAccessReason(c.req.query('accessReason'))
    const conversationId = c.req.param('conversationId')
    const query = parseAdminAppConversationMessageQuery({
      afterSequence: c.req.query('afterSequence'),
      limit: c.req.query('limit'),
    })
    const data = await listAdminAppConversationMessages(
      c.env.DB,
      c.get('userId')!,
      conversationId,
      query,
    )
    await auditAdminAppConversationAccess(
      c.env.DB,
      c.get('userId')!,
      conversationId,
      requestId(c),
    )
    return c.json({ data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.get('/:conversationId/internal-notes', async (c) => {
  try {
    enabledConfig(c.env)
    requireAccessReason(c.req.query('accessReason'))
    const data = await listAdminConversationInternalNotes(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      parseAdminConversationInternalNoteLimit(c.req.query('limit')),
      requestId(c),
    )
    return c.json({ data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/internal-notes', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await createAdminConversationInternalNote(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminCreateConversationInternalNoteInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原内部备注' : '内部备注已保存', data }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/transfer', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await transferAdminConversation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminTransferConversationInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原转派结果' : '话题已转派', data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/safety-escalations', async (c) => {
  try {
    enabledSafetyEscalationConfig(c.env)
    const data = await createAdminConversationSafetyEscalation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminCreateConversationSafetyEscalationInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原安全升级案件' : '安全升级案件已创建', data }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/read', async (c) => {
  try {
    enabledConfig(c.env)
    const body = await c.req.json<{ sequence?: unknown }>()
    const data = await markAdminAppConversationRead(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      body.sequence,
    )
    scheduleRealtime(c, publishAppRealtimeConversationRefresh(c.env, {
      conversationId: data.conversationId,
      dedupeKey: `conversation:${data.conversationId}:operator-read:${data.readSequence}`,
      scopes: ['conversations', 'messages'],
    }), 'admin.conversation.read')
    return c.json({ data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/messages', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const now = new Date()
    const data = await sendAdminAppConversationMessage(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminSendAppMessageInput>(),
      now,
      {
        policyId: config.moderationPolicyId,
        requireProductionReady: config.requireProductionReady,
      },
    )
    scheduleRealtime(c, publishAppRealtimeConversationRefresh(c.env, {
      conversationId: data.message.conversationId,
      dedupeKey: `message:${data.message.messageId}:operator`,
      scopes: ['conversations', 'messages'],
      occurredAt: new Date(data.message.createdAt),
    }), 'admin.conversation.reply')
    return c.json({
      message: data.replayed
        ? '已返回原运营回复'
        : data.message.status === 'review_pending'
          ? '运营回复已提交审核'
          : data.message.status === 'rejected'
            ? '运营回复未通过审核'
            : '运营回复已发送',
      data,
    }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/claim', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await claimAdminAppConversation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ message: data.replayed ? '已返回原领取结果' : '话题已领取', data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/release', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await releaseAdminAppConversation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ message: data.replayed ? '已返回原释放结果' : '话题已释放', data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/close', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await closeAdminAppConversation(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
    )
    if (!data.replayed) {
      scheduleRealtime(c, publishAppRealtimeConversationRefresh(c.env, {
        conversationId: data.conversationId,
        dedupeKey: `conversation:${data.conversationId}:closed`,
        scopes: ['conversations', 'messages'],
      }), 'admin.conversation.close')
    }
    return c.json({ message: data.replayed ? '已返回原关闭结果' : '话题已关闭', data })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppMessagingRuntimeConfig(env)
  requireAppMessagingAdminEnabled(config)
  return config
}

function scheduleRealtime(
  c: { executionCtx: { waitUntil(task: Promise<unknown>): void } },
  task: Promise<unknown>,
  operation: string,
) {
  scheduleAppRealtimeTask(c.executionCtx, task, operation)
}

function enabledSafetyEscalationConfig(env: Bindings) {
  enabledConfig(env)
  const safetyConfig = getAppSafetyRuntimeConfig(env)
  requireAppSafetyAdminEnabled(safetyConfig)
  return safetyConfig
}

function requireAccessReason(value: string | undefined) {
  if (value !== 'service_operation') {
    throw new AppMessagingError(400, 'ACCESS_REASON_REQUIRED', '查看消息正文必须声明 service_operation')
  }
}

function requestId(c: { get(name: 'appRequestId'): string | undefined }) {
  return c.get('appRequestId') || crypto.randomUUID()
}

function handleAppMessagingError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppSafetyError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  if (error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  if (error instanceof AppMessageModerationError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
