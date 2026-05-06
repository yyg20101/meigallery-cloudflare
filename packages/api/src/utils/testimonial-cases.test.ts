import { describe, expect, it } from 'vitest'
import {
  assertPublishableImageCount,
  getPublicImageUrl,
  getPublicOrderClause,
  isAllowedImageType,
  isValidSlug,
  normalizeSortOrder,
} from './testimonial-cases'

describe('真实案例工具', () => {
  it('slug 只允许小写字母、数字和短横线', () => {
    expect(isValidSlug('member-feedback-001')).toBe(true)
    expect(isValidSlug('MemberFeedback')).toBe(false)
    expect(isValidSlug('bad_slug')).toBe(false)
  })

  it('发布要求 2 到 9 张图片', () => {
    expect(() => assertPublishableImageCount(1)).toThrow('真实案例发布需要 2-9 张图片')
    expect(() => assertPublishableImageCount(2)).not.toThrow()
    expect(() => assertPublishableImageCount(9)).not.toThrow()
    expect(() => assertPublishableImageCount(10)).toThrow('真实案例发布需要 2-9 张图片')
  })

  it('图片类型使用白名单', () => {
    expect(isAllowedImageType('image/jpeg')).toBe(true)
    expect(isAllowedImageType('image/png')).toBe(true)
    expect(isAllowedImageType('image/webp')).toBe(true)
    expect(isAllowedImageType('image/gif')).toBe(false)
  })

  it('排序值归一化为非负整数', () => {
    expect(normalizeSortOrder(-1)).toBe(0)
    expect(normalizeSortOrder(3.8)).toBe(3)
    expect(normalizeSortOrder(Number.NaN)).toBe(0)
  })

  it('公开排序使用白名单', () => {
    expect(getPublicOrderClause('sort')).toBe(' ORDER BY tc.sort_order ASC, tc.published_at DESC')
    expect(getPublicOrderClause('newest')).toBe(' ORDER BY tc.published_at DESC, tc.sort_order ASC')
    expect(getPublicOrderClause('bad')).toBe(' ORDER BY tc.sort_order ASC, tc.published_at DESC')
  })

  it('公开图片 URL 不包含 R2 key', () => {
    expect(getPublicImageUrl('tci_123')).toBe('/api/testimonial-cases/images/tci_123')
  })
})
