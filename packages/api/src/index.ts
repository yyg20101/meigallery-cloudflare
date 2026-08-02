import { Hono } from 'hono'
import type { AdPlatformQueueMessage } from '@meigallery/shared'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { RATE_LIMITS } from '@meigallery/shared/constants'
import { authRoutes } from './routes/auth'
import { galleryRoutes } from './routes/galleries'
import { tagRoutes } from './routes/tags'
import { searchRoutes } from './routes/search'
import { mediaRoutes } from './routes/media'
import { meRoutes } from './routes/me'
import { contactMethodRoutes } from './routes/contact-methods'
import { caseRoutes } from './routes/cases'
import { importRoutes } from './routes/imports'
import { analyticsRoutes } from './routes/analytics'
import { conversionRoutes } from './routes/conversions'
import { adAttributionRoutes } from './routes/ad-attribution'
import { inviteRoutes } from './routes/invites'
import { appV2Routes } from './routes/app-v2'
import { PUBLIC_SETTING_KEYS } from './utils/site-settings'
import { sanitizePublicSiteSetting, sanitizePublicSiteSettings } from './utils/public-site-settings'
import { HOME_AD_PLACEMENT, type HomeAdRow, serializePublicHomeAd } from './utils/home-ads'
import { adminRoutes } from './routes/admin'
import { healthRoutes } from './routes/health'
import { authMiddleware } from './middleware/auth'
import { rateLimiter } from './middleware/rate-limit'
import { errorJson } from './utils/api-error'
import { appApiError } from './utils/app-api-v2'
import { parseStoredSettingValue } from './utils/stored-setting-value'
import {
  aggregateAnalyticsDaily,
  aggregateClickDaily,
  aggregatePathEdges,
  cleanupAnalyticsRetention,
} from './services/analytics-aggregate'
import { recoverAttributionOutbox } from './services/ad-platform/recovery'
import { recoverRegistrationConversionFacts } from './services/registration-conversion-recovery'
import { reconcileGoogleDeliveryDiagnostics } from './services/ad-platform/google-diagnostics-service'

/** Hono 应用绑定类型 */
export type Bindings = {
  DB: D1Database
  R2: R2Bucket
  APP_ENV: string
  SESSION_SECRET: string
  TURNSTILE_SECRET_KEY: string
  STREAM_ACCOUNT_ID: string
  STREAM_API_TOKEN: string
  EMAIL_FROM: string
  EMAIL: SendEmail
  SITE_URL?: string
  CORS_ORIGIN?: string
  IMAGE_RESIZING_ENABLED: string // "true" | "false"
  IMPORT_TOKEN_DAILY_LIMIT?: string
  TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT?: string
  TELEGRAM_BOT_TOKEN_OPS_CASE_BOT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
  AD_META_QUEUE?: Queue<AdPlatformQueueMessage>
  AD_TIKTOK_QUEUE?: Queue<AdPlatformQueueMessage>
  AD_GOOGLE_QUEUE?: Queue<AdPlatformQueueMessage>
  RELEASE_COMMIT?: string
  APP_AUTH_ENABLED?: string
  APP_AUTH_REGISTRATION_ENABLED?: string
  APP_AUTH_TERMS_VERSION?: string
  APP_AUTH_PRIVACY_VERSION?: string
  APP_AUTH_PLATFORM_NOTICE_VERSION?: string
  APP_AUTH_ELIGIBILITY_VERSION?: string
  APP_AUTH_TURNSTILE_SITE_KEY?: string
}

/** 应用级变量 */
export type Variables = {
  userId: number | null
  userRole: string | null
  appRequestId?: string
  appAccountId?: number
  appAccountPublicId?: string
  appSessionId?: string
  appDeviceId?: string
  appAccountEmail?: string
  appAccountNickname?: string | null
  appAccountRole?: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const requestLogger = logger()
const PUBLIC_SETTINGS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

// 全局中间件
app.use('*', async (c, next) => {
  if (c.env.APP_ENV === 'production') {
    await next()
    return
  }
  return requestLogger(c, next)
})
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
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'X-Analytics-Visitor-Id',
    'X-Analytics-Session-Id',
    'X-Client-Platform',
    'X-Client-Version',
    'X-Client-Build',
    'X-Device-Id',
    'X-Contract-Version',
    'X-Request-Id',
    'Idempotency-Key',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}))
app.use('*', async (c, next) => {
  await next()
  if (c.env.APP_ENV !== 'production') {
    c.header('X-Robots-Tag', 'noindex, nofollow')
  }
})
const rateLimitWindowMs = (seconds: number) => seconds * 1000

const authRateLimit = RATE_LIMITS.AUTH
const publicApiRateLimit = RATE_LIMITS.PUBLIC_API
const adminApiRateLimit = RATE_LIMITS.ADMIN_API
const mediaAccessRateLimit = RATE_LIMITS.MEDIA_ACCESS
const externalImportRateLimit = RATE_LIMITS.EXTERNAL_IMPORT
const analyticsIpRateLimit = RATE_LIMITS.ANALYTICS_IP
const analyticsVisitorRateLimit = RATE_LIMITS.ANALYTICS_VISITOR
const analyticsSessionRateLimit = RATE_LIMITS.ANALYTICS_SESSION

