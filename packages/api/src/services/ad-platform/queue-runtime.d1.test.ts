import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import type { AdAttributionProvider } from '@meigallery/shared'
import { encryptAttributionValue, loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import { CredentialVaultError } from './credential-vault'
import { handleAttributionQueueBatch, QUEUE_PROVIDERS, type AttributionDeliveryQueueRow } from './queue-runtime'

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'queue-runtime' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})
afterAll(async () => { await miniflare.dispose() })
beforeEach(async () => {
  await db.exec('DELETE FROM attribution_provider_receipts; DELETE FROM attribution_incidents; DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_platform_connections;')
})

describe('统一广告平台 Queue 运行时', () => {
  it('六个物理 Queue 均映射到唯一 provider', () => {
    expect(QUEUE_PROVIDERS).toEqual({
      'meigallery-ad-meta': 'meta',
      'meigallery-ad-meta-dlq': 'meta',
      'meigallery-ad-tiktok': 'tiktok',
      'meigallery-ad-tiktok-dlq': 'tiktok',
      'meigallery-ad-google': 'google',
      'meigallery-ad-google-dlq': 'google',
    })
  })

  it.each(['accepted', 'processed', 'rejected', 'dead_letter', 'cancelled'] as const)('%s 重复主消息在 Outbox 已清理后静默 ack 且不改变时间', async status => {
    await seed(status, 'meta', false)
    const before = await deliveryState('meta')
    const message = queueMessage()
    const deliver = vi.fn()
    await handleAttributionQueueBatch(batch([message]), env(), { deliver })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
    expect(await deliveryState('meta')).toEqual(before)
    expect(await db.prepare('SELECT id FROM attribution_incidents').first()).toBeNull()
  })

  it.each(['accepted', 'processed', 'rejected', 'dead_letter', 'cancelled'] as const)('%s 重复 DLQ 消息同样静默 ack', async status => {
    await seed(status, 'meta', false)
    const before = await deliveryState('meta')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message], 'meigallery-ad-meta-dlq'), env())
    expect(message.ack).toHaveBeenCalledOnce()
    expect(await deliveryState('meta')).toEqual(before)
    expect(await db.prepare('SELECT id FROM attribution_incidents').first()).toBeNull()
  })

  it.each(['accepted', 'processed', 'rejected', 'dead_letter', 'cancelled'] as const)('%s 终态清理残留密文，但保留脱敏 receipt 和 Delivery 时间', async status => {
    await seed(status)
    await db.prepare("INSERT INTO attribution_provider_receipts (id, delivery_id, provider, receipt_type, status, receipt_json, received_at) VALUES ('receipt_existing', 'delivery_meta', 'meta', 'server_delivery', ?, '{\"status\":200}', '2026-07-15 00:00:00')").bind(status).run()
    const before = await deliveryState('meta')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env())
    expect(message.ack).toHaveBeenCalledOnce()
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
    expect(await db.prepare("SELECT receipt_json FROM attribution_provider_receipts WHERE id = 'receipt_existing'").first()).toEqual({ receipt_json: '{"status":200}' })
    expect(await deliveryState('meta')).toEqual(before)
  })

  it.each([
    ['queue', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'tiktok' }],
    ['fact', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }],
    ['connection', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }],
    ['outbox', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }],
  ] as const)('%s provider 不一致时写 critical incident、ack 且不调用 Adapter', async (kind, body) => {
    await seed('queued')
    const deliver = vi.fn()
    const message = queueMessage(body)
    const row = await readDeliveryRow('meta')
    const mismatched = kind === 'fact'
      ? { ...row, fact_provider: 'tiktok' }
      : kind === 'connection'
        ? { ...row, connection_provider: 'tiktok' }
        : kind === 'outbox'
          ? { ...row, outbox_provider: 'tiktok' }
          : row
    await handleAttributionQueueBatch(batch([message]), env(), { deliver, readDelivery: async () => mismatched })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
    expect((await db.prepare('SELECT severity FROM attribution_incidents').first<{ severity: string }>())?.severity).toBe('critical')
  })

  it('attempts 1/2/3/4 均执行 retry，随后 DLQ 终态清理密文', async () => {
    await seed('queued')
    const deliver = vi.fn().mockResolvedValue({ classification: 'retryable' })
    for (const attempts of [1, 2, 3, 4]) {
      const message = queueMessage(undefined, attempts)
      await handleAttributionQueueBatch(batch([message]), env(), { deliver, readCredential: async () => 'secret' })
      expect(message.retry).toHaveBeenCalledOnce()
    }
    expect(deliver).toHaveBeenCalledTimes(4)
    const dlq = queueMessage(undefined, 5)
    await handleAttributionQueueBatch(batch([dlq], 'meigallery-ad-meta-dlq'), env())
    expect(dlq.ack).toHaveBeenCalledOnce()
    expect((await deliveryState('meta')).status).toBe('dead_letter')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
  })

  it.each(['rejected', 'credential_invalid', 'destination_invalid'] as const)('%s 直接拒绝、保留脱敏 receipt 并清理 Outbox', async classification => {
    await seed('queued')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env(), { deliver: vi.fn().mockResolvedValue({ classification, receipt: { status: 400, requestId: 'request-safe' } }), readCredential: async () => 'secret' })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect((await deliveryState('meta')).status).toBe('rejected')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
    expect((await db.prepare('SELECT receipt_json FROM attribution_provider_receipts').first<{ receipt_json: string }>())?.receipt_json).toBe('{"status":400,"requestId":"request-safe"}')
  })

  it('Google 正式 Queue 投递固定 validateOnly=false', async () => {
    await seed('queued', 'google')
    const message = queueMessage({ schemaVersion: 1, deliveryId: 'delivery_google', provider: 'google' })
    const deliver = vi.fn().mockResolvedValue({ classification: 'accepted', receipt: { status: 200 } })
    await handleAttributionQueueBatch(batch([message], 'meigallery-ad-google'), env(), { deliver, readCredential: async () => '{}' })
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ provider: 'google', validateOnly: false }) }))
  })

  it('迟到 lease 的 retry 写回不能覆盖后继消费者的 accepted 终态', async () => {
    await seed('queued')
    const firstResult = deferred<{ classification: 'retryable' }>()
    const firstMessage = queueMessage(undefined, 1)
    const firstDeliver = vi.fn(() => firstResult.promise)
    const first = handleAttributionQueueBatch(batch([firstMessage]), env(), { deliver: firstDeliver, readCredential: async () => 'secret' })
    await vi.waitFor(() => expect(firstDeliver).toHaveBeenCalledOnce())

    await db.prepare("UPDATE attribution_deliveries SET updated_at = datetime('now', '-6 minutes') WHERE id = 'delivery_meta'").run()
    const secondMessage = queueMessage(undefined, 2)
    await handleAttributionQueueBatch(batch([secondMessage]), env(), { deliver: async () => ({ classification: 'accepted', receipt: { status: 200 } }), readCredential: async () => 'secret' })
    firstResult.resolve({ classification: 'retryable' })
    await first

    expect((await deliveryState('meta')).status).toBe('accepted')
    expect(firstMessage.retry).not.toHaveBeenCalled()
    expect(firstMessage.ack).toHaveBeenCalledOnce()
  })

  it('DLQ 取得 fencing 后，活动消费者迟到 accepted 写回失效', async () => {
    await seed('queued')
    const activeResult = deferred<{ classification: 'accepted'; receipt: { status: number } }>()
    const activeMessage = queueMessage(undefined, 4)
    const activeDeliver = vi.fn(() => activeResult.promise)
    const active = handleAttributionQueueBatch(batch([activeMessage]), env(), { deliver: activeDeliver, readCredential: async () => 'secret' })
    await vi.waitFor(() => expect(activeDeliver).toHaveBeenCalledOnce())

    const dlq = queueMessage(undefined, 5)
    await handleAttributionQueueBatch(batch([dlq], 'meigallery-ad-meta-dlq'), env())
    activeResult.resolve({ classification: 'accepted', receipt: { status: 200 } })
    await active

    expect((await deliveryState('meta')).status).toBe('dead_letter')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
    expect(await db.prepare("SELECT id FROM attribution_provider_receipts WHERE status = 'accepted'").first()).toBeNull()
  })

  it('带合法 deliveryId 的 extra-field 消息仍定位 Delivery、写 critical incident 并 ack', async () => {
    await seed('queued')
    const message = queueMessage({ schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta', unexpected: true } as never)
    await handleAttributionQueueBatch(batch([message]), env(), { deliver: vi.fn() })
    expect(message.ack).toHaveBeenCalledOnce()
    expect((await db.prepare('SELECT severity FROM attribution_incidents').first<{ severity: string }>())?.severity).toBe('critical')
  })

  it.each([
    ['Adapter 网络异常', { readCredential: async () => 'secret', deliver: async () => { throw new Error('network') } }],
    ['Credential D1 异常', { readCredential: async () => { throw new Error('D1 unavailable') }, deliver: vi.fn() }],
  ] as const)('%s 作为 retryable，不误标 credential_invalid', async (_name, dependencies) => {
    await seed('queued')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env(), dependencies)
    expect(message.retry).toHaveBeenCalledOnce()
    expect((await deliveryState('meta')).status).toBe('retrying')
    expect((await deliveryState('meta')).last_error_code).toBe('retryable')
  })

  it('明确永久 CredentialVaultError 才标记 credential_invalid', async () => {
    await seed('queued')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env(), { readCredential: async () => { throw new CredentialVaultError('ATTRIBUTION_CREDENTIAL_NOT_FOUND') } })
    expect(message.ack).toHaveBeenCalledOnce()
    expect((await deliveryState('meta')).last_error_code).toBe('credential_invalid')
  })

  it('非永久 CredentialVaultError 仍保留 retryable', async () => {
    await seed('queued')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env(), { readCredential: async () => { throw new CredentialVaultError('ATTRIBUTION_CREDENTIAL_WRITE_FAILED') } })
    expect(message.retry).toHaveBeenCalledOnce()
    expect((await deliveryState('meta')).last_error_code).toBe('retryable')
  })

  it.each([
    ['不可解析', 'not-a-date', 'outbox_invalid'],
    ['已过期', '2020-01-01T00:00:00.000Z', 'outbox_expired'],
  ])('%s expires_at fail closed，不调用 Adapter', async (_name, expiresAt, errorCode) => {
    await seed('queued')
    await db.prepare('UPDATE attribution_outbox SET expires_at = ?').bind(expiresAt).run()
    const message = queueMessage()
    const deliver = vi.fn()
    await handleAttributionQueueBatch(batch([message]), env(), { readCredential: async () => 'secret', deliver })
    expect(deliver).not.toHaveBeenCalled()
    expect((await deliveryState('meta')).status).toBe('rejected')
    expect((await deliveryState('meta')).last_error_code).toBe(errorCode)
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
  })
})

