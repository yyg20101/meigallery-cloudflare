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
const conversionRequests = []
const browserAttemptReceipts = []
let authenticated = true
let sessionCookieRequired = false
let marketingConsentState = 'granted'
let currentAttributionProvider = null
let currentAttributionResolution = 'none'
let adminAnalyticsEmpty = false
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
  conversionRequests.length = 0
  browserAttemptReceipts.length = 0
  authenticated = true
  sessionCookieRequired = false
  marketingConsentState = 'granted'
  currentAttributionProvider = null
  currentAttributionResolution = 'none'
  adminAnalyticsEmpty = false
  adminAttributionRequests.length = 0
  adminAttributionActions.length = 0
}

function json(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type',
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

const attributionBrowserConfigs = {
  meta: { provider: 'meta', pixelId: '1234567890' },
  tiktok: { provider: 'tiktok', pixelCode: 'C123456789ABCDEF' },
  google: { provider: 'google', tagId: 'AW-123456789' },
}

function attributionBrowserInstruction(provider, canonicalEvent) {
  const eventSlug = canonicalEvent === 'Contact' ? 'contact' : 'registration'
  const browserDestination = provider === 'google'
    ? `AW-123456789/${eventSlug}`
    : `${provider}_pixel`
  return {
    deliveryId: `delivery_${provider}_${eventSlug}`,
    provider,
    canonicalEvent,
    externalEventId: `e2e_${provider}_${eventSlug}`,
    receiptToken: `v1.${'a'.repeat(16)}.${'b'.repeat(43)}`,
    descriptor: {
      provider,
      canonicalEvent,
      browserEventName: provider === 'google' ? 'conversion' : canonicalEvent,
      browserDestination,
      serverDestination: `${provider}_events_api`,
    },
    payload: { test_case: 'platform_isolation' },
  }
}

function resolvedTrackingInstructions(canonicalEvent, attribution) {
  if (marketingConsentState !== 'granted'
    || currentAttributionResolution !== 'matched'
    || !currentAttributionProvider
    || attribution?.consentState !== 'granted'
    || attribution?.adAttributionState !== 'resolved') return []
  return [attributionBrowserInstruction(currentAttributionProvider, canonicalEvent)]
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

function adminAttributionResponse(pathname, searchParams) {
  const range = analyticsRange(searchParams)
  const requestedProvider = searchParams.get('provider')
  const provider = ['meta', 'tiktok', 'google'].includes(requestedProvider) ? requestedProvider : 'meta'
  const usage = { rowsRead: 86, rowsWritten: 0, durationMs: 9 }
  const links = [
    {
      id: 'ats_meta_a',
      name: 'Meta 广告 A',
      sourceLabel: 'Meta 广告 A',
      channel: 'ad',
      slug: 'meta-ad-a',
      sourceCode: 'meta-ad-a',
      adProvider: 'meta',
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
  const deliveryMetrics = (index = 0) => ({
    browserAttempted: index + 3,
    server: {
      planned: 0,
      queued: index === 2 ? 1 : 0,
      accepted: index + 1,
      processed: 1,
      retrying: 0,
      rejected: index === 1 ? 1 : 0,
      deadLetter: 0,
      cancelled: 0,
    },
    queueRetryCount: index === 1 ? 1 : 0,
    queueEnqueueCount: index + 2,
  })
  const trendRows = dates.map((date, index) => ({
    date,
    business: { contactCount: index + 1, completeRegistrationCount: index, factCount: index * 2 + 1 },
    delivery: deliveryMetrics(index),
  }))

  if (pathname.endsWith('/summary')) {
    return {
      range,
      usage,
      data: {
        provider,
        business: { contactCount: 6, completeRegistrationCount: 3, factCount: 9 },
        delivery: {
          browserAttempted: 12,
          server: { planned: 0, queued: 1, accepted: 6, processed: 3, retrying: 0, rejected: 1, deadLetter: 0, cancelled: 0 },
          queueRetryCount: 2,
          queueEnqueueCount: 10,
        },
        routing: {
          totalFactCount: 12,
          attributedFactCount: 9,
          unattributedFactCount: 2,
          conflictFactCount: 1,
          byProvider: { meta: 5, tiktok: 3, google: 1 },
        },
      },
    }
  }
  if (pathname.endsWith('/trends')) return { range, usage, data: { provider, granularity: 'day', rows: trendRows } }
  if (pathname.endsWith('/quality')) {
    const metric = (numerator, denominator) => ({ availability: denominator ? 'available' : 'unavailable', numerator, denominator, rate: denominator ? numerator / denominator : null })
    const qualityRow = {
      date: dates.at(-1),
      canonicalEvent: 'Contact',
      metricKey: 'event_match_quality',
      value: 0.86,
      availability: 'available',
      status: 'available',
      errorCategory: '',
      collectedAt: `${dates.at(-1)}T09:30:00.000Z`,
    }
    return {
      range,
      usage,
      data: {
        provider,
        pairing: {
          summary: metric(8, 9),
          rows: dates.map((date, index) => ({ date, ...metric(index + 1, index + 2) })),
        },
        match: {
          summary: metric(8, 9),
          signals: [
            { key: provider === 'meta' ? 'fbp' : provider === 'tiktok' ? 'ttp' : 'gclid', ...metric(8, 9) },
            { key: 'external_id', ...metric(7, 9) },
          ],
          rows: dates.map((date, index) => ({ date, ...metric(index + 1, index + 2) })),
        },
        platformQuality: { availability: 'available', latest: qualityRow, rows: [qualityRow] },
      },
    }
  }
  if (pathname.endsWith('/breakdown')) return { range, usage, data: { provider, dimension: searchParams.get('dimension') || 'utm_campaign', rows: [{ value: 'july-contact', factCount: 6, contactCount: 4, completeRegistrationCount: 2, delivery: deliveryMetrics(2) }] } }
  if (pathname.endsWith('/capacity')) {
    const capacityMetric = (value, safetyLimit) => ({ value, safetyLimit, ratio: value / safetyLimit, warning: value >= safetyLimit })
    return {
      usage,
      data: {
        date: searchParams.get('date') || dates.at(-1),
        timeZone: 'Asia/Shanghai',
        note: '项目内部估算，不代表 Cloudflare 官方账单。',
        inputs: { factCount: 9, deliveryCount: 21, browserAttemptCount: 12, serverDeliveryCount: 9, adapterAttemptCount: 9, queueAttemptCount: 10, terminalServerDeliveryCount: 8, providerReceiptCount: 20, workflowStepCount: 3 },
        metrics: {
          workerRequests: capacityMetric(120, 70_000),
          queueOperations: capacityMetric(30, 7_000),
          d1RowsRead: capacityMetric(860, 3_500_000),
          d1RowsWritten: capacityMetric(90, 70_000),
          workflowSteps: capacityMetric(3, 2_100),
          serverConversions: capacityMetric(9, 2_000),
        },
      },
    }
  }
  if (pathname.endsWith('/platforms')) return { data: ['meta', 'tiktok', 'google'].map(platformConnection) }

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
        provider,
        byAction: [
          { action_type: 'contact', action_count: 4, unique_session_count: 4 },
          { action_type: 'complete_registration', action_count: 2, unique_session_count: 2 },
        ],
        bySource: [
          { source_channel: 'ad', source_name: `${provider}-ad-a`, utm_campaign: 'july-contact', utm_content: 'chat-a', contact_count: 4, complete_registration_count: 2 },
        ],
        samples: [
          { id: 'conv_1', action_type: 'contact', occurred_at: '2026-07-09T09:10:00.000Z', source_channel: 'ad', source_name: `${provider}-ad-a`, tracking_source_slug: `${provider}-ad-a`, utm_campaign: 'july-contact', utm_content: 'chat-a', method_type: 'telegram', action_target: 'floating_contact_panel', route_name: 'gallery-detail', path: '/gallery/summer-portrait', duplicate_of: '', attribution_provider: provider },
        ],
      },
    }
  }

  if (pathname.endsWith('/links')) return { range, usage, data: { provider, links: links.filter(link => link.adProvider === provider) } }

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
          { provider: 'meta', transport: 'browser', event_name: 'Contact', status: 'attempted', skip_reason: '', delivery_count: 8 },
          { provider: 'meta', transport: 'server', event_name: 'Contact', status: 'sent', skip_reason: '', delivery_count: 6 },
          { provider: 'meta', transport: 'server', event_name: 'CompleteRegistration', status: 'failed', skip_reason: 'retry_exhausted', delivery_count: 2 },
          { provider: 'meta', transport: 'server', event_name: 'Contact', status: 'skipped', skip_reason: 'queue_not_configured', delivery_count: 1 },
        ],
        lastSentAt: '2026-07-09T09:30:00.000Z',
        queueBindingPresent: true,
        connection: {
          state: 'unverified',
          environment: 'production',
          pixelIdConfigured: true,
          tokenConfigured: true,
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
          enabled: true,
          browser_enabled: true,
          server_enabled: false,
          mode: 'test',
        },
      },
    }
  }

  if (pathname.endsWith('/duplicates')) {
    return {
      range,
      usage,
      data: {
        provider,
        duplicateSuppressedCount: 1,
        duplicateActionCount: 1,
        duplicateRate: 0.125,
        samples: [
          { id: 'convdup_1', action_type: 'contact', occurred_at: '2026-07-09T09:11:00.000Z', source_channel: 'ad', source_name: `${provider}-ad-a`, tracking_source_slug: `${provider}-ad-a`, utm_campaign: 'july-contact', utm_content: 'chat-a', method_type: 'telegram', action_target: 'floating_contact_panel', duplicate_of: 'conv_1', attribution_provider: provider },
        ],
      },
    }
  }

  return { range, usage, data: {} }
}

