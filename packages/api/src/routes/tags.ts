import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { cacheControl } from '../middleware/cache'

export const tagRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/tags - 标签列表（按类型分组）
 * 查询参数：
 *   type: 筛选特定类型（可选）
 */
tagRoutes.get('/', cacheControl(300), async (c) => {
  const db = c.env.DB
  const filterType = c.req.query('type')

  let query = 'SELECT id, type, name, slug FROM tags'
  const params: unknown[] = []

  if (filterType) {
    query += ' WHERE type = ?'
    params.push(filterType)
  }

  query += ' ORDER BY type, name'

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<{ id: string; type: string; name: string; slug: string }>()

  // 按类型分组
  const grouped: Record<string, Array<{ id: string; name: string; slug: string }>> = {}
  for (const tag of result.results) {
    if (!grouped[tag.type]) grouped[tag.type] = []
    grouped[tag.type]!.push({ id: tag.id, name: tag.name, slug: tag.slug })
  }

  return c.json({ data: grouped })
})
