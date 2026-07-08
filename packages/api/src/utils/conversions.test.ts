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
})
