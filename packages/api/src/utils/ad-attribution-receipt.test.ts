import { describe, expect, it } from 'vitest'
import {
  AD_ATTRIBUTION_RECEIPT_TTL_SECONDS,
  createAdAttributionReceipt,
  resolveTrustedAdAttributionProvider,
  verifyAdAttributionReceipt,
} from './ad-attribution-receipt'

const SECRET = 'ad-attribution-test-secret'
const NOW = 1_783_699_200

describe('服务端广告来源 receipt', () => {
  it.each(['meta', 'tiktok'] as const)('签发并验证 %s 来源', async (provider) => {
    const receipt = await createAdAttributionReceipt(SECRET, provider, NOW)

    await expect(verifyAdAttributionReceipt(SECRET, receipt, NOW + 1)).resolves.toMatchObject({
      provider,
      issuedAt: NOW,
      expiresAt: NOW + AD_ATTRIBUTION_RECEIPT_TTL_SECONDS,
    })
    await expect(resolveTrustedAdAttributionProvider(SECRET, receipt, NOW + 1)).resolves.toBe(provider)
  })

  it.each([
    ['缺失', undefined],
    ['篡改', 'tampered.receipt'],
  ])('%s receipt 不产生可信来源', async (_label, receipt) => {
    await expect(resolveTrustedAdAttributionProvider(SECRET, receipt, NOW)).resolves.toBeNull()
  })

  it('过期 receipt 不产生可信来源', async () => {
    const receipt = await createAdAttributionReceipt(SECRET, 'meta', NOW)

    await expect(resolveTrustedAdAttributionProvider(
      SECRET,
      receipt,
      NOW + AD_ATTRIBUTION_RECEIPT_TTL_SECONDS,
    )).resolves.toBeNull()
  })

  it('不同密钥不能验证 receipt', async () => {
    const receipt = await createAdAttributionReceipt(SECRET, 'tiktok', NOW)

    await expect(verifyAdAttributionReceipt('other-secret', receipt, NOW + 1)).rejects.toThrow()
  })
})
