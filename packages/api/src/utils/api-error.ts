import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ApiErrorBody = {
  statusCode: number
  message: string
  code?: string
  detail?: unknown
}

export type ApiErrorOptions = {
  code?: string
  detail?: unknown
}

export function apiError(status: ContentfulStatusCode, message: string, options: ApiErrorOptions = {}): ApiErrorBody {
  return {
    statusCode: status,
    message,
    ...(options.code ? { code: options.code } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  }
}

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  options?: ApiErrorOptions,
) {
  return c.json(apiError(status, message, options), status)
}
