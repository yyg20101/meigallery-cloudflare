import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { CloudflareEnv } from '@meigallery/shared'
import { authRoutes } from './routes/auth'
import { galleryRoutes } from './routes/galleries'
import { tagRoutes } from './routes/tags'
import { searchRoutes } from './routes/search'
import { mediaRoutes } from './routes/media'
import { meRoutes } from './routes/me'
import { adminRoutes } from './routes/admin'
import { healthRoutes } from './routes/health'

/** Hono 应用绑定类型 */
export type Bindings = CloudflareEnv & {
  APP_ENV: string
  SESSION_SECRET: string
  TURNSTILE_SECRET_KEY: string
  STREAM_ACCOUNT_ID: string
  STREAM_API_TOKEN: string
}

/** 应用级变量 */
export type Variables = {
  userId: string | null
  userRole: string | null
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 全局中间件
app.use('*', logger())
app.use('*', cors({
  origin: (origin) => origin, // 开发阶段允许所有来源，生产环境需限制
  credentials: true,
}))

// 路由挂载
app.route('/api/health', healthRoutes)
app.route('/api/auth', authRoutes)
app.route('/api/galleries', galleryRoutes)
app.route('/api/tags', tagRoutes)
app.route('/api/search', searchRoutes)
app.route('/api/media', mediaRoutes)
app.route('/api/me', meRoutes)
app.route('/api/admin', adminRoutes)

// 404 fallback
app.notFound((c) => {
  return c.json({ statusCode: 404, message: '接口不存在' }, 404)
})

// 全局错误处理
app.onError((err, c) => {
  console.error('未处理异常:', err)
  return c.json(
    { statusCode: 500, message: '服务器内部错误' },
    500,
  )
})

export default app
