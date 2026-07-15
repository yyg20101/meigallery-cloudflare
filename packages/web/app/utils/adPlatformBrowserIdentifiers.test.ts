import { describe, expect, it } from 'vitest'
import {
  clearProjectAdClickCookies,
  projectAdClickCookie,
  readAdPlatformBrowserIdentifiers,
} from './adPlatformBrowserIdentifiers'

describe('广告平台浏览器标识严格隔离', () => {
  it('Meta 只读取 Meta 参数和 Cookie', () => {
    expect(readAdPlatformBrowserIdentifiers(
      'meta',
      '_fbp=fb.1.1700000000000.123456789; _ttp=tiktok-cookie; mg_ttclid=stored-tiktok',
      { fbclid: 'CLICK_abc-123', ttclid: 'current-tiktok', gclid: 'google-click' },
      1_700_000_000_000,
    )).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
    })
  })

  it('TikTok 只读取 TikTok 参数和 Cookie', () => {
    expect(readAdPlatformBrowserIdentifiers(
      'tiktok',
      '_fbp=fb.1.1700000000000.123456789; _ttp=ttp%2Dcookie; mg_ttclid=stored-click',
      { fbclid: 'meta-click', ttclid: 'current-click', gclid: 'google-click' },
    )).toEqual({ ttclid: 'current-click', ttp: 'ttp-cookie' })
  })

  it('Google 不读取 Meta 或 TikTok 标识且浏览器 instruction 不收集 Google Click ID', () => {
    expect(readAdPlatformBrowserIdentifiers(
      'google',
      '_fbp=fb.1.1700000000000.123456789; _ttp=tiktok-cookie; mg_ttclid=stored-tiktok',
      { fbclid: 'meta-click', ttclid: 'tiktok-click', gclid: 'google-click' },
    )).toEqual({})
  })

  it('只为当前 TikTok 来源持久化项目 click cookie，且撤回授权可统一清理', () => {
    expect(projectAdClickCookie('meta', { ttclid: 'tiktok-click' })).toBe('')
    expect(projectAdClickCookie('google', { ttclid: 'tiktok-click' })).toBe('')
    expect(projectAdClickCookie('tiktok', { ttclid: 'click/value' })).toContain('mg_ttclid=click%2Fvalue; Max-Age=2592000;')
    expect(clearProjectAdClickCookies()).toEqual([
      'mg_ttclid=; Max-Age=0; Path=/; SameSite=Lax; Secure',
    ])
  })

  it('读取工具不修改用户输入的 URL 参数对象', () => {
    const clickIds = { fbclid: 'meta-click', ttclid: 'tiktok-click', gclid: 'google-click' }
    const original = { ...clickIds }

    readAdPlatformBrowserIdentifiers('meta', '', clickIds)

    expect(clickIds).toEqual(original)
  })
})
