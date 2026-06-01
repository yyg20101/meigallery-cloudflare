import { PAGINATION } from '@meigallery/shared/constants'
import { validateUsername } from '@meigallery/shared/utils'
import { generateId } from '../utils/db'
import { writeAuditLog } from '../utils/permission'
import { hashPassword } from '../utils/password'
import { destroyAllUserSessions } from '../utils/session'

export interface ListAdminUsersParams {
  page?: string | null
  pageSize?: string | null
  keyword?: string | null
  role?: string | null
  status?: string | null
}

export interface AdminUserListItem {
  id: number
  email: string
  username: string | null
  nickname: string | null
  role: string
  status: string
  createdAt: string
  membershipRank: number
  membershipExpiry: string | null
}

export interface AdminUserListResult {
  data: AdminUserListItem[]
  total: number
  page: number
  pageSize: number
}

export interface AdminUserDetail {
  id: number
  email: string
  username: string | null
  nickname: string | null
  avatarKey: string | null
  role: string
  status: string
  emailVerified: boolean
  notificationEnabled: boolean
  createdAt: string
  updatedAt: string
  memberships: Array<{
    id: string
    levelName: string
    rank: number
    startsAt: string
    expiresAt: string
    grantedBy: string
    note: string | null
    createdAt: string
  }>
}

export interface AdminUserActivity {
  auditLogs: Array<{
    id: string
    adminId: number
    action: string
    targetType: string
    targetId: string | null
    beforeValue: unknown
    afterValue: unknown
    createdAt: string
  }>
  recentSessions: Array<{
    id: string
    createdAt: string
  }>
}

export interface AdminUserProfileUpdateInput {
  username?: string
  email?: string
}

export interface AdminUserMembershipGrantInput {
  levelId?: string
  startsAt?: string
  expiresAt?: string
  note?: string
}

export class AdminUserError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AdminUserError'
  }
}

interface UserRow {
  id: number
  email: string
  username: string | null
  nickname: string | null
  role: string
  status: string
  created_at: string
}

interface MembershipRow {
  user_id: number
  max_rank: number
  max_expiry: string
}

interface UserDetailRow {
  id: number
  email: string
  username: string | null
  nickname: string | null
  avatar_key: string | null
  role: string
  status: string
  email_verified: number
  notification_enabled: number
  created_at: string
  updated_at: string
}

interface UserMembershipDetailRow {
  id: string
  level_name: string
  rank: number
  starts_at: string
  expires_at: string
  granted_by: string
  note: string | null
  created_at: string
}

function toSqliteDatetime(iso: string) {
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '')
}

function parsePage(value: string | null | undefined): number {
  const parsed = Number.parseInt(value || String(PAGINATION.DEFAULT_PAGE), 10)
  return Math.max(1, Number.isNaN(parsed) ? PAGINATION.DEFAULT_PAGE : parsed)
}

function parsePageSize(value: string | null | undefined): number {
  const parsed = Number.parseInt(value || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)
  const pageSize = Number.isNaN(parsed) ? PAGINATION.DEFAULT_PAGE_SIZE : parsed
  return Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, pageSize))
}

function buildUserListFilter(params: ListAdminUsersParams): { whereClause: string; values: unknown[] } {
  const keyword = params.keyword?.trim()
  const whereConditions: string[] = []
  const values: unknown[] = []

  if (keyword) {
    whereConditions.push('(u.email LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)')
    values.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }

  if (params.role) {
    whereConditions.push('u.role = ?')
    values.push(params.role)
  }

  if (params.status) {
    whereConditions.push('u.status = ?')
    values.push(params.status)
  }

  return {
    whereClause: whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '',
    values,
  }
}

