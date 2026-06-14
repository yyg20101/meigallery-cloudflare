#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const DEFAULT_API_URL = 'https://api.616618.xyz'
const DEFAULT_WEB_URLS = ['https://616618.xyz', 'https://www.616618.xyz']
const DEFAULT_SITE_NAME = '图库站'
const OLD_DEFAULT_SITE_NAME = 'MeiGallery'
const OLD_DEFAULT_TITLE = 'MeiGallery - 精选写真图库'

if (isCliEntry()) {
  try {
    await main()
  } catch (error) {
    console.error(`生产首页 SEO 校验异常：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)

  if (args.help) {
    printHelp()
    return
  }

  const apiUrl = normalizeBaseUrl(args.api || env.SEO_VERIFY_API_URL || DEFAULT_API_URL)
  const retries = numberOption(args.retries || env.SEO_VERIFY_RETRIES, 3, '重试次数')
  const retryDelayMs = numberOption(args.retryDelayMs || env.SEO_VERIFY_RETRY_DELAY_MS, 5000, '重试间隔')
  const allowDefaultSeo = args.allowDefaultSeo || booleanOption(env.SEO_VERIFY_ALLOW_DEFAULT_SEO)
  const expectations = {
    title: args.expectTitle || env.SEO_VERIFY_EXPECT_TITLE || '',
    siteName: args.expectSiteName || env.SEO_VERIFY_EXPECT_SITE_NAME || '',
    description: args.expectDescription || env.SEO_VERIFY_EXPECT_DESCRIPTION || '',
  }
  const webUrls = resolveWebUrls(args.web, env)
  const settings = await fetchJson(`${apiUrl}/api/settings/public`)
  const expected = expectedSeo(settings)
  const failures = [
    ...validateExpectedSeo(settings, expected, expectations, { allowDefaultSeo }),
    ...await verifyWithRetry(webUrls, expected, retries, retryDelayMs),
  ]

  if (failures.length > 0) {
    console.error('生产首页 SEO 校验失败：')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error('')
    console.error('提示：若 /api/settings/public 未返回后台新值，请确认 API Worker 已部署包含站点设置 upsert 的版本，并在后台重新保存站点设置；若 API 已是新值但首页 <head> 仍为旧值，请确认 Web Worker 已部署到最新版本。')
    process.exit(1)
  }

  console.log('生产首页 SEO 校验通过：')
  console.log(`- API: ${apiUrl}/api/settings/public`)
  for (const webUrl of webUrls) console.log(`- Web: ${webUrl}/`)
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

function resolveWebUrls(argWebUrls, env = process.env) {
  const webUrls = (argWebUrls.length > 0
    ? argWebUrls
    : String(env.SEO_VERIFY_WEB_URLS || '')
        .split(',')
        .map(url => url.trim())
        .filter(Boolean)
  ).map(normalizeBaseUrl)

  if (webUrls.length === 0) webUrls.push(...DEFAULT_WEB_URLS)
  return webUrls
}

function parseArgs(argv) {
  const parsed = {
    api: '',
    web: [],
    retries: '',
    retryDelayMs: '',
    expectTitle: '',
    expectSiteName: '',
    expectDescription: '',
    allowDefaultSeo: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--api') {
      parsed.api = requiredValue(argv, index, '--api')
      index += 1
    } else if (arg === '--web') {
      parsed.web.push(requiredValue(argv, index, '--web'))
      index += 1
    } else if (arg === '--retries') {
      parsed.retries = requiredValue(argv, index, '--retries')
      index += 1
    } else if (arg === '--retry-delay-ms') {
      parsed.retryDelayMs = requiredValue(argv, index, '--retry-delay-ms')
      index += 1
    } else if (arg === '--expect-title') {
      parsed.expectTitle = requiredValue(argv, index, '--expect-title')
      index += 1
    } else if (arg === '--expect-site-name') {
      parsed.expectSiteName = requiredValue(argv, index, '--expect-site-name')
      index += 1
    } else if (arg === '--expect-description') {
      parsed.expectDescription = requiredValue(argv, index, '--expect-description')
      index += 1
    } else if (arg === '--allow-default-seo') {
      parsed.allowDefaultSeo = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  return parsed
}

function requiredValue(argv, index, name) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

function printHelp() {
  console.log(`
用法：
  node scripts/verify-production-seo.mjs
  node scripts/verify-production-seo.mjs --api https://api.example.com --web https://example.com --web https://www.example.com
  node scripts/verify-production-seo.mjs --retries 6 --retry-delay-ms 10000
  node scripts/verify-production-seo.mjs --expect-site-name 星耀传媒 --expect-title 星耀传媒

环境变量：
  SEO_VERIFY_API_URL   API Worker 地址，默认 ${DEFAULT_API_URL}
  SEO_VERIFY_WEB_URLS  逗号分隔的 Web 地址，默认 ${DEFAULT_WEB_URLS.join(',')}
  SEO_VERIFY_RETRIES   失败后重试次数，默认 3
  SEO_VERIFY_RETRY_DELAY_MS  重试间隔毫秒，默认 5000
  SEO_VERIFY_EXPECT_SITE_NAME  期望公开设置中的站点名称
  SEO_VERIFY_EXPECT_TITLE      期望首页 SEO 标题
  SEO_VERIFY_EXPECT_DESCRIPTION  期望首页 description
  SEO_VERIFY_ALLOW_DEFAULT_SEO   允许生产仍使用脚手架默认 SEO，默认不允许
`.trim())
}

function numberOption(value, fallback, label) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label}必须是非负整数`)
  return number
}

function booleanOption(value) {
  return value === '1' || value === 'true' || value === 'yes'
}

function normalizeBaseUrl(url) {
  return String(url).replace(/\/+$/, '')
}

async function fetchJson(url) {
  const response = await fetch(url, noCacheInit())
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`)
  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url, noCacheInit())
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`)
  return response.text()
}

