import { describe, expect, it } from 'vitest'
import {
  allRuntimePromotionHealthy,
  type RuntimePromotionHealth,
} from './runtime-policy-commands'

describe('运行策略健康判定', () => {
  it('四项全部健康时才允许提升', () => {
    const healthy: RuntimePromotionHealth = {
      activeSnapshotReadable: true,
      credentialDecryptable: true,
      queueBound: true,
      adapterConstructable: true,
    }
    expect(allRuntimePromotionHealthy(healthy)).toBe(true)

    for (const key of Object.keys(healthy) as (keyof RuntimePromotionHealth)[]) {
      expect(allRuntimePromotionHealthy({ ...healthy, [key]: false })).toBe(false)
    }
  })
})
