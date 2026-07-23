import { describe, expect, it } from 'vitest'
import { resolveAdAttributionRouting } from './ad-attribution-routing'

describe('广告来源严格路由', () => {
  it.each([
    ['Meta click id', { fbclid: 'IwAR_valid-click' }, 'meta'],
    ['TikTok click id', { ttclid: 'E.C.P.valid-click-id' }, 'tiktok'],
    ['Google gclid', { gclid: 'google-click-id' }, 'google'],
    ['Google gbraid', { gbraid: 'google-gbraid' }, 'google'],
    ['Google wbraid', { wbraid: 'google-wbraid' }, 'google'],
  ] as const)('%s 只匹配对应平台', async (_label, signals, provider) => {
    await expect(resolveAdAttributionRouting(emptyDb(), signals, null)).resolves.toMatchObject({
      provider,
      resolution: 'matched',
    })
  })

  it('受管投放链接必须同时具备后台生成的随机校验参数', async () => {
    const db = sourceDb({ 'summer-meta': 'meta', 'summer-tiktok': 'tiktok' })

    await expect(resolveAdAttributionRouting(
      db,
      managedSignals('summer-tiktok', 'campaign-alias'),
      null,
    )).resolves.toMatchObject({ provider: 'tiktok', resolution: 'matched' })
  })

  it.each([
    { trackingSourceSlug: 'summer-meta' },
    { trackingSourceSlug: 'summer-meta', managedLinkProof: 'f'.repeat(64) },
    { managedLinkProof: SOURCE_PROOFS['summer-meta'] },
  ])('缺少或伪造校验参数的来源不能建立平台归因', async signals => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      signals,
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'none' })
  })

  it.each(['instagram_ads', 'tiktok-ads', 'google_ads'])(
    'UTM 平台别名 %s 只能用于冲突检测，不能单独建立可信归因',
    async utmSource => {
      await expect(resolveAdAttributionRouting(emptyDb(), { utmSource }, null)).resolves.toMatchObject({
        provider: null,
        resolution: 'none',
      })
    },
  )

  it('Click ID 与后台绑定平台冲突时失败关闭，禁止跨平台投递', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-tiktok': 'tiktok' }),
      { ...managedSignals('summer-tiktok'), fbclid: 'meta-click' },
      null,
    )).resolves.toMatchObject({ provider: null, resolution: 'conflict' })
  })

  it('Click ID 与后台绑定平台一致时保留平台匹配参数', async () => {
    await expect(resolveAdAttributionRouting(
      sourceDb({ 'summer-meta': 'meta' }),
      { ...managedSignals('summer-meta'), fbclid: 'meta-click' },
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
      { ...managedSignals('summer-meta'), utmSource: 'tiktok_ads' },
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
      {
        trackingSourceSlug: 'summer-other',
        managedLinkProof: 'd'.repeat(64),
      },
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

const SOURCE_PROOFS: Record<string, string> = {
  'summer-meta': 'a'.repeat(64),
  'summer-tiktok': 'b'.repeat(64),
}

function managedSignals(slug: string, utmSource = '') {
  return {
    trackingSourceSlug: slug,
    managedLinkProof: SOURCE_PROOFS[slug] ?? 'c'.repeat(64),
    ...(utmSource ? { utmSource } : {}),
  }
}

function sourceDb(sources: Record<string, 'meta' | 'tiktok' | 'google'>) {
  return {
    prepare(_sql: string) {
      return {
        bind(...values: string[]) {
          return {
            async all<T>() {
              const slug = values[0] || ''
              const proofMatches = SOURCE_PROOFS[slug] === values[1]
              const providers = [...new Set([proofMatches ? sources[slug] : undefined].filter(Boolean))]
              return { results: providers.map(provider => ({ ad_provider: provider })) as T[] }
            },
          }
        },
      }
    },
  } as unknown as Pick<D1Database, 'prepare'>
}