function noCacheInit() {
  return {
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  }
}

async function verifyWithRetry(webUrls, expected, retries, retryDelayMs) {
  let failures = []

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    failures = await verifyWebUrls(webUrls, expected)
    if (failures.length === 0) return []

    if (attempt < retries) {
      console.warn(`生产首页 SEO 校验第 ${attempt + 1} 次失败，${retryDelayMs}ms 后重试。`)
      await sleep(retryDelayMs)
    }
  }

  return failures
}

async function verifyWebUrls(webUrls, expected) {
  const failures = []

  for (const webUrl of webUrls) {
    const html = await fetchText(`${webUrl}/`)
    const actual = extractSeo(html)
    const result = compareSeo(webUrl, expected, actual)
    if (result.length > 0) failures.push(...result)
    failures.push(...await verifySeoFiles(webUrl))
  }

  return failures
}

async function verifySeoFiles(webUrl) {
  const [robots, sitemap] = await Promise.all([
    fetchText(`${webUrl}/robots.txt`),
    fetchText(`${webUrl}/sitemap.xml`),
  ])

  return inspectSeoFiles(webUrl, robots, sitemap)
}

function inspectSeoFiles(webUrl, robots, sitemap) {
  const failures = []

  if (!robots.includes('User-agent: *')) {
    failures.push(`${webUrl}/robots.txt 未包含 User-agent: *`)
  }
  if (!/Sitemap:\s*https:\/\/\S+\/sitemap\.xml/i.test(robots)) {
    failures.push(`${webUrl}/robots.txt 未声明 HTTPS sitemap 地址`)
  }
  if (containsLocalhostUrl(robots)) {
    failures.push(`${webUrl}/robots.txt 包含 localhost 或本地地址`)
  }

  if (!sitemap.includes('<urlset')) {
    failures.push(`${webUrl}/sitemap.xml 未包含 urlset`)
  }
  if (!/<loc>https:\/\/[^<]+<\/loc>/i.test(sitemap)) {
    failures.push(`${webUrl}/sitemap.xml 未包含 HTTPS loc`)
  }
  if (containsLocalhostUrl(sitemap)) {
    failures.push(`${webUrl}/sitemap.xml 包含 localhost 或本地地址`)
  }

  return failures
}