export async function listAdminUsers(
  db: D1Database,
  params: ListAdminUsersParams,
): Promise<AdminUserListResult> {
  const page = parsePage(params.page)
  const pageSize = parsePageSize(params.pageSize)
  const offset = (page - 1) * pageSize
  const filter = buildUserListFilter(params)

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM users u ${filter.whereClause}`)
    .bind(...filter.values)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  const users = await db
    .prepare(`
      SELECT u.id, u.email, u.username, u.nickname, u.role, u.status, u.created_at
      FROM users u
      ${filter.whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...filter.values, pageSize, offset)
    .all<UserRow>()

  const userIds = users.results.map(user => user.id)
  const membershipsMap: Record<number, { rank: number; expiresAt: string }> = {}

  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',')
    const memberships = await db
      .prepare(`
        SELECT um.user_id, MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry
        FROM user_memberships um
        JOIN membership_levels ml ON um.level_id = ml.id
        WHERE um.user_id IN (${placeholders})
          AND datetime('now') BETWEEN datetime(um.starts_at) AND datetime(um.expires_at)
        GROUP BY um.user_id
      `)
      .bind(...userIds)
      .all<MembershipRow>()

    for (const membership of memberships.results) {
      membershipsMap[membership.user_id] = {
        rank: membership.max_rank,
        expiresAt: membership.max_expiry,
      }
    }
  }

  return {
    data: users.results.map(user => ({
      id: user.id,
      email: user.email,
      username: user.username,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      membershipRank: membershipsMap[user.id]?.rank ?? 0,
      membershipExpiry: membershipsMap[user.id]?.expiresAt ?? null,
    })),
    total,
    page,
    pageSize,
  }
}

export async function getAdminUserDetail(db: D1Database, id: number): Promise<AdminUserDetail> {
  const user = await db
    .prepare('SELECT id, email, username, nickname, avatar_key, role, status, email_verified, notification_enabled, created_at, updated_at FROM users WHERE id = ?')
    .bind(id)
    .first<UserDetailRow>()

  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

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
    .all<UserMembershipDetailRow>()

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    nickname: user.nickname,
    avatarKey: user.avatar_key,
    role: user.role,
    status: user.status,
    emailVerified: user.email_verified === 1,
    notificationEnabled: user.notification_enabled === 1,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    memberships: memberships.results.map(membership => ({
      id: membership.id,
      levelName: membership.level_name,
      rank: membership.rank,
      startsAt: membership.starts_at,
      expiresAt: membership.expires_at,
      grantedBy: membership.granted_by,
      note: membership.note,
      createdAt: membership.created_at,
    })),
  }
}

