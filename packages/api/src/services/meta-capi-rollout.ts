import type { AdPlatformRolloutPercentage } from '@meigallery/shared'
import {
  adPlatformRolloutBucket,
  decideAdPlatformRollout,
  type AdPlatformRolloutDecision,
} from './ad-platform/rollout'

export type MetaCapiRolloutDecision = AdPlatformRolloutDecision

export interface RolloutPromotionInput {
  from: AdPlatformRolloutPercentage
  to: AdPlatformRolloutPercentage
  sent: number
  failed: number
  permissionErrors: number
  retryExhausted: number
  stalePending: number
  criticalQualityDiagnostics: number
}

const ROLLOUT_PERCENTAGES = new Set<unknown>([0, 10, 50, 100])
const NEXT_PERCENTAGE: Partial<Record<AdPlatformRolloutPercentage, AdPlatformRolloutPercentage>> = {
  0: 10,
  10: 50,
  50: 100,
}

export function normalizeMetaCapiRollout(value: unknown): AdPlatformRolloutPercentage {
  return typeof value === 'number' && ROLLOUT_PERCENTAGES.has(value)
    ? value as AdPlatformRolloutPercentage
    : 0
}

export async function rolloutBucket(stableId: string): Promise<number> {
  if (!stableId.trim()) throw new Error('META_CAPI_STABLE_ID_MISSING')
  return adPlatformRolloutBucket('meta-capi-rollout-v1', stableId)
}

export async function decideMetaCapiRollout(input: {
  targetPercentage: AdPlatformRolloutPercentage
  stableId: string
  circuitOpen: boolean
}): Promise<MetaCapiRolloutDecision> {
  return decideAdPlatformRollout({
    namespace: 'meta-capi-rollout-v1',
    ...input,
  })
}

export function evaluateRolloutPromotion(input: RolloutPromotionInput): {
  allowed: boolean
  requiresOverrideReason: boolean
  blockers: string[]
} {
  if (input.to <= input.from) {
    return { allowed: true, requiresOverrideReason: false, blockers: [] }
  }
  if (NEXT_PERCENTAGE[input.from] !== input.to) {
    return { allowed: false, requiresOverrideReason: false, blockers: ['non_adjacent_promotion'] }
  }
  if (input.from === 0) {
    return { allowed: true, requiresOverrideReason: false, blockers: [] }
  }

  const sent = count(input.sent)
  const failed = count(input.failed)
  const attempts = sent + failed
  const blockers: string[] = []
  const minimumAttempts = input.from === 10 ? 10 : 50
  const minimumSuccessPercent = input.from === 10 ? 98 : 99
  if (attempts < minimumAttempts) blockers.push('insufficient_attempts')
  else if (sent * 100 < attempts * minimumSuccessPercent) {
    blockers.push(`success_rate_below_${minimumSuccessPercent}`)
  }

  if (input.from === 10) {
    if (count(input.permissionErrors) > 0) blockers.push('permission_errors_present')
    if (count(input.retryExhausted) > 0) blockers.push('retry_exhausted_present')
    if (count(input.stalePending) > 0) blockers.push('stale_pending_present')
  }
  if (input.from === 50 && count(input.criticalQualityDiagnostics) > 0) {
    blockers.push('critical_quality_diagnostics_present')
  }

  return {
    allowed: blockers.length === 0,
    requiresOverrideReason: blockers.length > 0,
    blockers,
  }
}

function count(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}
