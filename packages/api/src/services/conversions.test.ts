import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { decryptMetaCapiContext, loadMetaCapiCryptoKeys } from '../utils/meta-capi-crypto'
import {
  recordContact,
  recordRegistration,
  recordRegistrationFactOnly,
  type RecordContactInput,
  type RecordRegistrationInput,
} from './conversions'
import { rolloutBucket } from './meta-capi-rollout'

const metaHashMocks = vi.hoisted(() => ({
  email: vi.fn(),
  externalId: vi.fn(),
}))

const metaCryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn(),
  loadKeys: vi.fn(),
}))

vi.mock('../utils/meta-browser-identifiers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/meta-browser-identifiers')>()
  metaHashMocks.email.mockImplementation(actual.hashMetaEmail)
  metaHashMocks.externalId.mockImplementation(actual.hashMetaExternalId)
  return {
    ...actual,
    hashMetaEmail: metaHashMocks.email,
    hashMetaExternalId: metaHashMocks.externalId,
  }
})

vi.mock('../utils/meta-capi-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/meta-capi-crypto')>()
  metaCryptoMocks.encrypt.mockImplementation(actual.encryptMetaCapiContext)
  metaCryptoMocks.loadKeys.mockImplementation(actual.loadMetaCapiCryptoKeys)
  return {
    ...actual,
    encryptMetaCapiContext: metaCryptoMocks.encrypt,
    loadMetaCapiCryptoKeys: metaCryptoMocks.loadKeys,
  }
})

type Call = { sql: string; params: unknown[] }
type InsertedConversion = { id: string; actionType: string; dedupeKey: string; sessionId: string }
type InsertedDelivery = {
  id: string
  conversionActionId: string
  provider: string
  transport: string
  eventName: string
  eventId: string
  status: string
  skipReason: string
  encryptionKeyId: string
  connectionRevision: string | null
  queueEnqueuedAt: string | null
  hasFbp: number
  hasFbc: number
  hasEmail: number
  hasExternalId: number
  rolloutTargetPercentage: number
  rolloutEffectivePercentage: number
  rolloutBucket: number | null
}
type InsertedOutbox = {
  deliveryId: string
  schemaVersion: number
  keyId: string
  iv: string
  ciphertext: string
  tag: string
  expiresAt: string
}
type DedupeClaim = {
  ownerActionId: string
  claimToken: string
  claimedAt: string
  expiresAt: string
}

const DATA_KEY = Buffer.alloc(32, 7).toString('base64')
const META_TOKEN = 'conversion-token'
const RELEASE_COMMIT = 'a'.repeat(40)
const TOKEN_FINGERPRINT = '769024a811a288c6842575d21f81ae2ee1adb18187c48dbd538ac364226d1197'
const CONNECTION_REVISION = '1'.repeat(32)

