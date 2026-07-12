import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { ActiveMetaEventName, ConversionSkipReason } from '@meigallery/shared'
import type { Bindings } from '../index'
import {
  MetaCapiDeliveryError,
  buildMetaCapiPayload,
  classifyMetaCapiError,
  sendMetaCapiEvent,
  type MetaCapiPayloadInput,
} from './meta-capi'
import { readMetaEventsResponse } from './meta-graph'

type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'duplicate_suppressed'
type DeliveryRow = {
  id: string
  conversion_action_id: string
  channel: string
  external_event_id: string
  event_name: string
  status: DeliveryStatus
  skip_reason: string
  error_code: string
  error_message: string
  attempt_count: number
  tracking_mode: 'disabled' | 'test' | 'production'
  meta_connection_revision: string | null
  duplicate_suppressed_at: string | null
  last_attempt_at: string | null
  sent_at: string | null
  date: string
  occurred_at: string
  path: string
  metadata: string
  delivery_lease_token: string
  delivery_lease_expires_at: string | null
}

const RELEASE_COMMIT = 'a'.repeat(40)
const TOKEN_FINGERPRINT = '0b7a8749b34fd009cf020b30ea6bde2defee9e24b5f1c191764d60b8c1de9f31'
const CONNECTION_REVISION = '1'.repeat(32)

function createMetaCapiDb(options: {
  pixelId?: string
  delivery?: Partial<DeliveryRow>
  connectionVerified?: boolean
  connectionRevision?: string
  incidentBatchFailure?: boolean
  beforeFirstDeliveryTransition?: (delivery: DeliveryRow) => void
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const delivery: DeliveryRow = {
    id: 'cdlv_1',
    conversion_action_id: 'conv_1',
    channel: 'meta_capi',
    external_event_id: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
    event_name: 'Contact',
    status: 'pending',
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 0,
    tracking_mode: 'production',
    meta_connection_revision: CONNECTION_REVISION,
    duplicate_suppressed_at: null,
    last_attempt_at: null,
    sent_at: null,
    date: '2026-07-09',
    occurred_at: '2026-07-09T10:00:00.000Z',
    path: '/gallery/demo',
    metadata: JSON.stringify({ method_type: 'telegram', email: 'user@example.test' }),
    delivery_lease_token: '',
    delivery_lease_expires_at: null,
    ...options.delivery,
  }
  const daily: Array<Record<string, unknown>> = []
  let transitionHookCalled = false
  const db = {
    calls,
    delivery,
    daily,
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] }
      const statement = {
        __call: call,
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('JOIN analytics_conversion_actions')) {
            return call.params[0] === delivery.id ? ({ ...delivery } as T) : null
          }
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) {
            return options.pixelId ? ({ value: options.pixelId } as T) : null
          }
          if (sql.includes("WHERE key = 'meta_tracking_mode'")) {
            return { value: JSON.stringify(delivery.tracking_mode) } as T
          }
          if (sql.includes('FROM meta_connection_verifications')) {
            if (!options.pixelId || options.connectionVerified === false) return null
            return {
              environment: 'dev',
              pixel_id: options.pixelId,
              token_fingerprint: TOKEN_FINGERPRINT,
              graph_api_version: 'v25.0',
              verified_event_name: 'Contact',
              verified_commit: RELEASE_COMMIT,
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: 1,
              invalidated_at: null,
              invalidation_reason: '',
              revision: options.connectionRevision ?? CONNECTION_REVISION,
            } as T
          }
          return null
        },
        async all<T>() {
          calls.push(call)
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          if (sql.includes('delivery_lease_expires_at = datetime')) {
            if (delivery.delivery_lease_token || !['pending', 'failed'].includes(delivery.status)) {
              return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
            }
            delivery.delivery_lease_token = String(call.params[0])
            delivery.delivery_lease_expires_at = '2026-07-11 00:01:00'
            return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
          }
          if (sql.includes("SET delivery_lease_token = ''")) {
            const matches = delivery.delivery_lease_token === String(call.params[1])
            if (matches) {
              delivery.delivery_lease_token = ''
              delivery.delivery_lease_expires_at = null
            }
            return { meta: { changes: matches ? 1 : 0, rows_written: matches ? 1 : 0, rows_read: 0, duration: 1 } }
          }
          if (sql.includes('UPDATE analytics_conversion_deliveries')) {
            const changesStatus = /SET\s+status\s*=\s*\?/m.test(sql)
            if (!transitionHookCalled) {
              transitionHookCalled = true
              options.beforeFirstDeliveryTransition?.(delivery)
            }
            const expectedStatus = String(call.params[changesStatus ? 6 : 4])
            if (delivery.status !== expectedStatus || delivery.status === 'sent') {
              return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
            }
            if (sql.includes('AND delivery_lease_token = ?')
              && delivery.delivery_lease_token !== String(call.params.at(-1))) {
              return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
            }
            if (changesStatus) delivery.status = String(call.params[0]) as DeliveryStatus
            const offset = changesStatus ? 1 : 0
            delivery.skip_reason = String(call.params[offset] ?? '')
            delivery.error_code = String(call.params[offset + 1] ?? '')
            delivery.error_message = String(call.params[offset + 2] ?? '')
            delivery.attempt_count += 1
            if (delivery.status === 'sent') delivery.sent_at = 'now'
          }
          if (sql.includes('INSERT INTO analytics_conversion_delivery_daily')) {
            daily.push({
              date: call.params[0],
              channel: call.params[1],
              event_name: call.params[2],
              status: call.params[3],
              skip_reason: call.params[4],
            })
          }
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<D1Result<unknown>> }>) {
      if (options.incidentBatchFailure && statements.some(statement => (
        '__call' in statement
        && String((statement as { __call?: { sql?: string } }).__call?.sql).includes('meta_capi_incidents')
      ))) throw new Error('模拟 incident 写入失败')
      return Promise.all(statements.map(statement => statement.run()))
    },
  }
  return db
}

