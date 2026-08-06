import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'
import { adminGalleryRoutes } from './galleries'
import { adminTagRoutes } from './tags'
import { adminUserRoutes } from './users'
import { adminImportRoutes } from './import-jobs'
import { adminAuditLogRoutes as adminAuditRoutes } from './audit-logs'
import { adminSettingsRoutes } from './settings'
import { adminLegacyImportRoutes } from './legacy-import'
import { adminContactMethodRoutes } from './contact-methods'
import { adminMediaRoutes } from './media'
import { adminCaseRoutes } from './cases'
import { adminImportApiTokenRoutes } from './import-api-tokens'
import { adminExternalImportRecordRoutes } from './external-import-records'
import { adminAdRoutes } from './ads'
import { adminInviteCodeRoutes } from './invite-codes'
import { adminAnalyticsRoutes } from './analytics'
import { adminTrackingSourceRoutes } from './tracking-sources'
import { adminAttributionRoutes } from './attribution'
import { adminAppPersonRoutes } from './app-persons'
import { adminAppMembershipRoutes } from './app-memberships'

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminRoutes.use('*', requireAdmin)

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
      WHERE ml.rank > 0 AND datetime('now') BETWEEN datetime(um.starts_at) AND datetime(um.expires_at)
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
adminRoutes.route('/cases', adminCaseRoutes)
adminRoutes.route('/ads', adminAdRoutes)
adminRoutes.route('/import-api-tokens', adminImportApiTokenRoutes)
adminRoutes.route('/external-import-records', adminExternalImportRecordRoutes)
adminRoutes.route('/invite-codes', adminInviteCodeRoutes)
adminRoutes.route('/tracking-sources', adminTrackingSourceRoutes)
adminRoutes.route('/analytics', adminAnalyticsRoutes)
adminRoutes.route('/attribution', adminAttributionRoutes)
adminRoutes.route('/app/persons', adminAppPersonRoutes)
adminRoutes.route('/app/memberships', adminAppMembershipRoutes)
adminRoutes.route('/', adminMediaRoutes)