function platformConnection(provider) {
  const configs = {
    meta: { provider: 'meta', pixelId: '123456789012345' },
    tiktok: { provider: 'tiktok', pixelCode: 'C123456789ABCDEF' },
    google: { provider: 'google', tagId: 'AW-123456789', customerId: '1234567890', cloudProjectId: 'meigallery-ads' },
  }
  const destinations = {
    meta: [['meta_pixel', 'meta_capi'], ['meta_pixel', 'meta_capi']],
    tiktok: [['tiktok_pixel', 'tiktok_events_api'], ['tiktok_pixel', 'tiktok_events_api']],
    google: [['AW-123456789/ContactLabel', '1234567890'], ['AW-123456789/RegisterLabel', '1234567891']],
  }
  const credentialTypes = { meta: 'access_token', tiktok: 'access_token', google: 'service_account_json' }
  return {
    connectionId: `conn_${provider}`,
    provider,
    enabled: true,
    mode: 'production',
    browserEnabled: true,
    serverEnabled: true,
    publicConfig: configs[provider],
    eventBindings: ['Contact', 'CompleteRegistration'].map((canonicalEvent, index) => ({
      canonicalEvent,
      enabled: true,
      browserDestination: destinations[provider][index][0],
      serverDestination: destinations[provider][index][1],
    })),
    rolloutTargetPercentage: 10,
    rolloutEffectivePercentage: 10,
    connectionRevision: `connection_revision_${provider}`,
    credential: { configured: true, type: credentialTypes[provider], revision: `credential_revision_${provider}` },
  }
}

