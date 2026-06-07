import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { generateId } from '../../utils/db'
import {
  HOME_AD_PLACEMENT,
  type HomeAdRow,
  isExpectedHomeAdImageKey,
  normalizeHomeAdPayload,
  serializeHomeAd,
} from '../../utils/home-ads'
import { writeAuditLog } from '../../utils/permission'

export const adminAdRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAdRoutes.use('*', requireOwner)

adminAdRoutes.get('/', async (c) => {
  const result = await c.env.DB
    .prepare(`
      SELECT id, placement, eyebrow, title, summary, cta_label, target_url, sponsor,
             image_url, image_key, enabled, starts_at, ends_at, sort_order, created_at, updated_at
      FROM home_ads
      ORDER BY sort_order ASC, created_at ASC
    `)
    .all<HomeAdRow>()

  return c.json({ data: result.results.map(serializeHomeAd) })
})

adminAdRoutes.post('/', async (c) => {
  const adminId = c.get('userId')!
  const body = await c.req.json<Record<string, unknown>>()
  let normalized: ReturnType<typeof normalizeHomeAdPayload>
  try {
    normalized = normalizeHomeAdPayload(body)
  } catch (error) {
    return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '广告配置无效' }, 400)
  }

  const maxRow = await c.env.DB
    .prepare('SELECT MAX(sort_order) as max_order FROM home_ads WHERE placement = ?')
    .bind(normalized.placement)
    .first<{ max_order: number | null }>()
  const sortOrder = (maxRow?.max_order ?? -1) + 1
  const id = generateId('ad')

  await c.env.DB
    .prepare(`
      INSERT INTO home_ads (
        id, placement, eyebrow, title, summary, cta_label, target_url, sponsor,
        image_url, enabled, starts_at, ends_at, sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    .bind(
      id,
      normalized.placement,
      normalized.eyebrow,
      normalized.title,
      normalized.summary,
      normalized.ctaLabel,
      normalized.targetUrl,
      normalized.sponsor,
      normalized.imageUrl,
      normalized.enabled ? 1 : 0,
      normalized.startsAt,
      normalized.endsAt,
      sortOrder,
    )
    .run()

  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'home_ad_create',
    targetType: 'home_ad',
    targetId: id,
    afterValue: { ...normalized, sortOrder },
  })

  return c.json({ message: '广告位已创建', id }, 201)
})

adminAdRoutes.patch('/reorder', async (c) => {
  const adminId = c.get('userId')!
  const body = await c.req.json<{ ids?: unknown }>()
  const ids = Array.isArray(body.ids) ? body.ids.map(id => String(id)).filter(Boolean) : []
  if (ids.length === 0) return c.json({ statusCode: 400, message: 'ids 必须为非空数组' }, 400)

  const existing = await c.env.DB
    .prepare(`SELECT id FROM home_ads WHERE placement = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(HOME_AD_PLACEMENT, ...ids)
    .all<{ id: string }>()
  const existingIds = new Set(existing.results.map(row => row.id))
  if (existingIds.size !== ids.length) {
    return c.json({ statusCode: 400, message: '排序列表包含不存在的广告位' }, 400)
  }

  await c.env.DB.batch(ids.map((id, index) =>
    c.env.DB
      .prepare("UPDATE home_ads SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(index, id)
  ))

  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'home_ad_reorder',
    targetType: 'home_ad',
    afterValue: { ids },
  })

  return c.json({ message: '广告位排序已更新' })
})

