import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { hashImportToken } from '../utils/import-token'
import { importRoutes } from './imports'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/imports', importRoutes)
  return app
}

function createDb(tokenHash: string, options: { importsToday?: number; lastUsedAt?: string | null } = {}) {
  const records: Record<string, Record<string, unknown>> = {}
  let createdRecords = 0
  let tokenTouchUpdates = 0
  return {
    get createdRecords() {
      return createdRecords
    },
    get tokenTouchUpdates() {
      return tokenTouchUpdates
    },
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          if (sql.includes('FROM import_api_tokens')) {
            if (params[0] !== tokenHash) return null as T
            return { id: 'iat_1', created_by: 1, permissions: '["gallery:create","testimonial:create"]', allowed_source_bot_keys: '["ops_gallery_bot"]', status: 'active', expires_at: null, last_used_at: options.lastUsedAt ?? null } as T
          }
          if (sql.includes('COUNT(*) as count') && sql.includes('FROM external_import_records')) return { count: options.importsToday ?? 0 } as T
          if (sql.includes('FROM external_import_records') && sql.includes("source = 'telegram'")) return null as T
          if (sql.includes('FROM external_import_records') && sql.includes('WHERE id = ? AND token_id = ?')) return records[String(params[0])] as T
          return null as T
        },
        async all<T>() { return { results: [] as T[] } },
        async run() {
          if (sql.includes('UPDATE import_api_tokens SET last_used_at')) tokenTouchUpdates++
          if (sql.includes('INSERT INTO external_import_records')) {
            createdRecords++
            records[String(params[0])] = { id: params[0], status: 'pending_media_fetch' }
          }
          return { success: true }
        },
      }
    },
  }
}

const payload = {
  metadata: { type: 'gallery', source: 'telegram', externalMessageId: '-100:1', title: '标题', slug: 'title-001', requiredLevelRank: 0 },
  telegram: { sourceBotKey: 'ops_gallery_bot', sourceChatId: '-100', sourceMessageId: '1' },
  files: [{ fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true }],
}

describe('Telegram 导入 API', () => {
  it('requires bearer import token', async () => {
    const res = await createApp().request('/api/imports/telegram-file-id', { method: 'POST', body: JSON.stringify(payload) }, { DB: createDb('') } as unknown as Bindings)

    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('IMPORT_TOKEN_MISSING')
  })

  it('accepts valid token and returns pending_media_fetch', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { DB: createDb(await hashImportToken(token)), R2: { put: async () => null, delete: async () => null } } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(202)
    expect(body.status).toBe('pending_media_fetch')
    expect(body.importId).toMatch(/^eir_/)
  })

  it('rejects non-json import requests', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }, { DB: createDb(await hashImportToken(token)) } as unknown as Bindings)

    expect(res.status).toBe(415)
    expect((await res.json()).code).toBe('IMPORT_VALIDATION_FAILED')
  })

  it('超过 token 每日导入限额时不创建导入记录', async () => {
    const token = 'mgi_valid_token'
    const db = createDb(await hashImportToken(token), { importsToday: 1 })
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { DB: db, IMPORT_TOKEN_DAILY_LIMIT: '1' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.code).toBe('IMPORT_DAILY_LIMIT_EXCEEDED')
    expect(db.createdRecords).toBe(0)
  })

  it('token 最近已使用时不重复写 last_used_at', async () => {
    const token = 'mgi_valid_token'
    const db = createDb(await hashImportToken(token), { lastUsedAt: new Date().toISOString() })
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(415)
    expect(db.tokenTouchUpdates).toBe(0)
  })
})
