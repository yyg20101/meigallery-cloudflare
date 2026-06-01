import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { normalizeContactLinkUrl } from '../../utils/contact-link-url'
import { isExpectedContactQrCodeKey } from '../../utils/contact-qrcode'
import { writeAuditLog } from '../../utils/permission'
import { CONTACT_PLATFORMS } from '@meigallery/shared/constants'

export const adminContactMethodRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/admin/contact-methods
 * 列出所有联系方式（含禁用的）
 */
adminContactMethodRoutes.get('/', requireOwner, async (c) => {
  const db = c.env.DB
  const result = await db
    .prepare(`
      SELECT id, platform, label, value, link_url, qr_code_key, sort_order, enabled, created_at, updated_at
      FROM contact_methods
      ORDER BY sort_order ASC, created_at ASC
    `)
    .all<{
      id: string
      platform: string
      label: string
      value: string
      link_url: string | null
      qr_code_key: string | null
      sort_order: number
      enabled: number
      created_at: string
      updated_at: string
    }>()

  const apiBase = new URL(c.req.url).origin
  const data = result.results.map((row) => ({
    id: row.id,
    platform: row.platform,
    label: row.label,
    value: row.value,
    linkUrl: row.link_url,
    qrCodeKey: row.qr_code_key,
    qrCodeUrl: row.qr_code_key ? `${apiBase}/api/contact-methods/${row.id}/qrcode` : null,
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  return c.json({ data })
})

/**
 * POST /api/admin/contact-methods
 * 创建联系方式
 */
adminContactMethodRoutes.post('/', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const body = await c.req.json<{
    platform: string
    label: string
    value: string
    linkUrl?: string | null
    enabled?: boolean
  }>()

  if (!body.platform || !body.label || !body.value) {
    return c.json({ statusCode: 400, message: 'platform、label、value 为必填项' }, 400)
  }

  if (!CONTACT_PLATFORMS[body.platform]) {
    return c.json({ statusCode: 400, message: `不支持的平台: ${body.platform}` }, 400)
  }

  let linkUrl: string | null
  try {
    linkUrl = normalizeContactLinkUrl(body.linkUrl)
  } catch (error) {
    return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '联系方式跳转链接无效' }, 400)
  }
  const enabled = body.enabled !== undefined ? body.enabled : true

  // 获取最大 sort_order
  const maxRow = await db
    .prepare('SELECT MAX(sort_order) as max_order FROM contact_methods')
    .first<{ max_order: number | null }>()
  const sortOrder = (maxRow?.max_order ?? -1) + 1

  const id = crypto.randomUUID()
  await db
    .prepare(`
      INSERT INTO contact_methods (id, platform, label, value, link_url, sort_order, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    .bind(id, body.platform, body.label, body.value, linkUrl, sortOrder, enabled ? 1 : 0)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'contact_method_create',
    targetType: 'contact_method',
    targetId: id,
    afterValue: { platform: body.platform, label: body.label, value: body.value, linkUrl, enabled },
  })

  return c.json({ message: '联系方式已创建', id }, 201)
})

/**
 * PUT /api/admin/contact-methods/:id
 * 更新联系方式
 */
adminContactMethodRoutes.put('/:id', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const body = await c.req.json<{
    platform?: string
    label?: string
    value?: string
    linkUrl?: string | null
    enabled?: boolean
    sortOrder?: number
  }>()

  // 获取当前记录
  const current = await db
    .prepare('SELECT * FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{
      id: string
      platform: string
      label: string
      value: string
      link_url: string | null
      qr_code_key: string | null
      sort_order: number
      enabled: number
      created_at: string
      updated_at: string
    }>()

  if (!current) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  if (body.platform && !CONTACT_PLATFORMS[body.platform]) {
    return c.json({ statusCode: 400, message: `不支持的平台: ${body.platform}` }, 400)
  }

  const newPlatform = body.platform ?? current.platform
  const newValue = body.value ?? current.value
  const newLabel = body.label ?? current.label
  const newEnabled = body.enabled !== undefined ? body.enabled : current.enabled === 1
  const newSortOrder = body.sortOrder !== undefined ? body.sortOrder : current.sort_order

  // linkUrl: 显式传入则使用（含 null/空字符串 → null），否则保留原值
  let newLinkUrl: string | null
  if (body.linkUrl !== undefined) {
    try {
      newLinkUrl = normalizeContactLinkUrl(body.linkUrl)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '联系方式跳转链接无效' }, 400)
    }
  } else {
    newLinkUrl = current.link_url
  }

  await db
    .prepare(`
      UPDATE contact_methods
      SET platform = ?, label = ?, value = ?, link_url = ?, sort_order = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .bind(newPlatform, newLabel, newValue, newLinkUrl, newSortOrder, newEnabled ? 1 : 0, id)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'contact_method_update',
    targetType: 'contact_method',
    targetId: id,
    beforeValue: { platform: current.platform, label: current.label, value: current.value, linkUrl: current.link_url, enabled: current.enabled === 1 },
    afterValue: { platform: newPlatform, label: newLabel, value: newValue, linkUrl: newLinkUrl, enabled: newEnabled },
  })

  return c.json({ message: '联系方式已更新' })
})

