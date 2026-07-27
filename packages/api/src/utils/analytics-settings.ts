import { ANALYTICS_RETENTION } from '@meigallery/shared/constants'

export function normalizeAnalyticsSampleRate(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return ANALYTICS_RETENTION.DEFAULT_SAMPLE_RATE
  }
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error('分析采样率必须是 0 到 0.05 之间的数字')
  }
  return Math.min(rate, ANALYTICS_RETENTION.MAX_SAMPLE_RATE)
}

export function safeAnalyticsSampleRate(value: unknown) {
  try {
    return normalizeAnalyticsSampleRate(value)
  } catch {
    return ANALYTICS_RETENTION.DEFAULT_SAMPLE_RATE
  }
}
