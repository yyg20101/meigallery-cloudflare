import { describe, expect, it } from 'vitest'
import app from '../index'
import type { Bindings } from '../index'

type SettingRow = { key: string; value: unknown } | { key: string; rawValue: string }
type HomeAdTestRow = {
  id: string
  placement?: string
  eyebrow?: string
  title: string
  summary?: string
  cta_label?: string
  target_url?: string
  sponsor?: string
  image_url?: string
  image_key?: string | null
  enabled?: number
  starts_at?: string
  ends_at?: string
  sort_order?: number
  created_at?: string
  updated_at?: string
}

function createDb(rows: SettingRow[], homeAds: HomeAdTestRow[] = []) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this
        },
        async all<T>() {
          if (sql.includes('FROM home_ads')) {
            return {
              results: homeAds.map(row => ({
                placement: 'home_after_hero',
                eyebrow: '',
                summary: '',
                cta_label: '查看详情',
                target_url: '/discover?sort=hot',
                sponsor: '',
                image_url: '',
                image_key: null,
                enabled: 1,
                starts_at: '',
                ends_at: '',
                sort_order: 0,
                created_at: '2026-06-01T00:00:00.000Z',
                updated_at: '2026-06-01T00:00:00.000Z',
                ...row,
              })) as T[],
            }
          }
          return {
            results: rows.map((row) => {
              const value = 'rawValue' in row ? row.rawValue : JSON.stringify(row.value)
              return { key: row.key, value }
            }) as T[],
          }
        },
      }
    },
  }
}

describe('公开站点设置 API', () => {
  it('过滤历史危险公开 URL，响应不包含广告平台凭据', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_icon', value: 'javascript:alert(1)' },
        { key: 'og_image', value: 'https://example.com/%5Cog.jpg' },
        { key: 'home_ad_url', value: '/api/media/public/site/icon.png' },
        { key: 'rules_page_url', value: '/rules%5Cnext' },
        { key: 'home_ad_enabled', value: 'true' },
        { key: 'home_ad_eyebrow', value: '  本周   推荐  ' },
        { key: 'home_ad_title', value: 'x'.repeat(41) },
        { key: 'home_ad_summary', value: '会员\u0001精选' },
        { key: 'home_ad_cta_label', value: 'x'.repeat(13) },
        { key: 'home_ad_sponsor', value: 'x'.repeat(31) },
        { key: 'home_ad_starts_at', value: '2026-06-01T08:30:00+08:00' },
        { key: 'home_ad_ends_at', value: 'not-a-date' },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=300')
    expect(body.site_icon).toBe('')
    expect(body.og_image).toBe('')
    expect(body.home_ad_url).toBe('')
    expect(body.rules_page_url).toBe('')
    expect(body).not.toHaveProperty('destination_id')
    expect(body).not.toHaveProperty('mode')
    expect(body.home_ad_enabled).toBe(true)
    expect(body.home_ad_eyebrow).toBe('本周 推荐')
    expect(body.home_ad_title).toBe('')
    expect(body.home_ad_summary).toBe('')
    expect(body.home_ad_cta_label).toBe('')
    expect(body.home_ad_sponsor).toBe('')
    expect(body.home_ad_starts_at).toBe('2026-06-01T00:30:00.000Z')
    expect(body.home_ad_ends_at).toBe('')
  })

  it('单条历史损坏 JSON 不影响公开设置整体响应', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_name', value: '测试图库' },
        { key: 'site_description', value: '后台保存后的站点描述' },
        { key: 'seo_title', rawValue: '{"broken"' },
        { key: 'home_ad_title', rawValue: '会员精选' },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=300')
    expect(body.site_name).toBe('测试图库')
    expect(body.site_description).toBe('后台保存后的站点描述')
    expect(body.seo_title).toBe('')
    expect(body.home_ad_title).toBe('')
  })

  it('清空历史默认 SEO 标题，避免前台继续显示脚手架标题', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_name', value: '星耀传媒' },
        { key: 'seo_title', value: 'MeiGallery - 精选写真图库' },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.site_name).toBe('星耀传媒')
    expect(body.seo_title).toBe('')
  })

  it('清空历史默认站点名称，避免前台继续显示脚手架品牌', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_name', value: 'MeiGallery' },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.site_name).toBe('')
  })

  it('保留后台显式保存的自定义 SEO 标题', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_name', value: '星耀传媒' },
        { key: 'seo_title', value: '星耀传媒 - 官方图库' },
        { key: 'seo_keywords', value: '授权图库，写真,授权图库,#时尚写真' },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.seo_title).toBe('星耀传媒 - 官方图库')
    expect(body.seo_keywords).toBe('授权图库,写真,时尚写真')
  })

  it('返回服务端派生的首页广告展示状态', async () => {
    const activeEnv = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'home_ad_enabled', value: 'true' },
        { key: 'home_ad_starts_at', value: '2000-01-01T00:00:00.000Z' },
        { key: 'home_ad_ends_at', value: '2099-01-01T00:00:00.000Z' },
      ]),
    } as unknown as Bindings
    const inactiveEnv = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'home_ad_enabled', value: 'true' },
        { key: 'home_ad_starts_at', value: '2000-01-01T00:00:00.000Z' },
        { key: 'home_ad_ends_at', value: '2000-01-02T00:00:00.000Z' },
      ]),
    } as unknown as Bindings

    const activeRes = await app.fetch(new Request('https://api.test/api/settings/public'), activeEnv, {} as ExecutionContext)
    const activeBody = await activeRes.json()
    const inactiveRes = await app.fetch(new Request('https://api.test/api/settings/public'), inactiveEnv, {} as ExecutionContext)
    const inactiveBody = await inactiveRes.json()

    expect(activeRes.status).toBe(200)
    expect(activeBody.home_ad_active).toBe(true)
    expect(inactiveRes.status).toBe(200)
    expect(inactiveBody.home_ad_active).toBe(false)
  })

  it('返回过滤后的首页多广告配置', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([], [
        {
          id: 'ad-1',
          eyebrow: '  本周   推荐  ',
          title: '会员季精选内容',
          summary: '探索本周精选图库',
          cta_label: '查看推荐',
          target_url: '/discover?sort=hot',
          sponsor: '运营精选',
          image_url: '/api/media/public/home-ads/ad-1/cover.webp',
          sort_order: 1,
        },
        {
          id: 'ad-2',
          title: '危险广告',
          target_url: 'javascript:alert(1)',
          sort_order: 2,
        },
        {
          id: 'ad-3',
          title: '已过期广告',
          target_url: '/discover?sort=hot',
          ends_at: '2000-01-01T00:00:00.000Z',
          sort_order: 3,
        },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.home_ads).toEqual([
      {
        id: 'ad-1',
        eyebrow: '本周 推荐',
        title: '会员季精选内容',
        summary: '探索本周精选图库',
        ctaLabel: '查看推荐',
        targetUrl: '/discover?sort=hot',
        sponsor: '运营精选',
        imageUrl: '/api/media/public/home-ads/ad-1/cover.webp',
        sortOrder: 1,
      },
    ])
  })
})
