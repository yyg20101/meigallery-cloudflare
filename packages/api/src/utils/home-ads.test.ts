import { describe, expect, it } from 'vitest'
import {
  HOME_AD_PLACEMENT,
  type HomeAdRow,
  isExpectedHomeAdImageKey,
  normalizeHomeAdImageUrl,
  normalizeHomeAdPayload,
  safeHomeAdImageUrl,
  serializePublicHomeAd,
} from './home-ads'

function row(overrides: Partial<HomeAdRow> = {}): HomeAdRow {
  return {
    id: 'ad-1',
    placement: HOME_AD_PLACEMENT,
    eyebrow: '本周推荐',
    title: '会员季精选内容',
    summary: '探索本周精选图库',
    cta_label: '查看详情',
    target_url: '/discover?sort=hot',
    sponsor: '运营精选',
    image_url: '/api/media/public/home-ads/ad-1/cover.webp',
    image_key: 'home-ads/ad-1/cover.webp',
    enabled: 1,
    starts_at: '',
    ends_at: '',
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('首页多广告配置工具', () => {
  it('归一化后台广告字段并支持大图 URL', () => {
    const normalized = normalizeHomeAdPayload({
      eyebrow: '  本周   推荐  ',
      title: '  会员季   精选内容  ',
      summary: '精选图库与真实案例',
      ctaLabel: '查看推荐',
      targetUrl: ' /discover?sort=hot ',
      sponsor: '运营精选',
      imageUrl: ' /api/media/public/home-ads/ad-1/cover.webp ',
      enabled: 'true',
      startsAt: '2026-06-01T08:00:00+08:00',
      endsAt: '2026-06-02T08:00:00+08:00',
    })

    expect(normalized).toEqual({
      placement: HOME_AD_PLACEMENT,
      eyebrow: '本周 推荐',
      title: '会员季 精选内容',
      summary: '精选图库与真实案例',
      ctaLabel: '查看推荐',
      targetUrl: '/discover?sort=hot',
      sponsor: '运营精选',
      imageUrl: '/api/media/public/home-ads/ad-1/cover.webp',
      enabled: true,
      startsAt: '2026-06-01T00:00:00.000Z',
      endsAt: '2026-06-02T00:00:00.000Z',
    })
  })

  it('拒绝不安全链接、错误位置和非广告公开媒体图片', () => {
    expect(() => normalizeHomeAdPayload({ title: '危险链接', targetUrl: 'javascript:alert(1)' })).toThrow('首页广告链接')
    expect(() => normalizeHomeAdPayload({ title: '错误位置', targetUrl: '/discover?sort=hot', placement: 'sidebar' })).toThrow('广告位置')
    expect(() => normalizeHomeAdPayload({ title: '错误图片', targetUrl: '/discover?sort=hot', imageUrl: '/api/media/public/site/icon.png' })).toThrow('广告大图 URL')
  })

  it('公开序列化只返回启用、排期有效且安全的广告', () => {
    const now = new Date('2026-06-01T12:00:00.000Z')

    expect(serializePublicHomeAd(row({ starts_at: '2026-06-01T00:00:00.000Z', ends_at: '2026-06-02T00:00:00.000Z' }), now)).toEqual({
      id: 'ad-1',
      eyebrow: '本周推荐',
      title: '会员季精选内容',
      summary: '探索本周精选图库',
      ctaLabel: '查看详情',
      targetUrl: '/discover?sort=hot',
      sponsor: '运营精选',
      imageUrl: '/api/media/public/home-ads/ad-1/cover.webp',
      sortOrder: 0,
    })
    expect(serializePublicHomeAd(row({ enabled: 0 }), now)).toBeNull()
    expect(serializePublicHomeAd(row({ starts_at: '2026-06-02T00:00:00.000Z' }), now)).toBeNull()
    expect(serializePublicHomeAd(row({ target_url: '/admin/settings' }), now)).toBeNull()
    expect(serializePublicHomeAd(row({ title: 'x'.repeat(65) }), now)).toBeNull()
    expect(serializePublicHomeAd(row({ image_url: '/api/media/public/site/icon.png' }), now)?.imageUrl).toBe('')
  })

  it('广告大图只允许广告公开媒体路径或安全 https 图片链接', () => {
    expect(normalizeHomeAdImageUrl('/api/media/public/home-ads/ad-1/cover.webp')).toBe('/api/media/public/home-ads/ad-1/cover.webp')
    expect(normalizeHomeAdImageUrl('HTTPS://example.com/ad.webp?next="x"')).toBe('https://example.com/ad.webp?next=%22x%22')
    expect(safeHomeAdImageUrl('/api/media/public/site/icon.png')).toBe('')
    expect(safeHomeAdImageUrl('https://127.0.0.1/ad.webp')).toBe('')
  })

  it('校验 R2 大图 key 必须归属当前广告', () => {
    expect(isExpectedHomeAdImageKey('home-ads/ad-1/cover.webp', 'ad-1')).toBe(true)
    expect(isExpectedHomeAdImageKey('home-ads/ad-2/cover.webp', 'ad-1')).toBe(false)
    expect(isExpectedHomeAdImageKey('home-ads/ad-1/../cover.webp', 'ad-1')).toBe(false)
    expect(isExpectedHomeAdImageKey('home-ads/ad-1\\cover.webp', 'ad-1')).toBe(false)
  })
})
