import { describe, expect, it } from 'vitest'
import { readConnectionAggregate } from './connection-repository'

describe('归因连接聚合读模型', () => {
  it('一次查询返回 active、live candidate、策略、绑定和凭证元数据', async () => {
    const db = snapshotDb(validRow())
    const aggregate = await readConnectionAggregate(
      db as unknown as D1Database,
      'conn_meta',
    )

    expect(db.calls).toHaveLength(1)
    expect(aggregate).toMatchObject({
      connection: {
        id: 'conn_meta',
        provider: 'meta',
        activeVersionId: 'ver_active',
      },
      activeVersion: {
        id: 'ver_active',
        status: 'active',
        credential: { fingerprint: 'fp_active' },
      },
      liveCandidate: {
        id: 'ver_candidate',
        status: 'ready',
        credential: { fingerprint: 'fp_candidate' },
      },
      runtimePolicy: {
        enabled: true,
        serverEffectivePercentage: 10,
      },
    })
    expect(aggregate?.activeVersion?.bindings).toHaveLength(2)
  })

  it.each([
    ['version provider 不匹配', (row: SnapshotRow) => ({
      ...row,
      versions_json: JSON.stringify([
        { ...JSON.parse(row.versions_json)[0], provider: 'tiktok' },
        JSON.parse(row.versions_json)[1],
      ]),
    })],
    ['credential provider 不匹配', (row: SnapshotRow) => ({
      ...row,
      credentials_json: JSON.stringify([
        { ...JSON.parse(row.credentials_json)[0], provider: 'google' },
        JSON.parse(row.credentials_json)[1],
      ]),
    })],
    ['重复 credential 行', (row: SnapshotRow) => ({
      ...row,
      credentials_json: JSON.stringify([
        ...JSON.parse(row.credentials_json),
        JSON.parse(row.credentials_json)[0],
      ]),
    })],
    ['重复 binding 行', (row: SnapshotRow) => ({
      ...row,
      bindings_json: JSON.stringify([
        ...JSON.parse(row.bindings_json),
        JSON.parse(row.bindings_json)[0],
      ]),
    })],
    ['损坏 public config', (row: SnapshotRow) => ({
      ...row,
      versions_json: JSON.stringify([
        { ...JSON.parse(row.versions_json)[0], public_config_json: '{bad' },
        JSON.parse(row.versions_json)[1],
      ]),
    })],
  ] as const)('%s 时 fail closed', async (_label, mutate) => {
    await expect(readConnectionAggregate(
      snapshotDb(mutate(validRow())) as unknown as D1Database,
      'conn_meta',
    )).rejects.toThrow('ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID')
  })
})

interface SnapshotRow {
  connection_id: string
  connection_provider: string
  connection_name: string
  is_default: number
  active_version_id: string | null
  connection_created_at: string
  connection_updated_at: string
  policy_enabled: number
  browser_enabled: number
  server_enabled: number
  server_target_percentage: number
  server_effective_percentage: number
  circuit_state: string
  runtime_generation: number
  policy_updated_by: number
  policy_updated_at: string
  versions_json: string
  bindings_json: string
  credentials_json: string
}

function snapshotDb(row: SnapshotRow | null) {
  const calls: string[] = []
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql)
      return {
        bind: () => ({
          first: async () => row,
        }),
      }
    },
  }
}

function validRow(): SnapshotRow {
  const versions = [
    version('ver_active', 'active'),
    version('ver_candidate', 'ready'),
  ]
  const bindings = versions.flatMap(item => [
    binding(item.id, 'Contact'),
    binding(item.id, 'CompleteRegistration'),
  ])
  const credentials = [
    credential('ver_active', 'fp_active'),
    credential('ver_candidate', 'fp_candidate'),
  ]

  return {
    connection_id: 'conn_meta',
    connection_provider: 'meta',
    connection_name: 'default',
    is_default: 1,
    active_version_id: 'ver_active',
    connection_created_at: '2026-07-24T00:00:00.000Z',
    connection_updated_at: '2026-07-24T00:00:00.000Z',
    policy_enabled: 1,
    browser_enabled: 1,
    server_enabled: 1,
    server_target_percentage: 10,
    server_effective_percentage: 10,
    circuit_state: 'closed',
    runtime_generation: 1,
    policy_updated_by: 1,
    policy_updated_at: '2026-07-24T00:00:00.000Z',
    versions_json: JSON.stringify(versions),
    bindings_json: JSON.stringify(bindings),
    credentials_json: JSON.stringify(credentials),
  }
}

function version(id: string, status: 'active' | 'ready') {
  return {
    id,
    connection_id: 'conn_meta',
    provider: 'meta',
    base_active_version_id: status === 'active' ? null : 'ver_active',
    status,
    public_config_json: '{"pixelId":"1234567890123456"}',
    config_hash: `hash_${id}`,
    created_by: 1,
    created_at: '2026-07-24T00:00:00.000Z',
    validated_at: status === 'ready' ? '2026-07-24T00:01:00.000Z' : null,
    activated_at: status === 'active' ? '2026-07-24T00:02:00.000Z' : null,
    draining_at: null,
    retired_at: null,
    failure_code: '',
  }
}

function binding(
  versionId: string,
  canonicalEvent: 'Contact' | 'CompleteRegistration',
) {
  return {
    version_id: versionId,
    canonical_event: canonicalEvent,
    enabled: 1,
    browser_destination: 'meta_pixel',
    server_destination: 'meta_capi',
  }
}

function credential(versionId: string, fingerprint: string) {
  return {
    version_id: versionId,
    provider: 'meta',
    schema_version: 1,
    key_id: '0'.repeat(32),
    credential_fingerprint: fingerprint,
    destroy_after: null,
  }
}
