import { describe, expect, it, vi } from 'vitest'
import { validateSession } from './session'

describe('会话工具', () => {
  it('同名会话 Cookie 同时存在时使用有效 token', async () => {
    const validToken = 'valid-token'
    const validHash = await hashTokenForTest(validToken)
    const db = createSessionDbMock(validHash)
    const context = createContextWithCookie(`mei_session=stale-token; mei_session=${validToken}`)

    await expect(validateSession({ ...context, env: { ...context.env, DB: db.database } } as any)).resolves.toEqual({
      userId: 123,
      role: 'user',
    })
  })
})

function createSessionDbMock(validHash: string) {
  const first = vi.fn(async (hash?: string) => {
    if (hash !== validHash) return null
    return {
      session_id: 'ses_valid',
      user_id: 123,
      expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
      role: 'user',
      status: 'active',
    }
  })
  const run = vi.fn(async () => ({ success: true }))
  const bind = vi.fn((...args: unknown[]) => ({ first: () => first(args[0] as string), run }))
  const prepare = vi.fn(() => ({ bind }))

  return {
    database: { prepare } as unknown as D1Database,
    first,
  }
}

function createContextWithCookie(cookie: string) {
  return {
    env: { APP_ENV: 'production' },
    req: { raw: { headers: new Headers({ Cookie: cookie }) } },
    header: vi.fn(),
  }
}

async function hashTokenForTest(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
