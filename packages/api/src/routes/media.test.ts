import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { mediaRoutes } from './media'

function createApp(options: { userId?: number | null; userRole?: string | null } = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', options.userId ?? null)
    c.set('userRole', options.userRole ?? null)
    await next()
  })
  app.route('/api/media', mediaRoutes)
  return app
}

function createThumbnailEnv(options: {
  imageResizingEnabled: 'true' | 'false'
  requiredRank?: number
  galleryRequiredRank?: number
  assetType?: 'image' | 'video'
  streamUid?: string | null
  r2Key?: string | null
  streamAccountId?: string
  streamApiToken?: string
  r2Get?: ReturnType<typeof vi.fn>
}) {
  const r2Get = options.r2Get ?? vi.fn(async () => ({
    body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
    httpMetadata: { contentType: 'image/jpeg' },
    httpEtag: 'origin-etag',
  }))

  return {
    IMAGE_RESIZING_ENABLED: options.imageResizingEnabled,
    STREAM_ACCOUNT_ID: options.streamAccountId,
    STREAM_API_TOKEN: options.streamApiToken,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: 'asset-1',
            role: 'gallery',
            r2_key: options.r2Key === undefined ? 'originals/gallery-1/asset-1.jpg' : options.r2Key,
            stream_uid: options.streamUid === undefined ? null : options.streamUid,
            type: options.assetType ?? 'image',
            required_rank: options.requiredRank ?? 0,
            required_level_rank: options.galleryRequiredRank ?? 0,
            status: 'published',
          }),
        }),
      }),
    },
    R2: { get: r2Get },
  } as unknown as Bindings
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('公开媒体访问', () => {
  it('允许公开访问站点图标目录', async () => {
    const app = createApp()
    const env = {
      R2: {
        get: async () => ({
          body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
          httpMetadata: { contentType: 'image/png' },
          httpEtag: 'test-etag',
        }),
      },
    } as unknown as Bindings

    const res = await app.request('/api/media/public/site/site-icon-test.png', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  it('请求 w=800 时使用无 query 的 raw URL 和 480 宽度执行图片转换', async () => {
    const app = createApp()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('resized', {
      status: 200,
      headers: { 'Content-Type': 'image/webp' },
    }))

    const res = await app.request(
      '/api/media/asset-1/thumbnail?w=800',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'true' }),
    )

    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    const originUrl = new URL(url.toString())
    expect(originUrl.pathname).toBe('/api/media/raw/asset-1')
    expect(originUrl.search).toBe('')
    expect((init as { cf?: { image?: { width?: number } } }).cf?.image?.width).toBe(480)
  })

  it('受保护图片缩略图返回 403', async () => {
    const app = createApp()
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const res = await app.request(
      '/api/media/asset-1/thumbnail?w=480',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'true', requiredRank: 10 }),
    )

    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('图库级受保护图片缩略图返回 403', async () => {
    const app = createApp()
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const res = await app.request(
      '/api/media/asset-1/thumbnail?w=480',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'true', galleryRequiredRank: 10 }),
    )

    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('图库级受保护图片 raw 端点返回 404', async () => {
    const app = createApp()

    const res = await app.request(
      '/api/media/raw/asset-1',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'true', galleryRequiredRank: 10 }),
    )

    expect(res.status).toBe(404)
  })

  it('图片转换返回非 ok 时回退原图并返回 200', async () => {
    const app = createApp()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 9422,
      headers: new Headers(),
      body: null,
    } as Response)

    const res = await app.request(
      '/api/media/asset-1/thumbnail?w=480',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'true' }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800')
  })

  it('图片转换抛异常时回退原图并返回 200', async () => {
    const app = createApp()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('transform failed'))

    const res = await app.request(
      '/api/media/asset-1/thumbnail?w=480',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'true' }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800')
  })

  it('未启用图片转换时直接回退原图', async () => {
    const app = createApp()
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const res = await app.request(
      '/api/media/asset-1/thumbnail?w=480',
      {},
      createThumbnailEnv({ imageResizingEnabled: 'false' }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('受保护媒体访问', () => {
  it('图片访问接口校验后代理返回 R2 内容，不返回原始 URL', async () => {
    const app = createApp({ userId: 1, userRole: 'admin' })
    const env = createThumbnailEnv({ imageResizingEnabled: 'false', requiredRank: 10 })

    const res = await app.request('/api/media/asset-1/access', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=600')

    const body = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(body)).toEqual([1, 2, 3])
  })

  it('Stream 未配置时返回明确错误且不调用外部签名接口', async () => {
    const app = createApp({ userId: 1, userRole: 'admin' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const env = createThumbnailEnv({
      imageResizingEnabled: 'false',
      assetType: 'video',
      r2Key: null,
      streamUid: 'stream-video-1',
      streamAccountId: '',
      streamApiToken: '',
    })

    const res = await app.request('/api/media/asset-1/access', {}, env)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).toMatchObject({
      statusCode: 503,
      message: '视频服务暂未配置，请联系站点管理员',
      code: 'STREAM_NOT_CONFIGURED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
