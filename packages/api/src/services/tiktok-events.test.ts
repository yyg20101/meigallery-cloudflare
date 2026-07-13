import { describe, expect, it } from 'vitest'
import {
  buildTikTokEventsPayload,
  isRetryableTikTokEventsError,
  isTikTokCredentialError,
  isTikTokEventsSuccess,
  readTikTokEventsResponse,
  tiktokEventsRequestInit,
} from './tiktok-events'

describe('TikTok Events API 2.0 协议', () => {
  it('构造可去重的 Web Contact 事件', () => {
    expect(buildTikTokEventsPayload({
      pixelId: 'C1234567890',
      eventName: 'Contact',
      eventId: 'event-contact-1',
      eventTime: 1_700_000_000,
      pageUrl: 'https://616618.xyz/contact?ttclid=click',
      userData: {
        ttclid: 'E.C.P.example-click',
        ttp: 'cookie-id-123',
        clientIpAddress: '203.0.113.8',
        clientUserAgent: 'MeiGallery-Test/1.0',
        emailSha256: 'a'.repeat(64),
      },
    })).toEqual({
      event_source: 'web',
      event_source_id: 'C1234567890',
      data: [{
        event: 'Contact',
        event_time: 1_700_000_000,
        event_id: 'event-contact-1',
        user: {
          ttclid: 'E.C.P.example-click',
          ttp: 'cookie-id-123',
          ip: '203.0.113.8',
          user_agent: 'MeiGallery-Test/1.0',
        },
        page: { url: 'https://616618.xyz/contact?ttclid=click' },
      }],
    })
  })

  it('CompleteRegistration 才发送散列邮箱与外部 ID', () => {
    const payload = buildTikTokEventsPayload({
      pixelId: 'C1234567890',
      eventName: 'CompleteRegistration',
      eventId: 'event-registration-1',
      eventTime: 1_700_000_000,
      pageUrl: 'https://616618.xyz/register',
      userData: { emailSha256: 'a'.repeat(64), externalIdSha256: 'b'.repeat(64) },
      testEventCode: 'TEST_123',
    })
    expect(payload).toMatchObject({
      test_event_code: 'TEST_123',
      data: [{ user: { email: 'a'.repeat(64), external_id: 'b'.repeat(64) } }],
    })
  })

  it('生产 payload 默认不包含 test_event_code', () => {
    const payload = buildTikTokEventsPayload({
      pixelId: 'C1234567890', eventName: 'Contact', eventId: 'event-1',
      eventTime: 1_700_000_000, pageUrl: 'https://616618.xyz/',
    })
    expect(payload).not.toHaveProperty('test_event_code')
  })

  it('只保留允许的事件属性与合法 referrer', () => {
    const payload = buildTikTokEventsPayload({
      pixelId: 'c1234567890',
      eventName: 'Contact',
      eventId: 'event-properties',
      eventTime: 1_700_000_000.9,
      pageUrl: 'http://example.com/contact',
      pageReferrer: 'https://example.com/source',
      properties: {
        description: '  联系   Telegram  ',
        search_string: true,
        ignored: 'private',
        value: Number.POSITIVE_INFINITY,
      },
    }) as { data: Array<Record<string, unknown>> }
    expect(payload.data[0]).toMatchObject({
      event_time: 1_700_000_000,
      page: { url: 'http://example.com/contact', referrer: 'https://example.com/source' },
      properties: { description: '联系 Telegram', search_string: true },
    })
  })

  it.each([
    [{ pixelId: '', pageUrl: 'https://616618.xyz/', eventTime: 1, eventId: 'event' }, 'TIKTOK_EVENTS_PIXEL_ID_INVALID'],
    [{ pixelId: 'C1234567890', pageUrl: 'ftp://616618.xyz/', eventTime: 1, eventId: 'event' }, 'TIKTOK_EVENTS_PAGE_URL_INVALID'],
    [{ pixelId: 'C1234567890', pageUrl: 'https://616618.xyz/', eventTime: 0, eventId: 'event' }, 'TIKTOK_EVENTS_TIME_INVALID'],
    [{ pixelId: 'C1234567890', pageUrl: 'https://616618.xyz/', eventTime: 1, eventId: '' }, 'TIKTOK_EVENTS_EVENT_ID_INVALID'],
  ] as const)('拒绝非法 payload 输入 %#', (partial, code) => {
    expect(() => buildTikTokEventsPayload({
      eventName: 'Contact',
      ...partial,
    })).toThrow(code)
  })

  it('拒绝非法测试码和空 token', () => {
    expect(() => buildTikTokEventsPayload({
      pixelId: 'C1234567890', eventName: 'Contact', eventId: 'event-1',
      eventTime: 1_700_000_000, pageUrl: 'https://616618.xyz/', testEventCode: 'bad code',
    })).toThrow('TIKTOK_EVENTS_TEST_CODE_INVALID')
    expect(() => tiktokEventsRequestInit('', {})).toThrow('TIKTOK_EVENTS_ACCESS_TOKEN_MISSING')
  })

  it('token 仅进入 Access-Token header', () => {
    const init = tiktokEventsRequestInit('secret-token', { event_source: 'web' })
    expect(init.headers).toEqual({ 'Access-Token': 'secret-token', 'Content-Type': 'application/json' })
    expect(init.body).not.toContain('secret-token')
  })

  it('以 TikTok code=0 判断成功，并区分重试与凭证错误', async () => {
    const response = new Response(JSON.stringify({ code: 0, message: 'OK', request_id: 'req-1' }), { status: 200 })
    const parsed = await readTikTokEventsResponse(response)
    expect(isTikTokEventsSuccess(response, parsed)).toBe(true)
    expect(isRetryableTikTokEventsError(200, 40100)).toBe(true)
    expect(isRetryableTikTokEventsError(200, 50002)).toBe(true)
    expect(isRetryableTikTokEventsError(200, 40002)).toBe(false)
    expect(isTikTokCredentialError(40105)).toBe(true)
    expect(isTikTokCredentialError(null, 401)).toBe(true)
    expect(isTikTokCredentialError(null, 403)).toBe(true)
    expect(isTikTokCredentialError(null, 400)).toBe(false)
  })

  it('容错解析异常响应并覆盖 HTTP 重试边界', async () => {
    await expect(readTikTokEventsResponse(new Response('{bad json', { status: 502 }))).resolves.toEqual({
      code: null,
      message: '',
      requestId: '',
    })
    await expect(readTikTokEventsResponse(new Response(JSON.stringify({ code: '0', message: 123 })))).resolves.toEqual({
      code: null,
      message: '',
      requestId: '',
    })
    expect(isRetryableTikTokEventsError(429, null)).toBe(true)
    expect(isRetryableTikTokEventsError(503, null)).toBe(true)
    expect(isRetryableTikTokEventsError(400, 40002)).toBe(false)
  })
})
