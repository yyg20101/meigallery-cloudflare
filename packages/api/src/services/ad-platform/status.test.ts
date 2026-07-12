import { describe, expect, it, vi } from 'vitest'
import { listAdPlatformConnections } from './status'

vi.mock('../meta-connection', () => ({
  getMetaConnectionStatus: vi.fn(async () => ({
    state: 'verified',
    environment: 'production',
    pixelIdConfigured: true,
    tokenConfigured: true,
    testEventCodeConfigured: true,
    trackingMode: 'test',
    verifiedAt: '2026-07-12T00:00:00.000Z',
    verifiedCommit: 'a'.repeat(40),
  })),
}))

describe('广告平台连接状态', () => {
  it('通过统一契约暴露 Meta 状态而不泄漏凭证', async () => {
    const result = await listAdPlatformConnections({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              provider: 'meta', enabled: 1, mode: 'test', browser_enabled: 1,
              server_enabled: 1, destination_id: '1234567890', debug_enabled: 0,
              rollout_percentage: 0, credential_secret_name: 'META_CAPI_ACCESS_TOKEN', revision: null,
            }),
          }),
        }),
      },
    } as never)
    expect(result).toEqual([expect.objectContaining({
      provider: 'meta',
      environment: 'production',
      destinationConfigured: true,
      serverCredentialConfigured: true,
      state: 'verified',
      mode: 'test',
    })])
    expect(JSON.stringify(result)).not.toMatch(/accessToken|credentialValue/i)
  })
})
