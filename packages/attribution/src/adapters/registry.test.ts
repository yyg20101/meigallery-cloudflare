import { describe, expect, it } from 'vitest'
import { AttributionDomainError } from '../domain/errors'
import {
  getProviderAdapter,
  listProviderAdapters,
} from './registry'

describe('Provider Adapter 注册表', () => {
  it('只注册 Meta、TikTok 和 Google 且每个平台只有一个实现', () => {
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
  })

  it('未知平台明确拒绝，不做默认或广播投递', () => {
    expect(() => getProviderAdapter('unknown')).toThrow(
      new AttributionDomainError('ATTRIBUTION_PROVIDER_UNSUPPORTED'),
    )
  })
})
