import { describe, expect, it } from 'vitest'
import {
  createManagedLinkToken,
  resolveAdAttributionRouting,
} from './ad-attribution-routing'

const MANAGED_LINK_SECRET = 'managed-link-routing-test-secret'

describe('广告来源严格路由', () => {
  it.each([
    ['Meta click id', { fbclid: 'IwAR_valid-click' }, 'meta'],
    ['TikTok click id', { ttclid: 'E.C.P.valid-click-id' }, 'tiktok'],
    ['Google gclid', { gclid: 'google-click-id' }, 'google'],
    ['Google gbraid', { gbraid: 'google-gbraid' }, 'google'],
    ['Google wbraid', { wbraid: 'google-wbraid' }, 'google'],
    ['Meta UTM', { utmSource: 'instagram_ads' }, 'meta'],
    ['TikTok UTM', { utmSource: 'tiktok-ads' }, 'tiktok'],
    ['Google Ads UTM', { utmSource: 'google_ads' }, 'google'],
  ] as const)('%s 只匹配对应平台', async (_label, signals, provider) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, null)).resolves.toMatchObject({
      provider,
      resolution: 'matched',
    })
  })

  it('受管投放链接必须通过签名与后台来源校验', async () => {
    const db = sourceDb({ 'summer-meta': 'meta', 'summer-tiktok': 'tiktok' })
    const managedLinkToken = await createManagedLinkToken(MANAGED_LINK_SECRET, {
      trackingSourceSlug: 'summer-tiktok',
      provider: 'tiktok',
    })

    await expect(resolveAdAttributionRouting(
      db,
      { trackingSourceSlug: 'summer-tiktok', utmSource: 'campaign-alias', managedLinkToken },
      null,
      { managedLinkSecret: MANAGED_LINK_SECRET },
    )).resolves.toMatchObject({ provider: 'tiktok', resolution: 'matched' })
  })

  it('未签名或篡改的受管链接不得建立广告归因', async () => {
    const token = await createManagedLinkToken(MANAGED_LINK_SECRET, {
      trackingSourceSlug: 'summer-meta',
      provider: 'meta',
    })

    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { trackingSourceSlug: 'summer-meta' },
      null,
      { managedLinkSecret: MANAGED_LINK_SECRET },
    )).resolves.toMatchObject({ provider: null, resolution: 'none' })
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { trackingSourceSlug: 'summer-meta', managedLinkToken: `${token}x` },
      null,
      { managedLinkSecret: MANAGED_LINK_SECRET },
    )).resolves.toMatchObject({ provider: null, resolution: 'none' })
  })

  it.each([
    ['Meta 与 TikTok click id 并存', { fbclid: 'meta-click', ttclid: 'tiktok-click' }],
    ['Google 与 Meta click id 并存', { gclid: 'google-click', fbclid: 'meta-click' }],
  ])('%s 时拒绝全部平台', async (_label, signals) => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      signals,
      'meta',
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it('强 click id 优先于低优先级别名，普通 google 不视为 Google Ads', async () => {
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { fbclid: 'meta-click', utmSource: 'tiktok_ads' },
      null,
    )).resolves.toMatchObject({ provider: 'meta', resolution: 'matched' })
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { utmSource: 'google' },
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'none' })
  })

  it('未知显式来源会清除继承来源', async () => {
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { utmSource: 'unknown-network' },
      'meta',
    )).resolves.toMatchObject({ provider: null, resolution: 'none' })
  })

  it('完全没有新来源信号时才允许继承已验证来源', async () => {
    await expect(resolveAdAttributionRouting(emptyDb(), {}, 'tiktok')).resolves.toMatchObject({
      provider: 'tiktok',
      resolution: 'inherited',
    })
  })

  it.each([
    { fbclid: 'x'.repeat(129) },
    { ttclid: 'x'.repeat(1_001) },
    { utmSource: `meta\n` },
    { fbclid: { invalid: true } },
  ])('非法长度、控制字符或类型不会被误识别或继承旧来源', async (signals) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, 'meta')).resolves.toMatchObject({
      provider: null,
      resolution: 'none',
    })
  })
})

function emptyDb() {
  return sourceDb({})
}

function sourceDb(sources: Record<string, 'meta' | 'tiktok' | 'google'>) {
  return {
    prepare(_sql: string) {
      return {
        bind(...values: string[]) {
          return {
            async all<T>() {
              const providers = [...new Set([sources[values[0] || '']].filter(Boolean))]
              return { results: providers.map(provider => ({ ad_provider: provider })) as T[] }
            },
          }
        },
      }
    },
  } as unknown as Pick<D1Database, 'prepare'>
}
