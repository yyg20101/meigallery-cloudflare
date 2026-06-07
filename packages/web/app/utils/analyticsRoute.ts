import type { AnalyticsEntityType } from '@meigallery/shared'
import { sanitizeAnalyticsPath } from './analyticsSanitizer'

export interface AnalyticsRouteLike {
  fullPath?: string
  path?: string
  name?: string | symbol | null
  params?: Record<string, unknown>
}

export interface NormalizedAnalyticsRoute {
  skip: boolean
  routeName: string
  path: string
  entityType?: AnalyticsEntityType
  entityId?: string
}

export function normalizeAnalyticsRoute(route: AnalyticsRouteLike): NormalizedAnalyticsRoute {
  const safePath = sanitizeAnalyticsPath(route.fullPath || route.path || '/')
  if (!safePath) return { skip: true, routeName: '', path: '' }

  const pathname = safePath.split('?')[0] || '/'
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return { skip: true, routeName: '', path: '' }

  const galleryMatch = pathname.match(/^\/gallery\/([^/]+)$/)
  if (galleryMatch) {
    return {
      skip: false,
      routeName: '/gallery/:slug',
      path: safePath,
      entityType: 'gallery',
      entityId: safeEntityId(route.params?.slug ?? galleryMatch[1]),
    }
  }

  const caseMatch = pathname.match(/^\/cases\/([^/]+)$/)
  if (caseMatch) {
    return {
      skip: false,
      routeName: '/cases/:slug',
      path: safePath,
      entityType: 'case',
      entityId: safeEntityId(route.params?.slug ?? caseMatch[1]),
    }
  }

  if (pathname === '/search') return baseRoute('/search', safePath)
  if (pathname === '/discover') return baseRoute('/discover', safePath)
  if (pathname === '/register') return baseRoute('/register', safePath, 'auth')
  if (pathname === '/login') return baseRoute('/login', safePath, 'auth')
  if (pathname === '/rules') return baseRoute('/rules', safePath, 'page')
  if (pathname === '/cases') return baseRoute('/cases', safePath, 'case')
  if (pathname === '/' || pathname === '') return baseRoute('/', safePath, 'page')

  return baseRoute(pathname, safePath, 'page')
}

function baseRoute(routeName: string, path: string, entityType: AnalyticsEntityType = 'page'): NormalizedAnalyticsRoute {
  return { skip: false, routeName, path, entityType }
}

function safeEntityId(value: unknown) {
  return String(value ?? '').trim().replace(/[^\w-]/g, '').slice(0, 120)
}