function containsLocalhostUrl(value) {
  return /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(value)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function expectedSeo(settings) {
  const siteName = text(settings.site_name) || DEFAULT_SITE_NAME
  const siteDescription = text(settings.site_description)
  const seoTitle = text(settings.seo_title) || siteName
  const heroSubtitle = text(settings.home_hero_subtitle)
  const ogTitle = text(settings.og_title) || seoTitle
  const ogDescription = text(settings.og_description) || siteDescription || heroSubtitle

  return {
    title: seoTitle,
    description: siteDescription || heroSubtitle,
    ogTitle,
    ogDescription,
  }
}

function extractSeo(html) {
  return {
    title: decodeHtml(extractTitle(html)),
    description: decodeHtml(extractMetaContent(html, 'name', 'description')),
    ogTitle: decodeHtml(extractMetaContent(html, 'property', 'og:title')),
    ogDescription: decodeHtml(extractMetaContent(html, 'property', 'og:description')),
    hasOldDefaultTitle: html.includes(OLD_DEFAULT_TITLE),
  }
}

function compareSeo(webUrl, expected, actual) {
  const failures = []

  compareField(failures, webUrl, 'title', expected.title, actual.title)
  compareField(failures, webUrl, 'description', expected.description, actual.description)
  compareField(failures, webUrl, 'og:title', expected.ogTitle, actual.ogTitle)
  compareField(failures, webUrl, 'og:description', expected.ogDescription, actual.ogDescription)

  if (expected.title !== OLD_DEFAULT_TITLE && actual.hasOldDefaultTitle) {
    failures.push(`${webUrl}/ 仍包含旧默认标题 "${OLD_DEFAULT_TITLE}"`)
  }

  return failures
}

function validateExpectedSeo(settings, expected, expectations, options) {
  const failures = []
  const siteName = text(settings.site_name)
  const seoTitle = text(settings.seo_title)
  const siteDescription = text(settings.site_description)

  if (!options.allowDefaultSeo) {
    if (siteName === OLD_DEFAULT_SITE_NAME) {
      failures.push(`API /api/settings/public 的 site_name 仍为脚手架默认值 "${OLD_DEFAULT_SITE_NAME}"`)
    }
    if (seoTitle === OLD_DEFAULT_TITLE || expected.title === OLD_DEFAULT_TITLE) {
      failures.push(`API /api/settings/public 的 SEO 标题仍为脚手架默认值 "${OLD_DEFAULT_TITLE}"`)
    }
  }

  compareExpectedSetting(failures, 'API /api/settings/public 的 site_name', expectations.siteName, siteName)
  compareExpectedSetting(failures, 'API /api/settings/public 解析后的首页 title', expectations.title, expected.title)
  compareExpectedSetting(failures, 'API /api/settings/public 解析后的首页 description', expectations.description, expected.description)

  if (expectations.description && siteDescription !== expectations.description) {
    failures.push(`API /api/settings/public 的 site_description 不一致，期望 "${expectations.description}"，实际 "${siteDescription}"`)
  }

  return failures
}

function compareExpectedSetting(failures, label, expected, actual) {
  if (!expected || expected === actual) return
  failures.push(`${label} 不一致，期望 "${expected}"，实际 "${actual}"`)
}

function compareField(failures, webUrl, field, expected, actual) {
  if (expected === actual) return
  failures.push(`${webUrl}/ ${field} 不一致，期望 "${expected}"，实际 "${actual}"`)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function extractTitle(html) {
  return html.match(/<title>(.*?)<\/title>/is)?.[1] || ''
}

function extractMetaContent(html, attributeName, attributeValue) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || []

  for (const tag of metaTags) {
    if (extractAttribute(tag, attributeName) === attributeValue) {
      return extractAttribute(tag, 'content')
    }
  }

  return ''
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}=["']([^"']*)["']`, 'i'))
  return match?.[1] || ''
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export {
  compareSeo,
  expectedSeo,
  extractSeo,
  inspectSeoFiles,
  parseArgs,
  resolveWebUrls,
  validateExpectedSeo,
  verifySeoFiles,
}
