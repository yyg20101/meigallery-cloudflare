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
  assertAttributionRuntimeOwner,
  readAttributionRuntimeOwner,
  restoreAttributionRuntimeOwner,
  transitionAttributionRuntimeOwner,
} from './attribution-runtime-owner'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'attribution-runtime-owner' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(cleanSql(`
    CREATE TABLE attribution_runtime_cutover (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      changed_by INTEGER,
      changed_at TEXT NOT NULL
    );
    CREATE TABLE attribution_runtime_cutover_commands (
      idempotency_key TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE attribution_conversion_facts (
      id TEXT PRIMARY KEY,
      canonical_event TEXT NOT NULL,
      analytics_dimensions_json TEXT NOT NULL
    );
    CREATE TABLE attribution_business_outbox (
      id TEXT PRIMARY KEY,
      routing_owner TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE attribution_deliveries (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE attribution_outbox (
      delivery_id TEXT PRIMARY KEY
    );
  `))
})

beforeEach(async () => {
  await db.exec(cleanSql(`
    DELETE FROM attribution_outbox;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_business_outbox;
    DELETE FROM attribution_conversion_facts;
    DELETE FROM users;
    DELETE FROM admin_audit_logs;
    DELETE FROM attribution_runtime_cutover_commands;
    DELETE FROM attribution_runtime_cutover;
    INSERT INTO attribution_runtime_cutover (
      id, owner, owner_epoch, changed_by, changed_at
    ) VALUES (
      'global', 'old', 1, NULL, '2026-07-24T00:00:00.000Z'
    );
  `))
})

afterAll(async () => miniflare.dispose())

