export type AttributionServiceRequestInit =
  Omit<RequestInit, 'redirect'>

/**
 * Cloudflare Service Binding 仅支持 follow/manual。
 * 内部控制面由调用方自行处理响应状态，不允许自动跟随重定向。
 */
export function createAttributionServiceRequest(
  input: string,
  init: AttributionServiceRequestInit,
) {
  return new Request(input, {
    ...init,
    redirect: 'manual',
  })
}
