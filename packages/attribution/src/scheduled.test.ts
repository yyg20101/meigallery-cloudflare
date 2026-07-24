import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from './test/attribution-schema'
import { runAttributionMaintenance } from './scheduled'

const MIGRATIONS = [
  '../migrations/0001_attribution_runtime.sql',
  '../migrations/0002_event_delivery.sql',
  '../migrations/0003_queue_runtime.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'scheduled-maintenance' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const migration of MIGRATIONS) {
    await db.exec(migration.replace(/\s*\r?\n\s*/g, ' '))
  }
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

it('定时维护只清除到期 retired 凭证并保留 Active 与 Draining', async () => {
  await seedCredentialVersion(db, {
    id: 'ver_active',
    status: 'active',
    retiredAt: null,
  })
  await seedCredentialVersion(db, {
    id: 'ver_draining',
    status: 'draining',
    retiredAt: null,
  })
  await seedCredentialVersion(db, {
    id: 'ver_retired',
    status: 'retired',
    retiredAt: '2026-07-01T00:00:00.000Z',
  })

  const result = await runAttributionMaintenance(
    {
      db,
      queues: {
        meta: queue(),
        tiktok: queue(),
        google: queue(),
      },
    },
    new Date('2026-07-24T00:00:00.000Z'),
    'credentials',
  )

  expect(result).toEqual({
    credentialRetention: { deleted: 1, scheduled: 0 },
    outboxRecovery: null,
    expiredOutbox: null,
  })
  expect(await credentialExists(db, 'ver_active')).toBe(true)
  expect(await credentialExists(db, 'ver_draining')).toBe(true)
  expect(await credentialExists(db, 'ver_retired')).toBe(false)
})

function queue() {
  return {
    send: async () => undefined,
  } as unknown as Queue<never>
}

async function seedCredentialVersion(
  database: D1Database,
  input: {
    id: string
    status: 'active' | 'draining' | 'retired'
    retiredAt: string | null
  },
) {
  await database.batch([
    database.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, retired_at
      ) VALUES (?, 'conn_meta', 'meta', ?, '{}', ?, 1, ?)
    `).bind(
      input.id,
      input.status,
      `hash_${input.id}`,
      input.retiredAt,
    ),
    database.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv, ciphertext,
        tag, credential_fingerprint
      ) VALUES (?, 'meta', 1, 'key', 'iv', 'ciphertext', 'tag', ?)
    `).bind(input.id, `fingerprint_${input.id}`),
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
