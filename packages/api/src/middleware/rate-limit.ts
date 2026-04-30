/**
 * 简易内存速率限制中间件
 * 基于 IP 的滑动窗口计数器
 * 注意：Workers 每个 isolate 独立，分布式场景下不严格精确，但足以防御单 IP 暴力攻击
 */
import type { Context, MiddlewareHandler } from 'hono'

interface RateLimitOptions {
  /** 时间窗口内允许的最大请求数 */
  limit: number
  /** 时间窗口（毫秒） */
  windowMs: number
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
  const { limit, windowMs } = options

  return async (c: Context, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
    const now = Date.now()
    const cutoff = now - windowMs

    // 获取该 IP 的请求时间戳
    const timestamps = ipRequests.get(ip) || []
    const validTimestamps = timestamps.filter(t => t > cutoff)

    if (validTimestamps.length >= limit) {
      c.header('Retry-After', String(Math.ceil(windowMs / 1000)))
      c.header('X-RateLimit-Limit', String(limit))
      c.header('X-RateLimit-Remaining', '0')
      return c.json(
        { statusCode: 429, message: '请求过于频繁，请稍后再试' },
        429,
      )
    }

    // 记录本次请求
    validTimestamps.push(now)
    ipRequests.set(ip, validTimestamps)

    // 设置速率限制响应头
    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(limit - validTimestamps.length))

    // 定期清理
    cleanup(windowMs)

    await next()
  }
}
