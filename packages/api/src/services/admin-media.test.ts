import { describe, expect, it, vi } from 'vitest'
import {
  AdminMediaError,
  deleteAdminMediaAsset,
  listAdminGalleryMedia,
  setAdminGalleryCoverFromAsset,
  updateAdminMediaAsset,
  uploadAdminGalleryMedia,
} from './admin-media'

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

function imageFile(name: string, type = 'image/jpeg', size = 4) {
  return new File([new Uint8Array(size)], name, { type })
}

describe('后台媒体服务', () => {
  it('媒体列表缩略图只下发安全外链或内部代理', async () => {
    const db = createDb({
      first: sql => sql.includes('SELECT id FROM galleries') ? { id: 'gal_1' } : null,
      all: sql => sql.includes('FROM media_assets')
        ? [
            mediaRow('safe', 'HTTPS://example.com/source.jpg?next="x"'),
            mediaRow('unsafe', 'http://example.com/source.jpg'),
            mediaRow('local', 'https://127.0.0.1/source.jpg'),
            mediaRow('r2', 'originals/gal_1/r2.jpg'),
            { ...mediaRow('video', 'https://example.com/video.mp4'), type: 'video' },
          ]
        : [],
    })

    const result = await listAdminGalleryMedia(db as unknown as D1Database, 'gal_1')

    expect(result.data).toEqual([
      expect.objectContaining({ id: 'safe', thumbnailUrl: 'https://example.com/source.jpg?next=%22x%22' }),
      expect.objectContaining({ id: 'unsafe', thumbnailUrl: null }),
      expect.objectContaining({ id: 'local', thumbnailUrl: null }),
      expect.objectContaining({ id: 'r2', thumbnailUrl: '/api/media/r2/thumbnail' }),
      expect.objectContaining({ id: 'video', thumbnailUrl: null }),
    ])
  })

  it('上传图片会跳过非法文件并记录成功与失败数量审计', async () => {
    const r2Put = vi.fn()
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id FROM galleries')) return { id: 'gal_1' }
        if (sql.includes('MAX(sort_order)')) return { max_order: 2 }
        return null
      },
    })
    const files = [
      imageFile('ok.jpg', 'image/jpeg'),
      imageFile('bad.gif', 'image/gif'),
    ]

    const result = await uploadAdminGalleryMedia(
      db as unknown as D1Database,
      { put: r2Put } as unknown as R2Bucket,
      1,
      'gal_1',
      files,
    )

    expect(result.uploaded).toHaveLength(1)
    expect(result.uploaded[0].sortOrder).toBe(3)
    expect(result.failed).toEqual([{ filename: 'bad.gif', error: '不支持的文件格式: image/gif' }])
    expect(r2Put).toHaveBeenCalledTimes(1)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && String(call.params[6]).includes('"uploadedCount":1'))).toBe(true)
  })

  it('设置封面时拒绝不安全外部媒体地址', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id, cover_key FROM galleries')) return { id: 'gal_1', cover_key: null }
        if (sql.includes('SELECT id, gallery_id, r2_key FROM media_assets')) {
          return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'http://example.com/source.jpg' }
        }
        return null
      },
    })

    await expect(setAdminGalleryCoverFromAsset(db as unknown as D1Database, 1, 'gal_1', 'asset_1'))
      .rejects.toMatchObject(new AdminMediaError(400, '媒体资源地址不安全，不能设为封面'))
    expect(db.calls.some(call => call.sql.includes('UPDATE galleries SET cover_key'))).toBe(false)
  })

  it('设置封面时拒绝不属于当前图库和媒体的 R2 key', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id, cover_key FROM galleries')) return { id: 'gal_1', cover_key: null }
        if (sql.includes('SELECT id, gallery_id, r2_key FROM media_assets')) {
          return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'originals/gal_2/asset_1.jpg' }
        }
        return null
      },
    })

    await expect(setAdminGalleryCoverFromAsset(db as unknown as D1Database, 1, 'gal_1', 'asset_1'))
      .rejects.toMatchObject(new AdminMediaError(409, '媒体 R2 key 与当前图库/媒体不匹配，请先人工核查'))
    expect(db.calls.some(call => call.sql.includes('UPDATE galleries SET cover_key'))).toBe(false)
  })

  it('更新媒体属性时校验会员 rank 和角色白名单', async () => {
    const db = createDb({
      first: () => ({ id: 'asset_1', gallery_id: 'gal_1', required_rank: 0, sort_order: 1, role: 'content' }),
    })

    await expect(updateAdminMediaAsset(db as unknown as D1Database, 1, 'asset_1', { requiredRank: 7 }))
      .rejects.toMatchObject(new AdminMediaError(400, '无效的会员等级，允许值: 0, 10, 20'))
    await expect(updateAdminMediaAsset(db as unknown as D1Database, 1, 'asset_1', { role: 'hero' }))
      .rejects.toMatchObject(new AdminMediaError(400, '无效的角色'))
  })

  it('删除媒体时只删除匹配当前图库和媒体的 R2 key', async () => {
    const r2Delete = vi.fn()
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id, gallery_id, r2_key')) {
          return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'originals/gal_1/asset_1.jpg', type: 'image' }
        }
        if (sql.includes('SELECT cover_key FROM galleries')) return { cover_key: 'originals/gal_1/asset_1.jpg' }
        return null
      },
    })

    const result = await deleteAdminMediaAsset(
      db as unknown as D1Database,
      { delete: r2Delete } as unknown as R2Bucket,
      1,
      'asset_1',
    )

    expect(result).toEqual({ success: true })
    expect(r2Delete).toHaveBeenCalledWith('originals/gal_1/asset_1.jpg')
    expect(db.calls.some(call => call.sql.includes('SET cover_key = NULL'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('删除媒体时不会删除外链，也会拒绝异常 R2 key', async () => {
    const externalDelete = vi.fn()
    const externalDb = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id, gallery_id, r2_key')) {
          return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'HTTPS://example.com/source.jpg', type: 'image' }
        }
        if (sql.includes('SELECT cover_key FROM galleries')) return { cover_key: null }
        return null
      },
    })

    await deleteAdminMediaAsset(
      externalDb as unknown as D1Database,
      { delete: externalDelete } as unknown as R2Bucket,
      1,
      'asset_1',
    )
    expect(externalDelete).not.toHaveBeenCalled()

    const unsafeDb = createDb({
      first: sql => sql.includes('SELECT id, gallery_id, r2_key')
        ? { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'originals/gal_2/asset_1.jpg', type: 'image' }
        : null,
    })
    const unsafeDelete = vi.fn()

    await expect(deleteAdminMediaAsset(
      unsafeDb as unknown as D1Database,
      { delete: unsafeDelete } as unknown as R2Bucket,
      1,
      'asset_1',
    )).rejects.toMatchObject(new AdminMediaError(409, '媒体 R2 key 与当前图库/媒体不匹配，请先人工核查'))
    expect(unsafeDelete).not.toHaveBeenCalled()
  })
})

function mediaRow(id: string, r2Key: string | null) {
  return {
    id,
    gallery_id: 'gal_1',
    type: 'image',
    storage: 'r2',
    r2_key: r2Key,
    stream_uid: null,
    required_rank: 0,
    role: 'content',
    sort_order: 0,
    upload_status: 'completed',
    created_at: '2026-05-31T00:00:00.000Z',
  }
}
