import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { createAdminAttributionProxyRoutes } from './attribution-proxy'

const REQUEST_ID = '019f931b-132e-77c2-b06d-9378e4f6d680'

describe('归因管理 Service Binding 代理', () => {
  it.each([
    [null, null, 401],
    [2, 'admin', 403],
    [1, 'owner', 200],
  ] as const)(
    'userId=%s role=%s 时返回 %s',
    async (userId, role, status) => {
      const fetch = vi.fn(async () => Response.json({ data: [] }))
      const response = await createApp({
        userId,
        role,
        fetch,
      }).request(
        '/api/admin/attribution-runtime/connections',
        {},
        bindings(fetch),
      )

      expect(response.status).toBe(status)
      expect(fetch).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
    },
  )

  it('丢弃浏览器伪造身份和内部认证头，仅注入可信 Owner 身份', async () => {
    const fetch = vi.fn(async () => Response.json({
      data: { accepted: true },
    }))
    const body = JSON.stringify({
      provider: 'meta',
      name: '美国投放',
      isDefault: true,
    })
    const response = await createApp({
      userId: 7,
      role: 'owner',
      fetch,
    }).request(
      '/api/admin/attribution-runtime/connections?source=console',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer forged',
          Cookie: 'session=forged',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'connection-create-1',
          'X-Attribution-Actor-Id': '999',
          'X-Attribution-Actor-Role': 'admin',
          'X-Attribution-Internal-Auth': 'forged',
          'X-Attribution-Request-Id': 'forged',
          'X-Attribution-Request-Timestamp': '1',
        },
        body,
      },
      bindings(fetch),
    )

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
    const forwarded = fetch.mock.calls[0]?.[0]
    expect(forwarded).toBeInstanceOf(Request)
    expect(forwarded?.url).toBe(
      'https://attribution.internal/admin/attribution/connections?source=console',
    )
    expect(forwarded?.method).toBe('POST')
    expect(forwarded?.headers.get('Content-Type')).toBe('application/json')
    expect(forwarded?.headers.get('Idempotency-Key')).toBe(
      'connection-create-1',
    )
    expect(forwarded?.headers.get('Authorization')).toBeNull()
    expect(forwarded?.headers.get('Cookie')).toBeNull()
    expect(forwarded?.headers.get('X-Attribution-Actor-Id')).toBe('7')
    expect(forwarded?.headers.get('X-Attribution-Actor-Role')).toBe('owner')
    expect(forwarded?.headers.get('X-Attribution-Request-Id')).toBe(
      REQUEST_ID,
    )
    expect(forwarded?.headers.get(
      'X-Attribution-Request-Timestamp',
    )).toBeNull()
    expect(forwarded?.headers.get(
      'X-Attribution-Internal-Auth',
    )).toBeNull()
    expect(await forwarded?.text()).toBe(body)
  })

  it('拒绝非白名单方法和路径穿越，不触发 Service Binding', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }))
    const app = createApp({ userId: 1, role: 'owner', fetch })

    const [deleteResponse, traversalResponse] = await Promise.all([
      app.request(
        '/api/admin/attribution-runtime/connections/connection_meta_a',
        { method: 'DELETE' },
        bindings(fetch),
      ),
      app.request(
        '/api/admin/attribution-runtime/..%2finternal/v1/privacy-decision',
        {},
        bindings(fetch),
      ),
    ])

    expect(deleteResponse.status).toBe(405)
    expect(traversalResponse.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('通用后台代理禁止绕过专用 cutover 控制面推进 runtime', async () => {
    const fetch = vi.fn(async () => Response.json({ data: {} }))
    const response = await createApp({
      userId: 1,
      role: 'owner',
      fetch,
    }).request(
      '/api/admin/attribution-runtime/runtime-state/transition',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'bypass_runtime_transition',
        },
        body: JSON.stringify({
          targetMode: 'active',
          sourceOwnerEpoch: 99,
          reason: '绕过统一切换控制面',
        }),
      },
      bindings(fetch),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'ATTRIBUTION_ADMIN_PROXY_CONTROL_PLANE_FORBIDDEN',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('百分号编码路径也不能绕过专用 cutover 控制面', async () => {
    const fetch = vi.fn(async () => Response.json({ data: {} }))
    const response = await createApp({
      userId: 1,
      role: 'owner',
      fetch,
    }).request(
      '/api/admin/attribution-runtime/runtime-state/%74ransition',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'encoded_bypass_runtime_transition',
        },
        body: JSON.stringify({
          targetMode: 'bridge',
          sourceOwnerEpoch: 2,
          reason: '不得绕过统一切换控制面',
        }),
      },
      bindings(fetch),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'ATTRIBUTION_ADMIN_PROXY_CONTROL_PLANE_FORBIDDEN',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('在代理层拒绝超大请求体，不把压力传递给独立 Worker', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }))
    const response = await createApp({
      userId: 1,
      role: 'owner',
      fetch,
    }).request(
      '/api/admin/attribution-runtime/connections',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(65 * 1024) }),
      },
      bindings(fetch),
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      code: 'ATTRIBUTION_ADMIN_PROXY_BODY_TOO_LARGE',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('仅返回安全响应头并强制 no-store', async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ data: [] }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'internal=secret',
          'X-Attribution-Debug': 'credential-detail',
        },
      },
    ))
    const response = await createApp({
      userId: 1,
      role: 'owner',
      fetch,
    }).request(
      '/api/admin/attribution-runtime/connections',
      {},
      bindings(fetch),
    )

    expect(response.status).toBe(200)
    expect(fetch.mock.calls[0]?.[0].redirect).toBe('manual')
    expect(response.headers.get('Content-Type')).toContain(
      'application/json',
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('X-Attribution-Debug')).toBeNull()
  })

  it('Service Binding 异常时只返回稳定错误，不泄漏异常详情', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetch = vi.fn(async () => {
      throw new Error('private binding and credential detail')
    })
    const response = await createApp({
      userId: 1,
      role: 'owner',
      fetch,
    }).request(
      '/api/admin/attribution-runtime/connections',
      {},
      bindings(fetch),
    )

    expect(response.status).toBe(503)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({
      code: 'ATTRIBUTION_ADMIN_PROXY_UNAVAILABLE',
    })
    expect(text).not.toContain('private binding')
    expect(log).toHaveBeenCalledWith(
      'ATTRIBUTION_ADMIN_PROXY_FETCH_FAILED',
      {
        name: 'Error',
        message: 'private binding and credential detail',
      },
    )
    log.mockRestore()
  })
})

function createApp(input: {
  userId: number | null
  role: string | null
  fetch: (request: Request) => Promise<Response>
}) {
  const app = new Hono<{
    Bindings: Bindings
    Variables: Variables
  }>()
  app.use('*', async (c, next) => {
    c.set('userId', input.userId)
    c.set('userRole', input.role)
    await next()
  })
  app.route(
    '/api/admin/attribution-runtime',
    createAdminAttributionProxyRoutes({
      requestId: () => REQUEST_ID,
    }),
  )
  return app
}

function bindings(
  fetch: (request: Request) => Promise<Response>,
): Bindings {
  return {
    ATTRIBUTION: { fetch },
  } as unknown as Bindings
}
