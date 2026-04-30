import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { requireAuth } from '../middleware/auth'
import { hashPassword, verifyPassword } from '../utils/password'
import { destroyOtherSessions } from '../utils/session'
import { validateUsername } from '@meigallery/shared/utils'

export const meRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/me - 当前用户信息和会员状态
 */
meRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const user = await db
    .prepare('SELECT id, email, username, nickname, avatar_key, role, status, notification_enabled, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{
      id: string; email: string; username: string | null; nickname: string | null
      avatar_key: string | null; role: string; status: string
      notification_enabled: number; created_at: string
    }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  // 查询有效会员
  const membership = await db
    .prepare(`
      SELECT MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry, ml.name as level_name
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ? AND datetime('now') BETWEEN um.starts_at AND um.expires_at
    `)
    .bind(userId)
    .first<{ max_rank: number | null; max_expiry: string | null; level_name: string | null }>()

  return c.json({
    id: user.id,
    email: user.email,
    username: user.username,
    nickname: user.nickname,
    avatarKey: user.avatar_key,
    role: user.role,
    status: user.status,
    notificationEnabled: user.notification_enabled === 1,
    createdAt: user.created_at,
    membershipRank: membership?.max_rank ?? 0,
    membershipExpiry: membership?.max_expiry ?? null,
    membershipName: membership?.level_name ?? null,
  })
})

/**
 * PATCH /api/me/profile - 修改用户名
 * Body: { username: string }
 */
meRoutes.patch('/profile', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ username?: string }>()

  if (!body.username) {
    return c.json({ statusCode: 400, message: '用户名为必填' }, 400)
  }

  const newUsername = body.username.toLowerCase()
  const result = validateUsername(newUsername)
  if (!result.valid) {
    return c.json({ statusCode: 400, message: result.error }, 400)
  }

  // 唯一性检查
  const existing = await db
    .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
    .bind(newUsername, userId)
    .first()
  if (existing) {
    return c.json({ statusCode: 409, message: '该用户名已被使用' }, 409)
  }

  await db
    .prepare("UPDATE users SET username = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newUsername, userId)
    .run()

  return c.json({ username: newUsername })
})

/**
 * PATCH /api/me/password - 修改密码
 * Body: { oldPassword: string, newPassword: string }
 */
meRoutes.patch('/password', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ oldPassword?: string; newPassword?: string }>()

  if (!body.oldPassword || !body.newPassword) {
    return c.json({ statusCode: 400, message: '旧密码和新密码为必填' }, 400)
  }
  if (body.newPassword.length < 8) {
    return c.json({ statusCode: 400, message: '新密码长度至少 8 位' }, 400)
  }

  const user = await db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  const valid = await verifyPassword(body.oldPassword, user.password_hash)
  if (!valid) {
    return c.json({ statusCode: 401, message: '旧密码错误' }, 401)
  }

  const passwordHash = await hashPassword(body.newPassword)
  await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(passwordHash, userId)
    .run()

  // 清除其他 session，保留当前
  const sessionToken = c.req.header('Cookie')?.match(/mei_session=([^;]+)/)?.[1]
  if (sessionToken) {
    await destroyOtherSessions(db, userId, sessionToken)
  }

  return c.json({ message: '密码已修改' })
})

/**
 * POST /api/me/avatar - 上传头像
 * multipart/form-data, field: avatar
 */
