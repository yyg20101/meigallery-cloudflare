import type {
  AnalyticsEntityType,
  AnalyticsEventName,
  AnalyticsPropValue,
  AnalyticsSourceChannel,
} from '@meigallery/shared'

export const ANALYTICS_EVENT_NAMES = [
  'session_start',
  'session_end',
  'page_view',
  'page_leave',
  'engagement_ping',
  'scroll_depth',
  'source_detected',
  'home_ad_impression',
  'home_ad_click',
  'outbound_link_click',
  'invite_landed',
  'invite_code_checked',
  'register_start',
  'register_submit',
  'register_failed',
  'membership_granted_conversion',
  'gallery_card_impression',
  'gallery_card_click',
  'gallery_detail_view',
  'media_thumbnail_impression',
  'media_viewer_open',
  'media_access_request',
  'media_access_granted',
  'media_access_denied',
  'gallery_like_add',
  'gallery_like_remove',
  'search_submit',
  'search_results_view',
  'search_no_results',
  'filter_selected',
  'filter_removed',
  'sort_changed',
  'load_more',
  'contact_panel_open',
  'contact_value_copy',
  'contact_qr_expand',
  'rules_panel_open',
  'rules_page_click',
  'membership_cta_click',
  'login_start',
  'login_submit',
  'login_success',
  'login_failed',
  'logout_success',
] as const satisfies readonly AnalyticsEventName[]

export const ANALYTICS_ENTITY_TYPES = [
  'gallery',
  'tag',
  'ad',
  'contact',
  'invite',
  'auth',
  'media',
  'case',
  'page',
  'system',
] as const satisfies readonly AnalyticsEntityType[]

export const ANALYTICS_SOURCE_CHANNELS = [
  'direct',
  'search',
  'social',
  'referral',
  'invite',
  'ad',
  'internal',
  'unknown',
] as const satisfies readonly AnalyticsSourceChannel[]

const EVENT_NAME_SET = new Set<string>(ANALYTICS_EVENT_NAMES)
const ENTITY_TYPE_SET = new Set<string>(ANALYTICS_ENTITY_TYPES)
const SOURCE_CHANNEL_SET = new Set<string>(ANALYTICS_SOURCE_CHANNELS)

const GLOBAL_PROP_KEYS = [
  'source_channel',
  'source_name',
  'tracking_source_id',
  'tracking_source_slug',
  'utm_campaign',
  'utm_medium',
  'utm_source',
  'viewport_bucket',
] as const

const ANALYTICS_PROP_KEYS = [
  'active_seconds',
  'active_seconds_delta',
  'ad_id',
  'action_type',
  'asset_id',
  'channel',
  'contact_method_id',
  'creative_type',
  'days_to_grant',
  'depth_percent',
  'duplicate_clicks',
  'effective_clicks',
  'email_verification_enabled',
  'element_id',
  'element_type',
  'entry_path',
  'failure_code',
  'failure_reason',
  'gallery_id',
  'has_query',
  'identifier_type',
  'index',
  'invite_code',
  'invite_code_id',
  'invite_valid',
  'is_bounce',
  'is_landing',
  'link_type',
  'list_type',
  'location',
  'max_scroll_depth',
  'method_type',
  'new_sort',
  'old_sort',
  'page',
  'page_view_count',
  'position',
  'query_length',
  'rank',
  'raw_clicks',
  'reason',
  'redirect_path_type',
  'redirect_type',
  'required_rank',
  'result_count',
  'sort',
  'tag_count',
  'tag_slug',
  'tag_slugs',
  'tag_type',
  'target_host',
  'target_path_or_host',
  'target_type',
  'target_id',
] as const

