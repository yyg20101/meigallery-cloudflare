/**
 * WordPress REST API 拉取工具
 * 支持分页遍历所有文章、分类和标签
 */

import { createSafeExternalUrl, safeExternalFetch } from '../utils/external-url'

const MAX_WP_RESPONSE_BYTES = 16 * 1024 * 1024
const WP_REQUEST_TIMEOUT_MS = 60_000

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
  onPage?: WpPageProgressCallback
}

export interface WpFetchProgress {
  resource: 'posts' | 'categories' | 'tags'
  page: number
  totalPages: number
  itemCount: number
}

export type WpPageProgressCallback = (progress: WpFetchProgress) => void | Promise<void>

/**
 * 分页拉取所有文章
 */
export async function fetchAllPosts(options: WpFetcherOptions): Promise<{
  posts: WpPost[]
  totalPages: number
  totalPosts: number
}> {
  const perPage = integerInRange(options.perPage ?? 50, 1, 100, 'perPage')
  const maxPages = integerInRange(options.maxPages ?? 100, 1, 1_000, 'maxPages')
  const allPosts: WpPost[] = []
  let page = 1
  let totalPages = 1
  let declaredTotalPages: number | null = null
  let declaredTotalPosts: number | null = null

  while (page <= totalPages && page <= maxPages) {
    const url = createSafeExternalUrl(options.baseUrl, `/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,date,slug,link,title,content,featured_media,categories,tags`)
    const pageResult = await withWpRequestTimeout('文章', async (signal) => {
      const response = await safeExternalFetch(url, { signal })
      if (!response.ok) {
        throw new Error(`WP API 请求失败: ${response.status} ${response.statusText}`)
      }

      let responseTotalPages = nonNegativeHeader(response, 'X-WP-TotalPages', 1)
      if (responseTotalPages < 1) responseTotalPages = 1
      if (responseTotalPages > maxPages) {
        throw new Error(`WP API 页数 ${responseTotalPages} 超过安全上限 ${maxPages}`)
      }
      const posts = await readArrayJson(response, '文章', isWpPost)
      const currentTotalPosts = nonNegativeHeader(
        response,
        'X-WP-Total',
        allPosts.length + posts.length,
      )
      return { posts, totalPages: responseTotalPages, currentTotalPosts }
    })
    const { posts, currentTotalPosts } = pageResult
    if (declaredTotalPages !== null && pageResult.totalPages !== declaredTotalPages) {
      throw new Error('WP API 文章总页数在分页过程中发生变化，请重新执行')
    }
    declaredTotalPages = pageResult.totalPages
    totalPages = pageResult.totalPages
    if (declaredTotalPosts !== null && currentTotalPosts !== declaredTotalPosts) {
      throw new Error('WP API 文章总数在分页过程中发生变化，请重新执行')
    }
    declaredTotalPosts = currentTotalPosts
    allPosts.push(...posts)
    await options.onPage?.({
      resource: 'posts',
      page,
      totalPages,
      itemCount: allPosts.length,
    })
    page++
  }

  const totalPosts = declaredTotalPosts ?? 0
  if (allPosts.length !== totalPosts) {
    throw new Error(`WP API 文章读取不完整：期望 ${totalPosts}，实际 ${allPosts.length}`)
  }
  return { posts: allPosts, totalPages, totalPosts }
}

/**
 * 拉取所有分类
 */
export async function fetchAllCategories(
  baseUrl: string,
  onPage?: WpPageProgressCallback,
): Promise<WpCategory[]> {
  const allCategories: WpCategory[] = []
  let page = 1
  let hasMore = true
  const maxPages = 100
  let declaredTotalPages: number | null = null

  while (hasMore && page <= maxPages) {
    const url = createSafeExternalUrl(baseUrl, `/wp-json/wp/v2/categories?per_page=100&page=${page}&_fields=id,name,slug,parent,count`)
    const { categories, totalPages } = await withWpRequestTimeout('分类', async (signal) => {
      const response = await safeExternalFetch(url, { signal })
      if (!response.ok) {
        throw new Error(`WP 分类 API 请求失败: ${response.status} ${response.statusText}`)
      }
      const categories = await readArrayJson(response, '分类', isWpCategory)
      const totalPages = nonNegativeHeader(response, 'X-WP-TotalPages', 1)
      if (totalPages > maxPages) throw new Error(`WP 分类页数 ${totalPages} 超过安全上限 ${maxPages}`)
      if (categories.length > 0 && totalPages < 1) throw new Error('WP 分类分页响应不一致')
      return { categories, totalPages }
    })
    if (declaredTotalPages !== null && totalPages !== declaredTotalPages) {
      throw new Error('WP 分类总页数在分页过程中发生变化，请重新执行')
    }
    declaredTotalPages = totalPages
    if (categories.length === 0) {
      if (page === 1 && totalPages <= 1) {
        await onPage?.({ resource: 'categories', page, totalPages, itemCount: 0 })
        break
      }
      throw new Error(`WP 分类第 ${page} 页意外为空，拒绝部分导入`)
    }

    allCategories.push(...categories)
    await onPage?.({
      resource: 'categories',
      page,
      totalPages,
      itemCount: allCategories.length,
    })
    hasMore = page < totalPages
    page++
  }

  return allCategories
}

/**
 * 拉取所有标签
 */
