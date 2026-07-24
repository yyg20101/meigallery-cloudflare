/**
 * MeiGallery 共享类型定义
 * 前端和后端共用的接口契约
 */

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

/** 分析来源渠道 */
export type AnalyticsSourceChannel =
  | 'direct'
  | 'search'
  | 'social'
  | 'referral'
  | 'invite'
  | 'ad'
  | 'internal'
  | 'unknown'

/** 分析实体类型 */
export type AnalyticsEntityType =
  | 'gallery'
  | 'tag'
  | 'ad'
  | 'contact'
  | 'invite'
  | 'auth'
  | 'media'
  | 'case'
  | 'page'
  | 'system'

/** 分析授权/采集状态 */
export type AnalyticsConsentState = 'granted' | 'limited' | 'denied'

/** 营销衡量地区策略 */
export type MarketingConsentPolicyMode = 'notice_opt_out' | 'prior_consent' | 'disabled'

/** 营销衡量决策来源 */
export type MarketingConsentDecisionSource =
  | 'explicit'
  | 'regional_default'
  | 'choice_required'
  | 'gpc'
  | 'disabled'
  | 'request_limit'

import type {
  AdAttributionProvider as SharedAdAttributionProvider,
  CanonicalConversionEvent,
} from './ad-attribution'

export type {
  AdBrowserPublicConfig,
  AdAttributionProvider,
  AdBrowserInstruction,
  AdBrowserSignal,
  AdConsentSnapshot,
  CanonicalConversionEvent,
  PlatformEventDescriptor,
  PlatformPublicConfig,
} from './ad-attribution'

export * from './attribution-runtime'

export type ConversionActionType =
  | 'contact'
  | 'lead'
  | 'complete_registration'
  | 'start_trial'
  | 'membership_grant'

export type ActiveConversionActionType = Extract<
  ConversionActionType,
  'contact' | 'complete_registration'
>

export type AdPlatformProvider = SharedAdAttributionProvider

export type AdDeliveryTransport = 'browser' | 'server'

export type AdPlatformConversionEventName = CanonicalConversionEvent

export type AdPlatformTrackingMode = 'disabled' | 'test' | 'production'

export type AdPlatformRolloutPercentage = 0 | 10 | 50 | 100

export type PublicConversionActionType = Extract<ActiveConversionActionType, 'contact'>

export type ConversionDeliveryStatus = 'pending' | 'attempted' | 'sent' | 'failed' | 'skipped' | 'duplicate_suppressed'

/** 仅允许在内存或短期密文中持有的广告平台用户匹配上下文。 */
export interface AdPlatformSensitiveContext {
  fbp?: string
  fbc?: string
  ttclid?: string
  ttp?: string
  clientIpAddress?: string
  clientUserAgent?: string
  emailSha256?: string
  externalIdSha256?: string
}

export interface AdPlatformEncryptedEnvelope {
  keyId: string
  iv: string
  ciphertext: string
  tag: string
  expiresAt: string
}

/** Queue 只传递定位 Delivery 所需的最小信息，密文始终留在 D1 Outbox。 */
export interface AdPlatformQueueMessage {
  schemaVersion: 1
  deliveryId: string
  provider: SharedAdAttributionProvider
}

export type ConversionSkipReason =
  | 'disabled'
  | 'missing_secret'
  | 'missing_pixel_id'
  | 'missing_queue'
  | 'queue_send_failed'
  | 'unsupported_event'
  | 'consent_denied'
  | 'invalid_payload'
  | 'connection_unverified'
  | 'missing_data_key'
  | 'invalid_data_key'
  | 'invalid_sensitive_context'
  | 'rollout_excluded'
  | 'circuit_open'
  | 'missing_stable_id'
  | 'secure_context_expired'
  | 'secure_context_invalid'
  | 'queue_message_invalid'

/** 分析设备类型 */
export type AnalyticsDeviceType = 'desktop' | 'tablet' | 'mobile' | 'unknown'

/** 分析事件名称 */
export type AnalyticsEventName =
  | 'session_start'
  | 'session_end'
  | 'page_view'
  | 'page_leave'
  | 'engagement_ping'
  | 'scroll_depth'
  | 'source_detected'
  | 'home_ad_impression'
  | 'home_ad_click'
  | 'outbound_link_click'
  | 'invite_landed'
  | 'invite_code_checked'
  | 'register_start'
  | 'register_submit'
  | 'register_success'
  | 'register_failed'
  | 'membership_granted_conversion'
  | 'gallery_card_impression'
  | 'gallery_card_click'
  | 'gallery_detail_view'
  | 'media_thumbnail_impression'
  | 'media_viewer_open'
  | 'media_access_request'
  | 'media_access_granted'
  | 'media_access_denied'
  | 'gallery_like_add'
  | 'gallery_like_remove'
  | 'search_submit'
  | 'search_results_view'
  | 'search_no_results'
  | 'filter_selected'
  | 'filter_removed'
  | 'sort_changed'
  | 'load_more'
  | 'contact_panel_open'
  | 'contact_method_click'
  | 'contact_value_copy'
  | 'contact_qr_expand'
  | 'rules_panel_open'
  | 'rules_page_click'
  | 'membership_cta_click'
  | 'login_start'
  | 'login_submit'
  | 'login_success'
  | 'login_failed'
  | 'logout_success'

/** 邀请码状态 */
export type InviteCodeStatus = 'active' | 'disabled' | 'expired'

/** 邀请码公开校验失败原因 */
export type InviteCodeFailureReason = 'NOT_FOUND' | 'DISABLED' | 'EXPIRED' | 'USAGE_LIMIT_REACHED'

// ============================================================
// API 响应类型（前后端共用）
// ============================================================

/** 用户信息（客户端可见） */
export interface UserInfo {
  id: number
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
  viewCount?: number
  likeCount?: number
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

/** 分析事件属性值 */
export type AnalyticsPropValue = string | number | boolean | null | string[]

/** 前端批量上报的单个分析事件 */
export interface AnalyticsEventPayload {
  eventId: string
  eventName: AnalyticsEventName
  occurredAt: string
  routeName: string
  path: string
  pageTitle?: string
  referrer?: string
  referrerHost?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  trackingSourceSlug?: string
  sourceChannel?: AnalyticsSourceChannel
  deviceType?: AnalyticsDeviceType
  viewportWidth?: number
  consentState?: AnalyticsConsentState
  entityType?: AnalyticsEntityType
  entityId?: string
  props?: Record<string, AnalyticsPropValue>
  value?: number
}

/** 分析批量上报请求 */
export interface AnalyticsBatchRequest {
  visitorId: string
  sessionId: string
  events: AnalyticsEventPayload[]
}

/** 分析批量上报响应 */
export interface AnalyticsBatchResponse {
  accepted: number
  rejected: number
  duplicate: number
  disabled?: boolean
  errors?: Array<{
    eventId: string | null
    code: string
    message: string
  }>
}

/** 后台分析日期范围查询 */
export interface AnalyticsRangeQuery {
  from?: string
  to?: string
  range?: '7d' | '30d' | '90d'
  sourceChannel?: AnalyticsSourceChannel | 'all'
  inviteCodeId?: string
  deviceType?: AnalyticsDeviceType | 'all'
}

/** 邀请码公开状态响应 */
export type InviteCodeStatusResponse =
  | {
      valid: true
      inviteCodeId: string
      name: string
      channel: string
      expiresAt: string | null
    }
  | {
      valid: false
      reason: InviteCodeFailureReason
    }

export type { ContactMethod, ContactMethodAdmin } from './contact'
