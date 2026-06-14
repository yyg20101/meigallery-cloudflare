import { normalizePublicSettingUrl } from './siteSettingsSecurity'

const BLOCKED_LOGIN_REDIRECT_PREFIXES = [
  '/api',
  '/_nuxt',
  '/cdn-cgi',
]
const REDIRECT_PARAM_NAMES = new Set([
  'callback',
  'continue',
  'next',
  'redirect',
  'returnto',
  'returnurl',
])

export function normalizeLoginRedirect(value: unknown) {
  if (Array.isArray(value)) return '/'

  const url = normalizePublicSettingUrl(value)
  if (!url || url.startsWith('https://')) return '/'
  if (!hasAllowedNestedRedirectParams(url, 0)) return '/'

  const pathname = new URL(url, 'https://site.local').pathname
  if (BLOCKED_LOGIN_REDIRECT_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return '/'
  }

  return url
}

function hasAllowedNestedRedirectParams(url: string, depth: number) {
  if (depth > 3) return false

  const parsed = new URL(url, 'https://site.local')
  for (const [name, target] of parsed.searchParams.entries()) {
    if (!REDIRECT_PARAM_NAMES.has(normalizeParamName(name))) continue

    const normalizedTarget = normalizePublicSettingUrl(target)
    if (!normalizedTarget || normalizedTarget.startsWith('https://')) return false
    if (isBlockedLoginRedirectPath(normalizedTarget)) return false
    if (!hasAllowedNestedRedirectParams(normalizedTarget, depth + 1)) return false
  }
  return true
}

function isBlockedLoginRedirectPath(url: string) {
  const pathname = new URL(url, 'https://site.local').pathname
  return BLOCKED_LOGIN_REDIRECT_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function normalizeParamName(name: string) {
  return name.toLowerCase().replace(/[-_]/g, '')
}
