import { Hono, type Context } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  activateAdminEditorialPlacement,
  activateAdminRecommendationRule,
  copyAdminRecommendationRule,
  createAdminEditorialPlacement,
  createAdminRecommendationRule,
  decideAdminEditorialPlacement,
  decideAdminRecommendationRule,
  dryRunAdminRecommendationRule,
  getAdminEditorialPlacement,
  getAdminRecommendationOverview,
  getAdminRecommendationRule,
  listAdminEditorialPlacements,
  listAdminRecommendationRules,
  pauseAdminEditorialPlacement,
  pauseAdminRecommendationRule,
  rollbackAdminRecommendationRule,
  submitAdminEditorialPlacement,
  submitAdminRecommendationRule,
  updateAdminEditorialPlacement,
  updateAdminRecommendationRule,
} from '../../services/admin-app-recommendations'
import {
  createAdminRecommendationGuardrailPolicy,
  decideAdminRecommendationGuardrailPolicy,
  evaluateAdminRecommendationGuardrail,
  getAdminRecommendationGuardrailEvaluation,
  getAdminRecommendationGuardrailOverview,
  getAdminRecommendationGuardrailPolicy,
  listAdminRecommendationGuardrailPolicies,
  retireAdminRecommendationGuardrailPolicy,
  submitAdminRecommendationGuardrailPolicy,
  updateAdminRecommendationGuardrailPolicy,
} from '../../services/admin-app-recommendation-guardrails'
import {
  AppRecommendationError,
  getAppRecommendationRuntimeConfig,
  requireAppRecommendationPolicy,
} from '../../services/app-recommendation-policy'
import { errorJson } from '../../utils/api-error'

export const adminAppRecommendationRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

