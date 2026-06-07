import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminInviteCodeRoutes } from './invite-codes'

function app(role: string | null = 'admin') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/invite-codes', adminInviteCodeRoutes)
  return app
}

function createDb() {
  const executed: Array<{ sql: string; params: unknown[] }> = []
  return {
    executed,
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async all() {
          if (sql.includes('FROM invite_codes')) {
            return {
              results: [{
                id: 'inv_1',
                display_code: 'ABCD...1234',
                name: '活动',
                channel: 'manual',
                inviter_user_id: null,
                status: 'active',
                max_uses: null,
                used_count: 0,
                expires_at: null,
                created_by: 1,
                created_at: '2026-06-01T00:00:00.000Z',
                updated_at: '2026-06-01T00:00:00.000Z',
                note: '',
              }],
            }
          }
          return { results: [] }
        },
        async first() {
          if (sql.includes('SELECT id FROM invite_codes WHERE code_hash = ?')) return null
          if (sql.includes('FROM invite_codes') && params[0] === 'missing') return null
          if (sql.includes('FROM invite_codes')) {
            return {
              id: params[0],
              display_code: 'ABCD...1234',
              name: '活动',
              channel: 'manual',
              inviter_user_id: null,
              status: 'active',
              max_uses: null,
              used_count: 0,
              expires_at: null,
              created_by: 1,
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z',
              note: '',
            }
          }
          return null
        },
        async run() {
          executed.push({ sql, params: [...params] })
          return { meta: { changes: 1 } }
        },
      }
    },
  }
}

describe('后台邀请码 API', () => {
  it('管理员可以查看邀请码列表', async () => {
    const res = await app().request('/api/admin/invite-codes', {}, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0]).toMatchObject({ id: 'inv_1', displayCode: 'ABCD...1234' })
  })

  it('创建邀请码返回明文 code 但审计日志不包含 code_hash', async () => {
    const db = createDb()
    const res = await app().request('/api/admin/invite-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '夏季活动', channel: 'telegram', code: 'summer-001' }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.code).toBe('SUMMER-001')
    const audit = db.executed.find(call => call.sql.includes('INSERT INTO admin_audit_logs'))
    expect(audit).toBeTruthy()
    expect(String(audit?.params[6])).not.toContain('code_hash')
    expect(String(audit?.params[6])).not.toContain('SUMMER-001')
  })

  it('禁用邀请码会写审计日志', async () => {
    const db = createDb()
    const res = await app().request('/api/admin/invite-codes/inv_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disable: true }),
    }, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
    expect(db.executed.some(call => call.sql.includes('UPDATE invite_codes'))).toBe(true)
    const audit = db.executed.find(call => call.sql.includes('INSERT INTO admin_audit_logs'))
    expect(audit?.params[2]).toBe('invite_code.disable')
  })
})