function createConversionDb(options: {
  existingDedupeKeys?: string[]
  metaServerEnabled?: boolean
  metaBrowserEnabled?: boolean
  metaDestinationId?: string
  metaMode?: 'disabled' | 'test' | 'production'
  tiktokBrowserEnabled?: boolean
  tiktokDestinationId?: string
  tiktokMode?: 'disabled' | 'test' | 'production'
  metaConnectionVerified?: boolean
  metaRolloutPercentage?: unknown
  criticalIncidentOpen?: boolean
  userMetaExternalId?: string | null
  rolloutSettingQueryError?: boolean
  stableIdQueryError?: boolean
  incidentQueryError?: boolean
  failAt?: number
} = {}) {
  const calls: Call[] = []
  const readCalls: Call[] = []
  const insertedConversions: InsertedConversion[] = []
  const insertedDeliveries: InsertedDelivery[] = []
  const insertedOutboxes: InsertedOutbox[] = []
  const dedupe = new Map((options.existingDedupeKeys ?? []).map((key) => [key, `existing_${key}`]))
  const claims = new Map<string, DedupeClaim>()
  let statementCount = 0
  let leaseClock = Date.parse('2026-07-11T00:00:00.000Z')

  function returnedClaim(dedupeDigest: string, ownerActionId: string, claimToken: string) {
    const claimedAt = new Date(leaseClock += 1).toISOString()
    const expiresAt = new Date(leaseClock + 60_000).toISOString()
    const claim = { ownerActionId, claimToken, claimedAt, expiresAt }
    return {
      claim,
      result: {
        results: [{
          dedupe_digest: dedupeDigest,
          owner_action_id: ownerActionId,
          claim_token: claimToken,
          claimed_at: claimedAt,
          expires_at: expiresAt,
        }],
        meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 },
      },
    }
  }

  function applyCall(
    call: Call,
    target: {
      dedupe: Map<string, string>
      insertedConversions: InsertedConversion[]
      insertedDeliveries: InsertedDelivery[]
      insertedOutboxes: InsertedOutbox[]
      claims: Map<string, DedupeClaim>
    },
  ) {
    if (call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_dedupe_claims')) {
      const dedupeDigest = String(call.params[0])
      if (target.claims.has(dedupeDigest)) {
        return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      }
      const returned = returnedClaim(dedupeDigest, String(call.params[1]), String(call.params[2]))
      target.claims.set(dedupeDigest, returned.claim)
      return returned.result
    }
    if (call.sql.includes('UPDATE analytics_conversion_dedupe_claims')) {
      if (/SET\s+owner_action_id = \?/.test(call.sql)) {
        const dedupeDigest = String(call.params[3])
        const current = target.claims.get(dedupeDigest)
        if (!current
          || current.ownerActionId !== String(call.params[4])
          || current.claimToken !== String(call.params[5])
          || current.claimedAt !== String(call.params[6])
          || current.expiresAt !== String(call.params[7])) {
          return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
        }
        const returned = returnedClaim(dedupeDigest, String(call.params[0]), String(call.params[1]))
        target.claims.set(dedupeDigest, returned.claim)
        return returned.result
      }
      const dedupeDigest = String(call.params[1])
      const current = target.claims.get(dedupeDigest)
      if (!current
        || current.ownerActionId !== String(call.params[2])
        || current.claimToken !== String(call.params[3])
        || current.claimedAt !== String(call.params[4])
        || current.expiresAt !== String(call.params[5])) {
        return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      }
      const returned = returnedClaim(dedupeDigest, current.ownerActionId, current.claimToken)
      target.claims.set(dedupeDigest, returned.claim)
      return returned.result
    }
    if (call.sql.includes('DELETE FROM analytics_conversion_dedupe_claims')) {
      const dedupeKey = String(call.params[0])
      const current = target.claims.get(dedupeKey)
      if (!current
        || current.ownerActionId !== String(call.params[1])
        || current.claimToken !== String(call.params[2])
        || current.claimedAt !== String(call.params[3])
        || current.expiresAt !== String(call.params[4])) {
        return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      }
      target.claims.delete(dedupeKey)
      return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
    }
    if (call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_actions')) {
      const id = String(call.params[0])
      const actionType = String(call.params[1])
      const dedupeKey = String(call.params[2])
      const sessionId = String(call.params[6])
      if (call.sql.includes('FROM analytics_conversion_dedupe_claims')) {
        const claim = target.claims.get(String(call.params[21]))
        if (!claim
          || claim.ownerActionId !== String(call.params[22])
          || claim.claimToken !== String(call.params[23])
          || claim.claimedAt !== String(call.params[24])
          || claim.expiresAt !== String(call.params[25])) {
          return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
        }
      }
      if (target.dedupe.has(dedupeKey)) return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      target.dedupe.set(dedupeKey, id)
      target.insertedConversions.push({ id, actionType, dedupeKey, sessionId })
    }
    if (call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries')) {
      target.insertedDeliveries.push({
        id: String(call.params[0]),
        conversionActionId: String(call.params[1]),
        provider: String(call.params[2]),
        transport: String(call.params[3]),
        eventName: String(call.params[5]),
        eventId: String(call.params[4]),
        status: String(call.params[6]),
        skipReason: String(call.params[7]),
        encryptionKeyId: String(call.params[12]),
        connectionRevision: call.params[14] == null ? null : String(call.params[14]),
        queueEnqueuedAt: null,
        hasFbp: Number(call.params[8]),
        hasFbc: Number(call.params[9]),
        hasEmail: Number(call.params[10]),
        hasExternalId: Number(call.params[11]),
        rolloutTargetPercentage: Number(call.params[15]),
        rolloutEffectivePercentage: Number(call.params[16]),
        rolloutBucket: call.params[17] == null ? null : Number(call.params[17]),
      })
    }
    if (call.sql.includes('INSERT INTO meta_capi_secure_outbox')) {
      target.insertedOutboxes.push({
        deliveryId: String(call.params[0]),
        schemaVersion: Number(call.params[1]),
        keyId: String(call.params[2]),
        iv: String(call.params[3]),
        ciphertext: String(call.params[4]),
        tag: String(call.params[5]),
        expiresAt: String(call.params[6]),
      })
    }
    if (call.sql.includes('queue_attempt_count = queue_attempt_count + 1')) {
      const delivery = target.insertedDeliveries.find(item => item.id === String(call.params[0]))
      const outbox = target.insertedOutboxes.find(item => item.deliveryId === delivery?.id)
      return { meta: { changes: delivery?.status === 'pending' && !delivery.queueEnqueuedAt && outbox ? 1 : 0 } }
    }
    if (call.sql.includes('queue_enqueued_at = datetime')) {
      const delivery = target.insertedDeliveries.find(item => item.id === String(call.params[0]))
      if (delivery) delivery.queueEnqueuedAt = '2026-07-11 00:00:00'
    }
    if (call.sql.includes('DELETE FROM meta_capi_secure_outbox')) {
      const index = target.insertedOutboxes.findIndex(item => item.deliveryId === String(call.params[0]))
      if (index >= 0) target.insertedOutboxes.splice(index, 1)
    }
    return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
  }

  const db = {
    calls,
    insertedConversions,
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      const statement = {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          readCalls.push(call)
          if (sql.includes('FROM analytics_conversion_actions') && sql.includes('WHERE dedupe_key = ?')) {
            const existingId = dedupe.get(String(call.params[0]))
            return existingId ? ({ id: existingId } as T) : null
          }
          if (sql.includes('FROM analytics_conversion_dedupe_claims')) {
            const dedupeDigest = String(call.params[0])
            const claim = claims.get(dedupeDigest)
            return claim ? ({
              dedupe_digest: dedupeDigest,
              owner_action_id: claim.ownerActionId,
              claim_token: claim.claimToken,
              claimed_at: claim.claimedAt,
              expires_at: claim.expiresAt,
            } as T) : null
          }
          if (sql.includes('FROM ad_platform_connections')) {
            if (options.rolloutSettingQueryError) throw new Error('模拟 rollout setting 查询失败')
            if (call.params[0] === 'tiktok') {
              return {
                provider: 'tiktok',
                enabled: options.tiktokBrowserEnabled === true ? 1 : 0,
                mode: options.tiktokMode ?? 'disabled',
                browser_enabled: options.tiktokBrowserEnabled === true ? 1 : 0,
                server_enabled: 0,
                destination_id: options.tiktokDestinationId ?? '',
                debug_enabled: 0,
                rollout_percentage: 0,
                credential_secret_name: '',
                revision: null,
              } as T
            }
            return {
              provider: 'meta',
              enabled: options.metaBrowserEnabled === true || options.metaServerEnabled === true ? 1 : 0,
              mode: options.metaMode ?? 'disabled',
              browser_enabled: options.metaBrowserEnabled === true ? 1 : 0,
              server_enabled: options.metaServerEnabled === true ? 1 : 0,
              destination_id: options.metaDestinationId ?? '',
              debug_enabled: 0,
              rollout_percentage: options.metaRolloutPercentage ?? 100,
              credential_secret_name: 'META_CAPI_ACCESS_TOKEN',
              revision: CONNECTION_REVISION,
            } as T
          }
          if (sql.includes('FROM meta_capi_incidents')) {
            if (options.incidentQueryError) throw new Error('模拟 incident 查询失败')
            return options.criticalIncidentOpen
              ? ({ id: 'incident_open' } as T)
              : null
          }
          if (sql.includes('SELECT meta_external_id') && sql.includes('FROM users')) {
            if (options.stableIdQueryError) throw new Error('模拟 stable ID 查询失败')
            return options.userMetaExternalId == null
              ? null
              : ({ meta_external_id: options.userMetaExternalId } as T)
          }
          if (sql.includes('FROM meta_connection_verifications')) {
            if (options.metaConnectionVerified === false) return null
            return {
              environment: 'dev',
              pixel_id: options.metaDestinationId ?? '1234567890',
              token_fingerprint: TOKEN_FINGERPRINT,
              graph_api_version: 'v25.0',
              verified_event_name: 'Contact',
              verified_commit: RELEASE_COMMIT,
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: 1,
              invalidated_at: null,
              invalidation_reason: '',
              revision: CONNECTION_REVISION,
            } as T
          }
          if (sql.includes('FROM meta_capi_secure_outbox')) {
            const deliveryId = String(call.params[0])
            const outbox = insertedOutboxes.find(item => item.deliveryId === deliveryId)
            const delivery = insertedDeliveries.find(item => item.id === deliveryId)
            if (!outbox || !delivery) return null
            return {
              delivery_id: deliveryId,
              schema_version: outbox.schemaVersion,
              key_id: outbox.keyId,
              iv: outbox.iv,
              ciphertext: outbox.ciphertext,
              tag: outbox.tag,
              expires_at: outbox.expiresAt,
              status: delivery.status,
              skip_reason: delivery.skipReason,
              error_code: '',
              queue_enqueued_at: delivery.queueEnqueuedAt,
              queue_attempt_count: 0,
              updated_at: '2026-07-10 00:00:00',
              date: '2026-07-10',
              event_name: delivery.eventName,
            } as T
          }
          return null
        },
        async all<T>() {
          if (sql.includes('FROM ad_platform_connections')) {
            const rows: unknown[] = []
            if (options.metaBrowserEnabled || options.metaServerEnabled) rows.push({
              provider: 'meta', enabled: 1, mode: options.metaMode ?? 'disabled',
              browser_enabled: options.metaBrowserEnabled ? 1 : 0,
              server_enabled: options.metaServerEnabled ? 1 : 0,
              destination_id: options.metaDestinationId ?? '', debug_enabled: 0,
              rollout_percentage: options.metaRolloutPercentage ?? 100,
              credential_secret_name: 'META_CAPI_ACCESS_TOKEN', revision: CONNECTION_REVISION,
            })
            if (options.tiktokBrowserEnabled) rows.push({
              provider: 'tiktok', enabled: 1, mode: options.tiktokMode ?? 'disabled',
              browser_enabled: 1, server_enabled: 0,
              destination_id: options.tiktokDestinationId ?? '', debug_enabled: 0,
              rollout_percentage: 0, credential_secret_name: '', revision: null,
            })
            return { results: rows as T[] }
          }
          return { results: [] as T[] }
        },
        async run() {
          statementCount += 1
          calls.push(call)
          const result = applyCall(call, { dedupe, insertedConversions, insertedDeliveries, insertedOutboxes, claims })
          if (options.failAt === statementCount) throw new Error('模拟 D1 写入失败')
          return result
        },
      }
      Object.assign(statement, { __call: call })
      return statement
    },
    async batch(statements: Array<{ __call?: Call }>) {
      const staged = {
        dedupe: new Map(dedupe),
        insertedConversions: [...insertedConversions],
        insertedDeliveries: [...insertedDeliveries],
        insertedOutboxes: [...insertedOutboxes],
        claims: new Map(claims),
      }
      const results = []
      for (const statement of statements) {
        const call = statement.__call
        if (!call) throw new Error('缺少 batch statement')
        statementCount += 1
        calls.push(call)
        if (options.failAt === statementCount) throw new Error('模拟 D1 写入失败')
        results.push(applyCall(call, staged))
      }
      dedupe.clear()
      for (const [key, value] of staged.dedupe) dedupe.set(key, value)
      insertedConversions.splice(0, insertedConversions.length, ...staged.insertedConversions)
      insertedDeliveries.splice(0, insertedDeliveries.length, ...staged.insertedDeliveries)
      insertedOutboxes.splice(0, insertedOutboxes.length, ...staged.insertedOutboxes)
      claims.clear()
      for (const [key, value] of staged.claims) claims.set(key, value)
      return results
    },
    get failAt() {
      return options.failAt
    },
    set failAt(value: number | undefined) {
      options.failAt = value
    },
  }
  return Object.assign(db, { insertedDeliveries, insertedOutboxes, readCalls })
}

