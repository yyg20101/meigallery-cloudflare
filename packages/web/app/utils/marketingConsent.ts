import type { AnalyticsConsentState, MetaTrackingMode } from '@meigallery/shared'

export function normalizeMarketingConsent(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied' ? value : 'limited'
}

export function canTrackMarketing(consent: AnalyticsConsentState, mode: MetaTrackingMode) {
  return consent === 'granted' && (mode === 'test' || mode === 'production')
}
