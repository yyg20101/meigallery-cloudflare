import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { adminGalleryRoutes } from './galleries'
import { adminTagRoutes } from './tags'
import { adminUserRoutes } from './users'
import { adminImportRoutes } from './import-jobs'
import { adminAuditRoutes } from './audit-logs'
import { adminSettingsRoutes } from './settings'

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// TODO: 添加管理员认证中间件
// adminRoutes.use('*', adminAuthMiddleware)

adminRoutes.route('/galleries', adminGalleryRoutes)
adminRoutes.route('/tags', adminTagRoutes)
adminRoutes.route('/users', adminUserRoutes)
adminRoutes.route('/import-jobs', adminImportRoutes)
adminRoutes.route('/audit-logs', adminAuditRoutes)
adminRoutes.route('/settings', adminSettingsRoutes)