adminAdRoutes.put('/:id', async (c) => {
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const current = await readAd(c.env.DB, id)
  if (!current) return c.json({ statusCode: 404, message: '广告位不存在' }, 404)

  const body = await c.req.json<Record<string, unknown>>()
  let normalized: ReturnType<typeof normalizeHomeAdPayload>
  try {
    normalized = normalizeHomeAdPayload(body, current)
  } catch (error) {
    return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '广告配置无效' }, 400)
  }

  await c.env.DB
    .prepare(`
      UPDATE home_ads
      SET placement = ?, eyebrow = ?, title = ?, summary = ?, cta_label = ?,
          target_url = ?, sponsor = ?, image_url = ?, enabled = ?,
          starts_at = ?, ends_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .bind(
      normalized.placement,
      normalized.eyebrow,
      normalized.title,
      normalized.summary,
      normalized.ctaLabel,
      normalized.targetUrl,
      normalized.sponsor,
      normalized.imageUrl,
      normalized.enabled ? 1 : 0,
      normalized.startsAt,
      normalized.endsAt,
      id,
    )
    .run()

  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'home_ad_update',
    targetType: 'home_ad',
    targetId: id,
    beforeValue: serializeHomeAd(current),
    afterValue: normalized,
  })

  return c.json({ message: '广告位已更新' })
})

adminAdRoutes.delete('/:id', async (c) => {
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const current = await readAd(c.env.DB, id)
  if (!current) return c.json({ statusCode: 404, message: '广告位不存在' }, 404)

  if (current.image_key) {
    if (!isExpectedHomeAdImageKey(current.image_key, id)) {
      return c.json({ statusCode: 409, message: '广告大图 R2 key 与当前广告位不匹配，请先人工核查' }, 409)
    }
    await c.env.R2.delete(current.image_key)
  }

  await c.env.DB.prepare('DELETE FROM home_ads WHERE id = ?').bind(id).run()
  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'home_ad_delete',
    targetType: 'home_ad',
    targetId: id,
    beforeValue: serializeHomeAd(current),
  })

  return c.json({ message: '广告位已删除' })
})

adminAdRoutes.post('/:id/image', async (c) => {
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const current = await readAd(c.env.DB, id)
  if (!current) return c.json({ statusCode: 404, message: '广告位不存在' }, 404)

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ statusCode: 400, message: '请上传文件（字段名: file）' }, 400)

  const allowedTypes: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  }
  const ext = allowedTypes[file.type]
  if (!ext) return c.json({ statusCode: 400, message: '仅支持 PNG、JPEG、WebP 格式' }, 400)
  if (file.size > 3 * 1024 * 1024) return c.json({ statusCode: 400, message: '广告大图不能超过 3MB' }, 400)

  if (current.image_key) {
    if (!isExpectedHomeAdImageKey(current.image_key, id)) {
      return c.json({ statusCode: 409, message: '广告大图 R2 key 与当前广告位不匹配，请先人工核查' }, 409)
    }
    await c.env.R2.delete(current.image_key)
  }

  const key = `home-ads/${id}/${generateId('image')}.${ext}`
  const imageUrl = `/api/media/public/${key}`
  await c.env.R2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })
  await c.env.DB
    .prepare("UPDATE home_ads SET image_key = ?, image_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(key, imageUrl, id)
    .run()

  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'home_ad_image_upload',
    targetType: 'home_ad',
    targetId: id,
    beforeValue: { imageKey: current.image_key, imageUrl: current.image_url },
    afterValue: { imageKey: key, imageUrl },
  })

  return c.json({ message: '广告大图已上传', imageUrl, imageKey: key })
})

adminAdRoutes.delete('/:id/image', async (c) => {
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const current = await readAd(c.env.DB, id)
  if (!current) return c.json({ statusCode: 404, message: '广告位不存在' }, 404)
  if (!current.image_key) return c.json({ statusCode: 404, message: '该广告位没有已上传大图' }, 404)

  if (!isExpectedHomeAdImageKey(current.image_key, id)) {
    return c.json({ statusCode: 409, message: '广告大图 R2 key 与当前广告位不匹配，请先人工核查' }, 409)
  }

  await c.env.R2.delete(current.image_key)
  await c.env.DB
    .prepare("UPDATE home_ads SET image_key = NULL, image_url = '', updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run()

  await writeAuditLog(c.env.DB, {
    adminId,
    action: 'home_ad_image_delete',
    targetType: 'home_ad',
    targetId: id,
    beforeValue: { imageKey: current.image_key, imageUrl: current.image_url },
  })

  return c.json({ message: '广告大图已删除' })
})

async function readAd(db: D1Database, id: string) {
  return db
    .prepare(`
      SELECT id, placement, eyebrow, title, summary, cta_label, target_url, sponsor,
             image_url, image_key, enabled, starts_at, ends_at, sort_order, created_at, updated_at
      FROM home_ads
      WHERE id = ?
    `)
    .bind(id)
    .first<HomeAdRow>()
}
