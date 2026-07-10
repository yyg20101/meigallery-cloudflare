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

/** 受保护媒体访问响应/凭证 TTL（秒） */
export const MEDIA_ACCESS_TTL = {
  PROTECTED_IMAGE_CACHE: 600, // Worker 代理图片响应私有缓存 10 分钟
  STREAM_TOKEN: 14400,        // Stream signed token 4 小时
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
  MEDIA_ACCESS: { requests: 30, window: 60 }, // 30 次/分钟/user
  EXTERNAL_IMPORT: { requests: 120, window: 60 }, // 120 次/分钟/IP
  ANALYTICS_IP: { requests: 120, window: 60 }, // 120 次/分钟/IP
  ANALYTICS_VISITOR: { requests: 120, window: 60 }, // 120 次/分钟/visitor
  ANALYTICS_SESSION: { requests: 60, window: 60 }, // 60 次/分钟/session
} as const

/** 数据分析采集限制 */
export const ANALYTICS_LIMITS = {
  BATCH_EVENT_LIMIT: 20,
  BATCH_BODY_LIMIT_BYTES: 16 * 1024,
  QUEUE_MAX_EVENTS: 50,
  FLUSH_INTERVAL_SECONDS: 10,
  HEARTBEAT_SECONDS: 15,
  PAGE_ACTIVE_SECONDS_CAP: 30 * 60,
  CUSTOM_RANGE_MAX_DAYS: 90,
} as const

/** 数据分析采样与保留期 */
export const ANALYTICS_RETENTION = {
  DEFAULT_SAMPLE_RATE: 0.01,
  MAX_SAMPLE_RATE: 0.05,
  SAMPLED_RAW_DAYS: 30,
  SUMMARY_DAYS: 90,
  AGGREGATE_DAYS: 395,
  EXPORT_EXPIRES_DAYS: 7,
  VISITOR_TTL_DAYS: 180,
  SESSION_IDLE_MINUTES: 30,
} as const

/** 数据分析 D1 成本预算 */
export const ANALYTICS_D1_BUDGET = {
  DEV_DAILY_ROWS_WRITTEN: 40_000,
  DEV_DAILY_ROWS_READ: 80_000,
  PRODUCTION_DAILY_ROWS_WRITTEN: 80_000,
  REPORT_30D_ROWS_READ: 10_000,
  REPORT_90D_ROWS_READ: 30_000,
  QUEUE_TRIGGER_WRITE_BUDGET_RATIO: 0.8,
  INGEST_P95_QUEUE_TRIGGER_MS: 300,
  ADMIN_REPORT_P95_TRIGGER_MS: 2000,
} as const

/** 数据分析默认设置值 */
export const ANALYTICS_DEFAULT_SETTINGS = {
  ENABLED: false,
  SAMPLE_RATE: ANALYTICS_RETENTION.DEFAULT_SAMPLE_RATE,
  CONSENT_MODE: 'limited',
} as const

export const CONVERSION_ACTIONS = ['contact', 'lead', 'complete_registration', 'start_trial', 'membership_grant'] as const

export const META_EVENT_BY_CONVERSION = {
  contact: 'Contact',
  lead: 'Lead',
  complete_registration: 'CompleteRegistration',
  start_trial: null,
  membership_grant: null,
} as const

export const ATTRIBUTION_LIMITS = {
  METADATA_MAX_KEYS: 24,
  METADATA_VALUE_MAX_LENGTH: 120,
  DELIVERY_ERROR_MAX_LENGTH: 500,
  CONVERSION_DETAIL_SAMPLE_LIMIT: 200,
} as const

export { CONTACT_PLATFORMS, CONTACT_PLATFORM_KEYS, canGenerateContactLink, generateContactLink } from './contact-platforms'
export type { ContactPlatformConfig } from './contact-platforms'