app.use('/api/v2/*', async (c, next) => {
  c.set('appRequestId', crypto.randomUUID())
  c.header('Cache-Control', 'no-store')
  await next()
})

// 登录/注册接口速率限制兜底：每 IP 每分钟 5 次
app.use('/api/auth/*', rateLimiter({
  name: 'auth',
  keyBy: 'ip',
  limit: authRateLimit.requests,
  windowMs: rateLimitWindowMs(authRateLimit.window),
}))

app.use('/api/v2/auth/*', rateLimiter({
  name: 'app-auth',
  keyBy: 'ip',
  limit: authRateLimit.requests,
  windowMs: rateLimitWindowMs(authRateLimit.window),
}))

// 广告来源解析独立计数，避免图库、搜索等公开 API 消耗 Pixel 初始化预算。
for (const path of ['/api/ad-attribution', '/api/ad-attribution/*']) {
  app.use(path, rateLimiter({
    name: 'ad-attribution',
    keyBy: 'ip',
    limit: publicApiRateLimit.requests,
    windowMs: rateLimitWindowMs(publicApiRateLimit.window),
  }))
}

// 公开 API 速率限制兜底：每 IP 每分钟 60 次
for (const path of [
  '/api/galleries',
  '/api/galleries/*',
  '/api/tags',
  '/api/tags/*',
  '/api/search',
  '/api/search/*',
  '/api/cases',
  '/api/cases/*',
  '/api/contact-methods',
  '/api/contact-methods/*',
  '/api/invites/*',
  '/api/settings/public',
  '/api/v2/*',
]) {
  app.use(path, rateLimiter({
    name: 'public-api',
    keyBy: 'ip',
    limit: publicApiRateLimit.requests,
    windowMs: rateLimitWindowMs(publicApiRateLimit.window),
  }))
}

// 外部导入接口速率限制兜底：每 IP 每分钟 120 次
app.use('/api/imports/*', rateLimiter({
  name: 'external-import',
  keyBy: 'ip',
  limit: externalImportRateLimit.requests,
  windowMs: rateLimitWindowMs(externalImportRateLimit.window),
}))

// 数据分析采集兜底限流：IP、匿名 visitor 和 session 三层保护
app.use('/api/analytics/*', rateLimiter({
  name: 'analytics-ip',
  keyBy: 'ip',
  limit: analyticsIpRateLimit.requests,
  windowMs: rateLimitWindowMs(analyticsIpRateLimit.window),
}))
app.use('/api/analytics/*', rateLimiter({
  name: 'analytics-visitor',
  keyBy: 'analyticsVisitor',
  limit: analyticsVisitorRateLimit.requests,
  windowMs: rateLimitWindowMs(analyticsVisitorRateLimit.window),
}))
app.use('/api/analytics/*', rateLimiter({
  name: 'analytics-session',
  keyBy: 'analyticsSession',
  limit: analyticsSessionRateLimit.requests,
  windowMs: rateLimitWindowMs(analyticsSessionRateLimit.window),
}))

// 公开转化事件入口限流：沿用分析采集 IP 预算
app.use('/api/conversions/*', rateLimiter({
  name: 'conversions-ip',
  keyBy: 'ip',
  limit: analyticsIpRateLimit.requests,
  windowMs: rateLimitWindowMs(analyticsIpRateLimit.window),
}))
app.use('*', authMiddleware)

// 管理员 API 速率限制兜底：每 session 每分钟 120 次
app.use('/api/admin/*', rateLimiter({
  name: 'admin-api',
  keyBy: 'session',
  limit: adminApiRateLimit.requests,
  windowMs: rateLimitWindowMs(adminApiRateLimit.window),
}))

// 受保护媒体访问接口兜底：每 user 每分钟 30 次
app.use('/api/media/*/access', rateLimiter({
  name: 'media-access',
  keyBy: 'user',
  limit: mediaAccessRateLimit.requests,
  windowMs: rateLimitWindowMs(mediaAccessRateLimit.window),
}))

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
app.route('/api/analytics', analyticsRoutes)
app.route('/api/conversions', conversionRoutes)
app.route('/api/ad-attribution', adAttributionRoutes)
app.route('/api/invites', inviteRoutes)
app.route('/api/v2', appV2Routes)
// 公开站点信息（不需要登录）
app.get('/api/settings/public', async (c) => {
  const db = c.env.DB
  const keys = [...PUBLIC_SETTING_KEYS]
  const placeholders = keys.map(() => '?').join(',')
  const [settingsResult, adsResult] = await Promise.all([
    db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
      .all<{ key: string; value: string }>(),
    db
      .prepare(`
        SELECT id, placement, eyebrow, title, summary, cta_label, target_url, sponsor,
               image_url, image_key, enabled, starts_at, ends_at, sort_order, created_at, updated_at
        FROM home_ads
        WHERE placement = ?
        ORDER BY sort_order ASC, created_at ASC
      `)
      .bind(HOME_AD_PLACEMENT)
      .all<HomeAdRow>(),
  ])

  const settings: Record<string, unknown> = {}
  for (const row of settingsResult.results) {
    settings[row.key] = sanitizePublicSiteSetting(row.key, parseStoredSettingValue(row.value))
  }
  settings.home_ads = adsResult.results
    .map(row => serializePublicHomeAd(row))
    .filter((ad): ad is NonNullable<typeof ad> => Boolean(ad))
  c.header('Cache-Control', c.env.APP_ENV === 'production' ? PUBLIC_SETTINGS_CACHE_CONTROL : 'no-store')
  return c.json(sanitizePublicSiteSettings(settings))
})