function envFor(db: ReturnType<typeof createConversionDb>, overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'dev',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_ACCESS_TOKEN: META_TOKEN,
    META_CAPI_TEST_EVENT_CODE: 'test-code',
    RELEASE_COMMIT,
    ...overrides,
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE' | 'META_CAPI_DATA_KEY_CURRENT' | 'META_CAPI_DATA_KEY_PREVIOUS' | 'RELEASE_COMMIT'>
}

function envWithQueueFor(db: ReturnType<typeof createConversionDb>, sent: MetaCapiQueueMessage[]) {
  return {
    APP_ENV: 'dev',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_ACCESS_TOKEN: META_TOKEN,
    META_CAPI_TEST_EVENT_CODE: 'test-code',
    RELEASE_COMMIT,
    META_CAPI_QUEUE: {
      async send(message: MetaCapiQueueMessage) {
        sent.push(message)
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
      },
    },
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE' | 'META_CAPI_DATA_KEY_CURRENT' | 'META_CAPI_DATA_KEY_PREVIOUS' | 'RELEASE_COMMIT'>
}

function grantedContactInput() {
  return {
    visitorId: 'visitor_1',
    sessionId: 'session_1',
    occurredAt: '2026-07-09T10:00:00.000Z',
    consentState: 'granted',
    methodType: 'telegram',
    actionTarget: 'floating_contact_panel',
    metadata: { method_type: 'telegram', location: 'floating_contact_panel' },
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

describe('conversion ledger service', () => {
  beforeEach(() => {
    metaHashMocks.email.mockClear()
    metaHashMocks.externalId.mockClear()
    metaCryptoMocks.encrypt.mockClear()
    metaCryptoMocks.loadKeys.mockClear()
  })

  it('联系与注册入口使用独立输入契约', () => {
    expectTypeOf<RecordContactInput['methodType']>().toEqualTypeOf<string>()
    expectTypeOf<RecordContactInput['actionTarget']>().toEqualTypeOf<string>()
    expectTypeOf<RecordRegistrationInput['userId']>().toEqualTypeOf<number>()
  })

  it.each([
    ['methodType', { methodType: '   ' }],
    ['actionTarget', { actionTarget: '\t\n' }],
  ] as const)('服务层拒绝空白 %s', async (_field, override) => {
    const db = createConversionDb()

    await expect(recordContact(envFor(db), {
      ...grantedContactInput(),
      ...override,
    })).rejects.toThrow('联系转化必须包含非空 methodType 和 actionTarget')
    expect(db.calls).toEqual([])
  })

  it('首次授权联系只返回 Contact Pixel 指令', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'test',
    })
    const result = await recordContact(envFor(db), grantedContactInput())

    expect(result.trackingInstructions.map(item => item.eventName)).toEqual(['Contact'])
    expect(result.trackingInstructions[0]?.eventId).toMatch(/^mg:v2:Contact:[0-9a-f]{64}$/)
    expect(result.trackingInstructions[0]?.eventId).not.toContain('session_1')
    expect(result.trackingInstructions.every(item => item.receiptToken)).toBe(true)
    expect(db.insertedDeliveries.find(item => item.transport === 'browser')).toMatchObject({
      connectionRevision: CONNECTION_REVISION,
    })
    expect(db.calls.filter(call => (
      call.sql.includes('INSERT INTO analytics_conversion_delivery_daily')
      && call.params.includes('pending')
    ))).toHaveLength(1)
  })

  it('同一联系事实为 Meta 与 TikTok 生成独立浏览器投递', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'test',
      tiktokBrowserEnabled: true,
      tiktokDestinationId: 'C123456789ABCDEF',
      tiktokMode: 'test',
    })
    const result = await recordContact(envFor(db), grantedContactInput())

    expect(result.trackingInstructions).toHaveLength(2)
    expect(result.trackingInstructions.map(item => item.provider)).toEqual(['meta', 'tiktok'])
    expect(result.trackingInstructions.every(item => item.eventName === 'Contact')).toBe(true)
    expect(db.insertedDeliveries.map(item => item.provider)).toEqual(['meta', 'tiktok'])
  })

  it('公开 metadata 中的 Meta 标识和网络标识不进入 SQL 参数', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'test',
    })
    await recordContact(envFor(db), {
      ...grantedContactInput(),
      metadata: {
        method_type: 'telegram',
        fbp: 'fb.1.private',
        fbc: 'fb.1.private',
        clientIpAddress: '203.0.113.8',
        client_user_agent: 'private-browser',
        user_agent: 'private-browser',
      },
    })

    const serializedCalls = JSON.stringify(db.calls)
    expect(serializedCalls).not.toContain('fb.1.private')
    expect(serializedCalls).not.toContain('203.0.113.8')
    expect(serializedCalls).not.toContain('private-browser')
  })

  it.each(['limited', 'denied'] as const)('%s 不创建 Meta delivery 或 Pixel 指令', async consentState => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'production',
      metaServerEnabled: true,
    })
    const sent: MetaCapiQueueMessage[] = []
    let supplierCalls = 0
    const result = await recordContact(envWithQueueFor(db, sent), { ...grantedContactInput(), consentState }, {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789', clientIpAddress: '203.0.113.24' }
      },
    })

    expect(result.trackingInstructions).toEqual([])
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
    expect(sent).toEqual([])
    expect(supplierCalls).toBe(0)
  })

  it('disabled 模式不创建 Meta delivery 或 Pixel 指令', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'disabled',
      metaServerEnabled: true,
    })
    const sent: MetaCapiQueueMessage[] = []
    let supplierCalls = 0
    const result = await recordContact(envWithQueueFor(db, sent), grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789', clientIpAddress: '203.0.113.24' }
      },
    })

    expect(result.trackingInstructions).toEqual([])
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
    expect(sent).toEqual([])
    expect(supplierCalls).toBe(0)
  })

  it('首次有效联系只写入一条 contact 与两条派生 delivery', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'test',
      metaServerEnabled: true,
    })
    const result = await recordContact(envFor(db), grantedContactInput())

    expect(result.actionType).toBe('contact')
    expect(result).not.toHaveProperty('derivedActions')
    expect(db.insertedConversions.map(item => item.actionType)).toEqual(['contact'])
    expect(db.insertedDeliveries.map(item => item.eventName)).toEqual(['Contact', 'Contact'])
  })

  it('delivery 写入失败不残留 action，重试后可返回指令', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaMode: 'test',
      failAt: 5,
    })

    await expect(recordContact(envFor(db), grantedContactInput())).rejects.toThrow()
    expect(db.insertedConversions).toEqual([])

    db.failAt = undefined
    const retried = await recordContact(envFor(db), grantedContactInput())
    expect(retried.created).toBe(true)
    expect(retried.trackingInstructions.map(item => item.eventName)).toEqual(['Contact'])
  })

  it('重复有效联系只记录重复账本，不创建 delivery', async () => {
    const db = createConversionDb({ existingDedupeKeys: ['contact:session_1:telegram:floating_contact_panel'] })
    const result = await recordContact(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:05:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    expect(result.created).toBe(false)
    expect(result.duplicateOf).toBe('existing_contact:session_1:telegram:floating_contact_panel')
    expect(result).not.toHaveProperty('derivedActions')
    expect(result.trackingInstructions).toEqual([])
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_actions'))).toBe(true)
    expect(db.calls.some(call => (
      call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_actions') &&
      String(call.params[2]).startsWith('duplicate:contact:session_1:telegram:floating_contact_panel:') &&
      call.params[20] === 'existing_contact:session_1:telegram:floating_contact_panel'
    ))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_daily'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('拒绝授权时不创建 Meta delivery', async () => {
    const db = createConversionDb()
    await recordRegistration(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:10:00.000Z',
      consentState: 'denied',
      metadata: {},
    })
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it.each(['limited', 'denied'] as const)('%s 注册不读取浏览器或敏感值、不 hash 且不创建 outbox', async consentState => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'production',
    })
    const browserSupplier = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))
    const sensitiveSupplier = vi.fn(async () => ({
      email: 'limited-private@example.test',
      metaExternalId: '0123456789abcdef0123456789abcdef',
    }))

    await recordRegistration(envFor(db), {
      visitorId: 'visitor_limited_registration',
      sessionId: 'session_limited_registration',
      userId: 420,
      occurredAt: '2026-07-10T08:00:00.000Z',
      consentState,
      metadata: { method: 'email' },
    }, {
      getMetaCapiUserData: browserSupplier,
      getRegistrationSensitiveInput: sensitiveSupplier,
    })

    expect(browserSupplier).not.toHaveBeenCalled()
    expect(sensitiveSupplier).not.toHaveBeenCalled()
    expect(metaHashMocks.email).not.toHaveBeenCalled()
    expect(metaHashMocks.externalId).not.toHaveBeenCalled()
    expect(db.insertedDeliveries).toEqual([])
    expect(db.insertedOutboxes).toEqual([])
  })

  it('授权注册只在惰性门禁后 hash，并将浏览器信号与两项 hash 写入同一密文上下文', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'production',
    })
    const sent: MetaCapiQueueMessage[] = []
    const env = envWithQueueFor(db, sent)
    const email = '  Granted.Unique+S5@Example.Test  '
    const metaExternalId = 'abcdef0123456789abcdef0123456789'
    const browser = {
      fbp: 'fb.1.1700000000000.987654321',
      fbc: 'fb.1.1700000000000.CLICK_s5-unique',
      clientIpAddress: '203.0.113.211',
      clientUserAgent: 'S5 Registration Browser/5.0',
    }
    let renewCountBeforeBrowser = 0
    const browserSupplier = vi.fn(async () => {
      renewCountBeforeBrowser = db.calls.filter(call => (
        call.sql.includes('UPDATE analytics_conversion_dedupe_claims')
        && call.sql.includes('RETURNING dedupe_digest')
      )).length
      return browser
    })
    const sensitiveSupplier = vi.fn(async () => ({ email, metaExternalId }))

    await recordRegistration(env, {
      visitorId: 'visitor_registration_s5',
      sessionId: 'session_registration_s5',
      userId: 421,
      occurredAt: '2026-07-10T08:01:00.000Z',
      consentState: 'granted',
      metadata: { method: 'email' },
    }, {
      getMetaCapiUserData: browserSupplier,
      getRegistrationSensitiveInput: sensitiveSupplier,
    })

    expect(browserSupplier).toHaveBeenCalledOnce()
    expect(renewCountBeforeBrowser).toBe(1)
    expect(sensitiveSupplier).toHaveBeenCalledOnce()
    expect(metaHashMocks.email).toHaveBeenCalledWith(email)
    expect(metaHashMocks.externalId).toHaveBeenCalledWith(metaExternalId)
    const delivery = db.insertedDeliveries.find(item => (
      item.eventName === 'CompleteRegistration' && item.transport === 'server'
    ))!
    expect(delivery).toMatchObject({ hasFbp: 1, hasFbc: 1, hasEmail: 1, hasExternalId: 1 })
    const envelope = sent.find(item => item.deliveryId === delivery.id)!.envelope
    const keys = await loadMetaCapiCryptoKeys(env)
    const decrypted = await decryptMetaCapiContext({
      keys,
      aad: { deliveryId: delivery.id, externalEventId: delivery.eventId, eventName: 'CompleteRegistration' },
      envelope: {
        schemaVersion: 2,
        keyId: envelope.keyId,
        iv: envelope.iv,
        ciphertext: envelope.ciphertext,
        tag: envelope.tag,
      },
    })
    expect(decrypted).toEqual({
      ...browser,
      emailSha256: await sha256Hex(email.trim().toLowerCase()),
      externalIdSha256: await sha256Hex(metaExternalId),
    })
    const serializedPersistentBoundaries = JSON.stringify({ calls: db.calls, sent })
    expect(serializedPersistentBoundaries).not.toContain(email)
    expect(serializedPersistentBoundaries).not.toContain(metaExternalId)
    expect(serializedPersistentBoundaries).not.toContain(browser.fbp)
    expect(serializedPersistentBoundaries).not.toContain(browser.fbc)
    expect(serializedPersistentBoundaries).not.toContain(browser.clientIpAddress)
    expect(serializedPersistentBoundaries).not.toContain(browser.clientUserAgent)
  })

  it.each([
    ['CAPI disabled', { metaServerEnabled: false, metaMode: 'production' as const, metaDestinationId: '1234567890' }, DATA_KEY],
    ['tracking disabled', { metaServerEnabled: true, metaMode: 'disabled' as const, metaDestinationId: '1234567890' }, DATA_KEY],
    ['connection unverified', { metaServerEnabled: true, metaMode: 'production' as const, metaDestinationId: '1234567890', metaConnectionVerified: false }, DATA_KEY],
    ['missing data key', { metaServerEnabled: true, metaMode: 'production' as const, metaDestinationId: '1234567890' }, undefined],
    ['invalid data key', { metaServerEnabled: true, metaMode: 'production' as const, metaDestinationId: '1234567890' }, 'invalid-key'],
  ])('%s 时注册不读取或 hash 匹配数据', async (_caseName, dbOptions, dataKey) => {
    const db = createConversionDb(dbOptions)
    const browserSupplier = vi.fn(async () => ({ fbp: 'fb.1.1700000000000.gated-private' }))
    const sensitiveSupplier = vi.fn(async () => ({
      email: 'gated-private@example.test',
      metaExternalId: '22222222222222222222222222222222',
    }))

    await recordRegistration({
      ...envFor(db),
      META_CAPI_DATA_KEY_CURRENT: dataKey,
    }, {
      visitorId: 'visitor_gated_registration',
      sessionId: 'session_gated_registration',
      userId: 423,
      occurredAt: '2026-07-10T08:03:00.000Z',
      consentState: 'granted',
      metadata: {},
    }, {
      getMetaCapiUserData: browserSupplier,
      getRegistrationSensitiveInput: sensitiveSupplier,
    })

    expect(browserSupplier).not.toHaveBeenCalled()
    expect(sensitiveSupplier).not.toHaveBeenCalled()
    expect(metaHashMocks.email).not.toHaveBeenCalled()
    expect(metaHashMocks.externalId).not.toHaveBeenCalled()
    expect(db.insertedOutboxes).toEqual([])
  })

  it('注册敏感 supplier 异常转为稳定 skipped，不携带原值或 cause', async () => {
    const db = createConversionDb({
      metaServerEnabled: true,
      metaMode: 'production',
      metaDestinationId: '1234567890',
    })
    const sensitive = 'supplier-private@example.test|33333333333333333333333333333333'

    const result = await recordRegistration(envFor(db), {
      visitorId: 'visitor_supplier_failure',
      sessionId: 'session_supplier_failure',
      userId: 424,
      occurredAt: '2026-07-10T08:04:00.000Z',
      consentState: 'granted',
      metadata: {},
    }, {
      getMetaCapiUserData: async () => ({ fbp: 'fb.1.1700000000000.supplier-private' }),
      getRegistrationSensitiveInput: async () => { throw new Error(sensitive) },
    })

    expect(result).toMatchObject({ created: true })
    expect(result).not.toHaveProperty('cause')
    expect(db.insertedDeliveries).toEqual([
      expect.objectContaining({
        transport: 'server',
        status: 'skipped',
        skipReason: 'invalid_sensitive_context',
        hasFbp: 0,
        hasFbc: 0,
        hasEmail: 0,
        hasExternalId: 0,
        connectionRevision: CONNECTION_REVISION,
      }),
    ])
    expect(JSON.stringify(result)).not.toContain(sensitive)
    expect(db.insertedOutboxes).toEqual([])
  })

  it('已登录 Contact 只读取浏览器 supplier，不接收或查询注册 PII', async () => {
    const db = createConversionDb({
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'production',
    })
    const browserSupplier = vi.fn(async () => ({
      fbp: 'fb.1.1700000000000.contact-only',
      emailSha256: 'a'.repeat(64),
      externalIdSha256: 'b'.repeat(64),
    }))

    await recordContact(envFor(db), { ...grantedContactInput(), userId: 421 }, {
      getMetaCapiUserData: browserSupplier,
    })

    expect(browserSupplier).toHaveBeenCalledOnce()
    expect(metaHashMocks.email).not.toHaveBeenCalled()
    expect(metaHashMocks.externalId).not.toHaveBeenCalled()
    expect(db.calls.some(call => /FROM\s+users/i.test(call.sql))).toBe(false)
    expect(db.insertedDeliveries).toEqual([
      expect.objectContaining({ hasEmail: 0, hasExternalId: 0 }),
    ])
  })

  it('同一服务端用户重复注册按用户 ID 去重且不重复规划 delivery', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'production',
    })
    const sent: MetaCapiQueueMessage[] = []
    const input = {
      visitorId: 'visitor_first',
      sessionId: 'session_first',
      userId: 42,
      occurredAt: '2026-07-10T08:00:00.000Z',
      consentState: 'granted',
      metadata: { method: 'email' },
    }

    const first = await recordRegistration(envWithQueueFor(db, sent), input)
    const second = await recordRegistration(envWithQueueFor(db, sent), {
      ...input,
      visitorId: 'visitor_retry',
      sessionId: 'session_retry',
    })

    expect(first.created).toBe(true)
    expect(second).toMatchObject({ created: false, duplicateOf: first.id, trackingInstructions: [] })
    expect(db.insertedConversions[0]?.dedupeKey).toBe('complete_registration:user:42')
    expect(db.insertedDeliveries).toHaveLength(2)
    expect(sent).toHaveLength(1)
  })

  it('重复注册事实不读取惰性上下文且不 hash', async () => {
    const db = createConversionDb({ existingDedupeKeys: ['complete_registration:user:422'] })
    const browserSupplier = vi.fn(async () => ({ fbp: 'fb.1.duplicate-private' }))
    const sensitiveSupplier = vi.fn(async () => ({
      email: 'duplicate-private@example.test',
      metaExternalId: '11111111111111111111111111111111',
    }))

    await recordRegistration(envFor(db), {
      visitorId: 'visitor_duplicate_registration',
      sessionId: 'session_duplicate_registration',
      userId: 422,
      occurredAt: '2026-07-10T08:02:00.000Z',
      consentState: 'granted',
      metadata: {},
    }, {
      getMetaCapiUserData: browserSupplier,
      getRegistrationSensitiveInput: sensitiveSupplier,
    })

    expect(browserSupplier).not.toHaveBeenCalled()
    expect(sensitiveSupplier).not.toHaveBeenCalled()
    expect(metaHashMocks.email).not.toHaveBeenCalled()
    expect(metaHashMocks.externalId).not.toHaveBeenCalled()
    expect(db.insertedDeliveries).toEqual([])
  })

  it('注册事实修复只写 action 与 daily aggregate，且按服务端用户 ID 幂等', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'production',
    })
    const input = {
      userId: 42,
      visitorId: 'registration_user_42',
      sessionId: 'registration_user_42',
      occurredAt: '2026-07-10T08:00:00.000Z',
      sourceChannel: 'unknown',
      metadata: { method: 'email', recovery: true },
    }

    const first = await recordRegistrationFactOnly(db as unknown as D1Database, input)
    const second = await recordRegistrationFactOnly(db as unknown as D1Database, input)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(db.insertedConversions.map(item => item.dedupeKey)).toEqual(['complete_registration:user:42'])
    expect(db.calls.filter(call => call.sql.includes('analytics_conversion_daily'))).toHaveLength(1)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('可映射事件生成 Pixel 和 CAPI delivery，且 external_event_id 稳定', async () => {
    const input = {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:20:00.000Z',
      consentState: 'granted',
      actionTarget: 'register',
      metadata: {},
    }
    const firstDb = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
    })
    const secondDb = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
    })

    await recordRegistration(envFor(firstDb), input)
    await recordRegistration(envFor(secondDb), input)

    const firstDeliveries = firstDb.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    const secondDeliveries = secondDb.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    expect(firstDeliveries.map(call => call.params[3]).sort()).toEqual(['browser', 'server'])
    expect(firstDeliveries.map(call => call.params[4])).toEqual([
      secondDeliveries[0]?.params[4],
      secondDeliveries[1]?.params[4],
    ])
  })

  it('CAPI 开启且 Queue 存在时只发送 V2 密文消息', async () => {
    const sent: MetaCapiQueueMessage[] = []
    const db = createConversionDb({ metaServerEnabled: true, metaMode: 'test', metaDestinationId: '1234567890' })

    await recordRegistration(envWithQueueFor(db, sent), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:22:00.000Z',
      consentState: 'granted',
      metadata: {},
    })

    const capiDelivery = db.calls.find(call => (
      call.sql.includes('analytics_conversion_deliveries') &&
      call.params[3] === 'server'
    ))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      schemaVersion: 2,
      deliveryId: capiDelivery?.params[0] as string,
      envelope: {
        keyId: expect.stringMatching(/^[0-9a-f]{16}$/),
        iv: expect.any(String),
        ciphertext: expect.any(String),
        tag: expect.any(String),
        expiresAt: expect.any(String),
      },
    })
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(['deliveryId', 'envelope', 'schemaVersion'])
    expect(capiDelivery?.sql).toContain('tracking_mode')
    expect(capiDelivery?.sql).toContain('connection_revision')
    expect(capiDelivery?.params).toContain('test')
    expect(db.insertedDeliveries.find(delivery => delivery.id === capiDelivery?.params[0]))
      .toMatchObject({ connectionRevision: CONNECTION_REVISION })
    expect(db.calls.some(call => (
      call.sql.includes('queue_enqueued_at = datetime')
      && call.params.includes(capiDelivery?.params[0])
    ))).toBe(true)
  })

  it('只将临时匹配数据加密后投递，并仅以 0|1 写入 delivery 覆盖率', async () => {
    const db = createConversionDb({ metaServerEnabled: true, metaMode: 'test', metaDestinationId: '1234567890' })
    const sent: MetaCapiQueueMessage[] = []
    const userData = {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
      ignored: 'must-not-pass',
    }

    let supplierCalls = 0
    await recordContact(envWithQueueFor(db, sent), {
      ...grantedContactInput(),
      metadata: { fbp: 'metadata-fbp', fbc: 'metadata-fbc' },
    }, {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return userData
      },
    })

    expect(sent).toHaveLength(1)
    expect(supplierCalls).toBe(1)
    expect(sent[0]).toMatchObject({ schemaVersion: 2, envelope: { keyId: expect.any(String) } })
    expect(JSON.stringify(sent)).not.toContain(userData.fbp)
    expect(JSON.stringify(sent)).not.toContain(userData.fbc)
    expect(JSON.stringify(sent)).not.toContain(userData.clientIpAddress)
    expect(JSON.stringify(sent)).not.toContain(userData.clientUserAgent)
    const deliveryCalls = db.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    expect(deliveryCalls).toHaveLength(1)
    expect(deliveryCalls.every(call => call.params.includes(1))).toBe(true)
    expect(deliveryCalls.every(call => call.sql.includes('tracking_mode') && call.params.includes('test'))).toBe(true)
    expect(JSON.stringify(db.calls)).not.toContain(userData.fbp)
    expect(JSON.stringify(db.calls)).not.toContain(userData.fbc)
    expect(JSON.stringify(db.calls)).not.toContain(userData.clientIpAddress)
    expect(JSON.stringify(db.calls)).not.toContain(userData.clientUserAgent)
    expect(JSON.stringify(db.calls)).not.toContain('metadata-fbp')
    expect(JSON.stringify(db.calls)).not.toContain('metadata-fbc')
  })

  it('CAPI 未启用时不调用临时数据 supplier', async () => {
    const db = createConversionDb({ metaMode: 'test', metaDestinationId: '1234567890' })
    let supplierCalls = 0

    await recordContact(envFor(db), grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789' }
      },
    })

    expect(supplierCalls).toBe(0)
  })

  it('缺少合法 Pixel ID 时不调用临时数据 supplier', async () => {
    const db = createConversionDb({ metaServerEnabled: true, metaMode: 'test' })
    let supplierCalls = 0

    await recordContact(envFor(db), grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789' }
      },
    })

    expect(supplierCalls).toBe(0)
  })

  it('Queue 发送异常只记录固定诊断信息，不持久化异常原文', async () => {
    const db = createConversionDb({ metaServerEnabled: true, metaMode: 'test', metaDestinationId: '1234567890' })
    const sensitive = 'fb.1.1700000000000.123456789|fb.1.1700000000000.CLICK_abc-123|203.0.113.24|MeiGallery Test Browser/1.0|token_private'
    const env = {
      ...envFor(db),
      META_CAPI_QUEUE: { send: async () => { throw new Error(sensitive) } },
    } as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>

    const result = await recordContact(env, grantedContactInput())

    const serializedCalls = JSON.stringify(db.calls)
    expect(serializedCalls).not.toContain(sensitive)
    expect(JSON.stringify(result)).not.toContain(sensitive)
    expect(serializedCalls).toContain('queue_send_failed')
    expect(db.calls.some(call => (
      call.sql.includes('queue_attempt_count = queue_attempt_count + 1')
      && call.params.includes(db.calls.find(item => item.sql.includes('analytics_conversion_deliveries') && item.params[3] === 'server')?.params[0])
    ))).toBe(true)
    expect(db.calls.some(call => (
      call.sql.includes("error_code = 'queue_send_failed'")
      && !/SET\s+status\s*=/.test(call.sql)
    ))).toBe(true)
  })

  it('CAPI 开启但缺少 Queue binding 时保持 pending 并记录可恢复诊断', async () => {
    const db = createConversionDb({ metaServerEnabled: true, metaMode: 'test', metaDestinationId: '1234567890' })

    await recordRegistration(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:23:00.000Z',
      consentState: 'granted',
      metadata: {},
    })

    expect(db.calls.some(call => (
      call.sql.includes('UPDATE analytics_conversion_deliveries') &&
      call.sql.includes("error_code = 'missing_queue'")
    ))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('SET\n        status = ?') && call.params[0] === 'skipped')).toBe(false)
  })

  it('outbox statement 失败时 action、delivery 与密文均不残留', async () => {
    const db = createConversionDb({
      metaServerEnabled: true,
      metaMode: 'test',
      metaDestinationId: '1234567890',
      failAt: 5,
    })

    await expect(recordContact(envFor(db), grantedContactInput(), {
      getMetaCapiUserData: () => ({
        fbp: 'fb.1.1700000000000.123456789',
        clientIpAddress: '203.0.113.24',
      }),
    })).rejects.toThrow('模拟 D1 写入失败')

    expect(db.insertedConversions).toEqual([])
    expect(db.insertedDeliveries).toEqual([])
    expect(db.insertedOutboxes).toEqual([])
  })

  it.each([
    ['missing_data_key', undefined],
    ['invalid_data_key', 'not-a-valid-data-key'],
  ] as const)('数据密钥异常时 Pixel 与业务事实正常，CAPI 只写 skipped/%s', async (reason, dataKey) => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
    })
    const sent: MetaCapiQueueMessage[] = []
    let supplierCalls = 0
    const conversionEnv = {
      ...envWithQueueFor(db, sent),
      META_CAPI_DATA_KEY_CURRENT: dataKey,
    }

    const result = await recordContact(conversionEnv, grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789' }
      },
    })

    expect(result.created).toBe(true)
    expect(result.trackingInstructions).toHaveLength(1)
    expect(supplierCalls).toBe(0)
    expect(sent).toEqual([])
    expect(db.insertedConversions).toHaveLength(1)
    expect(db.insertedDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'pending', skipReason: '' }),
      expect.objectContaining({ status: 'skipped', skipReason: reason, encryptionKeyId: '' }),
    ]))
    expect(db.insertedOutboxes).toEqual([])
  })

  it('MetaConnection 未验证时保留业务事实，但 Pixel/CAPI 都 fail closed', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
    })
    const sent: MetaCapiQueueMessage[] = []
    let supplierCalls = 0

    const result = await recordContact({
      ...envWithQueueFor(db, sent),
      APP_ENV: 'dev',
      META_CAPI_ACCESS_TOKEN: 'unverified-token',
      META_CAPI_TEST_EVENT_CODE: 'test-code',
      RELEASE_COMMIT: 'a'.repeat(40),
    } as unknown as Parameters<typeof recordContact>[0], grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789' }
      },
    })

    expect(result.created).toBe(true)
    expect(result.trackingInstructions).toEqual([])
    expect(db.insertedDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ transport: 'browser', status: 'skipped', skipReason: 'connection_unverified' }),
      expect.objectContaining({ status: 'skipped', skipReason: 'connection_unverified' }),
    ]))
    expect(db.insertedOutboxes).toEqual([])
    expect(sent).toEqual([])
    expect(supplierCalls).toBe(0)
    expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
      rolloutTargetPercentage: 0,
      rolloutEffectivePercentage: 0,
      rolloutBucket: null,
    })
  })

  it.each([
    ['rollout_excluded', { metaRolloutPercentage: 0 }, 'visitor_rollout_excluded'],
    ['circuit_open', { metaRolloutPercentage: 100, criticalIncidentOpen: true }, 'visitor_circuit_open'],
    ['missing_stable_id', { metaRolloutPercentage: 100 }, '   '],
  ] as const)('%s 在敏感上下文之前短路，保留 skipped delivery 且不创建 secure outbox', async (
    reason,
    rolloutOptions,
    visitorId,
  ) => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      ...rolloutOptions,
    })
    const browserProvider = vi.fn(async () => ({
      fbp: 'fb.1.must-not-read',
      clientIpAddress: '203.0.113.10',
    }))

    const result = await recordContact(envFor(db), {
      ...grantedContactInput(),
      visitorId,
    }, { getMetaCapiUserData: browserProvider })

    expect(result.trackingInstructions).toHaveLength(1)
    expect(browserProvider).not.toHaveBeenCalled()
    expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
    expect(db.insertedOutboxes).toEqual([])
    const delivery = db.insertedDeliveries.find(item => item.transport === 'server')
    expect(delivery).toMatchObject({
      status: 'skipped',
      skipReason: reason,
      encryptionKeyId: '',
      rolloutTargetPercentage: rolloutOptions.metaRolloutPercentage,
      rolloutEffectivePercentage: reason === 'circuit_open' ? 0 : rolloutOptions.metaRolloutPercentage,
    })
    expect(delivery?.rolloutBucket == null).toBe(reason === 'missing_stable_id')
    expect(db.insertedDeliveries.find(item => item.transport === 'browser')).toMatchObject({
      rolloutTargetPercentage: 0,
      rolloutEffectivePercentage: 0,
      rolloutBucket: null,
    })
  })

  it('stable ID 查询异常时保留注册事实与 Pixel，并 fail closed 跳过 CAPI', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      metaRolloutPercentage: 100,
      stableIdQueryError: true,
    })
    const browserProvider = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))
    const sensitiveProvider = vi.fn(async () => ({
      email: 'must-not-hash@example.test',
      metaExternalId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }))

    const result = await recordRegistration(envFor(db), {
      visitorId: '',
      sessionId: 'session_registration_stable_query_error',
      userId: 42,
      occurredAt: '2026-07-11T08:00:00.000Z',
      consentState: 'granted',
      metadata: {},
    }, {
      getMetaCapiUserData: browserProvider,
      getRegistrationSensitiveInput: sensitiveProvider,
    })

    expect(result.created).toBe(true)
    expect(result.trackingInstructions).toHaveLength(1)
    expect(db.insertedConversions).toHaveLength(1)
    expect(browserProvider).not.toHaveBeenCalled()
    expect(sensitiveProvider).not.toHaveBeenCalled()
    expect(metaHashMocks.email).not.toHaveBeenCalled()
    expect(metaHashMocks.externalId).not.toHaveBeenCalled()
    expect(metaCryptoMocks.loadKeys).not.toHaveBeenCalled()
    expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
    expect(db.insertedOutboxes).toEqual([])
    expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
      status: 'skipped',
      skipReason: 'rollout_excluded',
      rolloutTargetPercentage: 0,
      rolloutEffectivePercentage: 0,
      rolloutBucket: null,
    })
  })

  it('统一连接读取异常时不提交事实或访问敏感上下文', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      rolloutSettingQueryError: true,
    })
    const browserProvider = vi.fn(async () => ({
      fbp: 'fb.1.must-not-read',
      clientIpAddress: '203.0.113.10',
    }))

    await expect(recordContact(
      envFor(db),
      { ...grantedContactInput(), visitorId: 'visitor_rollout_setting_query_error' },
      { getMetaCapiUserData: browserProvider },
    )).rejects.toThrow('模拟 rollout setting 查询失败')

    expect(db.insertedConversions).toHaveLength(0)
    expect(browserProvider).not.toHaveBeenCalled()
    expect(metaCryptoMocks.loadKeys).not.toHaveBeenCalled()
    expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
    expect(db.insertedOutboxes).toEqual([])
    expect(db.insertedDeliveries).toEqual([])
  })

  it('critical incident 查询异常时保留联系事实与 Pixel，并 fail closed 跳过 CAPI', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      metaRolloutPercentage: 100,
      incidentQueryError: true,
    })
    const browserProvider = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))

    const result = await recordContact(
      envFor(db),
      { ...grantedContactInput(), visitorId: 'visitor_incident_query_error' },
      { getMetaCapiUserData: browserProvider },
    )

    expect(result.created).toBe(true)
    expect(result.trackingInstructions).toHaveLength(1)
    expect(db.insertedConversions).toHaveLength(1)
    expect(browserProvider).not.toHaveBeenCalled()
    expect(metaCryptoMocks.loadKeys).not.toHaveBeenCalled()
    expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
    expect(db.insertedOutboxes).toEqual([])
    expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
      status: 'skipped',
      skipReason: 'rollout_excluded',
      rolloutTargetPercentage: 0,
      rolloutEffectivePercentage: 0,
      rolloutBucket: null,
    })
  })

  it('rollout digest 异常时保留联系事实与 Pixel，并 fail closed 跳过 CAPI', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      metaRolloutPercentage: 100,
    })
    const browserProvider = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      if (new TextDecoder().decode(bytes).startsWith('meta-capi-rollout-v1\n')) {
        return Promise.reject(new Error('模拟 rollout digest 失败'))
      }
      return originalDigest(algorithm, data)
    })

    try {
      const result = await recordContact(
        envFor(db),
        { ...grantedContactInput(), visitorId: 'visitor_digest_error' },
        { getMetaCapiUserData: browserProvider },
      )

      expect(result.created).toBe(true)
      expect(result.trackingInstructions).toHaveLength(1)
      expect(db.insertedConversions).toHaveLength(1)
      expect(browserProvider).not.toHaveBeenCalled()
      expect(metaCryptoMocks.loadKeys).not.toHaveBeenCalled()
      expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
      expect(db.insertedOutboxes).toEqual([])
      expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
        status: 'skipped',
        skipReason: 'rollout_excluded',
        rolloutTargetPercentage: 0,
        rolloutEffectivePercentage: 0,
        rolloutBucket: null,
      })
    }
    finally {
      digestSpy.mockRestore()
    }
  })

  it('Contact 仅使用 visitorId，不使用 userId 或用户 external ID 回退', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      metaRolloutPercentage: 100,
      userMetaExternalId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    const browserProvider = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))

    await recordContact(envFor(db), {
      ...grantedContactInput(),
      visitorId: ' ',
      userId: 42,
    }, { getMetaCapiUserData: browserProvider })

    expect(browserProvider).not.toHaveBeenCalled()
    expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
    expect(db.readCalls.some(call => call.sql.includes('SELECT meta_external_id'))).toBe(false)
    expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
      status: 'skipped',
      skipReason: 'missing_stable_id',
      rolloutBucket: null,
    })
  })

  it('CompleteRegistration 缺 visitorId 时只按 userId 查询 meta_external_id 作为 stable ID', async () => {
    const stableId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      metaRolloutPercentage: 100,
      userMetaExternalId: stableId,
    })
    const browserProvider = vi.fn(async () => ({ fbp: 'fb.1.1700000000000.registration' }))
    const sensitiveProvider = vi.fn(async () => ({
      email: 'registration@example.test',
      metaExternalId: stableId,
    }))

    await recordRegistration(envFor(db), {
      visitorId: ' ',
      sessionId: 'session_registration_rollout',
      userId: 42,
      occurredAt: '2026-07-11T08:00:00.000Z',
      consentState: 'granted',
      metadata: {},
    }, {
      getMetaCapiUserData: browserProvider,
      getRegistrationSensitiveInput: sensitiveProvider,
    })

    expect(browserProvider).toHaveBeenCalledOnce()
    expect(sensitiveProvider).toHaveBeenCalledOnce()
    expect(db.readCalls.find(call => call.sql.includes('SELECT meta_external_id'))?.params).toEqual([42])
    expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
      status: 'pending',
      rolloutTargetPercentage: 100,
      rolloutEffectivePercentage: 100,
      rolloutBucket: await rolloutBucket(stableId),
    })
  })

  it('CompleteRegistration 同时缺 visitorId 与 meta_external_id 时不读取或 hash 敏感值', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
      metaRolloutPercentage: 100,
      userMetaExternalId: null,
    })
    const browserProvider = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))
    const sensitiveProvider = vi.fn(async () => ({
      email: 'must-not-hash@example.test',
      metaExternalId: 'cccccccccccccccccccccccccccccccc',
    }))

    await recordRegistration(envFor(db), {
      visitorId: '',
      sessionId: 'session_registration_missing_stable',
      userId: 42,
      occurredAt: '2026-07-11T08:00:00.000Z',
      consentState: 'granted',
      metadata: {},
    }, {
      getMetaCapiUserData: browserProvider,
      getRegistrationSensitiveInput: sensitiveProvider,
    })

    expect(browserProvider).not.toHaveBeenCalled()
    expect(sensitiveProvider).not.toHaveBeenCalled()
    expect(metaHashMocks.email).not.toHaveBeenCalled()
    expect(metaHashMocks.externalId).not.toHaveBeenCalled()
    expect(metaCryptoMocks.encrypt).not.toHaveBeenCalled()
    expect(db.insertedOutboxes).toEqual([])
    expect(db.insertedDeliveries.find(item => item.transport === 'server')).toMatchObject({
      status: 'skipped',
      skipReason: 'missing_stable_id',
      rolloutBucket: null,
    })
  })

  it('同 session 不同 contact target 分别记录且不生成 Lead', async () => {
    const db = createConversionDb({
      metaBrowserEnabled: true,
      metaDestinationId: '1234567890',
      metaServerEnabled: true,
      metaMode: 'test',
    })

    const first = await recordContact(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:30:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    const second = await recordContact(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:30:01.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'gallery_detail_cta',
      metadata: {},
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(first).not.toHaveProperty('derivedActions')
    expect(second).not.toHaveProperty('derivedActions')
    expect(db.insertedConversions.filter(item => item.actionType === 'contact').map(item => item.dedupeKey).sort()).toEqual([
      'contact:session_1:telegram:floating_contact_panel',
      'contact:session_1:telegram:gallery_detail_cta',
    ])
    expect(db.insertedConversions.some(item => item.actionType === 'lead')).toBe(false)
    expect(db.insertedDeliveries.map(item => item.eventName)).toEqual(['Contact', 'Contact', 'Contact', 'Contact'])
  })
})
