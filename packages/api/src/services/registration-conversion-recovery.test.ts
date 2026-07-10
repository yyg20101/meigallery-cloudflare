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
      pixelEvents: [],
    })
  })

  it('只扫描最近 24 小时缺失事实的用户，每批最多 100 个', async () => {
    const db = createRecoveryDb([
      { id: 41, created_at: '2026-07-10T07:00:00.000Z' },
      { id: 42, created_at: '2026-07-10T08:00:00.000Z' },
    ])

    const result = await recoverRegistrationConversionFacts(
      db as unknown as D1Database,
      new Date('2026-07-10T09:00:00.000Z'),
    )

    expect(result).toEqual({ scanned: 2, created: 2, existing: 0, failed: 0 })
    const scan = db.calls.find(call => call.sql.includes('FROM users u'))
    expect(scan?.sql).toContain("datetime(?, '-24 hours')")
    expect(scan?.sql).toContain("a.action_type = 'complete_registration'")
    expect(scan?.sql).toContain('LIMIT 100')
    expect(scan?.sql).not.toContain('email')
    expect(scan?.sql).not.toContain('meta_external_id')
    expect(scan?.params).toEqual(['2026-07-10T09:00:00.000Z'])
    expect(recordFactOnlyMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      userId: 41,
      occurredAt: '2026-07-10T07:00:00.000Z',
      visitorId: 'registration_user_41',
      sessionId: 'registration_user_41',
      sourceChannel: 'unknown',
      metadata: { method: 'email', recovery: true },
    })
    expect(recordFactOnlyMock.mock.calls.every(call => call.length === 2)).toBe(true)
  })

  it('逐用户隔离失败且不要求任何 Meta delivery 环境', async () => {
    recordFactOnlyMock
      .mockRejectedValueOnce(new Error('private failure'))
      .mockResolvedValueOnce({
        id: 'conv_42',
        actionType: 'complete_registration',
        created: false,
        duplicateOf: 'conv_existing',
        pixelEvents: [],
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
    expect(scan?.sql).toContain("datetime(u.created_at) <= datetime('now')")
    expect(result).toEqual({ scanned: 0, created: 0, existing: 0, failed: 0 })
    expect(recordFactOnlyMock).not.toHaveBeenCalled()
  })
})

type RecoveryUser = { id: number; created_at: string }
type PreparedCall = { sql: string; params: unknown[] }

function createRecoveryDb(users: RecoveryUser[], options: { excludeFutureWhenUpperBounded?: boolean } = {}) {
  const calls: PreparedCall[] = []
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
            && sql.includes("datetime(u.created_at) <= datetime('now')")
            ? []
            : users
          return { results: results as T[] }
        },
      }
    },
  }
}
