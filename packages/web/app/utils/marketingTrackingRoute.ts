import { hasSensitiveAnalyticsUrl, isAdminPath } from '~/utils/trackingSanitizer'

export function isMarketingTrackingRoute(fullPath: string) {
  let pathname: string
  try {
    pathname = new URL(fullPath, 'https://site.local').pathname
  }
  catch {
    pathname = fullPath.split(/[?#]/)[0] || fullPath
  }
  return !isAdminPath(pathname) && !hasSensitiveAnalyticsUrl(fullPath)
}
