import { afterEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import type { Bindings } from './index'
import type { MetaCapiQueueMessage } from '@meigallery/shared'

function env(corsOrigin?: string) {
  return {
    APP_ENV: 'production',
    CORS_ORIGIN: corsOrigin,
    DB: {
      prepare() {
        return { first: async () => ({ ok: 1 }) }
      },
    },
  } as unknown as Bindings
}

describe('API CORS 安全配置', () => {
  it('生产环境未配置 CORS_ORIGIN 时不反射任意 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', {
      headers: { Origin: 'https://evil.example' },
    }), env(), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('支持多个明确允许的生产 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', {
      headers: { Origin: 'https://www.616618.xyz' },
    }), env('https://616618.xyz,https://www.616618.xyz'), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.616618.xyz')
  })
})

describe('Meta CAPI Queue consumer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('将 Queue 的临时 userData 传给 CAPI payload 后确认消息', async () => {
    const delivery = {
      id: 'cdlv_1',
      conversion_action_id: 'conv_1',
      channel: 'meta_capi',
      external_event_id: 'event_1',
      event_name: 'Contact',
      status: 'pending',
      skip_reason: '',
      error_code: '',
      error_message: '',
      attempt_count: 0,
      occurred_at: '2026-07-09T10:00:00.000Z',
      date: '2026-07-09',
      path: '/',
      metadata: '{}',
    }
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return this },
          async first<T>() {
            if (sql.includes('FROM analytics_conversion_deliveries')) return delivery as T
            if (sql.includes("WHERE key = 'facebook_pixel_id'")) return { value: JSON.stringify('1234567890') } as T
            return null as T | null
          },
          async run() { return { meta: { changes: 1 } } },
        }
        return statement
      },
    }
    const body: MetaCapiQueueMessage = {
      schemaVersion: 1,
      deliveryId: delivery.id,
      userData: {
        fbp: 'fb.1.1700000000000.123456789',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        clientIpAddress: '203.0.113.24',
        clientUserAgent: 'MeiGallery Test Browser/1.0',
      },
    }
    const message = { body, ack: vi.fn(), retry: vi.fn() }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await app.queue({ messages: [message] } as unknown as MessageBatch<MetaCapiQueueMessage>, {
      APP_ENV: 'test',
      SITE_URL: 'https://616618.xyz',
      META_CAPI_ACCESS_TOKEN: 'token_1',
      DB: db,
    } as unknown as Bindings)

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({
      fbp: body.userData.fbp,
      fbc: body.userData.fbc,
      client_ip_address: body.userData.clientIpAddress,
      client_user_agent: body.userData.clientUserAgent,
    })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })
})
