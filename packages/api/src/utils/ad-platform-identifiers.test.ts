import { describe, expect, it } from 'vitest'
import {
  buildAdPlatformUserData,
  hashAdPlatformEmail,
  hashAdPlatformExternalId,
  normalizeAdPlatformNetworkContext,
  normalizeAdPlatformBrowserIdentifiers,
} from './ad-platform-identifiers'

describe('广告平台用户匹配标识', () => {
  it('同时接受合法 Meta 与 TikTok 浏览器标识', () => {
    expect(normalizeAdPlatformBrowserIdentifiers({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      ttclid: 'E.C.P.example-click',
      ttp: 'cookie-id-123',
    })).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      ttclid: 'E.C.P.example-click',
      ttp: 'cookie-id-123',
    })
  })

  it('拒绝控制字符、超长值和未知字段', () => {
    expect(normalizeAdPlatformBrowserIdentifiers({
      ttclid: `E.C.P.bad\nvalue`,
      ttp: 'x'.repeat(257),
      accessToken: 'secret',
    })).toEqual({})
  })

  it('拒绝非对象输入并接受无原型的安全标识对象', () => {
    expect(normalizeAdPlatformBrowserIdentifiers(null)).toEqual({})
    expect(normalizeAdPlatformBrowserIdentifiers([])).toEqual({})

    const identifiers = Object.create(null) as Record<string, unknown>
    identifiers.ttclid = 'E.C.P.null-prototype'
    expect(normalizeAdPlatformBrowserIdentifiers(identifiers)).toEqual({
      ttclid: 'E.C.P.null-prototype',
    })
  })

  it('只从可信请求头补齐 IP 与 User-Agent', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        'CF-Connecting-IP': '203.0.113.8',
        'User-Agent': 'MeiGallery-Test/1.0',
      },
    })
    expect(buildAdPlatformUserData(request, { ttclid: 'E.C.P.click' })).toEqual({
      ttclid: 'E.C.P.click',
      clientIpAddress: '203.0.113.8',
      clientUserAgent: 'MeiGallery-Test/1.0',
    })
  })

  it('网络匹配上下文必须是合法 IP 与 User-Agent 完整组合', () => {
    expect(normalizeAdPlatformNetworkContext({
      clientIpAddress: '2001:db8::1',
      clientUserAgent: 'MeiGallery-Test/1.0',
    })).toEqual({
      clientIpAddress: '2001:db8::1',
      clientUserAgent: 'MeiGallery-Test/1.0',
    })
    expect(normalizeAdPlatformNetworkContext({
      clientIpAddress: '999.0.0.1',
      clientUserAgent: 'MeiGallery-Test/1.0',
    })).toEqual({})
    expect(normalizeAdPlatformNetworkContext({
      clientIpAddress: '203.0.113.8',
    })).toEqual({})
    expect(normalizeAdPlatformNetworkContext({
      clientIpAddress: '203.0.113.8',
      clientUserAgent: 'bad\nagent',
    })).toEqual({})
  })

  it('按平台要求规范化并散列邮箱和外部 ID', async () => {
    await expect(hashAdPlatformEmail(' User@Example.COM '))
      .resolves.toBe('b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514')
    await expect(hashAdPlatformExternalId('external-id-1'))
      .resolves.toMatch(/^[0-9a-f]{64}$/)
  })

  it('散列入口对空值和非法类型统一失败', async () => {
    await expect(hashAdPlatformEmail('   ')).rejects.toThrow('AD_PLATFORM_IDENTIFIER_INVALID')
    await expect(hashAdPlatformEmail(null as never)).rejects.toThrow('AD_PLATFORM_IDENTIFIER_INVALID')
    await expect(hashAdPlatformExternalId('')).rejects.toThrow('AD_PLATFORM_IDENTIFIER_INVALID')
    await expect(hashAdPlatformExternalId(null as never)).rejects.toThrow('AD_PLATFORM_IDENTIFIER_INVALID')
  })
})
