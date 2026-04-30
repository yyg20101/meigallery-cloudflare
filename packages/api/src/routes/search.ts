import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { PAGINATION } from '@meigallery/shared/constants'
import { cacheControl } from '../middleware/cache'

export const searchRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/search - 组合搜索
 * 查询参数：
 *   q: 关键词（搜索标题和摘要）
 *   tag: 标签 slug（逗号分隔，AND 关系）
 *   page: 页码
 *   pageSize: 每页数量
 */
searchRoutes.get('/', cacheControl(30), async (c) => {
  const db = c.env.DB
  const keyword = c.req.query('q')?.trim() || ''
  const tagSlugs = c.req.query('tag')?.split(',').filter(Boolean) || []
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )
  const offset = (page - 1) * pageSize

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

  // 总数查询
  const countParams = [...params]
  if (tagSlugs.length > 1) countParams.push(tagSlugs.length)

  let countQuery: string
  if (havingClause) {
    countQuery = `SELECT COUNT(*) as total FROM (SELECT g.id ${fromClause} WHERE ${whereClause}${havingClause})`
  } else {
    countQuery = `SELECT COUNT(DISTINCT g.id) as total ${fromClause} WHERE ${whereClause}`
  }

  const countResult = await db
    .prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  // 数据查询
  const dataParams = [...params]
  if (tagSlugs.length > 1) dataParams.push(tagSlugs.length)
  dataParams.push(pageSize, offset)

  let dataQuery: string
  if (havingClause) {
    dataQuery = `
      SELECT g.id, g.title, g.slug, g.summary, g.cover_key,
             g.required_level_rank, g.published_at
      ${fromClause}
      WHERE ${whereClause}
      ${havingClause}
      ORDER BY g.published_at DESC
      LIMIT ? OFFSET ?
    `
  } else {
    dataQuery = `
      SELECT DISTINCT g.id, g.title, g.slug, g.summary, g.cover_key,
             g.required_level_rank, g.published_at
      ${fromClause}
      WHERE ${whereClause}
      ORDER BY g.published_at DESC
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
    coverUrl: g.cover_key ? `/api/media/cover/${g.id}` : null,
    requiredLevelRank: g.required_level_rank,
    publishedAt: g.published_at,
    tags: tagsMap[g.id] || [],
  }))

  return c.json({ data, total, page, pageSize })
})
