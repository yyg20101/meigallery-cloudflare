import { describe, expect, it } from 'vitest'
import { serializeReadinessSettingRows, serializeReadinessVerificationRows } from './attributionReadiness'

describe('attributionReadiness', () => {
  it('只展示发布检查允许的归因配置', () => {
    const rows = serializeReadinessSettingRows({
      analytics_enabled: true,
      enabled: true,
      browser_enabled: true,
      server_enabled: true,
      destination_configured: true,
      mode: 'production',
      meta_capi_access_token: 'secret-token',
    })

    expect(rows.map(row => row.key)).toEqual([
      'analytics_enabled',
      'enabled',
      'browser_enabled',
      'server_enabled',
      'destination_configured',
      'mode',
    ])
    expect(rows.map(row => row.value)).not.toContain('secret-token')
    expect(rows.find(row => row.key === 'analytics_enabled')?.value).toBe('已开启')
    expect(rows.find(row => row.key === 'mode')?.value).toBe('生产')
  })

  it('只序列化 Meta live 与资源验证时间，不暴露额外字段', () => {
    const rows = serializeReadinessVerificationRows({
      environment: 'dev',
      releaseCommitPresent: true,
      metaLive: {
        present: true,
        verifiedAt: '2026-07-10T08:00:00.000Z',
        expiresAt: '2026-07-11T08:00:00.000Z',
        secret: 'never-show-live-secret',
      },
      metaResources: {
        present: true,
        verifiedAt: '2026-07-10T08:05:00.000Z',
        expiresAt: '2026-07-11T08:05:00.000Z',
        token: 'never-show-resource-token',
      },
    })

    expect(rows).toEqual([
      {
        key: 'meta_live',
        label: 'Meta live 验证',
        present: true,
        verifiedAt: '2026-07-10T08:00:00.000Z',
        expiresAt: '2026-07-11T08:00:00.000Z',
      },
      {
        key: 'meta_resources',
        label: 'Meta 资源验证',
        present: true,
        verifiedAt: '2026-07-10T08:05:00.000Z',
        expiresAt: '2026-07-11T08:05:00.000Z',
      },
    ])
    expect(JSON.stringify(rows)).not.toContain('never-show')
  })
})
