import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import {
  bootstrapMetaConnectionVerification,
  getMetaConnectionStatus,
  requireVerifiedMetaConnection,
} from './meta-connection'
import { META_GRAPH_API_VERSION } from './meta-graph'

const PIXEL_ID = '1234567890'
const REPLACEMENT_PIXEL_ID = '9988776655'
const TOKEN = 'meta-token-sensitive'
const ROTATED_TOKEN = 'rotated-meta-token-sensitive'
const TEST_EVENT_CODE = 'TEST25401'
const RELEASE_COMMIT = 'a'.repeat(40)
const DATA_KEY = Buffer.alloc(32, 7).toString('base64')
const INITIAL_REVISION = 'f'.repeat(32)

type VerificationRow = {
  environment: string
  pixel_id: string
  token_fingerprint: string
  graph_api_version: string
  verified_event_name: string
  verified_commit: string
  verified_by_user_id: number | null
  dataset_quality_status: string
  invalidated_at: string | null
  invalidation_reason: string
  revision: string | null
}

type ObservedRun = {
  sql: string
  params: unknown[]
  changes: number
}

let miniflare: Miniflare
let realDb: D1Database
let revisionSeed = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000038' },
    d1Persist: false,
  })
  realDb = (await miniflare.getBindings<{ DB: D1Database }>()).DB

  const bootstrapSchema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE analytics_conversion_deliveries (id TEXT PRIMARY KEY);
    CREATE TABLE ad_platform_connections (
      provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, mode TEXT NOT NULL,
      browser_enabled INTEGER NOT NULL, server_enabled INTEGER NOT NULL,
      destination_id TEXT NOT NULL, debug_enabled INTEGER NOT NULL,
      rollout_percentage INTEGER NOT NULL, credential_secret_name TEXT NOT NULL,
      revision TEXT, created_at TEXT, updated_at TEXT
    );
  `
  for (const statement of unstable_splitSqlQuery(bootstrapSchema)) {
    await realDb.prepare(statement).run()
  }
  await applyMigration('0036_meta_capi_v2_secure_delivery.sql')
  await applyMigration('0037_meta_connection_revision.sql')
}, 30_000)

beforeEach(async () => {
  revisionSeed = 0
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    array.fill(++revisionSeed)
    return array
  }) as Crypto['getRandomValues'])

  await realDb.exec(`
    DELETE FROM meta_connection_verifications;
    DELETE FROM site_settings;
    DELETE FROM users;
    INSERT INTO users (id) VALUES (41), (42);
  `)
  await setConnectionSettings(PIXEL_ID)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('MetaConnection 真实 D1 CAS', () => {
  it('verification 不存在时后返回的 bootstrap 以 changes=0 fail closed', async () => {
    const graph = installDeferredGraph(2)
    const olderDb = observeRuns(realDb)
    const newerDb = observeRuns(realDb)

    const older = bootstrapMetaConnectionVerification(connectionEnv(olderDb.db), 41, 'Contact', TEST_EVENT_CODE)
    await graph.requests[0]!.entered.promise
    const newer = bootstrapMetaConnectionVerification(connectionEnv(newerDb.db), 42, 'CompleteRegistration', TEST_EVENT_CODE)
    await graph.requests[1]!.entered.promise

    graph.requests[1]!.response.resolve(successfulMetaResponse())
    await expect(newer).resolves.toMatchObject({ connection: { state: 'verified' } })
    const winner = await readVerification()

    graph.requests[0]!.response.resolve(successfulMetaResponse())
    await expect(older).rejects.toMatchObject({ code: 'META_CONNECTION_VERIFICATION_WRITE_FAILED' })

    expect(graph.fetchMock).toHaveBeenCalledTimes(2)
    expect(newerDb.runs).toEqual([
      expect.objectContaining({ changes: 1 }),
      expect.objectContaining({ changes: 1 }),
    ])
    expect(olderDb.runs).toEqual([expect.objectContaining({ changes: 0 })])
    await expectWinnerToRemainValid(winner, {
      pixelId: PIXEL_ID,
      eventName: 'CompleteRegistration',
      ownerUserId: 42,
    })
  })

  it('历史 revision IS NULL 行并发重新验证时仅一个真实 UPDATE 成功', async () => {
    await seedVerification({ revision: null })
    const graph = installDeferredGraph(2)
    const olderDb = observeRuns(realDb)
    const newerDb = observeRuns(realDb)

    const older = bootstrapMetaConnectionVerification(connectionEnv(olderDb.db), 41, 'Contact', TEST_EVENT_CODE)
    await graph.requests[0]!.entered.promise
    const newer = bootstrapMetaConnectionVerification(connectionEnv(newerDb.db), 42, 'CompleteRegistration', TEST_EVENT_CODE)
    await graph.requests[1]!.entered.promise

    graph.requests[1]!.response.resolve(successfulMetaResponse())
    await newer
    const winner = await readVerification()
    graph.requests[0]!.response.resolve(successfulMetaResponse())

    await expect(older).rejects.toMatchObject({ code: 'META_CONNECTION_VERIFICATION_WRITE_FAILED' })
    expect(graph.fetchMock).toHaveBeenCalledTimes(2)
    expect(newerDb.runs).toEqual([
      expect.objectContaining({ changes: 1 }),
      expect.objectContaining({ changes: 1 }),
    ])
    expect(olderDb.runs).toEqual([expect.objectContaining({ changes: 0 })])
    await expectWinnerToRemainValid(winner, {
      pixelId: PIXEL_ID,
      eventName: 'CompleteRegistration',
      ownerUserId: 42,
    })
  })

  it('token 变化并轮换 revision 时陈旧请求不能覆盖胜者', async () => {
    await seedVerification({ revision: INITIAL_REVISION })
    const graph = installDeferredGraph(2)
    const olderDb = observeRuns(realDb)
    const newerDb = observeRuns(realDb)

    const older = bootstrapMetaConnectionVerification(connectionEnv(olderDb.db), 41, 'Contact', TEST_EVENT_CODE)
    await graph.requests[0]!.entered.promise
    const newer = bootstrapMetaConnectionVerification(
      connectionEnv(newerDb.db, ROTATED_TOKEN),
      42,
      'CompleteRegistration',
      TEST_EVENT_CODE,
    )
    await graph.requests[1]!.entered.promise

    graph.requests[1]!.response.resolve(successfulMetaResponse())
    await newer
    const winner = await readVerification()
    graph.requests[0]!.response.resolve(successfulMetaResponse())

    await expect(older).rejects.toMatchObject({ code: 'META_CONNECTION_VERIFICATION_WRITE_FAILED' })
    expect(graph.fetchMock).toHaveBeenCalledTimes(2)
    expect(newerDb.runs).toEqual([
      expect.objectContaining({ changes: 1 }),
      expect.objectContaining({ changes: 1 }),
    ])
    expect(olderDb.runs).toEqual([expect.objectContaining({ changes: 0 })])
    expect(winner.revision).not.toBe(INITIAL_REVISION)
    await expectWinnerToRemainValid(winner, {
      pixelId: PIXEL_ID,
      eventName: 'CompleteRegistration',
      ownerUserId: 42,
      token: ROTATED_TOKEN,
    })
  })

  it('stale invalidation 的真实 UPDATE 不得失效交错完成的新 revision', async () => {
    await seedVerification({ revision: INITIAL_REVISION })
    await setConnectionSettings(REPLACEMENT_PIXEL_ID)

    const invalidationEntered = deferred<void>()
    const releaseInvalidation = deferred<void>()
    const staleDb = observeRuns(realDb, async ({ sql }) => {
      if (sql.includes('SET invalidated_at')) {
        invalidationEntered.resolve()
        await releaseInvalidation.promise
      }
    })
    const staleStatus = getMetaConnectionStatus(connectionEnv(staleDb.db))
    await invalidationEntered.promise

    const graph = installDeferredGraph(1)
    const bootstrapDb = observeRuns(realDb)
    const replacement = bootstrapMetaConnectionVerification(
      connectionEnv(bootstrapDb.db),
      42,
      'CompleteRegistration',
      TEST_EVENT_CODE,
    )
    await graph.requests[0]!.entered.promise
    graph.requests[0]!.response.resolve(successfulMetaResponse())
    await replacement
    const winner = await readVerification()

    releaseInvalidation.resolve()
    await expect(staleStatus).resolves.toMatchObject({
      state: 'configuration_changed',
      invalidationReason: 'pixel_id_changed',
    })

    expect(graph.fetchMock).toHaveBeenCalledOnce()
    expect(bootstrapDb.runs).toEqual([
      expect.objectContaining({ changes: 1 }),
      expect.objectContaining({ changes: 1 }),
    ])
    expect(staleDb.runs).toEqual([expect.objectContaining({ changes: 0 })])
    await expectWinnerToRemainValid(winner, {
      pixelId: REPLACEMENT_PIXEL_ID,
      eventName: 'CompleteRegistration',
      ownerUserId: 42,
    })
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

function connectionEnv(db: D1Database, token = TOKEN): Bindings {
  return {
    APP_ENV: 'dev',
    DB: db,
    META_CAPI_ACCESS_TOKEN: token,
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_QUEUE: { send: vi.fn() },
    RELEASE_COMMIT,
  } as unknown as Bindings
}

async function setConnectionSettings(pixelId: string) {
  await realDb.prepare(`
    INSERT INTO ad_platform_connections
      (provider, enabled, mode, browser_enabled, server_enabled, destination_id,
       debug_enabled, rollout_percentage, credential_secret_name, revision)
    VALUES ('meta', 1, 'test', 1, 1, ?, 0, 100, 'META_CAPI_ACCESS_TOKEN', NULL)
    ON CONFLICT(provider) DO UPDATE SET destination_id = excluded.destination_id, mode = excluded.mode
  `).bind(pixelId).run()
}

async function seedVerification({ revision }: { revision: string | null }) {
  const fingerprint = await metaConnectionFingerprint(PIXEL_ID, TOKEN)
  await realDb.prepare(`
    INSERT INTO meta_connection_verifications (
      environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, verified_at, verified_by_user_id,
      dataset_quality_status, invalidated_at, invalidation_reason, revision
    ) VALUES (
      'dev', ?, ?, ?, 'Contact', ?, datetime('now'), 41,
      'not_checked', NULL, '', ?
    )
  `).bind(PIXEL_ID, fingerprint, META_GRAPH_API_VERSION, RELEASE_COMMIT, revision).run()
}

async function readVerification() {
  const row = await realDb.prepare(`
    SELECT environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, verified_by_user_id,
      dataset_quality_status, invalidated_at, invalidation_reason, revision
    FROM meta_connection_verifications
    WHERE environment = 'dev'
  `).first<VerificationRow>()
  expect(row).not.toBeNull()
  return row!
}

async function expectWinnerToRemainValid(
  winner: VerificationRow,
  expected: { pixelId: string; eventName: string; ownerUserId: number; token?: string },
) {
  const finalRow = await readVerification()
  const token = expected.token ?? TOKEN
  const fingerprint = await metaConnectionFingerprint(expected.pixelId, token)

  expect(finalRow).toEqual(winner)
  expect(finalRow).toMatchObject({
    environment: 'dev',
    pixel_id: expected.pixelId,
    token_fingerprint: fingerprint,
    graph_api_version: META_GRAPH_API_VERSION,
    verified_event_name: expected.eventName,
    verified_commit: RELEASE_COMMIT,
    verified_by_user_id: expected.ownerUserId,
    dataset_quality_status: 'not_checked',
    invalidated_at: null,
    invalidation_reason: '',
    revision: expect.stringMatching(/^[0-9a-f]{32}$/),
  })
  await expect(requireVerifiedMetaConnection(connectionEnv(realDb, token))).resolves.toEqual({
    pixelId: expected.pixelId,
    trackingMode: 'test',
    revision: finalRow.revision,
  })
  await expect(getMetaConnectionStatus(connectionEnv(realDb, token))).resolves.toMatchObject({
    state: 'verified',
    invalidationReason: '',
  })
}

function observeRuns(
  db: D1Database,
  beforeRun?: (call: { sql: string; params: unknown[] }) => Promise<void>,
) {
  const runs: ObservedRun[] = []

  function wrapStatement(statement: D1PreparedStatement, sql: string, params: unknown[]): D1PreparedStatement {
    return {
      bind(...values: unknown[]) {
        return wrapStatement(statement.bind(...values), sql, values)
      },
      first: statement.first.bind(statement),
      all: statement.all.bind(statement),
      raw: statement.raw.bind(statement),
      async run<T = unknown>() {
        await beforeRun?.({ sql, params })
        const result = await statement.run<T>()
        runs.push({
          sql,
          params,
          changes: result.meta?.changes ?? result.meta?.rows_written ?? 0,
        })
        return result
      },
    } as D1PreparedStatement
  }

  return {
    runs,
    db: {
      prepare(sql: string) {
        return wrapStatement(db.prepare(sql), sql, [])
      },
    } as D1Database,
  }
}

function installDeferredGraph(count: number) {
  const requests = Array.from({ length: count }, () => ({
    entered: deferred<void>(),
    response: deferred<Response>(),
  }))
  let index = 0
  const fetchMock = vi.fn(() => {
    const request = requests[index++]
    if (!request) throw new Error('收到非预期 Graph 请求')
    request.entered.resolve()
    return request.response.promise
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, requests }
}

function successfulMetaResponse() {
  return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
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
