import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  getAdminAppNotificationTemplateWorkspace,
  getAdminAppNotificationOverview,
  listAdminAppNotificationDefinitions,
  listAdminAppNotificationDeliveries,
  listAdminAppNotificationTemplates,
  parseAdminAppNotificationDeliveryQuery,
  reviewAdminAppNotificationTemplate,
  saveAdminAppNotificationTemplateDraft,
  submitAdminAppNotificationTemplateReview,
  type AdminNotificationTemplateDraftInput,
  type AdminNotificationTemplateReviewInput,
} from '../../services/admin-app-notifications'
import {
  AppNotificationError,
  getAppNotificationRuntimeConfig,
  requireAppNotificationsAdminEnabled,
} from '../../services/app-notifications'
import { errorJson } from '../../utils/api-error'

export const adminAppNotificationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppNotificationRoutes.get('/overview', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppNotificationOverview(c.env.DB, config.policyId) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.get('/events', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppNotificationDefinitions(c.env.DB, config.policyId) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.get('/templates', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppNotificationTemplates(c.env.DB, config.policyId) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.get('/templates/:templateId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppNotificationTemplateWorkspace(
      c.env.DB,
      config.policyId,
      c.req.param('templateId'),
      c.get('userId')!,
      c.get('userRole') ?? undefined,
    ) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.put('/templates/:templateId/draft', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await saveAdminAppNotificationTemplateDraft(
      c.env.DB,
      config.policyId,
      c.req.param('templateId'),
      c.get('userId')!,
      await c.req.json<AdminNotificationTemplateDraftInput>(),
    ) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.post('/templates/:templateId/requests/:requestId/submit', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const body = await c.req.json<{ expectedVersion?: unknown }>()
    return c.json({ data: await submitAdminAppNotificationTemplateReview(
      c.env.DB,
      config.policyId,
      c.req.param('templateId'),
      c.req.param('requestId'),
      c.get('userId')!,
      body.expectedVersion,
    ) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.post('/templates/:templateId/requests/:requestId/review', async (c) => {
  try {
    if (c.get('userRole') !== 'owner') {
      throw new AppNotificationError(403, 'OWNER_REVIEW_REQUIRED', '通知模板发布复核仅限 Owner')
    }
    const config = enabledConfig(c.env)
    return c.json({ data: await reviewAdminAppNotificationTemplate(
      c.env.DB,
      config.policyId,
      c.req.param('templateId'),
      c.req.param('requestId'),
      c.get('userId')!,
      await c.req.json<AdminNotificationTemplateReviewInput>(),
    ) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

adminAppNotificationRoutes.get('/deliveries', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const query = parseAdminAppNotificationDeliveryQuery({
      status: c.req.query('status'),
      category: c.req.query('category'),
      limit: c.req.query('limit'),
    })
    return c.json({ data: await listAdminAppNotificationDeliveries(c.env.DB, config.policyId, query) })
  }
  catch (error) {
    return handleNotificationError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppNotificationRuntimeConfig(env)
  requireAppNotificationsAdminEnabled(config)
  return config
}

function handleNotificationError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppNotificationError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
