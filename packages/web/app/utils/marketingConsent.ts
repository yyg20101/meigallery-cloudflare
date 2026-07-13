import type { AdPlatformTrackingMode, AnalyticsConsentState } from '@meigallery/shared'

export function normalizeMarketingConsent(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied' ? value : 'limited'
}

export function canTrackMarketing(consent: AnalyticsConsentState, mode: AdPlatformTrackingMode) {
  return consent === 'granted' && (mode === 'test' || mode === 'production')
}
