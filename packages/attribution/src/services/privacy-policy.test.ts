import { describe, expect, it } from 'vitest'
import {
  resolvePrivacyDecision,
  type AttributionPrivacyPolicy,
} from './privacy-policy'

const policy: AttributionPrivacyPolicy = {
  defaultMode: 'notice_opt_out',
  priorConsentCountryCodes: ['DE'],
  policyVersion: 1,
  updatedAt: null,
}

describe('归因地区隐私决策', () => {
  it.each([
    ['US', null, false, 'granted'],
    ['US', 'denied', false, 'denied'],
    ['DE', null, false, 'choice_required'],
    ['DE', 'granted', false, 'granted'],
    ['US', 'granted', true, 'denied'],
    ['XX', null, false, 'choice_required'],
    ['ZZ', null, false, 'choice_required'],
  ] as const)(
    'country=%s choice=%s gpc=%s',
    (country, choice, gpc, expected) => {
      expect(resolvePrivacyDecision(policy, {
        country,
        choice,
        gpc,
      }).state).toBe(expected)
    },
  )

  it('全局 prior_consent 对所有地区要求先选择', () => {
    expect(resolvePrivacyDecision({
      ...policy,
      defaultMode: 'prior_consent',
      priorConsentCountryCodes: [],
    }, {
      country: 'US',
      choice: null,
      gpc: false,
    })).toMatchObject({
      state: 'choice_required',
      reason: 'policy_default',
    })
  })

  it('全局 disabled 不能被显式同意覆盖', () => {
    expect(resolvePrivacyDecision({
      ...policy,
      defaultMode: 'disabled',
    }, {
      country: 'US',
      choice: 'granted',
      gpc: false,
    })).toEqual({
      state: 'denied',
      reason: 'disabled',
    })
  })
})
