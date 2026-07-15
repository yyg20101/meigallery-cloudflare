import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import app from './index'
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

  it('每 15 分钟 Cron 执行统一 Outbox 恢复，午夜继续执行每日维护', async () => {
    const sql: string[] = []
    let work: Promise<unknown> | undefined
    const ctx = { waitUntil(promise: Promise<unknown>) { work = promise } } as unknown as ExecutionContext
    await app.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse('2026-07-15T09:15:00.000Z') } as ScheduledEvent, {
      APP_ENV: 'production', DB: emptyDb(sql),
    } as unknown as Bindings, ctx)
    await work
    expect(sql.some(value => value.includes('attribution_outbox'))).toBe(true)
    expect(sql.some(value => value.includes('email_verification_codes'))).toBe(false)
  })

  it('Wrangler 只注册三平台新 Queue、三个 DLQ 和每 15 分钟 Cron', () => {
    const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    expect(config).toContain('crons = ["*/15 * * * *"]')
    expect(config).not.toContain('META_CAPI_QUEUE')
    expect(config).not.toContain('TIKTOK_EVENTS_QUEUE')
    for (const queue of ['meigallery-ad-meta', 'meigallery-ad-meta-dlq', 'meigallery-ad-tiktok', 'meigallery-ad-tiktok-dlq', 'meigallery-ad-google', 'meigallery-ad-google-dlq']) expect(config).toContain(queue)
    expect((config.match(/max_retries = 3/g) ?? [])).toHaveLength(3)
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