export async function fetchAllTags(
  baseUrl: string,
  onPage?: WpPageProgressCallback,
): Promise<WpTag[]> {
  const allTags: WpTag[] = []
  let page = 1
  let hasMore = true
  const maxPages = 100
  let declaredTotalPages: number | null = null

  while (hasMore && page <= maxPages) {
    const url = createSafeExternalUrl(baseUrl, `/wp-json/wp/v2/tags?per_page=100&page=${page}&_fields=id,name,slug,count`)
    const { tags, totalPages } = await withWpRequestTimeout('标签', async (signal) => {
      const response = await safeExternalFetch(url, { signal })
      if (!response.ok) {
        throw new Error(`WP 标签 API 请求失败: ${response.status} ${response.statusText}`)
      }
      const tags = await readArrayJson(response, '标签', isWpTag)
      const totalPages = nonNegativeHeader(response, 'X-WP-TotalPages', 1)
      if (totalPages > maxPages) throw new Error(`WP 标签页数 ${totalPages} 超过安全上限 ${maxPages}`)
      if (tags.length > 0 && totalPages < 1) throw new Error('WP 标签分页响应不一致')
      return { tags, totalPages }
    })
    if (declaredTotalPages !== null && totalPages !== declaredTotalPages) {
      throw new Error('WP 标签总页数在分页过程中发生变化，请重新执行')
    }
    declaredTotalPages = totalPages
    if (tags.length === 0) {
      if (page === 1 && totalPages <= 1) {
        await onPage?.({ resource: 'tags', page, totalPages, itemCount: 0 })
        break
      }
      throw new Error(`WP 标签第 ${page} 页意外为空，拒绝部分导入`)
    }

    allTags.push(...tags)
    await onPage?.({
      resource: 'tags',
      page,
      totalPages,
      itemCount: allTags.length,
    })
    hasMore = page < totalPages
    page++
  }

  return allTags
}

/**
 * 拉取单篇文章
 */
export async function fetchPost(baseUrl: string, postId: number): Promise<WpPost | null> {
  if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error('WP 文章 ID 不正确')
  const url = createSafeExternalUrl(baseUrl, `/wp-json/wp/v2/posts/${postId}?_fields=id,date,slug,link,title,content,featured_media,categories,tags`)
  return withWpRequestTimeout('文章', async (signal) => {
    const response = await safeExternalFetch(url, { signal })
    if (!response.ok) return null
    const value = await readJson(response, '文章')
    if (!isWpPost(value)) throw new Error('WP 文章响应格式不正确')
    return value
  })
}

async function withWpRequestTimeout<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(WP_REQUEST_TIMEOUT_MS)
  try {
    return await operation(signal)
  } catch (error: unknown) {
    if (signal.aborted) {
      throw new Error(`WP ${label}请求超过 60 秒安全上限`, { cause: error })
    }
    throw error
  }
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min}-${max} 的整数`)
  }
  return value
}

function nonNegativeHeader(response: Response, name: string, fallback: number): number {
  const raw = response.headers.get(name)
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`WP API 响应头 ${name} 不正确`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`WP API 响应头 ${name} 不正确`)
  }
  return value
}

async function readArrayJson<T>(
  response: Response,
  label: string,
  predicate: (value: unknown) => value is T,
): Promise<T[]> {
  const value = await readJson(response, label)
  if (!Array.isArray(value) || value.some(item => !predicate(item))) {
    throw new Error(`WP ${label}响应格式不正确`)
  }
  return value
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_WP_RESPONSE_BYTES) {
    throw new Error(`WP ${label}响应超过 16 MiB 安全上限`)
  }
  const text = await readBoundedResponseText(response, label)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`WP ${label}响应不是有效 JSON`)
  }
}

async function readBoundedResponseText(response: Response, label: string): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let byteLength = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > MAX_WP_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // 保留原始大小错误；取消上游连接失败不改变安全结论。
        }
        throw new Error(`WP ${label}响应超过 16 MiB 安全上限`)
      }
      try {
        text += decoder.decode(chunk.value, { stream: true })
      } catch {
        throw new Error(`WP ${label}响应不是有效 UTF-8`)
      }
    }
    try {
      return text + decoder.decode()
    } catch {
      throw new Error(`WP ${label}响应不是有效 UTF-8`)
    }
  } finally {
    reader.releaseLock()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWpPost(value: unknown): value is WpPost {
  if (!isRecord(value) || !isRecord(value.title) || !isRecord(value.content)) return false
  return isPositiveInteger(value.id)
    && typeof value.date === 'string'
    && typeof value.slug === 'string'
    && typeof value.link === 'string'
    && typeof value.title.rendered === 'string'
    && typeof value.content.rendered === 'string'
    && typeof value.featured_media === 'number'
    && Number.isSafeInteger(value.featured_media)
    && isIntegerArray(value.categories)
    && isIntegerArray(value.tags)
}

function isWpCategory(value: unknown): value is WpCategory {
  return isRecord(value)
    && isPositiveInteger(value.id)
    && typeof value.name === 'string'
    && typeof value.slug === 'string'
    && typeof value.parent === 'number'
    && Number.isSafeInteger(value.parent)
    && typeof value.count === 'number'
    && Number.isSafeInteger(value.count)
}

function isWpTag(value: unknown): value is WpTag {
  return isRecord(value)
    && isPositiveInteger(value.id)
    && typeof value.name === 'string'
    && typeof value.slug === 'string'
    && typeof value.count === 'number'
    && Number.isSafeInteger(value.count)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length <= 1_000
    && value.every(item => typeof item === 'number' && Number.isSafeInteger(item) && item > 0)
}
