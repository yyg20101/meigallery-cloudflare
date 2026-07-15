import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
  createAdAttributionContext,
  resolveTrustedAdAttributionContext,
  sealAdAttributionContext,
} from './ad-attribution-context'
import { loadAttributionCryptoKeys } from './attribution-crypto'

const NOW = 1_783_699_200
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64')

describe('加密广告归因上下文', () => {
  it('以 context purpose 加密 30 天上下文，不暴露 click id', async () => {
    const keys = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const context = createAdAttributionContext({
      provider: 'google',
      source: 'click_id',
      identifiers: { gclid: 'sensitive-google-click-id' },
      contextId: `ctx_${'1'.repeat(32)}`,
      nowSeconds: NOW,
    })
    const encrypted = await sealAdAttributionContext(keys, context)

    expect(context.expiresAt).toBe(NOW + AD_ATTRIBUTION_CONTEXT_TTL_SECONDS)
    expect(encrypted).not.toContain('sensitive-google-click-id')
    await expect(resolveTrustedAdAttributionContext(keys, encrypted, NOW + 1)).resolves.toEqual(context)
  })

  it('过期、篡改或跨上下文密文均不会恢复来源', async () => {
    const keys = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const context = createAdAttributionContext({
      provider: 'meta',
      source: 'click_id',
      identifiers: { fbclid: 'sensitive-meta-click-id' },
      nowSeconds: NOW,
    })
    const encrypted = await sealAdAttributionContext(keys, context)

    await expect(resolveTrustedAdAttributionContext(keys, encrypted, context.expiresAt)).resolves.toBeNull()
    await expect(resolveTrustedAdAttributionContext(keys, `${encrypted}x`, NOW + 1)).resolves.toBeNull()
  })
})
