import { describe, expect, it } from 'vitest'
import { resolveAdAttributionRouting } from './ad-attribution-routing'

describe('广告来源严格路由', () => {
  it.each([
    ['Meta click id', { fbclid: 'IwAR_valid-click' }, 'meta'],
    ['TikTok click id', { ttclid: 'E.C.P.valid-click-id' }, 'tiktok'],
    ['Google gclid', { gclid: 'google-click-id' }, 'google'],
    ['Google gbraid', { gbraid: 'google-gbraid' }, 'google'],
    ['Google wbraid', { wbraid: 'google-wbraid' }, 'google'],
    ['Meta 明确广告别名', { utmSource: 'instagram_ads' }, 'meta'],
    ['TikTok 明确广告别名', { utmSource: 'tiktok-ads' }, 'tiktok'],
    ['Google 明确广告别名', { utmSource: 'google_ads' }, 'google'],
  ] as const)('%s 只匹配对应平台', async (_label, signals, provider) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, null)).resolves.toMatchObject({
      provider,
      resolution: 'matched',
    })
  })

  it('受管投放链接按后台不可变的平台归属解析', async () => {
    const db = sourceDb({ 'summer-meta': 'meta', 'summer-tiktok': 'tiktok' })

    await expect(resolveAdAttributionRouting(
      db,
      { trackingSourceSlug: 'summer-tiktok', utmSource: 'campaign-alias' },
      null,
    )).resolves.toMatchObject({ provider: 'tiktok', resolution: 'matched' })
  })

  it('Click ID 与后台绑定平台冲突时失败关闭，禁止跨平台投递', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-tiktok': 'tiktok' }),
      { trackingSourceSlug: 'summer-tiktok', fbclid: 'meta-click' },
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it('Click ID 与后台绑定平台一致时保留平台匹配参数', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { trackingSourceSlug: 'summer-meta', fbclid: 'meta-click' },
      null,
    )).resolves.toMatchObject({
      provider: 'meta',
      resolution: 'matched',
      source: 'click_id',
      identifiers: { fbclid: 'meta-click' },
    })
  })

  it('未知或停用的来源不能替换已验证来源', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({}),
      { trackingSourceSlug: 'summer-meta' },
      'tiktok',
    )).resolves.toMatchObject({ provider: 'tiktok', resolution: 'inherited' })
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

  it('Click ID 与另一个平台的明确别名冲突时失败关闭', async () => {
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { fbclid: 'meta-click', utmSource: 'tiktok_ads' },
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it('管理链接与另一个平台的明确别名冲突时失败关闭', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { trackingSourceSlug: 'summer-meta', utmSource: 'tiktok_ads' },
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it('Click ID 可以携带不声明其他平台的普通 UTM', async () => {
    await expect(resolveAdAttributionRouting(
      emptyDb(),
      { fbclid: 'meta-click', utmSource: 'summer-campaign' },
      null,
    )).resolves.toMatchObject({
      provider: 'meta',
      resolution: 'matched',
      identifiers: { fbclid: 'meta-click' },
    })
  })

  it.each(['facebook', 'instagram', 'meta', 'tiktok', 'tt', 'google'])(
    '自然或含糊来源 %s 不能创建新归因，只保留可信旧来源',
    async utmSource => {
      await expect(resolveAdAttributionRouting(emptyDb(), { utmSource }, 'meta')).resolves.toMatchObject({
        provider: 'meta',
        resolution: 'inherited',
      })
    },
  )

  it('无效或不匹配的受管链接不能替换旧来源', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { trackingSourceSlug: 'summer-other' },
      'tiktok',
    )).resolves.toMatchObject({ provider: 'tiktok', resolution: 'inherited' })
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
    { utmSource: 'unknown-network' },
  ])('非法长度、控制字符、未知来源或类型均不能替换可信旧来源', async (signals) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, 'meta')).resolves.toMatchObject({
      provider: 'meta',
      resolution: 'inherited',
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
