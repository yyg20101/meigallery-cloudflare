import { describe, expect, it } from 'vitest'
import {
  META_CAPI_INCIDENT_CATEGORIES,
  metaCapiIncidentSummary,
  sanitizeMetaCapiIncidentEvidence,
} from './meta-capi-incident-evidence'

describe('Meta CAPI incident evidence sanitizer', () => {
  it('按 trigger code 只接受逐字段显式 allowlist 与固定 category', () => {
    const evidence = {
      totalCount: 20,
      failedCount: 2,
      failedRate: 0.1,
      errorCategory: 'client_error',
      windowStart: '2026-07-11T00:00:00.000Z',
      windowEnd: '2026-07-11T00:15:00.000Z',
      observedAt: '2026-07-11T00:15:00.000Z',
    }
    expect(sanitizeMetaCapiIncidentEvidence('permanent_failure_rate', evidence)).toEqual(evidence)
    expect(() => sanitizeMetaCapiIncidentEvidence('meta_permission_denied', evidence)).toThrow(/evidence/i)
  })

  it.each(['pixelCount', 'userCount', 'payloadCount', 'rawResponse', 'exceptionMessage'])(
    'reject 模式拒绝未知或敏感字段 %s，drop 模式逐字段丢弃',
    field => {
      const evidence = { failedCount: 1, errorCategory: 'permission_denied', [field]: 9 }
      expect(() => sanitizeMetaCapiIncidentEvidence('meta_permission_denied', evidence)).toThrow(/evidence/i)
      expect(sanitizeMetaCapiIncidentEvidence('meta_permission_denied', evidence, 'drop')).toEqual({
        failedCount: 1,
        errorCategory: 'permission_denied',
      })
    },
  )

  it.each([
    null,
    [],
    'not-an-object',
    { failedCount: -1 },
    { failedCount: 1.5 },
    { failedRate: 1.1 },
    { errorCategory: 'server_error' },
    { windowStart: '2026-07-11 00:00:00' },
    { failedCount: { value: 1 } },
  ])('拒绝非法 evidence %#', value => {
    expect(() => sanitizeMetaCapiIncidentEvidence('meta_permission_denied', value)).toThrow(/evidence/i)
  })

  it('未知 trigger 不信任数据库 summary 或 evidence', () => {
    expect(metaCapiIncidentSummary('future_trigger')).toBe('未知 Meta CAPI incident')
    expect(sanitizeMetaCapiIncidentEvidence('future_trigger', { userCount: 1 }, 'drop')).toEqual({})
    expect(() => sanitizeMetaCapiIncidentEvidence('future_trigger', {})).toThrow(/evidence/i)
  })

  it('保留集中定义的稳定 category 清单', () => {
    expect(META_CAPI_INCIDENT_CATEGORIES).toContain('permission_denied')
    expect(META_CAPI_INCIDENT_CATEGORIES).toContain('decryption_failed')
    expect(META_CAPI_INCIDENT_CATEGORIES).not.toContain('Graph Error 400')
  })
})
