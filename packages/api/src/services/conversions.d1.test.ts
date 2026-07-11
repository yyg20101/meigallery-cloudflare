import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import { recordContact, recordRegistration } from './conversions'

const hashMocks = vi.hoisted(() => ({
  email: vi.fn(),
  externalId: vi.fn(),
}))

vi.mock('../utils/meta-browser-identifiers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/meta-browser-identifiers')>()
  hashMocks.email.mockImplementation(actual.hashMetaEmail)
  hashMocks.externalId.mockImplementation(actual.hashMetaExternalId)
  return {
    ...actual,
    hashMetaEmail: hashMocks.email,
    hashMetaExternalId: hashMocks.externalId,
  }
})

const PIXEL_ID = '1234567890'
const META_TOKEN = 'conversion-d1-token'
const RELEASE_COMMIT = 'a'.repeat(40)
const CONNECTION_REVISION = '1'.repeat(32)
const DATA_KEY = Buffer.alloc(32, 7).toString('base64')

type ClaimRun = { sql: string; changes: number }
type WrappedStatement = D1PreparedStatement & { __inner: D1PreparedStatement }

let miniflare: Miniflare
let realDb: D1Database
let actualHashEmail: (email: string) => Promise<string>
let actualHashExternalId: (externalId: string) => Promise<string>

beforeAll(async () => {
  const identifiers = await vi.importActual<typeof import('../utils/meta-browser-identifiers')>('../utils/meta-browser-identifiers')
  actualHashEmail = identifiers.hashMetaEmail
  actualHashExternalId = identifiers.hashMetaExternalId
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000138' },
    d1Persist: false,
  })
  realDb = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  const bootstrapSchema = `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `
  for (const statement of unstable_splitSqlQuery(bootstrapSchema)) {
    await realDb.prepare(statement).run()
  }
  for (const name of [
    '0032_attribution_conversions.sql',
    '0034_meta_production_readiness.sql',
    '0035_meta_capi_delivery_recovery.sql',
    '0036_meta_capi_v2_secure_delivery.sql',
    '0037_meta_connection_revision.sql',
    '0038_conversion_dedupe_claims.sql',
    '0039_meta_capi_v2_operations.sql',
  ]) await applyMigration(name)
}, 30_000)

