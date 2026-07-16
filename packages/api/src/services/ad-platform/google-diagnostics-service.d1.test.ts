import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileGoogleDeliveryDiagnostics } from './google-diagnostics-service'

const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'test' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

beforeEach(async () => {
  await db.exec('DELETE FROM attribution_quality_snapshots; DELETE FROM attribution_incidents; DELETE FROM attribution_provider_receipts; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_platform_connections;')
})

afterAll(async () => miniflare.dispose())

describe('Google accepted Delivery 异步诊断', () => {
  it('把单次诊断批次限制在 40，为 Workers Free 外部 subrequest 预留余量', async () => {
    let boundValues: unknown[] = []
    const boundedDb = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            boundValues = values
            return { all: async () => ({ results: [] }) }
          },
        }
      },
    } as unknown as D1Database

    const result = await reconcileGoogleDeliveryDiagnostics(
      { ...env(), DB: boundedDb },
      new Date('2026-07-16T00:31:00.000Z'),
      100,
    )

    expect(boundValues.at(-1)).toBe(40)
    expect(result.scanned).toBe(0)
  })

  it('尚未到退避时间的旧记录不会阻塞后方已到期记录', async () => {
    await seedBacklog()
    const retrieveStatus = vi.fn(async () => ({ classification: 'processed' as const, status: 200, requestStatus: 'SUCCESS', errorReasons: [], warningReasons: [] }))

    const result = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T02:00:00.000Z'), 40, dependencies(retrieveStatus))

    expect(result).toMatchObject({ scanned: 1, processed: 1, skipped: 0 })
    expect(retrieveStatus).toHaveBeenCalledOnce()
    expect(await db.prepare("SELECT status FROM attribution_deliveries WHERE id = 'delivery_due'").first<{ status: string }>()).toEqual({ status: 'processed' })
  })

  it('超过 24 小时的记录优先于普通到期记录进入 40 条批次', async () => {
    await seedTimeoutPriorityBacklog()
    const retrieveStatus = vi.fn(async () => ({ classification: 'processed' as const, status: 200, requestStatus: 'SUCCESS', errorReasons: [], warningReasons: [] }))

    const result = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T02:00:00.000Z'), 40, dependencies(retrieveStatus))

    expect(result).toMatchObject({ scanned: 40, processed: 39, rejected: 1, timedOut: 1 })
    expect(retrieveStatus).toHaveBeenCalledTimes(39)
    expect(await db.prepare("SELECT status, last_error_code FROM attribution_deliveries WHERE id = 'delivery_expired'").first<{ status: string; last_error_code: string }>())
      .toEqual({ status: 'rejected', last_error_code: 'google_diagnostic_timeout' })
  })

  it('30 分钟后把 SUCCESS 原子收口为 processed 并写入质量快照', async () => {
    await seedAccepted('2026-07-16T00:00:00.000Z')
    const retrieveStatus = vi.fn(async () => ({ classification: 'processed' as const, status: 200, requestStatus: 'SUCCESS', errorReasons: [], warningReasons: [] }))

    const result = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:31:00.000Z'), 100, dependencies(retrieveStatus))

    expect(result).toEqual({ scanned: 1, processed: 1, rejected: 0, processing: 0, retryable: 0, timedOut: 0, skipped: 0 })
    expect(await delivery()).toMatchObject({ status: 'processed', last_error_code: '', processed_at: expect.any(String) })
    expect(await receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ receipt_type: 'google_request_status', status: 'processed' })]))
    expect(await quality()).toMatchObject({ metric_key: 'request_processing_success', metric_value: '1', collection_status: 'success' })
  })

  it('PROCESSING 保持 accepted，并按官方退避避免高频重复查询', async () => {
    await seedAccepted('2026-07-16T00:00:00.000Z')
    const retrieveStatus = vi.fn(async () => ({ classification: 'processing' as const, status: 200, requestStatus: 'PROCESSING', errorReasons: [], warningReasons: [] }))

    await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:31:00.000Z'), 100, dependencies(retrieveStatus))
    const second = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:50:00.000Z'), 100, dependencies(retrieveStatus))

    expect(retrieveStatus).toHaveBeenCalledOnce()
    expect(second).toMatchObject({ scanned: 0, skipped: 0 })
    expect(await delivery()).toMatchObject({ status: 'accepted', processed_at: null })
  })

  it('FAILED 清洗原因后标记 rejected 并记录质量错误', async () => {
    await seedAccepted('2026-07-16T00:00:00.000Z')
    const retrieveStatus = vi.fn(async () => ({
      classification: 'rejected' as const,
      status: 200,
      requestStatus: 'FAILED',
      errorReasons: ['PROCESSING_ERROR_REASON_INVALID_GCLID'],
      warningReasons: [],
    }))

    const result = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:31:00.000Z'), 100, dependencies(retrieveStatus))

    expect(result.rejected).toBe(1)
    expect(await delivery()).toMatchObject({ status: 'rejected', last_error_code: 'google_processing_failed' })
    expect(await quality()).toMatchObject({ metric_value: '0', collection_status: 'error', error_category: 'PROCESSING_ERROR_REASON_INVALID_GCLID' })
  })

  it('超过 24 小时仍 accepted 时安全超时，不再请求平台', async () => {
    await seedAccepted('2026-07-15T00:00:00.000Z')
    const retrieveStatus = vi.fn()

    const result = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:00:01.000Z'), 100, dependencies(retrieveStatus))

    expect(result.timedOut).toBe(1)
    expect(retrieveStatus).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({ status: 'rejected', last_error_code: 'google_diagnostic_timeout' })
    expect((await incidents())[0]).toMatchObject({ provider: 'google', severity: 'warning', trigger_code: 'google_diagnostic_timeout' })
  })

  it('未满 30 分钟和缺少安全 requestId 时不误调用平台', async () => {
    await seedAccepted('2026-07-16T00:00:00.000Z', '{}')
    const retrieveStatus = vi.fn()

    const early = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:20:00.000Z'), 100, dependencies(retrieveStatus))
    const missing = await reconcileGoogleDeliveryDiagnostics(env(), new Date('2026-07-16T00:31:00.000Z'), 100, dependencies(retrieveStatus))

    expect(early.scanned).toBe(0)
    expect(missing.rejected).toBe(1)
    expect(retrieveStatus).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({ status: 'rejected', last_error_code: 'google_request_id_missing' })
  })
})