adminAppRecommendationRoutes.use('*', async (c, next) => {
  try {
    await requireAppRecommendationPolicy(
      c.env.DB,
      getAppRecommendationRuntimeConfig(c.env),
      'admin',
    )
    await next()
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/overview', async (c) => {
  try {
    return c.json({
      data: await getAdminRecommendationOverview(c.env.DB, await policy(c.env)),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/guardrails/overview', async (c) => {
  try {
    return c.json({ data: await getAdminRecommendationGuardrailOverview(c.env.DB) })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/guardrails', async (c) => {
  try {
    return c.json({
      data: await listAdminRecommendationGuardrailPolicies(c.env.DB, c.req.query('state')),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/guardrails', async (c) => {
  try {
    const result = await createAdminRecommendationGuardrailPolicy(
      c.env.DB,
      await c.req.json<unknown>(),
      c.req.header('Idempotency-Key') ?? null,
      actor(c),
    )
    return c.json({
      message: result.replayed ? '已返回原推荐守护策略创建结果' : '推荐守护策略草稿已创建',
      data: result,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/guardrails/:policyId', async (c) => {
  try {
    return c.json({
      data: await getAdminRecommendationGuardrailPolicy(c.env.DB, c.req.param('policyId')),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.patch('/guardrails/:policyId', async (c) => {
  try {
    return c.json({
      message: '推荐守护策略草稿已更新',
      data: await updateAdminRecommendationGuardrailPolicy(
        c.env.DB,
        c.req.param('policyId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/guardrails/:policyId/submit', async (c) => {
  try {
    return c.json({
      message: '推荐守护策略已提交独立复核',
      data: await submitAdminRecommendationGuardrailPolicy(
        c.env.DB,
        c.req.param('policyId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/guardrails/:policyId/decision', async (c) => {
  try {
    return c.json({
      message: '推荐守护策略复核决定已记录',
      data: await decideAdminRecommendationGuardrailPolicy(
        c.env.DB,
        c.req.param('policyId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/guardrails/:policyId/retire', async (c) => {
  try {
    return c.json({
      message: '推荐守护策略已退休',
      data: await retireAdminRecommendationGuardrailPolicy(
        c.env.DB,
        c.req.param('policyId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/guardrail-evaluations/:evaluationId', async (c) => {
  try {
    return c.json({
      data: await getAdminRecommendationGuardrailEvaluation(
        c.env.DB,
        c.req.param('evaluationId'),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/rules', async (c) => {
  try {
    return c.json({
      data: await listAdminRecommendationRules(c.env.DB, {
        state: c.req.query('state'),
        mode: c.req.query('mode'),
      }),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/rules', async (c) => {
  try {
    const result = await createAdminRecommendationRule(
      c.env.DB,
      await c.req.json<unknown>(),
      c.req.header('Idempotency-Key') ?? null,
      actor(c),
    )
    return c.json({
      message: result.replayed ? '已返回原推荐规则创建结果' : '推荐规则草稿已创建',
      data: result,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/placements', async (c) => {
  try {
    return c.json({
      data: await listAdminEditorialPlacements(c.env.DB, {
        state: c.req.query('state'),
      }),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/placements', async (c) => {
  try {
    const result = await createAdminEditorialPlacement(
      c.env.DB,
      await c.req.json<unknown>(),
      c.req.header('Idempotency-Key') ?? null,
      actor(c),
    )
    return c.json({
      message: result.replayed ? '已返回原运营精选创建结果' : '运营精选排期草稿已创建',
      data: result,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.get('/placements/:placementId', async (c) => {
  try {
    return c.json({ data: await getAdminEditorialPlacement(c.env.DB, c.req.param('placementId')) })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.patch('/placements/:placementId', async (c) => {
  try {
    return c.json({
      message: '运营精选排期已更新',
      data: await updateAdminEditorialPlacement(
        c.env.DB,
        c.req.param('placementId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/placements/:placementId/submit', async (c) => {
  return placementTransition(c, submitAdminEditorialPlacement, '运营精选排期已提交复核')
})

adminAppRecommendationRoutes.post('/placements/:placementId/decision', async (c) => {
  return placementTransition(c, decideAdminEditorialPlacement, '运营精选复核决定已记录')
})

adminAppRecommendationRoutes.post('/placements/:placementId/activate', async (c) => {
  return placementTransition(c, activateAdminEditorialPlacement, '运营精选排期已启用')
})

adminAppRecommendationRoutes.post('/placements/:placementId/pause', async (c) => {
  return placementTransition(c, pauseAdminEditorialPlacement, '运营精选排期已暂停')
})

adminAppRecommendationRoutes.get('/rules/:ruleVersionId', async (c) => {
  try {
    return c.json({ data: await getAdminRecommendationRule(c.env.DB, c.req.param('ruleVersionId')) })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.patch('/rules/:ruleVersionId', async (c) => {
  try {
    return c.json({
      message: '推荐规则草稿已更新；原 Dry-run 结果已失效',
      data: await updateAdminRecommendationRule(
        c.env.DB,
        c.req.param('ruleVersionId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/copy', async (c) => {
  try {
    const result = await copyAdminRecommendationRule(
      c.env.DB,
      c.req.param('ruleVersionId'),
      c.req.header('Idempotency-Key') ?? null,
      actor(c),
    )
    return c.json({
      message: result.replayed ? '已返回原规则复制结果' : '新规则版本草稿已创建',
      data: result,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/dry-run', async (c) => {
  try {
    return c.json({
      message: 'Dry-run 已完成；未产生真实曝光',
      data: await dryRunAdminRecommendationRule(
        c.env.DB,
        c.req.param('ruleVersionId'),
        await c.req.json<unknown>(),
        actor(c),
        await policy(c.env),
        c.req.url,
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/guardrail-evaluations', async (c) => {
  try {
    const result = await evaluateAdminRecommendationGuardrail(
      c.env.DB,
      c.req.param('ruleVersionId'),
      await c.req.json<unknown>(),
      c.req.header('Idempotency-Key') ?? null,
      actor(c),
      getAppRecommendationRuntimeConfig(c.env).requireProductionReady,
    )
    return c.json({
      message: result.replayed ? '已返回原推荐守护评估结果' : '推荐守护评估已冻结',
      data: result,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/submit', async (c) => {
  return ruleTransition(c, submitAdminRecommendationRule, '推荐规则已提交复核')
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/decision', async (c) => {
  return ruleTransition(c, decideAdminRecommendationRule, '推荐规则复核决定已记录')
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/activate', async (c) => {
  try {
    const config = getAppRecommendationRuntimeConfig(c.env)
    return c.json({
      message: '推荐规则已启用或进入计划生效状态',
      data: await activateAdminRecommendationRule(
        c.env.DB,
        c.req.param('ruleVersionId'),
        await c.req.json<unknown>(),
        actor(c),
        await requireAppRecommendationPolicy(c.env.DB, config, 'admin'),
        config.requireProductionReady,
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/pause', async (c) => {
  return ruleTransition(c, pauseAdminRecommendationRule, '推荐规则已暂停')
})

adminAppRecommendationRoutes.post('/rules/:ruleVersionId/rollback', async (c) => {
  try {
    const config = getAppRecommendationRuntimeConfig(c.env)
    return c.json({
      message: '推荐规则已回滚',
      data: await rollbackAdminRecommendationRule(
        c.env.DB,
        c.req.param('ruleVersionId'),
        await c.req.json<unknown>(),
        actor(c),
        await requireAppRecommendationPolicy(c.env.DB, config, 'admin'),
        config.requireProductionReady,
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
})

type AdminContext = Context<{ Bindings: Bindings; Variables: Variables }>
type Actor = ReturnType<typeof actor>
type RuleTransition = (
  db: D1Database,
  ruleVersionId: unknown,
  input: unknown,
  actor: Actor,
) => Promise<unknown>
type PlacementTransition = (
  db: D1Database,
  placementId: unknown,
  input: unknown,
  actor: Actor,
) => Promise<unknown>

async function ruleTransition(c: AdminContext, transition: RuleTransition, message: string) {
  try {
    return c.json({
      message,
      data: await transition(
        c.env.DB,
        c.req.param('ruleVersionId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
}

async function placementTransition(c: AdminContext, transition: PlacementTransition, message: string) {
  try {
    return c.json({
      message,
      data: await transition(
        c.env.DB,
        c.req.param('placementId'),
        await c.req.json<unknown>(),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleRecommendationError(c, error)
  }
}

function actor(c: AdminContext) {
  return {
    adminId: c.get('userId')!,
    role: c.get('userRole')!,
    requestId: c.req.header('X-Request-ID') ?? crypto.randomUUID(),
  }
}

async function policy(env: Bindings) {
  return requireAppRecommendationPolicy(
    env.DB,
    getAppRecommendationRuntimeConfig(env),
    'admin',
  )
}

function handleRecommendationError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppRecommendationError) {
    return errorJson(c, error.status, error.message, {
      code: error.code,
      detail: error.detail,
    })
  }
  if (error instanceof SyntaxError) {
    return errorJson(c, 400, '请求体必须为有效 JSON', { code: 'REQUEST_BODY_INVALID' })
  }
  throw error
}