beforeEach(async () => {
  hashMocks.email.mockReset().mockImplementation(actualHashEmail)
  hashMocks.externalId.mockReset().mockImplementation(actualHashExternalId)
  await realDb.exec(`
    DELETE FROM meta_capi_secure_outbox;
    DELETE FROM analytics_conversion_deliveries;
    DELETE FROM analytics_conversion_delivery_daily;
    DELETE FROM analytics_conversion_daily;
    DELETE FROM analytics_conversion_actions;
    DELETE FROM analytics_conversion_dedupe_claims;
    DELETE FROM meta_capi_incidents;
    DELETE FROM meta_connection_verifications;
    DELETE FROM site_settings;
    DELETE FROM users;
  `)
  await seedRuntime()
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('conversion dedupe claim 真实 D1 并发', () => {
  it('首查均未命中时只有 claim winner 读取 PII/hash，loser 读取已提交 action', async () => {
    const sensitiveEntered = deferred<void>()
    const releaseSensitive = deferred<void>()
    const loserClaimConflict = deferred<void>()
    const releaseLoser = deferred<void>()
    const queueSend = vi.fn(async () => { throw new Error('QUEUE_UNAVAILABLE') })
    const winnerBrowser = vi.fn(async () => ({ fbp: 'fb.1.1700000000000.winner' }))
    const winnerSensitive = vi.fn(async () => {
      sensitiveEntered.resolve()
      await releaseSensitive.promise
      return {
        email: 'winner-only@example.test',
        metaExternalId: '0123456789abcdef0123456789abcdef',
      }
    })
    const loserBrowser = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))
    const loserSensitive = vi.fn(async () => ({
      email: 'loser-must-not-read@example.test',
      metaExternalId: 'fedcba9876543210fedcba9876543210',
    }))
    const loserDb = wrapDb(realDb, {
      afterClaimInsert: async (changes) => {
        if (changes !== 0) return
        loserClaimConflict.resolve()
        await releaseLoser.promise
      },
    })

    const winnerPromise = recordRegistration(conversionEnv(realDb, queueSend), registrationInput(), {
      getMetaCapiUserData: winnerBrowser,
      getRegistrationSensitiveInput: winnerSensitive,
    })
    await sensitiveEntered.promise
    const activeClaims = await realDb.prepare(`
      SELECT dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
      FROM analytics_conversion_dedupe_claims
    `).all<Record<string, unknown>>()
    const serializedClaims = JSON.stringify(activeClaims.results)
    expect(activeClaims.results).toHaveLength(1)
    expect(activeClaims.results[0]?.dedupe_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(activeClaims.results[0]?.claim_token).toMatch(/^[0-9a-f]{32}$/)
    expect(serializedClaims).not.toContain('complete_registration:user:42')
    expect(serializedClaims).not.toContain('winner-only@example.test')
    expect(serializedClaims).not.toContain('0123456789abcdef0123456789abcdef')
    expect(serializedClaims).not.toContain('floating_contact_panel')
    const loserPromise = recordRegistration(conversionEnv(loserDb, queueSend), registrationInput(), {
      getMetaCapiUserData: loserBrowser,
      getRegistrationSensitiveInput: loserSensitive,
    })
    await loserClaimConflict.promise

    releaseSensitive.resolve()
    const winner = await winnerPromise
    releaseLoser.resolve()
    const loser = await loserPromise

    expect(winner).toMatchObject({ created: true, duplicateOf: '' })
    expect(loser).toMatchObject({ id: winner.id, created: false, duplicateOf: winner.id, pixelEvents: [] })
    expect(winnerBrowser).toHaveBeenCalledOnce()
    expect(winnerSensitive).toHaveBeenCalledOnce()
    expect(loserBrowser).not.toHaveBeenCalled()
    expect(loserSensitive).not.toHaveBeenCalled()
    expect(hashMocks.email).toHaveBeenCalledOnce()
    expect(hashMocks.externalId).toHaveBeenCalledOnce()
    expect(queueSend).toHaveBeenCalledOnce()
    await expectLedgerCounts({ actions: 1, deliveries: 2, outboxes: 1, claims: 0 })
  })

  it.each([
    ['batch 构造失败', { failSettingsRead: true }],
    ['D1 batch 失败', { failBatch: true }],
  ])('%s 会按 owner 释放 claim', async (_name, options) => {
    const db = wrapDb(realDb, options)
    const browser = vi.fn(async () => ({ fbp: 'fb.1.must-not-persist' }))
    const sensitive = vi.fn(async () => ({
      email: 'failure@example.test',
      metaExternalId: '0123456789abcdef0123456789abcdef',
    }))

    await expect(recordRegistration(conversionEnv(db), registrationInput(), {
      getMetaCapiUserData: browser,
      getRegistrationSensitiveInput: sensitive,
    })).rejects.toThrow()

    expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_dedupe_claims')).toBe(0)
    expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_actions')).toBe(0)
  })

  it('旧 owner 被接管后不能提交或删除新 claim', async () => {
    const oldBatchReady = deferred<void>()
    const releaseOldBatch = deferred<void>()
    const newSensitiveEntered = deferred<void>()
    const releaseNewSensitive = deferred<void>()
    const queueSend = vi.fn(async () => { throw new Error('QUEUE_UNAVAILABLE') })
    const dedupeDigest = await sha256Hex('complete_registration:user:42')
    const input = registrationInput()
    const oldPromise = recordRegistration(conversionEnv(wrapDb(realDb, {
      beforeBatch: async () => {
        oldBatchReady.resolve()
        await releaseOldBatch.promise
      },
    })), input, {
      getMetaCapiUserData: async () => ({ fbp: 'fb.1.1700000000000.old-owner' }),
      getRegistrationSensitiveInput: async () => ({
        email: 'old-owner@example.test',
        metaExternalId: '0123456789abcdef0123456789abcdef',
      }),
    })
    await oldBatchReady.promise

    await realDb.prepare(`
      UPDATE analytics_conversion_dedupe_claims
      SET
        claimed_at = '1999-12-31T23:59:00.000Z',
        expires_at = '2000-01-01T00:00:00.000Z'
      WHERE dedupe_digest = ?
    `).bind(dedupeDigest).run()

    const newPromise = recordRegistration(conversionEnv(realDb, queueSend), input, {
      getMetaCapiUserData: async () => ({ fbp: 'fb.1.1700000000000.new-owner' }),
      getRegistrationSensitiveInput: async () => {
        newSensitiveEntered.resolve()
        await releaseNewSensitive.promise
        return {
          email: 'new-owner@example.test',
          metaExternalId: 'fedcba9876543210fedcba9876543210',
        }
      },
    })
    await newSensitiveEntered.promise
    const newClaim = await realDb.prepare(`
      SELECT owner_action_id, claim_token
      FROM analytics_conversion_dedupe_claims
      WHERE dedupe_digest = ?
    `).bind(dedupeDigest).first<{ owner_action_id: string; claim_token: string }>()

    releaseOldBatch.resolve()
    await expect(oldPromise).rejects.toMatchObject({ code: 'CONVERSION_IN_PROGRESS' })
    expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_actions')).toBe(0)
    expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_dedupe_claims')).toBe(1)
    expect(await realDb.prepare(`
      SELECT owner_action_id, claim_token
      FROM analytics_conversion_dedupe_claims
      WHERE dedupe_digest = ?
    `).bind(dedupeDigest).first()).toEqual(newClaim)

    releaseNewSensitive.resolve()
    const winner = await newPromise

    expect(winner.id).toBe(newClaim?.owner_action_id)
    await expectLedgerCounts({ actions: 1, deliveries: 2, outboxes: 1, claims: 0 })
  })

  it('claim 由真实 D1 时钟自然过期且无人接管时，最终 fence 阻止全部账本写入', async () => {
    const batchReady = deferred<void>()
    const releaseBatch = deferred<void>()
    const dedupeDigest = await sha256Hex('complete_registration:user:42')
    const request = recordRegistration(conversionEnv(wrapDb(realDb, {
      claimLeaseModifier: '+1 second',
      beforeBatch: async () => {
        batchReady.resolve()
        await releaseBatch.promise
      },
    })), registrationInput(), {
      getMetaCapiUserData: async () => ({ fbp: 'fb.1.1700000000000.expired-lease' }),
      getRegistrationSensitiveInput: async () => ({
        email: 'expired-lease@example.test',
        metaExternalId: '0123456789abcdef0123456789abcdef',
      }),
    })
    await batchReady.promise

    const beforeExpiry = await readClaimSnapshot(dedupeDigest)
    expect(beforeExpiry).not.toBeNull()
    await pollUntilClaimExpired(dedupeDigest)
    expect(await readClaimSnapshot(dedupeDigest)).toEqual(beforeExpiry)
    releaseBatch.resolve()

    await expect(request).rejects.toMatchObject({ code: 'CONVERSION_IN_PROGRESS' })
    await expectLedgerCounts({ actions: 0, deliveries: 0, outboxes: 0, claims: 0 })
    expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_daily')).toBe(0)
    expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_delivery_daily')).toBe(0)
  }, 10_000)

  it('过期 claim 只能通过 CAS 被一个 Contact 请求接管', async () => {
    const dedupeDigest = await sha256Hex('contact:session_contact:telegram:floating_contact_panel')
    await realDb.prepare(`
      INSERT INTO analytics_conversion_dedupe_claims (
        dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
      ) VALUES (?, 'conv_stale_owner', ?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:01:00.000Z')
    `).bind(dedupeDigest, 'a'.repeat(32)).run()
    const entered = deferred<void>()
    const release = deferred<void>()
    const claimRuns: ClaimRun[] = []
    const queueSend = vi.fn(async () => { throw new Error('QUEUE_UNAVAILABLE') })
    const suppliers = [0, 1].map(index => vi.fn(async () => {
      entered.resolve()
      await release.promise
      return { fbp: `fb.1.1700000000000.contact-${index}` }
    }))
    const input = {
      visitorId: 'visitor_contact',
      sessionId: 'session_contact',
      occurredAt: '2026-07-11T08:00:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    }

    const requests = suppliers.map(supplier => recordContact(
      conversionEnv(wrapDb(realDb, { claimRuns }), queueSend),
      input,
      { getMetaCapiUserData: supplier },
    ))
    await entered.promise
    release.resolve()
    const outcomes = await Promise.allSettled(requests)

    expect(suppliers.reduce((count, supplier) => count + supplier.mock.calls.length, 0)).toBe(1)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.created)).toHaveLength(1)
    expect(claimRuns.filter(run => (
      /SET\s+owner_action_id = \?/.test(run.sql) && run.changes === 1
    ))).toHaveLength(1)
    expect(claimRuns.filter(run => (
      /SET\s+owner_action_id = \?/.test(run.sql) && run.changes > 1
    ))).toHaveLength(0)
    await expectLedgerCounts({ actions: 1, deliveries: 2, outboxes: 1, claims: 0 })
  })

  it.each(['browser', 'sensitive', 'hash'] as const)(
    '%s 异常稳定转为 invalid_sensitive_context，不阻断一方事实和 Pixel',
    async failurePoint => {
      const sensitiveRaw = `private-${failurePoint}@example.test|0123456789abcdef0123456789abcdef`
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const browser = vi.fn(async () => {
        if (failurePoint === 'browser') throw new Error(sensitiveRaw)
        return { fbp: 'fb.1.1700000000000.private-context' }
      })
      const sensitive = vi.fn(async () => {
        if (failurePoint === 'sensitive') throw new Error(sensitiveRaw)
        return {
          email: `private-${failurePoint}@example.test`,
          metaExternalId: '0123456789abcdef0123456789abcdef',
        }
      })
      if (failurePoint === 'hash') hashMocks.email.mockRejectedValueOnce(new Error(sensitiveRaw))

      const result = await recordRegistration(conversionEnv(realDb), registrationInput(), {
        getMetaCapiUserData: browser,
        getRegistrationSensitiveInput: sensitive,
      })
      const deliveries = await realDb.prepare(`
        SELECT channel, status, skip_reason, has_fbp, has_fbc, has_email,
          has_external_id, meta_connection_revision
        FROM analytics_conversion_deliveries
        ORDER BY channel
      `).all<Record<string, unknown>>()
      const daily = await realDb.prepare(`
        SELECT channel, status, skip_reason, delivery_count
        FROM analytics_conversion_delivery_daily
        ORDER BY channel
      `).all<Record<string, unknown>>()

      expect(result).toMatchObject({ created: true })
      expect(result.pixelEvents).toHaveLength(1)
      expect(deliveries.results).toEqual([
        {
          channel: 'meta_capi',
          status: 'skipped',
          skip_reason: 'invalid_sensitive_context',
          has_fbp: 0,
          has_fbc: 0,
          has_email: 0,
          has_external_id: 0,
          meta_connection_revision: CONNECTION_REVISION,
        },
        {
          channel: 'meta_pixel',
          status: 'pending',
          skip_reason: '',
          has_fbp: 0,
          has_fbc: 0,
          has_email: 0,
          has_external_id: 0,
          meta_connection_revision: CONNECTION_REVISION,
        },
      ])
      expect(daily.results).toEqual([
        { channel: 'meta_capi', status: 'skipped', skip_reason: 'invalid_sensitive_context', delivery_count: 1 },
        { channel: 'meta_pixel', status: 'pending', skip_reason: '', delivery_count: 1 },
      ])
      expect(await scalar('SELECT action_count AS value FROM analytics_conversion_daily')).toBe(1)
      expect(await scalar('SELECT count(*) AS value FROM meta_capi_secure_outbox')).toBe(0)
      expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_dedupe_claims')).toBe(0)
      expect(JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])).not.toContain(sensitiveRaw)
      consoleError.mockRestore()
      consoleWarn.mockRestore()
    },
  )

  it.each([
    ['rollout_excluded', false, 'visitor_rollout_d1'],
    ['circuit_open', true, 'visitor_circuit_d1'],
    ['missing_stable_id', false, '   '],
  ] as const)('%s 在真实 D1 中写入 rollout 快照与 daily，且不产生 outbox', async (
    reason,
    circuitOpen,
    visitorId,
  ) => {
    if (reason === 'rollout_excluded') {
      await realDb.prepare(`
        UPDATE site_settings SET value = '0'
        WHERE key = 'meta_capi_rollout_percentage'
      `).run()
    }
    if (circuitOpen) {
      await realDb.prepare(`
        INSERT INTO meta_capi_incidents (
          id, environment, status, severity, trigger_code, trigger_summary,
          target_rollout_percentage, effective_rollout_percentage, evidence,
          opened_at, last_observed_at
        ) VALUES (?, 'dev', 'open', 'critical', 'permission_denied', '权限错误',
          100, 0, '{}', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
      `).bind('incident_conversion_d1').run()
    }
    const provider = vi.fn(async () => ({ fbp: 'fb.1.must-not-read' }))

    await recordContact(conversionEnv(realDb), {
      visitorId,
      sessionId: `session_${reason}`,
      occurredAt: '2026-07-11T08:00:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: `target_${reason}`,
      metadata: {},
    }, { getMetaCapiUserData: provider })

    const delivery = await realDb.prepare(`
      SELECT status, skip_reason, rollout_target_percentage,
        rollout_effective_percentage, rollout_bucket
      FROM analytics_conversion_deliveries
      WHERE channel = 'meta_capi'
    `).first<Record<string, unknown>>()
    expect(delivery).toMatchObject({
      status: 'skipped',
      skip_reason: reason,
      rollout_target_percentage: reason === 'rollout_excluded' ? 0 : 100,
      rollout_effective_percentage: reason === 'circuit_open' ? 0 : (reason === 'rollout_excluded' ? 0 : 100),
      rollout_bucket: reason === 'missing_stable_id' ? null : expect.any(Number),
    })
    expect(provider).not.toHaveBeenCalled()
    expect(await scalar('SELECT count(*) AS value FROM meta_capi_secure_outbox')).toBe(0)
    expect(await scalar(`
      SELECT delivery_count AS value
      FROM analytics_conversion_delivery_daily
      WHERE channel = 'meta_capi' AND status = 'skipped' AND skip_reason = '${reason}'
    `)).toBe(1)
  })
})

