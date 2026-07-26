import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testPlatformConnection } from './connection-diagnostics'

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  readCredential: vi.fn(),
  normalizeTestEventCode: vi.fn(),
  test: vi.fn(),
}))

vi.mock('./connections', () => ({
  readAttributionConnectionSnapshot: mocks.readSnapshot,
}))

vi.mock('./credential-vault', () => ({
  readAttributionCredential: mocks.readCredential,
}))

vi.mock('./connection-test-adapter', async importOriginal => ({
  ...await importOriginal<typeof import('./connection-test-adapter')>(),
  getPlatformConnectionTestAdapter: () => ({
    provider: 'meta',
    normalizeTestEventCode: mocks.normalizeTestEventCode,
    test: mocks.test,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.normalizeTestEventCode.mockReturnValue('TEST12345')
  mocks.readCredential.mockResolvedValue('secret-token')
  mocks.readSnapshot.mockResolvedValue({
    state: 'ready',
    connection: {
      id: 'conn_meta',
      provider: 'meta',
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      publicConfig: { pixelId: '123456789' },
      outboxScope: 'connection_scope_1',
    },
    bindings: new Map([
      ['Contact', { enabled: true, browserDestination: 'meta_pixel', serverDestination: 'meta_capi' }],
      ['CompleteRegistration', { enabled: true, browserDestination: 'meta_pixel', serverDestination: 'meta_capi' }],
    ]),
    credential: { type: 'access_token', schemaVersion: 1, revision: 'credential_1' },
  })
  mocks.test.mockResolvedValue({
    schemaVersion: 1,
    provider: 'meta',
    targetValid: true,
    credentialValid: true,
    bindingsValid: true,
    testEventsSent: 2,
    externalEventIds: ['contact-id', 'registration-id'],
    requestIds: ['request-id'],
    checkedAt: '2026-07-26T00:00:00.000Z',
  })
})

describe('平台连接即时诊断', () => {
  it('重复测试使用相同诊断编号且不持久化工作流状态', async () => {
    const env = {
      DB: {} as D1Database,
      SITE_URL: 'https://616618.xyz',
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'key',
    }
    const first = await testPlatformConnection(env, { provider: 'meta', testEventCode: 'TEST12345' })
    const second = await testPlatformConnection(env, { provider: 'meta', testEventCode: 'TEST12345' })

    expect(first).toEqual(second)
    expect(mocks.test.mock.calls[0]?.[0].testId).toBe(mocks.test.mock.calls[1]?.[0].testId)
    expect(mocks.test.mock.calls[0]?.[0].testId).toMatch(/^diag_meta_[0-9a-f]{32}$/)
    expect(JSON.stringify(first)).not.toContain('secret-token')
  })

  it('测试码无效或连接不存在时立即失败', async () => {
    mocks.normalizeTestEventCode.mockReturnValueOnce(null)
    await expect(testPlatformConnection({
      DB: {} as D1Database,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'key',
    }, { provider: 'meta', testEventCode: 'bad' })).rejects.toMatchObject({
      code: 'AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID',
    })

    mocks.normalizeTestEventCode.mockReturnValueOnce('TEST12345')
    mocks.readSnapshot.mockResolvedValueOnce({ state: 'connection_invalid', reason: 'not_found' })
    await expect(testPlatformConnection({
      DB: {} as D1Database,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'key',
    }, { provider: 'meta', testEventCode: 'TEST12345' })).rejects.toThrow('AD_PLATFORM_CONNECTION_INVALID')
  })
})
