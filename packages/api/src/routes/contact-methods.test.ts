import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { contactMethodRoutes } from './contact-methods'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/contact-methods', contactMethodRoutes)
  return app
}

function createDb(rows: unknown[], firstRow: unknown = null) {
  return {
    prepare() {
      return {
        async all<T>() {
          return { results: rows as T[] }
        },
        bind() {
          return this
        },
        async first<T>() {
          return firstRow as T | null
        },
      }
    },
  }
}

describe('公开联系方式 API', () => {
  it('二维码地址始终为公开相对路径，不泄漏 Service Binding origin', async () => {
    const app = createApp()
    const env = {
      DB: createDb([{
        id: 'contact-1',
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        link_url: null,
        qr_code_key: 'qrcodes/contact-1.png',
        sort_order: 0,
      }]),
    } as unknown as Bindings

    const res = await app.request('https://api.internal/api/contact-methods', {}, env)
    const body = await res.json()

    expect(body.data[0].qrCodeUrl).toBe('/api/contact-methods/contact-1/qrcode')
    expect(body.data[0].attributionCapability).toBeNull()
    expect(JSON.stringify(body)).not.toContain('api.internal')
  })

  it('只发送目标摘要并把匹配的签名 capability 附到联系人', async () => {
    const fetch = vi.fn(async (request: Request) => {
      const body = await request.json<{
        contacts: Array<{
          contactMethodId: string
          platform: string
          destinationDigest: string
        }>
      }>()
      expect(request.url).toBe(
        'https://attribution.internal/internal/v1/contact-capabilities',
      )
      expect(JSON.stringify(body)).not.toContain('@meigallery')
      expect(JSON.stringify(body)).not.toContain('telegram.me')
      expect(body.contacts).toEqual([{
        contactMethodId: 'contact-1',
        platform: 'telegram',
        destinationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }])
      return Response.json({
        capabilities: body.contacts.map(contact => ({
          ...contact,
          attributionCapability: 'contact_capability_0123456789',
        })),
      })
    })
    const app = createApp()
    const env = {
      DB: createDb([{
        id: 'contact-1',
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        link_url: 'https://telegram.me/meigallery',
        qr_code_key: null,
        sort_order: 0,
      }]),
      ATTRIBUTION: { fetch },
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
    expect(body.data[0].attributionCapability)
      .toBe('contact_capability_0123456789')
  })

  it('Attribution Binding 故障时仍返回联系人且不伪造 capability', async () => {
    const app = createApp()
    const env = {
      DB: createDb([{
        id: 'contact-1',
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        link_url: null,
        qr_code_key: null,
        sort_order: 0,
      }]),
      ATTRIBUTION: {
        fetch: vi.fn(async () => {
          throw new Error('unavailable')
        }),
      },
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0]).toMatchObject({
      id: 'contact-1',
      attributionCapability: null,
    })
  })

  it('丢弃历史危险 link_url 并回退到平台自动链接', async () => {
    const app = createApp()
    const env = {
      DB: createDb([
        {
          id: 'contact-1',
          platform: 'telegram',
          label: 'Telegram',
          value: '@meigallery',
          link_url: 'javascript:alert(1)',
          qr_code_key: null,
          sort_order: 0,
        },
      ]),
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0].linkUrl).toBe('https://telegram.me/meigallery')
  })

  it('原样返回历史 telegram.me 联系链接', async () => {
    const app = createApp()
    const env = {
      DB: createDb([{
        id: 'contact-1',
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        link_url: 'https://telegram.me/meigallery',
        qr_code_key: null,
        sort_order: 0,
      }]),
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0].linkUrl).toBe('https://telegram.me/meigallery')
  })

  it('无安全手动链接和自动链接时返回 null', async () => {
    const app = createApp()
    const env = {
      DB: createDb([
        {
          id: 'contact-1',
          platform: 'custom',
          label: '自定义',
          value: 'meigallery',
          link_url: 'http://example.com',
          qr_code_key: null,
          sort_order: 0,
        },
      ]),
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0].linkUrl).toBeNull()
  })

  it('丢弃历史内部地址 link_url 并回退到平台自动链接', async () => {
    const app = createApp()
    const env = {
      DB: createDb([
        {
          id: 'contact-1',
          platform: 'telegram',
          label: 'Telegram',
          value: '@meigallery',
          link_url: 'https://127.0.0.1/contact',
          qr_code_key: null,
          sort_order: 0,
        },
      ]),
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0].linkUrl).toBe('https://telegram.me/meigallery')
  })

  it('二维码代理拒绝不属于当前联系方式的 R2 key', async () => {
    const app = createApp()
    const env = {
      DB: createDb([], { qr_code_key: 'qrcodes/contact-2.png' }),
      R2: {
        async get() {
          throw new Error('不应读取不匹配的二维码 key')
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/contact-methods/contact-1/qrcode', {}, env)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.message).toBe('二维码配置异常')
  })
})
