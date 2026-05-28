import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { validateTurnstile } from '../../utils/turnstile'
import { PAGINATION, R2_KEY_PREFIX } from '@meigallery/shared/constants'

export const adminImportRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET / - 导入任务列表
 */
adminImportRoutes.get('/', async (c) => {
  const db = c.env.DB
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)))
  const offset = (page - 1) * pageSize

  const countResult = await db.prepare('SELECT COUNT(*) as total FROM import_jobs').first<{ total: number }>()
  const total = countResult?.total ?? 0

  const jobs = await db
    .prepare(`
      SELECT ij.id, ij.type, ij.status, ij.total_count, ij.success_count, ij.failure_count,
             ij.created_by, u.email as creator_email, ij.created_at, ij.completed_at
      FROM import_jobs ij
      JOIN users u ON ij.created_by = u.id
      ORDER BY ij.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(pageSize, offset)
    .all()

  return c.json({ data: jobs.results, total, page, pageSize })
})

/**
 * GET /:id - 任务详情
 */
adminImportRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB

  const job = await db
    .prepare(`
      SELECT ij.*, u.email as creator_email
      FROM import_jobs ij
      JOIN users u ON ij.created_by = u.id
      WHERE ij.id = ?
    `)
    .bind(id)
    .first()

  if (!job) return c.json({ statusCode: 404, message: '任务不存在' }, 404)
  return c.json(job)
})

/**
 * POST / - 创建导入任务
 */
adminImportRoutes.post('/', async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB

  // 检查并发限制
  const processing = await db
    .prepare("SELECT COUNT(*) as count FROM import_jobs WHERE status = 'processing'")
    .first<{ count: number }>()
  if ((processing?.count ?? 0) >= 3) {
    return c.json({ statusCode: 429, message: '导入任务已达上限（3个），请等待现有任务完成' }, 429)
  }

  const body = await c.req.json<{
    totalCount?: number
    sourceDescription?: string
    turnstileToken?: string
  }>()

  const turnstileError = await validateTurnstile(c.env, body.turnstileToken)
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)

  const jobId = generateId('imp')

  await db
    .prepare(`
      INSERT INTO import_jobs (id, type, status, total_count, created_by)
      VALUES (?, 'zip', 'queued', ?, ?)
    `)
    .bind(jobId, body.totalCount ?? 0, adminId)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'create_import',
    targetType: 'import_job',
    targetId: jobId,
    afterValue: { totalCount: body.totalCount, source: body.sourceDescription },
  })

  return c.json({ id: jobId, status: 'queued' }, 201)
})

/**
 * POST /:id/process - 处理导入任务
 */
adminImportRoutes.post('/:id/process', async (c) => {
  const jobId = c.req.param('id')
  const adminId = c.get('userId')!
  const userRole = c.get('userRole')!
  const db = c.env.DB

  // 验证任务存在且状态为 queued
  const job = await db
    .prepare("SELECT id, status FROM import_jobs WHERE id = ? AND status = 'queued'")
    .bind(jobId)
    .first<{ id: string; status: string }>()

  if (!job) {
    return c.json({ statusCode: 400, message: '任务不存在或状态不允许处理' }, 400)
  }

  const body = await c.req.json<{
    galleries: Array<{
      folder: string
      title: string
      slug: string
      summary?: string
      bodyMd?: string
      region?: string
      personality?: string
      style?: string
      tags?: string
      requiredLevel?: string
      status?: string
      coverKey?: string
      imageKeys?: string[]
      videoKeys?: Array<{ key: string; role: string; streamUid?: string }>
    }>
    turnstileToken?: string
  }>()

  const turnstileError = await validateTurnstile(c.env, body.turnstileToken)
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)

  // 请求和人机验证通过后再标记 processing，避免失败请求卡住任务。
  await db.prepare("UPDATE import_jobs SET status = 'processing' WHERE id = ?").bind(jobId).run()

  const errors: Array<{ folder: string; error: string }> = []
  let successCount = 0
  let failureCount = 0

  for (const entry of body.galleries) {
    try {
      // 校验必填字段
      if (!entry.title || !entry.slug) {
        errors.push({ folder: entry.folder, error: '缺少 title 或 slug' })
        failureCount++
        continue
      }

      // 检查 slug 唯一性
      const existing = await db.prepare('SELECT id FROM galleries WHERE slug = ?').bind(entry.slug).first()
      if (existing) {
        errors.push({ folder: entry.folder, error: `slug "${entry.slug}" 已存在` })
        failureCount++
        continue
      }

      // 确定状态：Admin 强制 draft，Owner 可按 manifest 设置
      let galleryStatus = 'draft'
      let publishedAt: string | null = null
      if (userRole === 'owner' && entry.status === 'published') {
        galleryStatus = 'published'
        publishedAt = new Date().toISOString()
      }

      // 确定 required_level_rank
      let requiredRank = 0
      if (entry.requiredLevel === 'vip') requiredRank = 10
      else if (entry.requiredLevel === 'svip') requiredRank = 20

      // 创建图库记录
      const galleryId = generateId('gal')
      await db
        .prepare(`
          INSERT INTO galleries (id, title, slug, summary, body_md, cover_key, status, required_level_rank, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          galleryId, entry.title, entry.slug,
          entry.summary || null, entry.bodyMd || null,
          entry.coverKey || null, galleryStatus, requiredRank, publishedAt,
        )
        .run()

      // 处理标签
      const tagSlugs: string[] = []
      if (entry.region) tagSlugs.push(entry.region)
      if (entry.personality) tagSlugs.push(entry.personality)
      if (entry.style) tagSlugs.push(entry.style)
      if (entry.tags) {
        tagSlugs.push(...entry.tags.split(',').map(t => t.trim()).filter(Boolean))
      }

      for (const tagSlug of tagSlugs) {
        const slug = tagSlug.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '-')
        let tag = await db
          .prepare('SELECT id FROM tags WHERE slug = ?')
          .bind(slug)
          .first<{ id: string }>()

        if (!tag) {
          const tagId = generateId('tag')
          await db
            .prepare('INSERT INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)')
            .bind(tagId, 'personality', tagSlug, slug)
            .run()
          tag = { id: tagId }
        }

        await db
          .prepare('INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)')
          .bind(galleryId, tag.id)
          .run()
      }

      // 处理图片
      if (entry.imageKeys) {
        for (let i = 0; i < entry.imageKeys.length; i++) {
          const assetId = generateId('med')
          await db
            .prepare(`
              INSERT INTO media_assets (id, gallery_id, type, role, r2_key, required_rank, sort_order, upload_status)
              VALUES (?, ?, 'image', 'gallery_image', ?, ?, ?, 'completed')
            `)
            .bind(assetId, galleryId, entry.imageKeys[i], requiredRank, i + 1)
            .run()
        }
      }

      // 处理视频
      if (entry.videoKeys) {
        for (const vid of entry.videoKeys) {
          const assetId = generateId('med')
          const videoRank = vid.role === 'full_video' ? requiredRank : 0
          await db
            .prepare(`
              INSERT INTO media_assets (id, gallery_id, type, role, r2_key, stream_uid, required_rank, sort_order, upload_status)
              VALUES (?, ?, 'video', ?, ?, ?, ?, 0, 'completed')
            `)
            .bind(assetId, galleryId, vid.role, vid.key || null, vid.streamUid || null, videoRank)
            .run()
        }
      }

      successCount++
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '未知错误'
      errors.push({ folder: entry.folder, error: message })
      failureCount++
    }
  }

  // 生成错误报告
  let errorReportKey: string | null = null
  if (errors.length > 0) {
    const csvLines = ['folder,error']
    for (const e of errors) {
      csvLines.push(`"${e.folder}","${e.error.replace(/"/g, '""')}"`)
    }
    const csvContent = csvLines.join('\n')
    errorReportKey = `${R2_KEY_PREFIX.IMPORTS}/${jobId}/errors.csv`
    await c.env.R2.put(errorReportKey, csvContent, {
      httpMetadata: { contentType: 'text/csv' },
    })
  }

  // 更新任务状态
  const finalStatus = failureCount === body.galleries.length ? 'failed' : 'completed'
  await db
    .prepare(`
      UPDATE import_jobs
      SET status = ?, success_count = ?, failure_count = ?, total_count = ?,
          error_report_key = ?, completed_at = datetime('now')
      WHERE id = ?
    `)
    .bind(finalStatus, successCount, failureCount, body.galleries.length, errorReportKey, jobId)
    .run()

  return c.json({
    id: jobId,
    status: finalStatus,
    totalCount: body.galleries.length,
    successCount,
    failureCount,
    errors: errors.length > 0 ? errors : undefined,
  })
})

/**
 * GET /:id/errors - 下载错误报告
 */
adminImportRoutes.get('/:id/errors', async (c) => {
  const jobId = c.req.param('id')
  const db = c.env.DB

  const job = await db
    .prepare('SELECT error_report_key FROM import_jobs WHERE id = ?')
    .bind(jobId)
    .first<{ error_report_key: string | null }>()

  if (!job?.error_report_key) {
    return c.json({ statusCode: 404, message: '错误报告不存在' }, 404)
  }

  const object = await c.env.R2.get(job.error_report_key)
  if (!object) {
    return c.json({ statusCode: 404, message: '报告文件不存在' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', 'text/csv; charset=utf-8')
  headers.set('Content-Disposition', `attachment; filename="import-errors-${jobId}.csv"`)
  return new Response(object.body, { headers })
})
