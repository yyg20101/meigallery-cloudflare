export type MetaCapiRolloutPercentage = 0 | 10 | 50 | 100

export interface MetaCapiRolloutDecision {
  targetPercentage: MetaCapiRolloutPercentage
  effectivePercentage: MetaCapiRolloutPercentage
  bucket: number | null
  included: boolean
  reason: 'included' | 'rollout_excluded' | 'circuit_open' | 'missing_stable_id'
}

export interface RolloutPromotionInput {
  from: MetaCapiRolloutPercentage
  to: MetaCapiRolloutPercentage
  sent: number
  failed: number
  permissionErrors: number
  retryExhausted: number
  stalePending: number
  criticalQualityDiagnostics: number
}

const ROLLOUT_PERCENTAGES = new Set<unknown>([0, 10, 50, 100])
const NEXT_PERCENTAGE: Partial<Record<MetaCapiRolloutPercentage, MetaCapiRolloutPercentage>> = {
  0: 10,
  10: 50,
  50: 100,
}

export function normalizeMetaCapiRollout(value: unknown): MetaCapiRolloutPercentage {
  return typeof value === 'number' && ROLLOUT_PERCENTAGES.has(value)
    ? value as MetaCapiRolloutPercentage
    : 0
}

export async function rolloutBucket(stableId: string): Promise<number> {
  const normalized = stableId.trim()
  if (!normalized) throw new Error('META_CAPI_STABLE_ID_MISSING')
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`meta-capi-rollout-v1\n${normalized}`),
  )
  return new DataView(digest).getUint32(0, false) % 100
}

export async function decideMetaCapiRollout(input: {
  targetPercentage: MetaCapiRolloutPercentage
  stableId: string
  circuitOpen: boolean
}): Promise<MetaCapiRolloutDecision> {
  const stableId = input.stableId.trim()
  if (!stableId) {
    return {
      targetPercentage: input.targetPercentage,
      effectivePercentage: input.circuitOpen ? 0 : input.targetPercentage,
      bucket: null,
      included: false,
      reason: 'missing_stable_id',
    }
  }

  const bucket = await rolloutBucket(stableId)
  if (input.circuitOpen) {
    return {
      targetPercentage: input.targetPercentage,
      effectivePercentage: 0,
      bucket,
      included: false,
      reason: 'circuit_open',
    }
  }

  const included = bucket < input.targetPercentage
  return {
    targetPercentage: input.targetPercentage,
    effectivePercentage: input.targetPercentage,
    bucket,
    included,
    reason: included ? 'included' : 'rollout_excluded',
  }
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
