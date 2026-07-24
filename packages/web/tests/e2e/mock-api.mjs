import { createServer } from 'node:http'

const port = Number(process.env.PLAYWRIGHT_MOCK_API_PORT || 8787)
const host = process.env.PLAYWRIGHT_MOCK_API_HOST || '127.0.0.1'
const allowedOrigin = process.env.PLAYWRIGHT_ALLOWED_ORIGIN || 'http://127.0.0.1:3000'

const imageDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#111827"/>
      <stop offset="55%" stop-color="#bfa46a"/>
      <stop offset="100%" stop-color="#fff7ed"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <circle cx="910" cy="180" r="110" fill="#ffffff" opacity="0.18"/>
</svg>
`.trim())

const tags = [
  { id: 'tag-region', type: 'city_country', name: '广州', slug: 'guangzhou' },
  { id: 'tag-style', type: 'style', name: '清新', slug: 'fresh' },
  { id: 'tag-scene', type: 'scene', name: '户外', slug: 'outdoor' },
]

const galleries = [
  {
    id: 'gallery-1',
    title: '夏日授权写真',
    slug: 'summer-portrait',
    summary: '用于 Playwright smoke 的公开图库数据。',
    coverUrl: imageDataUrl,
    requiredLevelRank: 0,
    publishedAt: '2026-05-01T08:00:00Z',
    tags,
    viewCount: 128,
    likeCount: 12,
  },
  {
    id: 'gallery-2',
    title: '城市生活影像',
    slug: 'city-life',
    summary: '覆盖搜索、推荐和响应式布局的测试图库。',
    coverUrl: imageDataUrl,
    requiredLevelRank: 10,
    publishedAt: '2026-05-02T08:00:00Z',
    tags: [
      { id: 'tag-region-2', type: 'city_country', name: '上海', slug: 'shanghai' },
      { id: 'tag-content', type: 'content_type', name: '视频', slug: 'video' },
    ],
    viewCount: 98,
    likeCount: 8,
  },
  {
    id: 'gallery-3',
    title: '艺术生活记录',
    slug: 'art-life',
    summary: '用于相关推荐和网格布局的测试图库。',
    coverUrl: imageDataUrl,
    requiredLevelRank: 0,
    publishedAt: '2026-05-03T08:00:00Z',
    tags,
    viewCount: 76,
    likeCount: 5,
  },
  {
    id: 'gallery-4',
    title: '周末户外专题',
    slug: 'weekend-outdoor',
    summary: '补齐首页多模块渲染所需的测试图库。',
    coverUrl: imageDataUrl,
    requiredLevelRank: 0,
    publishedAt: '2026-05-04T08:00:00Z',
    tags,
    viewCount: 64,
    likeCount: 3,
  },
  {
    id: 'gallery-5',
    title: '中文直达图库',
    slug: '中文直达图库',
    summary: '验证广告和搜索引擎可直接打开编码后的中文图库链接。',
    coverUrl: imageDataUrl,
    requiredLevelRank: 0,
    publishedAt: '2026-05-05T08:00:00Z',
    tags,
    viewCount: 32,
    likeCount: 2,
  },
]

const cases = [
  {
    id: 'case-1',
    title: '会员咨询真实案例',
    slug: 'member-case',
    summary: '已脱敏的测试案例，用于首页真实案例轮播。',
    imageCount: 3,
    coverImageUrl: imageDataUrl,
    publishedAt: '2026-05-10T08:00:00Z',
  },
]

const user = {
  id: 1,
  email: 'admin@example.test',
  username: 'admin',
  nickname: '测试管理员',
  avatarKey: null,
  role: 'owner',
  status: 'active',
  notificationEnabled: true,
  createdAt: '2026-05-01T00:00:00Z',
  membershipRank: 20,
  membershipExpiry: '2027-05-01T00:00:00Z',
  membershipName: 'SVIP',
}

const contactMethods = [
  {
    id: 'contact-1',
    platform: 'telegram',
    label: 'Telegram',
    value: 'meigallery_admin',
    linkUrl: null,
    qrCodeUrl: null,
    sortOrder: 1,
    enabled: true,
    attributionCapability: 'capability_playwright_contact_1',
  },
]

const defaultPublicSettings = {
  site_name: '测试图库站',
  site_description: 'Playwright smoke 测试站点',
  seo_title: '测试站点标题 - 首页 SEO',
  seo_keywords: '授权图库,写真,时尚写真',
  og_title: '测试站点 OG 标题',
  og_description: '测试站点 OG 描述',
  footer_text: '测试环境',
  video_enabled: 'false',
  ad_platform_browser_connections: [],
  analytics_enabled: 'true',
  analytics_sample_rate: '0',
  analytics_consent_mode: 'granted',
  home_hero_title: '精选写真，按地区发现',
  home_hero_subtitle: '测试环境中的授权内容展示。',
  home_ad_enabled: 'true',
  home_ad_eyebrow: '本周推荐',
  home_ad_title: '会员季精选内容精选内容精选内容',
  home_ad_summary: '探索本周精选图库、真实案例和会员可访问内容，保持文案可读、不过度堆叠并适配多断点预览。',
  home_ad_cta_label: '查看推荐',
  home_ad_url: '/discover?sort=hot',
  home_ad_sponsor: '运营推荐',
  rules_entry_enabled: 'false',
}

const mutablePublicSettings = { ...defaultPublicSettings }
const analyticsBatches = []
const sessionEndBatches = []
const registrations = []
const receiptProtectedRequests = []
let authenticated = true
let sessionCookieRequired = false
let adminAnalyticsEmpty = false
const adminAttributionRequests = []
const adminAttributionCommands = new Map()
const adminAttributionConnections = []
const adminAttributionManagedSources = new Map()
let adminAttributionPrivacyPolicy = null

function resetPublicSettings() {
  for (const key of Object.keys(mutablePublicSettings)) {
    delete mutablePublicSettings[key]
  }
  Object.assign(mutablePublicSettings, defaultPublicSettings)
  analyticsBatches.length = 0
  sessionEndBatches.length = 0
  registrations.length = 0
  receiptProtectedRequests.length = 0
  authenticated = true
  sessionCookieRequired = false
  adminAnalyticsEmpty = false
  adminAttributionRequests.length = 0
  resetAdminAttribution()
}

function json(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type,idempotency-key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function notFound(res) {
  json(res, { statusCode: 404, message: '测试接口不存在' }, 404)
}

function publicSettings() {
  return { ...mutablePublicSettings }
}

function adminSettings() {
  const now = new Date('2026-06-01T00:00:00.000Z').toISOString()
  return Object.fromEntries(Object.entries(mutablePublicSettings).map(([key, value]) => [key, { value, updatedAt: now }]))
}

async function readJsonBody(req) {
  const raw = (await readRawBodyBuffer(req)).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

async function readRawBodyBuffer(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function galleryDetail(slug) {
  const base = galleries.find(gallery => gallery.slug === slug)
  if (!base) return null

  return {
    ...base,
    bodyMd: 'Playwright smoke 测试正文。',
    status: 'published',
    createdAt: '2026-05-01T08:00:00Z',
    updatedAt: '2026-05-01T08:00:00Z',
    likedByMe: false,
    mediaAssets: [
      {
        id: 'asset-public-1',
        type: 'image',
        role: 'gallery',
        sortOrder: 1,
        requiredRank: 0,
        thumbnailUrl: imageDataUrl,
        url: imageDataUrl,
      },
      {
        id: 'asset-locked-1',
        type: 'image',
        role: 'gallery',
        sortOrder: 2,
        requiredRank: 20,
      },
    ],
  }
}

function analyticsRange(searchParams) {
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  if (from || to) {
    const start = from || to || '2026-06-30'
    const end = to || from || '2026-06-30'
    const startDate = new Date(`${start}T00:00:00Z`)
    const endDate = new Date(`${end}T00:00:00Z`)
    const days = Number.isFinite(startDate.getTime()) && Number.isFinite(endDate.getTime())
      ? Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1)
      : 1
    return { from: start, to: end, days }
  }

  const range = searchParams.get('range') || '30d'
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30
  return { from: '2026-06-01', to: '2026-06-30', days }
}

function adminAnalyticsResponse(pathname, searchParams) {
  const range = analyticsRange(searchParams)
  const usage = { rowsRead: 120, rowsWritten: 0, durationMs: 12 }
  if (adminAnalyticsEmpty) {
    if (pathname.endsWith('/overview')) {
      return {
        range,
        usage,
        data: {
          totals: {
            visitor_count: 0,
            session_count: 0,
            page_view_count: 0,
            gallery_detail_count: 0,
            register_count: 0,
            invite_register_count: 0,
            contact_click_count: 0,
            membership_grant_count: 0,
            average_active_seconds: 0,
          },
          trend: [],
          topSources: [],
          topPages: [],
          topClicks: [],
          health: null,
        },
      }
    }
    if (pathname.endsWith('/seo')) {
      return {
        range,
        usage,
        data: {
          totals: {
            visitor_count: 0,
            session_count: 0,
            page_view_count: 0,
            landing_count: 0,
            bounce_count: 0,
            contact_click_count: 0,
            register_count: 0,
            membership_grant_count: 0,
            search_session_share: 0,
            landing_bounce_rate: 0,
            contact_rate: 0,
            register_rate: 0,
          },
          trend: [],
          referrers: [],
          landingPages: [],
          notes: {
            source: 'SEO 数据来自站内一方埋点识别到的自然搜索 referrer 或 utm_medium=seo/search/organic_search。',
            limitation: '当前不读取 Google Search Console 或搜索广告后台，因此不包含关键词排名、展现量和搜索词明细。',
          },
        },
      }
    }
    if (pathname.endsWith('/health')) {
      return {
        range,
        usage,
        data: {
          totals: {
            accepted_count: 0,
            rejected_count: 0,
            duplicate_count: 0,
            sensitive_blocked_count: 0,
            sampled_count: 0,
            dropped_count: 0,
            estimated_rows_read: 0,
            estimated_rows_written: 0,
            max_duration_ms: 0,
            last_ingested_at: null,
          },
          daily: [],
        },
      }
    }
    return { range, usage, data: [] }
  }
  if (pathname.endsWith('/overview')) {
    return {
      range,
      usage,
      data: {
        totals: {
          visitor_count: 18,
          session_count: 22,
          page_view_count: 64,
          register_count: 3,
          invite_register_count: 2,
          contact_click_count: 4,
          effective_contact_click_count: 3,
          raw_contact_click_count: 4,
          duplicate_contact_click_count: 1,
          membership_grant_count: 1,
          gallery_detail_count: 9,
          average_active_seconds: 42,
        },
        trend: [
          { date: '2026-06-03', visitor_count: 8, session_count: 10, page_view_count: 24, register_count: 1, contact_click_count: 1, effective_contact_click_count: 1, membership_grant_count: 0 },
          { date: '2026-06-04', visitor_count: 11, session_count: 13, page_view_count: 34, register_count: 1, contact_click_count: 2, effective_contact_click_count: 2, membership_grant_count: 0 },
          { date: '2026-06-05', visitor_count: 14, session_count: 16, page_view_count: 45, register_count: 2, contact_click_count: 3, effective_contact_click_count: 2, membership_grant_count: 1 },
          { date: '2026-06-06', visitor_count: 16, session_count: 18, page_view_count: 52, register_count: 2, contact_click_count: 3, effective_contact_click_count: 3, membership_grant_count: 1 },
          { date: '2026-06-07', visitor_count: 18, session_count: 22, page_view_count: 64, register_count: 3, contact_click_count: 4, effective_contact_click_count: 3, membership_grant_count: 1 },
        ],
        topSources: [{ source_channel: 'invite', source_name: 'Playwright 邀请', session_count: 12, register_count: 2 }],
        topPages: [{ route_name: '/gallery/:slug', path: '/gallery/summer-portrait', page_view_count: 9, active_seconds_total: 420 }],
        topClicks: [{ element_id: 'contact_method_click', location: 'floating_contact_panel', raw_click_count: 4, effective_click_count: 3 }],
        health: { accepted_count: 120, rejected_count: 0, estimated_rows_written: 240, last_ingested_at: '2026-06-07T10:00:00.000Z' },
      },
    }
  }
  if (pathname.endsWith('/seo')) {
    return {
      range,
      usage,
      data: {
        totals: {
          visitor_count: 9,
          session_count: 11,
          page_view_count: 31,
          gallery_detail_count: 7,
          landing_count: 10,
          bounce_count: 2,
          contact_click_count: 3,
          register_count: 2,
          membership_grant_count: 1,
          average_active_seconds: 49,
          search_session_share: 0.5,
          search_page_view_share: 0.48,
          landing_bounce_rate: 0.2,
          contact_rate: 0.2727,
          register_rate: 0.1818,
        },
        trend: [
          { date: '2026-06-03', visitor_count: 2, session_count: 2, page_view_count: 5, contact_click_count: 0, register_count: 0, membership_grant_count: 0 },
          { date: '2026-06-04', visitor_count: 2, session_count: 3, page_view_count: 8, contact_click_count: 1, register_count: 1, membership_grant_count: 0 },
          { date: '2026-06-05', visitor_count: 2, session_count: 2, page_view_count: 6, contact_click_count: 1, register_count: 0, membership_grant_count: 0 },
          { date: '2026-06-06', visitor_count: 3, session_count: 4, page_view_count: 12, contact_click_count: 1, register_count: 1, membership_grant_count: 1 },
        ],
        referrers: [
          { source_channel: 'search', source_name: 'google.com', source_label: 'Google', session_count: 7, page_view_count: 21, average_active_seconds: 52, contact_click_count: 2, register_count: 1, contact_rate: 0.2857, register_rate: 0.1429 },
          { source_channel: 'search', source_name: 'bing.com', source_label: 'Bing', session_count: 4, page_view_count: 10, average_active_seconds: 44, contact_click_count: 1, register_count: 1, contact_rate: 0.25, register_rate: 0.25 },
        ],
        landingPages: [
          { route_label: '夏日授权写真', route_name: '/gallery/:slug', path: '/gallery/summer-portrait', entry_count: 6, page_view_count: 15, bounce_rate: 0.1667, average_active_seconds: 58, max_scroll_depth: 86, contact_click_count: 2, register_count: 1, contact_rate: 0.3333 },
          { route_label: '发现页', route_name: '/discover', path: '/discover?sort=hot', entry_count: 4, page_view_count: 9, bounce_rate: 0.25, average_active_seconds: 42, max_scroll_depth: 72, contact_click_count: 1, register_count: 1, contact_rate: 0.25 },
        ],
        notes: {
          source: 'SEO 数据来自站内一方埋点识别到的自然搜索 referrer 或 utm_medium=seo/search/organic_search。',
          limitation: '当前不读取 Google Search Console 或搜索广告后台，因此不包含关键词排名、展现量和搜索词明细。',
        },
      },
    }
  }
  if (pathname.endsWith('/health')) {
    return {
      range,
      usage,
      data: {
        totals: { accepted_count: 120, rejected_count: 0, duplicate_count: 0, estimated_rows_written: 240 },
        daily: [{ date: '2026-06-07', accepted_count: 120, rejected_count: 0, duplicate_count: 0, sensitive_blocked_count: 0, sampled_count: 0, estimated_rows_read: 12, estimated_rows_written: 240, max_duration_ms: 8, last_ingested_at: '2026-06-07T10:00:00.000Z' }],
      },
    }
  }
  if (pathname.endsWith('/invites')) {
    return {
      range,
      usage,
      data: [{ invite_code_id: 'inv_test', invite_name: 'Playwright 邀请', channel: 'test', status: 'active', landing_count: 5, visitor_count: 5, register_count: 2, contact_click_count: 1, membership_grant_count: 1 }],
    }
  }
  return {
    range,
    usage,
    data: [{
      source_channel: 'invite',
      source_name: 'Playwright 邀请',
      route_name: '/gallery/:slug',
      path: '/gallery/summer-portrait',
      from_route: '/',
      to_route: '/gallery/:slug',
      element_id: 'contact_method_click',
      element_type: 'button',
      location: 'floating_contact_panel',
      page_view_count: 9,
      visitor_count: 5,
      session_count: 5,
      raw_click_count: 4,
      effective_click_count: 3,
      duplicate_click_count: 1,
      active_seconds_total: 420,
      average_active_seconds: 46,
      bounce_rate: 0.1,
      max_scroll_depth: 80,
      transition_count: 6,
      conversion_count: 2,
    }],
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function attributionRuntimePolicy(
  serverTargetPercentage = 10,
  overrides = {},
) {
  return {
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    serverTargetPercentage,
    serverEffectivePercentage: serverTargetPercentage,
    circuitState: 'closed',
    ...overrides,
  }
}

function attributionConnectionFixture({
  id,
  provider,
  name,
  activeTarget,
  isDefault = false,
  serverTargetPercentage = 10,
}) {
  return {
    id,
    provider,
    name,
    isDefault,
    state: 'active',
    activeTarget,
    candidate: null,
    runtime: attributionRuntimePolicy(serverTargetPercentage),
    health: {
      level: 'healthy',
      lastDeliveryAt: '2026-07-24T02:30:00.000Z',
    },
  }
}

function defaultAdminAttributionConnections() {
  return [
    attributionConnectionFixture({
      id: 'conn_meta_a',
      provider: 'meta',
      name: 'Meta 美国 BJ 团队',
      activeTarget: '1615446443914929',
      isDefault: true,
    }),
    attributionConnectionFixture({
      id: 'conn_meta_b',
      provider: 'meta',
      name: 'Meta 美国 WA 团队',
      activeTarget: '1566612068298913',
    }),
    attributionConnectionFixture({
      id: 'conn_tiktok_a',
      provider: 'tiktok',
      name: 'TikTok 美国团队',
      activeTarget: 'D9AF43RC77U133LMNMM0',
      isDefault: true,
      serverTargetPercentage: 100,
    }),
    attributionConnectionFixture({
      id: 'conn_google_a',
      provider: 'google',
      name: 'Google 美国搜索团队',
      activeTarget: 'AW-123456789',
      isDefault: true,
      serverTargetPercentage: 0,
    }),
  ]
}

function resetAdminAttribution() {
  adminAttributionCommands.clear()
  adminAttributionConnections.splice(
    0,
    adminAttributionConnections.length,
    ...defaultAdminAttributionConnections(),
  )
  adminAttributionManagedSources.clear()
  for (const connection of adminAttributionConnections) {
    adminAttributionManagedSources.set(connection.id, [])
  }
  adminAttributionPrivacyPolicy = {
    availability: 'available',
    defaultMode: 'notice_opt_out',
    priorConsentCountryCodes: ['AT', 'BE', 'DE', 'FR', 'GB'],
    policyVersion: 3,
    updatedAt: '2026-07-24T01:00:00.000Z',
  }
}

function attributionConnection(id) {
  return adminAttributionConnections.find(connection => connection.id === id)
}

function attributionFilteredConnections(searchParams) {
  const provider = searchParams.get('provider') || ''
  const connectionId = searchParams.get('connectionId') || ''
  return adminAttributionConnections.filter(connection => (
    (!provider || connection.provider === provider)
    && (!connectionId || connection.id === connectionId)
  ))
}

function attributionDates(searchParams) {
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  if (dateFrom && dateFrom === dateTo) return [dateFrom]
  return ['2026-07-22', '2026-07-23', '2026-07-24']
}

function attributionEventBindings(provider) {
  const destinations = {
    meta: ['meta_pixel', 'meta_capi'],
    tiktok: ['tiktok_pixel', 'tiktok_events_api'],
    google: ['AW-123456789/ContactLabel', '1234567890'],
  }
  const [browserDestination, serverDestination] =
    destinations[provider] || destinations.meta
  return ['Contact', 'CompleteRegistration'].map(canonicalEvent => ({
    canonicalEvent,
    enabled: true,
    browserDestination,
    serverDestination,
  }))
}

function attributionOperations(searchParams) {
  return attributionDates(searchParams).flatMap((date, dateIndex) =>
    attributionFilteredConnections(searchParams).map(
      (connection, connectionIndex) => {
        const offset = dateIndex + connectionIndex
        const factCount = 5 + offset
        return {
          date,
          provider: connection.provider,
          connectionId: connection.id,
          connectionName: connection.name,
          contactCount: 3 + offset,
          completeRegistrationCount: 1 + dateIndex,
          factCount,
          attributedFactCount: factCount - 1,
          unattributedFactCount: 1,
          browserAttempted: factCount,
          serverPlanned: factCount,
          serverQueued: factCount - 1,
          serverProcessed: factCount - 2,
          serverRejected: offset % 2,
          serverDeadLetter: 0,
        }
      },
    ))
}

function attributionQuality(searchParams) {
  const date = attributionDates(searchParams).at(-1)
  return attributionFilteredConnections(searchParams).map(
    (connection, index) => ({
      date,
      provider: connection.provider,
      connectionId: connection.id,
      connectionName: connection.name,
      metricKey: 'event_match_quality',
      numerator: 8 + index,
      denominator: 10 + index,
      value: (8 + index) / (10 + index),
      availability: 'available',
    }),
  )
}

function attributionBindings(searchParams) {
  return attributionFilteredConnections(searchParams).map(connection => ({
    provider: connection.provider,
    connectionId: connection.id,
    connectionName: connection.name,
    active: {
      state: connection.state === 'not_configured'
        ? 'not_configured'
        : 'active',
      bindings: attributionEventBindings(connection.provider),
    },
    candidate: connection.candidate
      ? {
          state: connection.candidate.state,
          bindings: attributionEventBindings(connection.provider),
        }
      : null,
  }))
}

function attributionVerifications(searchParams) {
  return attributionFilteredConnections(searchParams).map(connection => ({
    provider: connection.provider,
    connectionId: connection.id,
    connectionName: connection.name,
    status: connection.candidate?.state === 'failed'
      ? 'failed'
      : 'verified',
    failureCode: connection.candidate?.failureCode || '',
    candidateChecked: Boolean(connection.candidate),
    pairedEventCount: 2,
    createdAt: '2026-07-24T01:30:00.000Z',
    startedAt: '2026-07-24T01:30:02.000Z',
    completedAt: '2026-07-24T01:30:05.000Z',
  }))
}

function attributionIncidents(searchParams) {
  const rows = [{
    id: 'incident_meta_a_warning',
    provider: 'meta',
    connectionId: 'conn_meta_a',
    connectionName: 'Meta 美国 BJ 团队',
    severity: 'warning',
    code: 'server_delivery_delayed',
    affectedChannel: 'server',
    affectedEvent: 'Contact',
    openedAt: '2026-07-23T08:00:00.000Z',
    detectedAt: '2026-07-23T08:03:00.000Z',
    recoveredAt: '2026-07-23T08:08:00.000Z',
    affectedFactCount: 2,
    affectedDeliveryCount: 2,
    automaticAction: 'retry',
    recoveryStatus: 'recovered',
  }]
  const provider = searchParams.get('provider')
  const connectionId = searchParams.get('connectionId')
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  return rows.filter(row => (
    (!provider || row.provider === provider)
    && (!connectionId || row.connectionId === connectionId)
    && (!dateFrom || row.openedAt.slice(0, 10) >= dateFrom)
    && (!dateTo || row.openedAt.slice(0, 10) <= dateTo)
  ))
}

function attributionAudit(searchParams) {
  return attributionFilteredConnections(searchParams).map(connection => ({
    provider: connection.provider,
    connectionId: connection.id,
    connectionName: connection.name,
    actorId: 1,
    commandType: 'set_runtime_policy',
    outcome: 'updated',
    summary: '更新运行策略',
    createdAt: '2026-07-24T02:00:00.000Z',
  }))
}

function attributionReadResponse(pathname, searchParams) {
  if (pathname.endsWith('/connections')) {
    return clone(adminAttributionConnections)
  }
  if (pathname.endsWith('/operations')) {
    return attributionOperations(searchParams)
  }
  if (pathname.endsWith('/quality')) {
    return attributionQuality(searchParams)
  }
  if (pathname.endsWith('/bindings')) {
    return attributionBindings(searchParams)
  }
  if (pathname.endsWith('/verifications')) {
    return attributionVerifications(searchParams)
  }
  if (pathname.endsWith('/incidents')) {
    return attributionIncidents(searchParams)
  }
  if (pathname.endsWith('/audit')) {
    return attributionAudit(searchParams)
  }
  if (pathname.endsWith('/privacy-policy')) {
    return clone(adminAttributionPrivacyPolicy)
  }
  return null
}

function attributionCommandSummary() {
  const commands = [...adminAttributionCommands.values()].map(command => ({
    key: command.key,
    type: command.type,
    path: command.path,
    requests: command.requests,
    writes: command.writes,
  }))
  return {
    commands,
    writesByType: commands.reduce((totals, command) => {
      totals[command.type] = (totals[command.type] || 0) + command.writes
      return totals
    }, {}),
  }
}

function runAttributionCommand(req, res, url, type, execute) {
  readJsonBody(req)
    .then((body) => {
      const key = String(req.headers['idempotency-key'] || '').trim()
      if (!key) {
        json(res, {
          error: {
            code: 'ATTRIBUTION_IDEMPOTENCY_KEY_REQUIRED',
            message: '缺少 Idempotency-Key',
          },
        }, 400)
        return
      }
      const signature = JSON.stringify({
        method: req.method,
        path: url.pathname,
        body,
      })
      const existing = adminAttributionCommands.get(key)
      if (existing) {
        existing.requests += 1
        if (existing.signature !== signature) {
          json(res, {
            error: {
              code: 'ATTRIBUTION_IDEMPOTENCY_CONFLICT',
              message: '幂等键已用于不同命令',
            },
          }, 409)
          return
        }
        json(res, clone(existing.response))
        return
      }

      const response = { data: clone(execute(body)) }
      adminAttributionCommands.set(key, {
        key,
        type,
        path: url.pathname,
        signature,
        requests: 1,
        writes: 1,
        response: clone(response),
      })
      json(res, response)
    })
    .catch(() => json(res, {
      error: {
        code: 'ATTRIBUTION_COMMAND_INVALID',
        message: '归因命令请求无效',
      },
    }, 400))
}

function handleAdminAttributionRuntime(req, res, url) {
  const prefix = '/api/admin/attribution-runtime'
  if (
    url.pathname !== prefix
    && !url.pathname.startsWith(`${prefix}/`)
  ) return false

  if (req.method === 'GET') {
    adminAttributionRequests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    })
  }

  if (req.method === 'GET') {
    const sourceListMatch = url.pathname.match(
      /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/sources$/,
    )
    if (sourceListMatch) {
      const connectionId = decodeURIComponent(sourceListMatch[1])
      json(res, {
        data: {
          connectionId,
          sources: clone(
            adminAttributionManagedSources.get(connectionId) || [],
          ),
        },
      })
      return true
    }

    const connectionMatch = url.pathname.match(
      /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)$/,
    )
    if (connectionMatch) {
      const connection = attributionConnection(
        decodeURIComponent(connectionMatch[1]),
      )
      if (connection) json(res, { data: clone(connection) })
      else notFound(res)
      return true
    }

    const data = attributionReadResponse(url.pathname, url.searchParams)
    if (data === null) notFound(res)
    else json(res, { data })
    return true
  }

  if (
    req.method === 'POST'
    && url.pathname === `${prefix}/connections`
  ) {
    runAttributionCommand(req, res, url, 'createConnection', (body) => {
      const provider = String(body.provider || 'meta')
      const connection = attributionConnectionFixture({
        id: `conn_${provider}_${adminAttributionConnections.length + 1}`,
        provider,
        name: String(body.name || '未命名连接'),
        activeTarget: '',
        isDefault: Boolean(body.isDefault),
        serverTargetPercentage: 0,
      })
      connection.state = 'not_configured'
      connection.runtime = attributionRuntimePolicy(0, {
        enabled: false,
        browserEnabled: false,
        serverEnabled: false,
      })
      adminAttributionConnections.push(connection)
      adminAttributionManagedSources.set(connection.id, [])
      return connection
    })
    return true
  }

  const candidateMatch = url.pathname.match(
    /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/candidates$/,
  )
  if (req.method === 'POST' && candidateMatch) {
    runAttributionCommand(req, res, url, 'createCandidate', (body) => {
      const connection = attributionConnection(
        decodeURIComponent(candidateMatch[1]),
      )
      if (!connection) throw new Error('connection not found')
      const failed = Object.values(body.publicConfig || {})
        .some(value => value === '00000')
      connection.candidate = {
        state: failed ? 'failed' : 'validating',
        createdAt: '2026-07-24T03:00:00.000Z',
        failureCode: failed ? 'identity_not_found' : '',
        productionContinues: true,
      }
      return connection
    })
    return true
  }

  const runtimeMatch = url.pathname.match(
    /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/runtime-policy$/,
  )
  if (req.method === 'PATCH' && runtimeMatch) {
    runAttributionCommand(req, res, url, 'setRuntimePolicy', (body) => {
      const connection = attributionConnection(
        decodeURIComponent(runtimeMatch[1]),
      )
      if (!connection) throw new Error('connection not found')
      connection.runtime = {
        ...connection.runtime,
        enabled: Boolean(body.enabled),
        browserEnabled: Boolean(body.browserEnabled),
        serverEnabled: Boolean(body.serverEnabled),
        serverTargetPercentage: Number(body.serverTargetPercentage),
        serverEffectivePercentage: Number(body.serverTargetPercentage),
      }
      connection.state = connection.runtime.enabled ? 'active' : 'disabled'
      return connection
    })
    return true
  }

  const rollbackMatch = url.pathname.match(
    /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/rollback$/,
  )
  if (req.method === 'POST' && rollbackMatch) {
    runAttributionCommand(req, res, url, 'rollbackConnection', () => {
      const connection = attributionConnection(
        decodeURIComponent(rollbackMatch[1]),
      )
      if (!connection) throw new Error('connection not found')
      return connection
    })
    return true
  }

  const disableMatch = url.pathname.match(
    /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/disable$/,
  )
  if (req.method === 'POST' && disableMatch) {
    runAttributionCommand(req, res, url, 'disableConnection', () => {
      const connection = attributionConnection(
        decodeURIComponent(disableMatch[1]),
      )
      if (!connection) throw new Error('connection not found')
      connection.state = 'disabled'
      connection.runtime = {
        ...connection.runtime,
        enabled: false,
        serverEffectivePercentage: 0,
      }
      return connection
    })
    return true
  }

  const createSourceMatch = url.pathname.match(
    /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/sources$/,
  )
  if (req.method === 'POST' && createSourceMatch) {
    runAttributionCommand(req, res, url, 'createManagedSource', (body) => {
      const connectionId = decodeURIComponent(createSourceMatch[1])
      const connection = attributionConnection(connectionId)
      if (!connection) throw new Error('connection not found')
      const rows = adminAttributionManagedSources.get(connectionId) || []
      const source = {
        id: `source_${connectionId}_${rows.length + 1}`,
        provider: connection.provider,
        connectionId,
        campaign: String(body.campaign || ''),
        medium: String(body.medium || ''),
        content: String(body.content || ''),
        expiresAt: body.expiresAt || null,
        enabled: true,
        createdAt: '2026-07-24T03:10:00.000Z',
      }
      rows.unshift(source)
      adminAttributionManagedSources.set(connectionId, rows)
      return {
        source,
        proof: 'playwright_managed_source_proof',
        proofDelivery: 'issued_once',
        replayed: false,
      }
    })
    return true
  }

  const disableSourceMatch = url.pathname.match(
    /^\/api\/admin\/attribution-runtime\/connections\/([^/]+)\/sources\/([^/]+)\/disable$/,
  )
  if (req.method === 'POST' && disableSourceMatch) {
    runAttributionCommand(req, res, url, 'disableManagedSource', () => {
      const connectionId = decodeURIComponent(disableSourceMatch[1])
      const sourceId = decodeURIComponent(disableSourceMatch[2])
      const source = (adminAttributionManagedSources.get(connectionId) || [])
        .find(item => item.id === sourceId)
      if (!source) throw new Error('source not found')
      source.enabled = false
      return { source, disabled: true }
    })
    return true
  }

  if (
    req.method === 'PATCH'
    && url.pathname === `${prefix}/privacy-policy`
  ) {
    runAttributionCommand(req, res, url, 'savePrivacyPolicy', (body) => {
      adminAttributionPrivacyPolicy = {
        ...adminAttributionPrivacyPolicy,
        defaultMode: body.defaultMode,
        priorConsentCountryCodes: body.priorConsentCountryCodes,
        policyVersion: adminAttributionPrivacyPolicy.policyVersion + 1,
        updatedAt: '2026-07-24T03:20:00.000Z',
      }
      return adminAttributionPrivacyPolicy
    })
    return true
  }

  notFound(res)
  return true
}

function handleApi(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'content-type,idempotency-key',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    })
    res.end()
    return
  }

  if (url.pathname === '/api/health') return json(res, { ok: true })
  if (url.pathname === '/api/test/reset' && req.method === 'POST') {
    resetPublicSettings()
    return json(res, { ok: true })
  }
  if (url.pathname === '/api/test/admin-analytics-empty' && req.method === 'PATCH') {
    readJsonBody(req)
      .then((body) => {
        adminAnalyticsEmpty = Boolean(body?.enabled)
        json(res, { ok: true, enabled: adminAnalyticsEmpty })
      })
      .catch(() => json(res, { statusCode: 400, message: '测试设置请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/test/admin-attribution-requests') {
    return json(res, { requests: adminAttributionRequests })
  }
  if (url.pathname === '/api/test/admin-attribution-requests/clear' && req.method === 'POST') {
    adminAttributionRequests.length = 0
    return json(res, { ok: true })
  }
  if (url.pathname === '/api/test/admin-attribution-commands') {
    return json(res, attributionCommandSummary())
  }
  if (url.pathname === '/api/test/analytics-events') {
    return json(res, {
      batches: analyticsBatches,
      sessionEnds: sessionEndBatches,
      registrations,
      receiptProtectedRequests,
      events: analyticsBatches.flatMap(batch => Array.isArray(batch.events) ? batch.events : []),
    })
  }
  if (url.pathname === '/api/test/receipt-protected-requests/clear' && req.method === 'POST') {
    receiptProtectedRequests.length = 0
    return json(res, { ok: true })
  }
  if (url.pathname === '/api/test/binary-upload' && req.method === 'POST') {
    readRawBodyBuffer(req)
      .then((body) => {
        const marker = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42, 0x43])
        json(res, { preserved: body.includes(marker), bytes: body.length })
      })
      .catch(() => json(res, { statusCode: 400, message: '二进制上传读取失败' }, 400))
    return
  }
  if (url.pathname === '/api/test/auth' && req.method === 'PATCH') {
    readJsonBody(req)
      .then((body) => {
        authenticated = body.authenticated !== false
        json(res, { ok: true, authenticated })
      })
      .catch(() => json(res, { statusCode: 400, message: '认证状态请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/settings/public') return json(res, publicSettings())
  if (url.pathname === '/api/me') {
    const cookie = String(req.headers.cookie || '')
    receiptProtectedRequests.push({ endpoint: '/api/me', cookie })
    const hasRequiredSession = !sessionCookieRequired
      || cookie.includes('mei_session=mock-session')
      || cookie.includes('mei_session=renewed-session')
    return authenticated && hasRequiredSession
      ? json(res, user, 200, cookie.includes('mei_session=mock-session')
          ? { 'Set-Cookie': 'mei_session=renewed-session; Path=/; HttpOnly; SameSite=Lax' }
          : {})
      : json(res, { statusCode: 401, message: '未登录', code: 'AUTH_REQUIRED' }, 401)
  }
  if (url.pathname === '/api/contact-methods') return json(res, { data: contactMethods })
  if (url.pathname.startsWith('/api/invites/') && url.pathname.endsWith('/status')) {
    const code = decodeURIComponent(url.pathname.replace('/api/invites/', '').replace('/status', ''))
    if (code === 'TESTCODE') {
      return json(res, {
        valid: true,
        inviteCodeId: 'inv_test',
        name: 'Playwright 邀请',
        channel: 'test',
        expiresAt: '2026-12-31T00:00:00.000Z',
      })
    }
    return json(res, { valid: false, reason: 'NOT_FOUND' })
  }
  if (url.pathname === '/api/analytics/events' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        analyticsBatches.push(body)
        json(res, { accepted: Array.isArray(body.events) ? body.events.length : 0, rejected: 0, duplicate: 0 })
      })
      .catch(() => json(res, { statusCode: 400, message: '分析事件请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/analytics/session/end' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        sessionEndBatches.push(body)
        json(res, { accepted: 1, rejected: 0, duplicate: 0 })
      })
      .catch(() => json(res, { statusCode: 400, message: 'session end 请求无效' }, 400))
    return
  }
  if (url.pathname.startsWith('/api/auth/check-username/')) {
    return json(res, { available: true })
  }
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        receiptProtectedRequests.push({ endpoint: '/api/auth/register', cookie: req.headers.cookie || '' })
        registrations.push(body)
        authenticated = true
        sessionCookieRequired = true
        json(res, {
          ...user,
          id: 22,
          email: body.email || 'new-user@example.test',
          username: body.username || 'newuser',
          role: 'user',
          membershipRank: 0,
          membershipName: 'free',
          attributionInstructionToken: null,
        }, 200, {
          'Set-Cookie': 'mei_session=mock-session; Path=/; HttpOnly; SameSite=Lax',
        })
      })
      .catch(() => json(res, { statusCode: 400, message: '注册请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/cases') return json(res, { data: cases, total: cases.length })
  if (url.pathname === '/api/tags') {
    return json(res, {
      data: {
        city_country: tags.filter(tag => tag.type === 'city_country').map(({ id, name, slug }) => ({ id, name, slug })),
        style: tags.filter(tag => tag.type === 'style').map(({ id, name, slug }) => ({ id, name, slug })),
        scene: tags.filter(tag => tag.type === 'scene').map(({ id, name, slug }) => ({ id, name, slug })),
      },
    })
  }
  if (url.pathname === '/api/galleries') {
    return json(res, { data: galleries, total: galleries.length, page: 1, pageSize: Number(url.searchParams.get('pageSize') || 24) })
  }
  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim()
    const data = query
      ? galleries.filter(gallery => gallery.title.includes(query) || gallery.summary?.includes(query))
      : galleries
    return json(res, { data, total: data.length, page: 1, pageSize: 24 })
  }
  if (url.pathname.startsWith('/api/galleries/') && url.pathname.endsWith('/like')) {
    return json(res, { likeCount: 13, likedByMe: req.method === 'POST' })
  }
  if (url.pathname.startsWith('/api/galleries/')) {
    const slug = decodeURIComponent(url.pathname.replace('/api/galleries/', ''))
    const detail = galleryDetail(slug)
    return detail ? json(res, detail) : notFound(res)
  }
  if (url.pathname === '/api/admin/dashboard') {
    return json(res, {
      totalGalleries: 5,
      publishedGalleries: 3,
      totalUsers: 12,
      activeVipUsers: 5,
      processingImports: 0,
      draftGalleries: 1,
      failedImports: 0,
    })
  }
  if (url.pathname.startsWith('/api/admin/analytics/')) {
    return json(res, adminAnalyticsResponse(url.pathname, url.searchParams))
  }
  if (handleAdminAttributionRuntime(req, res, url)) return
  if (url.pathname === '/api/admin/tracking-sources' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const slug = String(body.sourceLabel || 'tracking-source').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tracking-source'
        json(res, {
          data: {
            id: `ats_${slug}`,
            name: body.sourceLabel || '测试投放链接',
            sourceLabel: body.sourceLabel || '测试投放链接',
            channel: body.channel || 'ad',
            slug,
            sourceCode: slug,
            targetPath: body.targetPath || '/',
            utmSource: slug,
            utmMedium: body.utmMedium || 'paid_social',
            utmCampaign: body.utmCampaign || '',
            utmContent: body.utmContent || '',
            status: 'active',
            note: body.note || '',
            trackingPath: `${body.targetPath || '/'}?mg_source=${slug}&utm_source=${slug}&utm_medium=${body.utmMedium || 'paid_social'}${body.utmCampaign ? `&utm_campaign=${body.utmCampaign}` : ''}${body.utmContent ? `&utm_content=${body.utmContent}` : ''}`,
          },
        }, 201)
      })
      .catch(() => json(res, { statusCode: 400, message: '追踪来源请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/admin/invite-codes') {
    return json(res, {
      data: [{
        id: 'inv_test',
        displayCode: 'TEST...',
        name: 'Playwright 邀请',
        channel: 'test',
        status: 'active',
        maxUses: 100,
        usedCount: 1,
        expiresAt: '2026-12-31T00:00:00.000Z',
        note: '测试邀请码',
      }],
    })
  }
  if (url.pathname === '/api/admin/settings') {
    if (req.method === 'GET') return json(res, { data: adminSettings() })
    if (req.method === 'PATCH') {
      readJsonBody(req)
        .then((body) => {
          Object.assign(mutablePublicSettings, body)
          json(res, { message: '设置已更新', updated: Object.keys(body) })
        })
        .catch(() => json(res, { statusCode: 400, message: '测试设置请求无效' }, 400))
      return
    }
  }
  if (url.pathname === '/api/admin/galleries') {
    return json(res, {
      data: galleries.slice(0, 2).map(gallery => ({
        id: gallery.id,
        title: gallery.title,
        slug: gallery.slug,
        status: gallery.requiredLevelRank > 0 ? 'draft' : 'published',
        cover_key: 'covers/test.svg',
        created_at: gallery.publishedAt,
      })),
    })
  }
  if (url.pathname.startsWith('/api/media/cover/')) {
    res.writeHead(302, { Location: imageDataUrl })
    res.end()
    return
  }

  notFound(res)
}

resetPublicSettings()

const server = createServer(handleApi)

server.listen(port, host, () => {
  console.log(`Playwright mock API listening on http://${host}:${port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
