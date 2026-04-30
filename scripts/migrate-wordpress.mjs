#!/usr/bin/env node
/**
 * WordPress → MeiGallery 本地迁移脚本（HTTP API 版本）
 * 使用 Cloudflare D1 HTTP API 直接批量插入，速度远超 wrangler CLI
 * 
 * 用法: node scripts/migrate-wordpress.mjs
 */

const WP_BASE = 'https://zuole.me'
const ACCOUNT_ID = '32b73e607476d0224c7ca40d28be1120'
const DB_ID = '714929cb-003b-4cb1-bd9f-545fa1895e8c'

// 从 wrangler config 读取 token
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Token 在 d1Query 中每次调用时读取（支持 wrangler 自动刷新）

// ===== 敏感标签替换映射 =====
const SENSITIVE_TAG_REPLACEMENT = {
  'sm': null,
  'sm/猎奇': null,
  '包养': '长期合作',
  '伴游': '旅拍',
  '包养 伴游': '旅拍',
  '萝莉': '甜美',
  '联系方式': null,
}

// ===== 工具函数 =====
function generateId(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}_${id}`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getToken() {
  try {
    const config = readFileSync(join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), 'utf-8')
    return config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1]
  } catch { return null }
}

async function d1Query(sql, params = [], retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = getToken() // 每次重新读取（wrangler 可能已刷新）
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      }
    )

    if (resp.status === 429 || resp.status === 403) {
      if (attempt < retries) {
        const wait = Math.pow(2, attempt + 1) * 1000 // 2s, 4s, 8s
        process.stdout.write(`\n  ⏳ 限速，等待 ${wait/1000}s...`)
        await sleep(wait)
        continue
      }
    }

    const data = await resp.json()
    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || JSON.stringify(data.errors)
      // 如果是授权问题，等待后重试（token 可能需要刷新）
      if (errMsg.includes('not valid or is not authorized') && attempt < retries) {
        const wait = Math.pow(2, attempt + 1) * 2000
        process.stdout.write(`\n  🔑 Token 问题，等待 ${wait/1000}s 后重试...`)
        await sleep(wait)
        continue
      }
      throw new Error(errMsg)
    }
    return data.result
  }
}

// d1Query 已内置批量支持（分号分隔多条语句）

// ===== WP API 获取 =====
async function fetchWpPosts() {
  console.log('📥 获取 WordPress 文章...')
  const posts = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const url = `${WP_BASE}/wp-json/wp/v2/posts?per_page=50&page=${page}&_fields=id,date,slug,link,title,content,categories,tags`
    const resp = await fetch(url)
    if (!resp.ok) break

    totalPages = parseInt(resp.headers.get('X-WP-TotalPages') || '1')
    const data = await resp.json()
    posts.push(...data)
    process.stdout.write(`\r  第 ${page}/${totalPages} 页，已获取 ${posts.length} 篇`)
    page++
    await sleep(300)
  }
  console.log('')
  return posts
}

async function fetchWpCategories() {
  const url = `${WP_BASE}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug,parent,count`
  const resp = await fetch(url)
  return resp.json()
}

async function fetchWpTags() {
  const url = `${WP_BASE}/wp-json/wp/v2/tags?per_page=100&_fields=id,name,slug,count`
  const resp = await fetch(url)
  return resp.json()
}

// ===== 内容解析 =====
function parseContent(html) {
  const media = []
  const seen = new Set()

  // 提取图片
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*\/?>/gi
  let match
  while ((match = imgRegex.exec(html)) !== null) {
    let url = match[1]
    url = url.replace(/-\d+x\d+(\.\w+)$/, '$1')
    if (url.includes('/wp-content/uploads/') && !seen.has(url)) {
      seen.add(url)
      media.push({ type: 'image', url })
    }
  }

  // 提取视频
  const videoRegex = /src="([^"]+\.mp4[^"]*)"/gi
  while ((match = videoRegex.exec(html)) !== null) {
    const url = match[1]
    if (!seen.has(url)) {
      seen.add(url)
      media.push({ type: 'video', url })
    }
  }

  // 文本内容
  const text = html
    .replace(/<figure[^>]*>.*?<\/figure>/gis, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

  return { media, text }
}

// ===== 标签映射 =====
const REGION_SCOPE_MAP = { 1: '国内精选', 2: '海外精选', 73: '港澳台' }
const REGION_GROUP_MAP = { 68: '华东地区', 69: '华西地区', 70: '华南地区', 71: '华北地区' }

function mapCategories(categories, postCatIds) {
  const tags = []
  for (const catId of postCatIds) {
    const cat = categories.find(c => c.id === catId)
    if (!cat) continue
    if (REGION_SCOPE_MAP[catId]) {
      tags.push({ type: 'region_scope', name: REGION_SCOPE_MAP[catId] })
    } else if (REGION_GROUP_MAP[catId]) {
      tags.push({ type: 'region_group', name: REGION_GROUP_MAP[catId] })
    } else {
      const name = cat.name.replace(/外围$/, '').trim()
      if (name && name !== '微信') {
        tags.push({ type: 'city_country', name })
      }
    }
  }
  return tags
}

function mapPostTags(wpTags, postTagIds) {
  const tags = []
  for (const tagId of postTagIds) {
    const wpTag = wpTags.find(t => t.id === tagId)
    if (!wpTag) continue
    const replacement = SENSITIVE_TAG_REPLACEMENT[wpTag.name]
    if (replacement === null) continue
    const name = replacement || wpTag.name
    if (name === '制服-反差') {
      tags.push({ type: 'style', name: '制服' })
      tags.push({ type: 'style', name: '反差' })
      continue
    }
    let type = 'personality'
    if (['留学生', '模特', '网红'].some(k => name.includes(k))) type = 'identity'
    if (['制服', '反差'].some(k => name.includes(k))) type = 'style'
    if (['长期合作', '旅拍'].includes(name)) type = 'scenario'
    tags.push({ type, name })
  }
  return tags
}

function generateSlug(text) {
  return text.toLowerCase()
    .replace(/[\s\/]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

// ===== 主流程 =====
async function main() {
  console.log('🚀 开始 WordPress → MeiGallery 迁移')
  console.log('='.repeat(60))

  // 1. 获取 WP 数据
  const [posts, categories, wpTags] = await Promise.all([
    fetchWpPosts(),
    fetchWpCategories(),
    fetchWpTags(),
  ])
  console.log(`\n📊 数据: ${posts.length} 篇文章, ${categories.length} 分类, ${wpTags.length} 标签`)

  // 2. 收集所有唯一标签 - 先查询已有标签
  console.log('\n🏷️  处理标签...')
  const tagMap = new Map() // name → { id, type, slug }

  // 查询 D1 中已有标签
  const existingTagsResult = await d1Query("SELECT id, name, type, slug FROM tags")
  const existingTags = existingTagsResult[0]?.results || []
  for (const t of existingTags) {
    tagMap.set(t.name, { id: t.id, type: t.type, name: t.name, slug: t.slug })
  }
  console.log(`  已有标签: ${tagMap.size} 个`)

  // 收集新标签
  const newTags = []
  for (const post of posts) {
    const allTags = [...mapCategories(categories, post.categories), ...mapPostTags(wpTags, post.tags)]
    for (const t of allTags) {
      if (!tagMap.has(t.name)) {
        const tag = { id: generateId('tag'), type: t.type, name: t.name, slug: generateSlug(t.name) }
        tagMap.set(t.name, tag)
        newTags.push(tag)
      }
    }
  }
  console.log(`  需新建标签: ${newTags.length} 个`)

  // 批量插入新标签（每批 20 个）
  for (let i = 0; i < newTags.length; i += 20) {
    const batch = newTags.slice(i, i + 20)
    const sql = batch.map(t =>
      `INSERT OR IGNORE INTO tags (id, type, name, slug) VALUES ('${t.id}', '${t.type}', '${t.name.replace(/'/g, "''")}', '${t.slug.replace(/'/g, "''")}')`
    ).join(';\n')
    try {
      await d1Query(sql)
    } catch (err) {
      console.error(`  ❌ 标签批次失败:`, err.message?.slice(0, 100))
    }
  }
  console.log(`  ✅ 标签完成 (总计: ${tagMap.size})`)

  // 3. 获取已有图库 slug（跳过已导入的）
  const existingSlugsResult = await d1Query("SELECT slug FROM galleries")
  const existingSlugs = new Set((existingSlugsResult[0]?.results || []).map(r => r.slug))
  console.log(`  已有图库: ${existingSlugs.size} 个（将跳过）`)

  // 4. 处理文章
  console.log('\n📸 创建图库...')
  const slugSet = new Set(existingSlugs) // 包含已有的 slug 防止重复
  let successCount = 0
  let failCount = 0
  let skipCount = 0
  let mediaTotal = 0
  const errors = []

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]

    // 清洗标题
    const title = post.title.rendered
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim()

    // 生成 slug
    let slug = generateSlug(decodeURIComponent(post.slug))
    if (!slug || slug.length < 2) slug = `gallery-${post.id}`
    if (slugSet.has(slug)) {
      // 已存在：跳过
      skipCount++
      if ((i + 1) % 50 === 0 || i === posts.length - 1) {
        console.log(`  进度: ${i + 1}/${posts.length} | 成功: ${successCount} | 跳过: ${skipCount} | 失败: ${failCount} | 媒体: ${mediaTotal}`)
      }
      continue
    }
    slugSet.add(slug)

    // 解析内容
    const { media, text } = parseContent(post.content.rendered)
    const summary = text.slice(0, 200).replace(/'/g, "''")

    // 映射标签
    const allTags = [...mapCategories(categories, post.categories), ...mapPostTags(wpTags, post.tags)]
    const galleryId = generateId('gal')

    // 构建批量 SQL
    const stmts = []

    // gallery
    stmts.push(
      `INSERT INTO galleries (id, title, slug, summary, status, required_level_rank, legacy_url, legacy_slug, created_at, updated_at) VALUES ('${galleryId}', '${title.replace(/'/g, "''")}', '${slug.replace(/'/g, "''")}', '${summary}', 'draft', 0, '${post.link.replace(/'/g, "''")}', '${post.slug.replace(/'/g, "''")}', '${post.date}', '${post.date}')`
    )

    // gallery_tags
    for (const t of allTags) {
      const tag = tagMap.get(t.name)
      if (tag) {
        stmts.push(`INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES ('${galleryId}', '${tag.id}')`)
      }
    }

    // media_assets (storage 列为 NOT NULL，图片用 'r2'，视频用 'stream')
    for (let idx = 0; idx < media.length; idx++) {
      const m = media[idx]
      const assetId = generateId('med')
      const role = m.type === 'image' ? 'gallery_image' : 'preview_video'
      const storage = m.type === 'image' ? 'r2' : 'stream'
      stmts.push(
        `INSERT INTO media_assets (id, gallery_id, type, storage, role, r2_key, sort_order, upload_status, required_rank) VALUES ('${assetId}', '${galleryId}', '${m.type}', '${storage}', '${role}', '${m.url.replace(/'/g, "''")}', ${idx + 1}, 'pending', 0)`
      )
    }

    // URL redirect
    try {
      const oldPath = new URL(post.link).pathname.replace(/\/$/, '')
      if (oldPath) {
        stmts.push(`INSERT OR IGNORE INTO legacy_url_redirects (old_path, new_path) VALUES ('${oldPath.replace(/'/g, "''")}', '/gallery/${slug.replace(/'/g, "''")}')`)
      }
    } catch {}

    // 执行
    try {
      await d1Query(stmts.join(';\n'))
      successCount++
      mediaTotal += media.length
    } catch (err) {
      failCount++
      errors.push({ title, error: err.message?.slice(0, 150) })
      // 仅前 3 条失败输出调试
      if (failCount <= 3) {
        console.error(`\n  ⚠️ "${title}": ${err.message?.slice(0, 120)}`)
      }
    }

    // 进度
    if ((i + 1) % 50 === 0 || i === posts.length - 1) {
      console.log(`  进度: ${i + 1}/${posts.length} | 成功: ${successCount} | 跳过: ${skipCount} | 失败: ${failCount} | 媒体: ${mediaTotal}`)
    }

    // 限速（D1 HTTP API rate limit）- 每 3 个请求暂停 200ms
    if ((i + 1) % 3 === 0) await sleep(200)
  }

  // 4. 摘要
  console.log('\n' + '='.repeat(60))
  console.log('✅ 迁移完成！')
  console.log(`   图库: ${successCount} 成功, ${skipCount} 跳过, ${failCount} 失败`)
  console.log(`   标签: ${tagMap.size} 个`)
  console.log(`   媒体: ${mediaTotal} 条记录 (待下载)`)
  console.log(`   状态: 所有图库为 draft，需审核后发布`)

  if (errors.length > 0) {
    console.log(`\n❌ 失败列表 (前 10 条):`)
    errors.slice(0, 10).forEach(e => console.log(`   - ${e.title}: ${e.error}`))
  }

  console.log('\n下一步: node scripts/migrate-media.mjs (下载媒体到 R2)')
}

main().catch(err => {
  console.error('❌ 迁移失败:', err)
  process.exit(1)
})
