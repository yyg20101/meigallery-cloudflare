import type {
  AppApiErrorResponse,
  AppApiListSuccess,
  AppApiMeta,
  AppApiSuccess,
} from '@meigallery/shared'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Bindings, Variables } from '../index'

export const APP_API_VERSION = '2' as const
export const APP_CONTRACT_VERSION = '1.11.0' as const

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

function responseMeta(c: AppContext): AppApiMeta {
  const requestId = c.get('appRequestId') || crypto.randomUUID()
  c.header('X-Request-Id', requestId)
  c.header('X-Api-Version', APP_API_VERSION)
  c.header('X-Contract-Version', APP_CONTRACT_VERSION)
  return {
    requestId,
    serverTime: new Date().toISOString(),
    apiVersion: APP_API_VERSION,
    contractVersion: APP_CONTRACT_VERSION,
  }
}

export function appApiSuccess<T>(
  c: AppContext,
  data: T,
  status?: ContentfulStatusCode,
) {
  const body: AppApiSuccess<T> = { data, meta: responseMeta(c) }
  return status ? c.json(body, status) : c.json(body)
}

export function appApiListSuccess<T>(
  c: AppContext,
  data: T[],
  pagination: { nextCursor: string | null; hasMore: boolean },
) {
  const body: AppApiListSuccess<T> = {
    data,
    meta: {
      ...responseMeta(c),
      nextCursor: pagination.nextCursor,
      hasMore: pagination.hasMore,
    },
  }
  return c.json(body)
}

export function appApiError(
  c: AppContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  retryable = false,
) {
  const body: AppApiErrorResponse = {
    error: { code, message, retryable },
    meta: responseMeta(c),
  }
  return c.json(body, status)
}
