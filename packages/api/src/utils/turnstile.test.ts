import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateTurnstile, verifyTurnstileToken } from './turnstile'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Turnstile Siteverify', () => {
  it('发送幂等标识和可信 IP，并校验 action 与 hostname', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'app_login',
      hostname: 'api.example.com',
    }), { status: 200 }))

    await expect(verifyTurnstileToken('secret', 'token', {
      remoteIp: '203.0.113.8',
      expectedAction: 'app_login',
      expectedHostname: 'api.example.com',
    })).resolves.toEqual({ status: 'verified' })

    const request = fetchMock.mock.calls[0]?.[1]
    const payload = JSON.parse(String(request?.body)) as Record<string, string>
    expect(payload).toMatchObject({
      secret: 'secret',
      response: 'token',
      remoteip: '203.0.113.8',
    })
    expect(payload.idempotency_key).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('服务商 success 为真但 action 不匹配时仍拒绝', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'app_register',
      hostname: 'api.example.com',
    }), { status: 200 }))

    await expect(verifyTurnstileToken('secret', 'token', {
      expectedAction: 'app_login',
    })).resolves.toEqual({ status: 'rejected', reason: 'action' })
  })

  it('仅允许 local 兼容 Cloudflare 官方 always-pass 密钥的 test 或缺失 action', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const officialTestSecret = '1x0000000000000000000000000000000AA'

    for (const action of ['test', undefined]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        action,
        hostname: 'localhost',
      }), { status: 200 }))
      await expect(validateTurnstile(
        { APP_ENV: 'local', TURNSTILE_SECRET_KEY: officialTestSecret },
        'XXXX.DUMMY.TOKEN.XXXX',
        { expectedAction: 'app_login' },
      )).resolves.toBeNull()
    }

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      hostname: 'localhost',
    }), { status: 200 }))
    await expect(validateTurnstile(
      { APP_ENV: 'production', TURNSTILE_SECRET_KEY: officialTestSecret },
      'XXXX.DUMMY.TOKEN.XXXX',
      { expectedAction: 'app_login' },
    )).resolves.toMatchObject({ status: 400 })
  })

  it('Siteverify 网络或响应异常时 fail closed 为可重试错误', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))

    await expect(validateTurnstile(
      { APP_ENV: 'production', TURNSTILE_SECRET_KEY: 'secret' },
      'token',
      { expectedAction: 'app_login' },
    )).resolves.toMatchObject({ status: 503 })
  })

  it('超长 token 在调用 Siteverify 前直接拒绝', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(validateTurnstile(
      { APP_ENV: 'production', TURNSTILE_SECRET_KEY: 'secret' },
      'x'.repeat(2049),
    )).resolves.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
