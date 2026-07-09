import { describe, expect, it } from 'vitest'
import { serializeReadinessSettingRows } from './attributionReadiness'

describe('attributionReadiness', () => {
  it('只展示发布检查允许的归因配置', () => {
    const rows = serializeReadinessSettingRows({
      analytics_enabled: true,
      facebook_pixel_enabled: false,
      facebook_pixel_id: '1234567890',
      meta_capi_enabled: true,
      meta_tracking_mode: 'limited',
      meta_capi_access_token: 'secret-token',
    })

    expect(rows.map(row => row.key)).toEqual([
      'analytics_enabled',
      'facebook_pixel_enabled',
      'facebook_pixel_id',
      'meta_capi_enabled',
      'meta_tracking_mode',
    ])
    expect(rows.map(row => row.value)).not.toContain('secret-token')
    expect(rows.find(row => row.key === 'analytics_enabled')?.value).toBe('已开启')
  })
})
