import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import {
  assertPublishableImageCount,
  getPublicImageUrl,
  getR2Extension,
  isAllowedImageType,
  isValidSlug,
  normalizeSortOrder,
} from '../../utils/testimonial-cases'

export const adminTestimonialCaseRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminTestimonialCaseRoutes.use('*', requireAdmin)

type CaseBody = {
  title?: string
  slug?: string
  summary?: string
  bodyMd?: string
  status?: 'draft' | 'published'
  featured?: boolean
  sortOrder?: number
  seoTitle?: string
  seoDescription?: string
}

type UploadFailure = { statusCode: number; message: string; status: 400 }
type UploadedTestimonialImage = { id: string; url: string; sortOrder: number }
type UploadResult = { ok: true; uploaded: UploadedTestimonialImage[] } | { ok: false; error: UploadFailure }

function validateCaseBody(body: CaseBody): string | null {
  if (!body.title || body.title.trim().length > 80) return '标题为必填且不能超过 80 字'
  if (!body.slug || !isValidSlug(body.slug)) return 'slug 只能包含小写字母、数字和短横线'
  if (body.summary && body.summary.length > 160) return '摘要不能超过 160 字'
  if (body.bodyMd && body.bodyMd.length > 5000) return '正文不能超过 5000 字'
  if (body.status && !['draft', 'published'].includes(body.status)) return '状态不合法'
  return null
}

function isMultipartRequest(contentType: string | undefined): boolean {
  return (contentType || '').toLowerCase().includes('multipart/form-data')
}

function formString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key)
  return typeof value === 'string' ? value : undefined
}

function formBoolean(formData: FormData, key: string): boolean | undefined {
  const value = formString(formData, key)
  if (value === undefined || value === '') return undefined
  return value === 'true' || value === '1'
}

