import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { PAGINATION } from '@meigallery/shared/constants'
import { cacheControl } from '../middleware/cache'
import { getPublicGalleryOrderClause, isGalleryLikedByUser } from '../utils/gallery-interactions'

export const galleryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/galleries - 图库列表
 * 查询参数：
 *   page: 页码（默认 1）
 *   pageSize: 每页数量（默认 20，最大 100）
 *   tag: 标签 slug（可多个，逗号分隔）
 *   search: 关键词搜索（标题和摘要模糊匹配）
 *   sort: 排序方式（newest / oldest / random / hot，默认 newest）
 */
galleryRoutes.get('/', cacheControl(60), async (c) => {
  const db = c.env.DB
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )
  const tagSlugs = c.req.query('tag')?.split(',').filter(Boolean) || []
  const search = c.req.query('search')?.trim() || ''
  const sort = c.req.query('sort') || 'newest'
  const offset = (page - 1) * pageSize

  let countQuery = 'SELECT COUNT(DISTINCT g.id) as total FROM galleries g'
  let dataQuery = `
    SELECT DISTINCT g.id, g.title, g.slug, g.summary, g.cover_key,
           g.required_level_rank, g.published_at, g.view_count, g.like_count,
           (COALESCE(g.view_count, 0) + COALESCE(g.like_count, 0) * 5) as hot_score
    FROM galleries g
  `
  let whereClause = ' WHERE g.status = ?'
  const params: unknown[] = ['published']

  // 标签筛选
  if (tagSlugs.length > 0) {
    const placeholders = tagSlugs.map(() => '?').join(',')
    const joinClause = ` JOIN gallery_tags gt ON g.id = gt.gallery_id JOIN tags t ON gt.tag_id = t.id`
    countQuery += joinClause
    dataQuery += joinClause
    whereClause += ` AND t.slug IN (${placeholders})`
    params.push(...tagSlugs)
  }

  // 关键词搜索（标题 + 摘要模糊匹配）
  if (search) {
    const keyword = `%${search}%`
    whereClause += ` AND (g.title LIKE ? OR g.summary LIKE ?)`
    params.push(keyword, keyword)
  }

  countQuery += whereClause

  // 排序
  const orderClause = getPublicGalleryOrderClause(sort)

  dataQuery += whereClause + orderClause + ' LIMIT ? OFFSET ?'

  // 查询总数
  const countResult = await db
    .prepare(countQuery)
    .bind(...params)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  // 查询数据
  const galleries = await db
    .prepare(dataQuery)
    .bind(...params, pageSize, offset)
    .all<{
      id: string
      title: string
      slug: string
      summary: string | null
      cover_key: string | null
      required_level_rank: number
      published_at: string | null
      view_count: number
      like_count: number
      hot_score: number
    }>()

  // 批量查询标签
  const galleryIds = galleries.results.map(g => g.id)
  let tagsMap: Record<string, Array<{ id: string; type: string; name: string; slug: string }>> = {}

  if (galleryIds.length > 0) {
    const tagPlaceholders = galleryIds.map(() => '?').join(',')
    const tagsResult = await db
      .prepare(`
        SELECT gt.gallery_id, t.id, t.type, t.name, t.slug
        FROM gallery_tags gt
        JOIN tags t ON gt.tag_id = t.id
        WHERE gt.gallery_id IN (${tagPlaceholders})
      `)
      .bind(...galleryIds)
      .all<{ gallery_id: string; id: string; type: string; name: string; slug: string }>()

    for (const tag of tagsResult.results) {
      if (!tagsMap[tag.gallery_id]) tagsMap[tag.gallery_id] = []
      tagsMap[tag.gallery_id]!.push({ id: tag.id, type: tag.type, name: tag.name, slug: tag.slug })
    }
  }

  const data = galleries.results.map(g => ({
    id: g.id,
    title: g.title,
    slug: g.slug,
    summary: g.summary,
    // 外部 URL 直通（兼容测试数据和迁移内容），R2 key 走内部代理
    coverUrl: g.cover_key
      ? g.cover_key.startsWith('http') ? g.cover_key : `/api/media/cover/${g.id}`
      : null,
    requiredLevelRank: g.required_level_rank,
    publishedAt: g.published_at,
    viewCount: g.view_count,
    likeCount: g.like_count,
    tags: tagsMap[g.id] || [],
  }))

  return c.json({ data, total, page, pageSize })
})

/**
 * GET /api/galleries/:slug - 图库详情
 */
galleryRoutes.get('/:slug', cacheControl(120), async (c) => {
  const slug = c.req.param('slug')
  const db = c.env.DB

  const gallery = await db
    .prepare(`
      SELECT id, title, slug, summary, body_md, cover_key, status,
             required_level_rank, published_at, view_count, like_count, created_at, updated_at
      FROM galleries
      WHERE slug = ? AND status = 'published'
    `)
    .bind(slug)
    .first<{
      id: string
      title: string
      slug: string
      summary: string | null
      body_md: string | null
      cover_key: string | null
      status: string
      required_level_rank: number
      published_at: string | null
      view_count: number
      like_count: number
      created_at: string
      updated_at: string
    }>()

  if (!gallery) {
    return c.json({ statusCode: 404, message: '图库不存在' }, 404)
  }

  // 异步递增浏览量（不阻塞响应）
  c.executionCtx.waitUntil(
    db.prepare('UPDATE galleries SET view_count = view_count + 1 WHERE id = ?')
      .bind(gallery.id)
      .run()
      .catch(() => {}),
  )

  // 查询标签
  const tags = await db
    .prepare(`
      SELECT t.id, t.type, t.name, t.slug
      FROM gallery_tags gt
      JOIN tags t ON gt.tag_id = t.id
      WHERE gt.gallery_id = ?
    `)
    .bind(gallery.id)
    .all<{ id: string; type: string; name: string; slug: string }>()

  // 查询媒体资源（不含私有 URL）
  const media = await db
    .prepare(`
      SELECT id, type, role, sort_order, required_rank
      FROM media_assets
      WHERE gallery_id = ? AND upload_status = 'completed'
      ORDER BY sort_order ASC
    `)
    .bind(gallery.id)
    .all<{ id: string; type: string; role: string; sort_order: number; required_rank: number }>()

  const likedByMe = await isGalleryLikedByUser(db, gallery.id, c.get('userId'))

  return c.json({
    id: gallery.id,
    title: gallery.title,
    slug: gallery.slug,
    summary: gallery.summary,
    bodyMd: gallery.body_md,
    // 外部 URL 直通，R2 key 走内部代理
    coverUrl: gallery.cover_key
      ? gallery.cover_key.startsWith('http') ? gallery.cover_key : `/api/media/cover/${gallery.id}`
      : null,
    status: gallery.status,
    requiredLevelRank: gallery.required_level_rank,
    publishedAt: gallery.published_at,
    viewCount: gallery.view_count,
    likeCount: gallery.like_count,
    likedByMe,
    createdAt: gallery.created_at,
    updatedAt: gallery.updated_at,
    tags: tags.results,
    mediaAssets: media.results.map(m => ({
      id: m.id,
      type: m.type,
      role: m.role,
      sortOrder: m.sort_order,
      requiredRank: m.required_rank,
      thumbnailUrl: m.type === 'image' ? `/api/media/${m.id}/thumbnail?w=480` : undefined,
    })),
  })
})
