import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { safeContactLinkUrl } from '../utils/contact-link-url'
import { isExpectedContactQrCodeKey } from '../utils/contact-qrcode'
import { generateContactLink } from '@meigallery/shared/constants'

export const contactMethodRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/contact-methods
 * 公开接口：返回所有已启用的联系方式，按 sort_order 排序
 */
contactMethodRoutes.get('/', async (c) => {
  const db = c.env.DB
  const result = await db
    .prepare(`
      SELECT id, platform, label, value, link_url, qr_code_key, sort_order
      FROM contact_methods
      WHERE enabled = 1
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
    }>()

  const apiBase = new URL(c.req.url).origin
  const data = result.results.map((row) => ({
    id: row.id,
    platform: row.platform,
    label: row.label,
    value: row.value,
    linkUrl: safeContactLinkUrl(row.link_url) || generateContactLink(row.platform, row.value),
    qrCodeUrl: row.qr_code_key ? `${apiBase}/api/contact-methods/${row.id}/qrcode` : null,
    sortOrder: row.sort_order,
  }))

  return c.json({ data })
})

/**
 * GET /api/contact-methods/:id/qrcode
 * 公开接口：返回指定联系方式的二维码图片
 */
contactMethodRoutes.get('/:id/qrcode', async (c) => {
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const row = await db
    .prepare('SELECT qr_code_key FROM contact_methods WHERE id = ? AND enabled = 1')
    .bind(id)
    .first<{ qr_code_key: string | null }>()

  if (!row?.qr_code_key) {
    return c.json({ statusCode: 404, message: '二维码不存在' }, 404)
  }
  if (!isExpectedContactQrCodeKey(row.qr_code_key, id)) {
    return c.json({ statusCode: 404, message: '二维码配置异常' }, 404)
  }

  const object = await r2.get(row.qr_code_key)
  if (!object) {
    return c.json({ statusCode: 404, message: '二维码文件未找到' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png')
  headers.set('Cache-Control', 'public, max-age=86400')
  return new Response(object.body, { headers })
})