describe('归因运行时单写所有权', () => {
  it('默认 old 并按 old -> draining -> new 单向增加 epoch', async () => {
    expect(await readAttributionRuntimeOwner(db)).toEqual({
      owner: 'old',
      epoch: 1,
      changedBy: null,
      changedAt: '2026-07-24T00:00:00.000Z',
    })

    const draining = await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_to_draining',
    })
    expect(draining).toMatchObject({ owner: 'draining', epoch: 2 })

    const active = await transitionAttributionRuntimeOwner(env(2), {
      targetOwner: 'new',
      expectedEpoch: 2,
      actorId: 7,
      reason: '完成最终集合对账',
      idempotencyKey: 'owner_to_new',
    })
    expect(active).toMatchObject({ owner: 'new', epoch: 3 })

    const audits = await db.prepare(`
      SELECT action, before_value, after_value
      FROM admin_audit_logs
      ORDER BY created_at
    `).all<{
      action: string
      before_value: string
      after_value: string
    }>()
    expect(audits.results).toHaveLength(2)
    expect(audits.results.map(row => row.action)).toEqual([
      'attribution_runtime_owner_transition',
      'attribution_runtime_owner_transition',
    ])
    const receipts = await db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_runtime_cutover_commands
    `).first<{ value: number }>()
    expect(receipts?.value).toBe(2)
  })

  it('重复目标幂等且 epoch 过期或跨级切换被拒绝', async () => {
    const first = await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_replay_draining',
    })
    const replay = await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_replay_draining',
    })
    expect(replay).toEqual(first)
    await expect(transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '不同请求不可复用同一幂等键',
      idempotencyKey: 'owner_replay_draining',
    })).rejects.toThrow(
      'ATTRIBUTION_RUNTIME_OWNER_IDEMPOTENCY_CONFLICT',
    )

    await expect(transitionAttributionRuntimeOwner(env(2), {
      targetOwner: 'new',
      expectedEpoch: 1,
      actorId: 7,
      reason: '使用过期 epoch 切换',
      idempotencyKey: 'owner_stale_epoch',
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT')

    await db.prepare(`
      UPDATE attribution_runtime_cutover
      SET owner = 'old', owner_epoch = 1
      WHERE id = 'global'
    `).run()
    await expect(transitionAttributionRuntimeOwner(env(2), {
      targetOwner: 'new',
      expectedEpoch: 1,
      actorId: 7,
      reason: '禁止跨级切换运行时',
      idempotencyKey: 'owner_skip_stage',
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_REGRESSION')
  })

  it('相同 owner/epoch 的新命令也写入固定幂等回执', async () => {
    await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_noop_setup',
    })
    const input = {
      targetOwner: 'draining' as const,
      expectedEpoch: 2,
      actorId: 7,
      reason: '确认生产切换排空状态',
      idempotencyKey: 'owner_noop_receipt',
    }
    await expect(transitionAttributionRuntimeOwner(
      env(2),
      input,
    )).resolves.toMatchObject({ owner: 'draining', epoch: 2 })
    expect(await count('admin_audit_logs')).toBe(2)
    expect(await count(
      'attribution_runtime_cutover_commands',
    )).toBe(2)

    await expect(transitionAttributionRuntimeOwner(env(3), {
      ...input,
      reason: '复用幂等键但改变请求内容',
    })).rejects.toThrow(
      'ATTRIBUTION_RUNTIME_OWNER_IDEMPOTENCY_CONFLICT',
    )
  })

  it('普通切换禁止回退，显式 restore 单独审计并增加 epoch', async () => {
    await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_restore_setup',
    })
    await expect(transitionAttributionRuntimeOwner(env(2), {
      targetOwner: 'old',
      expectedEpoch: 2,
      actorId: 7,
      reason: '普通命令不得回退',
      idempotencyKey: 'owner_invalid_restore',
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_REGRESSION')

    const restored = await restoreAttributionRuntimeOwner(env(2), {
      expectedEpoch: 2,
      actorId: 7,
      reason: '新运行时 smoke 失败回滚',
      idempotencyKey: 'owner_explicit_restore',
    })
    expect(restored).toMatchObject({ owner: 'old', epoch: 3 })
    const audit = await db.prepare(`
      SELECT action
      FROM admin_audit_logs
      WHERE action = 'attribution_runtime_owner_restore'
    `).first<{ action: string }>()
    expect(audit?.action).toBe('attribution_runtime_owner_restore')
  })

  it('写入前 epoch 断言阻断切换后仍持有旧状态的请求', async () => {
    await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_epoch_assertion',
    })

    await expect(assertAttributionRuntimeOwner(db, {
      owner: 'old',
      epoch: 1,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_CHANGED')
    await expect(assertAttributionRuntimeOwner(db, {
      owner: 'draining',
      epoch: 2,
    })).resolves.toMatchObject({ owner: 'draining', epoch: 2 })
  })

  it('D1 CAS 在交权原子点再次检查注册事实与 Outbox', async () => {
    await db.prepare(`
      INSERT INTO users (id) VALUES (99)
    `).run()

    await expect(transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '预检后出现并发注册',
      idempotencyKey: 'owner_atomic_preflight',
    })).rejects.toThrow(
      'ATTRIBUTION_RUNTIME_OWNER_PREFLIGHT_CHANGED',
    )
    expect(await readAttributionRuntimeOwner(db)).toMatchObject({
      owner: 'old',
      epoch: 1,
    })
    const audit = await db.prepare(`
      SELECT COUNT(*) AS value FROM admin_audit_logs
    `).first<{ value: number }>()
    expect(audit?.value).toBe(0)
    const receipt = await db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_runtime_cutover_commands
      WHERE idempotency_key = 'owner_atomic_preflight'
    `).first<{ value: number }>()
    expect(receipt?.value).toBe(0)
  })

  it('draining -> new 在 CAS 原子点阻断任意未排空业务 outbox', async () => {
    await transitionAttributionRuntimeOwner(env(1), {
      targetOwner: 'draining',
      expectedEpoch: 1,
      actorId: 7,
      reason: '开始生产切换排空',
      idempotencyKey: 'owner_pending_setup',
    })
    await db.prepare(`
      INSERT INTO attribution_business_outbox (
        id, routing_owner, status
      ) VALUES ('registration_pending_2', 'draining', 'pending')
    `).run()

    await expect(transitionAttributionRuntimeOwner(env(2), {
      targetOwner: 'new',
      expectedEpoch: 2,
      actorId: 7,
      reason: '尝试在业务事件未排空时交权',
      idempotencyKey: 'owner_pending_to_new',
    })).rejects.toThrow(
      'ATTRIBUTION_RUNTIME_OWNER_PREFLIGHT_CHANGED',
    )
    expect(await readAttributionRuntimeOwner(db)).toMatchObject({
      owner: 'draining',
      epoch: 2,
    })
  })
})

function env(step: number) {
  return {
    db,
    now: () => new Date(`2026-07-24T00:0${step}:00.000Z`),
    idFactory: () => `audit_owner_${step}`,
  }
}

function cleanSql(value: string) {
  return value.replace(/\s*\r?\n\s*/gu, ' ').trim()
}

async function count(table: string) {
  const allowed = new Set([
    'admin_audit_logs',
    'attribution_runtime_cutover_commands',
  ])
  if (!allowed.has(table)) throw new Error('TEST_TABLE_INVALID')
  const row = await db.prepare(`
    SELECT COUNT(*) AS value FROM ${table}
  `).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
