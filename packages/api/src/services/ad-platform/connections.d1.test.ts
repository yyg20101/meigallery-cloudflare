import { describe, expect, it } from 'vitest'
import { readAttributionConnectionSnapshot } from './connections'

type SnapshotState = ReturnType<typeof validState>

describe('归因连接快照', () => {
  it('使用三张表的直接查询返回严格校验后的 ready 快照', async () => {
    const db = snapshotDb(validState())
    const snapshot = await readAttributionConnectionSnapshot(db as unknown as D1Database, 'meta')

    expect(db.calls).toHaveLength(3)
    expect(snapshot).toMatchObject({
      state: 'ready',
      connection: { provider: 'meta', id: 'conn_meta', outboxScope: 'connection_scope_1' },
      credential: { type: 'access_token', revision: 'credential_revision_1' },
    })
    expect(snapshot.state === 'ready' && [...snapshot.bindings.keys()]).toEqual([
      'CompleteRegistration',
      'Contact',
    ])
  })

  it('未知 provider 在查询前 fail closed', async () => {
    const db = snapshotDb(validState())
    await expect(readAttributionConnectionSnapshot(db as unknown as D1Database, 'unknown'))
      .resolves.toMatchObject({ state: 'connection_invalid', reason: 'provider_unknown' })
    expect(db.calls).toHaveLength(0)
  })

  it.each([
    ['额外 binding', (state: SnapshotState) => state.bindings.push({ ...state.bindings[0]!, id: 'binding_extra' })],
    ['重复 binding', (state: SnapshotState) => { state.bindings[1] = { ...state.bindings[0]!, id: 'binding_duplicate' } }],
    ['额外 credential', (state: SnapshotState) => state.credentials.push({ ...state.credentials[0]!, id: 'credential_extra' })],
    ['binding provider 不匹配', (state: SnapshotState) => { state.bindings[0]!.provider = 'google' }],
    ['credential provider 不匹配', (state: SnapshotState) => { state.credentials[0]!.provider = 'google' }],
    ['无效 public config', (state: SnapshotState) => { state.connection.public_config_json = '{invalid' }],
    ['额外 public config', (state: SnapshotState) => { state.connection.public_config_json = '{"pixelId":"123456789012345","unexpected":"x"}' }],
    ['credential type 不匹配', (state: SnapshotState) => { state.credentials[0]!.credential_type = 'service_account_json' }],
    ['credential schema 不匹配', (state: SnapshotState) => { state.credentials[0]!.schema_version = 2 }],
    ['连接作用域无效', (state: SnapshotState) => { state.connection.connection_revision = '' }],
  ])('%s 时 fail closed', async (_label, mutate) => {
    const state = validState()
    mutate(state)
    const snapshot = await readAttributionConnectionSnapshot(snapshotDb(state) as unknown as D1Database, 'meta')
    expect(snapshot).toMatchObject({ state: 'connection_invalid' })
  })
})

function snapshotDb(state: SnapshotState) {
  const calls: string[] = []
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql)
      if (sql.includes('FROM attribution_platform_connections')) {
        return { bind: () => ({ first: async () => state.connection }) }
      }
      if (sql.includes('FROM attribution_event_bindings')) {
        return { bind: () => ({ all: async () => ({ results: state.bindings }) }) }
      }
      if (sql.includes('FROM attribution_credentials')) {
        return { bind: () => ({ all: async () => ({ results: state.credentials }) }) }
      }
      throw new Error(`未处理 SQL: ${sql}`)
    },
  }
}

function validState() {
  return {
    connection: {
      id: 'conn_meta',
      provider: 'meta',
      enabled: 1,
      browser_enabled: 1,
      server_enabled: 1,
      public_config_json: '{"pixelId":"123456789012345"}',
      connection_revision: 'connection_scope_1',
    },
    bindings: [
      {
        id: 'binding_registration',
        provider: 'meta',
        canonical_event: 'CompleteRegistration',
        enabled: 1,
        browser_destination: 'meta_pixel',
        server_destination: 'meta_capi',
      },
      {
        id: 'binding_contact',
        provider: 'meta',
        canonical_event: 'Contact',
        enabled: 1,
        browser_destination: 'meta_pixel',
        server_destination: 'meta_capi',
      },
    ],
    credentials: [{
      id: 'credential_1',
      provider: 'meta',
      credential_type: 'access_token',
      schema_version: 1,
      credential_revision: 'credential_revision_1',
      key_id: '0123456789abcdef',
    }],
  }
}
