import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { requireOwner } from '../../middleware/auth'
import { hashPassword } from '../../utils/password'
import { destroyAllUserSessions } from '../../utils/session'
import { validateUsername } from '@meigallery/shared/utils'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminUserRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET / - 用户列表（分页+搜索）
 * 查询参数：page, pageSize, q(搜索邮箱/用户名/昵称), role?, status?
 */
adminUserRoutes.get('/', async (c) => {
  const db = c.env.DB
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )
  const offset = (page - 1) * pageSize
  const keyword = c.req.query('q')?.trim()
  const filterRole = c.req.query('role')
  const filterStatus = c.req.query('status')

  let whereConditions: string[] = []
  const params: unknown[] = []

  if (keyword) {
    whereConditions.push('(u.email LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  if (filterRole) {
    whereConditions.push('u.role = ?')
    params.push(filterRole)
  }
  if (filterStatus) {
    whereConditions.push('u.status = ?')
    params.push(filterStatus)
  }

  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM users u ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  const users = await db
    .prepare(`
      SELECT u.id, u.email, u.username, u.nickname, u.role, u.status, u.created_at
      FROM users u
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all<{ id: string; email: string; username: string | null; nickname: string | null; role: string; status: string; created_at: string }>()

  // 批量查询有效会员
  const userIds = users.results.map(u => u.id)
  let membershipsMap: Record<string, { rank: number; expiresAt: string }> = {}

  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',')
    const memberships = await db
      .prepare(`
        SELECT um.user_id, MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry
        FROM user_memberships um
        JOIN membership_levels ml ON um.level_id = ml.id
        WHERE um.user_id IN (${placeholders})
          AND datetime('now') BETWEEN um.starts_at AND um.expires_at
        GROUP BY um.user_id
      `)
      .bind(...userIds)
      .all<{ user_id: string; max_rank: number; max_expiry: string }>()

    for (const m of memberships.results) {
      membershipsMap[m.user_id] = { rank: m.max_rank, expiresAt: m.max_expiry }
    }
  }

  const data = users.results.map(u => ({
    id: u.id,
    email: u.email,
    username: u.username,
    nickname: u.nickname,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    membershipRank: membershipsMap[u.id]?.rank ?? 0,
    membershipExpiry: membershipsMap[u.id]?.expiresAt ?? null,
  }))

  return c.json({ data, total, page, pageSize })
})

/**
 * GET /:id - 用户详情（含会员历史）
 */
adminUserRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB

  const user = await db
    .prepare('SELECT id, email, username, nickname, avatar_key, role, status, email_verified, notification_enabled, created_at, updated_at FROM users WHERE id = ?')
    .bind(id)
    .first<{
      id: string; email: string; username: string | null; nickname: string | null; avatar_key: string | null
      role: string; status: string; email_verified: number; notification_enabled: number
      created_at: string; updated_at: string
    }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  // 会员历史
  const memberships = await db
    .prepare(`
      SELECT um.id, ml.name as level_name, ml.rank, um.starts_at, um.expires_at,
             um.granted_by, um.note, um.created_at
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ?
      ORDER BY um.created_at DESC
    `)
    .bind(id)
    .all<{ id: string; level_name: string; rank: number; starts_at: string; expires_at: string; granted_by: string; note: string | null; created_at: string }>()

  return c.json({
    ...user,
    avatarKey: user.avatar_key,
    emailVerified: user.email_verified === 1,
    notificationEnabled: user.notification_enabled === 1,
    memberships: memberships.results,
  })
})

/**
 * PATCH /:id - 编辑用户基本信息（用户名、邮箱）
 * Body: { username?, email? }
 */
adminUserRoutes.patch('/:id', async (c) => {
  const userId = c.req.param('id')
  const adminId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ username?: string; email?: string }>()

  const user = await db
    .prepare('SELECT id, email, username, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; username: string | null; role: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  const updates: string[] = []
  const updateParams: unknown[] = []
  const beforeValue: Record<string, unknown> = {}
  const afterValue: Record<string, unknown> = {}

  // 用户名修改
  if (body.username !== undefined) {
    const newUsername = body.username.toLowerCase()
    const result = validateUsername(newUsername)
    if (!result.valid) {
      return c.json({ statusCode: 400, message: result.error }, 400)
    }
    // 唯一性检查（排除自己）
    const existing = await db
      .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .bind(newUsername, userId)
      .first()
    if (existing) {
      return c.json({ statusCode: 409, message: '该用户名已被使用' }, 409)
    }
    updates.push('username = ?')
    updateParams.push(newUsername)
    beforeValue.username = user.username
    afterValue.username = newUsername
  }

  // 邮箱修改（管理员操作不需要邮箱验证）
  if (body.email !== undefined) {
    const newEmail = body.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
    }
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(newEmail, userId)
      .first()
    if (existing) {
      return c.json({ statusCode: 409, message: '该邮箱已被使用' }, 409)
    }
    updates.push('email = ?')
    updateParams.push(newEmail)
    beforeValue.email = user.email
    afterValue.email = newEmail
  }

  if (updates.length === 0) {
    return c.json({ statusCode: 400, message: '没有需要修改的字段' }, 400)
  }

  updates.push("updated_at = datetime('now')")
  await db
    .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...updateParams, userId)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'edit_user',
    targetType: 'user',
    targetId: userId,
    beforeValue,
    afterValue,
  })

  return c.json({ message: '用户信息已更新' })
})

/**
 * POST /:id/reset-password - 管理员重置用户密码
 * Body: { newPassword: string }
 */
adminUserRoutes.post('/:id/reset-password', async (c) => {
  const userId = c.req.param('id')
  const adminId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ newPassword?: string }>()

  if (!body.newPassword || body.newPassword.length < 8) {
    return c.json({ statusCode: 400, message: '密码长度至少 8 位' }, 400)
  }

  const user = await db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; role: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  if (user.role === 'owner' && adminId !== userId) {
    return c.json({ statusCode: 403, message: '不能重置站长密码' }, 403)
  }

  const passwordHash = await hashPassword(body.newPassword)
  await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(passwordHash, userId)
    .run()

  // 清除该用户所有 session
  await destroyAllUserSessions(db, userId)

  await writeAuditLog(db, {
    adminId,
    action: 'reset_password',
    targetType: 'user',
    targetId: userId,
  })

  return c.json({ message: '密码已重置，用户所有会话已清除' })
})

/**
 * GET /:id/activity - 用户活动日志
 * 查询审计日志 + 最近 session
 */
adminUserRoutes.get('/:id/activity', async (c) => {
  const userId = c.req.param('id')
  const db = c.env.DB

  // 验证用户存在
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  // 审计日志（与该用户相关的操作）
  const auditLogs = await db
    .prepare(`
      SELECT id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      FROM admin_audit_logs
      WHERE (target_type = 'user' AND target_id = ?)
         OR (target_type = 'user_membership' AND JSON_EXTRACT(after_value, '$.userId') = ?)
      ORDER BY created_at DESC
      LIMIT 50
    `)
    .bind(userId, userId)
    .all<{
      id: string; admin_id: string; action: string; target_type: string; target_id: string | null
      before_value: string | null; after_value: string | null; created_at: string
    }>()

  // 最近登录 session
  const sessions = await db
    .prepare(`
      SELECT id, created_at FROM sessions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .bind(userId)
    .all<{ id: string; created_at: string }>()

  return c.json({
    auditLogs: auditLogs.results.map(log => ({
      id: log.id,
      adminId: log.admin_id,
      action: log.action,
      targetType: log.target_type,
      targetId: log.target_id,
      beforeValue: log.before_value ? JSON.parse(log.before_value) : null,
      afterValue: log.after_value ? JSON.parse(log.after_value) : null,
      createdAt: log.created_at,
    })),
    recentSessions: sessions.results.map(s => ({
      id: s.id,
      createdAt: s.created_at,
    })),
  })
})

/**
 * POST /:id/memberships - 发放会员等级
 * Body: { levelId, startsAt?, expiresAt, note? }
 */
adminUserRoutes.post('/:id/memberships', async (c) => {
  const userId = c.req.param('id')
  const adminId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{
    levelId?: string
    startsAt?: string
    expiresAt?: string
    note?: string
  }>()

  if (!body.levelId || !body.expiresAt) {
    return c.json({ statusCode: 400, message: 'levelId 和 expiresAt 为必填' }, 400)
  }

  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  const level = await db
    .prepare('SELECT id, name, rank FROM membership_levels WHERE id = ?')
    .bind(body.levelId)
    .first<{ id: string; name: string; rank: number }>()
  if (!level) {
    return c.json({ statusCode: 400, message: '会员等级不存在' }, 400)
  }

  const id = generateId('mem')
  const startsAt = body.startsAt || new Date().toISOString()

  await db
    .prepare('INSERT INTO user_memberships (id, user_id, level_id, starts_at, expires_at, granted_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, body.levelId, startsAt, body.expiresAt, adminId, body.note?.trim() || null)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'grant_membership',
    targetType: 'user_membership',
    targetId: id,
    afterValue: {
      userId,
      levelName: level.name,
      rank: level.rank,
      startsAt,
      expiresAt: body.expiresAt,
      note: body.note,
    },
  })

  return c.json({
    id,
    userId,
    levelId: body.levelId,
    levelName: level.name,
    rank: level.rank,
    startsAt,
    expiresAt: body.expiresAt,
    note: body.note?.trim() || null,
  }, 201)
})

