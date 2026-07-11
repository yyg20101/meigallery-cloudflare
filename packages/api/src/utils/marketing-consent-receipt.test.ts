import { describe, expect, it } from 'vitest'
import {
  createMarketingConsentReceipt,
  resolveTrustedMarketingConsent,
  verifyMarketingConsentReceipt,
} from './marketing-consent-receipt'

const SECRET = 'marketing-consent-test-secret'
const NOW = 1_783_699_200

describe('服务端营销授权 receipt', () => {
  it('签发短期 granted receipt 并验证服务端权威状态', async () => {
    const receipt = await createMarketingConsentReceipt(SECRET, 'granted', NOW)

    await expect(verifyMarketingConsentReceipt(SECRET, receipt, NOW + 1)).resolves.toMatchObject({
      state: 'granted',
      issuedAt: NOW,
      expiresAt: NOW + 1_800,
    })
    await expect(resolveTrustedMarketingConsent(SECRET, receipt, 'granted', NOW + 1)).resolves.toBe('granted')
  })

  it.each([
    ['missing', undefined],
    ['tamper', 'tampered.receipt'],
  ])('%s receipt 不能把伪造 body granted 升级为授权', async (_label, receipt) => {
    await expect(resolveTrustedMarketingConsent(SECRET, receipt, 'granted', NOW)).resolves.toBe('limited')
  })

  it('过期 receipt 不能升级 granted', async () => {
    const receipt = await createMarketingConsentReceipt(SECRET, 'granted', NOW)

    await expect(resolveTrustedMarketingConsent(SECRET, receipt, 'granted', NOW + 1_800)).resolves.toBe('limited')
  })

  it('denied receipt 和请求 body 都只能降级授权', async () => {
    const granted = await createMarketingConsentReceipt(SECRET, 'granted', NOW)
    const denied = await createMarketingConsentReceipt(SECRET, 'denied', NOW)

    await expect(resolveTrustedMarketingConsent(SECRET, denied, 'granted', NOW + 1)).resolves.toBe('denied')
    await expect(resolveTrustedMarketingConsent(SECRET, granted, 'denied', NOW + 1)).resolves.toBe('denied')
    await expect(resolveTrustedMarketingConsent(SECRET, granted, 'limited', NOW + 1)).resolves.toBe('limited')
  })
})
