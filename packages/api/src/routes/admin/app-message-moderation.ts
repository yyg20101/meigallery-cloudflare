import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  AppMessageModerationError,
  claimAdminAppMessageModerationCase,
  decideAdminAppMessageModerationCase,
  getAdminAppMessageModerationCaseDetail,
  listAdminAppMessageModerationCases,
  parseAdminAppMessageModerationCaseListQuery,
  type AdminAppMessageModerationClaimInput,
  type AdminAppMessageModerationDecisionInput,
} from '../../services/app-message-moderation'
import {
  AppMessagingError,
  getAppMessagingRuntimeConfig,
  requireAppMessagingAdminEnabled,
} from '../../services/app-messaging'
import { autoAssignConversationIfEligible } from '../../services/app-conversation-auto-assignment'
import {
  publishAppRealtimeConversationRefresh,
  scheduleAppRealtimeTask,
} from '../../services/app-realtime'
import { errorJson } from '../../utils/api-error'

export const adminAppMessageModerationRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

adminAppMessageModerationRoutes.get('/cases', async (c) => {
  try {
    enabledConfig(c.env)
    const query = parseAdminAppMessageModerationCaseListQuery({
      status: c.req.query('status'),
      limit: c.req.query('limit'),
    })
    return c.json({
      data: await listAdminAppMessageModerationCases(
        c.env.DB,
        c.get('userId')!,
        query,
      ),
    })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppMessageModerationRoutes.post('/cases/:caseId/claim', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await claimAdminAppMessageModerationCase(
      c.env.DB,
      c.get('userId')!,
      c.req.param('caseId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMessageModerationClaimInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原领取结果' : '消息审核案件已领取', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppMessageModerationRoutes.get('/cases/:caseId', async (c) => {
  try {
    enabledConfig(c.env)
    requireAccessReason(c.req.query('accessReason'))
    return c.json({
      data: await getAdminAppMessageModerationCaseDetail(
        c.env.DB,
        c.get('userId')!,
        c.req.param('caseId'),
        requestId(c),
      ),
    })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppMessageModerationRoutes.post('/cases/:caseId/decision', async (c) => {
  try {
    enabledConfig(c.env)
    const now = new Date()
    const data = await decideAdminAppMessageModerationCase(
      c.env.DB,
      c.get('userId')!,
      c.req.param('caseId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMessageModerationDecisionInput>(),
      now,
    )
    if (data.autoAssignmentEligible) {
      scheduleTask(c, autoAssignConversationIfEligible(
        c.env.DB,
        data.conversationId,
        'viewer_message',
        now,
      ), 'admin.message_moderation.auto_assignment')
    }
    scheduleTask(c, publishAppRealtimeConversationRefresh(c.env, {
      conversationId: data.conversationId,
      dedupeKey: `message:${data.messageId}:moderation:${data.status}:${data.version}`,
      scopes: ['conversations', 'messages'],
      occurredAt: now,
    }), 'admin.message_moderation.realtime')
    return c.json({
      message: data.replayed
        ? '已返回原审核决定'
        : data.status === 'accepted'
          ? '消息已通过审核'
          : '消息已拒绝',
      data,
    })
  }
  catch (error) {
    return handleError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppMessagingRuntimeConfig(env)
  requireAppMessagingAdminEnabled(config)
  if (!config.moderationPolicyId) {
    throw new AppMessageModerationError(403, 'FEATURE_DISABLED', '消息审核工作台尚未开放')
  }
  return config
}

function requireAccessReason(value: string | undefined) {
  if (value !== 'message_moderation_review') {
    throw new AppMessageModerationError(
      400,
      'ACCESS_REASON_REQUIRED',
      '查看待审消息正文必须声明 message_moderation_review',
    )
  }
}

function requestId(c: { get(name: 'appRequestId'): string | undefined }) {
  return c.get('appRequestId') || crypto.randomUUID()
}

function scheduleTask(
  c: { executionCtx: { waitUntil(task: Promise<unknown>): void } },
  task: Promise<unknown>,
  operation: string,
) {
  scheduleAppRealtimeTask(c.executionCtx, task, operation)
}

function handleError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppMessageModerationError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  if (error instanceof AppMessagingError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  if (error instanceof SyntaxError) {
    return errorJson(c, 400, '请求体必须为有效 JSON', { code: 'REQUEST_BODY_INVALID' })
  }
  throw error
}
