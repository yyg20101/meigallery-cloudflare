/**
 * MeiGallery 共享类型定义
 * 前端和后端共用的接口契约
 */

// ============================================================
// Cloudflare 环境类型
// ============================================================

/** Cloudflare Worker 环境绑定 */
export interface CloudflareEnv {
  /** D1 数据库 */
  DB: D1Database
  /** R2 存储桶 */
  R2: R2Bucket
}

// ============================================================
// 基础枚举类型
// ============================================================

/** 用户角色 */
export type UserRole = 'visitor' | 'user' | 'admin' | 'owner'

/** 用户状态 */
export type UserStatus = 'active' | 'disabled'

/** 图库状态 */
export type GalleryStatus = 'draft' | 'published' | 'unpublished' | 'archived'

/** 媒体类型 */
export type MediaType = 'image' | 'video'

/** 媒体存储方式 */
export type MediaStorage = 'r2' | 'stream'

/** 媒体角色 */
export type MediaRole = 'cover' | 'content' | 'preview' | 'full'

/** 导入任务状态 */
export type ImportJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

/** 标签类型 */
export type TagType =
  | 'region_scope'
  | 'region_group'
  | 'city_country'
  | 'identity'
  | 'personality'
  | 'style'
  | 'occupation'
  | 'hair'
  | 'clothing'
  | 'scene'
  | 'content_type'

// ============================================================
// API 响应类型（前后端共用）
// ============================================================

/** 用户信息（客户端可见） */
export interface UserInfo {
  id: string
  email: string
  nickname: string | null
  role: UserRole
  status: UserStatus
  membershipRank: number
  membershipExpiry: string | null
}

/** 图库摘要（列表页） */
export interface GallerySummary {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  publishedAt: string | null
  tags: TagInfo[]
}

/** 图库详情 */
export interface GalleryDetail extends GallerySummary {
  bodyMd: string | null
  status: GalleryStatus
  mediaAssets: MediaAssetInfo[]
  createdAt: string
  updatedAt: string
}

/** 媒体资源信息 */
export interface MediaAssetInfo {
  id: string
  type: MediaType
  role: MediaRole
  sortOrder: number
  requiredRank: number
  thumbnailUrl?: string
}

/** 标签信息 */
export interface TagInfo {
  id: string
  type: TagType
  name: string
  slug: string
}

/** API 分页响应 */
export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

/** API 错误响应 */
export interface ApiError {
  statusCode: number
  message: string
  detail?: string
}
