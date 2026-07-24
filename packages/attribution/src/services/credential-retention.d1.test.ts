import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { enforceCredentialRetention } from './credential-retention'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'

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
    d1Databases: { DB: 'credential-retention' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  await db.prepare(`
    INSERT INTO attribution_connections (
      id, provider, name, is_default
    ) VALUES ('conn_meta', 'meta', 'default', 1)
  `).run()
})

describe('credential retention', () => {
  it('只保留最近一个 retired 凭证且最多 7 天', async () => {
    await retireVersion(db, 'ver_oldest', '2026-07-01T00:00:00.000Z')
    await retireVersion(db, 'ver_latest', '2026-07-24T00:00:00.000Z')

    await enforceCredentialRetention(
      db,
      new Date('2026-07-24T00:00:00.000Z'),
    )

    expect(await credentialExists(db, 'ver_oldest')).toBe(false)
    expect(await credentialDestroyAfter(db, 'ver_latest'))
      .toBe('2026-07-31T00:00:00.000Z')
  })

  it('到期后删除最后一个 retired 凭证且不删除 active 凭证', async () => {
    await retireVersion(db, 'ver_retired', '2026-07-01T00:00:00.000Z')
    await seedVersion(db, 'ver_active', 'active', null)

    await enforceCredentialRetention(
      db,
      new Date('2026-07-24T00:00:00.000Z'),
    )

    expect(await credentialExists(db, 'ver_retired')).toBe(false)
    expect(await credentialExists(db, 'ver_active')).toBe(true)
  })

  it.each(['failed', 'superseded'] as const)(
    '%s 候选凭证立即删除',
    async (status) => {
      await seedDiscardedVersion(db, `ver_${status}`, status)

      await enforceCredentialRetention(
        db,
        new Date('2026-07-24T00:00:00.000Z'),
      )

      expect(await credentialExists(db, `ver_${status}`)).toBe(false)
    },
  )
})

async function retireVersion(
  database: D1Database,
  versionId: string,
  retiredAt: string,
) {
  await seedVersion(database, versionId, 'retired', retiredAt)
}

async function seedVersion(
  database: D1Database,
  versionId: string,
  status: 'active' | 'retired',
  retiredAt: string | null,
) {
  await database.batch([
    database.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, retired_at
      ) VALUES (?, 'conn_meta', 'meta', ?, '{}', ?, 1, ?)
    `).bind(versionId, status, `hash_${versionId}`, retiredAt),
    database.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv, ciphertext,
        tag, credential_fingerprint
      ) VALUES (?, 'meta', 1, 'key', 'iv', 'ciphertext', 'tag', ?)
    `).bind(versionId, `fingerprint_${versionId}`),
  ])
}

async function seedDiscardedVersion(
  database: D1Database,
  versionId: string,
  status: 'failed' | 'superseded',
) {
  await database.batch([
    database.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by
      ) VALUES (?, 'conn_meta', 'meta', ?, '{}', ?, 1)
    `).bind(versionId, status, `hash_${versionId}`),
    database.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv, ciphertext,
        tag, credential_fingerprint
      ) VALUES (?, 'meta', 1, 'key', 'iv', 'ciphertext', 'tag', ?)
    `).bind(versionId, `fingerprint_${versionId}`),
  ])
}

async function credentialExists(
  database: D1Database,
  versionId: string,
): Promise<boolean> {
  return Boolean(await database.prepare(`
    SELECT version_id
    FROM attribution_version_credentials
    WHERE version_id = ?
  `).bind(versionId).first())
}

async function credentialDestroyAfter(
  database: D1Database,
  versionId: string,
): Promise<string | null> {
  const row = await database.prepare(`
    SELECT destroy_after
    FROM attribution_version_credentials
    WHERE version_id = ?
  `).bind(versionId).first<{ destroy_after: string | null }>()
  return row?.destroy_after ?? null
}
