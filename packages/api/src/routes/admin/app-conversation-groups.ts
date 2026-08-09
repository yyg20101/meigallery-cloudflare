import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  createAdminConversationGroup,
  createAdminConversationGroupShift,
  createAdminConversationRoutingRule,
  dispatchAdminConversationQueue,
  getAdminConversationRoutingSnapshot,
  updateAdminConversationGroup,
  updateAdminConversationGroupShift,
  updateAdminConversationRoutingRule,
  upsertAdminConversationGroupMember,
  upsertAdminConversationRoutingPolicy,
  type CreateConversationGroupInput,
  type CreateConversationGroupShiftInput,
  type CreateConversationRoutingRuleInput,
  type UpdateConversationGroupInput,
  type UpdateConversationGroupShiftInput,
  type UpdateConversationRoutingRuleInput,
  type UpsertConversationGroupMemberInput,
  type UpsertConversationRoutingPolicyInput,
} from '../../services/admin-app-conversation-routing'
import {
  AppMessagingError,
  getAppMessagingRuntimeConfig,
  requireAppMessagingAdminEnabled,
} from '../../services/app-messaging'
import { errorJson } from '../../utils/api-error'

export const adminAppConversationGroupRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

adminAppConversationGroupRoutes.get('/', async (c) => {
  try {
    enabledConfig(c.env)
    return c.json({ data: await getAdminConversationRoutingSnapshot(c.env.DB, actor(c)) })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.post('/', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await createAdminConversationGroup(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateConversationGroupInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原运营组结果' : '运营组已创建', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.put('/policy', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await upsertAdminConversationRoutingPolicy(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpsertConversationRoutingPolicyInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原策略结果' : '分配策略已保存', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.post('/dispatch', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await dispatchAdminConversationQueue(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ message: data.replayed ? '已返回原分配结果' : '待处理队列分配完成', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.post('/rules', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await createAdminConversationRoutingRule(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateConversationRoutingRuleInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原规则结果' : '分配规则已创建', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.patch('/rules/:ruleId', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await updateAdminConversationRoutingRule(
      c.env.DB,
      actor(c),
      c.req.param('ruleId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpdateConversationRoutingRuleInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原规则结果' : '分配规则已更新', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.patch('/:groupId', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await updateAdminConversationGroup(
      c.env.DB,
      actor(c),
      c.req.param('groupId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpdateConversationGroupInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原运营组结果' : '运营组已更新', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.put('/:groupId/members/:adminId', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await upsertAdminConversationGroupMember(
      c.env.DB,
      actor(c),
      c.req.param('groupId'),
      c.req.param('adminId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpsertConversationGroupMemberInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原成员结果' : '运营组成员已保存', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.post('/:groupId/shifts', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await createAdminConversationGroupShift(
      c.env.DB,
      actor(c),
      c.req.param('groupId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateConversationGroupShiftInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原班次结果' : '班次已创建', data })
  }
  catch (error) {
    return handleError(c, error)
  }
})

adminAppConversationGroupRoutes.patch('/:groupId/shifts/:shiftId', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await updateAdminConversationGroupShift(
      c.env.DB,
      actor(c),
      c.req.param('groupId'),
      c.req.param('shiftId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpdateConversationGroupShiftInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原班次结果' : '班次已更新', data })
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