function env() {
  return { DB: db, APP_ENV: 'production', AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'unused' }
}

function dependencies(retrieveStatus: ReturnType<typeof vi.fn>) {
  return { retrieveStatus, readCredential: vi.fn(async () => 'encrypted-service-account') }
}

async function seedAccepted(acceptedAt: string, receiptJson = '{"status":200,"requestId":"request_123"}') {
  await db.batch([
    db.prepare(`INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
      connection_revision, credential_revision
    ) VALUES ('conn_google', 'google', 1, 'production', 1, 1, ?, 'revision_1', 'credential_1')`).bind(JSON.stringify({ tagId: 'AW-12345', customerId: '12345', cloudProjectId: 'project-1' })),
    db.prepare(`INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id, attribution_provider,
      attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
    ) VALUES ('fact_google', 'Contact', 'live', ?, 'google', 'context', ?, 'dedupe_google', '{}', '{}')`).bind(`mg3_${'g'.repeat(43)}`, acceptedAt),
    db.prepare(`INSERT INTO attribution_deliveries (
      id, fact_id, connection_id, provider, transport, status, destination, accepted_at, updated_at
    ) VALUES ('delivery_google', 'fact_google', 'conn_google', 'google', 'server', 'accepted', '123456789', ?, ?)`).bind(acceptedAt, acceptedAt),
    db.prepare(`INSERT INTO attribution_provider_receipts (
      id, delivery_id, provider, receipt_type, status, receipt_json, received_at
    ) VALUES ('receipt_google', 'delivery_google', 'google', 'server_delivery', 'accepted', ?, ?)`).bind(receiptJson, acceptedAt),
  ])
}

