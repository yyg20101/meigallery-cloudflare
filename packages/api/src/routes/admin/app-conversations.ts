import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  auditAdminAppConversationAccess,
  getAdminAppConversation,
  listAdminAppConversationMessages,
  listAdminAppConversations,
  markAdminAppConversationRead,
  parseAdminAppConversationListQuery,
  parseAdminAppConversationMessageQuery,
  sendAdminAppConversationMessage,
  type AdminSendAppMessageInput,
} from '../../services/admin-app-messaging'
import {
  AppMessagingError,
  getAppMessagingRuntimeConfig,
  requireAppMessagingAdminEnabled,
} from '../../services/app-messaging'
import { errorJson } from '../../utils/api-error'

export const adminAppConversationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppConversationRoutes.get('/', async (c) => {
  try {
    enabledConfig(c.env)
    const query = parseAdminAppConversationListQuery({
      queueStatus: c.req.query('queueStatus'),
      limit: c.req.query('limit'),
    })
    return c.json({ data: await listAdminAppConversations(c.env.DB, query) })
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
    const data = await getAdminAppConversation(c.env.DB, conversationId)
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
    const data = await listAdminAppConversationMessages(c.env.DB, conversationId, query)
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

adminAppConversationRoutes.post('/:conversationId/read', async (c) => {
  try {
    enabledConfig(c.env)
    const body = await c.req.json<{ sequence?: unknown }>()
    return c.json({ data: await markAdminAppConversationRead(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      body.sequence,
    ) })
  }
  catch (error) {
    return handleAppMessagingError(c, error)
  }
})

adminAppConversationRoutes.post('/:conversationId/messages', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await sendAdminAppConversationMessage(
      c.env.DB,
      c.get('userId')!,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminSendAppMessageInput>(),
    )
    return c.json({
      message: data.replayed ? '已返回原运营回复' : '运营回复已发送',
      data,
    }, data.replayed ? 200 : 201)
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

function requireAccessReason(value: string | undefined) {
  if (value !== 'service_operation') {
    throw new AppMessagingError(400, 'ACCESS_REASON_REQUIRED', '查看消息正文必须声明 service_operation')
  }
}

function requestId(c: { get(name: 'appRequestId'): string | undefined }) {
  return c.get('appRequestId') || crypto.randomUUID()
}

function handleAppMessagingError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