function createConcurrentSuccessDb() {
  const delivery = {
    id: 'cdlv_concurrent',
    conversion_action_id: 'conv_concurrent',
    channel: 'meta_capi',
    external_event_id: 'event_concurrent',
    event_name: 'Contact',
    status: 'pending' as DeliveryStatus,
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 0,
    tracking_mode: 'production' as const,
    meta_connection_revision: CONNECTION_REVISION,
    duplicate_suppressed_at: null as string | null,
    last_attempt_at: null,
    sent_at: null as string | null,
    date: '2026-07-10',
    occurred_at: '2026-07-10T00:00:00.000Z',
    path: '/',
    metadata: '{}',
    delivery_lease_token: '',
    delivery_lease_expires_at: null as string | null,
  }
  const daily = new Map<string, number>([['pending', 1]])
  const db = {
    delivery,
    daily,
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params
          return this
        },
        async first<T>() {
          if (sql.includes('FROM analytics_conversion_deliveries')) return { ...delivery } as T
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) return { value: JSON.stringify('1234567890') } as T
          if (sql.includes("WHERE key = 'meta_tracking_mode'")) return { value: JSON.stringify(delivery.tracking_mode) } as T
          if (sql.includes('FROM meta_connection_verifications')) {
            return {
              environment: 'dev',
              pixel_id: '1234567890',
              token_fingerprint: TOKEN_FINGERPRINT,
              graph_api_version: 'v25.0',
              verified_event_name: 'Contact',
              verified_commit: RELEASE_COMMIT,
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: 1,
              invalidated_at: null,
              invalidation_reason: '',
              revision: CONNECTION_REVISION,
            } as T
          }
          return null
        },
        async run() {
          return applyStatement(statement, 1).result
        },
      }
      return statement
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      let lastChanges = 1
      return statements.map(statement => {
        const applied = applyStatement(statement, lastChanges)
        lastChanges = applied.changes
        return applied.result
      })
    },
  }

  function applyStatement(statement: { sql: string; params: unknown[] }, lastChanges: number) {
    const { sql, params } = statement
    let changes = 1
    if (sql.includes('UPDATE analytics_conversion_deliveries')) {
      if (sql.includes('delivery_lease_expires_at = datetime')) {
        changes = !delivery.delivery_lease_token && ['pending', 'failed'].includes(delivery.status) ? 1 : 0
        if (changes) {
          delivery.delivery_lease_token = String(params[0])
          delivery.delivery_lease_expires_at = '2026-07-10 00:01:00'
        }
      } else if (sql.includes("SET delivery_lease_token = ''")) {
        changes = delivery.delivery_lease_token === String(params[1]) ? 1 : 0
        if (changes) {
          delivery.delivery_lease_token = ''
          delivery.delivery_lease_expires_at = null
        }
      } else if (sql.includes('duplicate_suppressed_at')) {
        changes = delivery.status === 'sent' && !delivery.duplicate_suppressed_at ? 1 : 0
        if (changes) delivery.duplicate_suppressed_at = '2026-07-10 00:00:02'
      } else {
        const expectedStatus = String(params[6])
        changes = delivery.status === expectedStatus
          && delivery.status !== 'sent'
          && (!sql.includes('AND delivery_lease_token = ?') || delivery.delivery_lease_token === String(params.at(-1)))
          ? 1 : 0
        if (changes) {
          delivery.status = String(params[0]) as DeliveryStatus
          delivery.skip_reason = String(params[1] ?? '')
          delivery.error_code = String(params[2] ?? '')
          delivery.error_message = String(params[3] ?? '')
          delivery.attempt_count += 1
          if (delivery.status === 'sent') delivery.sent_at = '2026-07-10 00:00:01'
        }
      }
    } else if (sql.includes('analytics_conversion_delivery_daily')) {
      changes = sql.includes('WHERE changes() = 1') && lastChanges !== 1 ? 0 : 1
      if (changes && sql.includes('delivery_count + 1')) {
        const status = sql.includes("'duplicate_suppressed'") ? 'duplicate_suppressed' : String(params[3])
        daily.set(status, (daily.get(status) ?? 0) + 1)
      } else if (changes && sql.includes('delivery_count - 1')) {
        const status = String(params[3])
        daily.set(status, Math.max(0, (daily.get(status) ?? 0) - 1))
      }
    }
    return {
      changes,
      result: { meta: { changes, rows_written: changes, rows_read: 0, duration: 1 } },
    }
  }

  return db
}