async function seedBacklog() {
  await db.prepare(`INSERT INTO attribution_platform_connections (
    id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
    connection_revision, credential_revision
  ) VALUES ('conn_google', 'google', 1, 'production', 1, 1, ?, 'revision_1', 'credential_1')`)
    .bind(JSON.stringify({ tagId: 'AW-12345', customerId: '12345', cloudProjectId: 'project-1' })).run()

  const statements: D1PreparedStatement[] = []
  for (let index = 0; index < 41; index += 1) {
    const suffix = index === 40 ? 'due' : String(index)
    const factId = `fact_${suffix}`
    const deliveryId = `delivery_${suffix}`
    const acceptedAt = index === 40 ? '2026-07-16T01:00:00.000Z' : '2026-07-16T00:00:00.000Z'
    statements.push(
      db.prepare(`INSERT INTO attribution_conversion_facts (
        id, canonical_event, fact_origin, external_event_id, attribution_provider,
        attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
      ) VALUES (?, 'Contact', 'live', ?, 'google', 'context', ?, ?, '{}', '{}')`)
        .bind(factId, `mg3_${String(index).padStart(43, '0')}`, acceptedAt, `dedupe_${suffix}`),
      db.prepare(`INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, provider, transport, status, destination, accepted_at, updated_at
      ) VALUES (?, ?, 'conn_google', 'google', 'server', 'accepted', '123456789', ?, ?)`)
        .bind(deliveryId, factId, acceptedAt, acceptedAt),
      db.prepare(`INSERT INTO attribution_provider_receipts (
        id, delivery_id, provider, receipt_type, status, receipt_json, received_at
      ) VALUES (?, ?, 'google', 'server_delivery', 'accepted', ?, ?)`)
        .bind(`receipt_${suffix}`, deliveryId, JSON.stringify({ status: 200, requestId: `request_${suffix}` }), acceptedAt),
    )
    if (index < 40) {
      statements.push(db.prepare(`INSERT INTO attribution_provider_receipts (
        id, delivery_id, provider, receipt_type, status, receipt_json, received_at
      ) VALUES (?, ?, 'google', 'google_request_status', 'processing', '{}', '2026-07-16T01:50:00.000Z')`)
        .bind(`diagnostic_${suffix}`, deliveryId))
    }
  }
  await db.batch(statements)
}

async function seedTimeoutPriorityBacklog() {
  await db.prepare(`INSERT INTO attribution_platform_connections (
    id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
    connection_revision, credential_revision
  ) VALUES ('conn_google', 'google', 1, 'production', 1, 1, ?, 'revision_1', 'credential_1')`)
    .bind(JSON.stringify({ tagId: 'AW-12345', customerId: '12345', cloudProjectId: 'project-1' })).run()

  const statements: D1PreparedStatement[] = []
  for (let index = 0; index < 41; index += 1) {
    const expired = index === 40
    const suffix = expired ? 'expired' : `normal_${index}`
    const factId = `fact_${suffix}`
    const deliveryId = `delivery_${suffix}`
    const acceptedAt = expired ? '2026-07-15T00:00:00.000Z' : '2026-07-16T01:00:00.000Z'
    statements.push(
      db.prepare(`INSERT INTO attribution_conversion_facts (
        id, canonical_event, fact_origin, external_event_id, attribution_provider,
        attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
      ) VALUES (?, 'Contact', 'live', ?, 'google', 'context', ?, ?, '{}', '{}')`)
        .bind(factId, `mg3_${String(index + 100).padStart(43, '0')}`, acceptedAt, `dedupe_${suffix}`),
      db.prepare(`INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, provider, transport, status, destination, accepted_at, updated_at
      ) VALUES (?, ?, 'conn_google', 'google', 'server', 'accepted', '123456789', ?, ?)`)
        .bind(deliveryId, factId, acceptedAt, acceptedAt),
      db.prepare(`INSERT INTO attribution_provider_receipts (
        id, delivery_id, provider, receipt_type, status, receipt_json, received_at
      ) VALUES (?, ?, 'google', 'server_delivery', 'accepted', ?, ?)`)
        .bind(`receipt_${suffix}`, deliveryId, JSON.stringify({ status: 200, requestId: `request_${suffix}` }), acceptedAt),
    )
    if (expired) {
      statements.push(db.prepare(`INSERT INTO attribution_provider_receipts (
        id, delivery_id, provider, receipt_type, status, receipt_json, received_at
      ) VALUES ('diagnostic_expired', ?, 'google', 'google_request_status', 'processing', '{}', '2026-07-16T01:50:00.000Z')`)
        .bind(deliveryId))
    }
  }
  await db.batch(statements)
}

async function delivery() {
  return db.prepare('SELECT status, last_error_code, processed_at FROM attribution_deliveries WHERE id = ?').bind('delivery_google').first<{ status: string; last_error_code: string; processed_at: string | null }>()
}

async function receipts() {
  return (await db.prepare('SELECT receipt_type, status, receipt_json FROM attribution_provider_receipts ORDER BY created_at, id').all<{ receipt_type: string; status: string; receipt_json: string }>()).results
}

async function quality() {
  return db.prepare('SELECT metric_key, metric_value, collection_status, error_category FROM attribution_quality_snapshots ORDER BY collected_at DESC LIMIT 1').first<{ metric_key: string; metric_value: string | null; collection_status: string; error_category: string }>()
}

async function incidents() {
  return (await db.prepare('SELECT provider, severity, trigger_code FROM attribution_incidents ORDER BY opened_at').all<{ provider: string; severity: string; trigger_code: string }>()).results
}
