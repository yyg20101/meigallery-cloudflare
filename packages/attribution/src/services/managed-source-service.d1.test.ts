import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { resolveAttributionRoute } from '../domain/routing'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  createAdminManagedSource,
  createManagedSource,
  createManagedSourceRoutingRepository,
  disableAdminManagedSource,
  listAdminManagedSources,
} from './managed-source-service'

const MIGRATION = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')

let miniflare: Miniflare
let db: D1Database
let sequence = 0

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
      SELECT provider, connection_id, proof_hash
      FROM attribution_managed_sources
      WHERE id = ?
    `).bind(source.id).first<{
      provider: string
      connection_id: string
      proof_hash: string
    }>()

    expect(stored).toMatchObject({
      provider,
      connection_id: connectionId,
    })
    expect(stored?.proof_hash).not.toBe(source.proof)
    expect(stored?.proof_hash).toMatch(/^[a-f0-9]{64}$/)

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

  it('D1 拒绝非 SHA-256 格式的来源摘要', async () => {
    await expect(db.prepare(`
      INSERT INTO attribution_managed_sources (
        id, provider, connection_id, campaign, medium, content,
        proof_hash, enabled
      ) VALUES (
        'source_invalid_hash', 'meta', 'conn_meta_a', 'launch',
        'paid_social', 'creative-a', 'not-a-sha256-digest', 1
      )
    `).run()).rejects.toThrow()
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

  it('管理员首次创建返回一次性 proof，幂等重放不新增且不恢复 proof', async () => {
    const input = {
      connectionId: 'conn_meta_a',
      campaign: 'admin-launch',
      medium: 'paid_social',
      content: 'creative-admin',
      actorId: 42,
      idempotencyKey: 'idem_create_source_1',
    }
    const first = await createAdminManagedSource(environment(), input)
    const replay = await createAdminManagedSource(environment(), input)

    expect(first).toMatchObject({
      source: {
        provider: 'meta',
        connectionId: 'conn_meta_a',
        campaign: 'admin-launch',
      },
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      proofDelivery: 'issued_once',
      replayed: false,
    })
    expect(replay).toEqual({
      source: first.source,
      proof: null,
      proofDelivery: 'not_recoverable',
      replayed: true,
    })
    expect(await countRows('attribution_managed_sources')).toBe(1)
    expect(await countRows('attribution_audit_logs')).toBe(1)
    expect(await countRows('attribution_command_receipts')).toBe(1)

    const receipt = await db.prepare(`
      SELECT result_json
      FROM attribution_command_receipts
      WHERE idempotency_key = ?
    `).bind(input.idempotencyKey).first<{ result_json: string }>()
    expect(receipt?.result_json).not.toContain(first.proof as string)
    expect(receipt?.result_json).not.toContain('proof_hash')
    expect(receipt?.result_json).not.toContain('"proof":')

    const audit = await db.prepare(`
      SELECT actor_id, command_type, connection_id, detail_json
      FROM attribution_audit_logs
      WHERE command_type = 'create_managed_source'
    `).first<{
      actor_id: number
      command_type: string
      connection_id: string
      detail_json: string
    }>()
    expect(audit).toMatchObject({
      actor_id: 42,
      command_type: 'create_managed_source',
      connection_id: 'conn_meta_a',
    })
    expect(audit?.detail_json).not.toContain(first.proof as string)
    expect(audit?.detail_json).not.toContain('proof_hash')
    expect(audit?.detail_json).not.toContain('"proof":')
  })

  it('管理员创建相同幂等键但请求不同会 fail closed', async () => {
    const input = {
      connectionId: 'conn_meta_a',
      campaign: 'admin-launch',
      medium: 'paid_social',
      content: 'creative-admin',
      actorId: 42,
      idempotencyKey: 'idem_create_conflict',
    }
    await createAdminManagedSource(environment(), input)

    await expect(createAdminManagedSource(environment(), {
      ...input,
      campaign: 'different-campaign',
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_IDEMPOTENCY_CONFLICT',
    })
    expect(await countRows('attribution_managed_sources')).toBe(1)
    expect(await countRows('attribution_audit_logs')).toBe(1)
  })

  it('管理员列表不返回 proof 或 proof_hash，并对读取进行幂等审计', async () => {
    const created = await createAdminManagedSource(environment(), {
      connectionId: 'conn_tiktok_a',
      campaign: 'list-campaign',
      medium: 'paid_social',
      content: 'creative-list',
      actorId: 51,
      idempotencyKey: 'idem_create_for_list',
    })
    const input = {
      connectionId: 'conn_tiktok_a',
      actorId: 51,
      idempotencyKey: 'idem_list_sources',
    }

    const first = await listAdminManagedSources(environment(), input)
    const replay = await listAdminManagedSources(environment(), input)

    expect(replay).toEqual(first)
    expect(first).toEqual({
      connectionId: 'conn_tiktok_a',
      sources: [created.source],
    })
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain(created.proof as string)
    expect(serialized).not.toContain('proof_hash')
    expect(serialized).not.toContain('"proof":')
    expect(await auditCount('list_managed_sources')).toBe(1)
    expect(await receiptCount('idem_list_sources')).toBe(1)
  })

  it('管理员停用校验连接归属并且相同命令只审计一次', async () => {
    const created = await createAdminManagedSource(environment(), {
      connectionId: 'conn_google_a',
      campaign: 'disable-campaign',
      medium: 'paid_search',
      content: 'creative-disable',
      actorId: 63,
      idempotencyKey: 'idem_create_for_disable',
    })

    await expect(disableAdminManagedSource(environment(), {
      connectionId: 'conn_meta_a',
      sourceId: created.source.id,
      actorId: 63,
      idempotencyKey: 'idem_cross_connection_disable',
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_CONNECTION_NOT_FOUND',
    })
    expect(await receiptCount('idem_cross_connection_disable')).toBe(0)
    expect(await auditCount('disable_managed_source')).toBe(0)

    const input = {
      connectionId: 'conn_google_a',
      sourceId: created.source.id,
      actorId: 63,
      idempotencyKey: 'idem_disable_source',
    }
    const first = await disableAdminManagedSource(environment(), input)
    const replay = await disableAdminManagedSource(environment(), input)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      disabled: true,
      source: {
        id: created.source.id,
        provider: 'google',
        connectionId: 'conn_google_a',
        enabled: false,
      },
    })
    expect(await auditCount('disable_managed_source')).toBe(1)
    expect(await receiptCount('idem_disable_source')).toBe(1)
    expect(await db.prepare(`
      SELECT enabled
      FROM attribution_managed_sources
      WHERE id = ?
    `).bind(created.source.id).first<{ enabled: number }>())
      .toEqual({ enabled: 0 })
  })

  it('管理员停用相同幂等键不同来源会 fail closed', async () => {
    const first = await createAdminManagedSource(environment(), {
      connectionId: 'conn_meta_a',
      campaign: 'first',
      medium: 'paid_social',
      content: 'creative-first',
      actorId: 71,
      idempotencyKey: 'idem_create_disable_first',
    })
    const second = await createAdminManagedSource(environment(), {
      connectionId: 'conn_meta_a',
      campaign: 'second',
      medium: 'paid_social',
      content: 'creative-second',
      actorId: 71,
      idempotencyKey: 'idem_create_disable_second',
    })
    const input = {
      connectionId: 'conn_meta_a',
      sourceId: first.source.id,
      actorId: 71,
      idempotencyKey: 'idem_disable_conflict',
    }
    await disableAdminManagedSource(environment(), input)

    await expect(disableAdminManagedSource(environment(), {
      ...input,
      sourceId: second.source.id,
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_IDEMPOTENCY_CONFLICT',
    })
    expect(await auditCount('disable_managed_source')).toBe(1)
  })
})

function environment() {
  return {
    db,
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

async function countRows(table: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${table}
  `).first<{ count: number }>()
  return row?.count ?? 0
}

async function auditCount(commandType: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM attribution_audit_logs
    WHERE command_type = ?
  `).bind(commandType).first<{ count: number }>()
  return row?.count ?? 0
}

async function receiptCount(idempotencyKey: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
  `).bind(idempotencyKey).first<{ count: number }>()
  return row?.count ?? 0
}
