import { describe, expect, it } from 'vitest'
import { escapeHtml, renderInlineMarkdown, renderSafeMarkdown } from './safeMarkdown'

describe('safeMarkdown', () => {
  it('转义 HTML 内容', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('只把 https Markdown 链接渲染为安全外链', () => {
    const html = renderInlineMarkdown('[规则](https://example.com/rules?next="x")')

    expect(html).toBe('<a href="https://example.com/rules?next=%22x%22" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">规则</a>')
  })

  it('不把 http 或 javascript Markdown 链接渲染为可点击链接', () => {
    const html = renderInlineMarkdown('[旧链接](http://example.com) [危险](javascript:alert(1))')

    expect(html).toContain('[旧链接](http://example.com)')
    expect(html).toContain('[危险](javascript:alert(1))')
    expect(html).not.toContain('<a href=')
  })

  it('转义 Markdown 链接文案并保留加粗语法', () => {
    const html = renderInlineMarkdown('[**规则** <img src=x>](https://example.com/rules)')

    expect(html).toBe('<a href="https://example.com/rules" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer"><strong>规则</strong> &lt;img src=x&gt;</a>')
  })

  it('拒绝包含空白或控制字符的 Markdown 链接', () => {
    const html = renderInlineMarkdown('[规则](https://example.com/a%0Ajavascript:alert(1)) [空白](https://example.com/a b)')

    expect(html).toContain('[规则](https://example.com/a%0Ajavascript:alert(1))')
    expect(html).toContain('[空白](https://example.com/a b)')
    expect(html).not.toContain('<a href=')
  })

  it('拒绝指向本机或私网地址的 Markdown 链接', () => {
    const html = renderInlineMarkdown([
      '[本机](https://localhost/rules)',
      '[尾点本机](https://localhost./rules)',
      '[编码尾点本机](https://localhost%2e/rules)',
      '[回环](https://127.0.0.1/rules)',
      '[私网](https://192.168.1.10/rules)',
      '[本地域](https://example.local/rules)',
      '[尾点本地域](https://example.local./rules)',
    ].join(' '))

    expect(html).toContain('[本机](https://localhost/rules)')
    expect(html).toContain('[尾点本机](https://localhost./rules)')
    expect(html).toContain('[编码尾点本机](https://localhost%2e/rules)')
    expect(html).toContain('[回环](https://127.0.0.1/rules)')
    expect(html).toContain('[私网](https://192.168.1.10/rules)')
    expect(html).toContain('[本地域](https://example.local/rules)')
    expect(html).toContain('[尾点本地域](https://example.local./rules)')
    expect(html).not.toContain('<a href=')
  })

  it('拒绝带凭据或反斜杠歧义的 Markdown 链接', () => {
    const html = renderInlineMarkdown([
      '[凭据](https://user:pass@example.com/rules)',
      '[反斜杠](https://example.com\\@evil.test/rules)',
      '[编码反斜杠](https://example.com/%5Crules)',
    ].join(' '))

    expect(html).toContain('[凭据](https://user:pass@example.com/rules)')
    expect(html).toContain('[反斜杠](https://example.com\\@evil.test/rules)')
    expect(html).toContain('[编码反斜杠](https://example.com/%5Crules)')
    expect(html).not.toContain('<a href=')
  })

  it('渲染安全的标题、列表和加粗语法', () => {
    const html = renderSafeMarkdown('## 入站规则\n\n- **仅限授权内容**\n- [完整规则](https://example.com/rules)')

    expect(html).toContain('<h2>入站规则</h2>')
    expect(html).toContain('<li><strong>仅限授权内容</strong></li>')
    expect(html).toContain('<a href="https://example.com/rules" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">完整规则</a>')
  })
})
