import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { requireAuth } from '../middleware/auth'

export const meRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/me - 当前用户信息和会员状态
 */
meRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const db = c.env.DB

  const user = await db
    .prepare('SELECT id, email, nickname, role, status FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; nickname: string | null; role: string; status: string }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  // 查询有效会员
  const membership = await db
    .prepare(`
      SELECT MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ? AND datetime('now') BETWEEN um.starts_at AND um.expires_at
    `)
    .bind(userId)
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
