import { describe, expect, it } from 'vitest'
import {
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
})
