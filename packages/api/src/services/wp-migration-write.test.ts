import { describe, expect, it, vi } from 'vitest'
import type { WpPost } from './wp-fetcher'
import {
  loadLegacyMappingOverrides,
  processPosts,
  writeFailedMigrationItem,
  writeMigrationItem,
  type MigrationItem,
} from './wp-migration'

type RecordedStatement = {
  sql: string
  params: unknown[]
}

function createDb(options: { rejectBatch?: boolean } = {}) {
  const records: RecordedStatement[] = []
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
    if (options.rejectBatch) throw new Error('模拟 batch 回滚')
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  })
  const db = {
    prepare(sql: string) {
      const record: RecordedStatement = { sql, params: [] }
      records.push(record)
      const statement = {
        bind(...params: unknown[]) {
          record.params.push(...params)
          return statement
        },
      }
      return statement
    },
    batch,
  } as unknown as D1Database
  return { db, records, batch }
}

function createItem(mediaCount = 2): MigrationItem {
  return {
    wpPost: {
      id: 42,
      date: '2026-08-20T08:00:00.000Z',
      slug: 'legacy-gallery',
      link: 'https://legacy.example.com/gallery/legacy-gallery/',
      title: { rendered: '旧站图库' },
      content: { rendered: '<p>正文</p>' },
      featured_media: 0,
      categories: [],
      tags: [],
    },
    parsedContent: {
      media: Array.from({ length: mediaCount }, (_, index) => ({
        type: index % 2 === 0 ? 'image' as const : 'video' as const,
        url: `https://legacy.example.com/media/${index + 1}.jpg`,
      })),
      textContent: '正文',
      markdown: '正文',
      rawHtml: '<p>正文</p>',
    },
    mappedTags: [{
      type: 'style',
      name: '清新',
      slug: 'fresh',
      wpId: 9,
      wpSource: 'tag',
    }],
    reviewFlags: ['授权来源待确认'],
    galleryData: {
      id: 'gal_legacy_42',
      title: '旧站图库',
      slug: 'legacy-gallery',
      summary: '正文',
      bodyMd: '正文',
      legacyUrl: 'https://legacy.example.com/gallery/legacy-gallery/',
      legacySlug: 'legacy-gallery',
      status: 'draft',
      requiredLevelRank: 0,
    },
  }
}

