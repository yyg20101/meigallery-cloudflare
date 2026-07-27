import { describe, expect, it } from 'vitest'
import {
  resolveAdAttributionRouting,
  resolveAdAttributionSource,
} from './ad-attribution-routing'

describe('广告来源路由', () => {
  it.each([
    ['Meta', { fbclid: 'meta-click' }, 'meta', { fbclid: 'meta-click' }],
    ['TikTok', { ttclid: 'tiktok-click' }, 'tiktok', { ttclid: 'tiktok-click' }],
    ['Google gclid', { gclid: 'google-click' }, 'google', { gclid: 'google-click' }],
    ['Google braid', { gbraid: 'google-braid', wbraid: 'google-web-braid' }, 'google', {
      gbraid: 'google-braid',
      wbraid: 'google-web-braid',
    }],
  ] as const)('%s click ID 只选择对应平台', async (_label, signals, provider, identifiers) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, null)).resolves.toEqual({
      provider,
      resolution: 'matched',
      source: 'click_id',
      identifiers,
    })
  })

  it.each([
    'facebook',
    'instagram_ads',
    'meta',
    'tiktok_ads',
    'google_ads',
    'summer-campaign',
  ])('普通 utm_source=%s 不参与平台判定', async (utmSource) => {
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { utmSource } as never,
      null,
    )).resolves.toEqual({
      provider: null,
      resolution: 'none',
      source: null,
      identifiers: {},
    })
  })

  it('数据库验证通过的受管链接选择绑定平台', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-tiktok': 'tiktok' }),
      { trackingSourceSlug: 'summer-tiktok' },
      null,
    )).resolves.toEqual({
      provider: 'tiktok',
      resolution: 'matched',
      source: 'managed_link',
      identifiers: {},
    })
  })

  it.each([
    { trackingSourceSlug: 'unknown-source' },
    { trackingSourceSlug: 'invalid source' },
  ])('未知或非法的管理来源按冲突失败关闭', async (signals) => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      signals,
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it.each([
    ['Meta 与 TikTok', { fbclid: 'meta-click', ttclid: 'tiktok-click' }],
    ['Meta 与 Google', { fbclid: 'meta-click', gclid: 'google-click' }],
    ['TikTok 与 Google', { ttclid: 'tiktok-click', wbraid: 'google-click' }],
  ])('%s 强信号并存时冲突且不加载任何平台', async (_label, signals) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, 'meta')).resolves.toEqual({
      provider: null,
      resolution: 'conflict',
      source: null,
      identifiers: {},
    })
  })

  it('Click ID 与不同平台的受管链接冲突', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-tiktok': 'tiktok' }),
      { trackingSourceSlug: 'summer-tiktok', fbclid: 'meta-click' },
      'google',
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it('同平台 Click ID 优先于受管链接并保留匹配参数', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { trackingSourceSlug: 'summer-meta', fbclid: 'meta-click' },
      'tiktok',
    )).resolves.toEqual({
      provider: 'meta',
      resolution: 'matched',
      source: 'click_id',
      identifiers: { fbclid: 'meta-click' },
    })
  })

  it('无新来源时继承最近一次有效广告来源', () => {
    expect(resolveAdAttributionSource({
      clickIdentifiers: {},
      managedProvider: null,
      inheritedProvider: 'google',
    })).toEqual({
      provider: 'google',
      resolution: 'inherited',
      source: null,
      identifiers: {},
    })
  })

  it('新明确来源覆盖历史来源，采用最后一次付费来源', () => {
    expect(resolveAdAttributionSource({
      clickIdentifiers: { tiktok: { ttclid: 'new-click' } },
      managedProvider: null,
      inheritedProvider: 'meta',
    })).toEqual({
      provider: 'tiktok',
      resolution: 'matched',
      source: 'click_id',
      identifiers: { ttclid: 'new-click' },
    })
  })

  it('自然流量且没有历史来源时不选择平台', () => {
    expect(resolveAdAttributionSource({
      clickIdentifiers: {},
      managedProvider: null,
      inheritedProvider: null,
    })).toEqual({
      provider: null,
      resolution: 'none',
      source: null,
      identifiers: {},
    })
  })

  it.each([
    { fbclid: 'x'.repeat(129) },
    { ttclid: 'x'.repeat(1_001) },
    { gclid: { invalid: true } },
    { trackingSourceSlug: 'invalid source' },
  ])('非法强信号失败关闭，不继承旧平台', async (signals) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, 'meta')).resolves.toEqual({
      provider: null,
      resolution: 'conflict',
      source: null,
      identifiers: {},
    })
  })
})

function emptyDb() {
  return sourceDb({})
}

function sourceDb(sources: Record<string, 'meta' | 'tiktok' | 'google'>) {
  return {
    prepare() {
      return {
        bind(...values: string[]) {
          return {
            async all<T>() {
              const slug = values[0] || ''
              const provider = sources[slug]
              return {
                results: provider ? [{ ad_provider: provider }] as T[] : [],
              }
            },
          }
        },
      }
    },
  } as unknown as Pick<D1Database, 'prepare'>
}
