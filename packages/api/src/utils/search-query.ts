/**
 * 搜索查询构建工具
 */

export interface SearchParams {
  keyword: string
  tagSlugs: string[]
  page: number
  pageSize: number
}

export interface SearchQuery {
  countSql: string
  dataSql: string
  countParams: unknown[]
  dataParams: unknown[]
}

/**
 * 规范化搜索参数
 */
export function normalizeSearchParams(raw: {
  q?: string
  tag?: string
  page?: string
  pageSize?: string
}, maxPageSize: number, defaultPageSize: number): SearchParams {
  const keyword = raw.q?.trim() || ''
  const tagSlugs = raw.tag?.split(',').map(t => t.trim()).filter(Boolean) || []
  const parsedPage = parseInt(raw.page || '1', 10)
  const page = Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage)
  const parsedPageSize = parseInt(raw.pageSize || String(defaultPageSize), 10)
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.isNaN(parsedPageSize) ? defaultPageSize : parsedPageSize))
  return { keyword, tagSlugs, page, pageSize }
}

/**
 * 构建搜索 SQL 查询
 */
export function buildSearchQuery(params: SearchParams): SearchQuery {
  const { keyword, tagSlugs, page, pageSize } = params
  const offset = (page - 1) * pageSize

  let fromClause = 'FROM galleries g'
  const whereConditions = ['g.status = ?']
  const baseParams: unknown[] = ['published']

  // 标签筛选
  if (tagSlugs.length > 0) {
    fromClause += ' JOIN gallery_tags gt ON g.id = gt.gallery_id JOIN tags t ON gt.tag_id = t.id'
    const placeholders = tagSlugs.map(() => '?').join(',')
    whereConditions.push(`t.slug IN (${placeholders})`)
    baseParams.push(...tagSlugs)
  }

  // 关键词搜索
  if (keyword) {
    whereConditions.push('(g.title LIKE ? OR g.summary LIKE ?)')
    baseParams.push(`%${keyword}%`, `%${keyword}%`)
  }

  const whereClause = whereConditions.join(' AND ')

  // HAVING 子句（多标签 AND）
  let havingClause = ''
  if (tagSlugs.length > 1) {
    havingClause = ` GROUP BY g.id HAVING COUNT(DISTINCT t.slug) = ?`
  } else if (tagSlugs.length > 0) {
    havingClause = ' GROUP BY g.id'
  }

  // COUNT 查询
  const countParams = [...baseParams]
  if (tagSlugs.length > 1) countParams.push(tagSlugs.length)

  let countSql: string
  if (havingClause) {
    countSql = `SELECT COUNT(*) as total FROM (SELECT g.id ${fromClause} WHERE ${whereClause}${havingClause})`
  } else {
    countSql = `SELECT COUNT(DISTINCT g.id) as total ${fromClause} WHERE ${whereClause}`
  }

  // DATA 查询
  const dataParams = [...baseParams]
  if (tagSlugs.length > 1) dataParams.push(tagSlugs.length)
  dataParams.push(pageSize, offset)

  let dataSql: string
  if (havingClause) {
    dataSql = `SELECT g.id, g.title, g.slug, g.summary, g.cover_key, g.required_level_rank, g.published_at ${fromClause} WHERE ${whereClause}${havingClause} ORDER BY g.published_at DESC LIMIT ? OFFSET ?`
  } else {
    dataSql = `SELECT DISTINCT g.id, g.title, g.slug, g.summary, g.cover_key, g.required_level_rank, g.published_at ${fromClause} WHERE ${whereClause} ORDER BY g.published_at DESC LIMIT ? OFFSET ?`
  }

  return { countSql, dataSql, countParams, dataParams }
}
