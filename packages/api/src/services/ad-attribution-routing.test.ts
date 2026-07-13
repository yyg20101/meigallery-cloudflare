import { describe, expect, it } from 'vitest'
import { resolveAdAttributionRouting } from './ad-attribution-routing'

describe('广告来源严格路由', () => {
  it.each([
    ['Meta click id', { fbclid: 'IwAR_valid-click' }, 'meta'],
    ['TikTok click id', { ttclid: 'E.C.P.valid-click-id' }, 'tiktok'],
    ['Meta UTM', { utmSource: 'instagram_ads' }, 'meta'],
    ['TikTok UTM', { utmSource: 'tiktok-ads' }, 'tiktok'],
  ] as const)('%s 只匹配对应平台', async (_label, signals, provider) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, null)).resolves.toEqual({
      provider,
      resolution: 'matched',
    })
  })

  it('受管投放链接以后台 ad_provider 为权威来源', async () => {
    const db = sourceDb({ 'summer-meta': 'meta', 'summer-tiktok': 'tiktok' })

    await expect(resolveAdAttributionRouting(
      db,
      { trackingSourceSlug: 'summer-tiktok', utmSource: 'campaign-alias' },
      null,
    )).resolves.toEqual({ provider: 'tiktok', resolution: 'matched' })
  })

  it.each([
    ['同时出现两个 click id', { fbclid: 'meta-click', ttclid: 'tiktok-click' }],
    ['click id 与 UTM 冲突', { fbclid: 'meta-click', utmSource: 'tiktok' }],
    ['受管来源与 UTM 冲突', { trackingSourceSlug: 'summer-meta', utmSource: 'tiktok' }],
  ])('%s 时拒绝全部平台', async (_label, signals) => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      signals,
      'meta',
    )).resolves.toEqual({ provider: null, resolution: 'conflict' })
  })

  it('未知显式来源会清除继承来源', async () => {
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { utmSource: 'unknown-network' },
      'meta',
    )).resolves.toEqual({ provider: null, resolution: 'none' })
  })

  it('完全没有新来源信号时才允许继承已签名来源', async () => {
    await expect(resolveAdAttributionRouting(emptyDb(), {}, 'tiktok')).resolves.toEqual({
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
    await expect(resolveAdAttributionRouting(emptyDb(), signals, 'meta')).resolves.toEqual({
      provider: null,
      resolution: 'none',
    })
  })
})

function emptyDb() {
  return sourceDb({})
}

function sourceDb(sources: Record<string, 'meta' | 'tiktok'>) {
  return {
    prepare(_sql: string) {
      return {
        bind(...values: string[]) {
          return {
            async all<T>() {
              const providers = [...new Set([
                sources[values[0] || ''],
                sources[values[2] || ''],
              ].filter(Boolean))]
              return { results: providers.map(provider => ({ ad_provider: provider })) as T[] }
            },
          }
        },
      }
    },
  } as unknown as Pick<D1Database, 'prepare'>
}
