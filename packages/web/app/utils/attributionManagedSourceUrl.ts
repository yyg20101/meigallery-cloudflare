import type {
  AttributionManagedSourceView,
} from '~/types/attribution-admin'

export function buildAttributionManagedSourceUrl(
  origin: string,
  source: AttributionManagedSourceView,
  proof: string,
): string {
  const normalizedProof = proof.trim()
  if (!normalizedProof) {
    throw new Error('ATTRIBUTION_MANAGED_SOURCE_PROOF_REQUIRED')
  }
  const url = new URL('/', origin)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('ATTRIBUTION_MANAGED_SOURCE_ORIGIN_INVALID')
  }
  url.searchParams.set('mg_proof', normalizedProof)
  url.searchParams.set('utm_source', source.provider)
  url.searchParams.set('utm_medium', source.medium)
  url.searchParams.set('utm_campaign', source.campaign)
  url.searchParams.set('utm_content', source.content)
  return url.toString()
}
