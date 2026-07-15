import { describe, expect, it, vi } from 'vitest'
import { buildTikTokServerPayload, sendTikTokServerEvent } from './tiktok-server'

const EVENT_ID = `mg3_${'t'.repeat(43)}`
const input = {
  provider: 'tiktok' as const, canonicalEvent: 'CompleteRegistration' as const, externalEventId: EVENT_ID,
  eventTime: 1_784_256_123, pageUrl: 'https://meigallery.example/register', destination: 'tiktok_events_api',
  matchSignals: { ttclid: 'tt-click-id', ttp: 'ttp-cookie' }, hashedEmail: 'b'.repeat(64),
}

describe('TikTok 服务端 Adapter', () => {
  it('按 Events 2.0 v1.3 契约构造 Payload，且不接受 Test Event Code', () => {
    const payload = buildTikTokServerPayload({ ...input, testEventCode: 'must-not-be-accepted' } as typeof input, 'ABCDEF0123')
    expect(payload).toEqual({ event_source: 'web', event_source_id: 'ABCDEF0123', data: [{ event: 'CompleteRegistration', event_time: 1_784_256_123, event_id: EVENT_ID, user: { ttclid: 'tt-click-id', ttp: 'ttp-cookie', email: ['b'.repeat(64)] }, page: { url: 'https://meigallery.example/register' } }] })
    expect(payload).not.toHaveProperty('pixel_code')
    expect(payload).not.toHaveProperty('timestamp')
    expect(payload).not.toHaveProperty('test_event_code')
    expect(JSON.stringify(payload)).not.toContain('callback')
  })

  it('允许仅使用哈希邮箱作为有效匹配键', () => {
    expect(buildTikTokServerPayload({ ...input, matchSignals: {} }, 'ABCDEF0123').data[0]?.user).toEqual({ email: ['b'.repeat(64)] })
  })

  it('token 只放在 Access-Token header，并保存安全 request_id', async () => {
    const fetcher = vi.fn(async () => new Response('{"code":0,"request_id":"request_123","message":"very-secret-token"}', { status: 200 }))
    const outcome = await sendTikTokServerEvent({ input, config: { pixelCode: 'ABCDEF0123' }, accessToken: 'very-secret-token', fetcher })
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/')
    expect(init?.headers).toEqual({ 'Access-Token': 'very-secret-token', 'Content-Type': 'application/json' })
    expect(JSON.stringify(init?.body)).not.toContain('very-secret-token')
    expect(JSON.stringify(outcome)).not.toContain('very-secret-token')
    expect(outcome).toEqual({ classification: 'accepted', receipt: { status: 200, requestId: 'request_123' } })
  })

  it.each([['fbc'], ['fbp'], ['gclid'], ['gbraid'], ['wbraid']])('拒绝跨平台 %s', async signal => {
    const outcome = await sendTikTokServerEvent({ input: { ...input, matchSignals: { ...input.matchSignals, [signal]: 'cross-platform-id' } }, config: { pixelCode: 'ABCDEF0123' }, accessToken: 'very-secret-token', fetcher: vi.fn() })
    expect(outcome).toEqual({ classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } })
  })

  it.each([[403, 'credential_invalid'], [429, 'retryable'], [500, 'retryable'], [422, 'destination_invalid'], [418, 'rejected']] as const)('按 HTTP 状态码分类 %i', async (status, classification) => {
    const outcome = await sendTikTokServerEvent({ input, config: { pixelCode: 'ABCDEF0123' }, accessToken: 'very-secret-token', fetcher: vi.fn(async () => new Response('secret', { status })) })
    expect(outcome).toEqual({ classification, receipt: { status } })
  })

  it.each([[0, 'accepted'], [40101, 'credential_invalid'], [40016, 'retryable'], [50001, 'retryable'], [40099, 'destination_invalid']] as const)('按 HTTP 200 业务码分类 %i', async (code, classification) => {
    const outcome = await sendTikTokServerEvent({ input, config: { pixelCode: 'ABCDEF0123' }, accessToken: 'very-secret-token', fetcher: vi.fn(async () => new Response(JSON.stringify({ code, request_id: 'click-id:must-not-leak', message: 'very-secret-token' }), { status: 200 })) })
    expect(outcome).toEqual({ classification, receipt: { status: 200 } })
    expect(JSON.stringify(outcome)).not.toContain('very-secret-token')
    expect(JSON.stringify(outcome)).not.toContain('click-id')
  })

  it.each([
    [{ ...input, matchSignals: {}, hashedEmail: undefined }, { pixelCode: 'ABCDEF0123' }],
    [{ ...input, externalEventId: 'legacy-id' }, { pixelCode: 'ABCDEF0123' }],
    [{ ...input, eventTime: Number.NaN }, { pixelCode: 'ABCDEF0123' }],
    [{ ...input, eventTime: 4_102_444_800 }, { pixelCode: 'ABCDEF0123' }],
    [{ ...input, pageUrl: 'https://user:pass@meigallery.example/register' }, { pixelCode: 'ABCDEF0123' }],
    [input, { pixelCode: 'pixel_code_1' }],
  ] as const)('拒绝空匹配或非法边界，且不调用 fetch', async (invalidInput, config) => {
    const fetcher = vi.fn()
    await expect(sendTikTokServerEvent({ input: invalidInput, config, accessToken: 'very-secret-token', fetcher })).resolves.toEqual({ classification: 'destination_invalid' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
