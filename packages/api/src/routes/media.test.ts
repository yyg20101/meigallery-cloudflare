import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { mediaRoutes } from './media'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', null)
    c.set('userRole', null)
    await next()
  })
  app.route('/api/media', mediaRoutes)
  return app
}

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
})
