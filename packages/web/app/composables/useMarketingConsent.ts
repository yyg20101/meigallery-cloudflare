import type { AnalyticsConsentState } from '@meigallery/shared'
import { canTrackMarketing as isMarketingTrackingAllowed, normalizeMarketingConsent } from '~/utils/marketingConsent'

export function useMarketingConsent() {
  const config = useRuntimeConfig()
  const { metaTrackingMode } = useSiteSettings()
  const cookie = useCookie<AnalyticsConsentState>('mei_marketing_consent', {
    default: () => 'limited',
    sameSite: 'lax',
    secure: config.public.appEnv === 'production',
    maxAge: 15_552_000,
  })
  const state = computed(() => normalizeMarketingConsent(cookie.value))
  const canTrackMarketing = computed(() => isMarketingTrackingAllowed(state.value, metaTrackingMode.value))
  const grant = () => { cookie.value = 'granted' }
  const deny = () => { cookie.value = 'denied' }
  const reset = () => { cookie.value = 'limited' }

  return { state, grant, deny, reset, canTrackMarketing }
}
