import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import type {
  AttributionProviderAdapter,
  QualitySignalResult,
} from '../adapters/types'
import { sealCredential } from './credential-vault'
import { collectQualitySignals } from './quality-collector'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const MASTER_KEY = 'quality-collector-master-key-32-bytes-minimum'
const OPERATION_DATE = new Date('2026-07-24T23:55:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'quality-collector' },
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
  await seedActiveConnection()
})

describe('平台质量日报', () => {
  it('质量 API 无权限只记录 unavailable 且不修改运行策略', async () => {
    const adapter = adapterWith({
      availability: 'unavailable',
      provider: 'meta',
      reason: 'permission_denied',
      checkedAt: OPERATION_DATE.toISOString(),
    })
    const before = await runtimePolicy()

    await expect(collectQualitySignals({
      db,
      credentialMasterKeys: { current: MASTER_KEY },
      adapterFor: () => adapter,
    }, OPERATION_DATE)).resolves.toEqual({
      attempted: 1,
      available: 0,
      unavailable: 1,
      error: 0,
    })

    expect(await qualityRows()).toEqual([{
      metric_key: 'quality_status',
      availability: 'unavailable',
      value: null,
    }])
    expect(await runtimePolicy()).toEqual(before)
  })

  it('通过统一 Adapter 写入每个 Canonical Event 的可用指标', async () => {
    const adapter = adapterWith({
      availability: 'available',
      provider: 'meta',
      metrics: [
        { canonicalEvent: 'Contact', key: 'emq_score', value: 7.2 },
        {
          canonicalEvent: 'CompleteRegistration',
          key: 'fbc_coverage',
          value: 88,
        },
      ],
      checkedAt: OPERATION_DATE.toISOString(),
    })

    await collectQualitySignals({
      db,
      credentialMasterKeys: { current: MASTER_KEY },
      adapterFor: () => adapter,
    }, OPERATION_DATE)

    expect(await qualityRows()).toEqual([
      {
        metric_key: 'CompleteRegistration:fbc_coverage',
        availability: 'available',
        value: 88,
      },
      {
        metric_key: 'Contact:emq_score',
        availability: 'available',
        value: 7.2,
      },
    ])
    expect(adapter.readQualitySignal).toHaveBeenCalledWith({
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta_active',
      publicConfig: { pixelId: '1234567890123456' },
      credential: 'meta-quality-token',
    })
  })

  it('Adapter 异常只记录 error 并继续保留运行策略', async () => {
    const adapter = adapterWith({
      availability: 'unavailable',
      provider: 'meta',
      reason: 'unused',
      checkedAt: OPERATION_DATE.toISOString(),
    })
    vi.mocked(adapter.readQualitySignal).mockRejectedValueOnce(
      new Error('provider unavailable'),
    )
    const before = await runtimePolicy()

    await collectQualitySignals({
      db,
      credentialMasterKeys: { current: MASTER_KEY },
      adapterFor: () => adapter,
    }, OPERATION_DATE)

    expect(await qualityRows()).toEqual([{
      metric_key: 'quality_status',
      availability: 'error',
      value: null,
    }])
    expect(await runtimePolicy()).toEqual(before)
  })
})

function adapterWith(
  signal: QualitySignalResult,
): AttributionProviderAdapter {
  return {
    provider: 'meta',
    eventName: event => event,
    normalizeTestEventCode: value =>
      typeof value === 'string' ? value : null,
    validateCandidate: vi.fn(),
    buildBrowserInstruction: vi.fn(),
    deliverServerEvent: vi.fn(),
    readQualitySignal: vi.fn().mockResolvedValue(signal),
  }
}

async function seedActiveConnection(): Promise<void> {
  const envelope = await sealCredential({ current: MASTER_KEY }, {
    provider: 'meta',
    versionId: 'ver_meta_active',
    plaintext: 'meta-quality-token',
  })
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, is_default, active_version_id
      ) VALUES (
        'conn_meta', 'meta', 'Meta production', 1, 'ver_meta_active'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id,
        connection_id,
        provider,
        status,
        public_config_json,
        config_hash,
        created_by
      ) VALUES (
        'ver_meta_active',
        'conn_meta',
        'meta',
        'active',
        '{"pixelId":"1234567890123456"}',
        'config_hash_meta',
        1
      )
    `),
    db.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id,
        provider,
        schema_version,
        key_id,
        iv,
        ciphertext,
        tag,
        credential_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'ver_meta_active',
      'meta',
      envelope.schemaVersion,
      envelope.keyId,
      envelope.iv,
      envelope.ciphertext,
      envelope.tag,
      envelope.fingerprint,
    ),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id,
        enabled,
        browser_enabled,
        server_enabled,
        server_target_percentage,
        server_effective_percentage,
        circuit_state,
        runtime_generation,
        updated_by
      ) VALUES (
        'conn_meta', 1, 1, 1, 10, 10, 'closed', 1, 1
      )
    `),
  ])
}

async function runtimePolicy() {
  return db.prepare(`
    SELECT *
    FROM attribution_runtime_policies
    WHERE connection_id = 'conn_meta'
  `).first()
}

async function qualityRows() {
  const rows = await db.prepare(`
    SELECT metric_key, availability, value
    FROM attribution_quality_daily
    WHERE date = '2026-07-24'
      AND connection_id = 'conn_meta'
    ORDER BY metric_key
  `).all()
  return rows.results
}