function readMigration(name: string) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
}

async function applyMigration(name: string) {
  for (const statement of unstable_splitSqlQuery(readMigration(name))) {
    await realDb.prepare(statement).run()
  }
}

async function seedRuntime() {
  const fingerprint = await metaConnectionFingerprint(PIXEL_ID, META_TOKEN)
  await realDb.batch([
    realDb.prepare(`
      INSERT INTO users (id, email, password_hash, meta_external_id)
      VALUES (42, 'stored@example.test', 'hash', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    `),
    realDb.prepare(`
      INSERT INTO site_settings (key, value) VALUES
        ('facebook_pixel_id', ?),
        ('facebook_pixel_enabled', 'true'),
        ('meta_capi_enabled', 'true'),
        ('meta_tracking_mode', '"production"'),
        ('meta_capi_rollout_percentage', '100')
    `).bind(JSON.stringify(PIXEL_ID)),
    realDb.prepare(`
      INSERT INTO meta_connection_verifications (
        environment, pixel_id, token_fingerprint, graph_api_version,
        verified_event_name, verified_commit, dataset_quality_status,
        verified_at, invalidation_reason, revision
      ) VALUES (
        'dev', ?, ?, 'v25.0', 'CompleteRegistration', ?, 'not_checked',
        '2026-07-11T00:00:00.000Z', '', ?
      )
    `).bind(PIXEL_ID, fingerprint, RELEASE_COMMIT, CONNECTION_REVISION),
  ])
}