/**
 * DELETE /api/admin/contact-methods/:id
 * 删除联系方式
 */
adminContactMethodRoutes.delete('/:id', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const current = await db
    .prepare('SELECT id, platform, label, value, qr_code_key FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; platform: string; label: string; value: string; qr_code_key: string | null }>()

  if (!current) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  // 删除 R2 二维码
  if (current.qr_code_key) {
    if (!isExpectedContactQrCodeKey(current.qr_code_key, id)) {
      return c.json({ statusCode: 409, message: '二维码 R2 key 与当前联系方式不匹配，请先人工核查' }, 409)
    }
    await r2.delete(current.qr_code_key)
  }

  await db.prepare('DELETE FROM contact_methods WHERE id = ?').bind(id).run()

  await writeAuditLog(db, {
    adminId,
    action: 'contact_method_delete',
    targetType: 'contact_method',
    targetId: id,
    beforeValue: { platform: current.platform, label: current.label, value: current.value },
  })

  return c.json({ message: '联系方式已删除' })
})

/**
 * PATCH /api/admin/contact-methods/reorder
 * 批量排序
 */
adminContactMethodRoutes.patch('/reorder', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const body = await c.req.json<{ ids: string[] }>()

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ statusCode: 400, message: 'ids 必须为非空数组' }, 400)
  }

  const stmts = body.ids.map((id, index) =>
    db.prepare('UPDATE contact_methods SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(index, id)
  )
  await db.batch(stmts)

  await writeAuditLog(db, {
    adminId,
    action: 'contact_method_reorder',
    targetType: 'contact_method',
    afterValue: { ids: body.ids },
  })

  return c.json({ message: '排序已更新' })
})

/**
 * POST /api/admin/contact-methods/:id/qrcode
 * 上传二维码图片
 */
adminContactMethodRoutes.post('/:id/qrcode', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const current = await db
    .prepare('SELECT id, qr_code_key FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; qr_code_key: string | null }>()

  if (!current) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return c.json({ statusCode: 400, message: '请上传文件（字段名: file）' }, 400)
  }

  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    return c.json({ statusCode: 400, message: '仅支持 PNG、JPEG、WebP 格式' }, 400)
  }

  const maxSize = 2 * 1024 * 1024 // 2MB
  if (file.size > maxSize) {
    return c.json({ statusCode: 400, message: '文件大小不能超过 2MB' }, 400)
  }

  // 删除旧文件
  if (current.qr_code_key) {
    if (!isExpectedContactQrCodeKey(current.qr_code_key, id)) {
      return c.json({ statusCode: 409, message: '二维码 R2 key 与当前联系方式不匹配，请先人工核查' }, 409)
    }
    await r2.delete(current.qr_code_key)
  }

  const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1]
  const key = `qrcodes/${id}.${ext}`

  await r2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  })

  await db
    .prepare("UPDATE contact_methods SET qr_code_key = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(key, id)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'contact_method_qrcode_upload',
    targetType: 'contact_method',
    targetId: id,
    afterValue: { qrCodeKey: key },
  })

  return c.json({ message: '二维码已上传', qrCodeKey: key })
})

/**
 * DELETE /api/admin/contact-methods/:id/qrcode
 * 删除二维码
 */
adminContactMethodRoutes.delete('/:id/qrcode', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const current = await db
    .prepare('SELECT id, qr_code_key FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; qr_code_key: string | null }>()

  if (!current) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  if (!current.qr_code_key) {
    return c.json({ statusCode: 404, message: '该联系方式没有二维码' }, 404)
  }

  if (!isExpectedContactQrCodeKey(current.qr_code_key, id)) {
    return c.json({ statusCode: 409, message: '二维码 R2 key 与当前联系方式不匹配，请先人工核查' }, 409)
  }

  await r2.delete(current.qr_code_key)

  await db
    .prepare("UPDATE contact_methods SET qr_code_key = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'contact_method_qrcode_delete',
    targetType: 'contact_method',
    targetId: id,
    beforeValue: { qrCodeKey: current.qr_code_key },
  })

  return c.json({ message: '二维码已删除' })
})
