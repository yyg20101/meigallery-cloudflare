import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import type { CloudflareEnv } from '@meigallery/shared'
import { authRoutes } from './routes/auth'
import { galleryRoutes } from './routes/galleries'
import { tagRoutes } from './routes/tags'
import { searchRoutes } from './routes/search'
import { mediaRoutes } from './routes/media'
import { meRoutes } from './routes/me'
import { contactMethodRoutes } from './routes/contact-methods'
import { caseRoutes } from './routes/cases'
import { importRoutes } from './routes/imports'
import { PUBLIC_SETTING_KEYS } from './utils/site-settings'
import { adminRoutes } from './routes/admin'
import { healthRoutes } from './routes/health'
import { authMiddleware } from './middleware/auth'
import { rateLimiter } from './middleware/rate-limit'

/** Hono 应用绑定类型 */
export type Bindings = CloudflareEnv & {
  APP_ENV: string
  SESSION_SECRET: string
  TURNSTILE_SECRET_KEY: string
  STREAM_ACCOUNT_ID: string
  STREAM_API_TOKEN: string
  EMAIL_FROM: string
  EMAIL: SendEmail
  IMAGE_RESIZING_ENABLED: string // "true" | "false"
  IMPORT_TOKEN_DAILY_LIMIT?: string
  TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT?: string
}

/** 应用级变量 */
export type Variables = {
  userId: number | null
  userRole: string | null
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 全局中间件
app.use('*', logger())
app.use('*', secureHeaders({
  crossOriginEmbedderPolicy: false, // 图片嵌入需要
  xFrameOptions: 'DENY',
}))
app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return ''
    const allowed = (c.env.CORS_ORIGIN || '')
      .split(',')
      .map((item: string) => item.trim())
      .filter(Boolean)
    if (allowed.length === 0) return c.env.APP_ENV === 'production' ? '' : origin
    return allowed.includes(origin) ? origin : ''
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}))
app.use('*', async (c, next) => {
  await next()
  if (c.env.APP_ENV !== 'production') {
    c.header('X-Robots-Tag', 'noindex, nofollow')
  }
})
// 登录/注册接口速率限制：每 IP 每分钟 10 次
app.use('/api/auth/*', rateLimiter({ limit: 10, windowMs: 60_000 }))
// 图库互动接口速率限制：每 IP 每分钟 60 次
app.use('/api/galleries/*/like', rateLimiter({ limit: 60, windowMs: 60_000 }))
// 外部导入接口速率限制：每 IP 每分钟 120 次
app.use('/api/imports/*', rateLimiter({ limit: 120, windowMs: 60_000 }))
app.use('*', authMiddleware)

// 路由挂载
app.route('/api/health', healthRoutes)
app.route('/api/auth', authRoutes)
app.route('/api/galleries', galleryRoutes)
app.route('/api/tags', tagRoutes)
app.route('/api/search', searchRoutes)
app.route('/api/media', mediaRoutes)
app.route('/api/me', meRoutes)
app.route('/api/contact-methods', contactMethodRoutes)
app.route('/api/cases', caseRoutes)
app.route('/api/imports', importRoutes)
// 公开站点信息（不需要登录）
app.get('/api/settings/public', async (c) => {
  const db = c.env.DB
  const keys = [...PUBLIC_SETTING_KEYS]
  const placeholders = keys.map(() => '?').join(',')
  const result = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()

  const settings: Record<string, string> = {}
  for (const row of result.results) {
    settings[row.key] = JSON.parse(row.value)
  }
  return c.json(settings)
})

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

// ============================================================
// Scheduled Handler（Cron Trigger）
// 每天 UTC 00:00（北京时间 08:00）执行
// ============================================================

async function handleScheduled(env: Bindings): Promise<void> {
  const db = env.DB

  // 1. 清理过期验证码（超过 1 小时的记录）
  const cleaned = await db
    .prepare(`DELETE FROM email_verification_codes WHERE expires_at < datetime('now', '-1 hour')`)
    .run()
  console.log(`[cron] 清理过期验证码: ${cleaned.meta?.changes ?? 0} 条`)

  // 2. 发送会员到期提醒（到期前 3 天，未发送过提醒）
  try {
    const { sendMembershipExpiryReminder } = await import('./services/email')

    const expiring = await db
      .prepare(`
        SELECT um.id as membership_id, u.email, u.notification_enabled, ml.name as level_name, um.expires_at
        FROM user_memberships um
        JOIN users u ON um.user_id = u.id
        JOIN membership_levels ml ON um.level_id = ml.id
        WHERE um.expiry_notified = 0
          AND ml.rank > 0
          AND datetime('now') >= datetime(um.expires_at, '-3 days')
          AND datetime('now') < datetime(um.expires_at)
          AND u.email_verified = 1
          AND u.notification_enabled = 1
      `)
      .all<{
        membership_id: string
        email: string
        notification_enabled: number
        level_name: string
        expires_at: string
      }>()

    for (const row of expiring.results) {
      try {
        await sendMembershipExpiryReminder(env, row.email, row.level_name, row.expires_at)
        await db.prepare('UPDATE user_memberships SET expiry_notified = 1 WHERE id = ?').bind(row.membership_id).run()
        console.log(`[cron] 发送到期提醒: ${row.email} (${row.level_name})`)
      } catch (e) {
        console.error(`[cron] 发送到期提醒失败: ${row.email}`, e)
      }
    }

    console.log(`[cron] 到期提醒: ${expiring.results.length} 个待处理`)
  } catch (e) {
    console.error('[cron] 到期提醒任务失败:', e)
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env))
  },
}
