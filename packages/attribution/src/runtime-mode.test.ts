import { readFileSync } from 'node:fs'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import type { AttributionBindings } from './env'
import {
  app,
  attributionServiceApp,
} from './index'
import {
  readAttributionRuntimeState,
  transitionAttributionRuntimeMode,
} from './services/runtime-state'

const migrations = [
  '../migrations/0001_attribution_runtime.sql',
  '../migrations/0002_event_delivery.sql',
  '../migrations/0004_runtime_state.sql',
  '../migrations/0006_runtime_owner_epoch.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const origin = 'https://616618.xyz'
let miniflare: Miniflare
let db: D1Database
let legacyDeliveryColumns: string[]
let upgradedDeliveryColumns: string[]
let upgradedLegacyDelivery: {
  status: string
  last_error_code: string
  runtime_owner_epoch: number
} | null
let upgradedLegacyOutboxCount: number
let missingOwnerEpochRejected: boolean
let upgradedLegacyState: Awaited<
  ReturnType<typeof readAttributionRuntimeState>
>

const queue = {
  send: async () => {},
} as unknown as Queue

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'runtime-mode' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const [index, migration] of migrations.entries()) {
    await db.exec(migration.replace(/\s*\r?\n\s*/g, ' '))
    if (index === 1) {
      const columns = await db.prepare(`
        PRAGMA table_info(attribution_deliveries)
      `).all<{ name: string }>()
      legacyDeliveryColumns = columns.results.map(column => column.name)
      await seedLegacyDelivery()
    }
    if (index === 2) {
      await db.prepare(`
        UPDATE attribution_runtime_state
        SET mode = 'active',
            activated_at = '2026-07-23T23:59:00.000Z',
            updated_at = '2026-07-23T23:59:00.000Z'
        WHERE id = 'global'
      `).run()
    }
  }
  const columns = await db.prepare(`
    PRAGMA table_info(attribution_deliveries)
  `).all<{ name: string }>()
  upgradedDeliveryColumns = columns.results.map(column => column.name)
  upgradedLegacyDelivery = await db.prepare(`
    SELECT status, last_error_code, runtime_owner_epoch
    FROM attribution_deliveries
    WHERE id = 'delivery_legacy'
  `).first()
  const outboxCount = await db.prepare(`
    SELECT COUNT(*) AS value
    FROM attribution_outbox
    WHERE delivery_id = 'delivery_legacy'
  `).first<{ value: number }>()
  upgradedLegacyOutboxCount = outboxCount?.value ?? -1
  try {
    await db.prepare(`
      INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, version_id, provider, transport,
        destination, external_event_id, status
      ) VALUES (
        'delivery_missing_epoch',
        'fact_legacy',
        'conn_legacy',
        'ver_legacy',
        'meta',
        'browser',
        'pixel_legacy',
        'external_legacy',
        'planned'
      )
    `).run()
    missingOwnerEpochRejected = false
  } catch {
    missingOwnerEpochRejected = true
  }
  upgradedLegacyState = await readAttributionRuntimeState(db)
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await db.prepare(`
    UPDATE attribution_runtime_state
    SET mode = 'shadow',
        activated_at = NULL,
        bridge_owner_epoch = NULL,
        active_owner_epoch = NULL,
        fenced_owner_epoch = NULL,
        updated_at = '2026-07-24T00:00:00.000Z'
    WHERE id = 'global'
  `).run()
})