describe('WordPress 单篇迁移原子写入', () => {
  it('在一个 D1 batch 中提交完整事实与审计，并按 100 绑定参数限制分块媒体', async () => {
    const { db, records, batch } = createDb()

    const result = await writeMigrationItem(db, createItem(15), 'lsrc_1', 'job_1', 7)

    expect(result).toEqual({ success: true })
    expect(batch).toHaveBeenCalledTimes(1)
    expect(records.some(record => record.sql.includes('INSERT INTO galleries'))).toBe(true)
    expect(records.some(record => record.sql.includes('INSERT INTO legacy_import_items'))).toBe(true)
    expect(records.some(record => record.sql.includes('INSERT OR IGNORE INTO legacy_url_redirects'))).toBe(true)
    expect(records.some(record => record.sql.includes('create_legacy_import_tag'))).toBe(true)
    expect(records.some(record => record.sql.includes('import_legacy_gallery_item'))).toBe(true)

    const legacyItem = records.find(record => record.sql.includes('INSERT INTO legacy_import_items'))
    expect(legacyItem?.sql).toContain('source_snapshot_json')
    expect(JSON.parse(String(legacyItem?.params.at(-1)))).toMatchObject({
      schemaVersion: 1,
      postId: 42,
      categoryIds: [],
      tagIds: [],
      rawHtml: '<p>正文</p>',
    })

    const mediaStatements = records.filter(record => record.sql.includes('INSERT INTO media_assets'))
    expect(mediaStatements).toHaveLength(2)
    expect(mediaStatements.map(statement => statement.params.length)).toEqual([98, 7])
    expect(mediaStatements.every(statement => statement.params.length <= 100)).toBe(true)
    expect(mediaStatements[0]?.sql).toContain('storage')
    expect(mediaStatements.flatMap(statement => statement.params)).toEqual(
      expect.arrayContaining(['r2', 'stream', 'gallery_image', 'preview_video']),
    )

    const audit = records.find(record => record.sql.includes('import_legacy_gallery_item'))
    expect(audit?.params[1]).toBe(7)
    expect(audit?.params[2]).toBe('job_1')
    expect(JSON.parse(String(audit?.params[3]))).toMatchObject({
      sourceId: 'lsrc_1',
      legacyPostId: 42,
      galleryId: 'gal_legacy_42',
      mediaCount: 15,
    })
  })

  it('batch 失败时整篇返回失败，不降级为逐表写入', async () => {
    const { db, batch } = createDb({ rejectBatch: true })

    const result = await writeMigrationItem(db, createItem(), 'lsrc_1', 'job_1', 7)

    expect(result).toEqual({
      success: false,
      errorCode: 'LEGACY_ITEM_WRITE_FAILED',
      error: '单篇迁移写入失败，请检查该任务的失败条目和审计事件',
    })
    expect(batch).toHaveBeenCalledTimes(1)
  })

  it('拒绝不安全的旧站媒体地址且不启动数据库 batch', async () => {
    const { db, batch } = createDb()
    const item = createItem(1)
    item.parsedContent.media[0]!.url = 'http://127.0.0.1/private.jpg'

    const result = await writeMigrationItem(db, item, 'lsrc_1', 'job_1', 7)

    expect(result.success).toBe(false)
    if (result.success) throw new Error('预期不安全地址写入失败')
    expect(result.errorCode).toBe('LEGACY_ITEM_EXTERNAL_URL_INVALID')
    expect(result.error).toBe('仅允许 HTTPS 外部地址')
    expect(batch).not.toHaveBeenCalled()
  })

  it('显式映射直接关联权威标签，不创建同名替代行', async () => {
    const { db, records } = createDb()
    const item = createItem(0)
    item.mappedTags[0]!.existingId = 'tag_authoritative'

    const result = await writeMigrationItem(db, item, 'lsrc_1', 'job_1', 7)

    expect(result).toEqual({ success: true })
    expect(records.some(record => record.sql.includes('INSERT OR IGNORE INTO tags'))).toBe(false)
    const relation = records.find(record => (
      record.sql.includes('INSERT INTO gallery_tags')
      && !record.sql.includes('SELECT')
    ))
    expect(relation?.params).toEqual(['gal_legacy_42', 'tag_authoritative'])
  })

  it('以独立原子 batch 持久化结构化失败条目和最小审计', async () => {
    const { db, records, batch } = createDb()
    const item = createItem(1)
    item.wpPost.link = 'http://127.0.0.1/private'

    await writeFailedMigrationItem(
      db,
      item,
      'lsrc_1',
      'job_1',
      7,
      'https://legacy.example.com',
      {
        success: false,
        errorCode: 'LEGACY_ITEM_EXTERNAL_URL_INVALID',
        error: '仅允许 HTTPS 外部地址',
      },
    )

    expect(batch).toHaveBeenCalledTimes(1)
    const failedItem = records.find(record => (
      record.sql.includes('INSERT INTO legacy_import_items')
      && record.sql.includes("'failed'")
    ))
    expect(failedItem?.params[4]).toBe('https://legacy.example.com/wp-json/wp/v2/posts/42')
    expect(failedItem?.params.at(-2)).toBe('LEGACY_ITEM_EXTERNAL_URL_INVALID')
    expect(failedItem?.params.at(-1)).toBe('仅允许 HTTPS 外部地址')
    const snapshot = JSON.parse(String(failedItem?.params.at(-3)))
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      writeStatus: 'failed',
      postId: 42,
    })

    const audit = records.find(record => record.sql.includes('import_legacy_gallery_item_failed'))
    expect(audit?.params[1]).toBe(7)
    expect(JSON.parse(String(audit?.params[3]))).toMatchObject({
      sourceId: 'lsrc_1',
      jobId: 'job_1',
      legacyPostId: 42,
      errorCode: 'LEGACY_ITEM_EXTERNAL_URL_INVALID',
    })
  })

  it('失败来源快照超限时保存显式省略证据而不是截断原 HTML', async () => {
    const { db, records } = createDb()
    const item = createItem(0)
    item.parsedContent.rawHtml = '文'.repeat(220_000)

    await writeFailedMigrationItem(
      db,
      item,
      'lsrc_1',
      'job_1',
      7,
      'https://legacy.example.com',
      {
        success: false,
        errorCode: 'LEGACY_ITEM_SOURCE_SNAPSHOT_TOO_LARGE',
        error: '单篇旧站来源快照超过 512 KiB，需人工拆分或转存私有制品',
      },
    )

    const failedItem = records.find(record => (
      record.sql.includes('INSERT INTO legacy_import_items')
      && record.sql.includes("'failed'")
    ))
    const snapshotJson = String(failedItem?.params.at(-3))
    const snapshot = JSON.parse(snapshotJson)
    expect(snapshot.rawHtml).toMatchObject({ omitted: true })
    expect(snapshot.rawHtml.byteLength).toBeGreaterThan(512 * 1024)
    expect(new TextEncoder().encode(snapshotJson).byteLength).toBeLessThanOrEqual(512 * 1024)
  })
})

