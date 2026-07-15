import { describe, expect, it, vi } from 'vitest'
import { buildMetaServerPayload, sendMetaServerEvent } from './meta-server'

const input = {
  provider: 'meta' as const,
  canonicalEvent: 'Contact' as const,
  externalEventId: 'mg3_meta_event_1',
  eventTime: 1_784_256_123,
  pageUrl: 'https://meigallery.example/contact',
  destination: 'meta_capi',
  matchSignals: { fbc: 'fb.1.1784256123000.click', fbp: 'fb.1.123.browser' },
  hashedEmail: 'a'.repeat(64),
}

describe('Meta 服务端 Adapter', () => {
  it('按 CAPI 契约构造事件、去重 ID 和允许的匹配数据', () => {
    expect(buildMetaServerPayload(input)).toEqual({
      data: [{
        event_name: 'Contact', event_time: 1_784_256_123, event_id: 'mg3_meta_event_1',
        action_source: 'website', event_source_url: 'https://meigallery.example/contact',
        user_data: { fbc: 'fb.1.1784256123000.click', fbp: 'fb.1.123.browser', em: ['a'.repeat(64)] },
      }],
    })
  })

  it('只通过请求体携带 token，且不向结果泄露敏感响应', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events_received: 1, access_token: 'leaked-token' }), { status: 200 }))
    const outcome = await sendMetaServerEvent({ input, config: { pixelId: 'pixel_1' }, accessToken: 'very-secret-token', fetcher })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toContain('/pixel_1/events')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ access_token: 'very-secret-token', data: [{ event_id: input.externalEventId }] })
    expect(JSON.stringify(outcome)).not.toContain('very-secret-token')
    expect(JSON.stringify(outcome)).not.toContain('leaked-token')
    expect(outcome).toEqual({ classification: 'accepted', receipt: { status: 200 } })
  })

  it.each([['ttclid'], ['ttp'], ['gclid'], ['gbraid'], ['wbraid']])('拒绝跨平台 %s 并提供无敏感 critical incident', async signal => {
    const outcome = await sendMetaServerEvent({
      input: { ...input, matchSignals: { ...input.matchSignals, [signal]: 'cross-platform-id' } },
      config: { pixelId: 'pixel_1' }, accessToken: 'very-secret-token', fetcher: vi.fn(),
    })
    expect(outcome).toEqual({ classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } })
  })

  it.each([
    [401, 'credential_invalid'], [429, 'retryable'], [503, 'retryable'], [404, 'destination_invalid'], [400, 'destination_invalid'], [409, 'rejected'],
  ] as const)('按状态码分类 %i', async (status, classification) => {
    const outcome = await sendMetaServerEvent({ input, config: { pixelId: 'pixel_1' }, accessToken: 'very-secret-token', fetcher: vi.fn(async () => new Response('{"error":{"message":"very-secret-token"}}', { status })) })
    expect(outcome).toEqual({ classification, receipt: { status } })
  })
})
