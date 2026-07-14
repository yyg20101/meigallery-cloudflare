import { describe, expect, it, vi } from 'vitest'
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
        prepare: () => ({
          all: async () => ({
            results: [{
              provider: 'meta', enabled: 1, mode: 'test', browser_enabled: 1,
              server_enabled: 1, destination_id: '1234567890', debug_enabled: 0,
              rollout_percentage: 0, credential_secret_name: 'META_CAPI_ACCESS_TOKEN', revision: null,
            }, {
              provider: 'tiktok', enabled: 1, mode: 'test', browser_enabled: 1,
              server_enabled: 0, destination_id: 'C123456789ABCDEF', debug_enabled: 0,
              rollout_percentage: 0, credential_secret_name: '', revision: null,
            }],
          }),
        }),
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
    expect(result.map(connection => connection.provider)).toEqual(['meta', 'tiktok'])
    expect(JSON.stringify(result)).not.toMatch(/accessToken|credentialValue/i)
  })
})