function formNumber(formData: FormData, key: string): number | undefined {
  const value = formString(formData, key)
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function caseBodyFromFormData(formData: FormData): CaseBody {
  return {
    title: formString(formData, 'title'),
    slug: formString(formData, 'slug'),
    summary: formString(formData, 'summary'),
    bodyMd: formString(formData, 'bodyMd'),
    status: formString(formData, 'status') as CaseBody['status'],
    featured: formBoolean(formData, 'featured'),
    sortOrder: formNumber(formData, 'sortOrder'),
    seoTitle: formString(formData, 'seoTitle'),
    seoDescription: formString(formData, 'seoDescription'),
  }
}

async function uploadTestimonialImages(db: D1Database, r2: R2Bucket, caseId: string, files: File[], startOrder: number): Promise<UploadResult> {
  let nextOrder = startOrder
  const uploaded: UploadedTestimonialImage[] = []

  for (const file of files) {
    if (!isAllowedImageType(file.type)) return { ok: false, error: { statusCode: 400, message: `不支持的文件格式: ${file.type}`, status: 400 } }
    if (file.size > 10 * 1024 * 1024) return { ok: false, error: { statusCode: 400, message: '单张图片最大 10MB', status: 400 } }

    const imageId = generateId('tci')
    const ext = getR2Extension(file.name, file.type)
    const r2Key = `testimonials/${caseId}/${imageId}.${ext}`
    await r2.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
    await db.prepare(`
      INSERT INTO testimonial_case_images (id, case_id, r2_key, alt_text, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(imageId, caseId, r2Key, file.name, file.type, file.size, nextOrder).run()
    uploaded.push({ id: imageId, url: getPublicImageUrl(imageId), sortOrder: nextOrder })
    nextOrder += 1
  }

  return { ok: true, uploaded }
}

adminTestimonialCaseRoutes.get('/', async (c) => {
  const db = c.env.DB
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query('pageSize') || '20', 10)))
  const status = c.req.query('status')
  const offset = (page - 1) * pageSize
  const params: unknown[] = []
  let whereClause = ''

  if (status === 'draft' || status === 'published') {
    whereClause = ' WHERE tc.status = ?'
    params.push(status)
  }

  const total = await db
    .prepare(`SELECT COUNT(*) as total FROM testimonial_cases tc${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()

  const rows = await db
    .prepare(`
      SELECT tc.id, tc.title, tc.slug, tc.status, tc.featured, tc.sort_order,
             tc.published_at, tc.updated_at, COUNT(tci.id) as image_count
      FROM testimonial_cases tc
      LEFT JOIN testimonial_case_images tci ON tci.case_id = tc.id
      ${whereClause}
      GROUP BY tc.id
      ORDER BY tc.sort_order ASC, tc.updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all<{
      id: string
      title: string
      slug: string
      status: string
      featured: number
      sort_order: number
      published_at: string | null
      updated_at: string
      image_count: number
    }>()

  return c.json({
    data: rows.results.map(row => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      featured: Boolean(row.featured),
      sortOrder: row.sort_order,
      imageCount: row.image_count,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    })),
    total: total?.total ?? 0,
    page,
    pageSize,
  })
})

adminTestimonialCaseRoutes.get('/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const row = await db.prepare('SELECT * FROM testimonial_cases WHERE id = ?').bind(id).first<{
    id: string
    title: string
    slug: string
    summary: string | null
    body_md: string | null
    status: string
    featured: number
    sort_order: number
    seo_title: string | null
    seo_description: string | null
    published_at: string | null
    updated_at: string
  }>()
  if (!row) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)

  const images = await db
    .prepare('SELECT id, alt_text, sort_order FROM testimonial_case_images WHERE case_id = ? ORDER BY sort_order ASC, created_at ASC')
    .bind(id)
    .all<{ id: string; alt_text: string | null; sort_order: number }>()

  return c.json({
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    bodyMd: row.body_md,
    status: row.status,
    featured: Boolean(row.featured),
    sortOrder: row.sort_order,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    images: images.results.map(image => ({
      id: image.id,
      url: getPublicImageUrl(image.id),
      alt: image.alt_text || `${row.title} 图片`,
      sortOrder: image.sort_order,
    })),
  })
})

adminTestimonialCaseRoutes.post('/', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const isMultipart = isMultipartRequest(c.req.header('Content-Type'))
  const formData = isMultipart ? await c.req.formData() : null
  const files = formData?.getAll('files') as unknown as File[] | undefined
  const body = formData ? caseBodyFromFormData(formData) : await c.req.json<CaseBody>()
  const error = validateCaseBody(body)
  if (error) return c.json({ statusCode: 400, message: error }, 400)
  if (files && files.length > 9) return c.json({ statusCode: 400, message: '每个真实案例最多 9 张图片' }, 400)

  const id = generateId('tc')
  const status = body.status || 'draft'
  const publishedAt = status === 'published' ? new Date().toISOString() : null

  if (status === 'published') {
    return c.json({ statusCode: 400, message: '新建案例需先保存草稿并上传 2-9 张图片后再发布' }, 400)
  }

  await db.prepare(`
    INSERT INTO testimonial_cases
      (id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description, created_by, updated_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.title!.trim(),
    body.slug!.trim(),
    body.summary?.trim() || null,
    body.bodyMd?.trim() || null,
    status,
    body.featured === false ? 0 : 1,
    normalizeSortOrder(body.sortOrder),
    body.seoTitle?.trim() || null,
    body.seoDescription?.trim() || null,
    adminId,
    adminId,
    publishedAt,
  ).run()

  const uploadResult: UploadResult = files && files.length > 0
    ? await uploadTestimonialImages(db, c.env.R2, id, files, 0)
    : { ok: true, uploaded: [] }
  if (!uploadResult.ok) return c.json({ statusCode: uploadResult.error.statusCode, message: uploadResult.error.message }, uploadResult.error.status)

  await writeAuditLog(db, {
    adminId,
    action: 'create_testimonial_case',
    targetType: 'testimonial_case',
    targetId: id,
    afterValue: { title: body.title, slug: body.slug, status, uploadedCount: uploadResult.uploaded.length },
  })

  return c.json({ id, message: '真实案例已创建', uploaded: uploadResult.uploaded }, 201)
})

adminTestimonialCaseRoutes.patch('/:id', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const body = await c.req.json<CaseBody>()
  const error = validateCaseBody(body)
  if (error) return c.json({ statusCode: 400, message: error }, 400)

  const before = await db.prepare('SELECT * FROM testimonial_cases WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!before) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)

  if (body.status === 'published') {
    const imageCount = await db
      .prepare('SELECT COUNT(*) as count FROM testimonial_case_images WHERE case_id = ?')
      .bind(id)
      .first<{ count: number }>()
    try {
      assertPublishableImageCount(imageCount?.count ?? 0)
    } catch (e) {
      return c.json({ statusCode: 400, message: e instanceof Error ? e.message : '图片数量不合法' }, 400)
    }
  }

  const publishedAt = body.status === 'published' && !before.published_at ? new Date().toISOString() : before.published_at
  await db.prepare(`
    UPDATE testimonial_cases
    SET title = ?, slug = ?, summary = ?, body_md = ?, status = ?, featured = ?, sort_order = ?,
        seo_title = ?, seo_description = ?, updated_by = ?, published_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    body.title!.trim(),
    body.slug!.trim(),
    body.summary?.trim() || null,
    body.bodyMd?.trim() || null,
    body.status || 'draft',
    body.featured === false ? 0 : 1,
    normalizeSortOrder(body.sortOrder),
    body.seoTitle?.trim() || null,
    body.seoDescription?.trim() || null,
    adminId,
    publishedAt,
    id,
  ).run()

  await writeAuditLog(db, {
    adminId,
    action: 'update_testimonial_case',
    targetType: 'testimonial_case',
    targetId: id,
    beforeValue: before,
    afterValue: body,
  })

  return c.json({ message: '真实案例已更新' })
})

adminTestimonialCaseRoutes.delete('/:id', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const before = await db.prepare('SELECT * FROM testimonial_cases WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!before) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)

  const images = await db
    .prepare('SELECT id, r2_key FROM testimonial_case_images WHERE case_id = ?')
    .bind(id)
    .all<{ id: string; r2_key: string }>()

  for (const image of images.results) {
    await c.env.R2.delete(image.r2_key)
  }
  await db.prepare('DELETE FROM testimonial_cases WHERE id = ?').bind(id).run()

  await writeAuditLog(db, {
    adminId,
    action: 'delete_testimonial_case',
    targetType: 'testimonial_case',
    targetId: id,
    beforeValue: before,
    afterValue: { deletedImages: images.results.length },
  })

  return c.json({ message: '真实案例已删除' })
})

adminTestimonialCaseRoutes.post('/:id/images', async (c) => {
  const db = c.env.DB
  const r2 = c.env.R2
  const adminId = c.get('userId')!
  const caseId = c.req.param('id')
  const formData = await c.req.formData()
  const files = formData.getAll('files') as unknown as File[]

  const caseRow = await db.prepare('SELECT id FROM testimonial_cases WHERE id = ?').bind(caseId).first<{ id: string }>()
  if (!caseRow) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)
  if (files.length === 0) return c.json({ statusCode: 400, message: '请选择至少一张图片' }, 400)

  const current = await db.prepare('SELECT COUNT(*) as count FROM testimonial_case_images WHERE case_id = ?').bind(caseId).first<{ count: number }>()
  if ((current?.count ?? 0) + files.length > 9) {
    return c.json({ statusCode: 400, message: '每个真实案例最多 9 张图片' }, 400)
  }

  const maxOrder = await db.prepare('SELECT MAX(sort_order) as max_order FROM testimonial_case_images WHERE case_id = ?').bind(caseId).first<{ max_order: number | null }>()
  const uploadResult = await uploadTestimonialImages(db, r2, caseId, files, (maxOrder?.max_order ?? -1) + 1)
  if (!uploadResult.ok) return c.json({ statusCode: uploadResult.error.statusCode, message: uploadResult.error.message }, uploadResult.error.status)

  await writeAuditLog(db, {
    adminId,
    action: 'upload_testimonial_images',
    targetType: 'testimonial_case',
    targetId: caseId,
    afterValue: { uploadedCount: uploadResult.uploaded.length },
  })

  return c.json({ uploaded: uploadResult.uploaded }, 201)
})

adminTestimonialCaseRoutes.patch('/:id/images/order', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const caseId = c.req.param('id')
  const body = await c.req.json<{ imageIds: string[] }>()
  if (!Array.isArray(body.imageIds)) return c.json({ statusCode: 400, message: 'imageIds 为必填数组' }, 400)

  for (const [index, imageId] of body.imageIds.entries()) {
    await db.prepare('UPDATE testimonial_case_images SET sort_order = ? WHERE id = ? AND case_id = ?').bind(index, imageId, caseId).run()
  }

  await writeAuditLog(db, {
    adminId,
    action: 'sort_testimonial_images',
    targetType: 'testimonial_case',
    targetId: caseId,
    afterValue: { imageIds: body.imageIds },
  })

  return c.json({ message: '图片排序已保存' })
})

adminTestimonialCaseRoutes.delete('/:id/images/:imageId', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const caseId = c.req.param('id')
  const imageId = c.req.param('imageId')
  const image = await db.prepare('SELECT r2_key FROM testimonial_case_images WHERE id = ? AND case_id = ?').bind(imageId, caseId).first<{ r2_key: string }>()
  if (!image) return c.json({ statusCode: 404, message: '图片不存在' }, 404)

  await c.env.R2.delete(image.r2_key)
  await db.prepare('DELETE FROM testimonial_case_images WHERE id = ? AND case_id = ?').bind(imageId, caseId).run()
  await writeAuditLog(db, {
    adminId,
    action: 'delete_testimonial_image',
    targetType: 'testimonial_case',
    targetId: caseId,
    beforeValue: { imageId, r2Key: image.r2_key },
  })

  return c.json({ message: '图片已删除' })
})
