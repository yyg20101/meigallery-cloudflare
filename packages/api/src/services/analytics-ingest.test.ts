import { describe, expect, it } from 'vitest'
import type { Bindings } from '../index'
import { ingestAnalyticsBatch, normalizeSessionEndPayload, shouldSampleAnalyticsEvent } from './analytics-ingest'

type Call = { sql: string; params: unknown[] }

function createDb(options: {
  enabled?: boolean
  sampleRate?: number
  existingEvents?: string[]
} = {}) {
  const calls: Call[] = []
  const insertedEvents = new Set(options.existingEvents ?? [])
  const db = {
    calls,
    insertedEvents,
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          if (sql.includes('FROM site_settings')) {
            return {
              results: [
                { key: 'analytics_enabled', value: JSON.stringify(options.enabled ?? true) },
                { key: 'analytics_sample_rate', value: JSON.stringify(options.sampleRate ?? 0) },
                { key: 'analytics_consent_mode', value: JSON.stringify('limited') },
              ] as T[],
            }
          }
          return { results: [] as T[] }
        },
        async first<T>() {
          if (sql.includes('FROM analytics_events WHERE id = ?')) {
            return insertedEvents.has(String(call.params[0])) ? ({ id: call.params[0] } as T) : null
          }
          return null
        },
        async run() {
          calls.push(call)
          if (sql.includes('INSERT OR IGNORE INTO analytics_events')) {
            const eventId = String(call.params[0])
            if (insertedEvents.has(eventId)) return { meta: { changes: 0, rows_written: 0 } }
            insertedEvents.add(eventId)
          }
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

function envFor(db: ReturnType<typeof createDb>) {
  return {
    APP_ENV: 'test',
    DB: db,
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB'>
}

function baseBatch(overrides: Record<string, unknown> = {}) {
  return {
    visitorId: 'visitor_123456',
    sessionId: 'session_123456',
    events: [
      {
        eventId: 'event_123456',
        eventName: 'page_view',
        occurredAt: '2026-06-07T10:00:00.000Z',
        routeName: 'home',
        path: '/',
        pageTitle: '首页',
        props: { is_landing: true },
        ...overrides,
      },
    ],
  }
}

describe('analytics-ingest', () => {
  it('采集关闭时返回 disabled 且不写入 D1', async () => {
    const db = createDb({ enabled: false })
    const result = await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch(),
      bodySizeBytes: 256,
      userId: null,
      currentHost: '616618.xyz',
    })

    expect(result).toMatchObject({ accepted: 0, rejected: 0, duplicate: 0, disabled: true })
    expect(db.calls).toHaveLength(0)
  })

  it('拒绝非法 body、超过 20 个事件和超过 16KB payload', async () => {
    const db = createDb()
    await expect(ingestAnalyticsBatch(envFor(db), {
      body: null,
      bodySizeBytes: 2,
      userId: null,
    })).rejects.toMatchObject({ code: 'ANALYTICS_BODY_INVALID' })

    await expect(ingestAnalyticsBatch(envFor(db), {
      body: { visitorId: 'visitor_123456', sessionId: 'session_123456', events: Array.from({ length: 21 }, () => baseBatch().events[0]) },
      bodySizeBytes: 1024,
      userId: null,
    })).rejects.toMatchObject({ code: 'ANALYTICS_EVENTS_TOO_MANY' })

    await expect(ingestAnalyticsBatch(envFor(db), {
      body: baseBatch(),
      bodySizeBytes: 16 * 1024 + 1,
      userId: null,
    })).rejects.toMatchObject({ code: 'ANALYTICS_PAYLOAD_TOO_LARGE' })
  })

  it('敏感 URL 只拒绝单个事件并记录健康日报', async () => {
    const db = createDb()
    const result = await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch({ path: '/gallery/demo?token=secret' }),
      bodySizeBytes: 256,
      userId: null,
      currentHost: '616618.xyz',
    })

    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(1)
    expect(result.errors?.[0]).toMatchObject({ code: 'ANALYTICS_URL_SENSITIVE' })
    expect(db.calls.some(call => call.sql.includes('analytics_ingest_health_daily'))).toBe(true)
  })

  it('批量内部分失败返回 accepted/rejected，并继续写入合法事件', async () => {
    const db = createDb()
    const result = await ingestAnalyticsBatch(envFor(db), {
      body: {
        visitorId: 'visitor_123456',
        sessionId: 'session_123456',
        events: [
          baseBatch({ eventId: 'event_valid_1' }).events[0],
          baseBatch({ eventId: 'event_bad_1', eventName: 'unknown_event' }).events[0],
        ],
      },
      bodySizeBytes: 512,
      userId: null,
      currentHost: '616618.xyz',
    })

    expect(result.accepted).toBe(1)
    expect(result.rejected).toBe(1)
    expect(result.errors?.[0]).toMatchObject({ code: 'ANALYTICS_EVENT_NAME_INVALID' })
    expect(db.calls.some(call => call.sql.includes('analytics_sessions'))).toBe(true)
  })

  it('服务端使用 session 派生 userId，忽略前端伪造 user_id', async () => {
    const db = createDb()
    await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch({
        eventId: 'event_register_1',
        eventName: 'register_success',
        user_id: 999,
        entityType: 'auth',
        props: { invite_code_id: 'inv_1' },
      }),
      bodySizeBytes: 512,
      userId: 42,
      currentHost: '616618.xyz',
    })

    const rawInsert = db.calls.find(call => call.sql.includes('INSERT OR IGNORE INTO analytics_events'))
    expect(rawInsert).toBeTruthy()
    expect(rawInsert?.params[5]).toBe(42)
    expect(JSON.stringify(rawInsert?.params)).not.toContain('999')
  })

  it('识别推广来源 UTM 和 referrer 并写入 session 来源字段', async () => {
    const db = createDb()
    await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch({
        trackingSourceSlug: 'telegram-june',
        utmSource: 'telegram-june',
        utmMedium: 'social',
        utmCampaign: 'telegram-june',
        referrer: 'https://t.me/channel/post',
      }),
      bodySizeBytes: 512,
      userId: null,
      currentHost: '616618.xyz',
    })

    const sessionInsert = db.calls.find(call => call.sql.includes('INSERT INTO analytics_sessions'))
    expect(sessionInsert?.params[7]).toBe('social')
    expect(sessionInsert?.params[8]).toBe('telegram-june')
    expect(sessionInsert?.params[9]).toBe('t.me')
    expect(sessionInsert?.params[10]).toBe('telegram-june')
    expect(sessionInsert?.params[11]).toBe('social')
    expect(sessionInsert?.params[12]).toBe('telegram-june')
  })

  it('批量采集会同步写入日报聚合、来源页面和来源点击聚合', async () => {
    const db = createDb()
    await ingestAnalyticsBatch(envFor(db), {
      body: {
        visitorId: 'visitor_source_1',
        sessionId: 'session_source_1',
        events: [
          baseBatch({
            eventId: 'event_source_page_1',
            eventName: 'page_view',
            trackingSourceSlug: 'telegram-june',
            utmSource: 'telegram-june',
            utmMedium: 'social',
            routeName: '/gallery/:slug',
            path: '/gallery/demo',
            entityType: 'gallery',
            entityId: 'gallery-1',
          }).events[0],
          baseBatch({
            eventId: 'event_source_click_1',
            eventName: 'contact_method_click',
            trackingSourceSlug: 'telegram-june',
            utmSource: 'telegram-june',
            utmMedium: 'social',
            routeName: '/gallery/:slug',
            path: '/gallery/demo',
            entityType: 'contact',
            entityId: 'floating_contact_panel',
            props: {
              element_id: 'contact_method_click',
              element_type: 'button',
              location: 'floating_contact_panel',
              target_type: 'contact',
              target_id: 'floating_contact_panel',
            },
          }).events[0],
        ],
      },
      bodySizeBytes: 1024,
      userId: null,
      currentHost: '616618.xyz',
    })

    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_daily_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_daily_pages'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_click_daily'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_source_page_daily'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_source_click_daily'))).toBe(true)
  })

  it('采样率为 0 时不写采样原始事件，关键转化事件仍写明细', async () => {
    const db = createDb({ sampleRate: 0 })
    await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch({ eventId: 'event_page_1', eventName: 'page_view' }),
      bodySizeBytes: 256,
      userId: null,
      currentHost: '616618.xyz',
    })
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO analytics_events'))).toBe(false)

    await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch({ eventId: 'event_login_1', eventName: 'login_failed', entityType: 'auth', props: { failure_code: 'BAD_PASSWORD' } }),
      bodySizeBytes: 256,
      userId: null,
      currentHost: '616618.xyz',
    })
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO analytics_events'))).toBe(true)
  })

  it('采样判断稳定且能在 5% 采样率下找到入样事件', () => {
    const sampledId = Array.from({ length: 5000 }, (_, index) => `event_sample_${index}`)
      .find(eventId => shouldSampleAnalyticsEvent(eventId, 0.05))
    expect(sampledId).toBeTruthy()
    expect(shouldSampleAnalyticsEvent(sampledId!, 0.05)).toBe(true)
    expect(shouldSampleAnalyticsEvent(sampledId!, 0)).toBe(false)
  })

  it('重复 eventId 返回 duplicate 且不重复写入业务摘要', async () => {
    const db = createDb({ existingEvents: ['event_login_1'] })
    const result = await ingestAnalyticsBatch(envFor(db), {
      body: baseBatch({ eventId: 'event_login_1', eventName: 'login_failed', entityType: 'auth', props: { failure_code: 'BAD_PASSWORD' } }),
      bodySizeBytes: 256,
      userId: null,
      currentHost: '616618.xyz',
    })

    expect(result.accepted).toBe(0)
    expect(result.duplicate).toBe(1)
    expect(db.calls.some(call => call.sql.includes('analytics_sessions'))).toBe(false)
  })

  it('把 sendBeacon session/end 简写 payload 转成批量事件', () => {
    expect(normalizeSessionEndPayload({
      visitorId: 'visitor_123456',
      sessionId: 'session_123456',
      activeSeconds: 25,
      pageViewCount: 2,
      path: '/gallery/demo',
      occurredAt: '2026-06-07T10:00:00.000Z',
    })).toMatchObject({
      visitorId: 'visitor_123456',
      sessionId: 'session_123456',
      events: [
        {
          eventName: 'session_end',
          path: '/gallery/demo',
          props: { active_seconds: 25, page_view_count: 2 },
        },
      ],
    })
  })

  it('10,000 sessions / 天基线下 rows written 不超过 160,000', async () => {
    const sessionCount = 10_000
    const db = createDb({ sampleRate: 0 })
    let rowsWritten = 0

    for (let index = 0; index < sessionCount; index += 1) {
      const sessionId = `session_perf_${index}`
      const visitorId = `visitor_perf_${index}`
      const result = await ingestAnalyticsBatch(envFor(db), {
        body: {
          visitorId,
          sessionId,
          events: [
            perfEvent(index, 0, 'session_start', '/', 'home'),
            perfEvent(index, 1, 'page_view', '/', 'home'),
            perfEvent(index, 2, 'page_view', '/search', '/search'),
            perfEvent(index, 3, 'page_view', '/gallery/demo', '/gallery/:slug', { entityType: 'gallery', entityId: 'gallery-1' }),
            perfEvent(index, 4, 'membership_cta_click', '/gallery/demo', '/gallery/:slug', {
              entityType: 'gallery',
              entityId: 'gallery-1',
              props: { element_id: 'membership_cta', element_type: 'button', location: 'gallery_detail', target_type: 'contact', target_id: 'floating_contact_panel' },
            }),
            perfEvent(index, 5, 'membership_cta_click', '/gallery/demo', '/gallery/:slug', {
              entityType: 'gallery',
              entityId: 'gallery-1',
              props: { element_id: 'membership_cta', element_type: 'button', location: 'gallery_detail', target_type: 'contact', target_id: 'floating_contact_panel' },
            }),
          ],
        },
        bodySizeBytes: 2048,
        userId: null,
        currentHost: '616618.xyz',
      })
      rowsWritten += result.usage.rowsWritten
    }

    expect(rowsWritten).toBeLessThanOrEqual(160_000)
  }, 20_000)
})

function perfEvent(
  sessionIndex: number,
  eventIndex: number,
  eventName: string,
  path: string,
  routeName: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId: `event_perf_${sessionIndex}_${eventIndex}`,
    eventName,
    occurredAt: `2026-06-07T10:${String(Math.floor(eventIndex / 2)).padStart(2, '0')}:00.000Z`,
    routeName,
    path,
    pageTitle: '性能成本基线',
    props: eventIndex === 1 ? { is_landing: true } : {},
    ...overrides,
  }
}
