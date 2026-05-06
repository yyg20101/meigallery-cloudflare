import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminExternalImportRecordRoutes } from './external-import-records'

function app(role: string | null = 'admin') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/external-import-records', adminExternalImportRecordRoutes)
  return app
}

describe('后台外部导入记录 API', () => {
  it('does not expose Telegram token or download URL', async () => {
    const db = { prepare: () => ({ bind() { return this }, first: async () => ({ id: 'eir_1', source_bot_key: 'ops_gallery_bot', metadata_json: '{}', error_json: '{"message":"失败"}' }), all: async () => ({ results: [{ filename: '001.jpg', status: 'failed' }] }) }) }
    const res = await app().request('/api/admin/external-import-records/eir_1', {}, { DB: db } as unknown as Bindings)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('api.telegram.org/file')
    expect(text).not.toContain('123:secret')
  })
})
