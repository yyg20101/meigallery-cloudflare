import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRegistrationFactOnly } from './conversions'
import { recoverRegistrationConversionFacts } from './registration-conversion-recovery'

vi.mock('./conversions', () => ({
  recordRegistrationFactOnly: vi.fn(),
}))

const recordFactOnlyMock = vi.mocked(recordRegistrationFactOnly)

describe('注册转化事实修复任务', () => {
  beforeEach(() => {
    recordFactOnlyMock.mockReset()
    recordFactOnlyMock.mockResolvedValue({
      id: 'conv_recovered',
      actionType: 'complete_registration',
      created: true,
      duplicateOf: '',
      trackingInstructions: [],
    })
  })

  it('只扫描已超过实时投递窗口的缺失事实用户，每批最多 100 个', async () => {
    const db = createRecoveryDb([
      { id: 41, created_at: '2020-01-01T07:00:00.000Z' },
      { id: 42, created_at: '2026-07-10T08:00:00.000Z' },
    ])

    const result = await recoverRegistrationConversionFacts(
      db as unknown as D1Database,
      new Date('2026-07-10T09:00:00.000Z'),
    )

    expect(result).toEqual({ scanned: 2, created: 2, existing: 0, failed: 0 })
    const scan = db.calls.find(call => call.sql.includes('FROM users u'))
    expect(scan?.sql).toContain('datetime(u.created_at) <= datetime(?)')
    expect(scan?.sql).toContain("fact.canonical_event = 'CompleteRegistration'")
    expect(scan?.sql).toContain("json_extract(fact.analytics_dimensions_json, '$.userId')")
    expect(scan?.sql).not.toContain('analytics_conversion_actions')
    expect(scan?.sql).toContain('LIMIT 100')
    expect(scan?.sql).not.toContain('email')
    expect(scan?.sql).not.toContain('meta_external_id')
    expect(scan?.params).toEqual([
      0,
      '2026-07-10T08:50:00.000Z',
      'old',
    ])
    expect(recordFactOnlyMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      userId: 41,
      occurredAt: '2020-01-01T07:00:00.000Z',
      visitorId: 'registration_user_41',
      sessionId: 'registration_user_41',
      sourceChannel: 'unknown',
      metadata: { method: 'email', recovery: true },
    }, {
      owner: 'old',
      epoch: 1,
      changedBy: null,
      changedAt: '2026-07-24T00:00:00.000Z',
    })
    expect(recordFactOnlyMock.mock.calls.every(call => call.length === 3)).toBe(true)
  })

  it('失败时保留游标，下次成功后再继续推进，避免静默漏数', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const users = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      created_at: `2020-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }))
    const db = createPagedRecoveryDb(users)
    recordFactOnlyMock
      .mockRejectedValueOnce(new Error('暂时故障'))
      .mockImplementation(async (_db, input) => {
      db.completed.add(input.userId)
      return {
        id: `conv_${input.userId}`,
        actionType: 'complete_registration',
        created: true,
        duplicateOf: '',
        trackingInstructions: [],
      }
      })

    const first = await recoverRegistrationConversionFacts(db as unknown as D1Database)
    const second = await recoverRegistrationConversionFacts(db as unknown as D1Database)

    expect(first).toMatchObject({ scanned: 3, created: 0, failed: 1 })
    expect(second).toMatchObject({ scanned: 3, created: 3, failed: 0 })
    expect(db.completed).toEqual(new Set([1, 2, 3]))
  })

  it('单行失败即停止本批，不越过失败用户推进游标', async () => {
    recordFactOnlyMock
      .mockRejectedValueOnce(new Error('private failure'))
      .mockResolvedValueOnce({
        id: 'conv_42',
        actionType: 'complete_registration',
        created: false,
        duplicateOf: 'conv_existing',
        trackingInstructions: [],
      })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = createRecoveryDb([
      { id: 41, created_at: '2026-07-10T07:00:00.000Z' },
      { id: 42, created_at: '2026-07-10T08:00:00.000Z' },
    ])

    const result = await recoverRegistrationConversionFacts(db as unknown as D1Database)

    expect(result).toEqual({ scanned: 2, created: 0, existing: 0, failed: 1 })
    expect(recordFactOnlyMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private failure')
  })

  it('draining 只选择 routing_owner=old 的注册，new 完全停止旧补偿', async () => {
    const drainingDb = createRecoveryDb([
      { id: 41, created_at: '2026-07-10T07:00:00.000Z' },
    ], { owner: 'draining' })
    await recoverRegistrationConversionFacts(
      drainingDb as unknown as D1Database,
    )
    const scan = drainingDb.calls.find(
      call => call.sql.includes('FROM users u'),
    )
    expect(scan?.sql).toContain(
      "business_outbox.routing_owner = 'old'",
    )
    expect(scan?.params).toEqual([
      0,
      expect.any(String),
      'draining',
    ])
    expect(recordFactOnlyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        owner: 'draining',
        epoch: 2,
      }),
    )

    recordFactOnlyMock.mockClear()
    const newDb = createRecoveryDb([], { owner: 'new' })
    await expect(recoverRegistrationConversionFacts(
      newDb as unknown as D1Database,
    )).resolves.toEqual({
      scanned: 0,
      created: 0,
      existing: 0,
      failed: 0,
    })
    expect(newDb.calls.some(
      call => call.sql.includes('FROM users u'),
    )).toBe(false)
    expect(recordFactOnlyMock).not.toHaveBeenCalled()
  })

  it('不扫描仍在实时投递等待窗口或未来的用户', async () => {
    const db = createRecoveryDb([
      { id: 98, created_at: '2026-07-10T08:55:00.000Z' },
      { id: 99, created_at: '2999-01-01T00:00:00.000Z' },
    ], { respectMatureBefore: true })

    const result = await recoverRegistrationConversionFacts(
      db as unknown as D1Database,
      new Date('2026-07-10T09:00:00.000Z'),
    )

    const scan = db.calls.find(call => call.sql.includes('FROM users u'))
    expect(scan?.sql).toContain('datetime(u.created_at) <= datetime(?)')
    expect(result).toEqual({ scanned: 0, created: 0, existing: 0, failed: 0 })
    expect(recordFactOnlyMock).not.toHaveBeenCalled()
  })
})

type RecoveryUser = { id: number; created_at: string }
type PreparedCall = { sql: string; params: unknown[] }

function createRecoveryDb(users: RecoveryUser[], options: {
  respectMatureBefore?: boolean
  owner?: 'old' | 'draining' | 'new'
} = {}) {
  const calls: PreparedCall[] = []
  let cursor = 0
  return {
    calls,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          const results = options.respectMatureBefore
            && sql.includes('datetime(u.created_at) <= datetime(?)')
            ? users.filter(user =>
                user.created_at <= String(call.params[1] ?? ''))
            : users
          return { results: results as T[] }
        },
        async first<T>() {
          return sql.includes('FROM attribution_runtime_cutover')
            ? (runtimeOwner(options.owner ?? 'old') as T)
            : sql.includes('FROM site_settings')
            ? ({ value: String(cursor) } as T)
            : null
        },
        async run() {
          if (sql.includes('INSERT INTO site_settings')) cursor = Number(call.params[1] ?? 0)
          return { meta: { changes: 1 } }
        },
      }
    },
  }
}

function createPagedRecoveryDb(users: RecoveryUser[]) {
  const completed = new Set<number>()
  let cursor = 0
  return {
    completed,
    prepare(sql: string) {
      let params: unknown[] = []
      return {
        bind(...values: unknown[]) { params = values; return this },
        async first<T>() {
          return sql.includes('FROM attribution_runtime_cutover')
            ? (runtimeOwner('old') as T)
            : sql.includes('FROM site_settings')
            ? ({ value: String(cursor) } as T)
            : null
        },
        async all<T>() {
          const results = users
            .filter(user => user.id > Number(params[0] ?? cursor) && !completed.has(user.id))
            .slice(0, 100)
          return { results: results as T[] }
        },
        async run() {
          if (sql.includes('INSERT INTO site_settings')) cursor = Number(params[1] ?? 0)
          return { meta: { changes: 1 } }
        },
      }
    },
  }
}

function runtimeOwner(owner: 'old' | 'draining' | 'new') {
  return {
    owner,
    owner_epoch: owner === 'old' ? 1 : owner === 'draining' ? 2 : 3,
    changed_by: null,
    changed_at: '2026-07-24T00:00:00.000Z',
  }
}
