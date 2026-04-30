import { createMiddleware } from 'hono/factory'
import type { Bindings, Variables } from '../index'
import { validateSession } from '../utils/session'

/**
 * 认证中间件：解析 session，设置 userId 和 userRole
 * 不强制登录，仅提取用户信息供后续中间件使用
 */
export const authMiddleware = createMiddleware<{
  Bindings: Bindings
  Variables: Variables
}>(async (c, next) => {
  const session = await validateSession(c)
  c.set('userId', session?.userId ?? null)
  c.set('userRole', session?.role ?? null)
  await next()
})

/**
 * 要求登录中间件
 */
export const requireAuth = createMiddleware<{
  Bindings: Bindings
  Variables: Variables
}>(async (c, next) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json({ statusCode: 401, message: '请先登录' }, 401)
  }
  await next()
})

/**
 * 要求管理员中间件
 */
export const requireAdmin = createMiddleware<{
  Bindings: Bindings
  Variables: Variables
}>(async (c, next) => {
  const userRole = c.get('userRole')
  if (!userRole || !['admin', 'owner'].includes(userRole)) {
    return c.json({ statusCode: 403, message: '需要管理员权限' }, 403)
  }
  await next()
})

/**
 * 要求站长中间件
 */
export const requireOwner = createMiddleware<{
  Bindings: Bindings
  Variables: Variables
}>(async (c, next) => {
  const userRole = c.get('userRole')
  if (userRole !== 'owner') {
    return c.json({ statusCode: 403, message: '需要站长权限' }, 403)
  }
  await next()
})
