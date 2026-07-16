import type {
  AnalyticsConsentState,
  MarketingConsentDecisionSource,
  MarketingConsentPolicyMode,
} from '@meigallery/shared'
import { canTrackMarketing as isMarketingTrackingAllowed, normalizeMarketingConsent } from '~/utils/marketingConsent'

type MarketingConsentResponse = {
  state?: unknown
  policyMode?: unknown
  decisionSource?: unknown
  requiresChoice?: unknown
  policyVersion?: unknown
}

export function useMarketingConsent() {
  const { api } = useApi()
  const state = useState<AnalyticsConsentState>('marketing-consent-state', () => 'limited')
  const pending = useState<boolean>('marketing-consent-pending', () => false)
  const policyMode = useState<MarketingConsentPolicyMode>('marketing-consent-policy-mode', () => 'prior_consent')
  const decisionSource = useState<MarketingConsentDecisionSource>('marketing-consent-decision-source', () => 'choice_required')
  const requiresChoice = useState<boolean>('marketing-consent-requires-choice', () => false)
  const policyVersion = useState<number>('marketing-consent-policy-version', () => 0)
  const canTrackMarketing = computed(() => isMarketingTrackingAllowed(state.value))

  async function refresh() {
    try {
      const response = await api<MarketingConsentResponse>('/api/marketing-consent')
      applyTrustedResponse(response)
    }
    catch (error) {
      applyFallbackState()
      throw error
    }
  }

  async function update(nextState: 'granted' | 'denied') {
    pending.value = true
    try {
      const response = await api<MarketingConsentResponse>('/api/marketing-consent', {
        method: 'PUT',
        body: { state: nextState },
      })
      applyTrustedResponse(response)
    }
    catch (error) {
      applyFallbackState()
      throw error
    }
    finally {
      pending.value = false
    }
  }

  const grant = () => update('granted')
  const deny = () => update('denied')
  const reset = deny

  function applyTrustedResponse(response: MarketingConsentResponse) {
    state.value = trustedResponseState(response.state)
    policyMode.value = trustedPolicyMode(response.policyMode)
    decisionSource.value = trustedDecisionSource(response.decisionSource)
    requiresChoice.value = response.requiresChoice === true && state.value === 'limited'
    policyVersion.value = Number.isSafeInteger(response.policyVersion) && Number(response.policyVersion) > 0
      ? Number(response.policyVersion)
      : 0
  }

  function applyFallbackState() {
    state.value = 'limited'
    policyMode.value = 'prior_consent'
    decisionSource.value = 'choice_required'
    requiresChoice.value = false
    policyVersion.value = 0
  }

  return {
    state,
    pending,
    policyMode,
    decisionSource,
    requiresChoice,
    policyVersion,
    refresh,
    grant,
    deny,
    reset,
    canTrackMarketing,
  }
}

function trustedResponseState(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied'
    ? normalizeMarketingConsent(value)
    : 'limited'
}

function trustedPolicyMode(value: unknown): MarketingConsentPolicyMode {
  return value === 'notice_opt_out' || value === 'disabled' ? value : 'prior_consent'
}

function trustedDecisionSource(value: unknown): MarketingConsentDecisionSource {
  return value === 'explicit'
    || value === 'regional_default'
    || value === 'gpc'
    || value === 'disabled'
    || value === 'request_limit'
    ? value
    : 'choice_required'
}
