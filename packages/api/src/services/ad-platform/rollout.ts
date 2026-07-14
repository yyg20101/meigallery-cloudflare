import type { AdPlatformRolloutPercentage } from '@meigallery/shared'

export interface AdPlatformRolloutDecision {
  targetPercentage: AdPlatformRolloutPercentage
  effectivePercentage: AdPlatformRolloutPercentage
  bucket: number | null
  included: boolean
  reason: 'included' | 'rollout_excluded' | 'circuit_open' | 'missing_stable_id'
}

export async function adPlatformRolloutBucket(namespace: string, stableId: string): Promise<number> {
  const normalizedNamespace = namespace.trim()
  const normalizedStableId = stableId.trim()
  if (!normalizedNamespace || !normalizedStableId) throw new Error('AD_PLATFORM_STABLE_ID_MISSING')
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${normalizedNamespace}\n${normalizedStableId}`),
  )
  return new DataView(digest).getUint32(0, false) % 100
}

export async function decideAdPlatformRollout(input: {
  namespace: string
  targetPercentage: AdPlatformRolloutPercentage
  stableId: string
  circuitOpen: boolean
}): Promise<AdPlatformRolloutDecision> {
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

  const bucket = await adPlatformRolloutBucket(input.namespace, stableId)
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
