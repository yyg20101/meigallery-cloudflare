import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { resolveAttributionRoute } from '../domain/routing'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  createManagedSource,
  createManagedSourceRoutingRepository,
} from './managed-source-service'

const MIGRATION = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')

let miniflare: Miniflare
let db: D1Database
let sequence = 0

const signingKey = 'routing-signing-key'
const fixedNow = new Date('2026-07-24T04:00:00.000Z')

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'managed-sources' },
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
    INSERT INTO attribution_privacy_policy (
      id, default_mode, prior_consent_country_codes_json, policy_version
    ) VALUES ('global', 'prior_consent', '[]', 1)
  `).run()
  sequence = 0
  await seedActiveConnection(db, 'conn_meta_a', 'meta')
  await seedActiveConnection(db, 'conn_tiktok_a', 'tiktok')
  await seedActiveConnection(db, 'conn_google_a', 'google')
})

describe('managed source service', () => {
  it.each([
    ['conn_meta_a', 'meta'],
    ['conn_tiktok_a', 'tiktok'],
    ['conn_google_a', 'google'],
  ] as const)('proof 只解析到所属 %s 连接', async (connectionId, provider) => {
    const source = await createManagedSource(environment(), {
      connectionId,
      campaign: 'launch',
      medium: 'paid_social',
      content: 'creative-a',
    })
    const stored = await db.prepare(`
      SELECT provider, connection_id, proof_hmac
      FROM attribution_managed_sources
      WHERE id = ?
    `).bind(source.id).first<{
      provider: string
      connection_id: string
      proof_hmac: string
    }>()

    expect(stored).toMatchObject({
      provider,
      connection_id: connectionId,
    })
    expect(stored?.proof_hmac).not.toBe(source.proof)
    expect(stored?.proof_hmac).toMatch(/^[a-f0-9]{64}$/)

    const result = await resolveAttributionRoute(
      createManagedSourceRoutingRepository(environment()),
      { proof: source.proof },
    )
    expect(result).toEqual({
      resolution: 'resolved',
      provider,
      connectionId,
      incidentCode: null,
    })
  })

  it('过期 proof 无效且原始 proof 不落库', async () => {
    const source = await createManagedSource(environment(), {
      connectionId: 'conn_meta_a',
      campaign: 'expired',
      medium: 'paid_social',
      content: 'creative-expired',
      expiresAt: '2026-07-24T04:30:00.000Z',
    })
    const repository = createManagedSourceRoutingRepository({
      ...environment(),
      now: () => new Date('2026-07-24T05:00:00.000Z'),
    })

    expect(await resolveAttributionRoute(repository, {
      proof: source.proof,
    })).toMatchObject({
      resolution: 'none',
      connectionId: null,
    })

    const row = await db.prepare(`
      SELECT json_group_object(name, type) AS columns_json
      FROM pragma_table_info('attribution_managed_sources')
    `).first<{ columns_json: string }>()
    expect(Object.keys(JSON.parse(row?.columns_json ?? '{}')))
      .not.toContain('proof')
  })

  it('同平台多连接仅有 click ID 时记录一个开放 Incident', async () => {
    await seedActiveConnection(db, 'conn_meta_b', 'meta')
    const repository = createManagedSourceRoutingRepository(environment())

    const first = await resolveAttributionRoute(repository, {
      identifiers: { fbclid: 'fb-click' },
    })
    const second = await resolveAttributionRoute(repository, {
      identifiers: { fbclid: 'fb-click' },
    })

    expect(first.resolution).toBe('ambiguous')
    expect(second).toEqual(first)
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM attribution_incidents
      WHERE code = 'ATTRIBUTION_CONNECTION_AMBIGUOUS'
        AND status = 'open'
    `).first<{ count: number }>()).toEqual({ count: 1 })
  })
})

function environment() {
  return {
    db,
    signingKey,
    now: () => fixedNow,
    idFactory: (prefix: string) => `${prefix}_${++sequence}`,
    randomBytes: () => Uint8Array.from(
      { length: 32 },
      (_value, index) => index + sequence,
    ),
  }
}

async function seedActiveConnection(
  database: D1Database,
  connectionId: string,
  provider: 'meta' | 'tiktok' | 'google',
) {
  const versionId = `ver_${connectionId}`
  await database.batch([
    database.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, is_default, active_version_id
      ) VALUES (?, ?, ?, 0, ?)
    `).bind(connectionId, provider, connectionId, versionId),
    database.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (?, ?, ?, 'active', '{}', ?, 1, ?)
    `).bind(
      versionId,
      connectionId,
      provider,
      `hash_${connectionId}`,
      fixedNow.toISOString(),
    ),
    database.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by
      ) VALUES (?, 1, 1, 1, 10, 10, 'closed', 1)
    `).bind(connectionId),
  ])
}
