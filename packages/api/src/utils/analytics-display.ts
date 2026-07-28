import type { AnalyticsSourceChannel } from '@meigallery/shared'

const SOURCE_CHANNEL_LABELS: Record<string, string> = {
  direct: '直接访问',
  search: '搜索',
  social: '社交媒体',
  referral: '合作/引用',
  invite: '邀请码',
  ad: '广告投放',
  internal: '站内入口',
  unknown: '未知来源',
}

const SOURCE_NAME_LABELS: Record<string, string> = {
  fb: 'Facebook UTM 来源',
  facebook: 'Facebook UTM 来源',
  meta: 'Meta UTM 来源',
  ig: 'Instagram UTM 来源',
  instagram: 'Instagram UTM 来源',
}

const EVENT_LABELS: Record<string, string> = {
  session_start: '开始访问',
  session_end: '结束访问',
  page_view: '页面访问',
  page_leave: '离开页面',
  engagement_ping: '停留心跳',
  scroll_depth: '滚动深度',
  source_detected: '识别来源',
  home_ad_impression: '首页广告曝光',
  home_ad_click: '首页广告点击',
  outbound_link_click: '外链点击',
  invite_landed: '邀请码落地',
  invite_code_checked: '邀请码校验',
  register_start: '开始注册',
  register_submit: '提交注册',
  register_failed: '注册失败',
  membership_granted_conversion: '会员发放转化',
  gallery_card_impression: '图库卡片曝光',
  gallery_card_click: '图库卡片点击',
  gallery_detail_view: '图库详情浏览',
  media_thumbnail_impression: '媒体缩略图曝光',
  media_viewer_open: '打开图片查看器',
  media_access_request: '媒体访问请求',
  media_access_granted: '媒体访问通过',
  media_access_denied: '媒体访问拒绝',
  gallery_like_add: '收藏图库',
  gallery_like_remove: '取消收藏',
  search_submit: '提交搜索',
  search_results_view: '查看搜索结果',
  search_no_results: '搜索无结果',
  filter_selected: '选择筛选',
  filter_removed: '移除筛选',
  sort_changed: '切换排序',
  load_more: '加载更多',
  contact_panel_open: '打开联系面板',
  contact_method_click: '点击联系方式',
  contact_qr_expand: '展开联系二维码',
  rules_panel_open: '打开规则面板',
  rules_page_click: '查看规则页',
  membership_cta_click: '点击会员引导',
  login_start: '开始登录',
  login_submit: '提交登录',
  login_success: '登录成功',
  login_failed: '登录失败',
  logout_success: '退出登录',
}

const ENTITY_LABELS: Record<string, string> = {
  gallery: '图库',
  tag: '标签',
  ad: '广告',
  contact: '联系方式',
  invite: '邀请码',
  auth: '登录注册',
  media: '媒体',
  case: '真实案例',
  page: '页面',
  system: '系统',
}

const ELEMENT_LABELS: Record<string, string> = {
  contact_method_click: '联系方式',
  contact_qr_expand: '联系方式二维码',
  floating_contact_panel: '悬浮联系面板',
  membership_cta: '会员引导按钮',
  membership_cta_click: '会员引导按钮',
  home_ad: '首页广告',
  home_ad_click: '首页广告',
  gallery_card: '图库卡片',
  gallery_card_click: '图库卡片',
  rules_page_click: '规则页入口',
  rules_panel_open: '规则面板',
  search_submit: '搜索按钮',
  filter_selected: '筛选项',
  filter_removed: '筛选项',
  sort_changed: '排序控件',
  load_more: '加载更多按钮',
  outbound_link_click: '外链按钮',
}

const LOCATION_LABELS: Record<string, string> = {
  home: '首页',
  '/': '首页',
  '/discover': '发现页',
  '/search': '搜索页',
  '/gallery/:slug': '图库详情页',
  gallery_detail: '图库详情页',
  floating_contact_panel: '悬浮联系面板',
  contact_panel: '联系面板',
  rules_panel: '规则面板',
  rules_page: '规则页',
  home_ad_band: '首页广告位',
}

export function analyticsSourceChannelLabel(value: unknown) {
  const key = String(value ?? '').trim()
  return SOURCE_CHANNEL_LABELS[key] || readableToken(key) || '未知来源'
}

export function analyticsEventLabel(value: unknown) {
  const key = String(value ?? '').trim()
  return EVENT_LABELS[key] || readableToken(key) || '未知事件'
}

export function analyticsEntityLabel(value: unknown) {
  const key = String(value ?? '').trim()
  return ENTITY_LABELS[key] || readableToken(key) || '未知目标'
}

