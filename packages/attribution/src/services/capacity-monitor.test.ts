import { describe, expect, it } from 'vitest'
import {
  assessCapacity,
  capacityLevel,
  CLOUDFLARE_FREE_DAILY_LIMITS,
} from './capacity-monitor'

describe('账户级 Cloudflare Free 容量门禁', () => {
  it.each([
    [0.69, 'ok'],
    [0.7, 'warning'],
    [0.85, 'high'],
    [0.95, 'critical'],
  ] as const)('使用率 %s', (ratio, level) => {
    expect(capacityLevel(ratio)).toBe(level)
  })

  it('Queue 只使用一份账户级 10,000 operations 分母', () => {
    const result = assessCapacity(usage({
      queueOperations: 8_500,
    }))

    expect(CLOUDFLARE_FREE_DAILY_LIMITS.queueOperations).toBe(10_000)
    expect(result.metrics.queueOperations).toEqual({
      used: 8_500,
      limit: 10_000,
      ratio: 0.85,
      level: 'high',
    })
    expect(result.allowNonEssential).toBe(false)
    expect(result.allowServerEnqueue).toBe(true)
  })

  it('达到 95% 时暂停 Server enqueue，但不把事实伪装为成功', () => {
    const result = assessCapacity(usage({
      d1RowsWritten: 95_000,
    }))

    expect(result.level).toBe('critical')
    expect(result.allowNonEssential).toBe(false)
    expect(result.allowServerEnqueue).toBe(false)
  })

  it('拒绝消息数估算、按平台拆分和非 Cloudflare 实际用量来源', () => {
    expect(() => assessCapacity({
      ...usage(),
      source: 'message-estimate',
    } as never)).toThrow('ATTRIBUTION_CAPACITY_USAGE_INVALID')
    expect(() => assessCapacity({
      ...usage(),
      providerQueueOperations: {
        meta: 3_000,
        tiktok: 3_000,
        google: 3_000,
      },
    } as never)).toThrow('ATTRIBUTION_CAPACITY_USAGE_INVALID')
  })
})

function usage(
  overrides: Partial<ReturnType<typeof usageShape>> = {},
) {
  return {
    ...usageShape(),
    ...overrides,
  }
}

function usageShape() {
  return {
    schemaVersion: 1 as const,
    date: '2026-07-24',
    measuredAt: '2026-07-24T23:55:00.000Z',
    source: 'cloudflare-account-analytics' as const,
    workerRequests: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    queueOperations: 0,
  }
}
