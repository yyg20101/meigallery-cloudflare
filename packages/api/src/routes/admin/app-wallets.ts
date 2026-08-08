import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  createAdminAppWalletAdjustment,
  getAdminAppWalletAdjustment,
  getAdminAppWalletState,
  listAdminAppWalletAdjustments,
  previewAdminAppWalletAdjustment,
  reviewAdminAppWalletAdjustment,
  searchAdminAppWalletAccounts,
  type AdminWalletAdjustmentInput,
  type AdminWalletReviewInput,
} from '../../services/admin-app-wallet'
import {
  AppWalletError,
  getAppWalletRuntimeConfig,
  requireAppWalletAdminEnabled,
} from '../../services/app-wallet'
import { errorJson } from '../../utils/api-error'

export const adminAppWalletRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppWalletRoutes.get('/accounts', async (c) => {
  try {
    return c.json({ data: await searchAdminAppWalletAccounts(
      c.env.DB,
      c.req.query('query'),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/accounts/:accountId', async (c) => {
  try {
    return c.json({ data: await getAdminAppWalletState(
      c.env.DB,
      c.req.param('accountId'),
      c.get('userId')!,
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/adjustments/preview', async (c) => {
  try {
    return c.json({ data: await previewAdminAppWalletAdjustment(
      c.env.DB,
      await c.req.json<AdminWalletAdjustmentInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/adjustments', async (c) => {
  try {
    return c.json({ data: await createAdminAppWalletAdjustment(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletAdjustmentInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/adjustments', async (c) => {
  try {
    return c.json({ data: await listAdminAppWalletAdjustments(
      c.env.DB,
      c.req.query('status'),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/adjustments/:adjustmentId', async (c) => {
  try {
    return c.json({ data: await getAdminAppWalletAdjustment(
      c.env.DB,
      c.req.param('adjustmentId'),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

for (const decision of ['approve', 'reject'] as const) {
  adminAppWalletRoutes.post(`/adjustments/:adjustmentId/${decision}`, async (c) => {
    try {
      return c.json({ data: await reviewAdminAppWalletAdjustment(
        c.env.DB,
        c.req.param('adjustmentId'),
        c.get('userId')!,
        decision,
        c.req.header('Idempotency-Key') ?? null,
        await c.req.json<AdminWalletReviewInput>(),
        enabledConfig(c.env),
      ) })
    }
    catch (error) {
      return handleWalletError(c, error)
    }
  })
}

function enabledConfig(env: Bindings) {
  const config = getAppWalletRuntimeConfig(env)
  requireAppWalletAdminEnabled(config)
  return config
}

function handleWalletError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppWalletError) {
    return errorJson(c, error.status, error.message, {
      code: error.code,
      detail: { retryable: error.retryable },
    })
  }
  throw error
}
