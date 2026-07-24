import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import { recordCapacityUsage } from './capacity-monitor'
import {
  enqueueServerDelivery,
  physicalQueue,
  purgeExpiredServerOutbox,
  recoverPendingServerOutbox,
  type AttributionQueueMessage,
} from './secure-outbox'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0006_runtime_owner_epoch.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const now = new Date('2026-07-24T03:00:00.000Z')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'secure-outbox' },
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
    UPDATE attribution_runtime_state
    SET mode = 'active',
        activated_at = ?,
        bridge_owner_epoch = 2,
        active_owner_epoch = 3,
        fenced_owner_epoch = NULL,
        updated_at = ?
    WHERE id = 'global'
  `).bind(now.toISOString(), now.toISOString()).run()
  await seedDelivery()
})

describe('加密 Outbox 调度', () => {
  it('只向匹配 provider Queue 发送最小定位消息', async () => {
    const meta = queue()
    const result = await enqueueServerDelivery({
      db,
      queues: queues(meta),
      now: () => now,
    }, {
      provider: 'meta',
      deliveryId: 'delivery_meta',
    })

    expect(result).toBe('enqueued')
    expect(meta.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      provider: 'meta',
      deliveryId: 'delivery_meta',
    })
    expect(JSON.stringify(meta.send.mock.calls[0]?.[0])).not.toMatch(
      /ciphertext|credential|identifier|externalEventId/i,
    )
    expect(await deliveryState()).toMatchObject({
      status: 'queued',
      queue_attempt_count: 1,
    })
  })

  it('Queue 发送失败保留密文并由 D1 恢复复投同一 Delivery', async () => {
    const failed = queue()
    failed.send.mockRejectedValueOnce(new Error('queue unavailable'))
    expect(await enqueueServerDelivery({
      db,
      queues: queues(failed),
      now: () => now,
    }, {
      provider: 'meta',
      deliveryId: 'delivery_meta',
    })).toBe('failed')
    expect((await deliveryState()).status).toBe('retrying')
    expect(await outboxExists()).toBe(true)

    const recovered = queue()
    const result = await recoverPendingServerOutbox({
      db,
      queues: queues(recovered),
      now: () => new Date(now.getTime() + 6 * 60_000),
    })

    expect(result).toEqual({
      attempted: 1,
      enqueued: 1,
      failed: 0,
      expired: 0,
      paused: 0,
    })
    expect(recovered.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      provider: 'meta',
      deliveryId: 'delivery_meta',
    })
    expect((await deliveryState()).external_event_id).toBe(
      'attr1_meta_contact_event',
    )
  })

  it('bridge 的 Cron 恢复匹配 owner epoch 的待发送 Delivery', async () => {
    await db.batch([
      db.prepare(`
        UPDATE attribution_runtime_state
        SET mode = 'bridge',
            activated_at = NULL,
            bridge_owner_epoch = 2,
            active_owner_epoch = NULL,
            fenced_owner_epoch = NULL,
            updated_at = ?
        WHERE id = 'global'
      `).bind(now.toISOString()),
      db.prepare(`
        UPDATE attribution_deliveries
        SET runtime_owner_epoch = 2
        WHERE id = 'delivery_meta'
      `),
    ])
    const meta = queue()

    expect(await recoverPendingServerOutbox({
      db,
      queues: queues(meta),
      now: () => new Date(now.getTime() + 6 * 60_000),
    })).toEqual({
      attempted: 1,
      enqueued: 1,
      failed: 0,
      expired: 0,
      paused: 0,
    })
    expect(meta.send).toHaveBeenCalledOnce()
    expect(await deliveryState()).toMatchObject({
      status: 'queued',
      runtime_owner_epoch: 2,
    })
  })

  it('重新启用后不领取旧 owner epoch 的直接请求或 Cron Outbox', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_state
      SET mode = 'active',
          activated_at = ?,
          bridge_owner_epoch = 5,
          active_owner_epoch = 6,
          fenced_owner_epoch = NULL,
          updated_at = ?
      WHERE id = 'global'
    `).bind(now.toISOString(), now.toISOString()).run()
    const meta = queue()
    const environment = {
      db,
      queues: queues(meta),
      now: () => new Date(now.getTime() + 6 * 60_000),
    }

    expect(await enqueueServerDelivery(environment, {
      provider: 'meta',
      deliveryId: 'delivery_meta',
    })).toBe('not_pending')
    expect(await recoverPendingServerOutbox(environment)).toEqual({
      attempted: 0,
      enqueued: 0,
      failed: 0,
      expired: 0,
      paused: 0,
    })
    expect(meta.send).not.toHaveBeenCalled()
    expect(await deliveryState()).toMatchObject({
      status: 'planned',
      runtime_owner_epoch: 3,
    })
    expect(await outboxExists()).toBe(true)
  })

  it('fenced 原子取消待发送 Server Delivery 并销毁 Outbox', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_state
      SET mode = 'fenced',
          activated_at = NULL,
          bridge_owner_epoch = NULL,
          active_owner_epoch = NULL,
          fenced_owner_epoch = 4,
          updated_at = ?
      WHERE id = 'global'
    `).bind(now.toISOString()).run()

    expect(await deliveryState()).toMatchObject({
      status: 'cancelled',
      last_error_code: 'runtime_fenced',
      runtime_owner_epoch: 3,
    })
    expect(await outboxExists()).toBe(false)
  })

  it('过期 outbox 拒绝 Delivery、删除密文且不发送 Queue', async () => {
    await db.prepare(`
      UPDATE attribution_outbox
      SET expires_at = '2026-07-24T02:59:59.000Z'
      WHERE delivery_id = 'delivery_meta'
    `).run()
    const meta = queue()

    expect(await purgeExpiredServerOutbox(
      db,
      now,
    )).toBe(1)
    expect(meta.send).not.toHaveBeenCalled()
    expect(await deliveryState()).toMatchObject({
      status: 'rejected',
      last_error_code: 'outbox_expired',
    })
    expect(await outboxExists()).toBe(false)
    expect(await db.prepare(`
      SELECT severity, status, code
      FROM attribution_incidents
      WHERE id = 'outbox-expired:delivery_meta'
    `).first()).toEqual({
      severity: 'critical',
      status: 'open',
      code: 'outbox_recovery_expired',
    })
  })

  it('达到账户级 95% 时保留密文 Outbox 并暂停 Queue enqueue', async () => {
    await recordCapacityUsage(db, {
      schemaVersion: 1,
      date: '2026-07-24',
      measuredAt: '2026-07-24T02:59:00.000Z',
      source: 'cloudflare-account-analytics',
      workerRequests: 0,
      d1RowsRead: 0,
      d1RowsWritten: 0,
      queueOperations: 9_500,
    })
    const meta = queue()

    expect(await enqueueServerDelivery({
      db,
      queues: queues(meta),
      now: () => now,
    }, {
      provider: 'meta',
      deliveryId: 'delivery_meta',
    })).toBe('capacity_paused')
    expect(meta.send).not.toHaveBeenCalled()
    expect(await deliveryState()).toMatchObject({
      status: 'planned',
      queue_attempt_count: 0,
    })
    expect(await outboxExists()).toBe(true)
  })

  it('非法 expires_at 也按过期处理且不依赖运行策略联表', async () => {
    await db.batch([
      db.prepare(`
        UPDATE attribution_outbox
        SET expires_at = 'invalid'
        WHERE delivery_id = 'delivery_meta'
      `),
      db.prepare(`
        DELETE FROM attribution_runtime_policies
        WHERE connection_id = 'conn_meta'
      `),
    ])

    expect(await purgeExpiredServerOutbox(db, now)).toBe(1)
    expect(await deliveryState()).toMatchObject({
      status: 'rejected',
      last_error_code: 'outbox_expired',
    })
    expect(await outboxExists()).toBe(false)
  })

  it('物理 Queue 名严格区分环境、provider 和 DLQ', () => {
    expect(physicalQueue(
      'meigallery-attribution-tiktok',
      'production',
    )).toEqual({ provider: 'tiktok', deadLetter: false })
    expect(physicalQueue(
      'meigallery-attribution-google-dev-dlq',
      'dev',
    )).toEqual({ provider: 'google', deadLetter: true })
    expect(physicalQueue(
      'meigallery-attribution-meta',
      'dev',
    )).toBeNull()
    expect(physicalQueue('unknown', 'production')).toBeNull()
  })
})

function queue() {
  return {
    send: vi.fn<(
      message: AttributionQueueMessage,
    ) => Promise<unknown>>().mockResolvedValue({}),
  }
}

function queues(meta = queue()) {
  return {
    meta: meta as unknown as Queue<AttributionQueueMessage>,
    tiktok: queue() as unknown as Queue<AttributionQueueMessage>,
    google: queue() as unknown as Queue<AttributionQueueMessage>,
  }
}

async function seedDelivery() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta', 'meta', 'Meta', 'ver_meta')
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_meta', 'conn_meta', 'meta', 'active', '{}',
        'hash_meta', 1, ?
      )
    `).bind(now.toISOString()),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by, updated_at
      ) VALUES (
        'conn_meta', 1, 1, 1,
        10, 10,
        'closed', 1, ?
      )
    `).bind(now.toISOString()),
    db.prepare(`
      INSERT INTO attribution_facts (
        id, event_id, event_name, fact_origin, dedupe_hash,
        event_fingerprint, connection_id, version_id, provider,
        external_event_id, occurred_at, consent_json,
        analytics_dimensions_json, created_at
      ) VALUES (
        'fact_meta', 'event_meta', 'Contact', 'live', ?,
        ?, 'conn_meta', 'ver_meta', 'meta',
        'attr1_meta_contact_event', ?, '{}', '{}', ?
      )
    `).bind(
      'a'.repeat(64),
      'b'.repeat(64),
      now.toISOString(),
      now.toISOString(),
    ),
    db.prepare(`
      INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, version_id, provider,
        transport, destination, external_event_id, status,
        runtime_owner_epoch, created_at, updated_at
      ) VALUES (
        'delivery_meta', 'fact_meta', 'conn_meta', 'ver_meta', 'meta',
        'server', 'meta_capi', 'attr1_meta_contact_event', 'planned',
        3, ?, ?
      )
    `).bind(now.toISOString(), now.toISOString()),
    db.prepare(`
      INSERT INTO attribution_outbox (
        delivery_id, provider, version_id, schema_version,
        key_id, iv, ciphertext, tag, expires_at, created_at
      ) VALUES (
        'delivery_meta', 'meta', 'ver_meta', 1,
        'key', 'iv', 'ciphertext', 'tag', ?, ?
      )
    `).bind(
      new Date(now.getTime() + 60 * 60_000).toISOString(),
      now.toISOString(),
    ),
  ])
}

async function deliveryState() {
  return db.prepare(`
    SELECT
      status,
      queue_attempt_count,
      external_event_id,
      last_error_code,
      runtime_owner_epoch
    FROM attribution_deliveries
    WHERE id = 'delivery_meta'
  `).first<{
    status: string
    queue_attempt_count: number
    external_event_id: string
    last_error_code: string
    runtime_owner_epoch: number
  }>()
}

async function outboxExists() {
  return Boolean(await db.prepare(`
    SELECT delivery_id
    FROM attribution_outbox
    WHERE delivery_id = 'delivery_meta'
  `).first())
}
