import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { hashPassword, verifyPassword } from '../utils/password'
import { createSession, destroyAllUserSessions } from '../utils/session'
import { generateId } from '../utils/db'
import { sendRegistrationCode, sendPasswordResetCode } from '../services/email'

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ============================================================
// 验证码配置
// ============================================================

const CODE_LENGTH = 6
const CODE_TTL_MS = 10 * 60 * 1000     // 10 分钟
const CODE_COOLDOWN_MS = 60 * 1000      // 60 秒冷却
const MAX_ATTEMPTS = 3                   // 最多错误次数

/** 生成 6 位数字验证码 */
function generateVerificationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  const num = (bytes[0]! << 24 | bytes[1]! << 16 | bytes[2]! << 8 | bytes[3]!) >>> 0
  return String(num % 1_000_000).padStart(CODE_LENGTH, '0')
}

// ============================================================
// POST /api/auth/send-code - 发送验证码
// ============================================================

authRoutes.post('/send-code', async (c) => {
  const body = await c.req.json<{
    email?: string
    purpose?: string
    turnstileToken?: string
  }>()

  if (!body.email || !body.purpose) {
    return c.json({ statusCode: 400, message: '邮箱和用途为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
  }

  const purpose = body.purpose
  if (purpose !== 'register' && purpose !== 'password_reset') {
    return c.json({ statusCode: 400, message: 'purpose 必须为 register 或 password_reset' }, 400)
  }

  // Turnstile 验证
  if (c.env.TURNSTILE_SECRET_KEY) {
    if (!body.turnstileToken) {
      return c.json({ statusCode: 400, message: '请完成人机验证' }, 400)
    }
    const verified = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken)
    if (!verified) {
      return c.json({ statusCode: 400, message: '人机验证失败，请重试' }, 400)
    }
  }

  const db = c.env.DB

  // 注册场景：检查邮箱是否已注册
  if (purpose === 'register') {
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first()
    if (existing) {
      return c.json({ statusCode: 409, message: '该邮箱已注册' }, 409)
    }
  }

  // 密码重置场景：检查邮箱是否存在（不暴露，静默返回成功）
  if (purpose === 'password_reset') {
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first()
    if (!existing) {
      // 不暴露用户不存在，返回成功假象
      return c.json({ message: '验证码已发送', cooldown: CODE_COOLDOWN_MS / 1000 })
    }
  }

  // 冷却检查：60 秒内不可重发
  const recentCode = await db
    .prepare(
      `SELECT id FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND created_at > datetime('now', '-60 seconds')
       LIMIT 1`,
    )
    .bind(email, purpose)
    .first()

  if (recentCode) {
    return c.json({ statusCode: 429, message: '请等待 60 秒后重试' }, 429)
  }

  // 生成验证码
  const code = generateVerificationCode()
  const id = generateId('evc')
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  // 作废同邮箱同用途的旧验证码
  await db
    .prepare(
      `UPDATE email_verification_codes SET used = 1
       WHERE email = ? AND purpose = ? AND used = 0`,
    )
    .bind(email, purpose)
    .run()

  // 存入新验证码
  await db
    .prepare(
      `INSERT INTO email_verification_codes (id, email, code, purpose, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, email, code, purpose, expiresAt)
    .run()

  // 发送邮件
  try {
    if (purpose === 'register') {
      await sendRegistrationCode(c.env, email, code)
    } else {
      await sendPasswordResetCode(c.env, email, code)
    }
  } catch (e) {
    console.error('邮件发送失败:', e)
    return c.json({ statusCode: 500, message: '邮件发送失败，请稍后重试' }, 500)
  }

  return c.json({ message: '验证码已发送', cooldown: CODE_COOLDOWN_MS / 1000 })
})

// ============================================================
// POST /api/auth/register - 用户注册（含验证码校验）
// ============================================================

authRoutes.post('/register', async (c) => {
  const body = await c.req.json<{
    email?: string
    password?: string
    nickname?: string
    code?: string
    turnstileToken?: string
  }>()

  // 参数校验
  if (!body.email || !body.password) {
    return c.json({ statusCode: 400, message: '邮箱和密码为必填' }, 400)
  }

  if (!body.code) {
    return c.json({ statusCode: 400, message: '验证码为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
  }

  if (body.password.length < 8) {
    return c.json({ statusCode: 400, message: '密码长度至少 8 位' }, 400)
  }

  // Turnstile 验证
  if (c.env.TURNSTILE_SECRET_KEY) {
    if (!body.turnstileToken) {
      return c.json({ statusCode: 400, message: '请完成人机验证' }, 400)
    }
    const verified = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken)
    if (!verified) {
      return c.json({ statusCode: 400, message: '人机验证失败，请重试' }, 400)
    }
  }

  const db = c.env.DB

  // 校验验证码
  const codeValid = await verifyCode(db, email, body.code, 'register')
  if (!codeValid.success) {
    return c.json({ statusCode: 400, message: codeValid.error }, 400)
  }

  // 检查邮箱是否已注册
  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()

  if (existing) {
    return c.json({ statusCode: 409, message: '该邮箱已注册' }, 409)
  }

  // 创建用户（已验证邮箱）
  const userId = generateId('usr')
  const passwordHash = await hashPassword(body.password)

  await db
    .prepare(
      `INSERT INTO users (id, email, nickname, password_hash, role, status, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, email, body.nickname?.trim() || null, passwordHash, 'user', 'active', 1)
    .run()

  // 创建会话
  await createSession(c, userId)

  return c.json({
    id: userId,
    email,
    nickname: body.nickname?.trim() || null,
    role: 'user',
    status: 'active',
    membershipRank: 0,
    membershipExpiry: null,
  }, 201)
})

// ============================================================
// POST /api/auth/reset-password - 密码重置
// ============================================================

authRoutes.post('/reset-password', async (c) => {
  const body = await c.req.json<{
    email?: string
    code?: string
    newPassword?: string
  }>()

  if (!body.email || !body.code || !body.newPassword) {
    return c.json({ statusCode: 400, message: '邮箱、验证码和新密码为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()

  if (body.newPassword.length < 8) {
    return c.json({ statusCode: 400, message: '密码长度至少 8 位' }, 400)
  }

  const db = c.env.DB

  // 校验验证码
  const codeValid = await verifyCode(db, email, body.code, 'password_reset')
  if (!codeValid.success) {
    return c.json({ statusCode: 400, message: codeValid.error }, 400)
  }

  // 查找用户
  const user = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  // 更新密码
  const passwordHash = await hashPassword(body.newPassword)
  await db
    .prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(passwordHash, user.id)
    .run()

  // 清除所有已有 session
  await destroyAllUserSessions(db, user.id)

  return c.json({ message: '密码重置成功，请重新登录' })
})

// ============================================================
// POST /api/auth/login - 用户登录
// ============================================================

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{
    email?: string
    password?: string
    turnstileToken?: string
  }>()

  if (!body.email || !body.password) {
    return c.json({ statusCode: 400, message: '邮箱和密码为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()

  // Turnstile 验证
  if (c.env.TURNSTILE_SECRET_KEY) {
    if (!body.turnstileToken) {
      return c.json({ statusCode: 400, message: '请完成人机验证' }, 400)
    }
    const verified = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken)
    if (!verified) {
      return c.json({ statusCode: 400, message: '人机验证失败，请重试' }, 400)
    }
  }

  const db = c.env.DB

  // 查找用户
  const user = await db
    .prepare('SELECT id, email, nickname, password_hash, role, status FROM users WHERE email = ?')
    .bind(email)
    .first<{
      id: string
      email: string
      nickname: string | null
      password_hash: string
      role: string
      status: string
    }>()

  if (!user) {
    return c.json({ statusCode: 401, message: '邮箱或密码错误' }, 401)
  }

  // 检查用户状态
  if (user.status !== 'active') {
    return c.json({ statusCode: 403, message: '账号已被禁用' }, 403)
  }

  // 验证密码
  const valid = await verifyPassword(body.password, user.password_hash)
  if (!valid) {
    return c.json({ statusCode: 401, message: '邮箱或密码错误' }, 401)
  }

  // 创建会话
  await createSession(c, user.id)

  // 查询会员等级
  const membership = await db
    .prepare(`
      SELECT MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ? AND datetime('now') BETWEEN um.starts_at AND um.expires_at
    `)
    .bind(user.id)
    .first<{ max_rank: number | null; max_expiry: string | null }>()

  return c.json({
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    membershipRank: membership?.max_rank ?? 0,
    membershipExpiry: membership?.max_expiry ?? null,
  })
})

// ============================================================
// POST /api/auth/logout - 登出
// ============================================================

authRoutes.post('/logout', async (c) => {
  const { destroySession } = await import('../utils/session')
  await destroySession(c)
  return c.json({ message: '已登出' })
})

// ============================================================
// 内部工具函数
// ============================================================

async function verifyTurnstile(secretKey: string, token: string): Promise<boolean> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token }),
  })
  const result = await response.json() as { success: boolean }
  return result.success
}

/**
 * 验证邮箱验证码
 * 成功后标记为已使用，失败则增加尝试次数
 */
async function verifyCode(
  db: D1Database,
  email: string,
  code: string,
  purpose: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const record = await db
    .prepare(
      `SELECT id, code, attempts, expires_at FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND used = 0
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(email, purpose)
    .first<{ id: string; code: string; attempts: number; expires_at: string }>()

  if (!record) {
    return { success: false, error: '验证码不存在或已失效，请重新发送' }
  }

  // 检查过期
  if (new Date(record.expires_at) < new Date()) {
    await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
    return { success: false, error: '验证码已过期，请重新发送' }
  }

  // 检查尝试次数
  if (record.attempts >= MAX_ATTEMPTS) {
    await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
    return { success: false, error: '验证码错误次数过多，请重新发送' }
  }

  // 校验验证码
  if (record.code !== code) {
    await db
      .prepare('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?')
      .bind(record.id)
      .run()
    const remaining = MAX_ATTEMPTS - record.attempts - 1
    return { success: false, error: `验证码错误，还可尝试 ${remaining} 次` }
  }

  // 成功：标记已使用
  await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
  return { success: true }
}
