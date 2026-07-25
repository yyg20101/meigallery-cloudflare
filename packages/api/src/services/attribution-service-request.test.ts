import { describe, expect, it } from 'vitest'
import { createAttributionServiceRequest } from './attribution-service-request'

describe('归因 Service Binding 请求', () => {
  it('统一使用 Cloudflare Edge 支持的 manual 重定向模式', () => {
    const request = createAttributionServiceRequest(
      'https://attribution.internal/internal/v1/runtime-state',
      {
        method: 'GET',
      },
    )

    expect(request.redirect).toBe('manual')
  })
})
