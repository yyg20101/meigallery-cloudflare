import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { hashPassword, verifyPassword } from '../utils/password'
import { createSession, destroySession } from '../utils/session'
import { generateId } from '../utils/db'

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * POST /api/auth/register - 用户注册
 */
authRoutes.post('/register', async (c) => {
  const body = await c.req.json<{
    email?: string
    password?: string
    nickname?: string
    turnstileToken?: string
  }>()

  // 参数校验
  if (!body.email || !body.password) {
    return c.json({ statusCode: 400, message: '邮箱和密码为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
  }

  if (body.password.length < 8) {
    return c.json({ statusCode: 400, message: '密码长度至少 8 位' }, 400)
  }

  // Turnstile 验证（生产环境）
  // 当配置了 TURNSTILE_SECRET_KEY 时，token 为必填，防止客户端绕过验证
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

  // 检查邮箱是否已注册
  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()

  if (existing) {
    return c.json({ statusCode: 409, message: '该邮箱已注册' }, 409)
  }

  // 创建用户
  const userId = generateId('usr')
  const passwordHash = await hashPassword(body.password)

  await db
    .prepare('INSERT INTO users (id, email, nickname, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, email, body.nickname?.trim() || null, passwordHash, 'user', 'active')
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

/**
 * POST /api/auth/login - 用户登录
 */
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
  // 当配置了 TURNSTILE_SECRET_KEY 时，token 为必填，防止客户端绕过验证
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

/**
 * POST /api/auth/logout - 登出
 */
authRoutes.post('/logout', async (c) => {
  await destroySession(c)
  return c.json({ message: '已登出' })
})

// === 内部工具 ===

async function verifyTurnstile(secretKey: string, token: string): Promise<boolean> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token }),
  })
  const result = await response.json() as { success: boolean }
  return result.success
}
