import { describe, expect, it } from 'vitest'
import {
  decideMetaCapiRollout,
  evaluateRolloutPromotion,
  normalizeMetaCapiRollout,
  rolloutBucket,
} from './meta-capi-rollout'

describe('Meta CAPI 稳定 rollout', () => {
  it.each([
    [undefined], [null], ['10'], [NaN], [Infinity], [-1], [1], [20], [101], [{}], [[]],
  ])('非法配置 %j 保守归一化为 0', (value) => {
    expect(normalizeMetaCapiRollout(value)).toBe(0)
  })

  it.each([0, 10, 50, 100] as const)('保留合法离散档位 %i', (value) => {
    expect(normalizeMetaCapiRollout(value)).toBe(value)
  })

  it('按带版本前缀的 SHA-256 前 4 bytes unsigned big-endian 稳定分桶', async () => {
    const stableId = 'visitor_stable_42'
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`meta-capi-rollout-v1\n${stableId}`),
    )
    const expected = new DataView(digest).getUint32(0, false) % 100

    await expect(rolloutBucket(`  ${stableId}  `)).resolves.toBe(expected)
    await expect(rolloutBucket(stableId)).resolves.toBe(expected)
  })

  it('空 stable ID 不进入 hash', async () => {
    await expect(rolloutBucket('   ')).rejects.toThrow('META_CAPI_STABLE_ID_MISSING')
  })

  it('0 全排除、100 全包含，其他档位严格使用 bucket < percentage', async () => {
    const zero = await decideMetaCapiRollout({ targetPercentage: 0, stableId: 'visitor_a', circuitOpen: false })
    const full = await decideMetaCapiRollout({ targetPercentage: 100, stableId: 'visitor_a', circuitOpen: false })
    expect(zero).toMatchObject({ effectivePercentage: 0, included: false, reason: 'rollout_excluded' })
    expect(full).toMatchObject({ effectivePercentage: 100, included: true, reason: 'included' })

    for (const percentage of [10, 50] as const) {
      const decision = await decideMetaCapiRollout({ targetPercentage: percentage, stableId: `visitor_${percentage}`, circuitOpen: false })
      expect(decision.included).toBe(decision.bucket! < percentage)
    }
  })

  it('先处理缺失 stable ID，再处理 circuit，且 circuit effective=0', async () => {
    await expect(decideMetaCapiRollout({
      targetPercentage: 100,
      stableId: '   ',
      circuitOpen: true,
    })).resolves.toEqual({
      targetPercentage: 100,
      effectivePercentage: 0,
      bucket: null,
      included: false,
      reason: 'missing_stable_id',
    })

    const circuit = await decideMetaCapiRollout({
      targetPercentage: 100,
      stableId: 'visitor_circuit',
      circuitOpen: true,
    })
    expect(circuit).toMatchObject({
      targetPercentage: 100,
      effectivePercentage: 0,
      included: false,
      reason: 'circuit_open',
    })
    expect(circuit.bucket).toBeTypeOf('number')
  })
})

describe('Meta CAPI rollout 晋级判断', () => {
  const healthy = {
    sent: 100,
    failed: 0,
    permissionErrors: 0,
    retryExhausted: 0,
    stalePending: 0,
    criticalQualityDiagnostics: 0,
  }

  it('允许同值与任意降级，拒绝跳级', () => {
    expect(evaluateRolloutPromotion({ from: 100, to: 10, ...healthy })).toEqual({
      allowed: true,
      requiresOverrideReason: false,
      blockers: [],
    })
    expect(evaluateRolloutPromotion({ from: 10, to: 10, ...healthy }).allowed).toBe(true)
    expect(evaluateRolloutPromotion({ from: 0, to: 50, ...healthy })).toMatchObject({
      allowed: false,
      requiresOverrideReason: false,
      blockers: ['non_adjacent_promotion'],
    })
  })

  it('10 -> 50 要求至少 10 次、整数成功率 >=98% 且无权限/DLQ/stale pending', () => {
    expect(evaluateRolloutPromotion({ from: 10, to: 50, ...healthy, sent: 9 })).toMatchObject({
      allowed: false,
      requiresOverrideReason: true,
      blockers: ['insufficient_attempts'],
    })
    expect(evaluateRolloutPromotion({ from: 10, to: 50, ...healthy, sent: 98, failed: 2 }).allowed).toBe(true)
    expect(evaluateRolloutPromotion({
      from: 10,
      to: 50,
      ...healthy,
      sent: 97,
      failed: 3,
      permissionErrors: 1,
      retryExhausted: 1,
      stalePending: 1,
    }).blockers).toEqual([
      'success_rate_below_98',
      'permission_errors_present',
      'retry_exhausted_present',
      'stale_pending_present',
    ])
  })

  it('50 -> 100 要求至少 50 次、整数成功率 >=99% 且无关键质量诊断', () => {
    expect(evaluateRolloutPromotion({ from: 50, to: 100, ...healthy, sent: 49 })).toMatchObject({
      allowed: false,
      requiresOverrideReason: true,
      blockers: ['insufficient_attempts'],
    })
    expect(evaluateRolloutPromotion({ from: 50, to: 100, ...healthy, sent: 99, failed: 1 }).allowed).toBe(true)
    expect(evaluateRolloutPromotion({
      from: 50,
      to: 100,
      ...healthy,
      criticalQualityDiagnostics: 1,
    }).blockers).toEqual(['critical_quality_diagnostics_present'])
  })
})
