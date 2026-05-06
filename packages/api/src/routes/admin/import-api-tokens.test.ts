import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminImportApiTokenRoutes } from './import-api-tokens'

function app(role: string | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/import-api-tokens', adminImportApiTokenRoutes)
  return app
}

const db = { prepare: () => ({ bind() { return this }, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ success: true }) }) }

describe('后台 Import Token API', () => {
  it('requires owner role', async () => {
    const res = await app('admin').request('/api/admin/import-api-tokens', {}, { DB: db } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('returns plaintext token only on create response', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'] }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.token).toMatch(/^mgi_/)
  })
})
