import { describe, expect, it } from 'vitest'
import { normalizeFeaturedRegionSlugs, normalizeHomeHotTagLimit, normalizeRulesMarkdown, safeFeaturedRegionSlugs, safeHomeHotTagLimit, safeRulesMarkdown } from './site-content-settings'

describe('站点内容设置校验', () => {
  it('归一化首页热门标签数量', () => {
    expect(normalizeHomeHotTagLimit('')).toBe('15')
    expect(normalizeHomeHotTagLimit(' 12 ')).toBe('12')
    expect(normalizeHomeHotTagLimit(30)).toBe('30')
    expect(safeHomeHotTagLimit('not-a-number')).toBe('15')
  })

  it('拒绝无效首页热门标签数量', () => {
    for (const value of ['0', '31', '1.5', 'abc']) {
      expect(() => normalizeHomeHotTagLimit(value)).toThrow('首页热门标签数量')
    }
  })

  it('归一化主推地区 slug 列表并去重', () => {
    expect(normalizeFeaturedRegionSlugs(' Canada,domestic,canada,toronto-city ')).toBe('canada,domestic,toronto-city')
    expect(normalizeFeaturedRegionSlugs('')).toBe('')
    expect(safeFeaturedRegionSlugs('Canada,DOMESTIC')).toBe('canada,domestic')
  })

  it('拒绝无效主推地区 slug 列表', () => {
    expect(() => normalizeFeaturedRegionSlugs('canada,../admin')).toThrow('主推地区 slug')
    expect(() => normalizeFeaturedRegionSlugs(Array.from({ length: 13 }, (_, index) => `tag-${index}`).join(','))).toThrow('主推地区最多配置')
    expect(safeFeaturedRegionSlugs('canada,../admin')).toBe('')
  })

  it('归一化规则 Markdown 并限制危险内容长度', () => {
    expect(normalizeRulesMarkdown('## 规则\r\n\r\n- 内容', '规则页 Markdown 正文')).toBe('## 规则\n\n- 内容')
    expect(normalizeRulesMarkdown(null, '规则页 Markdown 正文')).toBe('')
    expect(() => normalizeRulesMarkdown('规则\u0001内容', '规则页 Markdown 正文')).toThrow('规则页 Markdown 正文不能包含控制字符')
    expect(() => normalizeRulesMarkdown('x'.repeat(8001), '规则页 Markdown 正文')).toThrow('规则页 Markdown 正文不能超过 8000 个字符')
    expect(safeRulesMarkdown('x'.repeat(8001))).toBe('')
  })
})
