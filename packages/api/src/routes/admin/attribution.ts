import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { adminAdPlatformRoutes } from './ad-platforms'
import { adminAttributionDashboardRoutes } from './attribution-dashboard'

export const adminAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAttributionRoutes.route('/', adminAttributionDashboardRoutes)
adminAttributionRoutes.route('/platforms', adminAdPlatformRoutes)
