import { describe, expect, it } from 'vitest'
import { buildMetaCapiUserData, normalizeMetaBrowserIdentifiers } from './meta-browser-identifiers'

describe('Meta 浏览器标识校验', () => {
  it('接受顶层合法 fbp/fbc，并拒绝控制字符与超长值', () => {
    expect(normalizeMetaBrowserIdentifiers({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
    })).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
    })
    expect(normalizeMetaBrowserIdentifiers({ fbp: 'bad\nvalue', fbc: 'x'.repeat(300) })).toEqual({})
  })

  it('仅合并四个 allow-list 字段，并拒绝含控制字符或超长的 IP 与 User-Agent', () => {
    const request = new Request('https://api.example.test/api/conversions/events', {
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'MeiGallery Test Browser/1.0',
      },
    })
    expect(buildMetaCapiUserData(request, {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      ignored: 'must-not-pass',
    })).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
    })

    expect(buildMetaCapiUserData({
      headers: {
        get(name: string) {
          return name === 'CF-Connecting-IP' ? `${'1'.repeat(65)}\n` : `${'a'.repeat(513)}\n`
        },
      },
    } as Request, {})).toEqual({})
  })
})
