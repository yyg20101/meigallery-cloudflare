import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireAuth, requireOwner } from '../../middleware/auth'
import { errorJson } from '../../utils/api-error'

export interface AdminAttributionProxyRouteOptions {
  requestId?: () => string
}

type AdminAttributionProxyEnvironment = {
  Bindings: Bindings
  Variables: Variables
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH'])
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{16,160}$/

export function createAdminAttributionProxyRoutes(
  options: AdminAttributionProxyRouteOptions = {},
) {
  const routes = new Hono<AdminAttributionProxyEnvironment>()
  const requestId = options.requestId ?? (() => crypto.randomUUID())

  routes.use('*', requireAuth)
  routes.use('*', requireOwner)

  routes.all('/*', async (c) => {
    const method = c.req.method.toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      return errorJson(c, 405, '请求方法不受支持', {
        code: 'ATTRIBUTION_ADMIN_PROXY_METHOD_NOT_ALLOWED',
      })
    }

    const relativePath = relativePathFromPublicPath(c.req.path)
    if (!relativePath) {
      return errorJson(c, 400, '归因管理路径无效', {
        code: 'ATTRIBUTION_ADMIN_PROXY_PATH_INVALID',
      })
    }

    const actorId = c.get('userId')
    if (!Number.isSafeInteger(actorId) || Number(actorId) <= 0) {
      return errorJson(c, 401, '请先登录', {
        code: 'AUTH_REQUIRED',
      })
    }

    const trustedRequestId = requestId()
    if (!REQUEST_ID_PATTERN.test(trustedRequestId)) {
      return errorJson(c, 503, '归因管理服务暂时不可用', {
        code: 'ATTRIBUTION_ADMIN_PROXY_UNAVAILABLE',
      })
    }

    let body: ArrayBuffer | undefined
    try {
      body = method === 'GET'
        ? undefined
        : await readBoundedBody(c.req.raw)
    } catch (error) {
      if (error instanceof ProxyRequestError) {
        return errorJson(c, error.status, error.message, {
          code: error.code,
        })
      }
      return unavailable(c)
    }

    const target = buildInternalUrl(
      relativePath,
      new URL(c.req.url).search,
    )
    if (!target) {
      return errorJson(c, 400, '归因管理路径无效', {
        code: 'ATTRIBUTION_ADMIN_PROXY_PATH_INVALID',
      })
    }

    const headers = forwardedHeaders(c.req.raw.headers)
    headers.set(
      ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID,
      String(actorId),
    )
    headers.set(
      ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE,
      'owner',
    )
    headers.set(
      ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID,
      trustedRequestId,
    )

    try {
      const upstream = await c.env.ATTRIBUTION.fetch(new Request(target, {
        method,
        headers,
        body,
        redirect: 'error',
      }))
      return sanitizeUpstreamResponse(upstream)
    } catch {
      return unavailable(c)
    }
  })

  return routes
}

export const adminAttributionProxyRoutes =
  createAdminAttributionProxyRoutes()

function normalizeRelativePath(value: string | undefined): string | null {
  const normalized = value?.replace(/^\/+/, '') ?? ''
  if (
    !normalized
    || normalized.length > 2_048
    || normalized.includes('\\')
    || containsControlCharacter(normalized)
  ) {
    return null
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => {
    if (!segment) return true
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || containsControlCharacter(decoded)
  })) {
    return null
  }
  return normalized
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some(
    character => character.charCodeAt(0) <= 0x1f,
  )
}

function relativePathFromPublicPath(path: string): string | null {
  const prefix =
    `${ATTRIBUTION_SERVICE_BINDING.ADMIN_PROXY_PUBLIC_PATH_PREFIX}/`
  if (!path.startsWith(prefix)) return null
  return normalizeRelativePath(path.slice(prefix.length))
}

function buildInternalUrl(
  relativePath: string,
  search: string,
): string | null {
  const value = `${ATTRIBUTION_SERVICE_BINDING.INTERNAL_ORIGIN}`
    + `${ATTRIBUTION_SERVICE_BINDING.ADMIN_PATH_PREFIX}/${relativePath}`
    + search
  if (value.length > ATTRIBUTION_SERVICE_BINDING.ADMIN_PROXY_MAX_URL_LENGTH) {
    return null
  }
  try {
    const url = new URL(value)
    if (
      url.origin !== ATTRIBUTION_SERVICE_BINDING.INTERNAL_ORIGIN
      || !url.pathname.startsWith(
        `${ATTRIBUTION_SERVICE_BINDING.ADMIN_PATH_PREFIX}/`,
      )
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function forwardedHeaders(input: Headers): Headers {
  const headers = new Headers()
  for (const name of ['content-type', 'idempotency-key']) {
    const value = input.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

async function readBoundedBody(request: Request): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (
      !Number.isSafeInteger(size)
      || size < 0
      || size > ATTRIBUTION_SERVICE_BINDING.ADMIN_PROXY_MAX_BODY_BYTES
    ) {
      throw new ProxyRequestError(
        413,
        '归因管理请求体过大',
        'ATTRIBUTION_ADMIN_PROXY_BODY_TOO_LARGE',
      )
    }
  }
  const body = await request.arrayBuffer()
  if (
    body.byteLength
    > ATTRIBUTION_SERVICE_BINDING.ADMIN_PROXY_MAX_BODY_BYTES
  ) {
    throw new ProxyRequestError(
      413,
      '归因管理请求体过大',
      'ATTRIBUTION_ADMIN_PROXY_BODY_TOO_LARGE',
    )
  }
  return body
}

function sanitizeUpstreamResponse(upstream: Response): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
  })
  const contentType = upstream.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}

function unavailable(
  c: Parameters<typeof errorJson>[0],
) {
  return errorJson(c, 503, '归因管理服务暂时不可用', {
    code: 'ATTRIBUTION_ADMIN_PROXY_UNAVAILABLE',
  })
}

class ProxyRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}
