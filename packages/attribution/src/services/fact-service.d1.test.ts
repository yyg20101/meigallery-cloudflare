import { readFileSync } from 'node:fs'
import type { AttributionBusinessEventV1 } from '@meigallery/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { openAttributionData } from '../security/data-envelope'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import { issueAttributionContextResponse } from './context-service'
import { recordCanonicalFact } from './fact-service'
import { issueRuntimeLease } from './runtime-lease'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const signingKey = 'fact-signing-key-current-with-at-least-32-bytes'
const encryptionKey = 'fact-encryption-key-current-at-least-32-bytes'
const fixedNow = new Date('2026-07-24T00:00:00.000Z')
let miniflare: Miniflare
let db: D1Database
let sequence = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'fact-service' },
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
  sequence = 0
  await seedProvider('meta')
  await seedProvider('tiktok')
  await seedProvider('google')
})

describe('Canonical Fact 与原子投递', () => {
  it('同一事实重复和并发提交只保留一组 Browser/Server delivery', async () => {
    const input = await attributedContact()
    const [first, second] = await Promise.all([
      recordCanonicalFact(environment(), input.event, input.options),
      recordCanonicalFact(environment(), input.event, input.options),
    ])

    expect(second.factId).toBe(first.factId)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_deliveries',
    )).toBe(2)
    expect(new Set(await values(
      'SELECT external_event_id AS value FROM attribution_deliveries',
    ))).toEqual(new Set([first.externalEventId]))
  })

  it('Meta 来源只创建 Meta delivery 且 Browser/Server 共用 event id', async () => {
    const input = await attributedContact()
    const result = await recordCanonicalFact(
      environment(),
      input.event,
      input.options,
    )

    expect(result.deliveries.map(item => item.provider)).toEqual([
      'meta',
      'meta',
    ])
    expect(result.deliveries.map(item => item.transport)).toEqual([
      'browser',
      'server',
    ])
    expect(new Set(result.deliveries.map(
      item => item.externalEventId,
    ))).toEqual(new Set([result.externalEventId]))
    expect(await values(
      'SELECT DISTINCT provider AS value FROM attribution_deliveries',
    )).toEqual(['meta'])
    const fact = await db.prepare(`
      SELECT dedupe_hash
      FROM attribution_facts
      WHERE id = ?
    `).bind(result.factId).first<{ dedupe_hash: string }>()
    expect(fact?.dedupe_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fact?.dedupe_hash).not.toContain('session-1')
  })

  it('拒绝广告用户数据时只创建 Browser delivery', async () => {
    const input = await attributedContact()
    const result = await recordCanonicalFact(
      environment(),
      {
        ...input.event,
        consent: {
          ...input.event.consent,
          adUserDataAllowed: false,
        },
      },
      input.options,
    )

    expect(result.deliveries.map(item => item.transport)).toEqual([
      'browser',
    ])
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_deliveries
      WHERE transport = 'server'
    `)).toBe(0)
  })

  it.each([
    ['无上下文', null],
    ['篡改上下文', 'tampered'],
  ])('%s仍保留最小业务事实但不创建广告 delivery', async (
    _label,
    sourceContextToken,
  ) => {
    const result = await recordCanonicalFact(environment(), {
      ...registrationEvent(),
      sourceContextToken,
    })

    expect(result.factId).toBeTruthy()
    expect(result.externalEventId).toBeNull()
    expect(result.deliveries).toEqual([])
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_deliveries',
    )).toBe(0)
  })

  it('Contact 缺失运行租约时不允许借上下文创建投递', async () => {
    const sourceContextToken = await contextToken('meta')
    const result = await recordCanonicalFact(environment(), {
      ...contactEvent(),
      sourceContextToken,
    })

    expect(result.deliveries).toEqual([])
  })

  it('Meta 上下文配 TikTok 租约时保留事实但严格零投递', async () => {
    const sourceContextToken = await contextToken('meta')
    const runtimeLeaseToken = await issueRuntimeLease({
      db,
      signingKeys: { current: signingKey },
      now: () => fixedNow,
    }, {
      connectionId: 'conn_tiktok',
      provider: 'tiktok',
      privacyState: 'granted',
    })
    const result = await recordCanonicalFact(environment(), {
      ...contactEvent(),
      sourceContextToken,
    }, {
      runtimeLeaseToken,
    })

    expect(result.factId).toBeTruthy()
    expect(result.externalEventId).toBeNull()
    expect(result.deliveries).toEqual([])
  })

  it('同一 dedupe key 的不同事实拒绝覆盖既有记录', async () => {
    const input = await attributedContact()
    await recordCanonicalFact(environment(), input.event, input.options)
    const conflicting: AttributionBusinessEventV1 = {
      ...input.event,
      payload: {
        contactMethodId: 'contact_1',
        contactPlatform: 'telegram',
        contactAction: 'copy',
      },
    }

    await expect(recordCanonicalFact(
      environment(),
      conflicting,
      input.options,
    )).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  })

  it('同一业务 event id 不允许以不同 dedupe key 创建第二事实', async () => {
    const input = await attributedContact()
    await recordCanonicalFact(environment(), input.event, input.options)

    await expect(recordCanonicalFact(environment(), {
      ...input.event,
      dedupeKey: 'contact:session-2:telegram:contact-1',
    }, input.options)).rejects.toThrow(
      'ATTRIBUTION_IDEMPOTENCY_CONFLICT',
    )
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(1)
  })

  it('delivery 已被接收或处理后重复事实仍返回原记录', async () => {
    const input = await attributedContact()
    const first = await recordCanonicalFact(
      environment(),
      input.event,
      input.options,
    )
    await db.batch([
      db.prepare(`
        UPDATE attribution_deliveries
        SET status = 'accepted'
        WHERE fact_id = ? AND transport = 'browser'
      `).bind(first.factId),
      db.prepare(`
        UPDATE attribution_deliveries
        SET status = 'processed'
        WHERE fact_id = ? AND transport = 'server'
      `).bind(first.factId),
    ])

    const duplicate = await recordCanonicalFact(
      environment(),
      input.event,
      input.options,
    )
    expect(duplicate.factId).toBe(first.factId)
    expect(duplicate.deliveries.map(item => item.status)).toEqual([
      'accepted',
      'processed',
    ])
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(1)
  })

  it('事实、delivery 与加密 outbox 任一失败时整批回滚', async () => {
    const input = await attributedContact()
    await db.prepare(`
      CREATE TRIGGER inject_outbox_failure
      BEFORE INSERT ON attribution_outbox
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_OUTBOX_FAILURE');
      END;
    `).run()

    await expect(recordCanonicalFact(
      environment(),
      input.event,
      input.options,
    )).rejects.toThrow()
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(0)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_deliveries',
    )).toBe(0)
    await db.exec('DROP TRIGGER inject_outbox_failure')
  })

  it('outbox 不保存上下文 token 明文且可按 delivery 身份解密', async () => {
    const input = await attributedContact()
    const result = await recordCanonicalFact(
      environment(),
      input.event,
      input.options,
    )
    const delivery = result.deliveries.find(
      item => item.transport === 'server',
    )!
    const plaintext = await decryptOutbox(delivery)

    expect(plaintext).not.toContain(input.event.sourceContextToken)
    expect(JSON.parse(plaintext)).toMatchObject({
      schemaVersion: 1,
      factId: result.factId,
      deliveryId: delivery.id,
      provider: 'meta',
      externalEventId: result.externalEventId,
      eventName: 'Contact',
      context: {
        issuedAt: Math.floor(fixedNow.getTime() / 1_000),
        identifiers: { fbclid: 'fbclid-meta-only' },
      },
    })
  })

  it('Browser outbox 不携带 Server 用户数据或上下文标识符', async () => {
    const input = await attributedContact()
    const result = await recordCanonicalFact(
      environment(),
      input.event,
      {
        ...input.options,
        requestMetadata: {
          clientIp: '192.0.2.10',
          userAgent: 'Attribution Test/1.0',
        },
      },
    )
    const delivery = result.deliveries.find(
      item => item.transport === 'browser',
    )!
    const payload = JSON.parse(await decryptOutbox(delivery))

    expect(payload).toEqual({
      schemaVersion: 1,
      factId: result.factId,
      deliveryId: delivery.id,
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta',
      transport: 'browser',
      destination: 'meta_browser',
      externalEventId: result.externalEventId,
      eventName: 'Contact',
      occurredAt: fixedNow.toISOString(),
    })
  })
})

async function decryptOutbox(
  delivery: {
    id: string
    provider: 'meta' | 'tiktok' | 'google'
    versionId: string
  },
): Promise<string> {
  const row = await db.prepare(`
      SELECT key_id, iv, ciphertext, tag
      FROM attribution_outbox
      WHERE delivery_id = ?
    `).bind(delivery.id).first<{
      key_id: string
      iv: string
      ciphertext: string
      tag: string
    }>()

  return openAttributionData(
    { current: encryptionKey },
    {
      purpose: 'delivery-outbox',
      identity: [
        delivery.id,
        delivery.provider,
        delivery.versionId,
      ].join(':'),
      envelope: {
        schemaVersion: 1,
        keyId: row!.key_id,
        iv: row!.iv,
        ciphertext: row!.ciphertext,
        tag: row!.tag,
      },
    },
  )
}

function environment() {
  return {
    db,
    signingKeys: { current: signingKey },
    encryptionKeys: { current: encryptionKey },
    now: () => fixedNow,
    idFactory: (prefix: string) => `${prefix}_${++sequence}`,
  }
}

async function attributedContact(): Promise<{
  event: AttributionBusinessEventV1
  options: { runtimeLeaseToken: string }
}> {
  const sourceContextToken = await contextToken('meta')
  const runtimeLeaseToken = await issueRuntimeLease({
    db,
    signingKeys: { current: signingKey },
    now: () => fixedNow,
  }, {
    connectionId: 'conn_meta',
    provider: 'meta',
    privacyState: 'granted',
  })
  return {
    event: {
      ...contactEvent(),
      sourceContextToken,
    },
    options: { runtimeLeaseToken },
  }
}

async function contextToken(
  provider: 'meta' | 'tiktok' | 'google',
): Promise<string> {
  const response = await issueAttributionContextResponse({
    db,
    signingKeys: { current: signingKey },
    encryptionKeys: { current: encryptionKey },
    nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
    idFactory: prefix => `${prefix}_${++sequence}`,
  }, {
    privacyDecision: {
      state: 'granted',
      reason: 'regional_default',
      policyVersion: 1,
    },
    route: {
      provider,
      connectionId: `conn_${provider}`,
    },
    sourceId: null,
    identifiers: provider === 'meta'
      ? { fbclid: 'fbclid-meta-only' }
      : provider === 'tiktok'
        ? { ttclid: 'ttclid-tiktok-only' }
        : { gclid: 'gclid-google-only' },
    idempotencyKey: `context-${provider}-${sequence}`,
  })
  return response.headers.get('Set-Cookie')!
    .split(';', 1)[0]!
    .split('=', 2)[1]!
}

function contactEvent(): AttributionBusinessEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt_contact_01',
    eventName: 'Contact',
    occurredAt: fixedNow.toISOString(),
    dedupeKey: 'contact:session-1:telegram:contact-1',
    sourceContextToken: null,
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
  }
}

function registrationEvent(): AttributionBusinessEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt_registration_01',
    eventName: 'CompleteRegistration',
    occurredAt: fixedNow.toISOString(),
    dedupeKey: 'complete_registration:user:1001',
    sourceContextToken: null,
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    payload: {
      userId: 1001,
    },
  }
}

async function seedProvider(
  provider: 'meta' | 'tiktok' | 'google',
): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES (?, ?, ?, ?)
    `).bind(
      `conn_${provider}`,
      provider,
      `${provider}-connection`,
      `ver_${provider}`,
    ),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (?, ?, ?, 'active', '{}', ?, 1, ?)
    `).bind(
      `ver_${provider}`,
      `conn_${provider}`,
      provider,
      `hash_${provider}`,
      fixedNow.toISOString(),
    ),
    db.prepare(`
      INSERT INTO attribution_version_bindings (
        version_id, canonical_event, enabled,
        browser_destination, server_destination
      ) VALUES (?, 'Contact', 1, ?, ?)
    `).bind(
      `ver_${provider}`,
      `${provider}_browser`,
      `${provider}_server`,
    ),
    db.prepare(`
      INSERT INTO attribution_version_bindings (
        version_id, canonical_event, enabled,
        browser_destination, server_destination
      ) VALUES (?, 'CompleteRegistration', 1, ?, ?)
    `).bind(
      `ver_${provider}`,
      `${provider}_browser`,
      `${provider}_server`,
    ),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by, updated_at
      ) VALUES (?, 1, 1, 1, 100, 100, 'closed', 1, ?)
    `).bind(
      `conn_${provider}`,
      fixedNow.toISOString(),
    ),
  ])
}

async function scalar(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

async function values(sql: string): Promise<string[]> {
  const rows = await db.prepare(sql).all<{ value: string }>()
  return rows.results.map(row => row.value)
}
