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
  facebook_pixel_enabled: 'false',
  facebook_pixel_id: '1234567890',
  meta_capi_enabled: 'false',
  meta_tracking_mode: 'test',
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
let marketingConsentState = 'granted'
let adminAnalyticsEmpty = false
let adminAttributionReadinessBlocked = true
let adminAttributionActionMode = 'success'
let adminAttributionRolloutTarget = 10
let adminAttributionIncidentOpen = true
let adminAttributionRolloutScenario = 'hard'
let adminAttributionDatasetScenario = 'unavailable'
let adminAttributionEnvironment = 'dev'
const adminAttributionRequests = []
const adminAttributionActions = []

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
  marketingConsentState = 'granted'
  adminAnalyticsEmpty = false
  adminAttributionReadinessBlocked = true
  adminAttributionActionMode = 'success'
  adminAttributionRolloutTarget = 10
  adminAttributionIncidentOpen = true
  adminAttributionRolloutScenario = 'hard'
  adminAttributionDatasetScenario = 'unavailable'
  adminAttributionEnvironment = 'dev'
  adminAttributionRequests.length = 0
  adminAttributionActions.length = 0
}

function json(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
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

function adminAttributionResponse(pathname, searchParams) {
  const range = analyticsRange(searchParams)
  const usage = { rowsRead: 86, rowsWritten: 0, durationMs: 9 }
  const links = [
    {
      id: 'ats_meta_a',
      name: 'Meta 广告 A',
      sourceLabel: 'Meta 广告 A',
      channel: 'ad',
      slug: 'meta-ad-a',
      sourceCode: 'meta-ad-a',
      targetPath: '/',
      utmSource: 'meta-ad-a',
      utmMedium: 'paid_social',
      utmCampaign: 'july-contact',
      utmContent: 'chat-a',
      status: 'active',
      note: '测试广告 A',
      trackingPath: '/?mg_source=meta-ad-a&utm_source=meta-ad-a&utm_medium=paid_social&utm_campaign=july-contact&utm_content=chat-a',
      sessionCount: 18,
      pageViewCount: 44,
      galleryDetailCount: 12,
      contactClickCount: 4,
      registerCount: 2,
      membershipGrantCount: 1,
      activeSecondsTotal: 820,
      contactCount: 4,
      leadCount: 3,
      completeRegistrationCount: 2,
      startTrialCount: 0,
      conversionMembershipGrantCount: 1,
    },
  ]

  const dates = range.days === 1 ? [range.from] : ['2026-07-08', '2026-07-09', '2026-07-10']
  const trendRows = dates.map((date, index) => ({
    date,
    business: { contactCount: index + 1, completeRegistrationCount: index, actionCount: index * 2 + 1 },
    delivery: { pixelAttempted: index + 3, capiSent: index + 2, failed: index === 1 ? 1 : 0, skipped: 1, pending: index === 2 ? 1 : 0, retryExhausted: 0 },
  }))
  const rollout = {
    environment: adminAttributionEnvironment,
    targetPercentage: adminAttributionRolloutTarget,
    effectivePercentage: adminAttributionIncidentOpen ? 0 : adminAttributionRolloutTarget,
    connectionVerified: true,
    liveEvidencePresent: true,
    openIncident: adminAttributionIncidentOpen ? {
      id: 'incident-1', environment: 'dev', status: 'open', severity: 'critical', triggerCode: 'retry_exhausted', triggerSummary: 'CAPI 重试耗尽', targetPercentage: adminAttributionRolloutTarget, effectivePercentage: 0, evidence: {}, openedAt: '2026-07-09T08:00:00Z', lastObservedAt: '2026-07-10T08:00:00Z', closedAt: null, resolution: '',
    } : null,
    metrics: { sent: 42, failed: 1, permissionErrors: 0, retryExhausted: 0, stalePending: 0, criticalQualityDiagnostics: 0 },
    metricsStatus: { available: true, errorCode: null },
    promotion: {
      from: adminAttributionRolloutTarget,
      to: adminAttributionRolloutTarget === 10 ? 50 : 100,
      allowed: adminAttributionRolloutScenario === 'none',
      requiresOverrideReason: adminAttributionRolloutScenario === 'metric-only',
      blockers: adminAttributionRolloutScenario === 'metric-only' ? ['insufficient_attempts'] : [],
      hardBlockers: adminAttributionIncidentOpen ? ['circuit_open'] : [],
    },
  }
  const connection = {
    state: 'verified', environment: adminAttributionEnvironment, pixelIdConfigured: true, tokenConfigured: true, testEventCodeConfigured: true, verifiedAt: '2026-07-10T07:00:00Z', verifiedCommit: 'a'.repeat(40), graphApiVersion: 'v25.0', datasetQualityStatus: 'not_checked', invalidationReason: '',
  }

  if (pathname.endsWith('/summary')) return { range, usage, data: { business: { contactCount: 6, completeRegistrationCount: 3, actionCount: 9 }, historical: { leadCount: 7 }, delivery: { pixelAttempted: 12, capiSent: 9, failed: 1, skipped: 3, pending: 1, retryExhausted: 0 } } }
  if (pathname.endsWith('/trends')) return { range, usage, data: { granularity: 'day', rows: trendRows } }
  if (pathname.endsWith('/quality')) {
    const metric = (numerator, denominator) => ({ availability: denominator ? 'available' : 'unavailable', numerator, denominator, rate: denominator ? numerator / denominator : null })
    const datasetQuality = adminAttributionDatasetScenario === 'error'
      ? { availability: 'error', latest: { availability: 'error', value: null, status: 'error', errorCategory: 'permission_denied' }, rows: [] }
      : { availability: 'unavailable', latest: null, rows: [] }
    return { range, usage, data: { match: { summary: { fbp: metric(8, 9), fbc: metric(0, 0), email: metric(9, 9), externalId: metric(7, 9) }, rows: dates.map((date, index) => ({ date, fbp: index === 1 ? metric(0, 0) : metric(6 + index, 9), fbc: metric(0, 0), email: metric(8 + index, 9), externalId: metric(5 + index, 9) })) }, datasetQuality } }
  }
  if (pathname.endsWith('/breakdown')) return { range, usage, data: { dimension: searchParams.get('dimension') || 'utm_campaign', rows: [{ value: 'july-contact', actionCount: 6, contactCount: 4, completeRegistrationCount: 2, delivery: { pixelAttempted: 6, capiSent: 5, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 } }] } }
  if (pathname.endsWith('/meta/status')) return { range, usage, data: { connection, rollout, activity: { business: { contactCount: 6, completeRegistrationCount: 3, actionCount: 9 }, historical: { leadCount: 7 }, delivery: { pixelAttempted: 12, capiSent: 9, failed: 1, skipped: 3, pending: 1, retryExhausted: 0 } } } }
  if (pathname.endsWith('/meta/incidents')) return { range, usage, data: { items: rollout.openIncident ? [rollout.openIncident] : [], pagination: { limit: 20, offset: 0, hasMore: false } } }

  if (pathname.endsWith('/overview')) {
    return {
      range,
      usage,
      data: {
        totals: {
          contact_count: 4,
          lead_count: 3,
          complete_registration_count: 2,
          start_trial_count: 0,
          membership_grant_count: 1,
        },
        trend: [
          { date: '2026-07-07', contact_count: 1, lead_count: 1, complete_registration_count: 0, start_trial_count: 0, membership_grant_count: 0 },
          { date: '2026-07-08', contact_count: 1, lead_count: 1, complete_registration_count: 1, start_trial_count: 0, membership_grant_count: 0 },
          { date: '2026-07-09', contact_count: 2, lead_count: 1, complete_registration_count: 1, start_trial_count: 0, membership_grant_count: 1 },
        ],
        meta: {
          sent_count: 6,
          failed_count: 0,
          skipped_count: 1,
          duplicate_suppressed_count: 1,
          last_sent_at: '2026-07-09T09:30:00.000Z',
        },
        metaTrend: [
          { date: '2026-07-07', sent_count: 2, failed_count: 0, skipped_count: 0, duplicate_suppressed_count: 0 },
          { date: '2026-07-08', sent_count: 2, failed_count: 0, skipped_count: 1, duplicate_suppressed_count: 0 },
          { date: '2026-07-09', sent_count: 2, failed_count: 0, skipped_count: 0, duplicate_suppressed_count: 1 },
        ],
        duplicates: {
          duplicate_suppressed_count: 1,
          duplicate_action_count: 1,
          duplicate_rate: 0.125,
        },
        risks: [{ key: 'meta_skipped', level: 'info', message: '部分 Meta 投递被跳过' }],
      },
    }
  }

  if (pathname.endsWith('/conversions')) {
    return {
      range,
      usage,
      data: {
        byAction: [
          { action_type: 'contact', action_count: 4, unique_session_count: 4 },
          { action_type: 'lead', action_count: 3, unique_session_count: 3 },
          { action_type: 'complete_registration', action_count: 2, unique_session_count: 2 },
        ],
        bySource: [
          { source_channel: 'ad', source_name: 'meta-ad-a', utm_campaign: 'july-contact', utm_content: 'chat-a', contact_count: 4, lead_count: 3, complete_registration_count: 2, start_trial_count: 0, membership_grant_count: 1 },
        ],
        samples: [
          { id: 'conv_1', action_type: 'contact', occurred_at: '2026-07-09T09:10:00.000Z', source_channel: 'ad', source_name: 'meta-ad-a', tracking_source_slug: 'meta-ad-a', utm_campaign: 'july-contact', utm_content: 'chat-a', method_type: 'telegram', action_target: 'floating_contact_panel', route_name: 'gallery-detail', path: '/gallery/summer-portrait', duplicate_of: '' },
        ],
      },
    }
  }

  if (pathname.endsWith('/links')) return { range, usage, data: { links } }

  if (pathname.endsWith('/meta')) {
    return {
      range,
      usage,
      data: {
        totals: {
          pixel_attempted_count: 8,
          pixel_pending_count: 0,
          pixel_skipped_count: 1,
          capi_sent_count: 6,
          capi_failed_count: 2,
          capi_skipped_count: 1,
          retry_exhausted_count: 1,
          duplicate_suppressed_count: 1,
        },
        deliveries: [
          { channel: 'meta_pixel', event_name: 'Contact', status: 'attempted', skip_reason: '', delivery_count: 8 },
          { channel: 'meta_capi', event_name: 'Contact', status: 'sent', skip_reason: '', delivery_count: 6 },
          { channel: 'meta_capi', event_name: 'CompleteRegistration', status: 'failed', skip_reason: 'retry_exhausted', delivery_count: 2 },
          { channel: 'meta_capi', event_name: 'Contact', status: 'skipped', skip_reason: 'queue_not_configured', delivery_count: 1 },
        ],
        lastSentAt: '2026-07-09T09:30:00.000Z',
        queueBindingPresent: true,
        connection: {
          state: 'unverified',
          environment: 'dev',
          pixelIdConfigured: true,
          tokenConfigured: true,
          testEventCodeConfigured: true,
          verifiedAt: null,
          verifiedCommit: null,
          graphApiVersion: 'v25.0',
          datasetQualityStatus: 'not_checked',
          invalidationReason: 'verification_missing',
        },
        keyRotation: {
          currentKeyValid: true,
          previousKeyConfigured: true,
          previousKeyValid: true,
          previousSameAsCurrent: false,
          previousOutboxCount: 0,
          previousActiveDeliveryCount: 0,
          canRemovePrevious: true,
        },
        settings: {
          facebook_pixel_enabled: true,
          facebook_pixel_id: '1234567890',
          meta_capi_enabled: true,
          meta_tracking_mode: 'test',
        },
      },
    }
  }

  if (pathname.endsWith('/duplicates')) {
    return {
      range,
      usage,
      data: {
        duplicateSuppressedCount: 1,
        duplicateActionCount: 1,
        duplicateRate: 0.125,
        samples: [
          { id: 'convdup_1', action_type: 'contact', occurred_at: '2026-07-09T09:11:00.000Z', source_channel: 'ad', source_name: 'meta-ad-a', tracking_source_slug: 'meta-ad-a', utm_campaign: 'july-contact', utm_content: 'chat-a', method_type: 'telegram', action_target: 'floating_contact_panel', duplicate_of: 'conv_1' },
        ],
      },
    }
  }

  if (pathname.endsWith('/readiness')) {
    return {
      range,
      usage,
      data: {
        ready: !adminAttributionReadinessBlocked,
        checks: [
          { key: 'analytics_enabled', label: '站内分析已开启', level: 'blocker', ok: true, detail: 'analytics_enabled 已开启' },
          { key: 'conversion_ledger', label: '转化账本有近期数据', level: 'blocker', ok: true, detail: '当前范围记录 9 次转化' },
          { key: 'retry_exhausted', label: '最近 24 小时无重试耗尽', level: 'blocker', ok: !adminAttributionReadinessBlocked, detail: adminAttributionReadinessBlocked ? '发现 1 条 retry_exhausted' : '发现 0 条 retry_exhausted' },
          { key: 'pending_too_long', label: '无超过 10 分钟的 CAPI pending', level: 'warning', ok: false, detail: '发现 2 条超时 pending' },
          { key: 'fbp_coverage', label: '近 7 天 fbp 覆盖率', level: 'warning', ok: true, detail: '覆盖率 92.0%' },
        ],
        settings: {
          analytics_enabled: true,
          facebook_pixel_enabled: true,
          facebook_pixel_id: '1234567890',
          meta_capi_enabled: mutablePublicSettings.meta_capi_enabled === true || mutablePublicSettings.meta_capi_enabled === 'true',
          meta_tracking_mode: mutablePublicSettings.meta_tracking_mode,
        },
        verifications: {
          environment: 'dev',
          releaseCommitPresent: true,
          metaLive: { present: true, verifiedAt: '2026-07-10T08:00:00.000Z', expiresAt: '2026-07-11T08:00:00.000Z' },
          metaResources: { present: true, verifiedAt: '2026-07-10T08:05:00.000Z', expiresAt: '2026-07-11T08:05:00.000Z' },
        },
      },
    }
  }

  return { range, usage, data: {} }
}

function handleApi(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'content-type',
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
  if (url.pathname === '/api/test/admin-attribution-readiness' && req.method === 'PATCH') {
    readJsonBody(req)
      .then((body) => {
        adminAttributionReadinessBlocked = body.blocked !== false
        json(res, { ok: true, blocked: adminAttributionReadinessBlocked })
      })
      .catch(() => json(res, { statusCode: 400, message: '归因 readiness 测试请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/test/admin-attribution-requests') {
    return json(res, { requests: adminAttributionRequests })
  }
  if (url.pathname === '/api/test/admin-attribution-requests/clear' && req.method === 'POST') {
    adminAttributionRequests.length = 0
    return json(res, { ok: true })
  }
  if (url.pathname === '/api/test/admin-attribution-actions') {
    return json(res, { actions: adminAttributionActions })
  }
  if (url.pathname === '/api/test/admin-attribution-rollout-scenario' && req.method === 'PATCH') {
    readJsonBody(req).then((body) => {
      adminAttributionRolloutScenario = String(body.scenario || 'hard')
      adminAttributionRolloutTarget = Number(body.target ?? 10)
      adminAttributionIncidentOpen = adminAttributionRolloutScenario === 'hard'
      json(res, { ok: true, scenario: adminAttributionRolloutScenario })
    }).catch(() => json(res, { statusCode: 400, message: 'rollout 场景无效' }, 400))
    return
  }
  if (url.pathname === '/api/test/admin-attribution-dataset-scenario' && req.method === 'PATCH') {
    readJsonBody(req).then((body) => {
      adminAttributionDatasetScenario = String(body.scenario || 'unavailable')
      json(res, { ok: true, scenario: adminAttributionDatasetScenario })
    }).catch(() => json(res, { statusCode: 400, message: 'Dataset 场景无效' }, 400))
    return
  }
  if (url.pathname === '/api/test/admin-attribution-action-mode' && req.method === 'PATCH') {
    readJsonBody(req).then((body) => {
      adminAttributionActionMode = String(body.mode || 'success')
      json(res, { ok: true, mode: adminAttributionActionMode })
    }).catch(() => json(res, { statusCode: 400, message: '测试模式请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/test/admin-attribution-environment' && req.method === 'PATCH') {
    readJsonBody(req).then((body) => {
      adminAttributionEnvironment = body.environment === 'production' ? 'production' : 'dev'
      json(res, { ok: true, environment: adminAttributionEnvironment })
    }).catch(() => json(res, { statusCode: 400, message: '归因环境无效' }, 400))
    return
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
  if (url.pathname === '/api/test/auth' && req.method === 'PATCH') {
    readJsonBody(req)
      .then((body) => {
        authenticated = body.authenticated !== false
        json(res, { ok: true, authenticated })
      })
      .catch(() => json(res, { statusCode: 400, message: '认证状态请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/test/marketing-consent-state' && req.method === 'PATCH') {
    readJsonBody(req)
      .then((body) => {
        marketingConsentState = body.state === 'granted' || body.state === 'denied' ? body.state : 'limited'
        json(res, { state: marketingConsentState })
      })
      .catch(() => json(res, { statusCode: 400, message: '营销授权测试状态无效' }, 400))
    return
  }
  if (url.pathname === '/api/settings/public') return json(res, publicSettings())
  if (url.pathname === '/api/marketing-consent' && req.method === 'GET') {
    return json(res, { state: marketingConsentState })
  }
  if (url.pathname === '/api/marketing-consent' && req.method === 'PUT') {
    readJsonBody(req)
      .then((body) => {
        if (body.state !== 'granted' && body.state !== 'denied') {
          json(res, { code: 'MARKETING_CONSENT_INVALID', message: '营销授权状态无效' }, 400)
          return
        }
        marketingConsentState = body.state
        json(res, { state: marketingConsentState }, 200, {
          'Set-Cookie': `mei_marketing_consent_receipt=mock-${marketingConsentState}; Path=/; HttpOnly; SameSite=Lax`,
        })
      })
      .catch(() => json(res, { code: 'MARKETING_CONSENT_INVALID', message: '营销授权请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/me') {
    receiptProtectedRequests.push({ endpoint: '/api/me', cookie: req.headers.cookie || '' })
    return authenticated
      ? json(res, user)
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
        json(res, {
          ...user,
          id: 22,
          email: body.email || 'new-user@example.test',
          username: body.username || 'newuser',
          role: 'user',
          membershipRank: 0,
          membershipName: 'free',
          pixelEvents: [{
            deliveryId: 'cdlv_registration_22',
            eventName: 'CompleteRegistration',
            eventId: 'meta:CompleteRegistration:complete_registration:user:22',
            payload: { method: 'email' },
            receiptToken: 'receipt_registration_22',
          }],
        }, 200, {
          'Set-Cookie': 'mei_session=mock-session; Path=/; HttpOnly; SameSite=Lax',
        })
      })
      .catch(() => json(res, { statusCode: 400, message: '注册请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/conversions/events' && req.method === 'POST') {
    receiptProtectedRequests.push({ endpoint: '/api/conversions/events', cookie: req.headers.cookie || '' })
    return json(res, { data: { pixelEvents: [] } })
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
      totalGalleries: 4,
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
  if (url.pathname === '/api/admin/attribution/meta/test-event' && req.method === 'POST') {
    if (adminAttributionActionMode === 'conflict') {
      return json(res, {
        statusCode: 409,
        message: 'production 资源验证尚未通过',
        code: 'META_TEST_EVENT_BOOTSTRAP_BLOCKED',
        detail: { blockers: ['meta_resources_verification_missing'] },
      }, 409)
    }
    return json(res, {
      data: {
        status: 'verified',
        eventsReceived: 1,
        connection: {
          state: 'verified',
          environment: adminAttributionEnvironment,
          pixelIdConfigured: true,
          tokenConfigured: true,
          testEventCodeConfigured: true,
          verifiedAt: '2026-07-09T09:30:00.000Z',
          verifiedCommit: 'a'.repeat(40),
          graphApiVersion: 'v25.0',
          datasetQualityStatus: 'not_checked',
          invalidationReason: '',
        },
      },
    })
  }
  if (url.pathname === '/api/admin/attribution/meta/live-challenge' && req.method === 'POST') {
    return json(res, {
      data: {
        challengeId: `mlc_${'c'.repeat(32)}`,
        environment: 'dev',
        commitSha: 'a'.repeat(40),
        pixelId: '1234567890',
        expiresAt: '2026-07-11T01:00:00.000Z',
        eventIds: {
          Contact: `mlv_contact_${'a'.repeat(32)}`,
          CompleteRegistration: `mlv_registration_${'b'.repeat(32)}`,
        },
      },
    })
  }
  if (url.pathname === '/api/admin/attribution/meta/live-challenge/consume' && req.method === 'POST') {
    return json(res, { data: { status: 'server_sent', eventsReceived: 2 } })
  }
  if (url.pathname === '/api/admin/attribution/meta/rollout' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      adminAttributionActions.push({ type: 'rollout', body })
      const percentage = Number(body.percentage)
      const upgrading = percentage > adminAttributionRolloutTarget
      const blockers = adminAttributionIncidentOpen ? ['circuit_open'] : ['insufficient_attempts']
      if (upgrading && adminAttributionIncidentOpen) {
        return json(res, { statusCode: 409, message: 'CAPI rollout 升级门禁未通过', code: 'META_CAPI_ROLLOUT_PROMOTION_BLOCKED', detail: { blockers } }, 409)
      }
      if (upgrading && adminAttributionRolloutScenario === 'metric-only' && body.force !== true) {
        return json(res, { statusCode: 409, message: 'CAPI rollout 升级门禁未通过', code: 'META_CAPI_ROLLOUT_PROMOTION_BLOCKED', detail: { blockers } }, 409)
      }
      if (body.force === true) {
        const hanCount = String(body.reason || '').match(/[\u3400-\u9fff]/g)?.length ?? 0
        if (!upgrading || adminAttributionRolloutScenario !== 'metric-only') return json(res, { statusCode: 400, message: '当前升级不能 force', code: 'META_CAPI_ROLLOUT_FORCE_NOT_APPLICABLE' }, 400)
        if (hanCount < 20) return json(res, { statusCode: 400, message: 'force 理由至少需要 20 个汉字', code: 'META_CAPI_ROLLOUT_FORCE_REASON_INVALID' }, 400)
      }
      if (adminAttributionActionMode === 'conflict') return json(res, { statusCode: 409, message: 'CAPI rollout 升级门禁未通过' }, 409)
      if (adminAttributionActionMode === 'forbidden') return json(res, { statusCode: 403, message: '需要站长权限' }, 403)
      if (adminAttributionActionMode === 'network') return json(res, { statusCode: 503, message: '服务暂时不可用' }, 503)
      adminAttributionRolloutTarget = percentage
      json(res, { data: { targetPercentage: adminAttributionRolloutTarget, effectivePercentage: adminAttributionIncidentOpen ? 0 : adminAttributionRolloutTarget, changed: true } })
    }).catch(() => json(res, { statusCode: 400, message: 'rollout 请求无效' }, 400))
    return
  }
  if (/^\/api\/admin\/attribution\/meta\/incidents\/[^/]+\/close$/.test(url.pathname) && req.method === 'POST') {
    readJsonBody(req).then(() => {
      if (adminAttributionActionMode === 'conflict') return json(res, { statusCode: 409, message: 'incident 关闭门禁未通过' }, 409)
      if (adminAttributionActionMode === 'forbidden') return json(res, { statusCode: 403, message: '需要站长权限' }, 403)
      if (adminAttributionActionMode === 'network') return json(res, { statusCode: 503, message: '服务暂时不可用' }, 503)
      adminAttributionIncidentOpen = false
      json(res, { data: { id: 'incident-1', status: 'closed' } })
    }).catch(() => json(res, { statusCode: 400, message: 'incident 请求无效' }, 400))
    return
  }
  if (url.pathname.startsWith('/api/admin/attribution/')) {
    adminAttributionRequests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams.entries()) })
    return json(res, adminAttributionResponse(url.pathname, url.searchParams))
  }
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

const server = createServer(handleApi)

server.listen(port, host, () => {
  console.log(`Playwright mock API listening on http://${host}:${port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
