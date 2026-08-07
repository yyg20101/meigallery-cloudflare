import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  getAdminAppNotificationOverview,
  listAdminAppNotificationDefinitions,
  listAdminAppNotificationDeliveries,
  listAdminAppNotificationTemplates,
  parseAdminAppNotificationDeliveryQuery,
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
