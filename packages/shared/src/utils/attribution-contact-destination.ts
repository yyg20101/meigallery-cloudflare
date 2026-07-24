export interface AttributionContactDestination {
  value: string
  linkUrl: string | null
}

const encoder = new TextEncoder()

/**
 * 绑定联系人实际目标配置；API 签发 capability 与 Attribution Worker 验证事件必须共用该算法。
 */
export async function digestAttributionContactDestination(
  input: AttributionContactDestination,
): Promise<string> {
  const canonical = JSON.stringify({
    linkUrl: input.linkUrl,
    value: input.value,
  })
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`contact-destination:v1:${canonical}`),
  ))
  return Array.from(
    digest,
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}
