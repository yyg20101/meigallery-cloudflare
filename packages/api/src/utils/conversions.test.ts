import { describe, expect, it } from 'vitest'
import {
  buildConversionDedupeKey,
  buildExternalEventId,
  sanitizeConversionMetadata,
  metaEventForConversion,
} from './conversions'

describe('conversion utils', () => {
  it('为同一业务动作生成稳定 dedupe key 和 external event id', () => {
    const input = {
      actionType: 'contact' as const,
      sessionId: 'session_abc',
      visitorId: 'visitor_abc',
      occurredDate: '2026-07-09',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
    }
    expect(buildConversionDedupeKey(input)).toBe('contact:session_abc:telegram:floating_contact_panel')
    expect(buildExternalEventId({ ...input, metaEventName: 'Contact' })).toBe(
      'meta:Contact:contact:session_abc:telegram:floating_contact_panel',
    )
  })

  it('注册成功映射 CompleteRegistration 且不映射 StartTrial', () => {
    expect(metaEventForConversion('complete_registration')).toBe('CompleteRegistration')
    expect(metaEventForConversion('start_trial')).toBe('StartTrial')
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
      channel: 'meta_capi',
    })

    expect(sanitized).toEqual({
      asset_code: 'asset_1',
      channel: 'meta_capi',
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
})
