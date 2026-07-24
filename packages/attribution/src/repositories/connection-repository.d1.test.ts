import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readConnectionAggregate } from './connection-repository'

const MIGRATION = readFileSync(
  new URL('../../migrations/0001_attribution_runtime.sql', import.meta.url),
  'utf8',
)

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'connection-repository' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('归因连接聚合 D1 查询', () => {
  it('在真实 D1 Schema 上返回完整 active 聚合且不读取密文', async () => {
    await db.batch([
      db.prepare(`
        INSERT INTO attribution_connections (
          id, provider, name, is_default, active_version_id
        ) VALUES ('conn_meta', 'meta', 'default', 1, 'ver_active')
      `),
      db.prepare(`
        INSERT INTO attribution_connection_versions (
          id, connection_id, provider, status, public_config_json,
          config_hash, created_by, activated_at
        ) VALUES (
          'ver_active', 'conn_meta', 'meta', 'active',
          '{"pixelId":"123"}', 'hash_active', 1,
          '2026-07-24T00:00:00.000Z'
        )
      `),
      db.prepare(`
        INSERT INTO attribution_runtime_policies (
          connection_id, enabled, browser_enabled, server_enabled,
          server_target_percentage, server_effective_percentage,
          circuit_state, runtime_generation, updated_by
        ) VALUES ('conn_meta', 1, 1, 1, 10, 10, 'closed', 1, 1)
      `),
      db.prepare(`
        INSERT INTO attribution_version_credentials (
          version_id, provider, schema_version, key_id, iv, ciphertext,
          tag, credential_fingerprint
        ) VALUES (
          'ver_active', 'meta', 1, 'key-id', 'iv', 'encrypted-secret',
          'tag', 'fingerprint'
        )
      `),
      ...(['Contact', 'CompleteRegistration'] as const).map(event =>
        db.prepare(`
          INSERT INTO attribution_version_bindings (
            version_id, canonical_event, enabled,
            browser_destination, server_destination
          ) VALUES ('ver_active', ?, 1, 'meta_pixel', 'meta_capi')
        `).bind(event)),
    ])

    const aggregate = await readConnectionAggregate(db, 'conn_meta')

    expect(aggregate).toMatchObject({
      connection: { provider: 'meta' },
      activeVersion: {
        id: 'ver_active',
        publicConfig: { pixelId: '123' },
        credential: { fingerprint: 'fingerprint' },
      },
      liveCandidate: null,
    })
    expect(JSON.stringify(aggregate)).not.toContain('encrypted-secret')
  })
})
