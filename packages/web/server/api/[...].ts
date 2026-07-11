/**
 * SSR API 代理（解决 Cloudflare Workers 同账户 *.workers.dev 互访限制）
 *
 * 问题：Web Worker SSR 期间通过 *.workers.dev 域名请求 API Worker
 * 会触发 Cloudflare error 1042（同账户 Worker 互访限制），导致 404。
 *
 * 方案：
 * - Cloudflare 环境：通过 Service Binding（API_SERVICE）零网络开销直连 API Worker
 * - 本地开发：回退到 HTTP 代理转发至 API 开发服务器
 *
 * useApi() 在 SSR 期间使用相对路径 '/api/...'，Nitro 直接调用此 handler（无 HTTP 开销）；
 * 在 CSR 期间使用完整 API URL，浏览器直连 API Worker，不经过此代理。
 */

import {
  apiProxyResponseHeaderEntries,
  filterApiProxyRequestHeaders,
} from '../../app/utils/apiProxyHeaders'

interface CloudflareEnv {
  API_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
}

export default defineEventHandler(async (event) => {
  const cloudflareEnv = (event.context as Record<string, any>).cloudflare?.env as CloudflareEnv | undefined
  const config = useRuntimeConfig()
  const apiBinding = config.public.appEnv === 'test' ? undefined : cloudflareEnv?.API_SERVICE

  // 构建目标 URL
  const path = event.path // 完整路径，如 /api/galleries/summer-fresh-guangzhou?page=1
  const method = event.method
  const forwardHeaders = filterApiProxyRequestHeaders(getRequestHeaders(event))

  // 读取请求体（仅 POST/PUT/PATCH/DELETE）
  let body: string | undefined
  if (!['GET', 'HEAD'].includes(method)) {
    body = (await readRawBody(event)) ?? undefined
  }

  let response: Response

  if (apiBinding) {
    // Cloudflare Workers 环境：Service Binding 直连
    // Service Binding 忽略域名，仅使用路径路由到目标 Worker
    response = await apiBinding.fetch(`https://api.internal${path}`, {
      method,
      headers: forwardHeaders,
      body,
    })
  } else {
    // 本地开发回退：代理到 API 开发服务器
    const apiBaseUrl = config.public.apiBaseUrl as string
    response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: forwardHeaders,
      body,
    })
  }

  // 转发响应状态
  setResponseStatus(event, response.status, response.statusText)

  // 转发响应头（仅保留前端确实需要感知的业务头）
  for (const [name, value] of apiProxyResponseHeaderEntries(response.headers)) {
    if (name === 'set-cookie') appendResponseHeader(event, name, value)
    else setResponseHeader(event, name, value)
  }

  // 返回响应体
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return response.json()
  }

  // 非 JSON 响应（如图片等）直接返回 ArrayBuffer
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
})
