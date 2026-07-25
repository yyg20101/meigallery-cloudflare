import { describe, expect, it } from 'vitest'
import { createAttributionServiceRequest } from './attribution-service-request'

describe('归因 Service Binding 请求', () => {
  it('保留请求参数并统一使用 Edge 支持的 manual 重定向模式', async () => {
    const request = createAttributionServiceRequest(
      'https://attribution.internal/internal/v1/runtime-state',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'request-1',
        },
        body: '{"mode":"shadow"}',
        redirect: 'follow',
      },
    )

    expect(request.method).toBe('POST')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('X-Request-Id')).toBe('request-1')
    expect(await request.text()).toBe('{"mode":"shadow"}')
    expect(request.redirect).toBe('manual')
  })
})
