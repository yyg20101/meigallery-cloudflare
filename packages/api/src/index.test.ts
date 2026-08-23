import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import app, { isQueueForEnvironment } from './index'
import type { Bindings } from './index'

function env(corsOrigin?: string) {
  return {
    APP_ENV: 'production', CORS_ORIGIN: corsOrigin,
    DB: { prepare() { return { first: async () => ({ ok: 1 }) } } },
  } as unknown as Bindings
}

describe('API CORS 安全配置', () => {
  it('生产环境未配置 CORS_ORIGIN 时不反射任意 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', { headers: { Origin: 'https://evil.example' } }), env(), {} as ExecutionContext)
    expect(res.status).toBe(503)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('支持多个明确允许的生产 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', { headers: { Origin: 'https://www.616618.xyz' } }), env('https://616618.xyz,https://www.616618.xyz'), {} as ExecutionContext)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.616618.xyz')
  })
})

describe('统一 Queue 与 Cron 入口', () => {
  it('未知 Queue 也委托统一运行时并安全确认消息', async () => {
    const ack = () => { acknowledged = true }
    let acknowledged = false
    await app.queue({ queue: 'unknown-queue', messages: [{ body: { schemaVersion: 1, deliveryId: 'delivery_1', provider: 'meta' }, attempts: 1, ack, retry() {} }] } as unknown as MessageBatch<{ schemaVersion: 1; deliveryId: string; provider: 'meta' }>, {
      APP_ENV: 'production', DB: emptyDb(),
    } as unknown as Bindings)
    expect(acknowledged).toBe(true)
  })

  it('Telegram 导入 Queue 由专用消费者识别并安全确认无效消息', async () => {
    let acknowledged = false
    await app.queue({
      queue: 'meigallery-import-telegram',
      messages: [{ body: { kind: 'unknown' }, attempts: 1, ack() { acknowledged = true }, retry() {} }],
    } as unknown as MessageBatch<unknown>, {
      APP_ENV: 'production',
      DB: emptyDb(),
      R2: {},
    } as unknown as Bindings)
    expect(acknowledged).toBe(true)
  })

  it('业务 Queue 严格隔离 production 与 dev 名称', () => {
    expect(isQueueForEnvironment('meigallery-import-telegram', 'meigallery-import-telegram', 'production')).toBe(true)
    expect(isQueueForEnvironment('meigallery-import-telegram-dev', 'meigallery-import-telegram', 'dev')).toBe(true)
    expect(isQueueForEnvironment('meigallery-import-telegram', 'meigallery-import-telegram', 'dev')).toBe(false)
    expect(isQueueForEnvironment('meigallery-import-telegram-dev', 'meigallery-import-telegram', 'production')).toBe(false)
    expect(isQueueForEnvironment('meigallery-import-telegram', 'meigallery-import-telegram', 'unknown')).toBe(false)
    expect(isQueueForEnvironment('meigallery-import-telegram-dev', 'meigallery-import-telegram', 'unknown')).toBe(false)
  })

  it('业务 Queue 配错环境或 APP_ENV 非法时不确认消息', async () => {
    for (const [queue, appEnvironment, errorCode] of [
      ['meigallery-import-telegram-dev', 'production', 'QUEUE_ENVIRONMENT_MISMATCH'],
      ['meigallery-import-telegram', 'dev', 'QUEUE_ENVIRONMENT_MISMATCH'],
      ['meigallery-import-telegram', 'unknown', 'QUEUE_ENVIRONMENT_INVALID'],
    ] as const) {
      let acknowledged = false
      const work = app.queue({
        queue,
        messages: [{ body: { kind: 'unknown' }, attempts: 1, ack() { acknowledged = true }, retry() {} }],
      } as unknown as MessageBatch<unknown>, {
        APP_ENV: appEnvironment,
        DB: emptyDb(),
        R2: {},
      } as unknown as Bindings)
      await expect(work).rejects.toThrow(errorCode)
      expect(acknowledged).toBe(false)
    }
  })

  it('每 15 分钟 Cron 执行统一 Outbox 恢复，午夜继续执行每日维护', async () => {
    const sql: string[] = []
    let work: Promise<unknown> | undefined
    const ctx = { waitUntil(promise: Promise<unknown>) { work = promise } } as unknown as ExecutionContext
    await app.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse('2026-07-15T09:15:00.000Z') } as ScheduledEvent, {
      APP_ENV: 'production', DB: emptyDb(sql),
    } as unknown as Bindings, ctx)
    await work
    expect(sql.some(value => value.includes('attribution_outbox'))).toBe(true)
    expect(sql.some(value => value.includes("delivery.provider = 'google'"))).toBe(true)
    expect(sql.some(value => value.includes('email_verification_codes'))).toBe(false)
  })

  it('Wrangler 注册三平台归因 Queue、四个业务 Queue、隔离的 dev 资源和每 15 分钟 Cron', () => {
    const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    expect(config).toContain('crons = ["*/15 * * * *"]')
    expect(config).not.toContain('META_CAPI_QUEUE')
    expect(config).not.toContain('TIKTOK_EVENTS_QUEUE')
    for (const queue of ['meigallery-ad-meta', 'meigallery-ad-meta-dlq', 'meigallery-ad-tiktok', 'meigallery-ad-tiktok-dlq', 'meigallery-ad-google', 'meigallery-ad-google-dlq']) expect(config).toContain(queue)
    for (const queue of ['meigallery-import-zip', 'meigallery-app-data-rights-export', 'meigallery-app-data-rights-deletion', 'meigallery-import-telegram']) {
      expect(config).toContain(`queue = "${queue}"`)
      expect(config).toContain(`queue = "${queue}-dev"`)
      expect(config).toContain(`dead_letter_queue = "${queue}-dlq"`)
      expect(config).toContain(`dead_letter_queue = "${queue}-dev-dlq"`)
    }
    expect(config).toContain('[exports.AppRealtimeHub]')
    expect((config.match(/name = "APP_REALTIME_HUB"/g) ?? [])).toHaveLength(2)
  })
})

