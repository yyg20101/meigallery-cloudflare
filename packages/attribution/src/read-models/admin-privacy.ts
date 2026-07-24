import {
  readPrivacyPolicyStrict,
  type AttributionPrivacyDefaultMode,
} from '../services/privacy-policy'
import { AttributionDomainError } from '../domain/errors'

export type AdminAttributionPrivacyPolicyView =
  | {
      availability: 'available'
      defaultMode: AttributionPrivacyDefaultMode
      priorConsentCountryCodes: readonly string[]
      policyVersion: number
      updatedAt: string
    }
  | {
      availability: 'unavailable' | 'error'
      defaultMode: null
      priorConsentCountryCodes: readonly []
      policyVersion: null
      updatedAt: ''
    }

export async function readAdminAttributionPrivacyPolicy(
  db: D1Database,
): Promise<AdminAttributionPrivacyPolicyView> {
  let policy
  try {
    policy = await readPrivacyPolicyStrict(db)
  } catch (error) {
    return unavailablePrivacy(
      error instanceof AttributionDomainError
        && error.code === 'ATTRIBUTION_COMMAND_FAILED'
        ? 'unavailable'
        : 'error',
    )
  }
  return {
    availability: 'available',
    defaultMode: policy.defaultMode,
    priorConsentCountryCodes: [...policy.priorConsentCountryCodes],
    policyVersion: policy.policyVersion,
    updatedAt: policy.updatedAt ?? '',
  }
}

function unavailablePrivacy(
  availability: 'unavailable' | 'error',
): AdminAttributionPrivacyPolicyView {
  return {
    availability,
    defaultMode: null,
    priorConsentCountryCodes: [],
    policyVersion: null,
    updatedAt: '',
  }
}
