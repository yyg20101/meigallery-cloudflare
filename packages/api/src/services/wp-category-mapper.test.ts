import { describe, it, expect } from 'vitest'
import { mapWpCategories, mapWpTags, generateSlug } from './wp-category-mapper'
import type { WpCategory, WpTag } from './wp-fetcher'

const mockCategories: WpCategory[] = [
  { id: 1, name: '国内精选', slug: 'guonei', parent: 0, count: 394 },
  { id: 2, name: '海外精选', slug: 'haiwai', parent: 0, count: 107 },
  { id: 73, name: '港澳台', slug: 'gangaotai', parent: 0, count: 0 },
  { id: 68, name: '华东地区', slug: 'huadong', parent: 0, count: 31 },
  { id: 24, name: '上海外围', slug: 'shanghai', parent: 0, count: 29 },
  { id: 67, name: '加拿大外围', slug: 'canada', parent: 0, count: 29 },
]

const mockTags: WpTag[] = [
  { id: 6, name: '留学生', slug: 'liuxuesheng', count: 159 },
  { id: 75, name: '模特', slug: 'mote', count: 91 },
  { id: 76, name: '包养', slug: 'baoyang', count: 108 },
  { id: 78, name: '制服-反差', slug: 'zhifu-fancha', count: 117 },
  { id: 9, name: '萝莉', slug: 'luoli', count: 43 },
]

describe('mapWpCategories', () => {
  it('映射顶层范围', () => {
    const result = mapWpCategories(mockCategories, [1])
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.type).toBe('region_scope')
    expect(result.tags[0]!.name).toBe('国内精选')
  })

  it('映射区域组', () => {
    const result = mapWpCategories(mockCategories, [68])
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.type).toBe('region_group')
    expect(result.tags[0]!.name).toBe('华东地区')
  })

  it('映射城市并去掉"外围"后缀', () => {
    const result = mapWpCategories(mockCategories, [24])
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.type).toBe('city_country')
    expect(result.tags[0]!.name).toBe('上海')
  })

  it('映射国家并去掉"外围"后缀', () => {
    const result = mapWpCategories(mockCategories, [67])
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.type).toBe('city_country')
    expect(result.tags[0]!.name).toBe('加拿大')
  })

  it('同时映射多个分类', () => {
    const result = mapWpCategories(mockCategories, [2, 67])
    expect(result.tags).toHaveLength(2)
    expect(result.tags[0]!.type).toBe('region_scope')
    expect(result.tags[1]!.type).toBe('city_country')
  })

  it('跳过未知分类 ID', () => {
    const result = mapWpCategories(mockCategories, [999])
    expect(result.tags).toHaveLength(0)
  })
})

describe('mapWpTags', () => {
  it('映射正常标签为 identity 类型', () => {
    const result = mapWpTags(mockTags, [6])
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.type).toBe('identity')
    expect(result.tags[0]!.name).toBe('留学生')
    expect(result.reviewFlags).toHaveLength(0)
  })

  it('映射制服标签为 style 类型', () => {
    const result = mapWpTags(mockTags, [78])
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.type).toBe('style')
  })

  it('标记需审核的标签', () => {
    const result = mapWpTags(mockTags, [76])
    expect(result.tags).toHaveLength(1)
    expect(result.reviewFlags).toHaveLength(1)
    expect(result.reviewFlags[0]).toContain('包养')
    expect(result.reviewFlags[0]).toContain('审核')
  })

  it('萝莉标签触发审核', () => {
    const result = mapWpTags(mockTags, [9])
    expect(result.reviewFlags.length).toBeGreaterThan(0)
    expect(result.reviewFlags[0]).toContain('萝莉')
  })

  it('多标签混合', () => {
    const result = mapWpTags(mockTags, [6, 76, 75])
    expect(result.tags).toHaveLength(3)
    // 留学生和模特不触发审核，包养触发
    expect(result.reviewFlags).toHaveLength(1)
  })
})

describe('generateSlug', () => {
  it('中文保留', () => {
    expect(generateSlug('上海')).toBe('上海')
  })

  it('空格转连字符', () => {
    expect(generateSlug('Hello World')).toBe('hello-world')
  })

  it('斜线转连字符', () => {
    expect(generateSlug('sm/猎奇')).toBe('sm-猎奇')
  })

  it('去除特殊字符', () => {
    expect(generateSlug('test@#$%')).toBe('test')
  })

  it('合并连续连字符', () => {
    expect(generateSlug('a---b')).toBe('a-b')
  })
})
