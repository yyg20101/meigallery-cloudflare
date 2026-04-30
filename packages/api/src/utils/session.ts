import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import { generateId } from './db'

const SESSION_COOKIE = 'mei_session'
const SESSION_TTL_DAYS = 7

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

/**
 * 创建会话
 * 生成 token，哈希后存入 D1，设置 cookie
 */
export async function createSession(c: AppContext, userId: string): Promise<void> {
  const db = c.env.DB
  const token = generateSessionToken()
  const tokenHash = await hashToken(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const id = generateId('ses')

  await db
    .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, tokenHash, expiresAt)
    .run()

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

/**
 * 验证会话，返回 user_id 或 null
 * 同时实现滑动续期
 */
export async function validateSession(c: AppContext): Promise<{ userId: string; role: string } | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null

  const db = c.env.DB
  const tokenHash = await hashToken(token)

  const session = await db
    .prepare(`
      SELECT s.id as session_id, s.user_id, s.expires_at, u.role, u.status
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ?
    `)
    .bind(tokenHash)
    .first<{ session_id: string; user_id: string; expires_at: string; role: string; status: string }>()

  if (!session) return null

  // 检查过期
  if (new Date(session.expires_at) < new Date()) {
    // 清理过期 session
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(session.session_id).run()
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return null
  }

  // 检查用户状态
  if (session.status !== 'active') return null

  // 滑动续期：如果距过期不足一半时间，延长有效期
  const expiresAt = new Date(session.expires_at)
  const halfLife = (SESSION_TTL_DAYS * 24 * 60 * 60 * 1000) / 2
  if (expiresAt.getTime() - Date.now() < halfLife) {
    const newExpiry = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(newExpiry, session.session_id).run()
  }

  return { userId: session.user_id, role: session.role }
}

/**
 * 销毁会话
 */
export async function destroySession(c: AppContext): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return

  const db = c.env.DB
  const tokenHash = await hashToken(token)

  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/**
 * 清理用户所有会话（用于密码修改等场景）
 */
export async function destroyAllUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
}

/**
 * 清理用户其他会话，保留当前 session（用于用户自行修改密码）
 */
export async function destroyOtherSessions(db: D1Database, userId: string, currentToken: string): Promise<void> {
  const currentHash = await hashToken(currentToken)
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .bind(userId, currentHash)
    .run()
}

// === 内部工具函数 ===

function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
