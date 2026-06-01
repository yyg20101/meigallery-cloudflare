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

function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function notFound(res) {
  json(res, { statusCode: 404, message: '测试接口不存在' }, 404)
}

function publicSettings() {
  return {
    site_name: 'MeiGallery',
    site_description: 'Playwright smoke 测试站点',
    seo_title: '测试站点标题 - 首页 SEO',
    og_title: '测试站点 OG 标题',
    og_description: '测试站点 OG 描述',
    footer_text: '测试环境',
    video_enabled: 'false',
    facebook_pixel_enabled: 'false',
    home_hero_title: '精选写真，按地区发现',
    home_hero_subtitle: '测试环境中的授权内容展示。',
    home_ad_enabled: 'true',
    home_ad_eyebrow: '本周推荐',
    home_ad_title: '会员季精选内容精选内容精选内容',
    home_ad_summary: '探索本周精选图库、真实案例和会员可访问内容，保持文案可读、不过度堆叠并适配多断点预览。',
    home_ad_cta_label: '查看推荐',
    home_ad_url: '/discover?sort=hot',
    home_ad_sponsor: 'MeiGallery 运营推荐',
    rules_entry_enabled: 'false',
  }
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

function handleApi(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    })
    res.end()
    return
  }

  if (url.pathname === '/api/health') return json(res, { ok: true })
  if (url.pathname === '/api/settings/public') return json(res, publicSettings())
  if (url.pathname === '/api/me') return json(res, user)
  if (url.pathname === '/api/contact-methods') return json(res, { data: [] })
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
