/**
 * 统一 API 客户端
 * 封装 $fetch 调用 API Worker，自动携带 cookie
 */
export function useApi() {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl as string

  async function api<T = unknown>(
    path: string,
    options?: {
      method?: string
      body?: unknown
      query?: Record<string, string | number | undefined>
    },
  ): Promise<T> {
    const fetchOptions: Record<string, unknown> = {
      method: options?.method || 'GET',
      credentials: 'include',
    }

    if (options?.body) {
      fetchOptions.headers = { 'Content-Type': 'application/json' }
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    }

    if (options?.query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== '') params.set(k, String(v))
      }
      const qs = params.toString()
      const url = qs ? `${baseURL}${path}?${qs}` : `${baseURL}${path}`
      return $fetch<T>(url, fetchOptions as any)
    }

    return $fetch<T>(`${baseURL}${path}`, fetchOptions as any)
  }

  return { api, baseURL }
}
