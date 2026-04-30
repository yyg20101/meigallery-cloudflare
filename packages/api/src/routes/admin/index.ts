import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { adminGalleryRoutes } from './galleries'
import { adminTagRoutes } from './tags'
import { adminUserRoutes } from './users'
import { adminImportRoutes } from './import-jobs'
import { adminAuditLogRoutes as adminAuditRoutes } from './audit-logs'
import { adminSettingsRoutes } from './settings'
import { adminLegacyImportRoutes } from './legacy-import'
import { adminContactMethodRoutes } from './contact-methods'

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// TODO: 添加管理员认证中间件
// adminRoutes.use('*', adminAuthMiddleware)

adminRoutes.get('/dashboard', async (c) => {
  const db = c.env.DB
  const [galleries, published, users, vipUsers, importJobs] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM galleries').first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM galleries WHERE status = 'published'").first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(DISTINCT um.user_id) as count
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE ml.rank > 0 AND datetime('now') BETWEEN um.starts_at AND um.expires_at
    `).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM import_jobs WHERE status = 'processing'").first<{ count: number }>(),
  ])

  return c.json({
    totalGalleries: galleries?.count ?? 0,
    publishedGalleries: published?.count ?? 0,
    totalUsers: users?.count ?? 0,
    activeVipUsers: vipUsers?.count ?? 0,
    processingImports: importJobs?.count ?? 0,
  })
})

adminRoutes.route('/galleries', adminGalleryRoutes)
adminRoutes.route('/tags', adminTagRoutes)
adminRoutes.route('/users', adminUserRoutes)
adminRoutes.route('/import-jobs', adminImportRoutes)
adminRoutes.route('/audit-logs', adminAuditRoutes)
adminRoutes.route('/settings', adminSettingsRoutes)
adminRoutes.route('/legacy-import', adminLegacyImportRoutes)
adminRoutes.route('/contact-methods', adminContactMethodRoutes)
