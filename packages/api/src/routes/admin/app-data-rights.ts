import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import {
  actOnAdminAppDataRightsRequest,
  AdminAppDataRightsError,
  adminDataRightsConfig,
  claimAdminAppDataRightsRequest,
  getAdminAppDataRightsOverview,
  getAdminAppDataRightsRequest,
  listAdminAppDataRightsRequests,
  type AdminDataRightsActionInput,
  type AdminDataRightsActor,
  type AdminDataRightsClaimInput,
} from '../../services/admin-app-data-rights'
import { AppDataRightsError } from '../../services/app-data-rights'
import { errorJson } from '../../utils/api-error'

export const adminAppDataRightsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppDataRightsRoutes.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store, max-age=0')
})

adminAppDataRightsRoutes.get('/overview', async (c) => {
  try {
    return c.json({
      data: await getAdminAppDataRightsOverview(
        c.env.DB,
        adminDataRightsConfig(c.env),
      ),
    })
  }
  catch (error) {
    return handleDataRightsError(c, error)
  }
})

adminAppDataRightsRoutes.get('/requests', async (c) => {
  try {
    return c.json({
      data: await listAdminAppDataRightsRequests(c.env.DB, actor(c), {
        type: c.req.query('type'),
        status: c.req.query('status'),
        assignment: c.req.query('assignment'),
        limit: c.req.query('limit'),
      }),
    })
  }
  catch (error) {
    return handleDataRightsError(c, error)
  }
})

adminAppDataRightsRoutes.get('/requests/:requestId', async (c) => {
  try {
    return c.json({
      data: await getAdminAppDataRightsRequest(
        c.env,
        c.req.param('requestId'),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleDataRightsError(c, error)
  }
})

adminAppDataRightsRoutes.post('/requests/:requestId/claim', requireOwner, async (c) => {
  try {
    const body = await c.req.json<AdminDataRightsClaimInput>().catch(() => ({}))
    const result = await claimAdminAppDataRightsRequest(
      c.env,
      adminDataRightsConfig(c.env),
      c.req.param('requestId'),
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.request, replayed: result.replayed })
  }
  catch (error) {
    return handleDataRightsError(c, error)
  }
})

adminAppDataRightsRoutes.post('/requests/:requestId/actions', requireOwner, async (c) => {
  try {
    const body = await c.req.json<AdminDataRightsActionInput>().catch(() => ({}))
    const result = await actOnAdminAppDataRightsRequest(
      c.env,
      adminDataRightsConfig(c.env),
      c.req.param('requestId'),
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.request, replayed: result.replayed })
  }
  catch (error) {
    return handleDataRightsError(c, error)
  }
})

function actor(c: Parameters<typeof errorJson>[0]): AdminDataRightsActor {
  return {
    adminId: c.get('userId')!,
    role: c.get('userRole')!,
    requestId: c.get('appRequestId') || c.req.header('X-Request-Id') || crypto.randomUUID(),
    traceId: c.req.header('CF-Ray') || null,
  }
}

function handleDataRightsError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AdminAppDataRightsError || error instanceof AppDataRightsError) {
    return errorJson(c, error.status, error.message, {
      code: error.code,
      detail: { retryable: error.retryable },
    })
  }
  throw error
}
