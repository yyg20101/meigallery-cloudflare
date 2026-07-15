import { describe, expect, it, vi } from 'vitest'
import { clearGoogleAccessTokenCacheForTests } from './google-auth'
import { buildGoogleServerRequest, sendGoogleServerEvent } from './google-server'

const input = {
  provider: 'google' as const,
  canonicalEvent: 'Contact' as const,
  externalEventId: 'mg3_google_event_1',
  eventTime: 1_784_256_123,
  pageUrl: 'https://meigallery.example/contact',
  destination: '123456789',
  matchSignals: { gclid: 'gclid-1', gbraid: 'gbraid-1', wbraid: 'wbraid-1' },
  hashedEmail: 'c'.repeat(64), validateOnly: true,
}

describe('Google Data Manager 服务端 Adapter', () => {
  it('构造最新 events:ingest 请求，不写顶层 requestId', () => {
    expect(buildGoogleServerRequest(input, { customerId: '1112223333', loginCustomerId: '9998887777', cloudProjectId: 'project-1' })).toEqual({
      validateOnly: true, encoding: 'HEX',
      destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1112223333' }, loginAccount: { accountType: 'GOOGLE_ADS', accountId: '9998887777' }, productDestinationId: '123456789' }],
      events: [{ eventTimestamp: '2026-07-17T02:42:03.000Z', transactionId: 'mg3_google_event_1', eventSource: 'WEB', adIdentifiers: { gclid: 'gclid-1', gbraid: 'gbraid-1', wbraid: 'wbraid-1' }, userData: { userIdentifiers: [{ emailAddress: 'c'.repeat(64) }] } }],
    })
  })

  it('发送 Authorization、x-goog-user-project，且绝不发送 Developer Token', async () => {
    clearGoogleAccessTokenCacheForTests()
    const fetcher = vi.fn(async (url: string) => url.includes('/token')
      ? new Response(JSON.stringify({ access_token: 'google-access-token', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ requestId: 'google-request-1', access_token: 'should-not-leak' }), { status: 200 }))
    const outcome = await sendGoogleServerEvent({ input, config: { customerId: '1112223333', cloudProjectId: 'project-1' }, serviceAccount: await serviceAccount(), fetcher })
    const [, init] = fetcher.mock.calls[1]!
    expect(init?.headers).toEqual({ Authorization: 'Bearer google-access-token', 'Content-Type': 'application/json', 'x-goog-user-project': 'project-1' })
    expect(JSON.stringify(init?.headers)).not.toContain('Developer')
    expect(outcome).toEqual({ classification: 'accepted', receipt: { status: 200, requestId: 'google-request-1' } })
    expect(JSON.stringify(outcome)).not.toContain('should-not-leak')
  })

  it.each([['fbc'], ['fbp'], ['ttclid'], ['ttp']])('拒绝跨平台 %s', async signal => {
    const outcome = await sendGoogleServerEvent({ input: { ...input, matchSignals: { ...input.matchSignals, [signal]: 'cross-platform-id' } }, config: { customerId: '1112223333', cloudProjectId: 'project-1' }, serviceAccount: await serviceAccount(), fetcher: vi.fn() })
    expect(outcome).toEqual({ classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } })
  })

  it.each([[401, 'credential_invalid'], [429, 'retryable'], [503, 'retryable'], [400, 'destination_invalid'], [409, 'rejected']] as const)('清洗失败响应并按状态码分类 %i', async (status, classification) => {
    clearGoogleAccessTokenCacheForTests()
    const fetcher = vi.fn(async (url: string) => url.includes('/token')
      ? new Response(JSON.stringify({ access_token: 'google-access-token', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: 'google-access-token' } }), { status }))
    const outcome = await sendGoogleServerEvent({ input, config: { customerId: '1112223333', cloudProjectId: 'project-1' }, serviceAccount: await serviceAccount(), fetcher })
    expect(outcome).toEqual({ classification, receipt: { status } })
    expect(JSON.stringify(outcome)).not.toContain('google-access-token')
  })
})

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return JSON.stringify({ type: 'service_account', client_email: 'google-adapter@project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...privateKey))}\n-----END PRIVATE KEY-----\n` })
}