describe('Attribution Worker 运行模式', () => {
  it('旧 active 状态升级时确定性映射首轮 owner epoch', () => {
    expect(legacyDeliveryColumns).not.toContain('runtime_owner_epoch')
    expect(upgradedDeliveryColumns).toContain('runtime_owner_epoch')
    expect(upgradedLegacyState).toMatchObject({
      mode: 'active',
      bridgeOwnerEpoch: 2,
      activeOwnerEpoch: 3,
    })
  })

  it('旧投递升级后隔离 epoch=1 且新投递必须显式提供 epoch', () => {
    expect(upgradedLegacyDelivery).toEqual({
      status: 'cancelled',
      last_error_code: 'runtime_epoch_migration',
      runtime_owner_epoch: 1,
    })
    expect(upgradedLegacyOutboxCount).toBe(0)
    expect(missingOwnerEpochRejected).toBe(true)
  })

  it('默认 shadow 且只能按顺序单向切换，重复命令幂等', async () => {
    expect(await readAttributionRuntimeState(db)).toMatchObject({
      mode: 'shadow',
      activatedAt: null,
      bridgeOwnerEpoch: null,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: null,
    })

    await expect(
      transitionAttributionRuntimeMode(db, 'active', {
        sourceOwnerEpoch: 3,
      }),
    ).rejects.toThrow('ATTRIBUTION_RUNTIME_TRANSITION_INVALID')

    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
    })
    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
    })
    expect((await readAttributionRuntimeState(db)).mode).toBe('bridge')

    await transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 3,
    })
    await transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 3,
    })
    expect(await readAttributionRuntimeState(db)).toMatchObject({
      mode: 'active',
      activatedAt: expect.any(String),
      bridgeOwnerEpoch: 2,
      activeOwnerEpoch: 3,
    })

    await expect(
      transitionAttributionRuntimeMode(db, 'bridge', {
        sourceOwnerEpoch: 2,
      }),
    ).rejects.toThrow('ATTRIBUTION_RUNTIME_TRANSITION_INVALID')
  })

  it('shadow 拒绝公开事实与内部写入所有权，health 暴露当前模式', async () => {
    const env = bindings()

    const health = await app.request('/health', {}, env)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: 'ok',
      runtimeMode: 'shadow',
    })

    const publicFact = await app.request('/v1/events/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: '{}',
    }, env)
    expect(publicFact.status).toBe(503)
    expect(await publicFact.json()).toMatchObject({
      code: 'ATTRIBUTION_NOT_ACTIVE',
      runtimeMode: 'shadow',
    })

    const internalFact = await attributionServiceApp.request(
      '/internal/v1/registration-events',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...ownershipHeaders('draining', 2),
        },
        body: '{}',
      },
      env,
    )
    expect(internalFact.status).toBe(503)
    expect(await internalFact.json()).toMatchObject({
      code: 'ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED',
    })
  })

  it('active 接受切换窗口与新所有者 epoch，不用 Git revision 决策', async () => {
    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
    })
    await transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 3,
    })
    const env = bindings()

    const publicFact = await app.request('/v1/events/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: '{}',
    }, env)
    expect(publicFact.status).toBe(400)
    expect(await publicFact.json()).toMatchObject({
      code: 'ATTRIBUTION_CONTACT_REQUEST_INVALID',
    })

    for (const ownership of [
      ownershipHeaders('draining', 2),
      ownershipHeaders('new', 3),
    ]) {
      const internalFact = await attributionServiceApp.request(
        '/internal/v1/registration-events',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...ownership,
          },
          body: '{}',
        },
        env,
      )
      expect(internalFact.status).toBe(400)
      expect(await internalFact.json()).toMatchObject({
        code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
      })
    }
  })

  it('fenced 与 shadow 一样拒绝公网和内部写入', async () => {
    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
    })
    await transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 3,
    })
    await transitionAttributionRuntimeMode(db, 'fenced', {
      sourceOwnerEpoch: 4,
    })
    const env = bindings()

    const publicFact = await app.request('/v1/events/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: '{}',
    }, env)
    expect(publicFact.status).toBe(503)
    expect(await publicFact.json()).toMatchObject({
      code: 'ATTRIBUTION_NOT_ACTIVE',
      runtimeMode: 'fenced',
    })

    const internalFact = await attributionServiceApp.request(
      '/internal/v1/registration-events',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...ownershipHeaders('new', 3),
        },
        body: '{}',
      },
      env,
    )
    expect(internalFact.status).toBe(503)
    expect(await internalFact.json()).toMatchObject({
      code: 'ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED',
    })
  })
})

function ownershipHeaders(
  owner: 'draining' | 'new',
  epoch: number,
) {
  return {
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_OWNER]: owner,
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_EPOCH]: String(epoch),
  }
}

async function seedLegacyDelivery(): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, is_default
      ) VALUES ('conn_legacy', 'meta', 'legacy', 1)
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by
      ) VALUES (
        'ver_legacy',
        'conn_legacy',
        'meta',
        'active',
        '{}',
        'legacy_config_hash',
        1
      )
    `),
    db.prepare(`
      INSERT INTO attribution_facts (
        id, event_id, event_name, fact_origin, dedupe_hash,
        event_fingerprint, connection_id, version_id, provider,
        external_event_id, occurred_at, consent_json,
        analytics_dimensions_json
      ) VALUES (
        'fact_legacy',
        'event_legacy',
        'Contact',
        'live',
        ?,
        ?,
        'conn_legacy',
        'ver_legacy',
        'meta',
        'external_legacy',
        '2026-07-23T23:58:00.000Z',
        '{}',
        '{}'
      )
    `).bind('a'.repeat(64), 'b'.repeat(64)),
    db.prepare(`
      INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, version_id, provider, transport,
        destination, external_event_id, status
      ) VALUES (
        'delivery_legacy',
        'fact_legacy',
        'conn_legacy',
        'ver_legacy',
        'meta',
        'server',
        'dataset_legacy',
        'external_legacy',
        'queued'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_outbox (
        delivery_id, provider, version_id, schema_version, key_id,
        iv, ciphertext, tag, expires_at
      ) VALUES (
        'delivery_legacy',
        'meta',
        'ver_legacy',
        1,
        'key',
        'iv',
        'ciphertext',
        'tag',
        '2026-07-25T00:00:00.000Z'
      )
    `),
  ])
}

function bindings(): AttributionBindings {
  return {
    DB: db,
    APP_ENV: 'production',
    ATTRIBUTION_PUBLIC_ORIGINS: origin,
    ATTRIBUTION_COOKIE_DOMAIN: '.616618.xyz',
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT:
      'runtime-mode-credential-master-key-current',
    ATTRIBUTION_SIGNING_KEY_CURRENT:
      'runtime-mode-signing-key-current-at-least-32-bytes',
    ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT:
      'runtime-mode-data-encryption-key-current',
    META_QUEUE: queue,
    TIKTOK_QUEUE: queue,
    GOOGLE_QUEUE: queue,
    ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW: {
      createBatch: async () => [],
    } as unknown as AttributionBindings[
      'ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW'
    ],
  }
}
