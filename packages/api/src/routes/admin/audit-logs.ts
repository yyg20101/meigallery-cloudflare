import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminAuditLogRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAuditLogRoutes.get('/', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const userRole = c.get('userRole')!
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )
  const offset = (page - 1) * pageSize
  const filterAction = c.req.query('action')
  const filterTargetType = c.req.query('targetType')

  const conditions: string[] = []
  const params: unknown[] = []

  if (userRole !== 'owner') {
    conditions.push('al.admin_id = ?')
    params.push(userId)
  }

  if (filterAction) {
    conditions.push('al.action = ?')
    params.push(filterAction)
  }

  if (filterTargetType) {
    conditions.push('al.target_type = ?')
    params.push(filterTargetType)
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM admin_audit_logs al ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  const logs = await db
    .prepare(`
      SELECT al.id, al.admin_id, u.email as admin_email, u.nickname as admin_nickname,
             al.action, al.target_type, al.target_id, al.before_value, al.after_value, al.created_at
      FROM admin_audit_logs al
      JOIN users u ON al.admin_id = u.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all()

  return c.json({ data: logs.results, total, page, pageSize })
})
