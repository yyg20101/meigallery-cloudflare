import { describe, expect, it } from 'vitest'
import app from '../index'
import type { Bindings } from '../index'

type SettingRow = { key: string; value: unknown } | { key: string; rawValue: string }

function createDb(rows: SettingRow[]) {
  return {
    prepare() {
      return {
        bind() {
          return this
        },
        async all<T>() {
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
  it('过滤历史危险公开 URL 和 Pixel 设置', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_icon', value: 'javascript:alert(1)' },
        { key: 'og_image', value: 'https://example.com/%5Cog.jpg' },
        { key: 'home_ad_url', value: '/api/media/public/site/icon.png' },
        { key: 'rules_page_url', value: '/rules%5Cnext' },
        { key: 'facebook_pixel_id', value: 'fbq("track")' },
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
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(body.site_icon).toBe('')
    expect(body.og_image).toBe('')
    expect(body.home_ad_url).toBe('')
    expect(body.rules_page_url).toBe('')
    expect(body.facebook_pixel_id).toBe('')
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
    expect(res.headers.get('Cache-Control')).toBe('no-store')
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

  it('保留后台显式保存的自定义 SEO 标题', async () => {
    const env = {
      APP_ENV: 'production',
      DB: createDb([
        { key: 'site_name', value: '星耀传媒' },
        { key: 'seo_title', value: '星耀传媒 - 官方图库' },
      ]),
    } as unknown as Bindings

    const res = await app.fetch(new Request('https://api.test/api/settings/public'), env, {} as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.seo_title).toBe('星耀传媒 - 官方图库')
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
})