function platformVerification(provider, attempt = 1) {
  return {
    id: `verify:${provider}:connection_revision_${provider}:${attempt}`,
    provider,
    connectionRevision: `connection_revision_${provider}`,
    credentialRevision: `credential_revision_${provider}`,
    attempt,
    status: 'awaiting_human_evidence',
    evidence: { automatic: { received: true } },
    startedAt: '2026-07-15T08:00:00.000Z',
    completedAt: '',
    updatedAt: '2026-07-15T08:01:00.000Z',
  }
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
  if (url.pathname === '/api/test/analytics-events') {
    return json(res, {
      batches: analyticsBatches,
      sessionEnds: sessionEndBatches,
      registrations,
      receiptProtectedRequests,
      events: analyticsBatches.flatMap(batch => Array.isArray(batch.events) ? batch.events : []),
    })
  }
  if (url.pathname === '/api/test/ad-attribution-events') {
    return json(res, {
      provider: currentAttributionProvider,
      resolution: currentAttributionResolution,
      conversions: conversionRequests,
      browserAttempts: browserAttemptReceipts,
      registrations,
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
  if (url.pathname === '/api/ad-attribution' && req.method === 'PUT') {
    readJsonBody(req)
      .then((body) => {
        const providers = [
          Boolean(String(body.fbclid || '').trim()) && 'meta',
          Boolean(String(body.ttclid || '').trim()) && 'tiktok',
          Boolean(String(body.gclid || body.gbraid || body.wbraid || '').trim()) && 'google',
        ].filter(Boolean)
        const provider = providers.length === 1 ? providers[0] : null
        currentAttributionProvider = provider
        currentAttributionResolution = providers.length > 1 ? 'conflict' : provider ? 'matched' : 'none'
        json(res, {
          provider,
          resolution: currentAttributionResolution,
          expiresInSeconds: 1_800,
        })
      })
      .catch(() => json(res, { statusCode: 400, message: '广告来源请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/ad-attribution/bootstrap' && req.method === 'GET') {
    const publicConfig = currentAttributionProvider ? attributionBrowserConfigs[currentAttributionProvider] : null
    return json(res, { provider: currentAttributionProvider, publicConfig })
  }
  if (url.pathname === '/api/ad-attribution' && req.method === 'DELETE') {
    currentAttributionProvider = null
    currentAttributionResolution = 'none'
    return json(res, { provider: null, resolution: 'none', expiresInSeconds: 1_800 })
  }
  if (url.pathname === '/api/marketing-consent' && req.method === 'GET') {
    return json(res, marketingConsentResponse())
  }
  if (url.pathname === '/api/marketing-consent' && req.method === 'PUT') {
    readJsonBody(req)
      .then((body) => {
        if (body.state !== 'granted' && body.state !== 'denied') {
          json(res, { code: 'MARKETING_CONSENT_INVALID', message: '营销授权状态无效' }, 400)
          return
        }
        marketingConsentState = body.state
        json(res, marketingConsentResponse(), 200, {
          'Set-Cookie': `mei_marketing_consent_receipt=mock-${marketingConsentState}; Path=/; HttpOnly; SameSite=Lax`,
        })
      })
      .catch(() => json(res, { code: 'MARKETING_CONSENT_INVALID', message: '营销授权请求无效' }, 400))
    return
  }
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
          trackingInstructions: resolvedTrackingInstructions('CompleteRegistration', body.attribution),
        }, 200, {
          'Set-Cookie': 'mei_session=mock-session; Path=/; HttpOnly; SameSite=Lax',
        })
      })
      .catch(() => json(res, { statusCode: 400, message: '注册请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/conversions/events' && req.method === 'POST') {
    receiptProtectedRequests.push({ endpoint: '/api/conversions/events', cookie: req.headers.cookie || '' })
    readJsonBody(req)
      .then((body) => {
        conversionRequests.push(body)
        json(res, {
          data: {
            id: `fact_contact_${conversionRequests.length}`,
            created: true,
            trackingInstructions: resolvedTrackingInstructions('Contact', body),
          },
        })
      })
      .catch(() => json(res, { statusCode: 400, message: '转化事件请求无效' }, 400))
    return
  }
  if (url.pathname === '/api/conversions/browser-attempt' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        browserAttemptReceipts.push(body)
        json(res, { accepted: true })
      })
      .catch(() => json(res, { statusCode: 400, message: '浏览器投递回执无效' }, 400))
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
  const platformConnectionMatch = url.pathname.match(/^\/api\/admin\/attribution\/platforms\/(meta|tiktok|google)$/)
  if (platformConnectionMatch && req.method === 'PATCH') {
    readJsonBody(req)
      .then(body => {
        adminAttributionActions.push({ type: 'save_connection', provider: platformConnectionMatch[1], body })
        json(res, { data: platformConnection(platformConnectionMatch[1]) })
      })
      .catch(() => json(res, { statusCode: 400, message: '连接配置请求无效' }, 400))
    return
  }
  const platformVerificationMatch = url.pathname.match(/^\/api\/admin\/attribution\/platforms\/(meta|tiktok|google)\/(verify|reverify|verification)$/)
  if (platformVerificationMatch) {
    const provider = platformVerificationMatch[1]
    const action = platformVerificationMatch[2]
    if (req.method === 'GET' && action === 'verification') return json(res, { data: platformVerification(provider) })
    if (req.method === 'POST' && (action === 'verify' || action === 'reverify')) {
      readJsonBody(req).then((body) => {
        adminAttributionActions.push({ type: action, provider, body })
        json(res, { data: platformVerification(provider, action === 'reverify' ? 2 : 1) }, 202)
      }).catch(() => json(res, { statusCode: 400, message: '验证请求无效' }, 400))
      return
    }
  }
  const platformVerificationRecordMatch = url.pathname.match(/^\/api\/admin\/attribution\/platforms\/(meta|tiktok|google)\/verifications\/([^/]+)$/)
  if (platformVerificationRecordMatch && req.method === 'GET') {
    return json(res, { data: platformVerification(platformVerificationRecordMatch[1]) })
  }
  const platformEvidenceMatch = url.pathname.match(/^\/api\/admin\/attribution\/platforms\/(meta|tiktok|google)\/verifications\/([^/]+)\/evidence$/)
  if (platformEvidenceMatch && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      adminAttributionActions.push({ type: 'evidence', provider: platformEvidenceMatch[1], body })
      json(res, { data: platformVerification(platformEvidenceMatch[1]) }, 202)
    }).catch(() => json(res, { statusCode: 400, message: '证据请求无效' }, 400))
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

function marketingConsentResponse() {
  const requiresChoice = marketingConsentState === 'limited'
  return {
    state: marketingConsentState,
    policyMode: requiresChoice ? 'prior_consent' : 'notice_opt_out',
    decisionSource: requiresChoice ? 'choice_required' : 'explicit',
    requiresChoice,
    policyVersion: 1,
  }
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