function registrationInput() {
  return {
    visitorId: 'visitor_registration_d1',
    sessionId: 'session_registration_d1',
    userId: 42,
    occurredAt: '2026-07-11T08:00:00.000Z',
    consentState: 'granted',
    metadata: { method: 'email' },
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function conversionEnv(
  db: D1Database,
  queueSend: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
) {
  return {
    APP_ENV: 'dev',
    DB: db,
    SESSION_SECRET: 'conversion-d1-session-secret',
    META_CAPI_QUEUE: { send: queueSend },
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_ACCESS_TOKEN: META_TOKEN,
    META_CAPI_TEST_EVENT_CODE: 'conversion-d1-test-code',
    RELEASE_COMMIT,
  } as unknown as Pick<Bindings,
    | 'APP_ENV'
    | 'DB'
    | 'SESSION_SECRET'
    | 'META_CAPI_QUEUE'
    | 'META_CAPI_DATA_KEY_CURRENT'
    | 'META_CAPI_DATA_KEY_PREVIOUS'
    | 'META_CAPI_ACCESS_TOKEN'
    | 'META_CAPI_TEST_EVENT_CODE'
    | 'RELEASE_COMMIT'
  >
}

function wrapDb(db: D1Database, options: {
  afterClaimInsert?: (changes: number) => Promise<void>
  beforeBatch?: () => Promise<void>
  claimRuns?: ClaimRun[]
  failSettingsRead?: boolean
  failBatch?: boolean
  claimLeaseModifier?: string
}): D1Database {
  let settingsFailurePending = options.failSettingsRead === true
  let batchFailurePending = options.failBatch === true

  function wrapStatement(inner: D1PreparedStatement, sql: string): WrappedStatement {
    const wrapped = {
      __inner: inner,
      bind(...values: unknown[]) {
        const boundValues = sql.includes('analytics_conversion_dedupe_claims') && options.claimLeaseModifier
          ? values.map(value => value === '+60 seconds' ? options.claimLeaseModifier : value)
          : values
        return wrapStatement(inner.bind(...boundValues), sql)
      },
      async first<T>(columnName?: string) {
        if (settingsFailurePending && sql.includes('FROM site_settings')) {
          settingsFailurePending = false
          throw new Error('CONVERSION_PLAN_BUILD_FAILED')
        }
        return inner.first<T>(columnName)
      },
      all: inner.all.bind(inner),
      raw: inner.raw.bind(inner),
      async run<T = unknown>() {
        const result = await inner.run<T>()
        const changes = result.meta?.changes ?? result.meta?.rows_written ?? 0
        if (sql.includes('analytics_conversion_dedupe_claims')) {
          options.claimRuns?.push({ sql, changes })
        }
        if (sql.includes('INSERT OR IGNORE INTO analytics_conversion_dedupe_claims')) {
          await options.afterClaimInsert?.(changes)
        }
        return result
      },
    }
    return wrapped as unknown as WrappedStatement
  }

  return {
    prepare(sql: string) {
      return wrapStatement(db.prepare(sql), sql)
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      await options.beforeBatch?.()
      if (batchFailurePending) {
        batchFailurePending = false
        return db.batch<T>([
          ...statements.map(statement => (statement as WrappedStatement).__inner),
          db.prepare('INSERT INTO conversion_batch_failure_missing_table (id) VALUES (1)'),
        ])
      }
      return db.batch<T>(statements.map(statement => (statement as WrappedStatement).__inner))
    },
  } as D1Database
}

async function scalar(sql: string) {
  const row = await realDb.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

async function readClaimSnapshot(dedupeDigest: string) {
  return realDb.prepare(`
    SELECT dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
    FROM analytics_conversion_dedupe_claims
    WHERE dedupe_digest = ?
  `).bind(dedupeDigest).first<Record<string, unknown>>()
}

async function pollUntilClaimExpired(dedupeDigest: string) {
  for (;;) {
    const row = await realDb.prepare(`
      SELECT expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS expired
      FROM analytics_conversion_dedupe_claims
      WHERE dedupe_digest = ?
    `).bind(dedupeDigest).first<{ expired: number }>()
    if (row?.expired === 1) return
    await Promise.resolve()
  }
}

async function expectLedgerCounts(expected: {
  actions: number
  deliveries: number
  outboxes: number
  claims: number
}) {
  expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_actions')).toBe(expected.actions)
  expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_deliveries')).toBe(expected.deliveries)
  expect(await scalar('SELECT count(*) AS value FROM meta_capi_secure_outbox')).toBe(expected.outboxes)
  expect(await scalar('SELECT count(*) AS value FROM analytics_conversion_dedupe_claims')).toBe(expected.claims)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}
