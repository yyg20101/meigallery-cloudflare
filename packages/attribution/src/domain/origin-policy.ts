import type { AttributionAppEnvironment } from '../env'

const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
])

export function isAllowedAttributionOrigin(
  url: URL,
  appEnvironment: AttributionAppEnvironment,
): boolean {
  if (url.protocol === 'https:') return true
  return appEnvironment !== 'production'
    && url.protocol === 'http:'
    && LOOPBACK_HOSTNAMES.has(url.hostname)
}