function env() { return { DB: db, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY } }
function batch(messages: ReturnType<typeof queueMessage>[], queue = 'meigallery-ad-meta') { return { queue, messages } as unknown as MessageBatch<{ schemaVersion: 1; deliveryId: string; provider: AdAttributionProvider }> }
function queueMessage(body: Record<string, unknown> = { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }, attempts = 1) { return { body, attempts, ack: vi.fn(), retry: vi.fn() } }

async function seed(status: DeliveryStatus, provider: AdAttributionProvider = 'meta', withOutbox = true) {
  const connectionId = `conn_${provider}`
  const factId = `fact_${provider}`
  const deliveryId = `delivery_${provider}`
  const config = provider === 'meta' ? '{"pixelId":"12345"}' : provider === 'tiktok' ? '{"pixelCode":"12345"}' : '{"customerId":"12345","cloudProjectId":"project-1"}'
  const statements = [
    db.prepare('INSERT INTO attribution_platform_connections (id, provider, public_config_json, connection_revision, credential_revision) VALUES (?, ?, ?, ?, ?)').bind(connectionId, provider, config, 'revision_1', 'credential_1'),
    db.prepare("INSERT INTO attribution_conversion_facts (id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json) VALUES (?, 'CompleteRegistration', 'live', ?, ?, 'context', '2026-07-15T00:00:00.000Z', ?, '{}', '{}')").bind(factId, `mg3_${provider}_${'a'.repeat(32)}`, provider, `dedupe_${provider}`),
    db.prepare("INSERT INTO attribution_deliveries (id, fact_id, connection_id, provider, transport, status, destination, updated_at) VALUES (?, ?, ?, ?, 'server', ?, 'destination_1', '2026-07-15 00:00:00')").bind(deliveryId, factId, connectionId, provider, status),
  ]
  if (withOutbox) statements.push(await encryptedOutboxStatement(provider))
  await db.batch(statements)
}

