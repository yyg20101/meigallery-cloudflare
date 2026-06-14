import { describe, expect, it } from 'vitest'
import { emailTemplates } from './email-templates'

describe('邮件模板安全渲染', () => {
  it('新图库通知会转义标题并归一化安全链接', () => {
    const result = emailTemplates.newGallery(
      '夏日 <img src=x onerror=alert(1)> "精选"',
      'HTTPS://example.com/gallery?next="x"',
      'HTTPS://example.com/cover.jpg?next="x"',
    )

    expect(result.html).toContain('夏日 &lt;img src=x onerror=alert(1)&gt; &quot;精选&quot;')
    expect(result.html).toContain('href="https://example.com/gallery?next=%22x%22"')
    expect(result.html).toContain('src="https://example.com/cover.jpg?next=%22x%22"')
    expect(result.html).not.toContain('<img src=x onerror')
    expect(result.text).toContain('https://example.com/gallery?next=%22x%22')
  })

  it('新图库通知拒绝危险跳转和封面地址', () => {
    const result = emailTemplates.newGallery(
      '标题\r\nBcc: attacker@example.com',
      'javascript:alert(1)',
      'https://127.0.0.1/cover.jpg',
      { siteName: '星耀传媒' },
    )

    expect(result.subject).toBe('[星耀传媒] 新内容发布：标题 Bcc: attacker@example.com')
    expect(result.subject).not.toMatch(/[\r\n]/)
    expect(result.html).toContain('href="https://616618.xyz"')
    expect(result.html).not.toContain('<img src=')
    expect(result.text).toBe('[星耀传媒] 新内容发布：标题 Bcc: attacker@example.com — https://616618.xyz')
  })

  it('会员到期和验证码模板会转义可变内容', () => {
    const membership = emailTemplates.membershipExpiry('VIP<script>alert(1)</script>', '2026-06-01T00:00:00Z', { siteName: '星耀<站点>' })
    const registration = emailTemplates.registrationCode('123<svg/onload=alert(1)>', { siteName: '星耀<站点>' })

    expect(membership.html).toContain('VIP&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(membership.html).not.toContain('<script>alert(1)</script>')
    expect(membership.html).toContain('星耀&lt;站点&gt;')
    expect(registration.html).toContain('123&lt;svg/onload=alert(1)&gt;')
    expect(registration.html).not.toContain('<svg/onload=alert(1)>')
  })

  it('未传站点上下文时使用中性站名兜底', () => {
    const result = emailTemplates.passwordResetCode('123456')

    expect(result.subject).toBe('[图库站] 密码重置验证码')
    expect(result.text).toContain('[图库站]')
  })
})
