interface ListResponse<T> {
  data: T[]
  total?: number
  hasMore?: boolean
}

interface GallerySitemapItem {
  slug: string
  publishedAt?: string | null
}

interface CaseSitemapItem {
  slug: string
  publishedAt?: string | null
}

interface TagSitemapItem {
  slug: string
}

interface SitemapEntry {
  loc: string
  lastmod?: string
  changefreq: 'daily' | 'weekly' | 'monthly'
  priority: string
}

const PAGE_SIZE = 100
const MAX_PAGES = 20

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const siteUrl = normalizeSiteUrl(config.public.siteUrl)
  const apiBaseUrl = normalizeBaseUrl(config.public.apiBaseUrl)
  const isProduction = config.public.appEnv === 'production'

  setHeader(event, 'Content-Type', 'application/xml; charset=utf-8')
  setHeader(event, 'Cache-Control', isProduction ? 'public, max-age=900, stale-while-revalidate=3600' : 'no-store')

  if (!isProduction) {
    return xml([
      { loc: `${siteUrl}/`, changefreq: 'daily', priority: '1.0' },
    ])
  }

  const [galleries, cases, tags] = await Promise.all([
    fetchPaginated<GallerySitemapItem>(apiBaseUrl, '/api/galleries', { sort: 'newest' }),
    fetchPaginated<CaseSitemapItem>(apiBaseUrl, '/api/cases', { sort: 'sort' }),
    fetchTags(apiBaseUrl),
  ])

  const entries: SitemapEntry[] = [
    { loc: `${siteUrl}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${siteUrl}/discover`, changefreq: 'daily', priority: '0.9' },
    { loc: `${siteUrl}/cases`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${siteUrl}/tags`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${siteUrl}/rules`, changefreq: 'monthly', priority: '0.4' },
    ...galleries.map(item => ({
      loc: `${siteUrl}/gallery/${encodeURIComponent(item.slug)}`,
      lastmod: normalizeLastmod(item.publishedAt),
      changefreq: 'weekly' as const,
      priority: '0.8',
    })),
    ...cases.map(item => ({
      loc: `${siteUrl}/cases/${encodeURIComponent(item.slug)}`,
      lastmod: normalizeLastmod(item.publishedAt),
      changefreq: 'weekly' as const,
      priority: '0.7',
    })),
    ...tags.map(item => ({
      loc: `${siteUrl}/discover?tag=${encodeURIComponent(item.slug)}`,
      changefreq: 'weekly' as const,
      priority: '0.6',
    })),
  ]

  return xml(dedupeEntries(entries))
})

async function fetchPaginated<T>(apiBaseUrl: string, path: string, params: Record<string, string>) {
  const rows: T[] = []

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(path, apiBaseUrl)
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    const payload = await $fetch<ListResponse<T>>(url.toString()).catch(() => null)
    const pageRows = Array.isArray(payload?.data) ? payload.data : []
    rows.push(...pageRows)

    if (!payload || pageRows.length < PAGE_SIZE) break
    if (typeof payload.total === 'number' && rows.length >= payload.total) break
    if (payload.hasMore === false) break
  }

  return rows
}

async function fetchTags(apiBaseUrl: string) {
  const url = new URL('/api/tags', apiBaseUrl)
  const payload = await $fetch<{ data: Record<string, TagSitemapItem[]> }>(url.toString()).catch(() => null)
  if (!payload?.data) return []
  return Object.values(payload.data).flat().filter(item => item.slug)
}

function normalizeSiteUrl(value: unknown) {
  try {
    const url = new URL(String(value || 'https://616618.xyz'))
    return url.origin
  } catch {
    return 'https://616618.xyz'
  }
}

function normalizeBaseUrl(value: unknown) {
  try {
    const url = new URL(String(value || 'https://api.616618.xyz'))
    return url.origin
  } catch {
    return 'https://api.616618.xyz'
  }
}

function normalizeLastmod(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function dedupeEntries(entries: SitemapEntry[]) {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.loc)) return false
    seen.add(entry.loc)
    return true
  })
}

function xml(entries: SitemapEntry[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(entry => [
      '  <url>',
      `    <loc>${escapeXml(entry.loc)}</loc>`,
      entry.lastmod ? `    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '',
      `    <changefreq>${entry.changefreq}</changefreq>`,
      `    <priority>${entry.priority}</priority>`,
      '  </url>',
    ].filter(Boolean).join('\n')),
    '</urlset>',
    '',
  ].join('\n')
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
