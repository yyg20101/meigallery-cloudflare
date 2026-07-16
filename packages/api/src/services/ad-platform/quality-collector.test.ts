import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  readCredential: vi.fn(),
  fetchQuality: vi.fn(),
}))

vi.mock('./connections', () => ({ readAttributionConnectionSnapshot: mocks.readSnapshot }))
vi.mock('./credential-vault', () => ({ readAttributionCredential: mocks.readCredential }))
vi.mock('./adapters/meta-quality', () => ({ fetchMetaQuality: mocks.fetchQuality }))

import { collectAttributionQuality } from './quality-collector'

function createDb() {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this },
        async run() { statements.push({ sql, values: this.values }); return { meta: { changes: 1 } } },
      }
    },
    async batch(items: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(items.map(item => item.run()))
    },
  } as unknown as D1Database
  return { db, statements }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readSnapshot.mockResolvedValue({
    state: 'ready',
    connection: {
      id: 'conn_meta', provider: 'meta', enabled: true, mode: 'production',
      publicConfig: { pixelId: '1277657707436781' }, credentialRevision: 'credential_revision',
    },
  })
  mocks.readCredential.mockResolvedValue('private-token')
})

describe('通用归因质量采集', () => {
  it('从通用连接和凭证库采集并写入通用快照', async () => {
    const { db, statements } = createDb()
    mocks.fetchQuality.mockResolvedValue({
      metrics: [{ canonicalEvent: 'Contact', metricKey: 'emq_score', value: 8.5 }],
      errorCategory: '',
    })
    const result = await collectAttributionQuality({
      APP_ENV: 'production',
      DB: db,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'master-key',
    }, new Date('2026-07-16T00:00:00.000Z'))
    expect(result).toEqual({ status: 'success', metricCount: 1, errorCategory: '' })
    expect(mocks.readCredential).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      connectionId: 'conn_meta', provider: 'meta', credentialRevision: 'credential_revision',
    }))
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain('INSERT INTO attribution_quality_snapshots')
    expect(JSON.stringify(statements)).not.toContain('private-token')
  })

  it('dev 不读取连接、凭证或平台网络', async () => {
    const { db, statements } = createDb()
    const result = await collectAttributionQuality({
      APP_ENV: 'dev',
      DB: db,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'master-key',
    })
    expect(result.status).toBe('skipped')
    expect(mocks.readSnapshot).not.toHaveBeenCalled()
    expect(mocks.readCredential).not.toHaveBeenCalled()
    expect(mocks.fetchQuality).not.toHaveBeenCalled()
    expect(statements).toEqual([])
  })

  it('平台权限失败写入通用错误快照', async () => {
    const { db, statements } = createDb()
    mocks.fetchQuality.mockResolvedValue({ metrics: [], errorCategory: 'permission_denied' })
    const result = await collectAttributionQuality({
      APP_ENV: 'production',
      DB: db,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'master-key',
    })
    expect(result).toEqual({ status: 'error', metricCount: 0, errorCategory: 'permission_denied' })
    expect(statements).toHaveLength(2)
    expect(statements.every(item => item.sql.includes('attribution_quality_snapshots'))).toBe(true)
  })
})
