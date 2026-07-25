import { readFileSync } from 'node:fs'
import type { AttributionProvider } from '@meigallery/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import type {
  AttributionProviderAdapter,
  ProviderDeliveryClassification,
  ServerDeliveryInput,
} from '../adapters/types'
import { sealAttributionData } from '../security/data-envelope'
import { sealCredential } from './credential-vault'
import {
  consumeAttributionQueue,
  type AttributionQueueConsumerEnvironment,
} from './queue-consumer'
import { claimDelivery } from './queue-repository'
import { readDeliverySnapshot } from './queue-snapshot'
import type { AttributionQueueMessage } from './secure-outbox'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0006_runtime_owner_epoch.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const now = new Date('2026-07-24T05:00:00.000Z')
const credentialKeys = {
  current: 'credential-key-current-queue-consumer-20260724',
}
const dataKeys = {
  current: 'data-key-current-queue-consumer-20260724',
}
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'queue-consumer' },
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
  await seedMetaDelivery()
})

describe('归因 Queue Consumer', () => {
  it('shadow 仅允许 synthetic 候选验证领取投递', async () => {
    await setSyntheticFactAndRuntime('shadow')
    const row = await readDeliverySnapshot(db, 'delivery_meta')

    expect(row).not.toBeNull()
    expect(await claimDelivery(db, row!, now)).toBe(1)
    expect(await delivery()).toMatchObject({
      status: 'retrying',
      attempt_count: 1,
      last_error_code: 'processing',
    })
  })

  it('fenced 原子取消 synthetic 候选投递并删除 outbox', async () => {
    await setSyntheticFactAndRuntime('fenced')

    expect(await readDeliverySnapshot(db, 'delivery_meta')).toBeNull()
    expect(await delivery()).toMatchObject({
      status: 'cancelled',
      attempt_count: 0,
      last_error_code: 'runtime_fenced',
    })
    expect(await outboxExists()).toBe(false)
  })

  it('fenced 后既有 Queue 消息只确认取消态且不调用平台', async () => {
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
    const deliver = vi.fn()
    const item = queueMessage()

    expect(await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )).toEqual({
      accepted: 0,
      retried: 0,
      rejected: 0,
      deadLettered: 0,
      skipped: 1,
    })
    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({
      status: 'cancelled',
      attempt_count: 0,
      last_error_code: 'runtime_fenced',
    })
  })

  it('解密同一 provider 的凭据与事件并只完成一次投递', async () => {
    const deliver = vi.fn().mockResolvedValue({
      provider: 'meta',
      classification: 'accepted',
      httpStatus: 200,
      requestId: 'request_meta_1',
    })
    const item = queueMessage()

    expect(await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )).toEqual({
      accepted: 1,
      retried: 0,
      rejected: 0,
      deadLettered: 0,
      skipped: 0,
    })

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta',
      deliveryId: 'delivery_meta',
      canonicalEvent: 'Contact',
      externalEventId: 'attr1_meta_contact_event',
      pageUrl: 'https://616618.xyz/gallery/contact?source=ad',
      destination: 'meta_capi',
      publicConfig: { pixelId: '1234567890123456' },
      credential: 'meta-access-token',
      identifiers: { fbclid: 'fbclid_test_1' },
      contextIssuedAt: 1_753_333_200,
      clientIp: '203.0.113.8',
      userAgent: 'Queue Consumer Test/1.0',
      consent: {
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: false,
      },
      validateOnly: false,
    } satisfies Partial<ServerDeliveryInput>)
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty(
      'testEventCode',
    )
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({
      status: 'accepted',
      attempt_count: 1,
      last_error_code: '',
    })
    expect(await outboxExists()).toBe(false)
    expect(await receipt()).toMatchObject({
      provider: 'meta',
      classification: 'accepted',
      request_id: 'request_meta_1',
      attempt_count: 1,
    })

    const duplicate = queueMessage('duplicate_message')
    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [duplicate.message]),
      environment(adapter('meta', deliver)),
    )
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(duplicate.ack).toHaveBeenCalledOnce()
    expect(await incident('queue_delivery_not_found')).toBeNull()
  })

  it('物理 Queue 与消息 provider 不一致时绝不调用任何 Adapter', async () => {
    const deliver = vi.fn()
    const item = queueMessage('message_tiktok', {
      schemaVersion: 1,
      provider: 'tiktok',
      deliveryId: 'delivery_meta',
    })

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({
      status: 'queued',
      attempt_count: 0,
    })
    expect(await outboxExists()).toBe(true)
    expect(await incident('queue_provider_mismatch')).toBeTruthy()
  })

  it('数据库 provider 链任一字段不一致时隔离消息且不改写 Delivery', async () => {
    await db.prepare(`
      UPDATE attribution_outbox
      SET provider = 'tiktok'
      WHERE delivery_id = 'delivery_meta'
    `).run()
    const deliver = vi.fn()
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(await delivery()).toMatchObject({
      status: 'queued',
      attempt_count: 0,
    })
    expect(await outboxExists()).toBe(true)
    expect(await incident('queue_provider_mismatch')).toBeTruthy()
  })

  it('Adapter provider 错配时在解密任何敏感数据前拒绝', async () => {
    await db.prepare(`
      UPDATE attribution_version_credentials
      SET ciphertext = 'corrupted'
      WHERE version_id = 'ver_meta'
    `).run()
    const deliver = vi.fn()
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('tiktok', deliver)),
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({
      status: 'rejected',
      attempt_count: 0,
      last_error_code: 'adapter_provider_mismatch',
    })
    expect(await outboxExists()).toBe(false)
    expect(await policy()).toMatchObject({
      browser_enabled: 1,
      circuit_state: 'server_open',
    })
  })

  it('平台暂时故障时保留 outbox、记录回执并退避重试', async () => {
    const deliver = vi.fn().mockResolvedValue({
      provider: 'meta',
      classification: 'retryable',
      httpStatus: 503,
    })
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(item.ack).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(await delivery()).toMatchObject({
      status: 'retrying',
      attempt_count: 1,
      last_error_code: 'provider_retryable',
    })
    expect(await outboxExists()).toBe(true)
    expect(await receipt()).toMatchObject({
      classification: 'retryable',
      http_status: 503,
      attempt_count: 1,
    })
  })

  it('Server rollout 降低后立即取消尚未发送的 Delivery', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_policies
      SET server_target_percentage = 0,
          server_effective_percentage = 0
      WHERE connection_id = 'conn_meta'
    `).run()
    const deliver = vi.fn()
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(await delivery()).toMatchObject({
      status: 'cancelled',
      attempt_count: 0,
      last_error_code: 'runtime_policy_disabled',
    })
    expect(await outboxExists()).toBe(false)
  })

  it('Server circuit 打开后保留 outbox 等待恢复且不影响 Browser', async () => {
    await db.prepare(`
      UPDATE attribution_runtime_policies
      SET server_effective_percentage = 0,
          circuit_state = 'server_open'
      WHERE connection_id = 'conn_meta'
    `).run()
    const deliver = vi.fn()
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(await delivery()).toMatchObject({
      status: 'retrying',
      attempt_count: 0,
      last_error_code: 'server_circuit_open',
    })
    expect(await outboxExists()).toBe(true)
    expect(await policy()).toMatchObject({
      browser_enabled: 1,
      circuit_state: 'server_open',
    })
  })

  it('dev 仅允许 localhost Mock Adapter，不会调用真实平台', async () => {
    const deliver = vi.fn().mockResolvedValue({
      provider: 'meta',
      classification: 'accepted',
      httpStatus: 200,
    })
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta-dev', [item.message]),
      environment(adapter('meta', deliver), {
        appEnvironment: 'dev',
        publicOrigins: ['http://localhost:3000'],
      }),
    )

    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      pageUrl: 'http://localhost:3000/gallery/contact?source=ad',
    })
    expect(item.ack).toHaveBeenCalledOnce()
    expect(await delivery()).toMatchObject({
      status: 'accepted',
      attempt_count: 1,
    })
  })

  it('非生产环境未注入 Mock Adapter 时拒绝且绝不调用真实平台', async () => {
    const item = queueMessage()
    const localEnvironment = environment(
      adapter('meta', vi.fn()),
      {
        appEnvironment: 'dev',
        publicOrigins: ['http://localhost:3000'],
      },
    )
    delete localEnvironment.adapterFor

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta-dev', [item.message]),
      localEnvironment,
    )

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(await delivery()).toMatchObject({
      status: 'rejected',
      attempt_count: 0,
      last_error_code: 'nonproduction_real_adapter_forbidden',
    })
    expect(await outboxExists()).toBe(false)
  })

  it('凭据失效时拒绝当前 Server Delivery 并打开 Server circuit', async () => {
    const deliver = vi.fn().mockResolvedValue({
      provider: 'meta',
      classification: 'credential_invalid',
      httpStatus: 401,
      providerCode: 190,
    })
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(item.ack).toHaveBeenCalledOnce()
    expect(await delivery()).toMatchObject({
      status: 'rejected',
      attempt_count: 1,
      last_error_code: 'provider_credential_invalid',
    })
    expect(await outboxExists()).toBe(false)
    expect(await policy()).toMatchObject({
      browser_enabled: 1,
      server_enabled: 1,
      server_target_percentage: 100,
      server_effective_percentage: 0,
      circuit_state: 'server_open',
    })
    expect(await incident('provider_credential_invalid')).toBeTruthy()
  })

  it('DLQ 消息转为 dead_letter、保留密文并创建告警', async () => {
    const deliver = vi.fn()
    const item = queueMessage()

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta-dlq', [item.message]),
      environment(adapter('meta', deliver)),
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(await delivery()).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'queue_dead_letter',
    })
    expect(await outboxExists()).toBe(true)
    expect(await incident('queue_dead_letter')).toBeTruthy()
  })
})

function environment(
  providerAdapter: AttributionProviderAdapter,
  overrides: Partial<AttributionQueueConsumerEnvironment> = {},
): AttributionQueueConsumerEnvironment {
  return {
    db,
    appEnvironment: 'production',
    publicOrigins: ['https://616618.xyz'],
    credentialMasterKeys: credentialKeys,
    dataEncryptionKeys: dataKeys,
    adapterFor: () => providerAdapter,
    now: () => now,
    idFactory: prefix => `${prefix}_queue_consumer`,
    ...overrides,
  }
}

function adapter(
  provider: AttributionProvider,
  deliver: (
    input: ServerDeliveryInput,
  ) => Promise<{
    provider: AttributionProvider
    classification: ProviderDeliveryClassification
    httpStatus?: number
    requestId?: string
    providerCode?: number
  }>,
): AttributionProviderAdapter {
  return {
    provider,
    eventName: event => event,
    normalizeTestEventCode: () => undefined,
    validateCandidate: vi.fn(),
    buildBrowserInstruction: vi.fn(),
    deliverServerEvent: deliver,
    readQualitySignal: vi.fn(),
  }
}

function queueMessage(
  id = 'message_meta',
  body: AttributionQueueMessage = {
    schemaVersion: 1,
    provider: 'meta',
    deliveryId: 'delivery_meta',
  },
) {
  const ack = vi.fn()
  const retry = vi.fn()
  return {
    ack,
    retry,
    message: {
      id,
      timestamp: now,
      body,
      attempts: 1,
      ack,
      retry,
    } as unknown as Message<AttributionQueueMessage>,
  }
}

function queueBatch(
  queue: string,
  messages: Message<AttributionQueueMessage>[],
): MessageBatch<AttributionQueueMessage> {
  return {
    queue,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<AttributionQueueMessage>
}

async function seedMetaDelivery() {
  const credential = await sealCredential(credentialKeys, {
    versionId: 'ver_meta',
    provider: 'meta',
    plaintext: 'meta-access-token',
  })
  const outbox = await sealAttributionData(dataKeys, {
    purpose: 'delivery-outbox',
    identity: 'delivery_meta:meta:ver_meta',
    plaintext: JSON.stringify({
      schemaVersion: 1,
      factId: 'fact_meta',
      deliveryId: 'delivery_meta',
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta',
      transport: 'server',
      destination: 'meta_capi',
      externalEventId: 'attr1_meta_contact_event',
      eventName: 'Contact',
      occurredAt: '2026-07-24T04:59:00.000Z',
      pagePath: '/gallery/contact?source=ad',
      consent: {
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: false,
      },
      payload: {
        contactMethodId: 'contact_1',
        contactPlatform: 'telegram',
        contactAction: 'open_link',
      },
      context: {
        sourceId: 'source_meta',
        issuedAt: 1_753_333_200,
        identifiers: { fbclid: 'fbclid_test_1' },
      },
      requestMetadata: {
        clientIp: '203.0.113.8',
        userAgent: 'Queue Consumer Test/1.0',
      },
    }),
  })

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
        'ver_meta', 'conn_meta', 'meta', 'active', ?,
        'hash_meta', 1, ?
      )
    `).bind(
      JSON.stringify({ pixelId: '1234567890123456' }),
      now.toISOString(),
    ),
    db.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv,
        ciphertext, tag, credential_fingerprint
      ) VALUES ('ver_meta', 'meta', 1, ?, ?, ?, ?, ?)
    `).bind(
      credential.keyId,
      credential.iv,
      credential.ciphertext,
      credential.tag,
      credential.fingerprint,
    ),
    db.prepare(`
      INSERT INTO attribution_version_bindings (
        version_id, canonical_event, enabled,
        browser_destination, server_destination
      ) VALUES (
        'ver_meta', 'Contact', 1, 'meta_pixel', 'meta_capi'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by, updated_at
      ) VALUES (
        'conn_meta', 1, 1, 1, 100, 100, 'closed', 1, ?
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
        'attr1_meta_contact_event', ?, ?, '{}', ?
      )
    `).bind(
      'a'.repeat(64),
      'b'.repeat(64),
      '2026-07-24T04:59:00.000Z',
      JSON.stringify({
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: false,
      }),
      now.toISOString(),
    ),
    db.prepare(`
      INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, version_id, provider,
        transport, destination, external_event_id, status,
        runtime_owner_epoch, created_at, updated_at
      ) VALUES (
        'delivery_meta', 'fact_meta', 'conn_meta', 'ver_meta', 'meta',
        'server', 'meta_capi', 'attr1_meta_contact_event', 'queued',
        3, ?, ?
      )
    `).bind(now.toISOString(), now.toISOString()),
    db.prepare(`
      INSERT INTO attribution_outbox (
        delivery_id, provider, version_id, schema_version,
        key_id, iv, ciphertext, tag, expires_at, created_at
      ) VALUES (
        'delivery_meta', 'meta', 'ver_meta', 1,
        ?, ?, ?, ?, ?, ?
      )
    `).bind(
      outbox.keyId,
      outbox.iv,
      outbox.ciphertext,
      outbox.tag,
      new Date(now.getTime() + 60 * 60_000).toISOString(),
      now.toISOString(),
    ),
  ])
}

async function setSyntheticFactAndRuntime(
  mode: 'shadow' | 'fenced',
) {
  await db.batch([
    db.prepare(`
      UPDATE attribution_connection_versions
      SET status = 'validating',
          activated_at = NULL
      WHERE id = 'ver_meta'
    `),
    db.prepare(`
      UPDATE attribution_facts
      SET fact_origin = 'synthetic'
      WHERE id = 'fact_meta'
    `),
    db.prepare(`
      UPDATE attribution_deliveries
      SET runtime_owner_epoch = 2
      WHERE id = 'delivery_meta'
    `),
    db.prepare(`
      INSERT INTO attribution_validations (
        id, candidate_version_id, provider, status,
        evidence_json, started_at, created_at
      ) VALUES (
        'validation_meta', 'ver_meta', 'meta', 'running',
        '{}', ?, ?
      )
    `).bind(now.toISOString(), now.toISOString()),
    db.prepare(`
      UPDATE attribution_runtime_state
      SET mode = ?,
          activated_at = NULL,
          bridge_owner_epoch = NULL,
          active_owner_epoch = NULL,
          fenced_owner_epoch = ?,
          updated_at = ?
      WHERE id = 'global'
    `).bind(
      mode,
      mode === 'fenced' ? 4 : null,
      now.toISOString(),
    ),
  ])
}

async function delivery() {
  return db.prepare(`
    SELECT status, attempt_count, last_error_code
    FROM attribution_deliveries
    WHERE id = 'delivery_meta'
  `).first<{
    status: string
    attempt_count: number
    last_error_code: string
  }>()
}

async function outboxExists() {
  return Boolean(await db.prepare(`
    SELECT delivery_id
    FROM attribution_outbox
    WHERE delivery_id = 'delivery_meta'
  `).first())
}

async function receipt() {
  return db.prepare(`
    SELECT provider, classification, http_status, request_id, attempt_count
    FROM attribution_delivery_receipts
    WHERE delivery_id = 'delivery_meta'
  `).first()
}

async function policy() {
  return db.prepare(`
    SELECT
      browser_enabled, server_enabled, server_target_percentage,
      server_effective_percentage, circuit_state
    FROM attribution_runtime_policies
    WHERE connection_id = 'conn_meta'
  `).first()
}

async function incident(code: string) {
  return db.prepare(`
    SELECT id, status, severity, affected_transport
    FROM attribution_incidents
    WHERE code = ?
    LIMIT 1
  `).bind(code).first()
}
