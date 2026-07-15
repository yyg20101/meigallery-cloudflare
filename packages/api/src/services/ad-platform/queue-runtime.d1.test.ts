import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import type { AdAttributionProvider } from '@meigallery/shared'
import { encryptAttributionValue, loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import { CredentialVaultError } from './credential-vault'
import { handleAttributionQueueBatch, QUEUE_PROVIDERS, type AttributionDeliveryQueueRow } from './queue-runtime'
import { purgeExpiredAttributionOutbox } from './secure-outbox'

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
    expect(Object.fromEntries(QUEUE_PROVIDERS)).toEqual({
      'meigallery-ad-meta': 'meta',
      'meigallery-ad-meta-dlq': 'meta',
      'meigallery-ad-tiktok': 'tiktok',
      'meigallery-ad-tiktok-dlq': 'tiktok',
      'meigallery-ad-google': 'google',
      'meigallery-ad-google-dlq': 'google',
    })
  })

  it.each(['constructor', 'toString', '__proto__'])('原型属性 Queue %s 仍按未注册处理并记录 system incident', async queue => {
    const message = queueMessage({})
    await handleAttributionQueueBatch(batch([message], queue), env())
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(await incidentRows()).toEqual([expect.objectContaining({
      connection_id: null,
      provider: 'system',
      trigger_code: 'queue_unregistered',
    })])
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
    ['未知 Queue', 'unknown-queue', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }],
    ['跨平台 Queue', 'meigallery-ad-meta', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'tiktok' }],
    ['畸形 body', 'meigallery-ad-meta', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta', unexpected: true }],
  ] as const)('%s 即使指向终态 Delivery 也写 critical incident、ack 且不删除 Outbox', async (_name, queue, body) => {
    await seed('accepted')
    const message = queueMessage(body)
    await handleAttributionQueueBatch(batch([message], queue), env())
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).not.toBeNull()
    expect((await db.prepare('SELECT severity FROM attribution_incidents').first<{ severity: string }>())?.severity).toBe('critical')
  })

  it('known Queue 的空 body 写无连接 meta critical incident，并继续处理同批下一条消息', async () => {
    await seed('queued')
    const malformed = queueMessage({})
    const valid = queueMessage()
    await handleAttributionQueueBatch(batch([malformed, valid]), env(), {
      deliver: async () => ({ classification: 'accepted' }),
      readCredential: async () => 'secret',
    })

    expect(malformed.ack).toHaveBeenCalledOnce()
    expect(malformed.retry).not.toHaveBeenCalled()
    expect(valid.ack).toHaveBeenCalledOnce()
    expect((await deliveryState('meta')).status).toBe('accepted')
    expect(await incidentRows()).toEqual([expect.objectContaining({
      connection_id: null,
      provider: 'meta',
      severity: 'critical',
      trigger_code: 'queue_message_invalid',
      evidence_json: '{"queue":"meigallery-ad-meta"}',
    })])
  })

  it('unknown Queue 按安全可识别 provider 归属，否则归为 system，并继续处理同批消息', async () => {
    const unknown = queueMessage({})
    const recognizable = queueMessage({ provider: 'tiktok', token: 'secret-token', userEmail: 'user@example.test' })
    await handleAttributionQueueBatch(batch([unknown, recognizable], 'unknown-queue'), env())

    expect(unknown.ack).toHaveBeenCalledOnce()
    expect(recognizable.ack).toHaveBeenCalledOnce()
    expect(unknown.retry).not.toHaveBeenCalled()
    expect(recognizable.retry).not.toHaveBeenCalled()
    expect(await incidentRows()).toEqual([
      expect.objectContaining({ connection_id: null, provider: 'system', severity: 'critical', trigger_code: 'queue_unregistered', evidence_json: '{"queue":"unknown-queue"}' }),
      expect.objectContaining({ connection_id: null, provider: 'tiktok', severity: 'critical', trigger_code: 'queue_unregistered', evidence_json: '{"queue":"unknown-queue"}' }),
    ])
    const serialized = JSON.stringify(await incidentRows())
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('user@example.test')
  })

  it.each([
    ['不存在', { schemaVersion: 1, deliveryId: 'delivery_missing', provider: 'meta' }, 'queue_provider_mismatch'],
    ['非法', { schemaVersion: 1, deliveryId: 'delivery invalid', provider: 'meta', token: 'secret-token' }, 'queue_message_invalid'],
  ] as const)('%s deliveryId 写无连接 meta critical incident 且 evidence 仅含 Queue', async (_name, body, triggerCode) => {
    const message = queueMessage(body)
    await handleAttributionQueueBatch(batch([message]), env())

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(await incidentRows()).toEqual([expect.objectContaining({
      connection_id: null,
      provider: 'meta',
      severity: 'critical',
      trigger_code: triggerCode,
      evidence_json: '{"queue":"meigallery-ad-meta"}',
    })])
    const serialized = JSON.stringify(await incidentRows())
    expect(serialized).not.toContain(String(body.deliveryId))
    expect(serialized).not.toContain('secret-token')
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
    expect((await deliveryState('meta')).attempt_count).toBe(5)
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
    expect((await deliveryState('meta')).attempt_count).toBe(2)
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
    expect(await db.prepare("SELECT id FROM attribution_provider_receipts WHERE status = 'accepted'").first()).toBeNull()
  })

  it('两个 DLQ consumer 同读旧 row 时只有 winner 写一条 incident', async () => {
    await seed('retrying')
    const snapshot = await readDeliveryRow('meta')
    const first = queueMessage(undefined, 5)
    const second = queueMessage(undefined, 5)
    await handleAttributionQueueBatch(batch([first], 'meigallery-ad-meta-dlq'), env(), { readDelivery: async () => snapshot })
    await handleAttributionQueueBatch(batch([second], 'meigallery-ad-meta-dlq'), env(), { readDelivery: async () => snapshot })
    expect(first.ack).toHaveBeenCalledOnce()
    expect(second.ack).toHaveBeenCalledOnce()
    expect((await db.prepare("SELECT count(*) AS count FROM attribution_incidents WHERE trigger_code = 'queue_dead_letter'").first<{ count: number }>())?.count).toBe(1)
    expect(await deliveryState('meta')).toMatchObject({ status: 'dead_letter', attempt_count: 1, last_error_code: 'queue_dead_letter' })
  })

  it('expiry 先置为 rejected 后，迟到 finalize 同为 rejected 也不能写 receipt 或 incident', async () => {
    await seed('queued')
    const result = deferred<{ classification: 'rejected'; receipt: { status: number }; incident: { code: 'cross_platform_identifier'; severity: 'critical' } }>()
    const message = queueMessage()
    const deliver = vi.fn(() => result.promise)
    const active = handleAttributionQueueBatch(batch([message]), env(), { deliver, readCredential: async () => 'secret' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())

    await db.prepare("UPDATE attribution_outbox SET expires_at = datetime('now', '-1 minute') WHERE delivery_id = 'delivery_meta'").run()
    await expect(purgeExpiredAttributionOutbox(db)).resolves.toBe(1)
    result.resolve({ classification: 'rejected', receipt: { status: 400 }, incident: { code: 'cross_platform_identifier', severity: 'critical' } })
    await active

    expect((await deliveryState('meta')).status).toBe('rejected')
    expect(await db.prepare('SELECT id FROM attribution_provider_receipts').first()).toBeNull()
    expect(await db.prepare('SELECT id FROM attribution_incidents').first()).toBeNull()
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
  })

  it('finalize batch 任一语句失败时整体回滚，不留下终态或副作用', async () => {
    await seed('queued')
    const failingBatchDb = {
      prepare: db.prepare.bind(db),
      batch(statements: D1PreparedStatement[]) {
        return db.batch([...statements, db.prepare('INSERT INTO missing_finalize_table (id) VALUES (1)')])
      },
    } as unknown as D1Database
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), { ...env(), DB: failingBatchDb }, {
      deliver: async () => ({ classification: 'rejected', receipt: { status: 400 }, incident: { code: 'cross_platform_identifier', severity: 'critical' } }),
      readCredential: async () => 'secret',
    })
    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    expect((await deliveryState('meta')).status).toBe('retrying')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).not.toBeNull()
    expect(await db.prepare('SELECT id FROM attribution_provider_receipts').first()).toBeNull()
    expect(await db.prepare('SELECT id FROM attribution_incidents').first()).toBeNull()
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

  it('ack 抛异常时不调用 retry，并继续处理同批下一条消息', async () => {
    await seed('queued')
    const malformed = queueMessage({ schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta', unexpected: true })
    malformed.ack.mockImplementation(() => { throw new Error('ack failed') })
    const valid = queueMessage()
    await handleAttributionQueueBatch(batch([malformed, valid]), env(), { deliver: async () => ({ classification: 'accepted' }), readCredential: async () => 'secret' })
    expect(malformed.ack).toHaveBeenCalledOnce()
    expect(malformed.retry).not.toHaveBeenCalled()
    expect(valid.ack).toHaveBeenCalledOnce()
    expect((await deliveryState('meta')).status).toBe('accepted')
  })

  it('retry 抛异常时不调用 ack，并继续处理同批下一条消息', async () => {
    await seed('queued')
    const retryable = queueMessage()
    retryable.retry.mockImplementation(() => { throw new Error('retry failed') })
    const malformed = queueMessage({ schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta', unexpected: true })
    await handleAttributionQueueBatch(batch([retryable, malformed]), env(), { deliver: async () => ({ classification: 'retryable' }), readCredential: async () => 'secret' })
    expect(retryable.retry).toHaveBeenCalledOnce()
    expect(retryable.ack).not.toHaveBeenCalled()
    expect(malformed.ack).toHaveBeenCalledOnce()
  })
})

function env() { return { DB: db, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY } }
function batch(messages: ReturnType<typeof queueMessage>[], queue = 'meigallery-ad-meta') { return { queue, messages } as unknown as MessageBatch<{ schemaVersion: 1; deliveryId: string; provider: AdAttributionProvider }> }
function queueMessage(body: Record<string, unknown> = { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }, attempts = 1) { return { body, attempts, ack: vi.fn(), retry: vi.fn() } }

async function seed(status: DeliveryStatus, provider: AdAttributionProvider = 'meta', withOutbox = true) {
  const connectionId = `conn_${provider}`
  const factId = `fact_${provider}`
  const deliveryId = `delivery_${provider}`
  const config = provider === 'meta'
    ? '{"pixelId":"12345"}'
    : provider === 'tiktok'
      ? '{"pixelCode":"ABCDEF1234"}'
      : '{"tagId":"AW-12345","customerId":"12345","cloudProjectId":"project-1"}'
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

async function incidentRows() {
  const result = await db.prepare(`
    SELECT connection_id, provider, severity, trigger_code, evidence_json
    FROM attribution_incidents
    ORDER BY opened_at, rowid
  `).all<{ connection_id: string | null; provider: string; severity: string; trigger_code: string; evidence_json: string }>()
  return result.results
}

async function readDeliveryRow(provider: AdAttributionProvider) {
  return db.prepare(`
    SELECT d.id AS delivery_id, d.provider AS delivery_provider, d.status, d.attempt_count, d.updated_at, d.fact_id, f.canonical_event, f.attribution_provider AS fact_provider,
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