/**
 * PATCH /:id/role - 修改用户角色（仅 Owner）
 * Body: { role: 'user' | 'admin' }
 */
adminUserRoutes.patch('/:id/role', requireOwner, async (c) => {
  const userId = c.req.param('id')
  const adminId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ role?: string }>()

  if (!body.role || !['user', 'admin'].includes(body.role)) {
    return c.json({ statusCode: 400, message: 'role 必须为 user 或 admin' }, 400)
  }

  const user = await db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; role: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  if (user.role === 'owner') {
    return c.json({ statusCode: 403, message: '不能修改站长角色' }, 403)
  }

  await db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(body.role, userId).run()

  await writeAuditLog(db, {
    adminId,
    action: 'change_role',
    targetType: 'user',
    targetId: userId,
    beforeValue: { role: user.role },
    afterValue: { role: body.role },
  })

  return c.json({ id: userId, role: body.role })
})

/**
 * PATCH /:id/status - 修改用户状态（封禁/解封）
 * Body: { status: 'active' | 'banned' }
 */
adminUserRoutes.patch('/:id/status', async (c) => {
  const userId = c.req.param('id')
  const adminId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ status?: string }>()

  if (!body.status || !['active', 'banned'].includes(body.status)) {
    return c.json({ statusCode: 400, message: 'status 必须为 active 或 banned' }, 400)
  }

  const user = await db
    .prepare('SELECT id, role, status FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; role: string; status: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  if (user.role === 'owner') {
    return c.json({ statusCode: 403, message: '不能修改站长状态' }, 403)
  }

  await db.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(body.status, userId).run()

  // 封禁时清除所有 session
  if (body.status === 'banned') {
    await destroyAllUserSessions(db, userId)
  }

  await writeAuditLog(db, {
    adminId,
    action: 'change_status',
    targetType: 'user',
    targetId: userId,
    beforeValue: { status: user.status },
    afterValue: { status: body.status },
  })

  return c.json({ id: userId, status: body.status })
})
