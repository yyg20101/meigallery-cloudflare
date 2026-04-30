/**
 * WordPress 分类→新站标签映射工具
 */

import type { WpCategory, WpTag } from './wp-fetcher'

export interface MappedTag {
  type: string       // TAG_TYPES 中的类型
  name: string       // 清洗后的名称
  slug: string       // 生成的 slug
  wpId: number       // 原始 WP ID
  wpSource: 'category' | 'tag'
}

export interface MappingResult {
  tags: MappedTag[]
  reviewFlags: string[]  // 需要人工审核的原因
}

/**
 * 需要审核的旧站标签关键词（与新站定位不符）
 */
const REVIEW_KEYWORDS = [
  'sm', '猎奇', '包养', '伴游', '萝莉', '联系方式',
]

/**
 * 顶层分类 → region_scope 映射
 */
const REGION_SCOPE_MAP: Record<number, string> = {
  1: '国内精选',
  2: '海外精选',
  73: '港澳台',
}

/**
 * 区域组 → region_group 映射
 */
const REGION_GROUP_MAP: Record<number, string> = {
  68: '华东地区',
  69: '华西地区',
  70: '华南地区',
  71: '华北地区',
}

/**
 * 映射 WordPress 分类到新站标签
 */
export function mapWpCategories(categories: WpCategory[], postCategoryIds: number[]): MappingResult {
  const tags: MappedTag[] = []
  const reviewFlags: string[] = []

  for (const catId of postCategoryIds) {
    const cat = categories.find(c => c.id === catId)
    if (!cat) continue

    // 顶层范围
    if (REGION_SCOPE_MAP[catId]) {
      tags.push({
        type: 'region_scope',
        name: REGION_SCOPE_MAP[catId]!,
        slug: generateSlug(REGION_SCOPE_MAP[catId]!),
        wpId: catId,
        wpSource: 'category',
      })
      continue
    }

    // 区域组
    if (REGION_GROUP_MAP[catId]) {
      tags.push({
        type: 'region_group',
        name: REGION_GROUP_MAP[catId]!,
        slug: generateSlug(REGION_GROUP_MAP[catId]!),
        wpId: catId,
        wpSource: 'category',
      })
      continue
    }

    // 其他分类 → city_country（去掉"外围"后缀）
    const cityName = cat.name.replace(/外围$/, '').trim()
    if (cityName) {
      tags.push({
        type: 'city_country',
        name: cityName,
        slug: generateSlug(cityName),
        wpId: catId,
        wpSource: 'category',
      })
    }
  }

  return { tags, reviewFlags }
}

/**
 * 映射 WordPress 标签到新站标签
 */
export function mapWpTags(wpTags: WpTag[], postTagIds: number[]): MappingResult {
  const tags: MappedTag[] = []
  const reviewFlags: string[] = []

  for (const tagId of postTagIds) {
    const wpTag = wpTags.find(t => t.id === tagId)
    if (!wpTag) continue

    // 检查是否包含需要审核的关键词
    const needsReview = REVIEW_KEYWORDS.some(kw =>
      wpTag.name.toLowerCase().includes(kw.toLowerCase())
    )
    if (needsReview) {
      reviewFlags.push(`标签"${wpTag.name}"与新站定位不符，需审核`)
    }

    // 映射标签类型
    const tagType = inferTagType(wpTag.name)
    tags.push({
      type: tagType,
      name: wpTag.name,
      slug: generateSlug(wpTag.name),
      wpId: tagId,
      wpSource: 'tag',
    })
  }

  return { tags, reviewFlags }
}

/**
 * 推断标签类型
 */
function inferTagType(name: string): string {
  const lower = name.toLowerCase()

  // 身份类
  if (['留学生', '模特', '网红'].some(k => lower.includes(k))) return 'identity'
  // 风格类
  if (['制服', '反差'].some(k => lower.includes(k))) return 'style'

  // 默认归入 personality
  return 'personality'
}

/**
 * 生成 URL-safe slug
 */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\/]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}
