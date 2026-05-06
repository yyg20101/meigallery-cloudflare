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

function createDb(tokenHash: string) {
  const records: Record<string, Record<string, unknown>> = {}
  return {
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
            return { id: 'iat_1', permissions: '["gallery:create","testimonial:create"]', allowed_source_bot_keys: '["ops_gallery_bot"]', status: 'active', expires_at: null } as T
          }
          if (sql.includes('FROM external_import_records') && sql.includes("source = 'telegram'")) return null as T
          if (sql.includes('FROM external_import_records') && sql.includes('WHERE id = ? AND token_id = ?')) return records[String(params[0])] as T
          return null as T
        },
        async all<T>() { return { results: [] as T[] } },
        async run() {
          if (sql.includes('INSERT INTO external_import_records')) records[String(params[0])] = { id: params[0], status: 'pending_media_fetch' }
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
})
