import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRateLimitStoreForTest } from './middleware/rate-limit'
import type { Bindings } from './index'
import app from './index'

const { consumeTicketMock } = vi.hoisted(() => ({
  consumeTicketMock: vi.fn(),
}))

vi.mock('./services/meta-resource-attestation-ticket', async importOriginal => ({
  ...await importOriginal<typeof import('./services/meta-resource-attestation-ticket')>(),
  consumeMetaResourceAttestationTicket: consumeTicketMock,
}))

const NONCE = `nonce_${'a'.repeat(64)}`
const TICKET = `mrat_${'b'.repeat(64)}`

beforeEach(() => {
  resetRateLimitStoreForTest()
  consumeTicketMock.mockReset()
  consumeTicketMock.mockResolvedValue({
    attestation: {
      schemaVersion: 2,
      environment: 'production',
      commitSha: 'c'.repeat(40),
      nonce: NONCE,
      issuedAt: '2026-07-11T00:00:00.000Z',
      expiresAt: '2026-07-11T00:05:00.000Z',
      identities: {
        pixel: `hmac-sha256:${'1'.repeat(64)}`,
        token: `hmac-sha256:${'2'.repeat(64)}`,
        dataKey: `hmac-sha256:${'4'.repeat(64)}`,
      },
    },
    ownerUserId: 1,
  })
})

describe('公开 Meta resource attestation 路由', () => {
  it('ticket consume 成功和失败均 no-store，且响应不回显 ticket', async () => {
    const success = await request('203.0.113.10')
    expect(success.status).toBe(200)
    expect(success.headers.get('cache-control')).toBe('no-store')
    expect(await success.text()).not.toContain(TICKET)

    consumeTicketMock.mockRejectedValueOnce(new Error('ticket invalid'))
    const failed = await request('203.0.113.11')
    expect(failed.status).toBe(409)
    expect(failed.headers.get('cache-control')).toBe('no-store')
    expect(await failed.text()).not.toContain(TICKET)
  })

  it('复用公开 API 的 IP 应用层限流，第 61 次在消费 ticket 前返回 429', async () => {
    for (let index = 0; index < 60; index += 1) {
      expect((await request('203.0.113.12')).status).toBe(200)
    }
    const limited = await request('203.0.113.12')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('cache-control')).toBe('no-store')
    expect(consumeTicketMock).toHaveBeenCalledTimes(60)
  })
})

function request(ip: string) {
  return app.fetch(new Request('https://api.test/api/meta/resource-attestation', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': ip,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ nonce: NONCE, ticket: TICKET }),
  }), {
    APP_ENV: 'production',
    DB: {
      prepare: () => ({
        bind() { return this },
        async run() { return { meta: { changes: 1 } } },
      }),
    },
  } as unknown as Bindings)
}
