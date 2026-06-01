import { describe, expect, it } from 'vitest'
import app from '../index'
import type { Bindings } from '../index'

function createDb(rows: Array<{ key: string; value: unknown }>) {
  return {
    prepare() {
      return {
        bind() {
          return this
        },
        async all<T>() {
          return { results: rows.map(row => ({ key: row.key, value: JSON.stringify(row.value) })) as T[] }
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
        { key: 'home_ad_url', value: 'https:\\\\example.com\\campaign' },
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
})
