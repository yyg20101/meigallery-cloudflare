import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { hashImportToken } from '../utils/import-token'
import { importRoutes } from './imports'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/imports', importRoutes)
  return app
}

function createDb(tokenHash: string, options: {
  importsToday?: number
  lastUsedAt?: string | null
  existingRecord?: Record<string, unknown>
  permissions?: string[]
  allowedSourceBotKeys?: string[]
} = {}) {
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
            return {
              id: 'iat_1',
              created_by: 1,
              permissions: JSON.stringify(options.permissions ?? ['gallery:create', 'case:create']),
              allowed_source_bot_keys: JSON.stringify(options.allowedSourceBotKeys ?? ['ops_gallery_bot']),
              status: 'active',
              expires_at: null,
              last_used_at: options.lastUsedAt ?? null,
            } as T
          }
          if (sql.includes('COUNT(*) as count') && sql.includes('FROM external_import_records')) return { count: options.importsToday ?? 0 } as T
          if (sql.includes('FROM external_import_records') && sql.includes("source = 'telegram'")) return (options.existingRecord ?? null) as T
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

const casePayload = {
  ...payload,
  metadata: { ...payload.metadata, type: 'case', externalMessageId: '-100:case-1', slug: 'case-001', requiredLevelRank: undefined },
  files: [
    { fileId: 'AgACAgCase1', mimeType: 'image/jpeg', sortOrder: 0 },
    { fileId: 'AgACAgCase2', mimeType: 'image/png', sortOrder: 1 },
  ],
}

describe('Telegram 导入 API', () => {
  it('要求 bearer import token', async () => {
    const res = await createApp().request('/api/imports/telegram-file-id', { method: 'POST', body: JSON.stringify(payload) }, { DB: createDb('') } as unknown as Bindings)

    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('IMPORT_TOKEN_MISSING')
  })

  it('接受有效 token 并返回 pending_media_fetch', async () => {
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

  it('接受 case payload 并使用 case:create 权限创建 pending 导入', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(casePayload),
    }, { DB: createDb(await hashImportToken(token)), R2: { put: async () => null, delete: async () => null } } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(202)
    expect(body.type).toBe('case')
    expect(body.status).toBe('pending_media_fetch')
  })

  it('拒绝没有 case:create 权限的 case 导入', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(casePayload),
    }, { DB: createDb(await hashImportToken(token), { permissions: ['gallery:create'] }) } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('IMPORT_PERMISSION_DENIED')
  })

  it('拒绝 sourceBotKey 不在 allowlist 的导入', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { DB: createDb(await hashImportToken(token), { allowedSourceBotKeys: ['other_bot'] }) } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('IMPORT_SOURCE_BOT_NOT_ALLOWED')
  })

  it('重复 pending 导入会重新调度异步处理', async () => {
    const token = 'mgi_valid_token'
    const waitUntil = vi.fn()
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, {
      DB: createDb(await hashImportToken(token), {
        existingRecord: { id: 'eir_existing', target_type: 'gallery', target_id: null, status: 'pending_media_fetch' },
      }),
      R2: { put: async () => null, delete: async () => null },
    } as unknown as Bindings, { waitUntil } as unknown as ExecutionContext)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('duplicate')
    expect(body.currentStatus).toBe('pending_media_fetch')
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('拒绝非 JSON 导入请求', async () => {
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

  it('拒绝旧 testimonial_case 导入类型', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        metadata: { ...payload.metadata, type: 'testimonial_case' },
      }),
    }, { DB: createDb(await hashImportToken(token)) } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toBe('metadata.type 必须是 gallery 或 case')
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
