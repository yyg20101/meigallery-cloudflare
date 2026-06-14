const DISALLOW_PATHS = [
  '/admin/',
  '/api/',
  '/login',
  '/register',
  '/forgot-password',
  '/settings',
  '/user',
]

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const siteUrl = normalizeSiteUrl(config.public.siteUrl)
  const isProduction = config.public.appEnv === 'production'

  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setHeader(event, 'Cache-Control', isProduction ? 'public, max-age=3600' : 'no-store')

  if (!isProduction) {
    return 'User-agent: *\nDisallow: /\n'
  }

  return [
    'User-agent: *',
    'Allow: /',
    ...DISALLOW_PATHS.map(path => `Disallow: ${path}`),
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n')
})

function normalizeSiteUrl(value: unknown) {
  try {
    const url = new URL(String(value || 'https://616618.xyz'))
    return url.origin
  } catch {
    return 'https://616618.xyz'
  }
}
