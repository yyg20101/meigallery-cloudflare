import { describe, expect, it } from 'vitest'
import { isHomeAdActive, normalizeHomeAdScheduleRange, normalizeHomeAdScheduleValue } from './home-ad-schedule'

describe('首页广告排期设置', () => {
  it('将有效时间归一化为 ISO 字符串', () => {
    expect(normalizeHomeAdScheduleValue('2026-06-01T08:30:00+08:00')).toBe('2026-06-01T00:30:00.000Z')
    expect(normalizeHomeAdScheduleValue('')).toBe('')
    expect(normalizeHomeAdScheduleValue('not-a-date')).toBe('')
    expect(normalizeHomeAdScheduleValue(null)).toBe('')
  })

  it('拒绝结束时间不晚于开始时间的排期', () => {
    expect(() => normalizeHomeAdScheduleRange(
      '2026-06-01T08:00:00+08:00',
      '2026-06-01T08:00:00+08:00',
    )).toThrow('首页广告结束时间必须晚于开始时间')
  })

  it('根据开关和时间窗判断广告是否生效', () => {
    const now = new Date('2026-06-01T12:00:00.000Z')

    expect(isHomeAdActive(true, '', '', now)).toBe(true)
    expect(isHomeAdActive('true', '2026-06-01T11:00:00.000Z', '2026-06-01T13:00:00.000Z', now)).toBe(true)
    expect(isHomeAdActive(true, '2026-06-01T13:00:00.000Z', '', now)).toBe(false)
    expect(isHomeAdActive(true, '', '2026-06-01T12:00:00.000Z', now)).toBe(false)
    expect(isHomeAdActive(true, 'not-a-date', '', now)).toBe(false)
    expect(isHomeAdActive(false, '', '', now)).toBe(false)
  })
})
