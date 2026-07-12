import { describe, expect, it } from 'vitest'
import {
  getAdPlatformAdapter,
  mapConversionToPlatformEvent,
} from './registry'

describe('广告平台 adapter registry', () => {
  it('Meta 通过通用事件映射复用唯一业务事实', () => {
    expect(mapConversionToPlatformEvent('meta', 'contact')).toBe('Contact')
    expect(mapConversionToPlatformEvent('meta', 'complete_registration')).toBe('CompleteRegistration')
    expect(getAdPlatformAdapter('meta').transports).toEqual(['browser', 'server'])
  })
})
