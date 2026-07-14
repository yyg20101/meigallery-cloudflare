import { describe, expect, it } from 'vitest'
import {
  clearTikTokClickIdCookie,
  readAdPlatformBrowserIdentifiers,
  tikTokClickIdCookie,
} from './adPlatformBrowserIdentifiers'

describe('广告平台浏览器标识', () => {
  it('读取 Meta 与 TikTok 合法标识并优先采用当前点击参数', () => {
    expect(readAdPlatformBrowserIdentifiers(
      '_fbp=fb.1.1700000000000.123456789; _ttp=ttp%2Dcookie; mg_ttclid=stored-click',
      { fbclid: 'CLICK_abc-123', ttclid: 'current-click' },
      1_700_000_000_000,
    )).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      ttclid: 'current-click',
      ttp: 'ttp-cookie',
    })
  })

  it('回退到已保存标识并拒绝控制字符与超长值', () => {
    expect(readAdPlatformBrowserIdentifiers(
      '_fbc=fb.1.1700000000000.saved-click; mg_ttclid=stored-click',
      { fbclid: `${'x'.repeat(129)}\n`, ttclid: 'bad\nclick' },
      1_700_000_000_000,
    )).toEqual({ fbc: 'fb.1.1700000000000.saved-click', ttclid: 'stored-click' })
  })

  it('仅为合法 ttclid 生成短期安全 Cookie，并支持清除', () => {
    expect(tikTokClickIdCookie('click/value')).toContain('mg_ttclid=click%2Fvalue; Max-Age=2592000;')
    expect(tikTokClickIdCookie('bad\nvalue')).toBe('')
    expect(clearTikTokClickIdCookie()).toContain('mg_ttclid=; Max-Age=0;')
  })
})
