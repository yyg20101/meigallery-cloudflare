import { describe, it, expect } from 'vitest'
import {
  getEffectiveRankFromRecords,
  isMembershipExpired,
  hasAccessToRank,
  type MembershipRecord,
} from './membership'

describe('getEffectiveRankFromRecords', () => {
  const now = new Date('2026-06-15T12:00:00Z')

  it('无会员返回 0', () => {
    expect(getEffectiveRankFromRecords([], now)).toBe(0)
  })

  it('有一个有效 VIP 返回 10', () => {
    const memberships: MembershipRecord[] = [
      { levelRank: 10, startsAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-31T23:59:59Z' },
    ]
    expect(getEffectiveRankFromRecords(memberships, now)).toBe(10)
  })

  it('多个有效会员返回最高 rank', () => {
    const memberships: MembershipRecord[] = [
      { levelRank: 10, startsAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-31T23:59:59Z' },
      { levelRank: 20, startsAt: '2026-06-01T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z' },
    ]
    expect(getEffectiveRankFromRecords(memberships, now)).toBe(20)
  })

  it('已过期的会员不计入', () => {
    const memberships: MembershipRecord[] = [
      { levelRank: 20, startsAt: '2025-01-01T00:00:00Z', expiresAt: '2025-12-31T23:59:59Z' },
      { levelRank: 10, startsAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-31T23:59:59Z' },
    ]
    expect(getEffectiveRankFromRecords(memberships, now)).toBe(10)
  })

  it('尚未开始的会员不计入', () => {
    const memberships: MembershipRecord[] = [
      { levelRank: 20, startsAt: '2027-01-01T00:00:00Z', expiresAt: '2027-12-31T23:59:59Z' },
    ]
    expect(getEffectiveRankFromRecords(memberships, now)).toBe(0)
  })

  it('恰好在到期时间点视为过期', () => {
    const memberships: MembershipRecord[] = [
      { levelRank: 10, startsAt: '2026-01-01T00:00:00Z', expiresAt: '2026-06-15T12:00:00Z' },
    ]
    expect(getEffectiveRankFromRecords(memberships, now)).toBe(0)
  })

  it('恰好在开始时间点视为有效', () => {
    const memberships: MembershipRecord[] = [
      { levelRank: 10, startsAt: '2026-06-15T12:00:00Z', expiresAt: '2026-12-31T23:59:59Z' },
    ]
    expect(getEffectiveRankFromRecords(memberships, now)).toBe(10)
  })
})

describe('isMembershipExpired', () => {
  it('过期返回 true', () => {
    expect(isMembershipExpired('2025-01-01T00:00:00Z', new Date('2026-01-01T00:00:00Z'))).toBe(true)
  })

  it('未过期返回 false', () => {
    expect(isMembershipExpired('2027-01-01T00:00:00Z', new Date('2026-01-01T00:00:00Z'))).toBe(false)
  })

  it('恰好到期返回 true', () => {
    expect(isMembershipExpired('2026-01-01T00:00:00Z', new Date('2026-01-01T00:00:00Z'))).toBe(true)
  })
})

describe('hasAccessToRank', () => {
  it('requiredRank=0 所有用户可访问', () => {
    expect(hasAccessToRank(0, 0)).toBe(true)
    expect(hasAccessToRank(10, 0)).toBe(true)
  })

  it('用户 rank >= required 可访问', () => {
    expect(hasAccessToRank(20, 10)).toBe(true)
    expect(hasAccessToRank(10, 10)).toBe(true)
  })

  it('用户 rank < required 不可访问', () => {
    expect(hasAccessToRank(0, 10)).toBe(false)
    expect(hasAccessToRank(10, 20)).toBe(false)
  })
})
