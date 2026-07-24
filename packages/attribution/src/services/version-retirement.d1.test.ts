import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import { retireDrainedVersions } from './version-retirement'

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
    d1Databases: { DB: 'version-retirement' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  await seedVersions()
})

describe('draining 版本退休', () => {
  it('未满 30 分钟不退休', async () => {
    expect(await retireDrainedVersions(
      db,
      new Date('2026-07-24T00:29:59.999Z'),
    )).toEqual({ retired: 0 })
    expect((await version('ver_old'))?.status).toBe('draining')
  })

  it('满 30 分钟原子退休并启动 7 天凭证保留', async () => {
    expect(await retireDrainedVersions(
      db,
      new Date('2026-07-24T00:30:00.000Z'),
    )).toEqual({ retired: 1 })

    expect(await version('ver_old')).toMatchObject({
      status: 'retired',
      retired_at: '2026-07-24T00:30:00.000Z',
    })
    expect(await credential('ver_old')).toMatchObject({
      destroy_after: '2026-07-31T00:30:00.000Z',
    })
    expect((await version('ver_new'))?.status).toBe('active')

    expect(await retireDrainedVersions(
      db,
      new Date('2026-07-24T00:31:00.000Z'),
    )).toEqual({ retired: 0 })
  })
})

async function version(id: string) {
  return db.prepare(`
    SELECT status, retired_at
    FROM attribution_connection_versions
    WHERE id = ?
  `).bind(id).first<{
    status: string
    retired_at: string | null
  }>()
}

async function credential(versionId: string) {
  return db.prepare(`
    SELECT destroy_after
    FROM attribution_version_credentials
    WHERE version_id = ?
  `).bind(versionId).first<{ destroy_after: string | null }>()
}

async function seedVersions() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta_a', 'meta', 'meta-a', 'ver_new')
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at, draining_at
      ) VALUES (
        'ver_old', 'conn_meta_a', 'meta', 'draining', '{}',
        'hash_old', 1, '2026-07-23T23:00:00.000Z',
        '2026-07-24T00:00:00.000Z'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_new', 'conn_meta_a', 'meta', 'active', '{}',
        'hash_new', 1, '2026-07-24T00:00:00.000Z'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv,
        ciphertext, tag, credential_fingerprint
      ) VALUES (
        'ver_old', 'meta', 1, 'key-old', 'iv-old',
        'cipher-old', 'tag-old', 'fingerprint-old'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv,
        ciphertext, tag, credential_fingerprint
      ) VALUES (
        'ver_new', 'meta', 1, 'key-new', 'iv-new',
        'cipher-new', 'tag-new', 'fingerprint-new'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by
      ) VALUES ('conn_meta_a', 1, 1, 1, 10, 10, 'closed', 1)
    `),
  ])
}
