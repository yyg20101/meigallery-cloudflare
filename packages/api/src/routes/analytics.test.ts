import { describe, expect, it, beforeEach } from 'vitest'
import app from '../index'
import type { Bindings } from '../index'
import { resetRateLimitStoreForTest } from '../middleware/rate-limit'

function createDb(enabled = true) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    calls,
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          if (sql.includes('FROM site_settings')) {
            return {
              results: [
                { key: 'analytics_enabled', value: JSON.stringify(enabled) },
                { key: 'analytics_sample_rate', value: JSON.stringify(0) },
              ] as T[],
            }
          }
          return { results: [] as T[] }
        },
        async first<T>() {
          return null as T | null
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1, rows_written: 1, duration: 1 } }
        },
      }
    },
  }
}

function envFor(db: ReturnType<typeof createDb>) {
  return {
    APP_ENV: 'production',
    DB: db,
    SESSION_SECRET: 'test-secret',
  } as unknown as Bindings
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    visitorId: 'visitor_abcdef',
    sessionId: 'session_abcdef',
    events: [
      {
        eventId: 'event_abcdef',
        eventName: 'page_view',
        occurredAt: '2026-06-07T10:00:00.000Z',
        routeName: 'home',
        path: '/',
        ...overrides,
      },
    ],
  }
}

describe('analytics routes', () => {
  beforeEach(() => {
    resetRateLimitStoreForTest()
  })

  it('挂载 POST /api/analytics/events 并返回批量结果', async () => {
    const db = createDb()
    const res = await app.fetch(new Request('https://api.test/api/analytics/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Analytics-Visitor-Id': 'visitor_abcdef',
        'X-Analytics-Session-Id': 'session_abcdef',
      },
      body: JSON.stringify(requestBody()),
    }), envFor(db), {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ accepted: 1, rejected: 0, duplicate: 0 })
    expect(db.calls.some(call => call.sql.includes('analytics_sessions'))).toBe(true)
  })

  it('关闭开关时返回 disabled 且不写入业务表', async () => {
    const db = createDb(false)
    const res = await app.fetch(new Request('https://api.test/api/analytics/events', {
      method: 'POST',
      body: JSON.stringify(requestBody()),
    }), envFor(db), {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ accepted: 0, rejected: 0, duplicate: 0, disabled: true })
    expect(db.calls).toHaveLength(0)
  })

  it('无效 JSON 使用统一错误体', async () => {
    const db = createDb()
    const res = await app.fetch(new Request('https://api.test/api/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken"',
    }), envFor(db), {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toMatchObject({
      statusCode: 400,
      message: '分析上报内容必须是有效 JSON',
      code: 'ANALYTICS_JSON_INVALID',
    })
  })

  it('批量超过 20 个事件时返回统一错误体', async () => {
    const db = createDb()
    const body = {
      visitorId: 'visitor_abcdef',
      sessionId: 'session_abcdef',
      events: Array.from({ length: 21 }, (_, index) => ({
        eventId: `event_many_${index}`,
        eventName: 'page_view',
        occurredAt: '2026-06-07T10:00:00.000Z',
        routeName: 'home',
        path: '/',
      })),
    }
    const res = await app.fetch(new Request('https://api.test/api/analytics/events', {
      method: 'POST',
      body: JSON.stringify(body),
    }), envFor(db), {} as ExecutionContext)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json).toMatchObject({
      statusCode: 400,
      code: 'ANALYTICS_EVENTS_TOO_MANY',
    })
  })

  it('部分事件失败时返回 202', async () => {
    const db = createDb()
    const body = requestBody()
    body.events.push({
      ...body.events[0],
      eventId: 'event_bad_1',
      eventName: 'bad_event',
    })
    const res = await app.fetch(new Request('https://api.test/api/analytics/events', {
      method: 'POST',
      body: JSON.stringify(body),
    }), envFor(db), {} as ExecutionContext)
    const json = await res.json()

    expect(res.status).toBe(202)
    expect(json).toMatchObject({ accepted: 1, rejected: 1 })
  })

  it('session/end 兼容 sendBeacon 简写 payload', async () => {
    const db = createDb()
    const res = await app.fetch(new Request('https://api.test/api/analytics/session/end', {
      method: 'POST',
      body: JSON.stringify({
        visitorId: 'visitor_abcdef',
        sessionId: 'session_abcdef',
        occurredAt: '2026-06-07T10:00:00.000Z',
        path: '/gallery/demo',
        activeSeconds: 18,
        pageViewCount: 2,
      }),
    }), envFor(db), {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ accepted: 1, rejected: 0 })
    expect(db.calls.some(call => call.sql.includes('analytics_session_summaries'))).toBe(true)
  })

  it('采集接口按 session 维度限流', async () => {
    const db = createDb(false)
    let lastStatus = 0
    for (let index = 0; index < 61; index += 1) {
      const res = await app.fetch(new Request('https://api.test/api/analytics/events', {
        method: 'POST',
        headers: {
          'X-Analytics-Visitor-Id': 'visitor_limit',
          'X-Analytics-Session-Id': 'session_limit',
        },
        body: JSON.stringify(requestBody({ eventId: `event_limit_${index}` })),
      }), envFor(db), {} as ExecutionContext)
      lastStatus = res.status
    }

    expect(lastStatus).toBe(429)
  })
})
