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
        { key: 'og_image', value: 'http://example.com/og.jpg' },
        { key: 'home_ad_url', value: 'https://example.com/%0Ajavascript:alert(1)' },
        { key: 'rules_page_url', value: 'https://example.com/rules' },
        { key: 'facebook_pixel_id', value: 'fbq("track")' },
        { key: 'home_ad_enabled', value: 'true' },
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
  })
})
