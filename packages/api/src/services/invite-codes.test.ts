import { describe, expect, it } from 'vitest'
import {
  createInviteCode,
  consumeInviteCodeForRegistration,
  disableInviteCode,
  hashInviteCode,
  recordFirstMembershipGrantConversion,
  verifyInviteCodeStatus,
} from './invite-codes'

interface PreparedCall {
  sql: string
  params: unknown[]
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
} = {}) {
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
        async first<T>() {
          return (handlers.first?.(sql, call.params) ?? null) as T | null
        },
        async all<T>() {
          return { results: (handlers.all?.(sql, call.params) ?? []) as T[] }
        },
        async run() {
          return handlers.run?.(sql, call.params) ?? { meta: { changes: 1 } }
        },
      }
    },
  }
}

describe('invite-codes service', () => {
  it('创建邀请码时只保存 hash 和 display code', async () => {
    const db = createDb()
    const result = await createInviteCode(db as unknown as D1Database, {
      name: '夏季活动',
      channel: 'Telegram',
      code: 'summer-001',
      maxUses: 20,
      createdBy: 1,
    })

    expect(result.code).toBe('SUMMER-001')
    expect(result.displayCode).toBe('SUMM...-001')
    const insert = db.calls.find(call => call.sql.includes('INSERT INTO invite_codes'))
    expect(insert?.params[1]).toMatch(/^[a-f0-9]{64}$/)
    expect(insert?.params).not.toContain('SUMMER-001')
    expect(insert?.params).toContain('SUMM...-001')
  })

  it('公开校验覆盖有效、禁用、过期、次数耗尽和不存在', async () => {
    const activeHash = await hashInviteCode('ACTIVE1')
    const disabledHash = await hashInviteCode('DISABLED1')
    const expiredHash = await hashInviteCode('EXPIRED1')
    const usedHash = await hashInviteCode('USEDUP1')
    const db = createDb({
      first: (_sql, params) => {
        const hash = params[0]
        if (hash === activeHash) return { id: 'inv_1', name: '活动', channel: 'manual', status: 'active', max_uses: null, used_count: 0, expires_at: null }
        if (hash === disabledHash) return { id: 'inv_2', name: '活动', channel: 'manual', status: 'disabled', max_uses: null, used_count: 0, expires_at: null }
        if (hash === expiredHash) return { id: 'inv_3', name: '活动', channel: 'manual', status: 'active', max_uses: null, used_count: 0, expires_at: '2026-01-01T00:00:00.000Z' }
        if (hash === usedHash) return { id: 'inv_4', name: '活动', channel: 'manual', status: 'active', max_uses: 1, used_count: 1, expires_at: null }
        return null
      },
    })
    const now = new Date('2026-06-07T00:00:00.000Z')

    expect(await verifyInviteCodeStatus(db as unknown as D1Database, 'ACTIVE1', now)).toMatchObject({ valid: true, inviteCodeId: 'inv_1' })
    expect(await verifyInviteCodeStatus(db as unknown as D1Database, 'DISABLED1', now)).toEqual({ valid: false, reason: 'DISABLED' })
    expect(await verifyInviteCodeStatus(db as unknown as D1Database, 'EXPIRED1', now)).toEqual({ valid: false, reason: 'EXPIRED' })
    expect(await verifyInviteCodeStatus(db as unknown as D1Database, 'USEDUP1', now)).toEqual({ valid: false, reason: 'USAGE_LIMIT_REACHED' })
    expect(await verifyInviteCodeStatus(db as unknown as D1Database, 'MISSING1', now)).toEqual({ valid: false, reason: 'NOT_FOUND' })
  })

  it('注册消费写入 visitor/session、注册事实并增加 used_count', async () => {
    const codeHash = await hashInviteCode('ACTIVE1')
    const db = createDb({
      first: (_sql, params) => params[0] === codeHash
        ? { id: 'inv_1', name: '活动', channel: 'telegram', status: 'active', max_uses: 10, used_count: 2, expires_at: null }
        : null,
    })

    const result = await consumeInviteCodeForRegistration(db as unknown as D1Database, {
      code: 'ACTIVE1',
      invitedUserId: 9,
      visitorId: 'visitor_abcdef',
      sessionId: 'session_abcdef',
      landingPath: '/register?token=bad',
    }, new Date('2026-06-07T00:00:00.000Z'))

    expect(result).toMatchObject({ valid: true, inviteCodeId: 'inv_1', visitorId: 'visitor_abcdef', sessionId: 'session_abcdef' })
    expect(result.registered).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_visitors'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_sessions'))).toBe(true)
    const registration = db.calls.find(call => call.sql.includes('INSERT OR IGNORE INTO invite_registrations'))
    expect(registration?.params).toContain('/')
    expect(db.calls.some(call => call.sql.includes('UPDATE invite_codes SET used_count = used_count + 1'))).toBe(true)
  })

  it('重复注册绑定不会再次增加 used_count', async () => {
    const codeHash = await hashInviteCode('ACTIVE1')
    const db = createDb({
      first: (_sql, params) => params[0] === codeHash
        ? { id: 'inv_1', name: '活动', channel: 'telegram', status: 'active', max_uses: 10, used_count: 2, expires_at: null }
        : null,
      run: sql => sql.includes('INSERT OR IGNORE INTO invite_registrations')
        ? { meta: { changes: 0 } }
        : { meta: { changes: 1 } },
    })

    const result = await consumeInviteCodeForRegistration(db as unknown as D1Database, {
      code: 'ACTIVE1',
      invitedUserId: 9,
      visitorId: 'visitor_abcdef',
      sessionId: 'session_abcdef',
    }, new Date('2026-06-07T00:00:00.000Z'))

    expect(result).toMatchObject({ valid: true, registered: false })
    expect(db.calls.some(call => call.sql.includes('UPDATE invite_codes SET used_count = used_count + 1'))).toBe(false)
  })

  it('禁用邀请码复用更新流程', async () => {
    const db = createDb({
      first: () => ({
        id: 'inv_1',
        display_code: 'ABCD...1234',
        name: '活动',
        channel: 'manual',
        inviter_user_id: null,
        status: 'active',
        max_uses: null,
        used_count: 0,
        expires_at: null,
        created_by: 1,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
        note: '',
      }),
    })

    const result = await disableInviteCode(db as unknown as D1Database, 'inv_1')
    expect(result.after.status).toBe('disabled')
    expect(db.calls.some(call => call.sql.includes('UPDATE invite_codes'))).toBe(true)
  })

  it('首次会员发放只在 rank 大于 0 时回填', async () => {
    const db = createDb({
      run: () => ({ meta: { changes: 1 } }),
    })

    expect(await recordFirstMembershipGrantConversion(db as unknown as D1Database, { invitedUserId: 8, rank: 0 })).toEqual({ updated: false })
    expect(await recordFirstMembershipGrantConversion(db as unknown as D1Database, { invitedUserId: 8, rank: 10, grantedAt: '2026-06-07T00:00:00.000Z' })).toEqual({ updated: true })
    const update = db.calls.find(call => call.sql.includes('UPDATE invite_registrations'))
    expect(update?.params).toEqual(['2026-06-07T00:00:00.000Z', 10, 8])
  })
})
