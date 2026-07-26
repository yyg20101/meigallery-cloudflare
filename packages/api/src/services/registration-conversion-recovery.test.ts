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

  it('只扫描成熟的缺失事实用户，每批最多 100 个且事件 ID 只由用户 ID 决定', async () => {
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
    expect(scan?.params).toEqual([0, '2026-07-10T08:50:00.000Z'])
    expect(recordFactOnlyMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      userId: 41,
      occurredAt: '2020-01-01T07:00:00.000Z',
      visitorId: 'registration_user_41',
      sessionId: 'registration_user_41',
      sourceChannel: 'unknown',
      metadata: { method: 'email', recovery: true },
    })
    expect(recordFactOnlyMock.mock.calls.every(call => call.length === 2)).toBe(true)
  })

  it('连续批次通过 NOT EXISTS 向后推进，失败行不会永久挡住后续用户', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const users = Array.from({ length: 205 }, (_, index) => ({
      id: index + 1,
      created_at: `2020-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }))
    const db = createPagedRecoveryDb(users)
    recordFactOnlyMock.mockImplementation(async (_db, input) => {
      if (input.userId === 1) throw new Error('稳定故障行')
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
    const third = await recoverRegistrationConversionFacts(db as unknown as D1Database)

    expect(first).toMatchObject({ scanned: 100, created: 99, failed: 1 })
    expect(second).toMatchObject({ scanned: 100, created: 100, failed: 0 })
    expect(third).toMatchObject({ scanned: 5, created: 5, failed: 0 })
    expect(db.completed.size).toBe(204)
    expect(db.completed.has(205)).toBe(true)
  })

  it('即使前 100 行持续失败，cursor 仍让下一批覆盖后续缺失事实', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const users = Array.from({ length: 105 }, (_, index) => ({
      id: index + 1,
      created_at: '2020-01-01T00:00:00.000Z',
    }))
    const db = createPagedRecoveryDb(users)
    recordFactOnlyMock.mockImplementation(async (_database, input) => {
      if (input.userId <= 100) throw new Error('持续故障')
      db.completed.add(input.userId)
      return {
        id: `conv_${input.userId}`,
        actionType: 'complete_registration',
        created: true,
        duplicateOf: '',
        trackingInstructions: [],
      }
    })

    expect(await recoverRegistrationConversionFacts(db as unknown as D1Database))
      .toMatchObject({ scanned: 100, failed: 100 })
    expect(await recoverRegistrationConversionFacts(db as unknown as D1Database))
      .toMatchObject({ scanned: 5, created: 5, failed: 0 })
    expect(db.completed.has(105)).toBe(true)
  })

  it('逐用户隔离失败且不要求任何 Meta delivery 环境', async () => {
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

    expect(result).toEqual({ scanned: 2, created: 0, existing: 1, failed: 1 })
    expect(recordFactOnlyMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private failure')
  })

  it('不扫描 created_at 在未来的用户', async () => {
    const db = createRecoveryDb([
      { id: 99, created_at: '2999-01-01T00:00:00.000Z' },
    ], { excludeFutureWhenUpperBounded: true })

    const result = await recoverRegistrationConversionFacts(
      db as unknown as D1Database,
      new Date('2026-07-10T09:00:00.000Z'),
    )

    const scan = db.calls.find(call => call.sql.includes('FROM users u'))
    expect(scan?.sql).toContain('datetime(u.created_at) <= datetime(?)')
    expect(scan?.params).toEqual([0, '2026-07-10T08:50:00.000Z'])
    expect(result).toEqual({ scanned: 0, created: 0, existing: 0, failed: 0 })
    expect(recordFactOnlyMock).not.toHaveBeenCalled()
  })
})

type RecoveryUser = { id: number; created_at: string }
type PreparedCall = { sql: string; params: unknown[] }

function createRecoveryDb(users: RecoveryUser[], options: { excludeFutureWhenUpperBounded?: boolean } = {}) {
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
          const results = options.excludeFutureWhenUpperBounded
            && sql.includes('datetime(u.created_at) <= datetime(?)')
            ? []
            : users
          return { results: results as T[] }
        },
        async first<T>() {
          return sql.includes('FROM site_settings')
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
          return sql.includes('FROM site_settings')
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
