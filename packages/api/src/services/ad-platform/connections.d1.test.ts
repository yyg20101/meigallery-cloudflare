import { describe, expect, it } from 'vitest'
import { readAttributionConnectionSnapshot } from './connections'

describe('归因连接快照', () => {
  it('使用单次查询读取并拒绝 revision 不一致', async () => {
    const calls: string[] = []
    const db = {
      prepare(sql: string) {
        calls.push(sql)
        return {
          bind: () => ({ all: async () => ({ results: [{
            connection_id: 'conn_meta', provider: 'meta', enabled: 1, mode: 'production',
            browser_enabled: 1, server_enabled: 1, public_config_json: '{"pixelId":"123"}',
            rollout_target_percentage: 100, rollout_effective_percentage: 100,
            connection_revision: 'connection_1', credential_revision: 'credential_1',
            canonical_event: 'Contact', binding_provider: 'meta', binding_enabled: 1,
            browser_destination: 'meta_pixel', server_destination: 'meta_capi', mapping_revision: 'other',
            credential_provider: 'meta', credential_type: 'access_token', schema_version: 1,
            credential_row_revision: 'credential_1', key_id: '0123456789abcdef',
          }] }) }),
        }
      },
    }
    const snapshot = await readAttributionConnectionSnapshot(db as unknown as D1Database, 'meta')
    expect(calls).toHaveLength(1)
    expect(snapshot).toMatchObject({ state: 'connection_invalid' })
  })
})
