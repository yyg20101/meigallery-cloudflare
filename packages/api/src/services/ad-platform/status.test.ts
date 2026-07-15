import { describe, expect, it, vi } from 'vitest'
import { attributionConnectionSnapshotRows } from '../../test/ad-platform-fixture'
import { listAdPlatformConnections } from './status'

vi.mock('../meta-connection', () => ({
  getMetaConnectionStatus: vi.fn(async () => ({
    state: 'verified',
    environment: 'production',
    pixelIdConfigured: true,
    tokenConfigured: true,
    trackingMode: 'test',
    verifiedAt: '2026-07-12T00:00:00.000Z',
    verifiedCommit: 'a'.repeat(40),
  })),
}))

vi.mock('../tiktok-connection', () => ({
  getTikTokConnectionStatus: vi.fn(async () => ({
    state: 'unverified',
    pixelIdConfigured: true,
    tokenConfigured: false,
    trackingMode: 'test',
    verifiedAt: '',
    revision: '',
  })),
}))

describe('广告平台连接状态', () => {
  it('通过统一契约暴露 Meta 状态而不泄漏凭证', async () => {
    const result = await listAdPlatformConnections({
      DB: {
        prepare: () => {
          let provider = ''
          return {
            bind(value: string) { provider = value; return this },
            async all() {
              const configs = {
                meta: { pixelId: '1234567890' },
                tiktok: { pixelCode: 'C123456789ABCDEF' },
                google: { tagId: 'AW-123456789', customerId: '1234567890', cloudProjectId: 'meigallery-ads' },
              } as const
              const config = configs[provider as keyof typeof configs]
              return {
                results: config
                  ? attributionConnectionSnapshotRows({
                      provider: provider as keyof typeof configs,
                      publicConfig: config,
                      mode: 'test',
                    })
                  : [],
              }
            },
          }
        },
      },
    } as never)
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({
      provider: 'meta',
      environment: 'production',
      destinationConfigured: true,
      serverCredentialConfigured: true,
      serverQueueConfigured: false,
      serverDataKeyConfigured: false,
      state: 'verified',
      mode: 'test',
    }), expect.objectContaining({
      provider: 'tiktok',
      serverQueueConfigured: false,
      serverDataKeyConfigured: false,
      state: 'unverified',
    })]))
    expect(result.map(connection => connection.provider)).toEqual(['meta', 'tiktok', 'google'])
    expect(JSON.stringify(result)).not.toMatch(/accessToken|credentialValue/i)
  })
})
