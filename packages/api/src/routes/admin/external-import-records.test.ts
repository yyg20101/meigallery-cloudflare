import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
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

  it('允许管理员重试 failed 导入并写入审计', async () => {
    const auditRows: string[] = []
    const record = {
      id: 'eir_1',
      token_id: 'iat_1',
      target_type: 'gallery',
      target_id: null,
      status: 'failed',
      retry_count: 0,
      source_bot_key: 'ops_gallery_bot',
    }
    const db = {
      prepare(sql: string) {
        const params: unknown[] = []
        return {
          bind(...values: unknown[]) {
            params.push(...values)
            return this
          },
          async first<T>() {
            if (sql.includes('SELECT eir.token_id, iat.permissions')) return {
              token_id: 'iat_1',
              permissions: '["gallery:create"]',
              allowed_source_bot_keys: '["ops_gallery_bot"]',
            } as T
            if (sql.includes('FROM external_import_records') && sql.includes('WHERE id = ? AND token_id = ?')) {
              return record.id === params[0] && record.token_id === params[1] ? record as T : null as T
            }
            if (sql.includes('FROM external_import_files') && sql.includes('r2_key IS NOT NULL')) return null as T
            if (sql.includes('iat.created_by as token_created_by')) return null as T
            return null as T
          },
          async all<T>() { return { results: [] as T[] } },
          async run() {
            if (sql.includes("SET status = 'pending_media_fetch'")) {
              record.status = 'pending_media_fetch'
            }
            if (sql.includes('INSERT INTO admin_audit_logs')) auditRows.push(String(params[6] ?? ''))
            return { success: true, meta: { changes: 1 } }
          },
        }
      },
    }
    const waitUntil = vi.fn()
    const res = await app().request('/api/admin/external-import-records/eir_1/retry', { method: 'POST' }, {
      DB: db,
      R2: { put: async () => undefined, delete: async () => undefined },
    } as unknown as Bindings, { waitUntil } as unknown as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(202)
    expect(body.status).toBe('pending_media_fetch')
    expect(record.status).toBe('pending_media_fetch')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(auditRows)).toContain('pending_media_fetch')
  })

  it('后台重试非 failed 导入时返回 409', async () => {
    const db = {
      prepare(sql: string) {
        const params: unknown[] = []
        return {
          bind(...values: unknown[]) {
            params.push(...values)
            return this
          },
          async first<T>() {
            if (sql.includes('SELECT eir.token_id, iat.permissions')) return {
              token_id: 'iat_1',
              permissions: '["gallery:create"]',
              allowed_source_bot_keys: '["ops_gallery_bot"]',
            } as T
            if (sql.includes('FROM external_import_records') && sql.includes('WHERE id = ? AND token_id = ?')) return {
              id: params[0],
              target_type: 'gallery',
              target_id: null,
              status: 'draft_created',
              retry_count: 0,
              source_bot_key: 'ops_gallery_bot',
            } as T
            return null as T
          },
          async all<T>() { return { results: [] as T[] } },
          async run() { return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const res = await app().request('/api/admin/external-import-records/eir_1/retry', { method: 'POST' }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('IMPORT_RETRY_NOT_ALLOWED')
  })
})
