import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { PAGINATION } from '@meigallery/shared/constants'
import { fetchAllPosts, fetchAllCategories, fetchAllTags } from '../../services/wp-fetcher'
import { processPosts, writeMigrationItem } from '../../services/wp-migration'
import { downloadGalleryMedia, downloadImageToR2 } from '../../services/media-downloader'

export const adminLegacyImportRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// POST /sources — 创建旧站来源
adminLegacyImportRoutes.post('/sources', async (c) => {
  const db = c.env.DB
  const body = await c.req.json<{
    name: string
    baseUrl: string
    mode: 'rest_api' | 'xml'
    categoryMapping?: Record<string, string>
    tagMapping?: Record<string, string>
  }>()

  const id = generateId('lsrc')
  await db
    .prepare(
      `INSERT INTO legacy_import_sources (id, name, base_url, mode, category_mapping, tag_mapping)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      body.name,
      body.baseUrl,
      body.mode,
      body.categoryMapping ? JSON.stringify(body.categoryMapping) : null,
      body.tagMapping ? JSON.stringify(body.tagMapping) : null,
    )
    .run()

  const record = await db
    .prepare('SELECT * FROM legacy_import_sources WHERE id = ?')
    .bind(id)
    .first()

  await writeAuditLog(db, {
    adminId: c.get('userId')!,
    action: 'create_legacy_source',
    targetType: 'legacy_import_source',
    targetId: id,
    afterValue: record,
  })

  return c.json(record, 201)
})

// GET /sources — 来源列表
adminLegacyImportRoutes.get('/sources', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare('SELECT * FROM legacy_import_sources ORDER BY created_at DESC').all()
  return c.json({ data: results })
})

// POST /jobs — 启动迁移任务
adminLegacyImportRoutes.post('/jobs', async (c) => {
  const db = c.env.DB
  const body = await c.req.json<{ sourceId: string; description?: string }>()

  // 验证 source 存在
  const source = await db
    .prepare('SELECT id FROM legacy_import_sources WHERE id = ?')
    .bind(body.sourceId)
    .first()
  if (!source) {
    return c.json({ error: '来源不存在' }, 404)
  }

  const id = generateId('job')
  await db
    .prepare(
      `INSERT INTO import_jobs (id, type, status, source_key, total_count, success_count, failure_count, created_by)
       VALUES (?, 'legacy', 'pending', ?, 0, 0, 0, ?)`,
    )
    .bind(id, body.sourceId, c.get('userId')!)
    .run()

  await writeAuditLog(db, {
    adminId: c.get('userId')!,
    action: 'create_legacy_import_job',
    targetType: 'import_job',
    targetId: id,
    afterValue: { sourceId: body.sourceId, description: body.description },
  })

  const record = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first()
  return c.json(record, 201)
})

// GET /jobs/:id — 任务详情
adminLegacyImportRoutes.get('/jobs/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  const job = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first()
  if (!job) {
    return c.json({ error: '任务不存在' }, 404)
  }

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
         SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) as imported_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
         SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) as approved_count,
         SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM legacy_import_items WHERE job_id = ?`,
    )
    .bind(id)
    .first()

  return c.json({ ...job, stats })
})

