export function clampCount(value: number | null | undefined): number {
  return Math.max(0, value ?? 0)
}

export function getHotScore(viewCount: number | null | undefined, likeCount: number | null | undefined): number {
  return clampCount(viewCount) + clampCount(likeCount) * 5
}

export function getPublicGalleryOrderClause(sort: string): string {
  switch (sort) {
    case 'oldest':
      return ' ORDER BY g.published_at ASC'
    case 'hot':
      // 调用方查询需要提供 hot_score alias。
      return ' ORDER BY hot_score DESC, g.published_at DESC'
    default:
      return ' ORDER BY g.published_at DESC'
  }
}

export function getAdminGalleryOrderClause(sort: string): string {
  switch (sort) {
    case 'view_desc':
      return ' ORDER BY g.view_count DESC, g.created_at DESC'
    case 'like_desc':
      return ' ORDER BY g.like_count DESC, g.created_at DESC'
    case 'created_asc':
      return ' ORDER BY g.created_at ASC'
    default:
      return ' ORDER BY g.created_at DESC'
  }
}

export async function isGalleryLikedByUser(db: D1Database, galleryId: string, userId: number | null): Promise<boolean> {
  if (!userId) return false
  const row = await db
    .prepare('SELECT 1 as liked FROM gallery_likes WHERE gallery_id = ? AND user_id = ?')
    .bind(galleryId, userId)
    .first<{ liked: number }>()
  return Boolean(row)
}