async function encryptedOutboxStatement(provider: AdAttributionProvider) {
  const envelope = await encryptAttributionValue({
    keys: await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }),
    aad: { purpose: 'outbox', provider, subjectId: `fact_${provider}`, revision: 'revision_1' },
    plaintext: JSON.stringify({ canonicalEvent: 'CompleteRegistration', externalEventId: `mg3_${'a'.repeat(43)}`, eventTime: 1784073600, pageUrl: 'https://gallery.example.test/register', destination: 'destination_1', matchSignals: provider === 'google' ? { gclid: 'gclid_1' } : { fbp: 'fbp_1' } }),
  })
  return db.prepare("INSERT INTO attribution_outbox (delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')").bind(`delivery_${provider}`, provider, envelope.schemaVersion, envelope.keyId, envelope.iv, envelope.ciphertext, envelope.tag)
}

async function deliveryState(provider: AdAttributionProvider) {
  return db.prepare('SELECT status, attempt_count, last_error_code, updated_at, accepted_at, processed_at FROM attribution_deliveries WHERE id = ?').bind(`delivery_${provider}`).first<{ status: string; attempt_count: number; last_error_code: string; updated_at: string; accepted_at: string | null; processed_at: string | null }>() as Promise<{ status: string; attempt_count: number; last_error_code: string; updated_at: string; accepted_at: string | null; processed_at: string | null }>
}

async function readDeliveryRow(provider: AdAttributionProvider) {
  return db.prepare(`
    SELECT d.id AS delivery_id, d.provider AS delivery_provider, d.status, d.attempt_count, d.fact_id, f.canonical_event, f.attribution_provider AS fact_provider,
      c.id AS connection_id, c.provider AS connection_provider, c.public_config_json, c.connection_revision, c.credential_revision, d.destination,
      o.provider AS outbox_provider, o.schema_version, o.key_id, o.iv, o.ciphertext, o.tag, o.expires_at
    FROM attribution_deliveries d JOIN attribution_conversion_facts f ON f.id = d.fact_id
    JOIN attribution_platform_connections c ON c.id = d.connection_id LEFT JOIN attribution_outbox o ON o.delivery_id = d.id
    WHERE d.id = ?
  `).bind(`delivery_${provider}`).first<AttributionDeliveryQueueRow>() as Promise<AttributionDeliveryQueueRow>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolver => { resolve = resolver })
  return { promise, resolve }
}

type DeliveryStatus = 'queued' | 'retrying' | 'accepted' | 'processed' | 'rejected' | 'dead_letter' | 'cancelled'