const EVENT_PROP_KEYS: Partial<Record<AnalyticsEventName, readonly string[]>> = {
  page_view: ['is_landing', 'entry_path'],
  page_leave: ['active_seconds', 'max_scroll_depth', 'is_bounce'],
  session_start: ['source_channel', 'source_name', 'invite_code_id'],
  session_end: ['active_seconds', 'page_view_count'],
  home_ad_impression: ['ad_id', 'position', 'creative_type'],
  home_ad_click: ['ad_id', 'target_type', 'target_path_or_host'],
  outbound_link_click: ['target_host', 'location', 'link_type'],
  invite_landed: ['invite_code', 'invite_code_id'],
  invite_code_checked: ['invite_code_id', 'invite_valid', 'failure_reason'],
  register_submit: ['invite_code_id', 'email_verification_enabled'],
  register_failed: ['failure_code', 'invite_code_id'],
  membership_granted_conversion: ['invite_code_id', 'rank', 'days_to_grant'],
  gallery_card_impression: ['gallery_id', 'list_type', 'position'],
  gallery_card_click: ['gallery_id', 'list_type', 'position'],
  gallery_detail_view: ['gallery_id', 'required_rank', 'tag_slugs'],
  media_thumbnail_impression: ['gallery_id', 'asset_id', 'required_rank'],
  media_viewer_open: ['gallery_id', 'asset_id', 'index'],
  media_access_request: ['gallery_id', 'asset_id', 'required_rank'],
  media_access_granted: ['gallery_id', 'asset_id', 'required_rank'],
  media_access_denied: ['gallery_id', 'asset_id', 'required_rank', 'reason'],
  gallery_like_add: ['gallery_id'],
  gallery_like_remove: ['gallery_id'],
  search_submit: ['has_query', 'query_length', 'tag_count', 'sort'],
  search_results_view: ['result_count', 'page', 'sort'],
  search_no_results: ['query_length', 'tag_count'],
  filter_selected: ['tag_slug', 'tag_type', 'location'],
  filter_removed: ['tag_slug', 'tag_type', 'location'],
  sort_changed: ['old_sort', 'new_sort', 'location'],
  load_more: ['page', 'result_count'],
  contact_panel_open: ['location'],
  contact_value_copy: ['contact_method_id', 'method_type', 'action_type', 'location'],
  contact_qr_expand: ['contact_method_id', 'method_type', 'action_type', 'location'],
  rules_panel_open: ['location'],
  rules_page_click: ['location'],
  membership_cta_click: ['location', 'required_rank'],
  login_start: ['redirect_type'],
  login_submit: ['identifier_type', 'redirect_type'],
  login_success: ['redirect_path_type'],
  login_failed: ['failure_code'],
  logout_success: [],
}

const KNOWN_PROP_SET = new Set<string>([...GLOBAL_PROP_KEYS, ...ANALYTICS_PROP_KEYS])

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value)
}

export function isAnalyticsEntityType(value: unknown): value is AnalyticsEntityType {
  return typeof value === 'string' && ENTITY_TYPE_SET.has(value)
}

export function isAnalyticsSourceChannel(value: unknown): value is AnalyticsSourceChannel {
  return typeof value === 'string' && SOURCE_CHANNEL_SET.has(value)
}

export function getAllowedAnalyticsPropKeys(eventName: AnalyticsEventName) {
  return new Set([...(EVENT_PROP_KEYS[eventName] ?? []), ...GLOBAL_PROP_KEYS])
}

export function sanitizeAnalyticsProps(
  eventName: AnalyticsEventName,
  props: unknown,
): Record<string, AnalyticsPropValue> {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}

  const allowed = getAllowedAnalyticsPropKeys(eventName)
  const sanitized: Record<string, AnalyticsPropValue> = {}
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (!allowed.has(key) || !KNOWN_PROP_SET.has(key)) continue
    const normalized = normalizeAnalyticsPropValue(value)
    if (normalized !== undefined) sanitized[key] = normalized
  }
  return sanitized
}

export function normalizeAnalyticsPropValue(value: unknown): AnalyticsPropValue | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return truncateAnalyticsString(value, 160)
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 20)
      .map(item => truncateAnalyticsString(item, 80))
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  return undefined
}

export function truncateAnalyticsString(value: string, maxLength: number) {
  const trimmed = value.trim()
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}
