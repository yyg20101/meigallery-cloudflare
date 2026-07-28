import { describe, expect, it } from 'vitest'
import { createAdAttributionContext, sealAdAttributionContext } from './ad-attribution-context'
import { loadAttributionCryptoKeys } from './attribution-crypto'
import { resolveRequestAdAttributionContext } from './request-ad-attribution-context'

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('请求广告归因上下文', () => {
  it('优先采用现有加密上下文，不被受管链接覆盖', async () => {
    const keys = await loadAttributionCryptoKeys(env(createDb('tiktok')))
    const cookie = await sealAdAttributionContext(keys, createAdAttributionContext({
      provider: 'meta',
      source: 'click_id',
      identifiers: { fbclid: 'meta-click' },
    }))

    const context = await resolveRequestAdAttributionContext(
      env(createDb('tiktok')),
      cookie,
      { trackingSourceSlug: 'ad-tiktok-team' },
    )

    expect(context).toMatchObject({
      provider: 'meta',
      source: 'click_id',
      identifiers: { fbclid: 'meta-click' },
    })
  })

  it('Cookie 缺失时只从 active 受管广告链接恢复唯一平台', async () => {
    const context = await resolveRequestAdAttributionContext(
      env(createDb('meta')),
      undefined,
      { trackingSourceSlug: 'ad-meta-team' },
    )

    expect(context).toMatchObject({
      provider: 'meta',
      source: 'managed_link',
      identifiers: {},
    })
  })

  it('当前请求没有 mg_source 时回退站内已归一化的受管来源', async () => {
    const context = await resolveRequestAdAttributionContext(
      env(createDb('meta')),
      undefined,
      {},
      'ad-meta-team',
    )

    expect(context).toMatchObject({
      provider: 'meta',
      source: 'managed_link',
    })
  })

  it.each([
    ['没有受管链接', undefined],
    ['无效受管链接', 'invalid source'],
    ['普通来源链接', 'referral-team'],
  ])('%s时不选择平台', async (_label, trackingSourceSlug) => {
    const context = await resolveRequestAdAttributionContext(
      env(createDb(null)),
      undefined,
      { trackingSourceSlug },
    )

    expect(context).toBeNull()
  })

  it('受管链接与另一平台 click ID 冲突时不恢复任何平台', async () => {
    const context = await resolveRequestAdAttributionContext(
      env(createDb('meta')),
      undefined,
      {
        trackingSourceSlug: 'ad-meta-team',
        ttclid: 'tiktok-click',
      },
    )

    expect(context).toBeNull()
  })

  it('忽略 fallback 中伪造的 provider', async () => {
    const context = await resolveRequestAdAttributionContext(
      env(createDb(null)),
      undefined,
      { trackingSourceSlug: undefined, provider: 'meta' } as never,
    )

    expect(context).toBeNull()
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
