import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  readAttributionRuntimeReadiness,
  transitionAttributionRuntimeModeCommand,
} from './runtime-state'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0005_migration_history.sql',
  '../../migrations/0006_runtime_owner_epoch.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'runtime-state-command' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const migration of MIGRATIONS) {
    await db.exec(cleanSql(migration))
  }
})

beforeEach(async () => {
  await db.exec(cleanSql(`
    DELETE FROM attribution_outbox;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_facts;
    DELETE FROM attribution_connection_versions;
    DELETE FROM attribution_connections;
    DELETE FROM attribution_command_receipts;
    DELETE FROM attribution_audit_logs;
    DELETE FROM attribution_migration_manifests;
    UPDATE attribution_runtime_state
    SET mode = 'shadow',
        activated_at = NULL,
        bridge_owner_epoch = NULL,
        active_owner_epoch = NULL,
        fenced_owner_epoch = NULL,
        updated_at = '2026-07-24T00:00:00.000Z'
    WHERE id = 'global';
  `))
})

afterAll(async () => miniflare.dispose())

describe('Attribution Worker 运行模式命令', () => {
  it('最终集合对账缺失时禁止进入 bridge', async () => {
    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_missing_manifest'),
    )).rejects.toThrow('ATTRIBUTION_RUNTIME_MIGRATION_NOT_READY')

    expect(await readAttributionRuntimeReadiness(db)).toMatchObject({
      mode: 'shadow',
      migrationReconciled: false,
    })
  })

  it('bridge 命令原子写入状态、审计和幂等回执', async () => {
    await insertReconciledManifest()
    const input = commandInput('bridge', 2, 'runtime_bridge_once')
    const first = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      input,
    )
    const replay = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      input,
    )

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      mode: 'bridge',
      bridgeOwnerEpoch: 2,
      activeOwnerEpoch: null,
    })
    expect(await count('attribution_audit_logs')).toBe(1)
    expect(await count('attribution_command_receipts')).toBe(1)
  })

  it('同一幂等键不能复用为不同 owner epoch', async () => {
    await insertReconciledManifest()
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_conflict'),
    )

    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(2),
      commandInput('bridge', 3, 'runtime_bridge_conflict'),
    )).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  })

  it('active 必须使用 bridge epoch 的下一个值', async () => {
    await insertReconciledManifest()
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_for_active'),
    )
    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(2),
      commandInput('active', 4, 'runtime_active_bad_epoch'),
    )).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')

    const active = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(3),
      commandInput('active', 3, 'runtime_active_valid'),
    )
    expect(active).toMatchObject({
      mode: 'active',
      bridgeOwnerEpoch: 2,
      activeOwnerEpoch: 3,
    })
  })

  it('回滚必须先 fenced，重新切换只能使用连续 epoch', async () => {
    await insertReconciledManifest()
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_before_restore'),
    )
    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(2),
      commandInput('bridge', 4, 'runtime_bridge_after_restore'),
    )).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')

    const fenced = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(3),
      commandInput('fenced', 3, 'runtime_fence_after_restore'),
    )
    expect(fenced).toMatchObject({
      mode: 'fenced',
      bridgeOwnerEpoch: null,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: 3,
    })

    const rearmedBridge = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(4),
      commandInput('bridge', 4, 'runtime_bridge_after_fence'),
    )
    expect(rearmedBridge).toMatchObject({
      mode: 'bridge',
      bridgeOwnerEpoch: 4,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: null,
    })

    const active = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(5),
      commandInput('active', 5, 'runtime_active_after_restore'),
    )
    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(6),
      commandInput('active', 8, 'runtime_active_second_restore'),
    )).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')
    expect(active).toMatchObject({
      mode: 'active',
      bridgeOwnerEpoch: 4,
      activeOwnerEpoch: 5,
    })
    expect(await count('attribution_audit_logs')).toBe(4)
  })

  it('存在 processing Server delivery 时拒绝 fenced，排空后才能回滚', async () => {
    await insertReconciledManifest()
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_before_fence'),
    )
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(2),
      commandInput('active', 3, 'runtime_active_before_fence'),
    )
    await seedProcessingServerDelivery()

    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(3),
      commandInput('fenced', 4, 'runtime_fence_in_flight'),
    )).rejects.toThrow('ATTRIBUTION_RUNTIME_IN_FLIGHT_DELIVERY')

    await db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'accepted',
          last_error_code = '',
          updated_at = ?
      WHERE id = 'delivery_processing'
    `).bind('2026-07-24T00:03:00.000Z').run()

    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(4),
      commandInput('fenced', 4, 'runtime_fence_drained'),
    )).resolves.toMatchObject({
      mode: 'fenced',
      fencedOwnerEpoch: 4,
    })
  })

  it('fenced 命令原子取消待发送 Delivery、删除 Outbox 并保留回执', async () => {
    await insertReconciledManifest()
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_before_cleanup'),
    )
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(2),
      commandInput('active', 3, 'runtime_active_before_cleanup'),
    )
    await seedPendingServerDelivery()

    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(3),
      commandInput('fenced', 4, 'runtime_fence_with_pending'),
    )).resolves.toMatchObject({
      mode: 'fenced',
      fencedOwnerEpoch: 4,
    })
    expect(await db.prepare(`
      SELECT status, last_error_code
      FROM attribution_deliveries
      WHERE id = 'delivery_processing'
    `).first()).toEqual({
      status: 'cancelled',
      last_error_code: 'runtime_fenced',
    })
    expect(await count('attribution_outbox')).toBe(0)
    expect(await count('attribution_command_receipts')).toBe(3)
    expect(await count('attribution_audit_logs')).toBe(3)
  })

  it('相同目标和 epoch 的新命令也固定生成幂等回执', async () => {
    await insertReconciledManifest()
    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(1),
      commandInput('bridge', 2, 'runtime_bridge_initial'),
    )
    const noOpInput = commandInput(
      'bridge',
      2,
      'runtime_bridge_explicit_noop',
    )
    const noOp = await transitionAttributionRuntimeModeCommand(
      commandEnvironment(2),
      noOpInput,
    )
    expect(noOp).toMatchObject({
      mode: 'bridge',
      bridgeOwnerEpoch: 2,
      updatedAt: '2026-07-24T00:01:00.000Z',
    })
    expect(await count('attribution_audit_logs')).toBe(2)
    expect(await count('attribution_command_receipts')).toBe(2)

    await transitionAttributionRuntimeModeCommand(
      commandEnvironment(3),
      commandInput('active', 3, 'runtime_active_after_noop'),
    )
    await expect(transitionAttributionRuntimeModeCommand(
      commandEnvironment(4),
      {
        ...noOpInput,
        reason: '复用键但修改请求内容',
      },
    )).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  })

  it('并发重放只生成一份状态、审计和回执', async () => {
    await insertReconciledManifest()
    const input = commandInput('bridge', 2, 'runtime_bridge_concurrent')
    const results = await Promise.all([
      transitionAttributionRuntimeModeCommand(
        commandEnvironment(1),
        input,
      ),
      transitionAttributionRuntimeModeCommand(
        commandEnvironment(1),
        input,
      ),
    ])

    expect(results[0]).toEqual(results[1])
    expect(await count('attribution_audit_logs')).toBe(1)
    expect(await count('attribution_command_receipts')).toBe(1)
  })
})

function commandEnvironment(step: number) {
  return {
    db,
    now: () => new Date(`2026-07-24T00:0${step}:00.000Z`),
    idFactory: () => `audit_runtime_mode_${step}`,
  }
}

function commandInput(
  targetMode: 'bridge' | 'active' | 'fenced',
  sourceOwnerEpoch: number,
  idempotencyKey: string,
) {
  return {
    targetMode,
    sourceOwnerEpoch,
    actorId: 7,
    reason: targetMode === 'bridge'
      ? '完成最终对账并启动桥接'
      : targetMode === 'active'
        ? '旧运行时排空完成并激活'
        : '隔离新运行时并恢复旧写者',
    idempotencyKey,
  } as const
}

async function insertReconciledManifest() {
  await db.prepare(`
    INSERT INTO attribution_migration_manifests (
      initial_run_id,
      initial_snapshot_hash,
      source_configuration_hash,
      credential_set_hash,
      initial_captured_at,
      desired_runtime_policies_json,
      status,
      reconcile_run_id,
      reconcile_snapshot_hash,
      reconciled_captured_at,
      created_at,
      reconciled_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 'reconciled', ?, ?, ?, ?, ?)
  `).bind(
    'initial_runtime_test',
    'a'.repeat(64),
    'b'.repeat(64),
    'c'.repeat(64),
    '2026-07-24T00:00:00.000Z',
    'reconcile_runtime_test',
    'd'.repeat(64),
    '2026-07-24T00:01:00.000Z',
    '2026-07-24T00:00:00.000Z',
    '2026-07-24T00:01:00.000Z',
  ).run()
}

async function seedProcessingServerDelivery() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_processing', 'meta', 'Meta processing', NULL)
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by
      ) VALUES (
        'ver_processing',
        'conn_processing',
        'meta',
        'active',
        '{"pixelId":"1234567890123456"}',
        'hash_processing',
        1
      )
    `),
    db.prepare(`
      INSERT INTO attribution_facts (
        id, event_id, event_name, fact_origin, dedupe_hash,
        event_fingerprint, connection_id, version_id, provider,
        external_event_id, occurred_at, consent_json,
        analytics_dimensions_json, created_at
      ) VALUES (
        'fact_processing',
        'event_processing',
        'Contact',
        'live',
        ?,
        ?,
        'conn_processing',
        'ver_processing',
        'meta',
        'external_processing',
        '2026-07-24T00:02:00.000Z',
        '{}',
        '{}',
        '2026-07-24T00:02:00.000Z'
      )
    `).bind('e'.repeat(64), 'f'.repeat(64)),
    db.prepare(`
      INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, version_id, provider,
        transport, destination, external_event_id, status,
        runtime_owner_epoch, attempt_count, last_error_code,
        created_at, updated_at
      ) VALUES (
        'delivery_processing',
        'fact_processing',
        'conn_processing',
        'ver_processing',
        'meta',
        'server',
        'meta_capi',
        'external_processing',
        'retrying',
        3,
        1,
        'processing',
        '2026-07-24T00:02:00.000Z',
        '2026-07-24T00:02:00.000Z'
      )
    `),
  ])
}

async function seedPendingServerDelivery() {
  await seedProcessingServerDelivery()
  await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'planned',
          attempt_count = 0,
          last_error_code = ''
      WHERE id = 'delivery_processing'
    `),
    db.prepare(`
      INSERT INTO attribution_outbox (
        delivery_id, provider, version_id, schema_version,
        key_id, iv, ciphertext, tag, expires_at, created_at
      ) VALUES (
        'delivery_processing',
        'meta',
        'ver_processing',
        1,
        'key',
        'iv',
        'ciphertext',
        'tag',
        '2026-07-25T00:00:00.000Z',
        '2026-07-24T00:02:00.000Z'
      )
    `),
  ])
}

async function count(table: string) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS value FROM ${table}
  `).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

function cleanSql(value: string) {
  return value
    .replace(/^--.*$/gmu, '')
    .replace(/\s*\r?\n\s*/gu, ' ')
    .trim()
}
