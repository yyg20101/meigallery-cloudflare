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
  const executed: Array<{ sql: string; params: unknown[] }> = []
  return {
    auditRows,
    executed,
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
            if (params[0] === 'missing') return null
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
          executed.push({ sql, params: [...params] })
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
  it('要求 owner 角色', async () => {
    const res = await app('admin').request('/api/admin/import-api-tokens', {}, { DB: createDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('仅在创建响应中返回明文 token', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'] }),
    }, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.token).toMatch(/^mgi_/)
  })

  it('拒绝无效的 expiresAt 值', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'], expiresAt: 'not-a-date' }),
    }, { DB: createDb() } as unknown as Bindings)

    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('过期时间格式不正确')
  })

  it('拒绝非字符串的 expiresAt 值', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'], expiresAt: 123 }),
    }, { DB: createDb() } as unknown as Bindings)

    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('过期时间格式不正确')
  })

  it('更新时不将 token hash 写入审计日志', async () => {
    const db = createDb()
    const res = await app('owner').request('/api/admin/import-api-tokens/iat_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新 Token', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'] }),
    }, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
    expect(JSON.stringify(db.auditRows)).not.toContain('secret_hash_should_not_be_logged')
  })

  it('禁用已有 token 时写入脱敏审计信息', async () => {
    const db = createDb()
    const res = await app('owner').request('/api/admin/import-api-tokens/iat_1', { method: 'DELETE' }, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
    expect(db.executed.some(item => item.sql.includes("UPDATE import_api_tokens SET status = 'disabled'"))).toBe(true)
    expect(JSON.stringify(db.auditRows)).not.toContain('secret_hash_should_not_be_logged')
    expect(db.auditRows[0]?.afterValue).toBe(JSON.stringify({ status: 'disabled' }))
  })

  it('禁用不存在的 token 时不写审计也不更新记录', async () => {
    const db = createDb()
    const res = await app('owner').request('/api/admin/import-api-tokens/missing', { method: 'DELETE' }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.message).toBe('Import Token 不存在')
    expect(db.executed.some(item => item.sql.includes("UPDATE import_api_tokens SET status = 'disabled'"))).toBe(false)
    expect(db.auditRows).toHaveLength(0)
  })
})
