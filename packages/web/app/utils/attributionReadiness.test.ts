import { describe, expect, it } from 'vitest'
import { canEnableMetaCapi, serializeReadinessSettingRows, serializeReadinessVerificationRows } from './attributionReadiness'

describe('attributionReadiness', () => {
  it.each([
    ['无数据', [], false],
    ['仅有 warning', [{ level: 'warning', ok: true }], false],
    ['blocker 全通过', [{ level: 'blocker', ok: true }, { level: 'warning', ok: false }], true],
    ['存在失败 blocker', [{ level: 'blocker', ok: true }, { level: 'blocker', ok: false }], false],
  ] as const)('%s时保持保守判断', (_label, checks, expected) => {
    expect(canEnableMetaCapi(checks)).toBe(expected)
  })

  it('只展示发布检查允许的归因配置', () => {
    const rows = serializeReadinessSettingRows({
      analytics_enabled: true,
      facebook_pixel_enabled: false,
      facebook_pixel_id: '1234567890',
      meta_capi_enabled: true,
      meta_tracking_mode: 'production',
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
    expect(rows.find(row => row.key === 'meta_tracking_mode')?.value).toBe('生产')
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