export function analyticsRouteLabel(input: {
  routeName?: unknown
  path?: unknown
  pageTitle?: unknown
}) {
  const title = String(input.pageTitle ?? '').trim()
  if (title) return title
  const routeName = String(input.routeName ?? '').trim()
  const path = String(input.path ?? '').trim()
  return LOCATION_LABELS[routeName] || LOCATION_LABELS[path] || routeName || path || '未知页面'
}

export function analyticsClickElementLabel(input: {
  elementId?: unknown
  eventName?: unknown
}) {
  const elementId = String(input.elementId ?? '').trim()
  const eventName = String(input.eventName ?? '').trim()
  return ELEMENT_LABELS[elementId] || EVENT_LABELS[eventName] || readableToken(elementId) || '未知点击'
}

export function analyticsLocationLabel(value: unknown) {
  const key = String(value ?? '').trim()
  return LOCATION_LABELS[key] || readableToken(key) || '未知位置'
}

export function analyticsSourceLabel(row: Record<string, unknown>) {
  const explicit = String(row.source_label ?? row.tracking_source_label ?? '').trim()
  if (explicit) return explicit
  const sourceName = String(row.source_name ?? row.sourceCode ?? row.source_code ?? '').trim()
  const inviteCodeId = String(row.invite_code_id ?? '').trim()
  const channel = String(row.source_channel ?? '').trim() as AnalyticsSourceChannel | ''
  if (channel === 'invite' && inviteCodeId) return `邀请码 ${inviteCodeId}`
  if (sourceName) return readableSourceName(sourceName)
  return analyticsSourceChannelLabel(channel)
}

export function enrichAnalyticsDisplayRow<T extends Record<string, unknown>>(row: T): T & Record<string, unknown> {
  const sourceCode = String(row.source_name ?? row.sourceCode ?? row.source_code ?? '').trim()
  const eventName = String(row.event_name ?? row.eventName ?? '').trim()
  const elementId = String(row.element_id ?? '').trim()
  const elementType = String(row.element_type ?? '').trim()
  const targetType = String(row.target_type ?? row.entity_type ?? '').trim()
  const targetId = String(row.target_id ?? row.entity_id ?? '').trim()

  return {
    ...row,
    sourceCode,
    sourceLabel: analyticsSourceLabel(row),
    source_label: analyticsSourceLabel(row),
    source_channel_label: analyticsSourceChannelLabel(row.source_channel),
    event_label: eventName ? analyticsEventLabel(eventName) : undefined,
    route_label: analyticsRouteLabel({
      routeName: row.route_name,
      path: row.path,
      pageTitle: row.page_title,
    }),
    from_route_label: analyticsRouteLabel({ routeName: row.from_route, path: row.from_path }),
    to_route_label: analyticsRouteLabel({ routeName: row.to_route, path: row.to_path }),
    element_label: analyticsClickElementLabel({ elementId, eventName }),
    element_type_label: elementType ? analyticsEntityLabel(elementType) : undefined,
    location_label: analyticsLocationLabel(row.location),
    target_label: analyticsTargetLabel(targetType, targetId),
    entity_label: analyticsTargetLabel(targetType, targetId),
  }
}

function analyticsTargetLabel(targetType: string, targetId: string) {
  const typeLabel = analyticsEntityLabel(targetType)
  if (!targetId) return typeLabel
  const targetLabel = ELEMENT_LABELS[targetId] || LOCATION_LABELS[targetId] || readableToken(targetId)
  return targetLabel && targetLabel !== typeLabel ? `${typeLabel} ${targetLabel}` : typeLabel
}

function readableSourceName(value: string) {
  const text = value.trim()
  const key = text.toLowerCase()
  if (SOURCE_NAME_LABELS[key]) return SOURCE_NAME_LABELS[key]
  if (key === 'google.com' || key.endsWith('.google.com')) return 'Google'
  if (key === 'bing.com' || key.endsWith('.bing.com')) return 'Bing'
  if (key === 'baidu.com' || key.endsWith('.baidu.com')) return '百度'
  if (key === 'duckduckgo.com' || key.endsWith('.duckduckgo.com')) return 'DuckDuckGo'
  if (key === 'facebook.com' || key.endsWith('.facebook.com')) return 'Facebook referrer 来源'
  if (key === 'instagram.com' || key.endsWith('.instagram.com')) return 'Instagram referrer 来源'
  return readableToken(text)
}

function readableToken(value: string) {
  const text = value.trim()
  if (!text) return ''
  return text
    .replace(/^\/gallery\/:slug$/, '图库详情页')
    .replace(/^\/$/, '首页')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
