/**
 * MeiGallery 共享常量
 */

/** 会员等级 rank 值（业务逻辑不硬编码等级名称，使用 rank 比较） */
export const MEMBERSHIP_RANKS = {
  FREE: 0,
  VIP: 10,
  SVIP: 20,
} as const

/** 用户角色优先级 */
export const ROLE_PRIORITY = {
  visitor: 0,
  user: 1,
  admin: 2,
  owner: 3,
} as const

/** 管理员角色列表 */
export const ADMIN_ROLES = ['admin', 'owner'] as const

/** 标签类型列表 */
export const TAG_TYPES = [
  'region_scope',
  'region_group',
  'city_country',
  'identity',
  'personality',
  'style',
  'occupation',
  'hair',
  'clothing',
  'scene',
  'content_type',
] as const

/** R2 对象 key 前缀 */
export const R2_KEY_PREFIX = {
  ORIGINALS: 'originals',
  THUMBNAILS: 'thumbnails',
  COVERS: 'covers',
  IMPORTS: 'imports',
} as const

/** 签名 URL 有效期（秒） */
export const SIGNED_URL_TTL = {
  IMAGE: 600,      // 10 分钟
  VIDEO: 14400,    // 4 小时
} as const

/** 分页默认值 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const

/** 速率限制 */
export const RATE_LIMITS = {
  AUTH: { requests: 5, window: 60 },         // 5 次/分钟/IP
  PUBLIC_API: { requests: 60, window: 60 },  // 60 次/分钟/IP
  ADMIN_API: { requests: 120, window: 60 },  // 120 次/分钟/session
  MEDIA_SIGN: { requests: 30, window: 60 },  // 30 次/分钟/user
} as const

export { CONTACT_PLATFORMS, CONTACT_PLATFORM_KEYS, generateContactLink } from './contact-platforms'
export type { ContactPlatformConfig } from './contact-platforms'
