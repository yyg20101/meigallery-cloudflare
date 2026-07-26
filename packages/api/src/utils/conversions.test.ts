import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ActiveConversionActionType, AdPlatformConversionEventName } from '@meigallery/shared'
import {
  buildConversionDedupeKey,
  buildExternalEventIdBasis,
} from '@meigallery/shared/utils'
import {
  buildExternalEventId,
  sanitizeConversionMetadata,
} from './conversions'
import {
  ACTIVE_AD_PLATFORM_CONVERSION_EVENTS,
  ACTIVE_CONVERSION_ACTIONS,
  ATTRIBUTION_LIMITS,
} from '@meigallery/shared/constants'

describe('conversion utils', () => {
  it('外部投递事件 ID 输入只接受活动动作和平台转化事件', async () => {
    type ExternalEventInput = Parameters<typeof buildExternalEventIdBasis>[0]
    expectTypeOf<ExternalEventInput['actionType']>().toEqualTypeOf<ActiveConversionActionType>()
    expectTypeOf<ExternalEventInput['eventName']>().toEqualTypeOf<AdPlatformConversionEventName>()

    const eventId = await buildExternalEventId('stable-server-secret', {
      actionType: 'complete_registration',
      eventName: 'CompleteRegistration',
      userId: 42,
      sessionId: 'session_a',
      visitorId: 'visitor_a',
      occurredDate: '2026-07-10',
    })
    expect(eventId).toMatch(/^mg:v2:CompleteRegistration:[0-9a-f]{64}$/)
    expect(eventId).not.toContain('user:42')

    expect(() => buildExternalEventIdBasis({
      actionType: 'lead',
      eventName: 'Lead',
      sessionId: 'session_a',
      visitorId: 'visitor_a',
      occurredDate: '2026-07-10',
    } as never)).toThrow('外部投递只允许活动转化事件')
  })

  it('共享契约生成稳定事件 ID', async () => {
    const input = {
      actionType: 'contact' as const,
      sessionId: 'session_abc',
      visitorId: 'visitor_abc',
      occurredDate: '2026-07-10',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
    }
    expect(buildConversionDedupeKey(input)).toBe('contact:session_abc:telegram:floating_contact_panel')
    expect(buildExternalEventIdBasis({ ...input, eventName: 'Contact' })).toBe(
      'Contact:contact:session_abc:telegram:floating_contact_panel',
    )
    const first = await buildExternalEventId('stable-server-secret', { ...input, eventName: 'Contact' })
    const second = await buildExternalEventId('stable-server-secret', { ...input, eventName: 'Contact' })
    expect(first).toBe(second)
    expect(first).not.toContain('session_abc')
  })

  it('活动广告平台契约只包含联系和注册', () => {
    expectTypeOf<ActiveConversionActionType>().toEqualTypeOf<'contact' | 'complete_registration'>()
    expectTypeOf<AdPlatformConversionEventName>().toEqualTypeOf<'Contact' | 'CompleteRegistration'>()
    expect(ACTIVE_CONVERSION_ACTIONS).toEqual(['contact', 'complete_registration'])
    expect(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS).toEqual(['Contact', 'CompleteRegistration'])
  })

  it('注册事件按服务端用户 ID 生成稳定去重键', () => {
    expect(buildConversionDedupeKey({
      actionType: 'complete_registration',
      userId: 42,
      sessionId: 'session_a',
      visitorId: 'visitor_a',
      occurredDate: '2026-07-10',
    })).toBe('complete_registration:user:42')
  })

  it('历史动作仅使用统一的确定性读取 fallback', () => {
    expect(buildConversionDedupeKey({
      actionType: 'lead',
      sessionId: 'session_a',
      visitorId: 'visitor_a',
      occurredDate: '2026-07-10',
    })).toBe('historical:lead:visitor_a:session_a:2026-07-10')
  })

  it('清洗 payload 时移除敏感字段', () => {
    const sanitized = sanitizeConversionMetadata({
      email: 'user@example.test',
      phone: '123',
      contactValue: '@secret',
      method_type: 'telegram',
      location: 'floating_contact_panel',
      token: 'secret',
      private_url: '/api/media/originals/x.jpg',
    })
    expect(sanitized).toEqual({
      method_type: 'telegram',
      location: 'floating_contact_panel',
    })
  })

  it('清洗 payload 时移除广告平台标识与客户端网络标识', () => {
    const sanitized = sanitizeConversionMetadata({
      fbp: 'fb.1.123',
      fbc: 'fb.1.456',
      ttclid: 'tiktok-click-private',
      ttp: 'tiktok-browser-private',
      client_ip_address: '203.0.113.8',
      clientIpAddress: '203.0.113.9',
      client_user_agent: 'browser-a',
      clientUserAgent: 'browser-b',
      user_agent: 'browser-c',
      method_type: 'telegram',
    })

    expect(sanitized).toEqual({ method_type: 'telegram' })
  })

  it('清洗 payload 时移除会员备注和后台审计详情字段', () => {
    const sanitized = sanitizeConversionMetadata({
      membership_note: '用户私密备注',
      admin_path: '/admin/users/88',
      admin_action_detail: '授予 svip 365 天',
      operator_note_text: '后台人工补单',
      action_result: 'granted',
      route_name: 'admin-membership-grant',
    })

    expect(sanitized).toEqual({
      action_result: 'granted',
      route_name: 'admin-membership-grant',
    })
  })

  it('清洗 payload 时移除 stream token 和私有后台路径值', () => {
    const sanitized = sanitizeConversionMetadata({
      stream_token: 'stream-secret',
      playbackToken: 'playback-secret',
      preview_path: '/admin/imports/jobs/1',
      media_path: '/api/media/protected/asset_1/access',
      asset_code: 'asset_1',
      transport: 'server',
    })

    expect(sanitized).toEqual({
      asset_code: 'asset_1',
      transport: 'server',
    })
  })

  it('清洗 payload 时对大小写变体敏感字段做等价拦截', () => {
    const sanitized = sanitizeConversionMetadata({
      Email: 'user@example.test',
      PHONE: '123',
      contact_value_text: '@hidden',
      Session_Token: 'session-secret',
      Method_Type: 'telegram',
      LOCATION: 'floating_contact_panel',
    })

    expect(sanitized).toEqual({
      Method_Type: 'telegram',
      LOCATION: 'floating_contact_panel',
    })
  })

  it('清洗安全 key 的字符串值时脱敏邮箱、手机号、URL 和凭据参数', () => {
    const sanitized = sanitizeConversionMetadata({
      safe_summary: '来源 user@example.test 手机 13800138000 查看 https://example.com/a?token=abc 搜索 api_key=secret&style=summer',
    })

    expect(sanitized.safe_summary).toContain('[redacted_email]')
    expect(sanitized.safe_summary).toContain('[redacted_phone]')
    expect(sanitized.safe_summary).toContain('[redacted_url]')
    expect(sanitized.safe_summary).toContain('api_key=[redacted_credential]&style=summer')
    expect(sanitized.safe_summary).not.toContain('user@example.test')
    expect(sanitized.safe_summary).not.toContain('13800138000')
    expect(sanitized.safe_summary).not.toContain('https://example.com/a?token=abc')
    expect(sanitized.safe_summary).not.toContain('secret')
  })

  it('清洗安全 key 的字符串值时脱敏常见联系方式 handle', () => {
    const sanitized = sanitizeConversionMetadata({
      contact_hint: '联系 微信 wxid_abc123 / telegram @abc123 / line: abc123 / QQ 123456 / wx wxid_more123 / tg: alpha_123 / whatsapp: wa_abc123',
      source_name: 'telegram-june',
      method_type: 'telegram',
    })

    expect(sanitized.contact_hint).toContain('[redacted_contact]')
    expect(sanitized.contact_hint).not.toContain('wxid_abc123')
    expect(sanitized.contact_hint).not.toContain('@abc123')
    expect(sanitized.contact_hint).not.toContain('line: abc123')
    expect(sanitized.contact_hint).not.toContain('QQ 123456')
    expect(sanitized.contact_hint).not.toContain('wxid_more123')
    expect(sanitized.contact_hint).not.toContain('alpha_123')
    expect(sanitized.contact_hint).not.toContain('wa_abc123')
    expect(sanitized.source_name).toBe('telegram-june')
    expect(sanitized.method_type).toBe('telegram')
  })

  it('清洗 payload 时移除凭据类字段名', () => {
    const sanitized = sanitizeConversionMetadata({
      api_key: 'secret-api-key',
      credential: 'credential-value',
      JWT: 'jwt-value',
      cookie_signature: 'cookie-value',
      safe_name: 'telegram june',
    })

    expect(sanitized).toEqual({
      safe_name: 'telegram june',
    })
  })

  it('清洗联系方式时不误删普通广告来源名', () => {
    const sanitized = sanitizeConversionMetadata({
      source_name: 'telegram june',
      source_alias: 'tg boost',
      line_name: 'line summer',
      whatsapp_name: 'whatsapp campaign',
    })

    expect(sanitized).toEqual({
      source_name: 'telegram june',
      source_alias: 'tg boost',
      line_name: 'line summer',
      whatsapp_name: 'whatsapp campaign',
    })
  })

  it('清洗 payload 时保留普通安全值并继续限制字符串长度', () => {
    const longText = '清新夏日'.repeat(40)
    const sanitized = sanitizeConversionMetadata({
      style: '清新 夏日 户外',
      long_text: longText,
    })

    expect(sanitized.style).toBe('清新 夏日 户外')
    expect(sanitized.long_text).toBe(longText.slice(0, ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH))
    expect(String(sanitized.long_text)).toHaveLength(ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH)
  })
})
