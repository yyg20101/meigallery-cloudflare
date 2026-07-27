export interface AttributionUsageInputs {
  factCount: number
  deliveryCount: number
  browserDeliveryCount: number
  serverDeliveryCount: number
  adapterAttemptCount: number
  queueAttemptCount: number
  terminalServerDeliveryCount: number
  providerReceiptCount: number
  workflowStepCount: number
}

export const FREE_SAFETY_LIMITS = {
  workerRequests: 70_000,
  queueOperations: 7_000,
  d1RowsRead: 3_500_000,
  d1RowsWritten: 70_000,
  workflowSteps: 2_100,
  serverConversions: 2_000,
} as const

export type AttributionUsageMetric = {
  value: number
  safetyLimit: number
  ratio: number
  warning: boolean
}

/**
 * 按项目当前读写路径估算 Cloudflare 消耗。该结果用于内部预警，不能替代 Cloudflare 账单。
 */
export function estimateAttributionUsage(inputs: AttributionUsageInputs) {
  const values = {
    workerRequests: inputs.factCount + inputs.adapterAttemptCount,
    queueOperations: inputs.serverDeliveryCount + inputs.queueAttemptCount + inputs.adapterAttemptCount,
    d1RowsRead: inputs.factCount * 4
      + inputs.serverDeliveryCount * 2
      + inputs.adapterAttemptCount * 4
      + inputs.providerReceiptCount,
    d1RowsWritten: inputs.factCount
      + inputs.deliveryCount
      + inputs.providerReceiptCount
      + inputs.serverDeliveryCount * 2
      + inputs.queueAttemptCount
      + inputs.adapterAttemptCount
      + inputs.terminalServerDeliveryCount,
    workflowSteps: inputs.workflowStepCount,
    serverConversions: inputs.serverDeliveryCount,
  }

  return {
    note: '项目内部估算，依据当前归因实现的事实、投递、队列和回执路径计算；Cloudflare 控制台数据仍是最终账单口径。',
    metrics: {
      workerRequests: metric(values.workerRequests, FREE_SAFETY_LIMITS.workerRequests),
      queueOperations: metric(values.queueOperations, FREE_SAFETY_LIMITS.queueOperations),
      d1RowsRead: metric(values.d1RowsRead, FREE_SAFETY_LIMITS.d1RowsRead),
      d1RowsWritten: metric(values.d1RowsWritten, FREE_SAFETY_LIMITS.d1RowsWritten),
      workflowSteps: metric(values.workflowSteps, FREE_SAFETY_LIMITS.workflowSteps),
      serverConversions: metric(values.serverConversions, FREE_SAFETY_LIMITS.serverConversions),
    },
  }
}

function metric(value: number, safetyLimit: number): AttributionUsageMetric {
  const normalized = nonNegativeInteger(value)
  return {
    value: normalized,
    safetyLimit,
    ratio: Math.round((normalized / safetyLimit) * 10_000) / 10_000,
    warning: normalized >= safetyLimit,
  }
}

function nonNegativeInteger(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
