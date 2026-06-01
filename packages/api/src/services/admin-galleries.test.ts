import { describe, expect, it } from 'vitest'
import {
  AdminGalleryError,
  createAdminGallery,
  listAdminGalleries,
  processAdminGalleryBatch,
  updateAdminGallery,
} from './admin-galleries'

interface PreparedCall {
  sql: string
  params: unknown[]
}

function createStatement<T>(call: PreparedCall, handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
}) {
  return {
    bind(...values: unknown[]) {
      call.params = values
      return this
    },
    async first<R>() {
      return (handlers.first?.(call.sql, call.params) ?? null) as R | null
    },
    async all<R>() {
      return { results: (handlers.all?.(call.sql, call.params) ?? []) as R[] }
    },
    async run() {
      return handlers.run?.(call.sql, call.params) ?? { success: true }
    },
  } as T
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
} = {}) {
  const calls: PreparedCall[] = []

  return {
    calls,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return createStatement<D1PreparedStatement>(call, handlers)
    },
    async batch(statements: D1PreparedStatement[]) {
      return statements.map(() => ({ success: true }))
    },
  }
}

describe('后台图库服务', () => {
  it('列表查询会规范分页并构建状态、关键词和标签筛选', async () => {
    const db = createDb({
      first: () => ({ total: 2 }),
      all: () => [
        {
          id: 'gal_1',
          title: '夏日写真',
          slug: 'summer',
          status: 'published',
          required_level_rank: 0,
          cover_key: null,
          published_at: '2026-06-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
          view_count: 10,
          like_count: 2,
        },
      ],
    })

    const result = await listAdminGalleries(db as unknown as D1Database, {
      page: '0',
      pageSize: '500',
      status: 'published',
      search: '夏日',
      tag: 'fresh',
      sort: 'like_desc',
    })

    expect(result.pagination).toEqual({ page: 1, pageSize: 100, total: 2, totalPages: 1 })
    expect(db.calls[0].sql).toContain('COUNT(DISTINCT g.id)')
    expect(db.calls[0].sql).toContain('INNER JOIN gallery_tags')
    expect(db.calls[0].sql).toContain('g.status = ?')
    expect(db.calls[0].sql).toContain('g.title LIKE ?')
    expect(db.calls[0].params).toEqual(['published', '%夏日%', 'fresh', 'fresh'])
    expect(db.calls[1].sql).toContain('ORDER BY g.like_count DESC')
    expect(db.calls[1].params).toEqual(['published', '%夏日%', 'fresh', 'fresh', 100, 0])
  })

  it('创建图库时普通管理员即使传 published 也会强制草稿', async () => {
    const db = createDb({
      first: () => null,
    })

    const result = await createAdminGallery(db as unknown as D1Database, 1, 'admin', {
      title: '新图库',
      slug: 'new-gallery',
      status: 'published',
      tagIds: ['tag_1'],
    })

    expect(result.status).toBe('draft')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO galleries') && call.params[6] === 'draft')).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('更新图库时拒绝重复 slug', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT * FROM galleries')) {
          return { id: 'gal_1', slug: 'old-slug', status: 'draft' }
        }
        if (sql.includes('SELECT id FROM galleries WHERE slug = ? AND id != ?')) {
          return { id: 'gal_2' }
        }
        return null
      },
    })

    await expect(updateAdminGallery(db as unknown as D1Database, 1, 'gal_1', { slug: 'new-slug' }))
      .rejects.toMatchObject(new AdminGalleryError(409, 'slug 已存在'))
  })

  it('批量删除只清理匹配当前图库和媒体的 R2 key', async () => {
    const deletedKeys: unknown[] = []
    const db = createDb({
      all: (sql) => {
        if (sql.includes('SELECT id, gallery_id, r2_key FROM media_assets')) {
          return [
            { id: 'ma_1', gallery_id: 'gal_1', r2_key: 'originals/gal_1/ma_1.jpg' },
            { id: 'ma_2', gallery_id: 'gal_1', r2_key: 'originals/gal_other/ma_2.jpg' },
            { id: 'ma_3', gallery_id: 'gal_1', r2_key: 'https://example.com/remote.jpg' },
          ]
        }
        return []
      },
    })
    const r2 = {
      async delete(keys: string[]) {
        deletedKeys.push(keys)
      },
    }

    const result = await processAdminGalleryBatch(
      db as unknown as D1Database,
      r2 as unknown as R2Bucket,
      1,
      'owner',
      { action: 'delete', galleryIds: ['gal_1'] },
    )

    expect(result).toMatchObject({ affected: 1, success: 1, failed: 0 })
    expect(deletedKeys).toEqual([['originals/gal_1/ma_1.jpg']])
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })
})
