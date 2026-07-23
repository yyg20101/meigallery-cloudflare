import type { AnalyticsSourceChannel } from '@meigallery/shared'

export function sourceChannelFromUtmMedium(value: unknown): AnalyticsSourceChannel {
  const medium = String(value ?? '').trim().toLowerCase()
  if (['ad', 'ads', 'paid', 'cpc', 'paid_social', 'paid-social', 'paidsocial'].includes(medium)) return 'ad'
  if (medium === 'social' || medium === 'sns') return 'social'
  if (medium === 'search' || medium === 'seo' || medium === 'organic_search') return 'search'
  if (medium === 'direct') return 'direct'
  if (medium === 'internal') return 'internal'
  return 'referral'
}
