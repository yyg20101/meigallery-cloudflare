import { describe, it, expect } from 'vitest'
import { normalizeSearchParams, buildSearchQuery } from './search-query'

describe('normalizeSearchParams', () => {
  it('空参数返回默认值', () => {
    const result = normalizeSearchParams({}, 100, 20)
    expect(result).toEqual({ keyword: '', tagSlugs: [], page: 1, pageSize: 20 })
  })

  it('解析关键词并去空格', () => {
    const result = normalizeSearchParams({ q: '  夏日  ' }, 100, 20)
    expect(result.keyword).toBe('夏日')
  })

  it('解析标签并过滤空值', () => {
    const result = normalizeSearchParams({ tag: 'outdoor,,fashion,' }, 100, 20)
    expect(result.tagSlugs).toEqual(['outdoor', 'fashion'])
  })

  it('页码最小为 1', () => {
    const result = normalizeSearchParams({ page: '-5' }, 100, 20)
    expect(result.page).toBe(1)
  })

  it('pageSize 不超过最大值', () => {
    const result = normalizeSearchParams({ pageSize: '500' }, 100, 20)
    expect(result.pageSize).toBe(100)
  })

  it('pageSize 最小为 1', () => {
    const result = normalizeSearchParams({ pageSize: '0' }, 100, 20)
    expect(result.pageSize).toBe(1)
  })

  it('无效数字回退为默认值', () => {
    const result = normalizeSearchParams({ page: 'abc', pageSize: 'xyz' }, 100, 20)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(20)
  })
})

describe('buildSearchQuery', () => {
  it('仅发布状态过滤（无关键词无标签）', () => {
    const result = buildSearchQuery({ keyword: '', tagSlugs: [], page: 1, pageSize: 20 })
    expect(result.countSql).toContain("g.status = ?")
    expect(result.countParams).toEqual(['published'])
    expect(result.dataParams).toEqual(['published', 20, 0])
    expect(result.dataSql).toContain('DISTINCT')
    expect(result.dataSql).toContain('LIMIT ? OFFSET ?')
  })

  it('关键词搜索添加 LIKE 条件', () => {
    const result = buildSearchQuery({ keyword: '夏日', tagSlugs: [], page: 1, pageSize: 20 })
    expect(result.countSql).toContain('g.title LIKE ?')
    expect(result.countSql).toContain('g.summary LIKE ?')
    expect(result.countParams).toContain('%夏日%')
    expect(result.dataParams).toContain('%夏日%')
  })

  it('单标签筛选添加 JOIN 和 GROUP BY', () => {
    const result = buildSearchQuery({ keyword: '', tagSlugs: ['outdoor'], page: 1, pageSize: 20 })
    expect(result.dataSql).toContain('JOIN gallery_tags')
    expect(result.dataSql).toContain('JOIN tags t')
    expect(result.dataSql).toContain('GROUP BY g.id')
    expect(result.countParams).toContain('outdoor')
    expect(result.dataSql).not.toContain('HAVING')
  })

  it('多标签 AND 添加 HAVING COUNT', () => {
    const result = buildSearchQuery({ keyword: '', tagSlugs: ['outdoor', 'fashion'], page: 1, pageSize: 20 })
    expect(result.dataSql).toContain('HAVING COUNT(DISTINCT t.slug) = ?')
    expect(result.countParams).toContain(2)
    expect(result.dataParams).toContain(2)
  })

  it('分页偏移计算正确', () => {
    const result = buildSearchQuery({ keyword: '', tagSlugs: [], page: 3, pageSize: 10 })
    const lastTwo = result.dataParams.slice(-2)
    expect(lastTwo).toEqual([10, 20])
  })

  it('关键词 + 标签组合', () => {
    const result = buildSearchQuery({ keyword: '写真', tagSlugs: ['guangdong'], page: 2, pageSize: 15 })
    expect(result.countSql).toContain('t.slug IN (?)')
    expect(result.countSql).toContain('g.title LIKE ?')
    expect(result.countParams).toEqual(['published', 'guangdong', '%写真%', '%写真%'])
    expect(result.dataParams).toEqual(['published', 'guangdong', '%写真%', '%写真%', 15, 15])
  })
})
