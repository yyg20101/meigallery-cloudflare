/**
 * WordPress REST API 拉取工具
 * 支持分页遍历所有文章、分类和标签
 */

import { createSafeExternalUrl, safeExternalFetch } from '../utils/external-url'

export interface WpPost {
  id: number
  date: string
  slug: string
  link: string
  title: { rendered: string }
  content: { rendered: string }
  featured_media: number
  categories: number[]
  tags: number[]
}

export interface WpCategory {
  id: number
  name: string
  slug: string
  parent: number
  count: number
}

export interface WpTag {
  id: number
  name: string
  slug: string
  count: number
}

export interface WpFetcherOptions {
  baseUrl: string       // 如 https://zuole.me
  perPage?: number      // 每页数量，默认 50
  maxPages?: number     // 最大页数，防止无限循环
}

/**
 * 分页拉取所有文章
 */
export async function fetchAllPosts(options: WpFetcherOptions): Promise<{
  posts: WpPost[]
  totalPages: number
  totalPosts: number
}> {
  const perPage = options.perPage ?? 50
  const maxPages = options.maxPages ?? 100
  const allPosts: WpPost[] = []
  let page = 1
  let totalPages = 1
  let totalPosts = 0

  while (page <= totalPages && page <= maxPages) {
    const url = createSafeExternalUrl(options.baseUrl, `/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,date,slug,link,title,content,featured_media,categories,tags`)

    const response = await safeExternalFetch(url)
    if (!response.ok) {
      if (response.status === 400 && page > 1) break // 超出最后一页
      throw new Error(`WP API 请求失败: ${response.status} ${response.statusText}`)
    }

    totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1', 10)
    totalPosts = parseInt(response.headers.get('X-WP-Total') || '0', 10)

    const posts = await response.json() as WpPost[]
    allPosts.push(...posts)
    page++
  }

  return { posts: allPosts, totalPages, totalPosts }
}

/**
 * 拉取所有分类
 */
export async function fetchAllCategories(baseUrl: string): Promise<WpCategory[]> {
  const allCategories: WpCategory[] = []
  let page = 1
  let hasMore = true

  while (hasMore) {
    const url = createSafeExternalUrl(baseUrl, `/wp-json/wp/v2/categories?per_page=100&page=${page}&_fields=id,name,slug,parent,count`)
    const response = await safeExternalFetch(url)
    if (!response.ok) break

    const categories = await response.json() as WpCategory[]
    if (categories.length === 0) break

    allCategories.push(...categories)
    const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1', 10)
    hasMore = page < totalPages
    page++
  }

  return allCategories
}

/**
 * 拉取所有标签
 */
export async function fetchAllTags(baseUrl: string): Promise<WpTag[]> {
  const allTags: WpTag[] = []
  let page = 1
  let hasMore = true

  while (hasMore) {
    const url = createSafeExternalUrl(baseUrl, `/wp-json/wp/v2/tags?per_page=100&page=${page}&_fields=id,name,slug,count`)
    const response = await safeExternalFetch(url)
    if (!response.ok) break

    const tags = await response.json() as WpTag[]
    if (tags.length === 0) break

    allTags.push(...tags)
    const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1', 10)
    hasMore = page < totalPages
    page++
  }

  return allTags
}

/**
 * 拉取单篇文章
 */
export async function fetchPost(baseUrl: string, postId: number): Promise<WpPost | null> {
  const url = createSafeExternalUrl(baseUrl, `/wp-json/wp/v2/posts/${postId}?_fields=id,date,slug,link,title,content,featured_media,categories,tags`)
  const response = await safeExternalFetch(url)
  if (!response.ok) return null
  return await response.json() as WpPost
}
