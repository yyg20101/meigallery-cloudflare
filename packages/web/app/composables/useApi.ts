/**
 * 统一 API 客户端
 * 封装对 API Worker 的调用，自动处理 SSR / CSR 差异和认证 cookie
 *
 * SSR（Cloudflare）：通过 useRequestEvent() 获取 Service Binding，直连 API Worker（零网络开销）
 * SSR（本地开发）：$fetch 直接请求 localhost:8787
 * CSR（浏览器）：统一请求 Web 同源 /api 代理
 *
 * 解决 Cloudflare 同账户 *.workers.dev 域名互访限制（error 1042）
 */
import { apiProxyResponseHeaderEntries } from '~/utils/apiProxyHeaders'
import { appendResponseHeader } from 'h3'

export function useApi() {
  const config = useRuntimeConfig()
  const appEnv = String(config.public.appEnv || 'development')
  const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

  /**
   * 构建带查询字符串的完整路径
   */
  function buildFullPath(path: string, query?: Record<string, string | number | undefined>): string {
    if (!query) return path
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    return qs ? `${path}?${qs}` : path
  }

  /**
   * SSR 专用：通过 Service Binding 直连 API Worker
   * 从原始请求事件获取 Cloudflare env，避免 localCall 合成事件无 env 的问题
   */
  function isFormDataBody(body: unknown): body is FormData {
    return typeof FormData !== 'undefined' && body instanceof FormData
  }

  function shouldConfirmDevAdminWrite(path: string, method: string): boolean {
    return import.meta.client
      && appEnv === 'dev'
      && path.startsWith('/api/admin/')
      && mutatingMethods.has(method.toUpperCase())
  }

  function confirmDevAdminWrite(path: string, method: string): void {
    if (!shouldConfirmDevAdminWrite(path, method)) return

    const confirmed = window.confirm([
      '当前 DEV 后台连接独立 dev D1/R2 数据。',
      `即将执行 ${method.toUpperCase()} ${path}，会修改 dev 测试数据、会员或媒体文件，并会写入审计日志。`,
      '确认继续执行？',
    ].join('\n\n'))

    if (!confirmed) {
      const error = new Error('已取消 DEV 后台写操作')
      ;(error as any).statusCode = 499
      throw error
    }
  }

  async function ssrFetch<T>(fullPath: string, options?: {
    method?: string
    body?: unknown
    keepalive?: boolean
  }): Promise<T> {
    const event = useRequestEvent()
    const apiBinding = (event?.context as Record<string, any>)?.cloudflare?.env?.API_SERVICE
    const isTestEnvironment = config.public.appEnv === 'test'
    const requestHeaders = useRequestHeaders(['cookie'])

    if (apiBinding && !isTestEnvironment) {
      // Cloudflare Workers 环境：Service Binding 直连（域名仅占位，路由取决于路径）
      const init: RequestInit = {
        method: options?.method || 'GET',
        keepalive: options?.keepalive,
      }
      if (isFormDataBody(options?.body)) {
        init.body = options.body
      } else if (options?.body) {
        (init as any).headers = { 'Content-Type': 'application/json' }
        init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      }
      // 转发原始请求的 cookie（用于认证场景）
      if (requestHeaders.cookie) {
        (init as any).headers = { ...(init.headers as Record<string, string> || {}), cookie: requestHeaders.cookie }
      }

      return fetchViaApiServiceBinding<T>(event, apiBinding, fullPath, init)
    }

    // 本地开发回退：直接 HTTP 请求 API 开发服务器（无 Worker-to-Worker 限制）
    const apiBaseUrl = config.public.apiBaseUrl as string
    const fetchOpts: RequestInit = {
      method: options?.method || 'GET',
      keepalive: options?.keepalive,
    }
    if (isFormDataBody(options?.body)) {
      fetchOpts.body = options.body
    } else if (options?.body) {
      fetchOpts.headers = { 'Content-Type': 'application/json' }
      fetchOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    }
    if (requestHeaders.cookie) {
      fetchOpts.headers = { ...(fetchOpts.headers as Record<string, string> || {}), cookie: requestHeaders.cookie }
    }
    const response = await fetch(`${apiBaseUrl}${fullPath}`, fetchOpts)
    forwardSsrResponseCookies(event, response)
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      const err = new Error(`[${fetchOpts.method}] "${fullPath}": ${response.status} ${response.statusText}`)
      ;(err as any).statusCode = response.status
      ;(err as any).statusMessage = response.statusText
      ;(err as any).data = errorBody
      throw err
    }
    return response.json() as Promise<T>
  }

  async function api<T = unknown>(
    path: string,
    options?: {
      method?: string
      body?: unknown
      query?: Record<string, string | number | undefined>
      keepalive?: boolean
    },
  ): Promise<T> {
    const method = options?.method || 'GET'
    confirmDevAdminWrite(path, method)

    const fullPath = buildFullPath(path, options?.query)

    // SSR: 使用 Service Binding 或本地开发回退
    if (import.meta.server) {
      return ssrFetch<T>(fullPath, options)
    }

    // 浏览器统一走 Web 同源代理，保证 session 与归因来源上下文共用同一 host-only cookie 域。
    const fetchOptions: Record<string, unknown> = {
      method,
      credentials: 'include',
      keepalive: options?.keepalive,
    }
    if (isFormDataBody(options?.body)) {
      fetchOptions.body = options.body
    } else if (options?.body) {
      fetchOptions.headers = { 'Content-Type': 'application/json' }
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    }
    return $fetch<T>(fullPath, fetchOptions as any)
  }

  return { api, baseURL: '' }
}

function forwardSsrResponseCookies(event: ReturnType<typeof useRequestEvent>, response: Response) {
  if (!event) return
  for (const [name, value] of apiProxyResponseHeaderEntries(response.headers)) {
    if (name === 'set-cookie') appendResponseHeader(event, name, value)
  }
}

export async function fetchViaApiServiceBinding<T>(
  event: ReturnType<typeof useRequestEvent>,
  apiBinding: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  fullPath: string,
  init: RequestInit,
): Promise<T> {
  const bindingUrl = new URL(fullPath, 'https://api.internal').href
  const response = await apiBinding.fetch(bindingUrl, init)
  forwardSsrResponseCookies(event, response)
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    const err = new Error(`[${init.method}] "${fullPath}": ${response.status} ${response.statusText}`)
    ;(err as any).statusCode = response.status
    ;(err as any).statusMessage = response.statusText
    ;(err as any).data = errorBody
    throw err
  }
  return response.json() as Promise<T>
}
