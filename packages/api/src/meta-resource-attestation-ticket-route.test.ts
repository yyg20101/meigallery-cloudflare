import { beforeEach, describe, expect, it } from 'vitest'
import { resetRateLimitStoreForTest } from './middleware/rate-limit'
import type { Bindings } from './index'
import app from './index'

const PATH = '/api/admin/attribution/meta/resource-attestation-ticket'
const NONCE = `nonce_${'a'.repeat(32)}`

beforeEach(() => {
  resetRateLimitStoreForTest()
})

describe('Meta resource attestation ticket 签发路由缓存控制', () => {
  it('真实全局路由的成功、业务失败和 Owner 拒绝响应均 no-store', async () => {
    const success = await request('owner')
    expect(success.status).toBe(200)
    expect(success.headers.get('cache-control')).toBe('no-store')

    const failure = await request('owner', { failTicketIssue: true, ip: '203.0.113.11' })
    expect(failure.status).toBe(409)
    expect(failure.headers.get('cache-control')).toBe('no-store')

    const forbidden = await request('admin', { ip: '203.0.113.12' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('cache-control')).toBe('no-store')
  })

  it('管理员限流在 handler 前返回 429 时仍 no-store', async () => {
    for (let index = 0; index < 120; index += 1) {
      expect((await request('owner', { ip: '203.0.113.13' })).status).toBe(200)
    }

    const limited = await request('owner', { ip: '203.0.113.13' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('cache-control')).toBe('no-store')
  })

  it('不会给其他管理员路由添加 no-store', async () => {
    const response = await app.fetch(new Request('https://api.test/api/admin/attribution/meta/test-event', {
      method: 'POST',
    }), ticketEnv('owner'), {} as ExecutionContext)

    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBeNull()
  })
})

function request(role: 'admin' | 'owner', options: { failTicketIssue?: boolean; ip?: string } = {}) {
  return app.fetch(new Request(`https://api.test${PATH}`, {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': options.ip ?? '203.0.113.10',
      'Content-Type': 'application/json',
      Cookie: 'mei_session=test-session',
    },
    body: JSON.stringify({ nonce: NONCE }),
  }), ticketEnv(role, options.failTicketIssue), {} as ExecutionContext)
}

function ticketEnv(role: 'admin' | 'owner', failTicketIssue = false) {
  return {
    APP_ENV: 'production',
    RELEASE_COMMIT: 'a'.repeat(40),
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this },
          async first<T>() {
            if (sql.includes('FROM sessions')) {
              return {
                session_id: 'ses_ticket_route',
                user_id: 1,
                expires_at: '2099-01-01T00:00:00.000Z',
                role,
                status: 'active',
              } as T
            }
            return null as T | null
          },
          async run() {
            return { meta: { changes: sql.includes('INSERT INTO meta_resource_attestation_tickets') && failTicketIssue ? 0 : 1 } }
          },
        }
      },
    },
  } as unknown as Bindings
}
