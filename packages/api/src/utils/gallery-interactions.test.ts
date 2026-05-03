import { describe, expect, it } from 'vitest'
import { clampCount, getAdminGalleryOrderClause, getPublicGalleryOrderClause, getHotScore } from './gallery-interactions'

describe('图库互动工具', () => {
  it('热度分数按浏览量 + 点赞数 * 5 计算', () => {
    expect(getHotScore(10, 2)).toBe(20)
    expect(getHotScore(null, 3)).toBe(15)
    expect(getHotScore(7, null)).toBe(7)
  })

  it('计数不会小于 0', () => {
    expect(clampCount(-1)).toBe(0)
    expect(clampCount(12)).toBe(12)
  })

  it('公开图库排序使用白名单', () => {
    expect(getPublicGalleryOrderClause('hot')).toContain('hot_score')
    expect(getPublicGalleryOrderClause('oldest')).toBe(' ORDER BY g.published_at ASC')
    expect(getPublicGalleryOrderClause('bad-input')).toBe(' ORDER BY g.published_at DESC')
  })

  it('后台图库排序使用白名单', () => {
    expect(getAdminGalleryOrderClause('view_desc')).toBe(' ORDER BY g.view_count DESC, g.created_at DESC')
    expect(getAdminGalleryOrderClause('like_desc')).toBe(' ORDER BY g.like_count DESC, g.created_at DESC')
    expect(getAdminGalleryOrderClause('bad-input')).toBe(' ORDER BY g.created_at DESC')
  })
})
