import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  importAttributionMigrationSnapshot,
  readAttributionMigrationImportResult,
  type AttributionMigrationImportEnvironment,
} from './migration-import'

const MIGRATION = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0005_migration_history.sql',
].map(path => readFileSync(
  new URL(path, import.meta.url),
  'utf8',
)).join('\n')

const NOW = new Date('2026-07-24T12:00:00.000Z')
const CREDENTIAL = 'migration-fixture-secret-value'
const KEYS = {
  current: 'migration-new-credential-key-0123456789abcdef',
}

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'migration-import' },
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
  await db.prepare(`
    UPDATE attribution_runtime_state
    SET mode = 'shadow', activated_at = NULL, updated_at = ?
    WHERE id = 'global'
  `).bind(NOW.toISOString()).run()
})

describe('归因运行时迁移导入', () => {
  it('重新封装凭证、保留业务 ID，且明文不进入响应、审计或 D1', async () => {
    const result = await importAttributionMigrationSnapshot(
      environment(),
      request(),
    )

    expect(result).toMatchObject({
      replayed: false,
      counts: {
        connections: 1,
        versions: 1,
        credentials: 1,
        bindings: 2,
        managedSources: 1,
        historyRows: 2,
        historyFacts: 38,
      },
    })
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL)

    const dump = await dumpAttributionTables()
    expect(dump).not.toContain(CREDENTIAL)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_connections',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_connection_versions',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_managed_sources',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(0)

    const connection = await db.prepare(`
      SELECT id, active_version_id
      FROM attribution_connections
      WHERE id = 'conn_meta'
    `).first<{ id: string; active_version_id: string | null }>()
    expect(connection).toEqual({
      id: 'conn_meta',
      active_version_id: null,
    })
    expect(await db.prepare(`
      SELECT status
      FROM attribution_connection_versions
      WHERE id = 'version_migrated_conn_meta'
    `).first()).toEqual({ status: 'candidate' })
    expect(await db.prepare(`
      SELECT server_target_percentage, server_effective_percentage
      FROM attribution_runtime_policies
      WHERE connection_id = 'conn_meta'
    `).first()).toEqual({
      server_target_percentage: 10,
      server_effective_percentage: 0,
    })
  })

  it('相同 runId 幂等重放不新增版本，内容变化则拒绝', async () => {
    const first = await importAttributionMigrationSnapshot(
      environment(),
      request(),
    )
    const second = await importAttributionMigrationSnapshot(
      environment(),
      request(),
    )

    expect(second).toEqual({
      ...first,
      replayed: true,
    })
    await expect(readAttributionMigrationImportResult(
      db,
      'migration-production-v1',
    )).resolves.toEqual(second)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_connection_versions',
    )).toBe(first.counts.versions)

    const changed = request()
    changed.snapshot.connections[0]!.publicConfig.pixelId =
      '9999999999999999'
    await expect(importAttributionMigrationSnapshot(
      environment(),
      changed,
    )).rejects.toThrow('ATTRIBUTION_MIGRATION_IDEMPOTENCY_CONFLICT')

    const changedWindow = request()
    changedWindow.snapshot.capturedAt = '2026-07-24T11:56:00.000Z'
    await expect(importAttributionMigrationSnapshot(
      environment(),
      changedWindow,
    )).rejects.toThrow('ATTRIBUTION_MIGRATION_IDEMPOTENCY_CONFLICT')
  })

  it('只接受 shadow 或 bridge，active 禁止重新导入', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_state
      SET mode = 'active', activated_at = ?
      WHERE id = 'global'
    `).bind(NOW.toISOString()).run()

    await expect(importAttributionMigrationSnapshot(
      environment(),
      request(),
    )).rejects.toThrow('ATTRIBUTION_MIGRATION_RUNTIME_MODE_INVALID')
  })

  it('冻结后对账原子替换历史和来源，且配置变化时拒绝', async () => {
    await importAttributionMigrationSnapshot(environment(), request())
    const reconcile = reconcileRequest()

    const result = await importAttributionMigrationSnapshot(
      environment(),
      reconcile,
    )

    expect(result).toMatchObject({
      phase: 'reconcile',
      counts: {
        connections: 0,
        managedSources: 1,
        historyRows: 1,
        historyFacts: 39,
      },
    })
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(0)
    expect(await scalar(`
      SELECT COALESCE(SUM(fact_count), 0) AS value
      FROM attribution_history_daily
    `)).toBe(39)
    expect(await db.prepare(`
      SELECT status, reconcile_run_id
      FROM attribution_migration_manifests
      WHERE initial_run_id = 'migration-production-v1'
    `).first()).toEqual({
      status: 'reconciled',
      reconcile_run_id: 'migration-production-reconcile-v1',
    })

    const replay = reconcileRequest()
    await expect(importAttributionMigrationSnapshot(
      environment(),
      replay,
    )).resolves.toEqual({
      ...result,
      replayed: true,
    })

    await clearAttributionRuntimeDatabase(db)
    await db.prepare(`
      INSERT INTO attribution_privacy_policy (
        id, default_mode, prior_consent_country_codes_json, policy_version
      ) VALUES ('global', 'prior_consent', '[]', 1)
    `).run()
    await db.prepare(`
      UPDATE attribution_runtime_state
      SET mode = 'shadow', activated_at = NULL, updated_at = ?
      WHERE id = 'global'
    `).bind(NOW.toISOString()).run()
    await importAttributionMigrationSnapshot(environment(), request())
    const changed = reconcileRequest()
    changed.snapshot.sourceConfigurationHash = 'c'.repeat(64)
    await expect(importAttributionMigrationSnapshot(
      environment(),
      changed,
    )).rejects.toThrow('ATTRIBUTION_MIGRATION_SOURCE_CHANGED')
  })
})

function environment(): AttributionMigrationImportEnvironment {
  return {
    db,
    credentialKeys: KEYS,
    now: () => NOW,
  }
}

function request() {
  return {
    runId: 'migration-production-v1',
    actorId: 1,
    snapshot: {
      schemaVersion: 1 as const,
      phase: 'initial' as const,
      capturedAt: '2026-07-24T11:55:00.000Z',
      sourceConfigurationHash: 'b'.repeat(64),
      connections: [{
        id: 'conn_meta',
        provider: 'meta' as const,
        name: 'Meta 默认连接',
        isDefault: true,
        enabled: true,
        browserEnabled: true,
        serverEnabled: true,
        serverTargetPercentage: 10 as const,
        serverEffectivePercentage: 10 as const,
        circuitState: 'closed' as const,
        publicConfig: { pixelId: '1234567890123456' },
        eventBindings: [
          {
            canonicalEvent: 'Contact' as const,
            enabled: true,
            browserDestination: 'meta_pixel',
            serverDestination: 'meta_capi',
          },
          {
            canonicalEvent: 'CompleteRegistration' as const,
            enabled: true,
            browserDestination: 'meta_pixel',
            serverDestination: 'meta_capi',
          },
        ],
        credential: {
          type: 'access_token' as const,
          plaintext: CREDENTIAL,
        },
        createdAt: '2026-07-16T00:14:19.000Z',
        updatedAt: '2026-07-23T06:33:27.000Z',
      }],
      managedSources: [{
        id: 'ats_meta_us_bj',
        provider: 'meta' as const,
        connectionId: 'conn_meta',
        campaign: 'meta-us-bj',
        medium: 'paid_social',
        content: 'bj',
        proof: 'a'.repeat(64),
        enabled: true,
        expiresAt: null,
        createdAt: '2026-07-21T00:54:56.000Z',
      }],
      historyDaily: [{
        date: '2026-07-23',
        eventName: 'Contact' as const,
        factOrigin: 'archived_live' as const,
        provider: 'meta' as const,
        attributionSource: 'managed_link',
        factCount: 1,
        firstOccurredAt: '2026-07-23T03:14:10.336Z',
        lastOccurredAt: '2026-07-23T03:14:10.336Z',
      }, {
        date: '2026-07-14',
        eventName: 'Contact' as const,
        factOrigin: 'historical_backfill' as const,
        provider: null,
        attributionSource: 'none',
        factCount: 37,
        firstOccurredAt: '2026-07-12T07:29:19.354Z',
        lastOccurredAt: '2026-07-14T10:14:22.743Z',
      }],
      privacyPolicy: {
        defaultMode: 'notice_opt_out' as const,
        priorConsentCountryCodes: ['CH', 'DE'],
        policyVersion: 2,
        updatedAt: '2026-07-18T06:43:16.000Z',
      },
    },
  }
}

function reconcileRequest() {
  return {
    runId: 'migration-production-reconcile-v1',
    actorId: 1,
    snapshot: {
      schemaVersion: 1 as const,
      phase: 'reconcile' as const,
      initialRunId: 'migration-production-v1',
      capturedAt: '2026-07-24T12:00:00.000Z',
      sourceConfigurationHash: 'b'.repeat(64),
      managedSources: request().snapshot.managedSources,
      historyDaily: [{
        date: '2026-07-23',
        eventName: 'Contact' as const,
        factOrigin: 'archived_live' as const,
        provider: 'meta' as const,
        attributionSource: 'managed_link',
        factCount: 39,
        firstOccurredAt: '2026-07-23T03:14:10.336Z',
        lastOccurredAt: '2026-07-24T11:59:59.000Z',
      }],
    },
  }
}

async function scalar(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

async function dumpAttributionTables(): Promise<string> {
  const tables = await db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name LIKE 'attribution_%'
    ORDER BY name
  `).all<{ name: string }>()
  const values: unknown[] = []
  for (const table of tables.results) {
    values.push(...(await db.prepare(
      `SELECT * FROM ${table.name}`,
    ).all<Record<string, unknown>>()).results)
  }
  return JSON.stringify(values)
}