export async function getAdminUserActivity(db: D1Database, id: number): Promise<AdminUserActivity> {
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()
  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

  const auditLogs = await db
    .prepare(`
      SELECT id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      FROM admin_audit_logs
      WHERE (target_type = 'user' AND target_id = ?)
         OR (target_type = 'user_membership' AND JSON_EXTRACT(after_value, '$.userId') = ?)
      ORDER BY created_at DESC
      LIMIT 50
    `)
    .bind(String(id), String(id))
    .all<{
      id: string
      admin_id: number
      action: string
      target_type: string
      target_id: string | null
      before_value: string | null
      after_value: string | null
      created_at: string
    }>()

  const sessions = await db
    .prepare(`
      SELECT id, created_at FROM sessions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .bind(id)
    .all<{ id: string; created_at: string }>()

  return {
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
    recentSessions: sessions.results.map(session => ({
      id: session.id,
      createdAt: session.created_at,
    })),
  }
}

export async function updateAdminUserProfile(
  db: D1Database,
  adminId: number,
  userId: number,
  body: AdminUserProfileUpdateInput,
): Promise<{ message: string }> {
  const user = await db
    .prepare('SELECT id, email, username, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; email: string; username: string | null; role: string }>()

  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

  const updates: string[] = []
  const updateParams: unknown[] = []
  const beforeValue: Record<string, unknown> = {}
  const afterValue: Record<string, unknown> = {}

  if (body.username !== undefined) {
    const newUsername = body.username.toLowerCase()
    const result = validateUsername(newUsername)
    if (!result.valid) {
      throw new AdminUserError(400, result.error)
    }
    const existing = await db
      .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .bind(newUsername, userId)
      .first()
    if (existing) {
      throw new AdminUserError(409, '该用户名已被使用')
    }
    updates.push('username = ?')
    updateParams.push(newUsername)
    beforeValue.username = user.username
    afterValue.username = newUsername
  }

  if (body.email !== undefined) {
    const newEmail = body.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      throw new AdminUserError(400, '邮箱格式无效')
    }
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(newEmail, userId)
      .first()
    if (existing) {
      throw new AdminUserError(409, '该邮箱已被使用')
    }
    updates.push('email = ?')
    updateParams.push(newEmail)
    beforeValue.email = user.email
    afterValue.email = newEmail
  }

  if (updates.length === 0) {
    throw new AdminUserError(400, '没有需要修改的字段')
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
    targetId: String(userId),
    beforeValue,
    afterValue,
  })

  return { message: '用户信息已更新' }
}

export async function resetAdminUserPassword(
  db: D1Database,
  adminId: number,
  userId: number,
  newPassword: string | undefined,
): Promise<{ message: string }> {
  if (!newPassword || newPassword.length < 8) {
    throw new AdminUserError(400, '密码长度至少 8 位')
  }

  const user = await db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; role: string }>()

  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

  if (user.role === 'owner' && adminId !== userId) {
    throw new AdminUserError(403, '不能重置站长密码')
  }

  const passwordHash = await hashPassword(newPassword)
  await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(passwordHash, userId)
    .run()

  await destroyAllUserSessions(db, userId)

  await writeAuditLog(db, {
    adminId,
    action: 'reset_password',
    targetType: 'user',
    targetId: String(userId),
  })

  return { message: '密码已重置，用户所有会话已清除' }
}

export async function grantAdminUserMembership(
  db: D1Database,
  adminId: number,
  userId: number,
  body: AdminUserMembershipGrantInput,
): Promise<{
  id: string
  userId: number
  levelId: string
  levelName: string
  rank: number
  startsAt: string
  expiresAt: string
  note: string | null
}> {
  if (!body.levelId || !body.expiresAt) {
    throw new AdminUserError(400, 'levelId 和 expiresAt 为必填')
  }

  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

  const level = await db
    .prepare('SELECT id, name, rank FROM membership_levels WHERE id = ?')
    .bind(body.levelId)
    .first<{ id: string; name: string; rank: number }>()
  if (!level) {
    throw new AdminUserError(400, '会员等级不存在')
  }

  const id = generateId('mem')
  const startsAt = toSqliteDatetime(body.startsAt || new Date().toISOString())
  const expiresAt = toSqliteDatetime(body.expiresAt)

  await db
    .prepare('INSERT INTO user_memberships (id, user_id, level_id, starts_at, expires_at, granted_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, body.levelId, startsAt, expiresAt, adminId, body.note?.trim() || null)
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
      expiresAt,
      note: body.note,
    },
  })

  return {
    id,
    userId,
    levelId: body.levelId,
    levelName: level.name,
    rank: level.rank,
    startsAt,
    expiresAt,
    note: body.note?.trim() || null,
  }
}

export async function changeAdminUserRole(
  db: D1Database,
  adminId: number,
  userId: number,
  role: string | undefined,
): Promise<{ id: number; role: string }> {
  if (!role || !['user', 'admin'].includes(role)) {
    throw new AdminUserError(400, 'role 必须为 user 或 admin')
  }

  const user = await db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; role: string }>()

  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

  if (user.role === 'owner') {
    throw new AdminUserError(403, '不能修改站长角色')
  }

  await db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(role, userId).run()

  await writeAuditLog(db, {
    adminId,
    action: 'change_role',
    targetType: 'user',
    targetId: String(userId),
    beforeValue: { role: user.role },
    afterValue: { role },
  })

  return { id: userId, role }
}

export async function changeAdminUserStatus(
  db: D1Database,
  adminId: number,
  userId: number,
  status: string | undefined,
): Promise<{ id: number; status: string }> {
  if (!status || !['active', 'banned'].includes(status)) {
    throw new AdminUserError(400, 'status 必须为 active 或 banned')
  }

  const user = await db
    .prepare('SELECT id, role, status FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; role: string; status: string }>()

  if (!user) {
    throw new AdminUserError(404, '用户不存在')
  }

  if (user.role === 'owner') {
    throw new AdminUserError(403, '不能修改站长状态')
  }

  await db.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, userId).run()

  if (status === 'banned') {
    await destroyAllUserSessions(db, userId)
  }

  await writeAuditLog(db, {
    adminId,
    action: 'change_status',
    targetType: 'user',
    targetId: String(userId),
    beforeValue: { status: user.status },
    afterValue: { status },
  })

  return { id: userId, status }
}
