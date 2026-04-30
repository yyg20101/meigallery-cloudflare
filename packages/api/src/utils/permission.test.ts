/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect, vi } from 'vitest'
import { getUserEffectiveRank, checkMediaAccess } from './permission'

function createMockDb(firstResult: unknown) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(firstResult),
        run: vi.fn().mockResolvedValue({}),
      }),
    }),
  } as unknown as D1Database
}

describe('getUserEffectiveRank', () => {
  it('有有效会员返回最高 rank', async () => {
    const db = createMockDb({ max_rank: 20 })
    const rank = await getUserEffectiveRank(db, 'usr_123')
    expect(rank).toBe(20)
  })

  it('无有效会员返回 0', async () => {
    const db = createMockDb({ max_rank: null })
    const rank = await getUserEffectiveRank(db, 'usr_123')
    expect(rank).toBe(0)
  })

  it('查询返回 null 返回 0', async () => {
    const db = createMockDb(null)
    const rank = await getUserEffectiveRank(db, 'usr_123')
    expect(rank).toBe(0)
  })
})

describe('checkMediaAccess', () => {
  it('requiredRank=0 直接通过', async () => {
    const db = createMockDb(null)
    expect(await checkMediaAccess(db, 'usr_123', 0)).toBe(true)
  })

  it('用户 rank >= required 通过', async () => {
    const db = createMockDb({ max_rank: 20 })
    expect(await checkMediaAccess(db, 'usr_123', 10)).toBe(true)
  })

  it('用户 rank < required 拒绝', async () => {
    const db = createMockDb({ max_rank: 10 })
    expect(await checkMediaAccess(db, 'usr_123', 20)).toBe(false)
  })

  it('无会员访问受保护内容拒绝', async () => {
    const db = createMockDb({ max_rank: null })
    expect(await checkMediaAccess(db, 'usr_123', 10)).toBe(false)
  })
})
