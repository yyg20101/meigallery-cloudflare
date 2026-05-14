import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { PAGINATION } from '@meigallery/shared/constants'
import { cacheControl } from '../middleware/cache'
import { parsePositiveIntParam } from '../utils/pagination'

export const searchRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/search - 组合搜索
 * 查询参数：
 *   q: 关键词（搜索标题和摘要）
 *   tag: 标签 slug（逗号分隔，AND 关系）
 *   page: 页码
 *   pageSize: 每页数量
 *   sort: 排序（newest / hot，默认 newest）
 */
searchRoutes.get('/', cacheControl(30), async (c) => {
  const db = c.env.DB
  const keyword = c.req.query('q')?.trim() || ''
  const tagSlugs = c.req.query('tag')?.split(',').filter(Boolean) || []
  const sort = c.req.query('sort') || 'newest'
  const page = parsePositiveIntParam(c.req.query('page'), 1)
  const pageSize = parsePositiveIntParam(c.req.query('pageSize'), PAGINATION.DEFAULT_PAGE_SIZE, PAGINATION.MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize
  const isComplexQuery = tagSlugs.length > 0 || Boolean(keyword)

  // 构建查询
  let fromClause = 'FROM galleries g'
  let whereConditions = ['g.status = ?']
  const params: unknown[] = ['published']

  // 标签筛选（AND 关系：要求包含所有指定标签）
  if (tagSlugs.length > 0) {
    fromClause += ' JOIN gallery_tags gt ON g.id = gt.gallery_id JOIN tags t ON gt.tag_id = t.id'
    const placeholders = tagSlugs.map(() => '?').join(',')
    whereConditions.push(`t.slug IN (${placeholders})`)
    params.push(...tagSlugs)
  }

  // 关键词搜索
  if (keyword) {
    whereConditions.push('(g.title LIKE ? OR g.summary LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }

  const whereClause = whereConditions.join(' AND ')

  // 如果有多标签 AND 关系，使用 HAVING COUNT
  let havingClause = ''
  if (tagSlugs.length > 1) {
    havingClause = ` GROUP BY g.id HAVING COUNT(DISTINCT t.slug) = ?`
  } else if (tagSlugs.length > 0) {
    havingClause = ' GROUP BY g.id'
  }

  let exactTotal: number | null = null
  if (!isComplexQuery) {
    const countResult = await db
      .prepare('SELECT COUNT(*) as total FROM galleries g WHERE g.status = ?')
      .bind('published')
      .first<{ total: number }>()
    exactTotal = countResult?.total ?? 0
  }

  // 数据查询
  // 排序
  let orderClause: string
  switch (sort) {
    case 'hot':
      orderClause = 'ORDER BY g.view_count DESC, g.published_at DESC'
      break
    case 'random':
      // 兼容旧 random 参数：不再提供随机排序，统一降级为最新排序。
      orderClause = 'ORDER BY g.published_at DESC'
      break
    default: // newest / relevance
      orderClause = 'ORDER BY g.published_at DESC'
  }

  const dataParams = [...params]
  if (tagSlugs.length > 1) dataParams.push(tagSlugs.length)
  dataParams.push(pageSize + 1, offset)

  let dataQuery: string
  if (havingClause) {
    dataQuery = `
      SELECT g.id, g.title, g.slug, g.summary, g.cover_key,
             g.required_level_rank, g.published_at
      ${fromClause}
      WHERE ${whereClause}
      ${havingClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `
  } else {
    dataQuery = `
      SELECT DISTINCT g.id, g.title, g.slug, g.summary, g.cover_key,
             g.required_level_rank, g.published_at
      ${fromClause}
      WHERE ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `
  }

  const galleries = await db
    .prepare(dataQuery)
    .bind(...dataParams)
    .all<{
      id: string
      title: string
      slug: string
      summary: string | null
      cover_key: string | null
      required_level_rank: number
      published_at: string | null
    }>()

  // 批量查询标签
  const hasMore = galleries.results.length > pageSize
  const pageRows = galleries.results.slice(0, pageSize)
  const total = exactTotal ?? offset + pageRows.length + (hasMore ? 1 : 0)

  const galleryIds = pageRows.map(g => g.id)
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

  const data = pageRows.map(g => ({
    id: g.id,
    title: g.title,
    slug: g.slug,
    summary: g.summary,
    coverUrl: g.cover_key
      ? g.cover_key.startsWith('http') ? g.cover_key : `/api/media/cover/${g.id}`
      : null,
    requiredLevelRank: g.required_level_rank,
    publishedAt: g.published_at,
    tags: tagsMap[g.id] || [],
  }))

  return c.json({ data, total, page, pageSize, hasMore })
})
