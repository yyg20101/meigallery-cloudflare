import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { cacheControl } from '../middleware/cache'
import { getPublicImageUrl, getPublicOrderClause } from '../utils/testimonial-cases'

export const testimonialCaseRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

testimonialCaseRoutes.get('/', cacheControl(120), async (c) => {
  const db = c.env.DB
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query('pageSize') || '12', 10)))
  const featuredOnly = c.req.query('featured') === 'true'
  const offset = (page - 1) * pageSize
  const params: unknown[] = ['published']
  let whereClause = ' WHERE tc.status = ?'

  if (featuredOnly) {
    whereClause += ' AND tc.featured = 1'
  }

  const totalRow = await db
    .prepare(`SELECT COUNT(*) as total FROM testimonial_cases tc${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()

  const rows = await db
    .prepare(`
      SELECT tc.id, tc.title, tc.slug, tc.summary, tc.published_at,
             COUNT(tci.id) as image_count,
             first_image.id as cover_image_id
      FROM testimonial_cases tc
      LEFT JOIN testimonial_case_images tci ON tci.case_id = tc.id
      LEFT JOIN testimonial_case_images first_image ON first_image.id = (
        SELECT id FROM testimonial_case_images
        WHERE case_id = tc.id
        ORDER BY sort_order ASC, created_at ASC
        LIMIT 1
      )
      ${whereClause}
      GROUP BY tc.id
      ${getPublicOrderClause(c.req.query('sort') || 'sort')}
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all<{
      id: string
      title: string
      slug: string
      summary: string | null
      published_at: string | null
      image_count: number
      cover_image_id: string | null
    }>()

  return c.json({
    data: rows.results.map(row => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      imageCount: row.image_count,
      coverImageUrl: row.cover_image_id ? getPublicImageUrl(row.cover_image_id) : null,
      publishedAt: row.published_at,
    })),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  })
})

testimonialCaseRoutes.get('/images/:imageId', cacheControl(86400), async (c) => {
  const imageId = c.req.param('imageId')
  const row = await c.env.DB
    .prepare(`
      SELECT tci.r2_key, tci.mime_type
      FROM testimonial_case_images tci
      JOIN testimonial_cases tc ON tc.id = tci.case_id
      WHERE tci.id = ? AND tc.status = 'published'
    `)
    .bind(imageId)
    .first<{ r2_key: string; mime_type: string }>()

  if (!row) return c.json({ statusCode: 404, message: '图片不存在' }, 404)

  const object = await c.env.R2.get(row.r2_key)
  if (!object) return c.json({ statusCode: 404, message: '图片文件不存在' }, 404)

  c.header('Content-Type', row.mime_type)
  c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  return c.body(object.body)
})

testimonialCaseRoutes.get('/:slug', cacheControl(120), async (c) => {
  const slug = c.req.param('slug')
  const db = c.env.DB
  const row = await db
    .prepare(`
      SELECT id, title, slug, summary, body_md, seo_title, seo_description, published_at
      FROM testimonial_cases
      WHERE slug = ? AND status = 'published'
    `)
    .bind(slug)
    .first<{
      id: string
      title: string
      slug: string
      summary: string | null
      body_md: string | null
      seo_title: string | null
      seo_description: string | null
      published_at: string | null
    }>()

  if (!row) return c.json({ statusCode: 404, message: '真实案例不存在或暂未公开' }, 404)

  const images = await db
    .prepare(`
      SELECT id, alt_text, sort_order
      FROM testimonial_case_images
      WHERE case_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `)
    .bind(row.id)
    .all<{ id: string; alt_text: string | null; sort_order: number }>()

  return c.json({
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    bodyMd: row.body_md,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    publishedAt: row.published_at,
    images: images.results.map(image => ({
      id: image.id,
      url: getPublicImageUrl(image.id),
      alt: image.alt_text || `${row.title} 图片`,
      sortOrder: image.sort_order,
    })),
  })
})