app.route('/api/admin', adminRoutes)

// 404 fallback
app.notFound((c) => {
  if (c.req.path.startsWith('/api/v2/')) {
    return appApiError(c, 404, 'ROUTE_NOT_FOUND', '接口不存在')
  }
  return errorJson(c, 404, '接口不存在', { code: 'NOT_FOUND' })
})

// 全局错误处理
app.onError((err, c) => {
  console.error('未处理异常:', err)
  if (c.req.path.startsWith('/api/v2/')) {
    return appApiError(c, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', true)
  }
  return errorJson(c, 500, '服务器内部错误', { code: 'INTERNAL_ERROR' })
})

// ============================================================
// Scheduled Handler（Cron Trigger）
// minute trigger 执行高频公共任务，并在 UTC 00:00 继续执行完整维护任务。
// ============================================================

const ATTRIBUTION_RECOVERY_CRON = '*/15 * * * *'

async function handleScheduled(event: ScheduledEvent, env: Bindings): Promise<void> {
  const db = env.DB

  if (event.cron === ATTRIBUTION_RECOVERY_CRON) {
    if (shouldRecoverAttributionOutbox(event)) {
      try {
        const recovery = await recoverAttributionOutbox(env, 100)
        console.log('[cron] 统一广告平台 Outbox 恢复完成:', recovery)
      } catch {
        console.error('[cron] 统一广告平台 Outbox 恢复失败:', { errorCode: 'attribution_outbox_recovery_failed' })
      }
      try {
        const diagnostics = await reconcileGoogleDeliveryDiagnostics(env, new Date(event.scheduledTime), 40)
        console.log('[cron] Google 异步诊断对账完成:', diagnostics)
      } catch {
        console.error('[cron] Google 异步诊断对账失败:', { errorCode: 'google_diagnostic_reconciliation_failed' })
      }
    }

    if (shouldRecoverRegistrationConversions(event)) {
      try {
        const recovery = await recoverRegistrationConversionFacts(db, new Date(event.scheduledTime))
        console.log('[cron] 注册转化事实修复完成:', recovery)
      } catch {
        console.error('[cron.registration-recovery] 注册事实修复任务失败', {
          code: 'REGISTRATION_CONVERSION_RECOVERY_JOB_FAILED',
        })
      }
    }
    if (!shouldRunDailyMaintenance(event)) return
  }
  else {
    console.log('[cron] 未知 trigger，跳过定时任务:', event.cron || 'unknown')
    return
  }

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

  // 3. 数据分析日报聚合与保留期清理。独立 try/catch，避免影响认证和会员提醒任务。
  try {
    const today = operationDate()
    const yesterday = addDays(today, -1)
    for (const date of [yesterday, today]) {
      await aggregateAnalyticsDaily(db, date)
      await aggregatePathEdges(db, date)
      await aggregateClickDaily(db, date)
      console.log(`[cron] 数据分析聚合完成: ${date}`)
    }
    const cleanup = await cleanupAnalyticsRetention(db)
    console.log('[cron] 数据分析保留期清理完成:', cleanup.changes)
  } catch (e) {
    console.error('[cron] 数据分析聚合任务失败:', e)
  }

}

function shouldRunDailyMaintenance(event: ScheduledEvent) {
  const scheduledAt = new Date(event.scheduledTime)
  return !Number.isNaN(scheduledAt.getTime())
    && scheduledAt.getUTCHours() === 0
    && scheduledAt.getUTCMinutes() === 0
}

function shouldRecoverRegistrationConversions(event: ScheduledEvent) {
  if (event.cron !== ATTRIBUTION_RECOVERY_CRON) return false
  const scheduledAt = new Date(event.scheduledTime)
  return !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getUTCMinutes() === 0
}

function shouldRecoverAttributionOutbox(event: ScheduledEvent) {
  const scheduledAt = new Date(event.scheduledTime)
  return !Number.isNaN(scheduledAt.getTime()) && [0, 15, 30, 45].includes(scheduledAt.getUTCMinutes())
}

function operationDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function addDays(date: string, delta: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + delta)
  return parsed.toISOString().slice(0, 10)
}

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(event, env))
  },
  queue: async (batch: MessageBatch<AdPlatformQueueMessage>, env: Bindings) => {
    const { handleAttributionQueueBatch } = await import('./services/ad-platform/queue-runtime')
    await handleAttributionQueueBatch(batch, env)
  },
}
