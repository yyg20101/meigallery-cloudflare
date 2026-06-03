import { describe, expect, it } from 'vitest'
import { WEB_SECURITY_HEADERS } from './securityHeaders'

describe('Web 安全响应头', () => {
  it('默认拒绝被第三方页面嵌入并收紧来源页策略', () => {
    expect(WEB_SECURITY_HEADERS['X-Frame-Options']).toBe('DENY')
    expect(WEB_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff')
    expect(WEB_SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
  })

  it('默认关闭与图库浏览无关的敏感浏览器能力', () => {
    expect(WEB_SECURITY_HEADERS['Permissions-Policy']).toContain('camera=()')
    expect(WEB_SECURITY_HEADERS['Permissions-Policy']).toContain('microphone=()')
    expect(WEB_SECURITY_HEADERS['Permissions-Policy']).toContain('geolocation=()')
    expect(WEB_SECURITY_HEADERS['Permissions-Policy']).toContain('payment=()')
  })
})
