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

function createDb() {
  const auditRows: Array<{ beforeValue: string | null; afterValue: string | null }> = []
  return {
    auditRows,
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        all: async () => ({ results: [] }),
        async first() {
          if (sql.includes('SELECT * FROM import_api_tokens')) {
            return {
              id: params[0],
              name: '旧 Token',
              token_hash: 'secret_hash_should_not_be_logged',
              permissions: '["gallery:create"]',
              allowed_source_bot_keys: '["ops_gallery_bot"]',
              status: 'active',
              expires_at: null,
            }
          }
          return null
        },
        async run() {
          if (sql.includes('INSERT INTO admin_audit_logs')) {
            auditRows.push({ beforeValue: params[5] as string | null, afterValue: params[6] as string | null })
          }
          return { success: true }
        },
      }
    },
  }
}

describe('后台 Import Token API', () => {
  it('requires owner role', async () => {
    const res = await app('admin').request('/api/admin/import-api-tokens', {}, { DB: createDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('returns plaintext token only on create response', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'] }),
    }, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.token).toMatch(/^mgi_/)
  })

  it('rejects invalid expiresAt values', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'], expiresAt: 'not-a-date' }),
    }, { DB: createDb() } as unknown as Bindings)

    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('过期时间格式不正确')
  })

  it('rejects non-string expiresAt values', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'], expiresAt: 123 }),
    }, { DB: createDb() } as unknown as Bindings)

    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('过期时间格式不正确')
  })

  it('does not write token hash to audit log when updating tokens', async () => {
    const db = createDb()
    const res = await app('owner').request('/api/admin/import-api-tokens/iat_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新 Token', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'] }),
    }, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
    expect(JSON.stringify(db.auditRows)).not.toContain('secret_hash_should_not_be_logged')
  })
})
