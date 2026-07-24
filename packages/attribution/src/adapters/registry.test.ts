import { describe, expect, it } from 'vitest'
import { AttributionDomainError } from '../domain/errors'
import {
  getProviderAdapter,
  getProviderCredentialType,
  listProviderAdapters,
} from './registry'

describe('归因平台 adapter 注册表', () => {
  it('统一声明 adapter 与凭证类型', () => {
    const adapters = listProviderAdapters()

    expect(adapters.map(adapter => adapter.provider)).toEqual([
      'meta',
      'tiktok',
      'google',
    ])
    expect(new Set(adapters).size).toBe(3)
    expect(getProviderAdapter('meta')).toBe(adapters[0])
    expect(getProviderAdapter('tiktok')).toBe(adapters[1])
    expect(getProviderAdapter('google')).toBe(adapters[2])
    expect(getProviderCredentialType('meta')).toBe('access_token')
    expect(getProviderCredentialType('tiktok')).toBe('access_token')
    expect(getProviderCredentialType('google')).toBe('service_account_json')
  })

  it('未知平台明确拒绝，不做默认或广播投递', () => {
    expect(() => getProviderAdapter('unknown')).toThrow(
      new AttributionDomainError('ATTRIBUTION_PROVIDER_UNSUPPORTED'),
    )
    expect(() => getProviderCredentialType('unknown'))
      .toThrow(
        new AttributionDomainError('ATTRIBUTION_PROVIDER_UNSUPPORTED'),
      )
  })
})
