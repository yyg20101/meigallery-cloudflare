import { createMiddleware } from 'hono/factory'
import type { Bindings, Variables } from '../index'

/**
 * 为公开 GET 请求添加 Cache-Control 头
 * @param maxAge 缓存秒数
 * @param staleWhileRevalidate 过期后可用的秒数
 */
export function cacheControl(maxAge: number, staleWhileRevalidate = 60) {
  return createMiddleware<{ Bindings: Bindings; Variables: Variables }>(async (c, next) => {
    await next()
    // 仅对成功的 GET 响应添加缓存头
    if (c.req.method === 'GET' && c.res.status >= 200 && c.res.status < 300) {
      c.res.headers.set(
        'Cache-Control',
        `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
      )
    }
  })
}
