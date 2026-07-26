import { describe, expect, it } from 'vitest'
import {
  getAdPlatformDefinition,
  getAdPlatformAdapter,
  listAdPlatformProviders,
  mapConversionToPlatformEvent,
} from './registry'

describe('广告平台 adapter registry', () => {
  it('为三个 provider 声明投递能力', () => {
    expect(listAdPlatformProviders()).toEqual(['meta', 'tiktok', 'google'])

    for (const provider of listAdPlatformProviders()) {
      expect(getAdPlatformAdapter(provider).transports).toEqual(['browser', 'server'])
    }
  })

  it('返回包含平台投递描述的事件映射', () => {
    expect(mapConversionToPlatformEvent('meta', 'contact')).toMatchObject({
      provider: 'meta',
      canonicalEvent: 'Contact',
      browserEventName: 'Contact',
    })
    expect(mapConversionToPlatformEvent('tiktok', 'complete_registration')).toMatchObject({
      provider: 'tiktok',
      canonicalEvent: 'CompleteRegistration',
      browserEventName: 'CompleteRegistration',
    })
  })

  it('为 Google 两个事件使用 conversion 名称和不同 browser destination', () => {
    const contact = mapConversionToPlatformEvent('google', 'contact')
    const registration = mapConversionToPlatformEvent('google', 'complete_registration')

    expect(contact.browserEventName).toBe('conversion')
    expect(registration.browserEventName).toBe('conversion')
    expect(contact.browserDestination).not.toBe(registration.browserDestination)
  })

  it('由平台注册表严格校验公开配置', () => {
    expect(getAdPlatformDefinition('meta')?.publicConfigSchema.parse({ pixelId: '123456789012345' })).toEqual({ pixelId: '123456789012345' })
    expect(getAdPlatformDefinition('meta')?.publicConfigSchema.parse({ pixelId: 'pixel_1' })).toBeNull()
    expect(getAdPlatformDefinition('tiktok')?.publicConfigSchema.parse({ pixelCode: 'ABCDEF123456' })).toEqual({ pixelCode: 'ABCDEF123456' })
    expect(getAdPlatformDefinition('google')?.publicConfigSchema.parse({
      tagId: 'AW-123456789',
      customerId: '1234567890',
      cloudProjectId: 'gallery-project',
    })).toMatchObject({ tagId: 'AW-123456789' })
  })

  it('由平台注册表解析事件目标，核心调用方无需判断 provider', () => {
    const google = getAdPlatformDefinition('google')!
    const config = { tagId: 'AW-123456789', customerId: '1234567890', cloudProjectId: 'gallery-project' }
    const contact = google.resolveEventBinding({
      canonicalEvent: 'Contact',
      publicConfig: config,
      browserDestination: 'AW-123456789/CONTACT_LABEL',
      serverDestination: '123456789',
    })
    const registration = google.resolveEventBinding({
      canonicalEvent: 'CompleteRegistration',
      publicConfig: config,
      browserDestination: 'AW-123456789/REGISTRATION_LABEL',
      serverDestination: '987654321',
    })

    expect(contact).toEqual({ browserDestination: 'AW-123456789/CONTACT_LABEL', serverDestination: '123456789' })
    expect(google.resolveEventBinding({
      canonicalEvent: 'Contact',
      publicConfig: config,
      browserDestination: 'AW-OTHER/CONTACT_LABEL',
      serverDestination: '123456789',
    })).toBeNull()
    expect(google.validateEventBindingSet([
      { canonicalEvent: 'Contact', ...contact! },
      { canonicalEvent: 'CompleteRegistration', ...registration! },
    ])).toBe(true)
  })
})
