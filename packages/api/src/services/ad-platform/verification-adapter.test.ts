import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGoogleAccessTokenCacheForTests } from './adapters/google-auth'
import { getPlatformVerificationAdapter, type PlatformVerificationAdapterInput } from './verification-adapter'

const fixedBindings = [
  { canonicalEvent: 'Contact' as const, enabled: true, browserDestination: 'browser', serverDestination: 'server' },
  { canonicalEvent: 'CompleteRegistration' as const, enabled: true, browserDestination: 'browser', serverDestination: 'server' },
]

describe('平台连接验证 Adapter', () => {
  beforeEach(() => clearGoogleAccessTokenCacheForTests())

  it('Meta 重试复用确定性事件编号，且不返回凭证和测试码', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events_received: 2 }), {
      status: 200,
      headers: { 'x-fb-trace-id': 'meta-trace-1' },
    }))
    const input: PlatformVerificationAdapterInput = {
      verificationId: 'verify:meta:1',
      provider: 'meta',
      publicConfig: { pixelId: '1234567890123456' },
      eventBindings: fixedBindings,
      credential: 'meta-secret-token',
      testEventCode: 'TEST90001',
      siteUrl: 'https://616618.xyz',
      fetcher,
    }
    const adapter = getPlatformVerificationAdapter('meta')!
    const first = await adapter.verify(input)
    const second = await adapter.verify(input)
    expect(second.externalEventIds).toEqual(first.externalEventIds)
    expect(first).toMatchObject({ provider: 'meta', testEventsSent: 2, requestIds: ['meta-trace-1'] })
    expect(JSON.stringify(first)).not.toMatch(/meta-secret-token|TEST90001/)
  })

  it('TikTok 发送同批 Contact 与 CompleteRegistration 测试事件', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, request_id: 'tt-request-1' }), { status: 200 }))
    const result = await getPlatformVerificationAdapter('tiktok')!.verify({
      verificationId: 'verify:tiktok:1',
      provider: 'tiktok',
      publicConfig: { pixelCode: 'ABCDEF123456' },
      eventBindings: fixedBindings,
      credential: 'tiktok-secret-token',
      testEventCode: 'TEST_1234',
      siteUrl: 'https://616618.xyz',
      fetcher,
    })
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect((request.data as Array<{ event: string }>).map(item => item.event)).toEqual(['Contact', 'CompleteRegistration'])
    expect(result).toMatchObject({ provider: 'tiktok', testEventsSent: 2, requestIds: ['tt-request-1'] })
    expect(JSON.stringify(result)).not.toMatch(/tiktok-secret-token|TEST_1234/)
  })

  it('Google 只执行 validateOnly 并校验两个 conversion action', async () => {
    const serviceAccount = await createServiceAccount()
    const fetcher = vi.fn(async (url: string) => url.includes('/token')
      ? new Response(JSON.stringify({ access_token: 'google-access-token', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ requestId: `google-request-${fetcher.mock.calls.length}` }), { status: 200 }))
    const result = await getPlatformVerificationAdapter('google')!.verify({
      verificationId: 'verify:google:1',
      provider: 'google',
      publicConfig: { tagId: 'AW-123456789', customerId: '1234567890', cloudProjectId: 'project-1' },
      eventBindings: [
        { canonicalEvent: 'Contact', enabled: true, browserDestination: 'AW-123456789/contact-label', serverDestination: '111222333' },
        { canonicalEvent: 'CompleteRegistration', enabled: true, browserDestination: 'AW-123456789/register-label', serverDestination: '444555666' },
      ],
      credential: serviceAccount,
      siteUrl: 'https://616618.xyz',
      fetcher,
    })
    const eventRequests = fetcher.mock.calls.filter(call => String(call[0]).includes('datamanager.googleapis.com'))
    expect(eventRequests).toHaveLength(2)
    expect(eventRequests.map(call => JSON.parse(String(call[1]?.body)).validateOnly)).toEqual([true, true])
    expect(eventRequests.map(call => JSON.parse(String(call[1]?.body)).destinations[0].productDestinationId))
      .toEqual(['111222333', '444555666'])
    expect(result).toMatchObject({ provider: 'google', testEventsSent: 0 })
    expect(JSON.stringify(result)).not.toMatch(/private_key|google-access-token/)
  })
})

async function createServiceAccount() {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify'])
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return JSON.stringify({
    type: 'service_account',
    client_email: 'verification@project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...privateKey))}\n-----END PRIVATE KEY-----\n`,
  })
}
