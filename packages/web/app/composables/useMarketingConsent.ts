import type { AnalyticsConsentState } from '@meigallery/shared'
import { canTrackMarketing as isMarketingTrackingAllowed, normalizeMarketingConsent } from '~/utils/marketingConsent'

export function useMarketingConsent() {
  const { api } = useApi()
  const state = useState<AnalyticsConsentState>('marketing-consent-state', () => 'limited')
  const pending = useState<boolean>('marketing-consent-pending', () => false)
  const canTrackMarketing = computed(() => isMarketingTrackingAllowed(state.value))

  async function refresh() {
    try {
      const response = await api<{ state?: unknown }>('/api/marketing-consent')
      state.value = trustedResponseState(response.state)
    }
    catch (error) {
      state.value = 'limited'
      throw error
    }
  }

  async function update(nextState: 'granted' | 'denied') {
    pending.value = true
    try {
      const response = await api<{ state?: unknown }>('/api/marketing-consent', {
        method: 'PUT',
        body: { state: nextState },
      })
      state.value = trustedResponseState(response.state)
    }
    catch (error) {
      state.value = 'limited'
      throw error
    }
    finally {
      pending.value = false
    }
  }

  const grant = () => update('granted')
  const deny = () => update('denied')
  const reset = deny

  return { state, pending, refresh, grant, deny, reset, canTrackMarketing }
}

function trustedResponseState(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied'
    ? normalizeMarketingConsent(value)
    : 'limited'
}