function envFor(db: ReturnType<typeof createMetaCapiDb>, overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'dev',
    SITE_URL: 'https://616618.xyz',
    META_CAPI_ACCESS_TOKEN: 'token_1',
    META_CAPI_TEST_EVENT_CODE: 'test-code',
    RELEASE_COMMIT,
    DB: db,
    ...overrides,
  } as unknown as Pick<Bindings, 'APP_ENV' | 'SITE_URL' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE' | 'RELEASE_COMMIT' | 'DB'>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('meta-capi', () => {
  it('共享跳过原因包含安全投递终态', () => {
    const reasons: ConversionSkipReason[] = [
      'unsupported_event',
      'missing_data_key',
      'invalid_data_key',
      'invalid_sensitive_context',
      'secure_context_expired',
      'secure_context_invalid',
      'queue_message_invalid',
    ]

    expect(reasons).toHaveLength(7)
  })

  it('CAPI payload 事件名使用活动 Meta 事件类型', () => {
    expectTypeOf<MetaCapiPayloadInput['eventName']>().toEqualTypeOf<ActiveMetaEventName>()
  })

  it('payload 只包含白名单字段', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'Contact',
      eventId: 'event_1',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      userData: { fbp: 'fb.1.1', fbc: 'fb.1.2' },
      customData: { method_type: 'telegram', email: 'user@example.test' },
    })
    expect(JSON.stringify(payload)).toContain('telegram')
    expect(JSON.stringify(payload)).not.toContain('user@example.test')
  })

  it('Contact 无条件丢弃邮箱与 external ID hash', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'Contact',
      eventId: 'event_contact_hash_defense',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      userData: {
        fbp: 'fb.1.1700000000000.123456789',
        emailSha256: 'a'.repeat(64),
        externalIdSha256: 'b'.repeat(64),
      },
    })

    expect(payload.data[0]?.user_data).toEqual({ fbp: 'fb.1.1700000000000.123456789' })
    expect(payload.data[0]?.user_data).not.toHaveProperty('em')
    expect(payload.data[0]?.user_data).not.toHaveProperty('external_id')
  })

  it('CompleteRegistration 仅接受 lowercase SHA-256 单元素数组', () => {
    const emailSha256 = 'a'.repeat(64)
    const externalIdSha256 = 'b'.repeat(64)
    const valid = buildMetaCapiPayload({
      eventName: 'CompleteRegistration',
      eventId: 'event_registration_hashes',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/register',
      actionSource: 'website',
      userData: { emailSha256, externalIdSha256 },
    })
    const invalid = buildMetaCapiPayload({
      eventName: 'CompleteRegistration',
      eventId: 'event_registration_bad_hashes',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/register',
      actionSource: 'website',
      userData: {
        emailSha256: 'A'.repeat(64),
        externalIdSha256: 'b'.repeat(63),
      },
    })

    expect(valid.data[0]?.user_data).toEqual({
      em: [emailSha256],
      external_id: [externalIdSha256],
    })
    expect(invalid.data[0]?.user_data).toEqual({})
  })

  it('CompleteRegistration Graph body 只携带 hash，不携带邮箱或 external ID 原值', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { event_name: 'CompleteRegistration' },
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))
    const email = 'graph-raw-s5@example.test'
    const externalId = 'fedcba9876543210fedcba9876543210'
    const emailSha256 = 'a'.repeat(64)
    const externalIdSha256 = 'b'.repeat(64)

    await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn,
      userData: {
        fbp: 'fb.1.1700000000000.graph-s5',
        emailSha256,
        externalIdSha256,
        email,
        metaExternalId: externalId,
      } as never,
    })

    const graphRequest = String(fetchFn.mock.calls[0]?.[1]?.body)
    expect(JSON.parse(graphRequest).data[0].user_data).toEqual({
      fbp: 'fb.1.1700000000000.graph-s5',
      em: [emailSha256],
      external_id: [externalIdSha256],
    })
    expect(graphRequest).not.toContain(email)
    expect(graphRequest).not.toContain(externalId)
    expect(graphRequest).not.toContain('conversion-token')
  })

  it('Graph 错误只解析数字 code 与严格 trace，丢弃完整 body 和冲突 trace', async () => {
    const sensitiveToken = 'S5SensitiveToken_123'
    const parsed = await readMetaEventsResponse(new Response(JSON.stringify({
      error: {
        message: 'graph-raw-s5@example.test fedcba9876543210fedcba9876543210',
        type: 'OAuthException',
        code: 190,
        error_subcode: 463,
        fbtrace_id: 'Trace_S5-safe-123',
      },
    }), { status: 400 }), [sensitiveToken])
    const conflict = await readMetaEventsResponse(new Response(JSON.stringify({
      error: { code: 190, fbtrace_id: sensitiveToken },
    }), { status: 400 }), [sensitiveToken])

    expect(parsed).toEqual({ eventsReceived: undefined, errorCode: 190, traceId: 'Trace_S5-safe-123' })
    expect(JSON.stringify(parsed)).not.toContain('graph-raw-s5@example.test')
    expect(JSON.stringify(parsed)).not.toContain('OAuthException')
    expect(JSON.stringify(parsed)).not.toContain('463')
    expect(conflict).toEqual({ eventsReceived: undefined, errorCode: 190 })
  })

  it('Graph 错误原值不进入 delivery、结果或 console', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const sensitiveValues = [
      'graph-error-s5@example.test',
      '44444444444444444444444444444444',
      'conversion-token',
      '203.0.113.177',
      'Graph Error Private Browser/7.7',
    ]
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: sensitiveValues.join('|'),
        type: 'OAuthException',
        code: 190,
        fbtrace_id: 'conversion-token',
      },
    }), { status: 400 }))

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', { fetchFn })
    const serializedBoundaries = JSON.stringify({
      result,
      dbCalls: db.calls,
      delivery: db.delivery,
      logs: [...consoleError.mock.calls, ...consoleWarn.mock.calls],
    })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'failed', reason: '400' })
    for (const sensitive of sensitiveValues) expect(serializedBoundaries).not.toContain(sensitive)
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  it('custom_data 只保留白名单内的有效字符串、有限数字和布尔值', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'CompleteRegistration',
      eventId: 'event_typed_custom_data',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      customData: {
        method_type: 42,
        action_type: true,
        content_category: '  portrait  ',
        location: Number.POSITIVE_INFINITY,
        content_name: '   ',
        unknown_field: 'secret',
      },
    })

    expect(payload.data[0]?.custom_data).toEqual({
      method_type: 42,
      action_type: true,
      content_category: 'portrait',
    })
  })

  it('Meta 4xx 不重试，5xx 和 429 重试', () => {
    expect(classifyMetaCapiError(400)).toBe('permanent')
    expect(classifyMetaCapiError(500)).toBe('retryable')
    expect(classifyMetaCapiError(429)).toBe('retryable')
  })

  it.each([401, 403])('Meta HTTP %i 使用真实 error code 并立即打开权限 incident', async status => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status })),
    })

    expect(result).toMatchObject({ status: 'failed', reason: String(status) })
    expect(db.delivery.error_code).toBe(`meta_http_${status}`)
    const incident = db.calls.find(call => call.sql.includes('INSERT OR IGNORE INTO meta_capi_incidents'))
    expect(incident?.params).toContain('meta_permission_denied')
    expect(JSON.stringify(incident)).not.toContain('token_1')
    expect(db.calls.findIndex(call => call.sql.includes('INSERT OR IGNORE INTO meta_capi_incidents')))
      .toBeLessThan(db.calls.findIndex(call => /UPDATE analytics_conversion_deliveries[\s\S]+SET\s+status\s*=\s*\?/.test(call.sql)))
  })

  it('401/403 即使 CAS 竞争为 sent，也先打开权限 incident 再返回 duplicate_suppressed', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      beforeFirstDeliveryTransition: delivery => {
        delivery.status = 'sent'
        delivery.sent_at = 'now'
      },
    })
    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    })

    expect(result).toMatchObject({ status: 'sent', reason: 'already_sent' })
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO meta_capi_incidents'))).toBe(true)
  })

  it('401/403 即使 delivery transition 冲突，也先打开权限 incident再保留状态冲突', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      beforeFirstDeliveryTransition: delivery => {
        delivery.status = 'skipped'
        delivery.skip_reason = 'concurrent_skip'
      },
    })
    const error = await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status: 403 })),
    }).catch(value => value as MetaCapiDeliveryError)

    expect(error).toMatchObject({ code: 'meta_delivery_state_conflict' })
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO meta_capi_incidents'))).toBe(true)
  })

  it('权限 incident 写入失败不替换原 delivery 失败', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890', incidentBatchFailure: true })
    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'failed', reason: '401' })
    expect(db.delivery.error_code).toBe('meta_http_401')
  })

  it.each(['Contact', 'CompleteRegistration'] as const)('普通 test 模式 %s payload 也不携带 Test Event Code', async eventName => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { event_name: eventName, tracking_mode: 'test' },
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db, { META_CAPI_TEST_EVENT_CODE: 'test-code-from-env' } as Partial<Bindings>), 'cdlv_1', { fetchFn })

    const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].event_name).toBe(eventName)
    expect(payload).not.toHaveProperty('test_event_code')
  })

  it.each(['Lead', 'StartTrial'])('历史 %s delivery 在 fetch 前进入 unsupported_event 安全终态', async eventName => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { event_name: eventName },
    })
    const fetchFn = vi.fn()

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', { fetchFn })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'skipped', reason: 'unsupported_event' })
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'unsupported_event' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('test 模式缺少 Test Event Code 时 fail closed 且绝不请求 Graph', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { tracking_mode: 'test' },
    })
    const fetchFn = vi.fn()

    const result = await sendMetaCapiEvent(envFor(db, { META_CAPI_TEST_EVENT_CODE: '  ' } as Partial<Bindings>), 'cdlv_1', { fetchFn })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'skipped', reason: 'connection_unverified' })
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'connection_unverified' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('production 模式即使环境和调用参数有 Test Event Code 也绝不附带', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { tracking_mode: 'production' },
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db, { META_CAPI_TEST_EVENT_CODE: 'environment-test-code' } as Partial<Bindings>), 'cdlv_1', { fetchFn })

    const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    expect(payload).not.toHaveProperty('test_event_code')
  })

  it('Graph fetch 前 MetaConnection 失效时安全跳过且不使用当前新 Dataset', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890', connectionVerified: false })
    const fetchFn = vi.fn()

    const result = await sendMetaCapiEvent(envFor(db, {
      APP_ENV: 'dev',
      RELEASE_COMMIT: 'a'.repeat(40),
    }), 'cdlv_1', { fetchFn })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'skipped', reason: 'connection_unverified' })
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'connection_unverified' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('delivery 绑定旧 revision 时在 fetch 前安全跳过', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      connectionRevision: '2'.repeat(32),
      delivery: { meta_connection_revision: '1'.repeat(32) },
    })
    const fetchFn = vi.fn()

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', { fetchFn })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'skipped', reason: 'connection_unverified' })
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'connection_unverified' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('缺少 access token 时标记 skipped/connection_unverified', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { path: 'https://evil.example/private?token=secret' },
    })
    await sendMetaCapiEvent(envFor(db, { META_CAPI_ACCESS_TOKEN: '' } as Partial<Bindings>), 'cdlv_1')

    expect(db.delivery.status).toBe('skipped')
    expect(db.delivery.skip_reason).toBe('connection_unverified')
    expect(db.daily[0]).toMatchObject({ status: 'skipped', skip_reason: 'connection_unverified' })
  })

  it('缺少 Pixel ID 时标记 skipped/connection_unverified', async () => {
    const db = createMetaCapiDb()
    await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    expect(db.delivery.status).toBe('skipped')
    expect(db.delivery.skip_reason).toBe('connection_unverified')
  })

  it('Meta 仅在 v25.0 返回 events_received=1 时标记 sent 且不泄露 token', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { path: 'https://evil.example/private?token=secret' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    expect(result.status).toBe('sent')
    expect(result.eventsReceived).toBe(1)
    expect(db.delivery.status).toBe('sent')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/v25.0/1234567890/events')
    expect(new URL(String(url)).search).toBe('')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token_1')
    const payload = JSON.parse(String(init?.body))
    expect(payload.data[0].event_source_url).toBe('https://616618.xyz/')
    expect(JSON.stringify(payload)).not.toContain('token_1')
    expect(JSON.stringify(init)).not.toContain('evil.example')
    expect(JSON.stringify(init)).not.toContain('user@example.test')
  })

  it('两个 pending 消息并发时只有 lease 赢家 fetch，loser 安全等待且第三次识别 sent', async () => {
    const db = createConcurrentSuccessDb()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const fetchFn = vi.fn(async () => {
      await barrier
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    })
    const concurrentEnv = envFor(db as unknown as ReturnType<typeof createMetaCapiDb>)

    const winnerPromise = sendMetaCapiEvent(concurrentEnv, db.delivery.id, { fetchFn })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
    const loser = await sendMetaCapiEvent(concurrentEnv, db.delivery.id, { fetchFn })
    release()
    const winner = await winnerPromise
    const third = await sendMetaCapiEvent(concurrentEnv, db.delivery.id, { fetchFn })

    expect(winner.status).toBe('sent')
    expect(loser).toMatchObject({ status: 'pending', reason: 'delivery_lease_active' })
    expect(third).toMatchObject({ status: 'duplicate_suppressed', reason: 'already_sent' })
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(db.delivery).toMatchObject({ status: 'sent', attempt_count: 1 })
    expect(db.daily.get('pending')).toBe(0)
    expect(db.daily.get('sent')).toBe(1)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
    expect(db.delivery.duplicate_suppressed_at).not.toBeNull()
  })

  it('不从 D1 metadata 恢复 fbp 或 fbc', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { metadata: JSON.stringify({ method_type: 'telegram', fbp: 'fb.1.private', fbc: 'fb.1.private' }) },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({})
    expect(JSON.stringify(payload)).not.toContain('fb.1.private')
  })

  it('仅使用 Queue 临时 userData 构造 Meta CAPI 匹配字段', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      userData: {
        fbp: 'fb.1.1700000000000.123456789',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        clientIpAddress: '203.0.113.24',
        clientUserAgent: 'MeiGallery Test Browser/1.0',
      },
    })

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      client_ip_address: '203.0.113.24',
      client_user_agent: 'MeiGallery Test Browser/1.0',
    })
  })

  it('消费异常 Queue userData 时丢弃无效字段', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'Contact',
      eventId: 'event_1',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      userData: {
        fbp: 'bad\nvalue',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        clientIpAddress: `${'1'.repeat(65)}\n`,
        clientUserAgent: 'browser\nagent',
      },
    })

    expect(payload.data[0].user_data).toEqual({ fbc: 'fb.1.1700000000000.CLICK_abc-123' })
  })

  it('Meta 5xx 标记 failed 后抛错交给 Queue 重试', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const sensitive = 'fb.1.1700000000000.123456789|fb.1.1700000000000.CLICK_abc-123|203.0.113.24|MeiGallery Test Browser/1.0|token_private'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sensitive, { status: 500 }))

    await expect(sendMetaCapiEvent(envFor(db), 'cdlv_1')).rejects.toMatchObject({
      message: 'Meta CAPI 请求失败',
      retryable: true,
      code: 'meta_http_500',
    })
    expect(db.delivery.status).toBe('failed')
    expect(db.delivery.error_code).toBe('meta_http_500')
    expect(db.delivery.error_message).toBe('Meta CAPI 请求失败')
    expect(JSON.stringify(db.calls)).not.toContain(sensitive)
  })

  it('Meta 2xx 但 events_received=0 时记录永久失败', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events_received: 0,
      fbtrace_id: 'trace_1',
    }), { status: 200 }))

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', { fetchFn })

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'events_not_received',
      eventsReceived: 0,
    })
    expect(result).not.toHaveProperty('traceId')
    expect(db.delivery).toMatchObject({
      status: 'failed',
      error_code: 'meta_events_not_received',
      error_message: 'Meta CAPI 请求失败',
    })
  })

  it('确定性 4xx 与 2xx/0 不抛可重试错误', async () => {
    const badRequestDb = createMetaCapiDb({ pixelId: '1234567890' })
    const badRequest = await sendMetaCapiEvent(envFor(badRequestDb), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status: 400 })),
    })
    expect(badRequest).toMatchObject({ status: 'failed', reason: '400' })

    const emptySuccessDb = createMetaCapiDb({ pixelId: '1234567890' })
    await expect(sendMetaCapiEvent(envFor(emptySuccessDb), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 0 }), { status: 200 })),
    })).resolves.toMatchObject({ status: 'failed', eventsReceived: 0 })
  })

  it('网络错误与 8 秒可注入超时都转为固定脱敏 retryable 错误', async () => {
    const sensitive = 'token_1|fb.1.private|203.0.113.24|private-browser'
    const networkDb = createMetaCapiDb({ pixelId: '1234567890' })
    const networkPromise = sendMetaCapiEvent(envFor(networkDb), 'cdlv_1', {
      fetchFn: vi.fn().mockRejectedValue(new Error(sensitive)),
      userData: {
        fbp: 'fb.1.private',
        clientIpAddress: '203.0.113.24',
        clientUserAgent: 'private-browser',
      },
    })

    const networkError = await networkPromise.catch(error => error as MetaCapiDeliveryError)
    expect(networkError).toMatchObject({
      message: 'Meta CAPI 请求失败',
      code: 'meta_network_error',
      retryable: true,
    })
    expect(JSON.stringify(networkError)).not.toContain(sensitive)
    expect(JSON.stringify(networkError)).not.toContain('token_1')
    expect(JSON.stringify(networkError)).not.toContain('fb.1.private')

    const timeoutDb = createMetaCapiDb({ pixelId: '1234567890' })
    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const timeoutError = await sendMetaCapiEvent(envFor(timeoutDb), 'cdlv_1', {
      fetchFn: timeoutFetch,
      timeoutMs: 5,
    }).catch(error => error as MetaCapiDeliveryError)

    expect(timeoutError).toMatchObject({
      message: 'Meta CAPI 请求超时',
      code: 'meta_timeout',
      retryable: true,
    })
    expect(timeoutFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('组合超时保留调用方 abort signal', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const caller = new AbortController()
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const sending = sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn,
      signal: caller.signal,
      timeoutMs: 8_000,
    })

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
    caller.abort()

    await expect(sending).rejects.toMatchObject({ retryable: true, code: 'meta_network_error' })
    expect(fetchFn.mock.calls[0]?.[1]?.signal).not.toBe(caller.signal)
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
