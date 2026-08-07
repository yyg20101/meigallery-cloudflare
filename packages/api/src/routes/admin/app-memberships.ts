import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  getAdminAppMembershipUserState,
  grantAdminAppMembership,
  previewAdminAppMembershipGrant,
  revokeAdminAppMembershipGrant,
  type AdminAppMembershipGrantInput,
  type AdminAppMembershipRevokeInput,
} from '../../services/admin-app-membership'
import {
  AppMembershipError,
  getAppMembershipCatalog,
  getAppMembershipRuntimeConfig,
  requireAppMembershipAdminEnabled,
} from '../../services/app-membership'
import { errorJson } from '../../utils/api-error'
import {
  approveAdminAppMembershipApplication,
  claimAdminAppMembershipApplication,
  getAdminAppMembershipApplication,
  listAdminAppMembershipApplications,
  transitionAdminAppMembershipApplication,
  type AdminAppMembershipApplicationApproveInput,
  type AdminAppMembershipApplicationMutationInput,
} from '../../services/admin-app-membership-applications'

export const adminAppMembershipRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppMembershipRoutes.get('/catalog', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAppMembershipCatalog(
      c.env.DB,
      config.catalogVersionId,
      { requireProductionReady: config.requireProductionReady },
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/applications', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppMembershipApplications(
      c.env.DB,
      config.catalogVersionId,
      {
        status: c.req.query('status'),
        tierId: c.req.query('tierId'),
        assignedTo: c.req.query('assignedTo'),
        submittedFrom: c.req.query('submittedFrom'),
        submittedTo: c.req.query('submittedTo'),
        limit: c.req.query('limit'),
      },
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/applications/:applicationId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipApplication(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('applicationId'),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/applications/:applicationId/claim', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const body = await c.req.json<{ expectedVersion?: unknown }>()
    return c.json({ data: await claimAdminAppMembershipApplication(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('applicationId'),
      c.get('userId')!,
      body.expectedVersion,
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

for (const [path, transition] of [
  ['request-information', 'request_information'],
  ['reject', 'reject'],
  ['expire', 'expire'],
  ['cancel', 'cancel'],
] as const) {
  adminAppMembershipRoutes.post(`/applications/:applicationId/${path}`, async (c) => {
    try {
      const config = enabledConfig(c.env)
      return c.json({ data: await transitionAdminAppMembershipApplication(
        c.env.DB,
        config.catalogVersionId,
        c.req.param('applicationId'),
        c.get('userId')!,
        transition,
        await c.req.json<AdminAppMembershipApplicationMutationInput>(),
        new Date(),
        config.requireProductionReady,
      ) })
    }
    catch (error) {
      return handleAppMembershipError(c, error)
    }
  })
}

adminAppMembershipRoutes.post('/applications/:applicationId/approve', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await approveAdminAppMembershipApplication(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('applicationId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipApplicationApproveInput>(),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/users/:userId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipUserState(
      c.env.DB,
      config.catalogVersionId,
      parseUserId(c.req.param('userId')),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants/preview', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await previewAdminAppMembershipGrant(
      c.env.DB,
      config.catalogVersionId,
      await c.req.json<AdminAppMembershipGrantInput>(),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await grantAdminAppMembership(
      c.env.DB,
      config.catalogVersionId,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipGrantInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return c.json({ message: data.replayed ? '已返回原会员操作结果' : 'App 会员已发放', data }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants/:grantId/revoke', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await revokeAdminAppMembershipGrant(
      c.env.DB,
      c.get('userId')!,
      c.req.param('grantId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipRevokeInput>(),
    )
    return c.json({ message: data.replayed ? '已返回原会员撤销结果' : 'App 会员发放已撤销', data })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppMembershipRuntimeConfig(env)
  requireAppMembershipAdminEnabled(config)
  return config
}

function parseUserId(raw: string): number {
  const userId = Number(raw)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppMembershipError(400, 'ACCOUNT_ID_INVALID', 'userId 必须为正整数')
  }
  return userId
}

function handleAppMembershipError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppMembershipError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
