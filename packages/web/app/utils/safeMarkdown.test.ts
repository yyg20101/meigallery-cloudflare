import { describe, expect, it } from 'vitest'
import { escapeHtml, renderInlineMarkdown, renderSafeMarkdown } from './safeMarkdown'

describe('safeMarkdown', () => {
  it('转义 HTML 内容', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('只把 https Markdown 链接渲染为安全外链', () => {
    const html = renderInlineMarkdown('[规则](https://example.com/rules)')

    expect(html).toBe('<a href="https://example.com/rules" target="_blank" rel="noopener noreferrer">规则</a>')
  })

  it('不把 http 或 javascript Markdown 链接渲染为可点击链接', () => {
    const html = renderInlineMarkdown('[旧链接](http://example.com) [危险](javascript:alert(1))')

    expect(html).toContain('[旧链接](http://example.com)')
    expect(html).toContain('[危险](javascript:alert(1))')
    expect(html).not.toContain('<a href=')
  })

  it('渲染安全的标题、列表和加粗语法', () => {
    const html = renderSafeMarkdown('## 入站规则\n\n- **仅限授权内容**\n- [完整规则](https://example.com/rules)')

    expect(html).toContain('<h2>入站规则</h2>')
    expect(html).toContain('<li><strong>仅限授权内容</strong></li>')
    expect(html).toContain('<a href="https://example.com/rules" target="_blank" rel="noopener noreferrer">完整规则</a>')
  })
})
