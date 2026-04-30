import type { H3Event } from 'h3'

/** Session 中存储的用户数据 */
export interface SessionUser {
  id: string
  email: string
  role: string
  status: string
}

/**
 * 从请求中获取当前会话用户
 * 校验 cookie 中的 session token，返回用户信息
 * 未登录返回 null
 */
export async function getSessionUser(event: H3Event): Promise<SessionUser | null> {
  // TODO: 实现 session 解析
  // 1. 读取 cookie 中的 session token
  // 2. 验证签名（使用 SESSION_SECRET）
  // 3. 查询 D1 获取用户信息
  // 4. 检查会话有效期
  // 5. 滑动续期
  void event
  return null
}

/**
 * 要求用户已登录，否则抛出 401
 */
export async function requireAuth(event: H3Event): Promise<SessionUser> {
  const user = await getSessionUser(event)
  if (!user) {
    throw createError({
      statusCode: 401,
      message: '请先登录',
    })
  }
  return user
}

/**
 * 要求用户为管理员角色（admin 或 owner），否则抛出 403
 */
export async function requireAdmin(event: H3Event): Promise<SessionUser> {
  const user = await requireAuth(event)
  if (!['admin', 'owner'].includes(user.role)) {
    throw createError({
      statusCode: 403,
      message: '需要管理员权限',
    })
  }
  return user
}

/**
 * 要求用户为站长角色（owner），否则抛出 403
 */
export async function requireOwner(event: H3Event): Promise<SessionUser> {
  const user = await requireAuth(event)
  if (user.role !== 'owner') {
    throw createError({
      statusCode: 403,
      message: '需要站长权限',
    })
  }
  return user
}

/**
 * 校验 Turnstile token
 */
export async function verifyTurnstile(event: H3Event, token: string): Promise<boolean> {
  const config = useRuntimeConfig(event)
  const secretKey = config.turnstileSecretKey

  if (!secretKey) {
    // 开发环境未配置时跳过验证
    if (config.public.appEnv === 'development') {
      return true
    }
    throw createError({
      statusCode: 500,
      message: 'Turnstile 未配置',
    })
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: secretKey,
      response: token,
    }),
  })

  const result = await response.json() as { success: boolean }
  return result.success
}
