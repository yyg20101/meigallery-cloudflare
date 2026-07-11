import { describe, expect, it } from 'vitest'
import { validateMetaCapiIncidentEvidence } from './meta-capi-incident-evidence'

describe('Meta CAPI incident evidence validator', () => {
  it('只接受脱敏计数、比率、稳定错误分类和 UTC 时间窗', () => {
    const evidence = {
      failedCount: 12,
      retry_rate: 0.25,
      deliveryPercentage: 50,
      errorCategory: 'rate_limited',
      clientCategory: 'client_error',
      authCategory: 'authorization_failed',
      windowStart: '2026-07-11T00:00:00.000Z',
      window_end: '2026-07-11T00:15:00.000Z',
    }

    expect(validateMetaCapiIncidentEvidence(evidence)).toEqual(evidence)
    expect(validateMetaCapiIncidentEvidence({})).toEqual({})
  })

  it.each([
    ['access_token', 'redacted'],
    ['secret', 'redacted'],
    ['email', 'redacted'],
    ['clientIp', 'redacted'],
    ['ip', 'redacted'],
    ['user_agent', 'redacted'],
    ['authorization', 'redacted'],
    ['authorizationCategory', 'redacted'],
    ['credential', 'redacted'],
    ['credentialCount', 1],
    ['cookie', 'redacted'],
    ['cookieCount', 1],
    ['session', 'redacted'],
    ['sessionCount', 1],
    ['ipCount', 1],
    ['fbp', 'redacted'],
    ['fbc', 'redacted'],
    ['externalEventId', 'redacted'],
    ['payload_hash', 'redacted'],
  ])('拒绝敏感键 %s', (key, item) => {
    expect(() => validateMetaCapiIncidentEvidence({ [key]: item })).toThrow(/evidence/i)
  })

  it.each([
    'token=EAAB-sensitive',
    'owner@example.com',
    '203.0.113.42',
    '2001:db8::1',
    'Mozilla/5.0 (Macintosh)',
    'Agent/1.0',
    'Browser',
    'Browser/122.0',
    'Client',
    'Client/1.2',
    'curl/8.7.1',
    'okhttp/4.12.0',
    'fb.1.1712345678.nondigit-value',
    'meta:Contact:external-123',
    'a'.repeat(64),
    'Bearer secret-value',
  ])('拒绝可能泄漏敏感信息的值', (value) => {
    expect(() => validateMetaCapiIncidentEvidence({ errorCategory: value })).toThrow(/evidence/i)
  })

  it.each([
    null,
    [],
    'not-an-object',
    { rawResponse: 'permission denied' },
    { failedCount: -1 },
    { failedCount: 1.5 },
    { retryRate: 1.1 },
    { deliveryPercentage: 101 },
    { errorCategory: 'Graph Error 400' },
    { windowStart: '2026-07-11 00:00:00' },
    { nestedCount: { value: 1 } },
  ])('拒绝非白名单或非法 evidence %#', (value) => {
    expect(() => validateMetaCapiIncidentEvidence(value)).toThrow(/evidence/i)
  })
})
