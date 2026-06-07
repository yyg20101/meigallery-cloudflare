/**
 * 简易内存速率限制中间件
 * 基于 IP、用户或 session 的滑动窗口计数器。
 * 注意：Workers 每个 isolate 独立，分布式场景下不严格精确；生产强限流必须使用 Cloudflare WAF / Rate Limiting Rules。
 */
import type { Context, MiddlewareHandler } from 'hono'
import { errorJson } from '../utils/api-error'

type RateLimitKeyBy = 'ip' | 'user' | 'session' | 'analyticsVisitor' | 'analyticsSession'

interface RateLimitOptions {
  /** 时间窗口内允许的最大请求数 */
  limit: number
  /** 时间窗口（毫秒） */
  windowMs: number
  /** 限流桶名称，避免不同接口共用同一计数器 */
  name: string
  /** 计数维度 */
  keyBy?: RateLimitKeyBy
}

// 每个 isolate 内的请求记录
const ipRequests = new Map<string, number[]>()

// 定期清理过期记录（防止内存泄漏）
let lastCleanup = Date.now()
const CLEANUP_INTERVAL = 60_000

function cleanup(windowMs: number) {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL) return
  lastCleanup = now

  const cutoff = now - windowMs
  for (const [ip, timestamps] of ipRequests.entries()) {
    const valid = timestamps.filter(t => t > cutoff)
    if (valid.length === 0) {
      ipRequests.delete(ip)
    } else {
      ipRequests.set(ip, valid)
    }
  }
}

/**
 * 创建速率限制中间件
 */
export function rateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, name, keyBy = 'ip' } = options

  return async (c: Context, next) => {
    const key = `${name}:${await resolveRateLimitKey(c, keyBy)}`
    const now = Date.now()
    const cutoff = now - windowMs

    // 获取该限流桶的请求时间戳
    const timestamps = ipRequests.get(key) || []
    const validTimestamps = timestamps.filter(t => t > cutoff)

    if (validTimestamps.length >= limit) {
      c.header('Retry-After', String(Math.ceil(windowMs / 1000)))
      c.header('X-RateLimit-Limit', String(limit))
      c.header('X-RateLimit-Remaining', '0')
      return errorJson(c, 429, '请求过于频繁，请稍后再试', { code: 'RATE_LIMITED' })
    }

    // 记录本次请求
    validTimestamps.push(now)
    ipRequests.set(key, validTimestamps)

    // 设置速率限制响应头
    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(limit - validTimestamps.length))

    // 定期清理
    cleanup(windowMs)

    await next()
  }
}

async function resolveRateLimitKey(c: Context, keyBy: RateLimitKeyBy): Promise<string> {
  if (keyBy === 'user') {
    const userId = getContextValue(c, 'userId')
    return userId ? `user:${userId}` : `ip:${getClientIp(c)}`
  }

  if (keyBy === 'session') {
    const token = getSessionToken(c)
    if (token) return `session:${await hashRateLimitValue(token)}`
    const userId = getContextValue(c, 'userId')
    return userId ? `user:${userId}` : `ip:${getClientIp(c)}`
  }

  if (keyBy === 'analyticsVisitor') {
    return analyticsHeaderKey(c, 'x-analytics-visitor-id', 'visitor') || `ip:${getClientIp(c)}`
  }

  if (keyBy === 'analyticsSession') {
    return analyticsHeaderKey(c, 'x-analytics-session-id', 'analytics-session') || `ip:${getClientIp(c)}`
  }

  return `ip:${getClientIp(c)}`
}

function getContextValue(c: Context, key: string): string | number | null {
  const value = (c as unknown as { get: (name: string) => unknown }).get(key)
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function getClientIp(c: Context): string {
  const cfIp = c.req.header('cf-connecting-ip')
  if (cfIp) return cfIp
  const forwarded = c.req.header('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() || 'unknown'
}

function getSessionToken(c: Context): string | null {
  const cookie = c.req.header('cookie')
  if (!cookie) return null

  for (const part of cookie.split(';')) {
    const [rawName, ...rawValue] = part.split('=')
    if (rawName?.trim() !== 'mei_session') continue
    const value = rawValue.join('=').trim()
    if (value) return value
  }

  return null
}

async function hashRateLimitValue(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

function analyticsHeaderKey(c: Context, headerName: string, prefix: string): string | null {
  const value = c.req.header(headerName)
  if (!value || !/^[A-Za-z0-9_-]{8,120}$/.test(value)) return null
  return `${prefix}:${value.slice(0, 120)}`
}

export function resetRateLimitStoreForTest(): void {
  ipRequests.clear()
  lastCleanup = Date.now()
}