describe('Safety-2 环境开关隔离', () => {
  it('只在 dev 开启内部联调能力，production 与全部 production-ready 门禁保持关闭', () => {
    const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    const [productionConfig, devConfig] = config.split('[env.dev]')

    expect(productionConfig).toBeTruthy()
    expect(devConfig).toBeTruthy()
    for (const key of [
      'APP_AUTH_ENABLED',
      'APP_SAFETY_ENABLED',
      'APP_SAFETY_ADMIN_ENABLED',
      'APP_SAFETY_APPEALS_ENABLED',
      'APP_SAFETY_APPEALS_ADMIN_ENABLED',
    ]) {
      expect(productionConfig).toContain(`${key} = "false"`)
      expect(devConfig).toContain(`${key} = "true"`)
    }
    for (const key of [
      'APP_AUTH_REGISTRATION_ENABLED',
      'APP_MEMBERSHIP_ENABLED',
      'APP_MESSAGING_ENABLED',
      'APP_SAFETY_PRODUCTION_READY',
      'APP_SAFETY_APPEALS_PRODUCTION_READY',
    ]) {
      expect(productionConfig).toContain(`${key} = "false"`)
      expect(devConfig).toContain(`${key} = "false"`)
    }
  })
})

describe('公开设置广告配置隔离', () => {
  it('不查询旧广告连接表或暴露全平台浏览器目标', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const publicSettingsRoute = source.slice(
      source.indexOf("app.get('/api/settings/public'"),
      source.indexOf("app.route('/api/meta'"),
    )

    expect(publicSettingsRoute).not.toContain('ad_platform_connections')
    expect(publicSettingsRoute).not.toContain('ad_platform_browser_connections')
    expect(publicSettingsRoute).not.toContain('browserConnections')
  })

  it('归因解析使用独立限流桶', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const attributionRateLimit = source.slice(
      source.indexOf('// 广告来源解析独立计数'),
      source.indexOf('// 公开 API 速率限制兜底'),
    )
    const publicRateLimit = source.slice(
      source.indexOf('// 公开 API 速率限制兜底'),
      source.indexOf('// 外部导入接口速率限制兜底'),
    )

    expect(attributionRateLimit).toContain("'/api/ad-attribution'")
    expect(attributionRateLimit).toContain("'/api/ad-attribution/*'")
    expect(attributionRateLimit).toContain("name: 'ad-attribution'")
    expect(publicRateLimit).not.toContain("'/api/ad-attribution'")
  })
})

function emptyDb(calls: string[] = []) {
  return {
    prepare(sql: string) {
      calls.push(sql)
      return {
        bind() { return this },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }
    },
    batch: async () => [],
  }
}
