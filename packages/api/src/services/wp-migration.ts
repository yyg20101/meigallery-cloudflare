/**
 * WordPress 迁移执行服务
 * 编排 WP 文章拉取 → HTML 解析 → 标签映射 → 入库流程
 */

import type { WpPost, WpCategory, WpTag } from './wp-fetcher'
import { parseWpContent, type ParsedContent } from './wp-html-parser'
import { mapWpCategories, mapWpTags, type MappedTag } from './wp-category-mapper'
import { generateId } from '../utils/db'

export interface MigrationItem {
  wpPost: WpPost
  parsedContent: ParsedContent
  mappedTags: MappedTag[]
  reviewFlags: string[]
  galleryData: {
    id: string
    title: string
    slug: string
    summary: string
    bodyMd: string
    legacyUrl: string
    legacySlug: string
    status: 'draft'  // 迁移内容始终为 draft
    requiredLevelRank: number
  }
}

export interface MigrationResult {
  totalProcessed: number
  items: MigrationItem[]
  skippedDuplicates: number
}

/**
 * 处理一批 WP 文章为 MigrationItem
 * 纯数据转换，不涉及数据库操作
 */
export function processPosts(
  posts: WpPost[],
  categories: WpCategory[],
  tags: WpTag[],
  existingSlugs: Set<string>,
): MigrationResult {
  const items: MigrationItem[] = []
  let skippedDuplicates = 0

  for (const post of posts) {
    // 生成 slug（解码 URL 编码的中文 slug）
    const decodedSlug = decodeURIComponent(post.slug).toLowerCase()
    const cleanSlug = decodedSlug.replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')

    // 检查 slug 重复
    if (existingSlugs.has(cleanSlug)) {
      skippedDuplicates++
      continue
    }
    existingSlugs.add(cleanSlug)

    // 解析正文
    const parsedContent = parseWpContent(post.content.rendered)

    // 映射分类
    const categoryResult = mapWpCategories(categories, post.categories)
    const tagResult = mapWpTags(tags, post.tags)

    const allTags = [...categoryResult.tags, ...tagResult.tags]
    const allFlags = [...categoryResult.reviewFlags, ...tagResult.reviewFlags]

    // 正文内容风险检查
    const contentFlags = checkContentRisk(post.title.rendered, parsedContent.textContent)
    allFlags.push(...contentFlags)

    // 清洗标题（去掉 emoji 和多余空格）
    const cleanTitle = post.title.rendered
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    items.push({
      wpPost: post,
      parsedContent,
      mappedTags: allTags,
      reviewFlags: allFlags,
      galleryData: {
        id: generateId('gal'),
        title: cleanTitle,
        slug: cleanSlug,
        summary: parsedContent.textContent.slice(0, 200),
        bodyMd: parsedContent.markdown,
        legacyUrl: post.link,
        legacySlug: post.slug,
        status: 'draft',
        requiredLevelRank: 0, // 默认免费，后续人工设置
      },
    })
  }

  return { totalProcessed: posts.length, items, skippedDuplicates }
}

/**
 * 正文内容风险检查
 */
function checkContentRisk(title: string, text: string): string[] {
  const flags: string[] = []
  const combined = `${title} ${text}`.toLowerCase()

  const riskKeywords = ['联系方式', '微信', 'wechat', '约', '上门', '服务']
  for (const keyword of riskKeywords) {
    if (combined.includes(keyword)) {
      flags.push(`正文包含风险关键词: "${keyword}"`)
    }
  }

  return flags
}

/**
 * 将 MigrationItem 写入数据库
 * 包括：galleries、tags、gallery_tags、media_assets、legacy_import_items、legacy_url_redirects
 */
export async function writeMigrationItem(
  db: D1Database,
  item: MigrationItem,
  sourceId: string,
  jobId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const g = item.galleryData

    // 插入 gallery
    await db
      .prepare(`
        INSERT INTO galleries (id, title, slug, summary, body_md, status, required_level_rank, legacy_url, legacy_slug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(g.id, g.title, g.slug, g.summary, g.bodyMd, g.status, g.requiredLevelRank, g.legacyUrl, g.legacySlug)
      .run()

    // 插入标签（自动创建不存在的标签）
    for (const tag of item.mappedTags) {
      let tagRow = await db
        .prepare('SELECT id FROM tags WHERE slug = ?')
        .bind(tag.slug)
        .first<{ id: string }>()

      if (!tagRow) {
        const tagId = generateId('tag')
        await db
          .prepare('INSERT INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)')
          .bind(tagId, tag.type, tag.name, tag.slug)
          .run()
        tagRow = { id: tagId }
      }

      await db
        .prepare('INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)')
        .bind(g.id, tagRow.id)
        .run()
    }

    // 插入媒体资产记录（暂不下载，仅记录 URL）
    for (let i = 0; i < item.parsedContent.media.length; i++) {
      const m = item.parsedContent.media[i]!
      const assetId = generateId('med')
      const role = m.type === 'image' ? 'gallery_image' : 'preview_video'

      await db
        .prepare(`
          INSERT INTO media_assets (id, gallery_id, type, role, r2_key, sort_order, upload_status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `)
        .bind(assetId, g.id, m.type, role, m.url, i + 1)
        .run()
    }

    // 插入 legacy_import_items
    const itemId = generateId('lii')
    const reviewStatus = item.reviewFlags.length > 0 ? 'pending' : 'pending'

    await db
      .prepare(`
        INSERT INTO legacy_import_items (id, source_id, job_id, legacy_post_id, legacy_url, legacy_title, gallery_id, status, review_status, review_flags)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?)
      `)
      .bind(
        itemId, sourceId, jobId,
        item.wpPost.id, item.wpPost.link, item.galleryData.title,
        g.id, reviewStatus,
        item.reviewFlags.length > 0 ? JSON.stringify(item.reviewFlags) : null,
      )
      .run()

    // 插入 URL 重定向
    const oldPath = new URL(item.wpPost.link).pathname.replace(/\/$/, '')
    if (oldPath) {
      await db
        .prepare('INSERT OR IGNORE INTO legacy_url_redirects (old_path, new_path) VALUES (?, ?)')
        .bind(oldPath, `/gallery/${g.slug}`)
        .run()
    }

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '未知错误'
    return { success: false, error: message }
  }
}
