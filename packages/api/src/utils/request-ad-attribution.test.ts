import { describe, expect, it } from 'vitest'
import { createAdAttributionContext, sealAdAttributionContext } from './ad-attribution-context'
import { loadAttributionCryptoKeys } from './attribution-crypto'
import { resolveRequestAdAttribution } from './request-ad-attribution'

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('请求广告归因上下文', () => {
  it('当前明确受管来源覆盖历史 Cookie', async () => {
    const keys = await loadAttributionCryptoKeys(env(createDb('tiktok')))
    const cookie = await sealAdAttributionContext(keys, createAdAttributionContext({
      provider: 'meta',
      source: 'click_id',
      identifiers: { fbclid: 'meta-click' },
    }))

    const result = await resolveRequestAdAttribution(
      env(createDb('tiktok')),
      cookie,
      { trackingSourceSlug: 'ad-tiktok-team' },
    )

    expect(result).toMatchObject({
      resolution: 'matched',
      context: {
        provider: 'tiktok',
        source: 'managed_link',
        identifiers: {},
      },
    })
  })

  it('当前请求没有新来源时继承可信 Cookie', async () => {
    const keys = await loadAttributionCryptoKeys(env(createDb(null)))
    const cookie = await sealAdAttributionContext(keys, createAdAttributionContext({
      provider: 'meta',
      source: 'click_id',
      identifiers: { fbclid: 'meta-click' },
    }))

    const result = await resolveRequestAdAttribution(
      env(createDb(null)),
      cookie,
    )

    expect(result).toMatchObject({
      resolution: 'inherited',
      context: {
        provider: 'meta',
        source: 'click_id',
        identifiers: { fbclid: 'meta-click' },
      },
    })
  })

  it('Cookie 缺失时只从 active 受管广告链接恢复唯一平台', async () => {
    const result = await resolveRequestAdAttribution(
      env(createDb('meta')),
      undefined,
      { trackingSourceSlug: 'ad-meta-team' },
    )

    expect(result).toMatchObject({
      resolution: 'matched',
      context: {
        provider: 'meta',
        source: 'managed_link',
        identifiers: {},
      },
    })
  })

  it('当前请求没有 mg_source 时回退站内已归一化的受管来源', async () => {
    const result = await resolveRequestAdAttribution(
      env(createDb('meta')),
      undefined,
      {},
      'ad-meta-team',
    )

    expect(result).toMatchObject({
      resolution: 'matched',
      context: {
        provider: 'meta',
        source: 'managed_link',
      },
    })
  })

  it('真实长度的 Meta click ID 与同平台受管来源共同恢复 Meta', async () => {
    const result = await resolveRequestAdAttribution(
      env(createDb('meta')),
      undefined,
      {
        fbclid: 'x'.repeat(512),
        trackingSourceSlug: 'ad-meta-team',
      },
    )

    expect(result).toMatchObject({
      resolution: 'matched',
      context: {
        provider: 'meta',
        source: 'click_id',
        identifiers: { fbclid: 'x'.repeat(512) },
      },
    })
  })

  it.each([
    ['没有受管链接', undefined],
    ['无效受管链接', 'invalid source'],
    ['普通来源链接', 'referral-team'],
  ])('%s时不选择平台', async (_label, trackingSourceSlug) => {
    const result = await resolveRequestAdAttribution(
      env(createDb(null)),
      undefined,
      { trackingSourceSlug },
    )

    expect(result.context).toBeNull()
  })

  it('受管链接与另一平台 click ID 冲突时不恢复任何平台', async () => {
    const result = await resolveRequestAdAttribution(
      env(createDb('meta')),
      undefined,
      {
        trackingSourceSlug: 'ad-meta-team',
        ttclid: 'tiktok-click',
      },
    )

    expect(result).toEqual({
      context: null,
      resolution: 'conflict',
    })
  })

  it('忽略 fallback 中伪造的 provider', async () => {
    const result = await resolveRequestAdAttribution(
      env(createDb(null)),
      undefined,
      { trackingSourceSlug: undefined, provider: 'meta' } as never,
    )

    expect(result).toEqual({
      context: null,
      resolution: 'none',
    })
  })
})

function env(db: D1Database) {
  return {
    DB: db,
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  }
}

function createDb(provider: 'meta' | 'tiktok' | 'google' | null) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all<T>() {
              return {
                results: provider ? [{ ad_provider: provider } as T] : [],
              }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}
