import type { AttributionProvider } from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import { sha256Hex } from '../security/digest'

export interface ServerRolloutInput {
  provider: AttributionProvider
  connectionId: string
  versionId: string
  externalEventId: string
  effectivePercentage: 0 | 10 | 50 | 100
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const PERCENTAGES = new Set([0, 10, 50, 100])

export async function isServerRolloutEligible(
  input: ServerRolloutInput,
): Promise<boolean> {
  if (
    !PROVIDERS.has(input.provider)
    || !isIdentifier(input.connectionId)
    || !isIdentifier(input.versionId)
    || !isIdentifier(input.externalEventId)
    || !PERCENTAGES.has(input.effectivePercentage)
  ) {
    throw new AttributionDomainError('ATTRIBUTION_FACT_INVALID')
  }
  if (input.effectivePercentage === 0) return false
  if (input.effectivePercentage === 100) return true
  const digest = await sha256Hex([
    'delivery-bucket:v1',
    input.provider,
    input.connectionId,
    input.versionId,
    input.externalEventId,
  ].join(':'))
  return Number.parseInt(digest.slice(0, 8), 16) % 100
    < input.effectivePercentage
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}
