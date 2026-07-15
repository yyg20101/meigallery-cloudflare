import type { AnalyticsConsentState } from '@meigallery/shared'

export function normalizeMarketingConsent(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied' ? value : 'limited'
}

export function canTrackMarketing(consent: AnalyticsConsentState) {
  return consent === 'granted'
}
