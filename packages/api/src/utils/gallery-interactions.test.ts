import { describe, expect, it, vi } from 'vitest'
import {
  clampCount,
  getAdminGalleryOrderClause,
  getPublicGalleryOrderClause,
  getHotScore,
  isGalleryLikedByUser,
} from './gallery-interactions'

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

  it('公开图库排序使用白名单，旧 random 参数降级为最新排序', () => {
    expect(getPublicGalleryOrderClause('hot')).toBe(' ORDER BY hot_score DESC, g.published_at DESC')
    expect(getPublicGalleryOrderClause('oldest')).toBe(' ORDER BY g.published_at ASC')
    expect(getPublicGalleryOrderClause('random')).toBe(' ORDER BY g.published_at DESC')
    expect(getPublicGalleryOrderClause('random')).not.toContain('RANDOM()')
    expect(getPublicGalleryOrderClause('bad-input')).toBe(' ORDER BY g.published_at DESC')
  })

  it('后台图库排序使用白名单', () => {
    expect(getAdminGalleryOrderClause('view_desc')).toBe(' ORDER BY g.view_count DESC, g.created_at DESC')
    expect(getAdminGalleryOrderClause('like_desc')).toBe(' ORDER BY g.like_count DESC, g.created_at DESC')
    expect(getAdminGalleryOrderClause('bad-input')).toBe(' ORDER BY g.created_at DESC')
  })

  it('用户为空时不查询点赞关系并返回 false', async () => {
    const db = createGalleryLikeDbMock({ liked: 1 })

    await expect(isGalleryLikedByUser(db.database, 'gallery-1', null)).resolves.toBe(false)

    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('命中点赞关系时返回 true', async () => {
    const db = createGalleryLikeDbMock({ liked: 1 })

    await expect(isGalleryLikedByUser(db.database, 'gallery-1', 12)).resolves.toBe(true)

    expect(db.prepare).toHaveBeenCalledWith('SELECT 1 as liked FROM gallery_likes WHERE gallery_id = ? AND user_id = ?')
    expect(db.bind).toHaveBeenCalledWith('gallery-1', 12)
  })

  it('未命中点赞关系时返回 false', async () => {
    const db = createGalleryLikeDbMock(null)

    await expect(isGalleryLikedByUser(db.database, 'gallery-1', 12)).resolves.toBe(false)
  })
})

function createGalleryLikeDbMock(row: { liked: number } | null) {
  const first = vi.fn().mockResolvedValue(row)
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind }))

  return {
    database: { prepare } as unknown as D1Database,
    prepare,
    bind,
    first,
  }
}
