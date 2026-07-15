import { describe, expect, it } from 'vitest'
import { estimateAttributionUsage, FREE_SAFETY_LIMITS } from './usage-estimator'

describe('归因 Cloudflare Free 容量内部估算', () => {
  it('安全线固定为官方 Free 日额度的 70%', () => {
    expect(FREE_SAFETY_LIMITS).toEqual({
      workerRequests: 70_000,
      queueOperations: 7_000,
      d1RowsRead: 3_500_000,
      d1RowsWritten: 70_000,
      workflowSteps: 2_100,
      serverConversions: 2_000,
    })
  })

  it('按事实、Delivery、Queue attempt、Receipt 和 Workflow step 估算，不伪装官方账单', () => {
    const result = estimateAttributionUsage({
      factCount: 100,
      deliveryCount: 180,
      browserAttemptCount: 80,
      serverDeliveryCount: 100,
      adapterAttemptCount: 110,
      queueAttemptCount: 100,
      terminalServerDeliveryCount: 90,
      providerReceiptCount: 100,
      workflowStepCount: 12,
    })

    expect(result.note).toContain('项目内部估算')
    expect(result.metrics).toMatchObject({
      workerRequests: { value: 290, safetyLimit: 70_000, warning: false },
      queueOperations: { value: 310, safetyLimit: 7_000, warning: false },
      d1RowsRead: { value: 1_140, safetyLimit: 3_500_000, warning: false },
      d1RowsWritten: { value: 880, safetyLimit: 70_000, warning: false },
      workflowSteps: { value: 12, safetyLimit: 2_100, warning: false },
      serverConversions: { value: 100, safetyLimit: 2_000, warning: false },
    })
  })

  it('达到安全线时预警但不自动切换投递路径', () => {
    const result = estimateAttributionUsage({
      factCount: 70_000,
      deliveryCount: 0,
      browserAttemptCount: 0,
      serverDeliveryCount: 2_000,
      adapterAttemptCount: 0,
      queueAttemptCount: 5_000,
      terminalServerDeliveryCount: 0,
      providerReceiptCount: 0,
      workflowStepCount: 2_100,
    })

    expect(result.metrics.workerRequests.warning).toBe(true)
    expect(result.metrics.queueOperations.warning).toBe(true)
    expect(result.metrics.workflowSteps.warning).toBe(true)
    expect(result.metrics.serverConversions.warning).toBe(true)
    expect(result).not.toHaveProperty('fallbackProvider')
  })
})
