import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  AdminAppSearchError,
  getAdminAppSearchOverview,
} from '../../services/admin-app-search'
import { errorJson } from '../../utils/api-error'

export const adminAppSearchRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

adminAppSearchRoutes.get('/overview', async (c) => {
  try {
    return c.json({ data: await getAdminAppSearchOverview(c.env.DB, c.env) })
  }
  catch (error) {
    if (error instanceof AdminAppSearchError) {
      return errorJson(c, error.status, error.message, {
        code: error.code,
      })
    }
    throw error
  }
})