meRoutes.post('/avatar', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const formData = await c.req.formData()
  const file = formData.get('avatar')

  if (!file || typeof (file as any).arrayBuffer !== 'function') {
    return c.json({ statusCode: 400, message: '请上传头像文件' }, 400)
  }

  const uploadFile = file as unknown as File

  // 格式校验
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
  if (!allowedTypes.includes(uploadFile.type)) {
    return c.json({ statusCode: 400, message: '仅支持 JPG、PNG、WebP 格式' }, 400)
  }

  // 大小校验（2MB）
  if (uploadFile.size > 2 * 1024 * 1024) {
    return c.json({ statusCode: 400, message: '图片大小不能超过 2MB' }, 400)
  }

  // 确定扩展名
  const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  const ext = extMap[uploadFile.type] || 'jpg'
  const key = `avatars/${userId}.${ext}`

  // 上传到 R2
  const arrayBuffer = await uploadFile.arrayBuffer()
  await c.env.R2.put(key, arrayBuffer, {
    httpMetadata: { contentType: uploadFile.type },
  })

  // 更新数据库
  await db
    .prepare("UPDATE users SET avatar_key = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(key, userId)
    .run()

  return c.json({ avatarKey: key })
})

/**
 * PATCH /api/me/notifications - 修改通知偏好
 * Body: { enabled: boolean }
 */
meRoutes.patch('/notifications', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ enabled?: boolean }>()

  if (body.enabled === undefined) {
    return c.json({ statusCode: 400, message: 'enabled 为必填' }, 400)
  }

  await db
    .prepare("UPDATE users SET notification_enabled = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(body.enabled ? 1 : 0, userId)
    .run()

  return c.json({ notificationEnabled: body.enabled })
})

/**
 * PATCH /api/me/email - 修改绑定邮箱
 * Body: { newEmail: string, password: string, code?: string }
 * 验证关闭时不需要 code，开启时需要验证码
 */
meRoutes.patch('/email', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const body = await c.req.json<{ newEmail?: string; password?: string; code?: string }>()

  if (!body.newEmail || !body.password) {
    return c.json({ statusCode: 400, message: '新邮箱和密码为必填' }, 400)
  }

  const newEmail = body.newEmail.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
  }

  // 验证密码
  const user = await db
    .prepare('SELECT password_hash, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string; email: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  if (newEmail === user.email) {
    return c.json({ statusCode: 400, message: '新邮箱与当前邮箱相同' }, 400)
  }

  const valid = await verifyPassword(body.password, user.password_hash)
  if (!valid) {
    return c.json({ statusCode: 401, message: '密码错误' }, 401)
  }

  // 检查新邮箱唯一性
  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
    .bind(newEmail, userId)
    .first()
  if (existing) {
    return c.json({ statusCode: 409, message: '该邮箱已被其他账号使用' }, 409)
  }

  // 检查邮箱验证开关
  const settingRow = await db
    .prepare("SELECT value FROM site_settings WHERE key = 'email_verification_enabled'")
    .first<{ value: string }>()
  const verificationEnabled = settingRow ? (JSON.parse(settingRow.value) === true || JSON.parse(settingRow.value) === 'true') : false

  if (verificationEnabled) {
    // 需要验证码
    if (!body.code) {
      return c.json({ statusCode: 400, message: '邮箱验证已开启，请提供验证码' }, 400)
    }
    // 复用 verifyCode 逻辑
    const record = await db
      .prepare(
        `SELECT id, code, attempts, expires_at FROM email_verification_codes
         WHERE email = ? AND purpose = 'email_change' AND used = 0
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(newEmail)
      .first<{ id: string; code: string; attempts: number; expires_at: string }>()

    if (!record) {
      return c.json({ statusCode: 400, message: '验证码不存在或已失效' }, 400)
    }
    if (new Date(record.expires_at) < new Date()) {
      await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
      return c.json({ statusCode: 400, message: '验证码已过期' }, 400)
    }
    if (record.attempts >= 3) {
      await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
      return c.json({ statusCode: 400, message: '验证码错误次数过多' }, 400)
    }
    if (record.code !== body.code) {
      await db.prepare('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?').bind(record.id).run()
      return c.json({ statusCode: 400, message: '验证码错误' }, 400)
    }
    await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
  }

  // 更新邮箱
  await db
    .prepare("UPDATE users SET email = ?, email_verified = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newEmail, verificationEnabled ? 1 : 0, userId)
    .run()

  return c.json({ email: newEmail })
})
