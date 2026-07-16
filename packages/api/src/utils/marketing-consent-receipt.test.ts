import { describe, expect, it } from 'vitest'
import {
  createMarketingConsentChoice,
  createMarketingConsentReceipt,
  MARKETING_CONSENT_CHOICE_TTL_SECONDS,
  resolveTrustedMarketingConsent,
  verifyMarketingConsentChoice,
  verifyMarketingConsentReceipt,
} from './marketing-consent-receipt'

const SECRET = 'marketing-consent-test-secret'
const NOW = 1_783_699_200

describe('服务端营销授权凭证', () => {
  it('签发 180 天选择和 30 分钟 receipt，并保留原始决定时间', async () => {
    const choice = await createMarketingConsentChoice(SECRET, 'granted', NOW)
    const receipt = await createMarketingConsentReceipt(SECRET, choice.claims, NOW + 60)

    await expect(verifyMarketingConsentChoice(SECRET, choice.token, NOW + 1)).resolves.toMatchObject({
      state: 'granted',
      decidedAt: NOW,
      expiresAt: NOW + MARKETING_CONSENT_CHOICE_TTL_SECONDS,
    })
    await expect(verifyMarketingConsentReceipt(SECRET, receipt, NOW + 61)).resolves.toMatchObject({
      state: 'granted',
      issuedAt: NOW + 60,
      expiresAt: NOW + 1_860,
      decisionNonce: choice.claims.nonce,
      consent: { decidedAt: new Date(NOW * 1_000).toISOString() },
    })
  })

  it('短期 receipt 过期后继续使用有效选择并要求续签', async () => {
    const choice = await createMarketingConsentChoice(SECRET, 'granted', NOW)
    const receipt = await createMarketingConsentReceipt(SECRET, choice.claims, NOW)
    const resolved = await resolveTrustedMarketingConsent(
      SECRET,
      { choice: choice.token, receipt },
      'granted',
      NOW + 1_800,
    )

    expect(resolved.state).toBe('granted')
    expect(resolved.consent.marketingAllowed).toBe(true)
    expect(resolved.needsReceiptRefresh).toBe(true)
    expect(resolved.choice?.nonce).toBe(choice.claims.nonce)
  })

  it.each([
    ['missing', {}],
    ['tamper', { choice: 'tampered.choice', receipt: 'tampered.receipt' }],
  ])('%s proof 不能把伪造 body granted 升级为授权', async (_label, tokens) => {
    const resolved = await resolveTrustedMarketingConsent(SECRET, tokens, 'granted', NOW)
    expect(resolved.state).toBe('limited')
    expect(resolved.consent.marketingAllowed).toBe(false)
  })

  it('过期选择不能续签 granted', async () => {
    const choice = await createMarketingConsentChoice(SECRET, 'granted', NOW)
    const resolved = await resolveTrustedMarketingConsent(
      SECRET,
      { choice: choice.token },
      'granted',
      NOW + MARKETING_CONSENT_CHOICE_TTL_SECONDS,
    )

    expect(resolved.state).toBe('limited')
    expect(resolved.needsReceiptRefresh).toBe(false)
  })

  it('denied proof 和请求 body 都只能降低授权', async () => {
    const grantedChoice = await createMarketingConsentChoice(SECRET, 'granted', NOW)
    const deniedChoice = await createMarketingConsentChoice(SECRET, 'denied', NOW)
    const granted = await createMarketingConsentReceipt(SECRET, grantedChoice.claims, NOW)
    const denied = await createMarketingConsentReceipt(SECRET, deniedChoice.claims, NOW)

    expect((await resolveTrustedMarketingConsent(SECRET, { choice: deniedChoice.token, receipt: denied }, 'granted', NOW + 1)).state).toBe('denied')
    expect((await resolveTrustedMarketingConsent(SECRET, { choice: grantedChoice.token, receipt: granted }, 'denied', NOW + 1)).state).toBe('denied')
    expect((await resolveTrustedMarketingConsent(SECRET, { choice: grantedChoice.token, receipt: granted }, 'limited', NOW + 1)).state).toBe('limited')
  })

  it('有效 choice 与 receipt 不属于同一次决定时 fail closed', async () => {
    const first = await createMarketingConsentChoice(SECRET, 'granted', NOW)
    const second = await createMarketingConsentChoice(SECRET, 'granted', NOW + 1)
    const receipt = await createMarketingConsentReceipt(SECRET, first.claims, NOW + 1)
    const resolved = await resolveTrustedMarketingConsent(
      SECRET,
      { choice: second.token, receipt },
      undefined,
      NOW + 2,
    )

    expect(resolved.state).toBe('limited')
    expect(resolved.choice).toBeNull()
    expect(resolved.needsReceiptRefresh).toBe(false)
  })
})
