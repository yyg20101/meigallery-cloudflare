export interface JsonLdScript {
  type: 'application/ld+json'
  innerHTML: string
}

interface WebSiteJsonLdInput {
  siteUrl: string
  siteName: string
  description?: string | null
  logoUrl?: string | null
}

interface ImageGalleryJsonLdInput {
  siteUrl: string
  path: string
  title: string
  description?: string | null
  imageUrls?: Array<string | null | undefined>
  datePublished?: string | null
  keywords?: string[]
}

interface ArticleJsonLdInput {
  siteUrl: string
  path: string
  siteName: string
  title: string
  description?: string | null
  imageUrls?: Array<string | null | undefined>
  datePublished?: string | null
  logoUrl?: string | null
}

const DEFAULT_SITE_URL = 'https://616618.xyz'
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mg_source',
])
const CANONICAL_QUERY_KEYS = new Set(['tag', 'sort', 'q'])

export function normalizeSeoSiteUrl(value: unknown) {
  try {
    const url = new URL(String(value || DEFAULT_SITE_URL))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_SITE_URL
    return url.origin
  } catch {
    return DEFAULT_SITE_URL
  }
}

export function buildCanonicalUrl(siteUrl: string, path: string) {
  const origin = normalizeSeoSiteUrl(siteUrl)
  const source = parseUrl(path || '/', origin)
  const canonical = new URL(source.pathname || '/', origin)

  for (const [key, value] of source.searchParams.entries()) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey.startsWith('utm_') || TRACKING_PARAMS.has(normalizedKey)) continue
    if (!CANONICAL_QUERY_KEYS.has(normalizedKey)) continue
    canonical.searchParams.append(key, value)
  }

  return canonical.toString()
}

export function buildAbsoluteSeoUrl(siteUrl: string, value?: string | null) {
  if (!value?.trim()) return ''

  const origin = normalizeSeoSiteUrl(siteUrl)
  try {
    const url = new URL(value.trim(), origin)
    if (url.protocol !== 'https:' && url.origin !== origin) return ''
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

export function buildJsonLdScript(data: Record<string, unknown>): JsonLdScript {
  return {
    type: 'application/ld+json',
    innerHTML: JSON.stringify(data)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029'),
  }
}

export function buildWebSiteJsonLd(input: WebSiteJsonLdInput) {
  const siteUrl = normalizeSeoSiteUrl(input.siteUrl)
  const siteName = cleanText(input.siteName) || '图库站'
  const description = cleanText(input.description)
  const logo = buildAbsoluteSeoUrl(siteUrl, input.logoUrl)

  return removeEmpty({
    '@context': 'https://schema.org',
    '@graph': [
      removeEmpty({
        '@type': 'WebSite',
        name: siteName,
        url: `${siteUrl}/`,
        description,
        inLanguage: 'zh-CN',
        potentialAction: {
          '@type': 'SearchAction',
          target: `${siteUrl}/search?q={search_term_string}`,
          'query-input': 'required name=search_term_string',
        },
      }),
      removeEmpty({
        '@type': 'Organization',
        name: siteName,
        url: `${siteUrl}/`,
        logo,
      }),
    ],
  })
}

export function buildImageGalleryJsonLd(input: ImageGalleryJsonLdInput) {
  const siteUrl = normalizeSeoSiteUrl(input.siteUrl)
  const url = buildCanonicalUrl(siteUrl, input.path)
  const title = cleanText(input.title)
  const description = cleanText(input.description)
  const image = collectImageUrls(siteUrl, input.imageUrls)
  const datePublished = normalizeDate(input.datePublished)
  const keywords = cleanKeywords(input.keywords)

  return removeEmpty({
    '@context': 'https://schema.org',
    '@type': 'ImageGallery',
    name: title,
    headline: title,
    description,
    url,
    mainEntityOfPage: url,
    inLanguage: 'zh-CN',
    datePublished,
    keywords,
    image,
  })
}

export function buildArticleJsonLd(input: ArticleJsonLdInput) {
  const siteUrl = normalizeSeoSiteUrl(input.siteUrl)
  const siteName = cleanText(input.siteName) || '图库站'
  const url = buildCanonicalUrl(siteUrl, input.path)
  const title = cleanText(input.title)
  const description = cleanText(input.description)
  const image = collectImageUrls(siteUrl, input.imageUrls)
  const datePublished = normalizeDate(input.datePublished)
  const logo = buildAbsoluteSeoUrl(siteUrl, input.logoUrl)

  return removeEmpty({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    url,
    mainEntityOfPage: url,
    inLanguage: 'zh-CN',
    datePublished,
    image,
    author: {
      '@type': 'Organization',
      name: siteName,
    },
    publisher: removeEmpty({
      '@type': 'Organization',
      name: siteName,
      logo,
    }),
  })
}

function parseUrl(value: string, origin: string) {
  try {
    return new URL(value, origin)
  } catch {
    return new URL('/', origin)
  }
}

function cleanText(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

function cleanKeywords(value: string[] | undefined) {
  const keywords = [...new Set((value ?? []).map(cleanText).filter(Boolean))]
  return keywords.length ? keywords.join(', ') : ''
}

function normalizeDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

function collectImageUrls(siteUrl: string, values?: Array<string | null | undefined>) {
  const urls = [...new Set((values ?? []).map(value => buildAbsoluteSeoUrl(siteUrl, value)).filter(Boolean))]
  return urls.length ? urls : undefined
}

function removeEmpty<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false
      if (Array.isArray(value) && value.length === 0) return false
      return true
    }),
  ) as T
}
