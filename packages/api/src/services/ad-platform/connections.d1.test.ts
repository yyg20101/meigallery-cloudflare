import { describe, expect, it } from 'vitest'
import { readAttributionConnectionSnapshot } from './connections'

type SnapshotRow = Record<string, unknown>

describe('归因连接快照', () => {
  it('单次 JOIN 查询返回严格校验后的 ready 快照', async () => {
    const db = snapshotDb(validRows())
    const snapshot = await readAttributionConnectionSnapshot(db as unknown as D1Database, 'meta')
    expect(db.calls).toHaveLength(1)
    expect(snapshot).toMatchObject({ state: 'ready', connection: { provider: 'meta', id: 'conn_meta' } })
    expect(snapshot.state === 'ready' && [...snapshot.bindings.keys()]).toEqual(['Contact', 'CompleteRegistration'])
  })

  it('未知 provider 在查询前 fail closed', async () => {
    const db = snapshotDb([])
    await expect(readAttributionConnectionSnapshot(db as unknown as D1Database, 'unknown')).resolves.toMatchObject({ state: 'connection_invalid', reason: 'provider_unknown' })
    expect(db.calls).toHaveLength(0)
  })

  it.each([
    ['额外 binding', (rows: SnapshotRow[]) => [...rows, { ...rows[0], binding_id: 'binding_extra', canonical_event: 'UnexpectedEvent' }]],
    ['重复 binding', (rows: SnapshotRow[]) => [...rows, { ...rows[0], binding_id: 'binding_duplicate' }]],
    ['额外 credential', (rows: SnapshotRow[]) => [...rows, { ...rows[0], credential_id: 'credential_extra', key_id: 'fedcba9876543210' }]],
    ['冲突 credential', (rows: SnapshotRow[]) => [...rows, { ...rows[0], key_id: 'fedcba9876543210' }]],
    ['binding provider 不匹配', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, binding_provider: 'google' }))],
    ['credential provider 不匹配', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, credential_provider: 'google' }))],
    ['无效 public config', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, public_config_json: '{invalid' }))],
    ['额外 public config', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, public_config_json: '{"pixelId":"1234567890123456","unexpected":"x"}' }))],
    ['credential type 不匹配', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, credential_type: 'service_account_json' }))],
    ['credential schema 不匹配', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, schema_version: 2 }))],
    ['binding revision 不匹配', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, mapping_revision: 'other_revision' }))],
    ['credential revision 不匹配', (rows: SnapshotRow[]) => rows.map(row => ({ ...row, credential_row_revision: 'other_revision' }))],
  ])('%s 时 fail closed', async (_label, mutate) => {
    const snapshot = await readAttributionConnectionSnapshot(snapshotDb(mutate(validRows())) as unknown as D1Database, 'meta')
    expect(snapshot).toMatchObject({ state: 'connection_invalid' })
  })
})

function snapshotDb(rows: SnapshotRow[]) {
  const calls: string[] = []
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql)
      return { bind: () => ({ all: async () => ({ results: rows }) }) }
    },
  }
}

function validRows(): SnapshotRow[] {
  return ['Contact', 'CompleteRegistration'].map((canonical_event, index) => ({
    connection_id: 'conn_meta', provider: 'meta', enabled: 1, mode: 'production', browser_enabled: 1, server_enabled: 1,
    public_config_json: '{"pixelId":"1234567890123456"}', rollout_target_percentage: 100, rollout_effective_percentage: 100,
    connection_revision: 'revision_1', credential_revision: 'credential_revision_1', binding_id: `binding_${index + 1}`,
    canonical_event, binding_provider: 'meta', binding_enabled: 1, browser_destination: 'meta_pixel', server_destination: 'meta_capi',
    mapping_revision: 'revision_1', credential_id: 'credential_1', credential_provider: 'meta', credential_type: 'access_token',
    schema_version: 1, credential_row_revision: 'credential_revision_1', key_id: '0123456789abcdef',
  }))
}
