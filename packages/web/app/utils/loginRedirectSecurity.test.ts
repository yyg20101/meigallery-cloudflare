import { describe, expect, it } from 'vitest'
import { normalizeLoginRedirect } from './loginRedirectSecurity'

describe('登录重定向安全处理', () => {
  it('允许安全站内路径并保留后台登录回跳', () => {
    expect(normalizeLoginRedirect('/')).toBe('/')
    expect(normalizeLoginRedirect('/user')).toBe('/user')
    expect(normalizeLoginRedirect('/admin/settings?tab=seo')).toBe('/admin/settings?tab=seo')
    expect(normalizeLoginRedirect('/gallery/summer-portrait#media')).toBe('/gallery/summer-portrait#media')
  })

  it('拒绝外站、资源路径和凭证类参数', () => {
    for (const url of [
      'https://example.com/account',
      '//example.com/account',
      '/api/me',
      '/api/settings/public',
      '/_nuxt/entry.js',
      '/cdn-cgi/trace',
      '/user?access_token=abc',
      '/user#token=abc',
      '/login?redirect=',
      '/login?redirect=https%3A%2F%2Fevil.example%2Faccount',
      '/login?redirect=/api/me',
      '/login?redirect=%2Flogin%3Fredirect%3Dhttps%253A%252F%252Fevil.example%252Faccount',
      '/user\\profile',
      '/user%5Cprofile',
      '/user next',
    ]) {
      expect(normalizeLoginRedirect(url)).toBe('/')
    }
  })

  it('拒绝多值 redirect 参数', () => {
    expect(normalizeLoginRedirect(['/user', '/admin'])).toBe('/')
  })
})
