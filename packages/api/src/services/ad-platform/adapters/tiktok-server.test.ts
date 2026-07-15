import { describe, expect, it, vi } from 'vitest'
import { buildTikTokServerPayload, sendTikTokServerEvent } from './tiktok-server'

const input = {
  provider: 'tiktok' as const,
  canonicalEvent: 'CompleteRegistration' as const,
  externalEventId: 'mg3_tiktok_event_1',
  eventTime: 1_784_256_123,
  pageUrl: 'https://meigallery.example/register',
  destination: 'tiktok_events_api',
  matchSignals: { ttclid: 'tt-click-id', ttp: 'ttp-cookie' },
  hashedEmail: 'b'.repeat(64),
}

describe('TikTok 服务端 Adapter', () => {
  it('按 Events API 契约构造 Payload', () => {
    expect(buildTikTokServerPayload(input, 'pixel_code_1')).toEqual({
      pixel_code: 'pixel_code_1', event: 'CompleteRegistration', event_id: 'mg3_tiktok_event_1',
      timestamp: '2026-07-17T02:42:03.000Z',
      context: { page: { url: 'https://meigallery.example/register' }, ad: { callback: 'tt-click-id' }, user: { ttp: 'ttp-cookie', email: 'b'.repeat(64) } },
    })
  })

  it('token 只放在 Access-Token header，结果不泄露 token 或响应体', async () => {
    const fetcher = vi.fn(async () => new Response('{"code":0,"message":"very-secret-token"}', { status: 200 }))
    const outcome = await sendTikTokServerEvent({ input, config: { pixelCode: 'pixel_code_1' }, accessToken: 'very-secret-token', fetcher })
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toContain('/pixel/track/')
    expect(init?.headers).toEqual({ 'Access-Token': 'very-secret-token', 'Content-Type': 'application/json' })
    expect(JSON.stringify(init?.body)).not.toContain('very-secret-token')
    expect(JSON.stringify(outcome)).not.toContain('very-secret-token')
    expect(outcome).toEqual({ classification: 'accepted', receipt: { status: 200 } })
  })

  it.each([['fbc'], ['fbp'], ['gclid'], ['gbraid'], ['wbraid']])('拒绝跨平台 %s', async signal => {
    const outcome = await sendTikTokServerEvent({ input: { ...input, matchSignals: { ...input.matchSignals, [signal]: 'cross-platform-id' } }, config: { pixelCode: 'pixel_code_1' }, accessToken: 'very-secret-token', fetcher: vi.fn() })
    expect(outcome).toEqual({ classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } })
  })

  it.each([[403, 'credential_invalid'], [429, 'retryable'], [500, 'retryable'], [422, 'destination_invalid'], [418, 'rejected']] as const)('按状态码分类 %i', async (status, classification) => {
    const outcome = await sendTikTokServerEvent({ input, config: { pixelCode: 'pixel_code_1' }, accessToken: 'very-secret-token', fetcher: vi.fn(async () => new Response('secret', { status })) })
    expect(outcome).toEqual({ classification, receipt: { status } })
  })
})
