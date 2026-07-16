import { describe, expect, it, vi } from 'vitest'
import { deliverServerEvent, getServerTrackingAdapter } from './server-adapter'

describe('服务端 Adapter 注册表', () => {
  it('按 provider 查表选择 Adapter，未知 provider fail closed', async () => {
    expect(getServerTrackingAdapter('meta')?.provider).toBe('meta')
    expect(getServerTrackingAdapter('tiktok')?.provider).toBe('tiktok')
    expect(getServerTrackingAdapter('google')?.provider).toBe('google')
    expect(getServerTrackingAdapter('unknown')).toBeNull()
    await expect(deliverServerEvent({
      input: { provider: 'unknown' as never, canonicalEvent: 'Contact', externalEventId: 'mg3_unknown', eventTime: 1_784_256_123, pageUrl: 'https://meigallery.example/', destination: 'x', matchSignals: {}, consent: { consentVersion: 1, marketingAllowed: true, adUserDataAllowed: true, adPersonalizationAllowed: true, decidedAt: '2026-07-17T02:40:00.000Z' } },
      config: {}, credential: 'secret', fetcher: vi.fn(),
    })).resolves.toEqual({ classification: 'rejected', incident: { code: 'server_adapter_unavailable', severity: 'critical' } })
  })
})
