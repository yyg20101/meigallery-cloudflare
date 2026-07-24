import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  readAttributionCutoverPreflight,
  readAttributionRestorePreflight,
} from './attribution-cutover-preflight'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'attribution-cutover-preflight' },
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
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE attribution_conversion_facts (
      id TEXT PRIMARY KEY,
      canonical_event TEXT NOT NULL,
      analytics_dimensions_json TEXT NOT NULL
    );
    CREATE TABLE attribution_business_outbox (
      id TEXT PRIMARY KEY,
      routing_owner TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
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
    DELETE FROM attribution_runtime_cutover;
    INSERT INTO attribution_runtime_cutover (
      id, owner, owner_epoch, changed_by, changed_at
    ) VALUES (
      'global', 'old', 1, NULL, '2026-07-24T00:00:00.000Z'
    );
  `))
})

afterAll(async () => miniflare.dispose())

describe('归因运行时切换预检', () => {
  it('old -> draining 阻断缺失注册事实和未结清旧业务 Outbox', async () => {
    await seedUserAndOldOutbox()
    const preflight = await readAttributionCutoverPreflight(
      db,
      remoteState('bridge', 2),
      'draining',
    )

    expect(preflight.ready).toBe(false)
    expect(preflight.counts).toMatchObject({
      missingRegistrationFacts: 1,
      oldBusinessOutboxPending: 1,
    })
    expect(preflight.checks).toMatchObject({
      remoteModeReady: true,
      remoteEpochReady: true,
      registrationFactsReady: false,
      oldBusinessOutboxReady: false,
    })
  })

  it('draining 阶段允许旧平台队列继续排空', async () => {
    await seedUserAndOldOutbox()
    await seedRegistrationFact()
    await db.prepare(`
      UPDATE attribution_business_outbox
      SET status = 'completed'
      WHERE id = 'registration_user_1'
    `).run()
    await seedOldServerWork()

    const preflight = await readAttributionCutoverPreflight(
      db,
      remoteState('bridge', 2),
      'draining',
    )
    expect(preflight.ready).toBe(true)
    expect(preflight.counts.oldServerWorkPending).toBe(1)
    expect(preflight.counts.oldEncryptedOutboxPending).toBe(1)
    expect(preflight.checks.oldServerWorkReady).toBe(true)
    expect(preflight.checks.oldEncryptedOutboxReady).toBe(true)
  })

  it('draining -> new 阻断旧 Server、Google 异步诊断和加密 Outbox', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_cutover
      SET owner = 'draining', owner_epoch = 2
      WHERE id = 'global'
    `).run()
    await seedOldServerWork()
    await db.prepare(`
      INSERT INTO attribution_deliveries (
        id, provider, transport, status
      ) VALUES ('delivery_google', 'google', 'server', 'accepted')
    `).run()

    const blocked = await readAttributionCutoverPreflight(
      db,
      remoteState('active', 3),
      'new',
    )
    expect(blocked.ready).toBe(false)
    expect(blocked.counts.oldServerWorkPending).toBe(2)
    expect(blocked.counts.oldEncryptedOutboxPending).toBe(1)

    await db.exec(cleanSql(`
      DELETE FROM attribution_outbox;
      UPDATE attribution_deliveries
      SET status = CASE
        WHEN provider = 'google' THEN 'processed'
        ELSE 'accepted'
      END;
    `))
    const ready = await readAttributionCutoverPreflight(
      db,
      remoteState('active', 3),
      'new',
    )
    expect(ready.ready).toBe(true)
  })

  it('draining -> new 阻断任意旧 epoch 或当前 epoch 的业务 Outbox', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_cutover
      SET owner = 'draining', owner_epoch = 2
      WHERE id = 'global'
    `).run()
    await db.exec(cleanSql(`
      INSERT INTO attribution_business_outbox (
        id, routing_owner, status, payload_json
      ) VALUES
        (
          'registration_old',
          'old',
          'pending',
          '{"payload":{"userId":1}}'
        ),
        (
          'registration_draining',
          'draining',
          'dispatching',
          '{"payload":{"userId":2}}'
        ),
        (
          'registration_new',
          'new',
          'pending',
          '{"payload":{"userId":3}}'
        );
    `))

    const blocked = await readAttributionCutoverPreflight(
      db,
      remoteState('active', 3),
      'new',
    )

    expect(blocked.ready).toBe(false)
    expect(blocked.counts.oldBusinessOutboxPending).toBe(3)
    expect(blocked.checks.oldBusinessOutboxReady).toBe(false)
  })

  it('远端模式或 epoch 不匹配时始终阻断', async () => {
    const wrongMode = await readAttributionCutoverPreflight(
      db,
      remoteState('bridge', 2),
      'new',
    )
    expect(wrongMode.ready).toBe(false)
    expect(wrongMode.checks.remoteModeReady).toBe(false)

    const wrongEpoch = await readAttributionCutoverPreflight(
      db,
      remoteState('bridge', 4),
      'draining',
    )
    expect(wrongEpoch.ready).toBe(false)
    expect(wrongEpoch.checks.remoteEpochReady).toBe(false)
  })

  it('回滚前必须清空已路由到新侧但尚未发送的业务 Outbox', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_cutover
      SET owner = 'draining', owner_epoch = 2
      WHERE id = 'global'
    `).run()
    await db.prepare(`
      INSERT INTO attribution_business_outbox (
        id, routing_owner, status, payload_json
      ) VALUES (
        'registration_user_9',
        'draining',
        'pending',
        '{"payload":{"userId":9}}'
      )
    `).run()

    const blocked = await readAttributionRestorePreflight(
      db,
      remoteState('bridge', 2),
    )
    expect(blocked.ready).toBe(false)
    expect(blocked.pendingForwardBusinessOutbox).toBe(1)

    await db.prepare(`
      UPDATE attribution_business_outbox
      SET status = 'completed'
      WHERE id = 'registration_user_9'
    `).run()
    const ready = await readAttributionRestorePreflight(
      db,
      remoteState('bridge', 2),
    )
    expect(ready.safeToFence).toBe(true)
    expect(ready.ready).toBe(false)
    expect(ready.restoredEpoch).toBe(3)

    const fenced = await readAttributionRestorePreflight(
      db,
      remoteState('fenced', 3),
    )
    expect(fenced.safeToFence).toBe(true)
    expect(fenced.ready).toBe(true)
    expect(fenced.checks.remoteFenced).toBe(true)
  })

  it('回滚前必须等待新 Worker 正在处理的平台请求结束', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_cutover
      SET owner = 'new', owner_epoch = 3
      WHERE id = 'global'
    `).run()

    const blocked = await readAttributionRestorePreflight(
      db,
      remoteState('active', 3, 1),
    )
    expect(blocked.safeToFence).toBe(false)
    expect(blocked.checks.remoteInFlightDrained).toBe(false)

    const ready = await readAttributionRestorePreflight(
      db,
      remoteState('active', 3),
    )
    expect(ready.safeToFence).toBe(true)
  })
})

function remoteState(
  mode: 'bridge' | 'active' | 'fenced',
  ownerEpoch: number,
  inFlightServerDeliveries = 0,
) {
  return {
    readRuntimeState: vi.fn(async () => ({
      mode,
      activatedAt: mode === 'active'
        ? '2026-07-24T00:02:00.000Z'
        : null,
      bridgeOwnerEpoch: mode === 'bridge'
        ? ownerEpoch
        : mode === 'active'
          ? 2
          : null,
      activeOwnerEpoch: mode === 'active' ? ownerEpoch : null,
      fencedOwnerEpoch: mode === 'fenced' ? ownerEpoch : null,
      updatedAt: '2026-07-24T00:02:00.000Z',
      migrationReconciled: true,
      inFlightServerDeliveries,
    })),
  }
}

async function seedUserAndOldOutbox() {
  await db.exec(cleanSql(`
    INSERT INTO users (id, created_at)
    VALUES (1, '2026-07-24T00:00:00.000Z');
    INSERT INTO attribution_business_outbox (
      id, routing_owner, status, payload_json
    ) VALUES (
      'registration_user_1',
      'old',
      'pending',
      '{"payload":{"userId":1}}'
    );
  `))
}

async function seedRegistrationFact() {
  await db.prepare(`
    INSERT INTO attribution_conversion_facts (
      id, canonical_event, analytics_dimensions_json
    ) VALUES (?, 'CompleteRegistration', ?)
  `).bind('fact_registration_1', JSON.stringify({ userId: 1 })).run()
}

async function seedOldServerWork() {
  await db.exec(cleanSql(`
    INSERT INTO attribution_deliveries (
      id, provider, transport, status
    ) VALUES ('delivery_meta', 'meta', 'server', 'queued');
    INSERT INTO attribution_outbox (delivery_id)
    VALUES ('delivery_meta');
  `))
}

function cleanSql(value: string) {
  return value.replace(/\s*\r?\n\s*/gu, ' ').trim()
}