// GET /items — 条目列表
adminLegacyImportRoutes.get('/items', async (c) => {
  const db = c.env.DB
  const sourceId = c.req.query('sourceId')
  const jobId = c.req.query('jobId')
  const status = c.req.query('status')
  const reviewStatus = c.req.query('reviewStatus')
  const page = Math.max(1, parseInt(c.req.query('page') || String(PAGINATION.DEFAULT_PAGE), 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (sourceId) {
    conditions.push('source_id = ?')
    bindings.push(sourceId)
  }
  if (jobId) {
    conditions.push('job_id = ?')
    bindings.push(jobId)
  }
  if (status) {
    conditions.push('status = ?')
    bindings.push(status)
  }
  if (reviewStatus) {
    conditions.push('review_status = ?')
    bindings.push(reviewStatus)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const offset = (page - 1) * pageSize

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM legacy_import_items ${where}`)
    .bind(...bindings)
    .first<{ total: number }>()

  const { results } = await db
    .prepare(`SELECT * FROM legacy_import_items ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, pageSize, offset)
    .all()

  return c.json({ data: results, total: countResult?.total ?? 0, page, pageSize })
})

// PATCH /items/:id/review — 审核条目
adminLegacyImportRoutes.patch('/items/:id/review', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json<{ reviewStatus: 'approved' | 'rejected'; note?: string }>()

  const item = await db.prepare('SELECT * FROM legacy_import_items WHERE id = ?').bind(id).first<{
    id: string
    gallery_id: string | null
    review_status: string
  }>()
  if (!item) {
    return c.json({ error: '条目不存在' }, 404)
  }

  const flags = body.note ? JSON.stringify({ note: body.note }) : null
  await db
    .prepare('UPDATE legacy_import_items SET review_status = ?, review_flags = ? WHERE id = ?')
    .bind(body.reviewStatus, flags, id)
    .run()

  // 如果 approved 且有 gallery_id，发布 gallery
  if (body.reviewStatus === 'approved' && item.gallery_id) {
    await db
      .prepare("UPDATE galleries SET status = 'published' WHERE id = ?")
      .bind(item.gallery_id)
      .run()
  }

  await writeAuditLog(db, {
    adminId: c.get('userId')!,
    action: 'review_legacy_import_item',
    targetType: 'legacy_import_item',
    targetId: id,
    beforeValue: { reviewStatus: item.review_status },
    afterValue: { reviewStatus: body.reviewStatus, note: body.note },
  })

  return c.json({ success: true })
})

/**
 * POST /jobs/:id/execute — 执行迁移任务
 * 从 WP REST API 拉取文章 → 解析 → 映射 → 写入数据库
 */
adminLegacyImportRoutes.post('/jobs/:id/execute', async (c) => {
  const db = c.env.DB
  const jobId = c.req.param('id')
  const adminId = c.get('userId')!

  // 获取任务和来源信息
  const job = await db
    .prepare("SELECT * FROM import_jobs WHERE id = ? AND type = 'legacy'")
    .bind(jobId)
    .first<{ id: string; status: string; source_key: string }>()

  if (!job) return c.json({ error: '任务不存在' }, 404)
  if (job.status !== 'pending' && job.status !== 'queued') {
    return c.json({ error: '任务状态不允许执行' }, 400)
  }

  const source = await db
    .prepare('SELECT * FROM legacy_import_sources WHERE id = ?')
    .bind(job.source_key)
    .first<{ id: string; base_url: string; mode: string }>()

  if (!source) return c.json({ error: '来源不存在' }, 404)

  // 标记 processing
  await db.prepare("UPDATE import_jobs SET status = 'processing' WHERE id = ?").bind(jobId).run()

  try {
    // 拉取 WP 数据
    const { posts, totalPosts } = await fetchAllPosts({ baseUrl: source.base_url, perPage: 50 })
    const categories = await fetchAllCategories(source.base_url)
    const tags = await fetchAllTags(source.base_url)

    // 获取已有 slugs 避免重复
    const existingResult = await db.prepare('SELECT slug FROM galleries').all<{ slug: string }>()
    const existingSlugs = new Set(existingResult.results.map(r => r.slug))

    // 处理文章
    const migrationResult = processPosts(posts, categories, tags, existingSlugs)

    // 逐条写入
    let successCount = 0
    let failureCount = 0
    const errors: Array<{ title: string; error: string }> = []

    for (const item of migrationResult.items) {
      const writeResult = await writeMigrationItem(db, item, source.id, jobId)
      if (writeResult.success) {
        successCount++
      } else {
        failureCount++
        errors.push({ title: item.galleryData.title, error: writeResult.error || '未知错误' })
      }
    }

    // 更新任务状态
    const totalCount = migrationResult.items.length + migrationResult.skippedDuplicates
    const finalStatus = failureCount === migrationResult.items.length ? 'failed' : 'completed'

    await db
      .prepare(`
        UPDATE import_jobs
        SET status = ?, total_count = ?, success_count = ?, failure_count = ?,
            completed_at = datetime('now')
        WHERE id = ?
      `)
      .bind(finalStatus, totalCount, successCount, failureCount, jobId)
      .run()

    await writeAuditLog(db, {
      adminId,
      action: 'execute_legacy_import',
      targetType: 'import_job',
      targetId: jobId,
      afterValue: {
        totalPosts,
        processed: migrationResult.items.length,
        skippedDuplicates: migrationResult.skippedDuplicates,
        successCount,
        failureCount,
      },
    })

    return c.json({
      status: finalStatus,
      totalPosts,
      processed: migrationResult.items.length,
      skippedDuplicates: migrationResult.skippedDuplicates,
      successCount,
      failureCount,
      errors: errors.length > 0 ? errors.slice(0, 50) : undefined,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '未知错误'
    await db
      .prepare("UPDATE import_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
      .bind(jobId)
      .run()
    return c.json({ error: `迁移执行失败: ${message}` }, 500)
  }
})

/**
 * POST /download-pending — 批量下载待处理媒体（不依赖 job_id）
 * 供本地迁移脚本循环调用
 * query: ?limit=10 （每次处理的数量，默认 10）
 * 图片并行下载（5 并发），视频跳过（需要配置 Stream）
 */
adminLegacyImportRoutes.post('/download-pending', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '10', 10)))

  // 只获取图片类型（视频需要 Stream 配置，单独处理）
  const assets = await db
    .prepare(
      `SELECT id, gallery_id, type, r2_key FROM media_assets
       WHERE upload_status = 'pending' AND r2_key IS NOT NULL AND type = 'image'
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; gallery_id: string; type: string; r2_key: string }>()

  if (assets.results.length === 0) {
    return c.json({ remaining: 0, downloaded: 0, failed: 0, done: true })
  }

  // 查询总剩余数量
  const countResult = await db
    .prepare("SELECT COUNT(*) as cnt FROM media_assets WHERE upload_status = 'pending' AND type = 'image'")
    .first<{ cnt: number }>()

  let downloaded = 0
  let failed = 0
  const errors: string[] = []

  // 并行下载（5 并发）
  const CONCURRENCY = 5
  for (let i = 0; i < assets.results.length; i += CONCURRENCY) {
    const batch = assets.results.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        const result = await downloadImageToR2(c.env.R2, asset.r2_key, asset.gallery_id, asset.id)
        if (result.success && result.r2Key) {
          await db
            .prepare("UPDATE media_assets SET r2_key = ?, upload_status = 'completed' WHERE id = ?")
            .bind(result.r2Key, asset.id)
            .run()
          return { success: true }
        } else {
          await db
            .prepare("UPDATE media_assets SET upload_status = 'failed' WHERE id = ?")
            .bind(asset.id)
            .run()
          return { success: false, error: `${asset.id}: ${result.error}` }
        }
      })
    )

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        downloaded++
      } else {
        failed++
        if (r.status === 'fulfilled' && r.value.error) {
          errors.push(r.value.error)
        } else if (r.status === 'rejected') {
          errors.push(r.reason?.message || '未知错误')
        }
      }
    }
  }

  return c.json({
    remaining: (countResult?.cnt ?? 0) - downloaded - failed,
    downloaded,
    failed,
    done: false,
    errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
  })
})

// ============================================================
// 迁移辅助工具
// ============================================================

/**
 * GET /migrate/status — 迁移资源状态概览
 * 返回图片/视频各状态数量 + 无封面图库数量
 */
adminLegacyImportRoutes.get('/migrate/status', async (c) => {
  const db = c.env.DB

  const [mediaStats, coverStats, totalGalleries] = await Promise.all([
    db
      .prepare(`
        SELECT type, upload_status, COUNT(*) as cnt
        FROM media_assets
        GROUP BY type, upload_status
      `)
      .all<{ type: string; upload_status: string; cnt: number }>(),
    db
      .prepare('SELECT COUNT(*) as cnt FROM galleries WHERE cover_key IS NULL')
      .first<{ cnt: number }>(),
    db
      .prepare('SELECT COUNT(*) as cnt FROM galleries')
      .first<{ cnt: number }>(),
  ])

  // 整理统计
  const stats: Record<string, Record<string, number>> = {}
  for (const row of mediaStats.results) {
    if (!stats[row.type]) stats[row.type] = {}
    stats[row.type]![row.upload_status] = row.cnt
  }

  return c.json({
    media: stats,
    galleries: {
      total: totalGalleries?.cnt ?? 0,
      withoutCover: coverStats?.cnt ?? 0,
    },
  })
})

/**
 * POST /migrate/retry-failed — 重置失败的图片为 pending，可被 download-pending 重新处理
 * 前提：失败图片的 r2_key 仍保留原始外部 URL
 */
adminLegacyImportRoutes.post('/migrate/retry-failed', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!

  // 确认失败图片的 r2_key 仍是外部 URL
  const failedCount = await db
    .prepare("SELECT COUNT(*) as cnt FROM media_assets WHERE upload_status = 'failed' AND type = 'image'")
    .first<{ cnt: number }>()

  if (!failedCount?.cnt) {
    return c.json({ message: '无失败图片', reset: 0 })
  }

  // 重置为 pending
  const result = await db
    .prepare("UPDATE media_assets SET upload_status = 'pending' WHERE upload_status = 'failed' AND type = 'image'")
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'retry_failed_media',
    targetType: 'media_asset',
    afterValue: { resetCount: result.meta?.changes ?? 0 },
  })

  return c.json({
    message: `已重置 ${result.meta?.changes ?? 0} 张失败图片为待下载状态`,
    reset: result.meta?.changes ?? 0,
  })
})

/**
 * POST /migrate/set-covers — 批量为无封面图库设置封面
 * 每个图库取 sort_order 最小的已完成图片作为封面
 * query: ?limit=100 （每次处理数量，默认 100）
 */
adminLegacyImportRoutes.post('/migrate/set-covers', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100', 10)))

  // 找出无封面的图库
  const galleries = await db
    .prepare(`
      SELECT id FROM galleries
      WHERE cover_key IS NULL
      LIMIT ?
    `)
    .bind(limit)
    .all<{ id: string }>()

  if (galleries.results.length === 0) {
    const remaining = await db
      .prepare('SELECT COUNT(*) as cnt FROM galleries WHERE cover_key IS NULL')
      .first<{ cnt: number }>()
    return c.json({ updated: 0, remaining: remaining?.cnt ?? 0, done: true })
  }

  let updated = 0
  let skipped = 0

  for (const gallery of galleries.results) {
    // 取该图库的第一张已完成的图片
    const firstImage = await db
      .prepare(`
        SELECT r2_key FROM media_assets
        WHERE gallery_id = ? AND type = 'image' AND upload_status = 'completed'
          AND r2_key IS NOT NULL AND r2_key NOT LIKE 'http%'
        ORDER BY sort_order ASC, created_at ASC
        LIMIT 1
      `)
      .bind(gallery.id)
      .first<{ r2_key: string }>()

    if (firstImage?.r2_key) {
      await db
        .prepare("UPDATE galleries SET cover_key = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(firstImage.r2_key, gallery.id)
        .run()
      updated++
    } else {
      skipped++ // 该图库没有已完成的 R2 图片
    }
  }

  const remaining = await db
    .prepare('SELECT COUNT(*) as cnt FROM galleries WHERE cover_key IS NULL')
    .first<{ cnt: number }>()

  await writeAuditLog(db, {
    adminId,
    action: 'batch_set_covers',
    targetType: 'gallery',
    afterValue: { updated, skipped, remaining: remaining?.cnt ?? 0 },
  })

  return c.json({
    updated,
    skipped,
    remaining: remaining?.cnt ?? 0,
    done: (remaining?.cnt ?? 0) === 0,
  })
})
