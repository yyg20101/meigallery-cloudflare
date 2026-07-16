import { describe, expect, it, vi } from 'vitest'
import { META_GRAPH_API_VERSION } from '../protocol-versions'
import { buildMetaServerPayload, sendMetaServerEvent } from './meta-server'

const EVENT_ID = `mg3_${'m'.repeat(43)}`
const input = {
  provider: 'meta' as const, canonicalEvent: 'Contact' as const, externalEventId: EVENT_ID,
  eventTime: 1_784_256_123, pageUrl: 'https://meigallery.example/contact', destination: 'meta_capi',
  matchSignals: { fbc: 'fb.1.1784256123000.click', fbp: 'fb.1.123.browser' }, hashedEmail: 'a'.repeat(64),
  consent: { consentVersion: 1, marketingAllowed: true, adUserDataAllowed: true, adPersonalizationAllowed: true, decidedAt: '2026-07-17T02:40:00.000Z' },
}

describe('Meta 服务端 Adapter', () => {
  it('按 CAPI 契约构造事件、去重 ID 和允许的匹配数据', () => {
    expect(buildMetaServerPayload(input)).toEqual({
      data: [{ event_name: 'Contact', event_time: 1_784_256_123, event_id: EVENT_ID, action_source: 'website', event_source_url: 'https://meigallery.example/contact', user_data: { fbc: 'fb.1.1784256123000.click', fbp: 'fb.1.123.browser', em: ['a'.repeat(64)] } }],
    })
  })

  it('允许仅使用哈希邮箱作为有效匹配键', () => {
    expect(buildMetaServerPayload({ ...input, matchSignals: {} }).data[0]?.user_data).toEqual({ em: ['a'.repeat(64)] })
  })

  it('从统一版本模块构造端点，token 只在请求体且不向结果泄露敏感响应', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events_received: 1, access_token: 'leaked-token' }), { status: 200 }))
    const outcome = await sendMetaServerEvent({ input, config: { pixelId: '123456789012345' }, accessToken: 'very-secret-token', fetcher })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/123456789012345/events`)
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ access_token: 'very-secret-token', data: [{ event_id: EVENT_ID }] })
    expect(JSON.stringify(outcome)).not.toContain('very-secret-token')
    expect(JSON.stringify(outcome)).not.toContain('leaked-token')
    expect(outcome).toEqual({ classification: 'accepted', receipt: { status: 200 } })
  })

  it.each([['ttclid'], ['ttp'], ['gclid'], ['gbraid'], ['wbraid']])('拒绝跨平台 %s 并提供无敏感 critical incident', async signal => {
    const outcome = await sendMetaServerEvent({ input: { ...input, matchSignals: { ...input.matchSignals, [signal]: 'cross-platform-id' } }, config: { pixelId: '123456789012345' }, accessToken: 'very-secret-token', fetcher: vi.fn() })
    expect(outcome).toEqual({ classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } })
  })

  it.each([[401, 'credential_invalid'], [429, 'retryable'], [503, 'retryable'], [404, 'destination_invalid'], [400, 'destination_invalid'], [409, 'rejected']] as const)('按状态码分类 %i', async (status, classification) => {
    const outcome = await sendMetaServerEvent({ input, config: { pixelId: '123456789012345' }, accessToken: 'very-secret-token', fetcher: vi.fn(async () => new Response('{"error":{"message":"very-secret-token"}}', { status })) })
    expect(outcome).toEqual({ classification, receipt: { status } })
  })

  it.each([
    [{ error: { code: 190, error_subcode: 463, message: 'very-secret-token' } }, 'credential_invalid'],
    [{ error: { code: 4, is_transient: true, message: 'very-secret-token' } }, 'retryable'],
  ] as const)('解析安全 Meta 错误分类而不泄露正文', async (body, classification) => {
    const outcome = await sendMetaServerEvent({ input, config: { pixelId: '123456789012345' }, accessToken: 'very-secret-token', fetcher: vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })) })
    expect(outcome).toEqual({ classification, receipt: { status: 400 } })
    expect(JSON.stringify(outcome)).not.toContain('very-secret-token')
  })

  it.each([
    [{ ...input, matchSignals: {}, hashedEmail: undefined }, { pixelId: '123456789012345' }],
    [{ ...input, externalEventId: 'legacy-id' }, { pixelId: '123456789012345' }],
    [{ ...input, eventTime: 1.5 }, { pixelId: '123456789012345' }],
    [{ ...input, eventTime: 4_102_444_800 }, { pixelId: '123456789012345' }],
    [{ ...input, pageUrl: 'https://user:pass@meigallery.example/contact' }, { pixelId: '123456789012345' }],
    [input, { pixelId: 'pixel_1' }],
  ] as const)('拒绝空匹配或非法边界，且不调用 fetch', async (invalidInput, config) => {
    const fetcher = vi.fn()
    await expect(sendMetaServerEvent({ input: invalidInput, config, accessToken: 'very-secret-token', fetcher })).resolves.toEqual({ classification: 'destination_invalid' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