describe('WordPress 迁移数据规范化', () => {
  it('为无效 slug 和空标题生成稳定兜底，并从正文移除远程媒体嵌入', () => {
    const post: WpPost = {
      id: 88,
      date: '2026-08-20T08:00:00.000Z',
      slug: '%%%',
      link: 'https://legacy.example.com/gallery/88/',
      title: { rendered: '😀' },
      content: {
        rendered: '<figure class="wp-block-image"><img src="https://legacy.example.com/a.jpg" /></figure><p>安全正文</p>',
      },
      featured_media: 0,
      categories: [],
      tags: [],
    }

    const result = processPosts([post], [], [], new Set())

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.galleryData).toMatchObject({
      slug: 'legacy-post-88',
      title: '未命名旧站内容 #88',
      bodyMd: '安全正文',
    })
    expect(result.items[0]?.galleryData.bodyMd).not.toContain('legacy.example.com')
    expect(result.items[0]?.parsedContent.media).toHaveLength(1)
  })

  it('按来源文章 ID 跳过已迁移内容，而不只依赖可变 slug', () => {
    const post: WpPost = {
      id: 88,
      date: '2026-08-20T08:00:00.000Z',
      slug: 'renamed-after-import',
      link: 'https://legacy.example.com/gallery/88/',
      title: { rendered: '已迁移内容' },
      content: { rendered: '<p>正文</p>' },
      featured_media: 0,
      categories: [],
      tags: [],
    }

    const result = processPosts([post], [], [], new Set(), new Set([88]))

    expect(result.items).toEqual([])
    expect(result.skippedDuplicates).toBe(1)
  })

  it('原始 HTML 超过快照上限时不进入媒体正则解析并保留失败候选', () => {
    const post = validMappedPost()
    post.content.rendered = `<figure class="wp-block-image"><img src="https://legacy.example.com/a.jpg" /></figure>${'文'.repeat(220_000)}`

    const result = processPosts([post], [], [], new Set())

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.parsedContent.media).toEqual([])
    expect(result.items[0]?.parsedContent.textContent).toBe('')
    expect(result.items[0]?.reviewFlags).toContain(
      '原始 HTML 超过 512 KiB，未进入正文解析，需人工拆分或转存私有制品',
    )
  })
})

describe('WordPress 来源显式标签映射', () => {
  it('解析到权威 tags.id 并覆盖旧站自动分类', async () => {
    const db = {
      prepare() {
        const params: unknown[] = []
        return {
          bind(...values: unknown[]) {
            params.push(...values)
            return this
          },
          async all<T>() {
            return {
              results: params.map((id) => {
                const tagId = String(id)
                return {
                  id: tagId,
                  type: 'style',
                  name: tagId === 'tag_fresh' ? '清新' : '自然',
                  slug: tagId === 'tag_fresh' ? 'fresh' : 'natural',
                }
              }) as T[],
            }
          },
        }
      },
    } as unknown as D1Database
    const overrides = await loadLegacyMappingOverrides(
      db,
      JSON.stringify({ 9: 'tag_fresh' }),
      JSON.stringify({ 11: 'tag_natural' }),
    )
    const post = validMappedPost()

    const result = processPosts(
      [post],
      [{ id: 9, name: '旧分类', slug: 'legacy', parent: 0, count: 1 }],
      [{ id: 11, name: '旧标签', slug: 'legacy-tag', count: 1 }],
      new Set(),
      new Set(),
      overrides,
    )

    expect(result.items[0]?.mappedTags).toEqual([
      expect.objectContaining({ wpId: 9, existingId: 'tag_fresh', slug: 'fresh' }),
      expect.objectContaining({ wpId: 11, existingId: 'tag_natural', slug: 'natural' }),
    ])
  })

  it('映射引用不存在的标签时拒绝执行', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this
          },
          async all<T>() {
            return { results: [] as T[] }
          },
        }
      },
    } as unknown as D1Database

    await expect(loadLegacyMappingOverrides(
      db,
      JSON.stringify({ 9: 'tag_missing' }),
      null,
    )).rejects.toThrow('来源映射引用了不存在的标签')
  })
})

function validMappedPost(): WpPost {
  return {
    id: 99,
    date: '2026-08-20T08:00:00.000Z',
    slug: 'mapped-post',
    link: 'https://legacy.example.com/gallery/mapped-post/',
    title: { rendered: '映射文章' },
    content: { rendered: '<p>正文</p>' },
    featured_media: 0,
    categories: [9],
    tags: [11],
  }
}
