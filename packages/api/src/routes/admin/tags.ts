import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { TAG_TYPES } from '@meigallery/shared/constants'

export const adminTagRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET / - 标签列表（管理员，可按类型筛选）
 * 查询参数：type?（筛选）
 * 返回全部标签，含关联图库计数
 */
adminTagRoutes.get('/', async (c) => {
  const db = c.env.DB
  const filterType = c.req.query('type')

  let query = `
    SELECT t.id, t.type, t.name, t.slug, t.created_at,
           COUNT(gt.gallery_id) as gallery_count
    FROM tags t
    LEFT JOIN gallery_tags gt ON t.id = gt.tag_id
  `
  const params: unknown[] = []

  if (filterType) {
    query += ' WHERE t.type = ?'
    params.push(filterType)
  }

  query += ' GROUP BY t.id ORDER BY t.type, t.name'

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<{ id: string; type: string; name: string; slug: string; created_at: string; gallery_count: number }>()

  return c.json({ data: result.results })
})

/**
 * POST / - 创建标签
 * Body: { type, name, slug }
 * - type 必须在 TAG_TYPES 范围内
 * - slug 必须唯一
 * - 写审计日志
 */
adminTagRoutes.post('/', async (c) => {
  const body = await c.req.json<{ type?: string; name?: string; slug?: string }>()
  const adminId = c.get('userId')!
  const db = c.env.DB

  // 参数校验
  if (!body.type || !body.name || !body.slug) {
    return c.json({ statusCode: 400, message: 'type、name、slug 为必填' }, 400)
  }

  if (!(TAG_TYPES as readonly string[]).includes(body.type)) {
    return c.json({ statusCode: 400, message: `type 必须为: ${TAG_TYPES.join(', ')}` }, 400)
  }

  const slug = body.slug.trim().toLowerCase()
  if (!/^[a-z0-9\-]+$/.test(slug)) {
    return c.json({ statusCode: 400, message: 'slug 只允许小写字母、数字和连字符' }, 400)
  }

  // slug 唯一性
  const existing = await db.prepare('SELECT id FROM tags WHERE slug = ?').bind(slug).first()
  if (existing) {
    return c.json({ statusCode: 409, message: '该 slug 已存在' }, 409)
  }

  const id = generateId('tag')
  await db
    .prepare('INSERT INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, body.type, body.name.trim(), slug)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'create_tag',
    targetType: 'tag',
    targetId: id,
    afterValue: { type: body.type, name: body.name.trim(), slug },
  })

  return c.json({ id, type: body.type, name: body.name.trim(), slug }, 201)
})

/**
 * PATCH /:id - 更新标签
 * Body: { name?, slug?, type? }
 * - 如果修改 slug 检查唯一性
 * - 如果修改 type 检查合法性
 * - 写审计日志
 */
adminTagRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; slug?: string; type?: string }>()
  const adminId = c.get('userId')!
  const db = c.env.DB

  const existing = await db
    .prepare('SELECT id, type, name, slug FROM tags WHERE id = ?')
    .bind(id)
    .first<{ id: string; type: string; name: string; slug: string }>()

  if (!existing) {
    return c.json({ statusCode: 404, message: '标签不存在' }, 404)
  }

  const updates: string[] = []
  const values: unknown[] = []
  const before = { ...existing }

  if (body.type !== undefined) {
    if (!(TAG_TYPES as readonly string[]).includes(body.type)) {
      return c.json({ statusCode: 400, message: `type 必须为: ${TAG_TYPES.join(', ')}` }, 400)
    }
    updates.push('type = ?')
    values.push(body.type)
  }

  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return c.json({ statusCode: 400, message: 'name 不能为空' }, 400)
    }
    updates.push('name = ?')
    values.push(body.name.trim())
  }

  if (body.slug !== undefined) {
    const newSlug = body.slug.trim().toLowerCase()
    if (!/^[a-z0-9\-]+$/.test(newSlug)) {
      return c.json({ statusCode: 400, message: 'slug 只允许小写字母、数字和连字符' }, 400)
    }
    if (newSlug !== existing.slug) {
      const slugExists = await db.prepare('SELECT id FROM tags WHERE slug = ? AND id != ?').bind(newSlug, id).first()
      if (slugExists) {
        return c.json({ statusCode: 409, message: '该 slug 已被其他标签使用' }, 409)
      }
    }
    updates.push('slug = ?')
    values.push(newSlug)
  }

  if (updates.length === 0) {
    return c.json({ statusCode: 400, message: '没有提供任何更新字段' }, 400)
  }

  values.push(id)
  await db
    .prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  const after = await db
    .prepare('SELECT id, type, name, slug FROM tags WHERE id = ?')
    .bind(id)
    .first<{ id: string; type: string; name: string; slug: string }>()

  await writeAuditLog(db, {
    adminId,
    action: 'update_tag',
    targetType: 'tag',
    targetId: id,
    beforeValue: before,
    afterValue: after,
  })

  return c.json(after)
})

/**
 * DELETE /:id - 删除标签
 * - 同时删除 gallery_tags 关联
 * - 写审计日志
 */
adminTagRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const adminId = c.get('userId')!
  const db = c.env.DB

  const existing = await db
    .prepare('SELECT id, type, name, slug FROM tags WHERE id = ?')
    .bind(id)
    .first<{ id: string; type: string; name: string; slug: string }>()

  if (!existing) {
    return c.json({ statusCode: 404, message: '标签不存在' }, 404)
  }

  // 删除关联
  await db.prepare('DELETE FROM gallery_tags WHERE tag_id = ?').bind(id).run()
  // 删除标签
  await db.prepare('DELETE FROM tags WHERE id = ?').bind(id).run()

  await writeAuditLog(db, {
    adminId,
    action: 'delete_tag',
    targetType: 'tag',
    targetId: id,
    beforeValue: existing,
  })

  return c.json({ message: '标签已删除' })
})
