import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../index'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import { META_GRAPH_API_VERSION } from './meta-graph'
import {
  createProductionPostDeployMetaResourcesSummary,
  META_RESOURCES_ISOLATION_FIELDS,
} from '../../../../scripts/meta-resources-summary-fixture.mjs'
import {
  MetaConnectionError,
  getMetaConnectionStatus,
  requireVerifiedMetaConnection,
  verifyMetaConnection,
} from './meta-connection'

const PIXEL_ID = '1234567890'
const TOKEN = 'meta-token-sensitive'
const TEST_EVENT_CODE = 'meta-test-code-sensitive'
const RELEASE_COMMIT = 'a'.repeat(40)
const DATA_KEY = Buffer.alloc(32, 7).toString('base64')

type VerificationRow = {
  environment: 'dev' | 'production'
  pixel_id: string
  token_fingerprint: string
  graph_api_version: string
  verified_event_name: string
  verified_commit: string
  dataset_quality_status: string
  verified_at: string
  verified_by_user_id: number
  invalidated_at: string | null
  invalidation_reason: string
  revision: string | null
}

type DbCall = { sql: string; params: unknown[] }

function createConnectionDb(options: {
  pixelId?: string
  trackingMode?: 'disabled' | 'test' | 'production'
  beforeInvalidation?: (verifications: Map<string, VerificationRow>) => void
  productionBootstrapEvidence?: Record<string, unknown> | null
  productionRollout?: number
  productionIncidentCount?: number
} = {}) {
  const settings = new Map<string, string>([
    ['destination_id', JSON.stringify(options.pixelId ?? PIXEL_ID)],
    ['mode', JSON.stringify(options.trackingMode ?? 'test')],
    ['rollout_percentage', String(options.productionRollout ?? 0)],
  ])
  const verifications = new Map<string, VerificationRow>()
  const calls: DbCall[] = []
  const preparedSql: string[] = []
  let invalidationHookCalled = false

  const db = {
    calls,
    preparedSql,
    settings,
    verifications,
    prepare(sql: string) {
      preparedSql.push(sql)
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_release_verifications')) {
            return (options.productionBootstrapEvidence === null || options.productionBootstrapEvidence === undefined
              ? null
              : {
                  id: 'rvf_production_meta_resources',
                  summary: JSON.stringify(options.productionBootstrapEvidence),
                }) as T | null
          }
          if (sql.includes('FROM meta_capi_incidents')) return { incident_count: options.productionIncidentCount ?? 0 } as T
          if (sql.includes('FROM ad_platform_connections')) {
            if (sql.includes('SELECT rollout_percentage')) {
              return { rollout_percentage: Number(settings.get('rollout_percentage') ?? 0) } as T
            }
            return {
              provider: 'meta', enabled: 1, mode: JSON.parse(settings.get('mode') ?? '"disabled"'),
              browser_enabled: 1, server_enabled: 1,
              destination_id: JSON.parse(settings.get('destination_id') ?? '""'),
              debug_enabled: 0, rollout_percentage: Number(settings.get('rollout_percentage') ?? 0),
              credential_secret_name: 'META_CAPI_ACCESS_TOKEN', revision: null,
            } as T
          }
          if (sql.includes('FROM site_settings')) {
            const literalKey = sql.match(/key\s*=\s*'([^']+)'/)?.[1]
            const key = literalKey || String(call.params[0] ?? '')
            const value = settings.get(key)
            return value === undefined ? null : ({ value } as T)
          }
          if (sql.includes('FROM meta_connection_verifications')) {
            const row = verifications.get(String(call.params[0] ?? ''))
            return (row ? { ...row } : null) as T | null
          }
          return null
        },
        async all<T>() {
          calls.push(call)
          if (sql.includes('FROM site_settings')) {
            return {
              results: Array.from(settings, ([key, value]) => ({ key, value })) as T[],
            }
          }
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          let changes = 1
          if (sql.includes('INSERT INTO meta_connection_verifications')) {
            const environment = String(call.params[0]) as VerificationRow['environment']
            if (sql.includes('WHERE NOT EXISTS') && verifications.has(environment)) {
              changes = 0
            } else {
              const hasRevision = call.params.length >= 8
              verifications.set(environment, {
                environment,
                pixel_id: String(call.params[1]),
                token_fingerprint: String(call.params[2]),
                graph_api_version: String(call.params[3]),
                verified_event_name: String(call.params[4]),
                verified_commit: String(call.params[5]),
                dataset_quality_status: 'not_checked',
                verified_at: '2026-07-11T00:00:00.000Z',
                verified_by_user_id: Number(call.params[hasRevision ? 7 : 6]),
                invalidated_at: null,
                invalidation_reason: '',
                revision: hasRevision ? String(call.params[6]) : null,
              })
            }
          }
          if (sql.includes('UPDATE meta_connection_verifications') && sql.includes('SET pixel_id')) {
            const environment = String(call.params[7] ?? '')
            const expectedRevision = call.params[8] == null ? null : String(call.params[8])
            const row = verifications.get(environment)
            if (!row || row.revision !== expectedRevision) {
              changes = 0
            } else {
              Object.assign(row, {
                pixel_id: String(call.params[0]),
                token_fingerprint: String(call.params[1]),
                graph_api_version: String(call.params[2]),
                verified_event_name: String(call.params[3]),
                verified_commit: String(call.params[4]),
                revision: String(call.params[5]),
                verified_by_user_id: Number(call.params[6]),
                invalidated_at: null,
                invalidation_reason: '',
              })
            }
          }
          if (sql.includes('UPDATE meta_connection_verifications')
            && sql.includes('invalidated_at')
            && !sql.includes('SET pixel_id')) {
            if (!invalidationHookCalled) {
              invalidationHookCalled = true
              options.beforeInvalidation?.(verifications)
            }
            const reason = String(call.params[0] ?? '')
            const environment = String(call.params[1] ?? '')
            const row = verifications.get(environment)
            const expectedRevision = call.params.length >= 3 ? call.params[2] : row?.revision
            if (row && row.invalidated_at === null && row.revision === expectedRevision) {
              row.invalidated_at = '2026-07-11T00:00:00.000Z'
              row.invalidation_reason = reason
            } else {
              changes = 0
            }
          }
          if (sql.includes('UPDATE ad_platform_connections')) {
            settings.set('revision', String(call.params[0] ?? ''))
          }
          return { meta: { changes, rows_written: changes, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

function connectionEnv(
  db: ReturnType<typeof createConnectionDb>,
  overrides: Partial<Bindings> = {},
) {
  return {
    APP_ENV: 'dev',
    DB: db,
    META_CAPI_ACCESS_TOKEN: TOKEN,
    META_CAPI_TEST_EVENT_CODE: TEST_EVENT_CODE,
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_QUEUE: { send: vi.fn() },
    RELEASE_COMMIT,
    ...overrides,
  } as unknown as Bindings
}

async function seedVerification(
  db: ReturnType<typeof createConnectionDb>,
  input: Partial<VerificationRow> & { environment?: 'dev' | 'production' } = {},
  token = TOKEN,
) {
  const environment = input.environment ?? 'dev'
  const pixelId = input.pixel_id ?? PIXEL_ID
  db.verifications.set(environment, {
    environment,
    pixel_id: pixelId,
    token_fingerprint: input.token_fingerprint ?? await metaConnectionFingerprint(pixelId, token),
    graph_api_version: input.graph_api_version ?? META_GRAPH_API_VERSION,
    verified_event_name: input.verified_event_name ?? 'Contact',
    verified_commit: input.verified_commit ?? RELEASE_COMMIT,
    dataset_quality_status: input.dataset_quality_status ?? 'not_checked',
    verified_at: input.verified_at ?? '2026-07-11T00:00:00.000Z',
    verified_by_user_id: input.verified_by_user_id ?? 1,
    invalidated_at: input.invalidated_at ?? null,
    invalidation_reason: input.invalidation_reason ?? '',
    revision: input.revision === undefined ? '1'.repeat(32) : input.revision,
  })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((complete) => { resolve = complete })
  return { promise, resolve }
}

function successfulMetaResponse() {
  return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('MetaConnection', () => {
  it.each([
    ['Pixel ID', { pixelId: '' }, {}],
    ['access token', {}, { META_CAPI_ACCESS_TOKEN: '  ' }],
  ])('%s 缺失时为 not_configured', async (_label, dbOptions, envOverrides) => {
    const db = createConnectionDb(dbOptions as Parameters<typeof createConnectionDb>[0])
    const status = await getMetaConnectionStatus(connectionEnv(db, envOverrides as Partial<Bindings>))

    expect(status.state).toBe('not_configured')
    expect(status.verifiedAt).toBeNull()
  })

  it('配置完整但没有验证行为时为 unverified', async () => {
    const status = await getMetaConnectionStatus(connectionEnv(createConnectionDb()))

    expect(status).toMatchObject({
      state: 'unverified',
      environment: 'dev',
      pixelIdConfigured: true,
      tokenConfigured: true,
      testEventCodeConfigured: true,
      graphApiVersion: 'v25.0',
      invalidationReason: 'verification_missing',
    })
  })

  it('dev bootstrap 仅在 Meta 确认接收 1 条合成 Test Event 后写 verified', async () => {
    const db = createConnectionDb()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      events_received: 1,
      fbtrace_id: 'must-not-leave-service',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const status = await verifyMetaConnection(connectionEnv(db), 42, 'Contact')

    expect(status).toMatchObject({
      state: 'verified',
      environment: 'dev',
      verifiedCommit: RELEASE_COMMIT,
      graphApiVersion: 'v25.0',
    })
    expect(db.verifications.get('dev')).toMatchObject({
      pixel_id: PIXEL_ID,
      graph_api_version: 'v25.0',
      verified_event_name: 'Contact',
      verified_commit: RELEASE_COMMIT,
      verified_by_user_id: 42,
      revision: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_actions'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
    const serializedD1Calls = JSON.stringify(db.calls)
    expect(serializedD1Calls).not.toContain(TOKEN)
    expect(serializedD1Calls).not.toContain(TEST_EVENT_CODE)
    expect(serializedD1Calls).not.toContain(DATA_KEY)
    expect(serializedD1Calls).not.toContain('must-not-leave-service')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/v25.0/1234567890/events')
    expect(new URL(String(url)).search).toBe('')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    const payload = JSON.parse(String(init?.body))
    expect(payload.test_event_code).toBe(TEST_EVENT_CODE)
    expect(payload.data[0].user_data).toEqual({
      client_ip_address: '192.0.2.1',
      client_user_agent: 'MeiGallery MetaConnection Synthetic Test/1.0',
    })
    expect(payload.data[0].event_id).toMatch(/^meta_verify_[0-9a-f]{32}$/)
    expect(payload.data[0].user_data).not.toHaveProperty('fbp')
    expect(payload.data[0].user_data).not.toHaveProperty('fbc')
    expect(payload.data[0].user_data).not.toHaveProperty('em')
    expect(payload.data[0].user_data).not.toHaveProperty('external_id')
  })

  it('Graph 期间 Pixel 或 tracking mode 变化时不写 verification', async () => {
    for (const mutate of [
      (db: ReturnType<typeof createConnectionDb>) => db.settings.set('destination_id', JSON.stringify('9988776655')),
      (db: ReturnType<typeof createConnectionDb>) => db.settings.set('mode', JSON.stringify('production')),
    ]) {
      const db = createConnectionDb()
      const pending = deferredResponse()
      vi.stubGlobal('fetch', vi.fn(() => pending.promise))

      const verification = verifyMetaConnection(connectionEnv(db), 42, 'Contact')
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      mutate(db)
      pending.resolve(successfulMetaResponse())

      await expect(verification).rejects.toMatchObject({ code: 'META_CONNECTION_CONFIGURATION_CHANGED' })
      expect(db.verifications.size).toBe(0)
      vi.unstubAllGlobals()
    }
  })

  it('后发 bootstrap 先完成时，旧 bootstrap 的 CAS 不能覆盖新 revision', async () => {
    const db = createConnectionDb()
    await seedVerification(db)
    const first = deferredResponse()
    const second = deferredResponse()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    vi.stubGlobal('fetch', fetchMock)

    const older = verifyMetaConnection(connectionEnv(db), 41, 'Contact')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const newer = verifyMetaConnection(connectionEnv(db), 42, 'CompleteRegistration')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    second.resolve(successfulMetaResponse())
    await expect(newer).resolves.toMatchObject({ state: 'verified' })
    const newerRevision = db.verifications.get('dev')?.revision
    expect(newerRevision).toMatch(/^[0-9a-f]{32}$/)

    first.resolve(successfulMetaResponse())
    await expect(older).rejects.toMatchObject({ code: 'META_CONNECTION_VERIFICATION_WRITE_FAILED' })
    expect(db.verifications.get('dev')).toMatchObject({
      revision: newerRevision,
      verified_event_name: 'CompleteRegistration',
      verified_by_user_id: 42,
    })
  })

  it.each([
    ['pixel_id_changed', async (db: ReturnType<typeof createConnectionDb>) => db.settings.set('destination_id', JSON.stringify('9988776655'))],
    ['access_token_changed', async (_db: ReturnType<typeof createConnectionDb>, env: Bindings) => { env.META_CAPI_ACCESS_TOKEN = 'rotated-token' }],
    ['graph_api_version_changed', async (db: ReturnType<typeof createConnectionDb>) => { db.verifications.get('dev')!.graph_api_version = 'v24.0' }],
  ])('%s 时立即 configuration_changed', async (reason, mutate) => {
    const db = createConnectionDb()
    await seedVerification(db)
    const env = connectionEnv(db)
    await mutate(db, env)

    const status = await getMetaConnectionStatus(env)

    expect(status).toMatchObject({ state: 'configuration_changed', invalidationReason: reason })
    expect(db.verifications.get('dev')).toMatchObject({ invalidation_reason: reason })
    await expect(requireVerifiedMetaConnection(env)).rejects.toMatchObject({ code: 'META_CONNECTION_UNVERIFIED' })
  })

  it('发布 commit 变化时保持当前 Meta 连接有效', async () => {
    const db = createConnectionDb()
    await seedVerification(db)
    const env = connectionEnv(db)
    env.RELEASE_COMMIT = 'b'.repeat(40)

    await expect(getMetaConnectionStatus(env)).resolves.toMatchObject({ state: 'verified', invalidationReason: '' })
    await expect(requireVerifiedMetaConnection(env)).resolves.toMatchObject({ pixelId: PIXEL_ID })
  })

  it('兼容恢复历史 release_commit_changed，不恢复其他失效原因', async () => {
    const db = createConnectionDb()
    await seedVerification(db)
    const row = db.verifications.get('dev')!
    row.invalidated_at = '2026-07-13T00:00:00.000Z'
    row.invalidation_reason = 'release_commit_changed'

    await expect(getMetaConnectionStatus(connectionEnv(db))).resolves.toMatchObject({
      state: 'verified',
      invalidationReason: '',
    })

    row.invalidation_reason = 'access_token_changed'
    await expect(getMetaConnectionStatus(connectionEnv(db))).resolves.toMatchObject({
      state: 'configuration_changed',
      invalidationReason: 'access_token_changed',
    })
  })

  it.each(['pixel_id_changed', 'access_token_changed'] as const)(
    '%s 在 require 阶段尝试打开 fingerprint critical，incident 失败也保留原连接错误',
    async (reason) => {
      const db = createConnectionDb()
      await seedVerification(db)
      const env = connectionEnv(db)
      if (reason === 'pixel_id_changed') db.settings.set('destination_id', JSON.stringify('9988776655'))
      else env.META_CAPI_ACCESS_TOKEN = 'rotated-token'

      await expect(requireVerifiedMetaConnection(env)).rejects.toMatchObject({
        code: 'META_CONNECTION_UNVERIFIED',
      })
      expect(db.preparedSql.some(sql => sql.includes('INSERT OR IGNORE INTO meta_capi_incidents'))).toBe(true)
    },
  )

  it('Test Event Code 变化不改变 fingerprint，但 test mode 仍要求非空', async () => {
    const db = createConnectionDb()
    await seedVerification(db)

    const changed = await getMetaConnectionStatus(connectionEnv(db, {
      META_CAPI_TEST_EVENT_CODE: 'another-test-code',
    }))
    const missing = await getMetaConnectionStatus(connectionEnv(db, {
      META_CAPI_TEST_EVENT_CODE: '  ',
    }))

    expect(changed.state).toBe('verified')
    expect(missing).toMatchObject({
      state: 'not_configured',
      testEventCodeConfigured: false,
      invalidationReason: 'test_event_code_missing',
    })
  })

  it('历史空 revision 保持可读取但必须重新验证后才能投递', async () => {
    const db = createConnectionDb()
    await seedVerification(db, { revision: null })

    const status = await getMetaConnectionStatus(connectionEnv(db))

    expect(status).toMatchObject({
      state: 'configuration_changed',
      invalidationReason: 'verification_revision_missing',
    })
    await expect(requireVerifiedMetaConnection(connectionEnv(db)))
      .rejects.toMatchObject({ code: 'META_CONNECTION_UNVERIFIED' })
  })

  it('旧状态读取不能失效随后完成的新 verification revision', async () => {
    const replacementRevision = '2'.repeat(32)
    const replacementPixelId = '9988776655'
    const replacementFingerprint = await metaConnectionFingerprint(replacementPixelId, TOKEN)
    const db = createConnectionDb({
      beforeInvalidation(verifications) {
        const row = verifications.get('dev')!
        verifications.set('dev', {
          ...row,
          pixel_id: replacementPixelId,
          token_fingerprint: replacementFingerprint,
          revision: replacementRevision,
          invalidated_at: null,
          invalidation_reason: '',
        })
      },
    })
    await seedVerification(db)
    db.settings.set('destination_id', JSON.stringify(replacementPixelId))

    const status = await getMetaConnectionStatus(connectionEnv(db))

    expect(status).toMatchObject({ state: 'configuration_changed', invalidationReason: 'pixel_id_changed' })
    expect(db.verifications.get('dev')).toMatchObject({
      revision: replacementRevision,
      invalidated_at: null,
      invalidation_reason: '',
    })
  })

  it.each([undefined, '', 'short-commit', 'g'.repeat(40)])('非法 RELEASE_COMMIT=%s 时不 fetch、不写 verified', async releaseCommit => {
    const db = createConnectionDb()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, { RELEASE_COMMIT: releaseCommit }), 1, 'Contact'))
      .rejects.toMatchObject({ code: 'META_RELEASE_COMMIT_INVALID' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.verifications.size).toBe(0)
  })

  it.each([
    ['Queue binding', { META_CAPI_QUEUE: undefined }],
    ['data key', { META_CAPI_DATA_KEY_CURRENT: undefined }],
    ['非 canonical data key', { META_CAPI_DATA_KEY_CURRENT: `${DATA_KEY}\n` }],
    ['31-byte data key', { META_CAPI_DATA_KEY_CURRENT: Buffer.alloc(31, 7).toString('base64') }],
  ])('dev bootstrap 缺少或非法 %s 时不调用 Graph', async (_label, overrides) => {
    const db = createConnectionDb()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, overrides as Partial<Bindings>), 1, 'Contact'))
      .rejects.toBeInstanceOf(MetaConnectionError)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.verifications.size).toBe(0)
  })

  it('production bootstrap 缺少发布资源证据时 409，且不 fetch、不写 verification', async () => {
    const db = createConnectionDb({ trackingMode: 'test' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, { APP_ENV: 'production' }), 1, 'Contact'))
      .rejects.toMatchObject({ code: 'META_PRODUCTION_TEST_GATE_BLOCKED', httpStatus: 409 })

    expect(db.calls.some(call => call.sql.includes('INSERT INTO meta_connection_verifications'))).toBe(false)
    expect(db.verifications.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('production Test Event 只信当前 commit 未过期的完整 post-deploy V2 摘要，且绝不查询 production D1 的 dev row', async () => {
    const db = createConnectionDb({
      trackingMode: 'test',
      productionBootstrapEvidence: createProductionPostDeployMetaResourcesSummary(),
    })
    const fetchMock = vi.fn(async () => successfulMetaResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, { APP_ENV: 'production' }), 1, 'Contact'))
      .resolves.toMatchObject({ state: 'verified', environment: 'production' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.calls.some(call => call.sql.includes("environment = 'dev'"))).toBe(false)
  })

  it.each(['disabled', 'production'] as const)('production bootstrap 在 trackingMode=%s 时于 fetch 前阻断', async trackingMode => {
    const db = createConnectionDb({
      trackingMode,
      productionBootstrapEvidence: createProductionPostDeployMetaResourcesSummary(),
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, { APP_ENV: 'production' }), 1, 'Contact'))
      .rejects.toMatchObject({ code: 'META_PRODUCTION_TEST_GATE_BLOCKED', httpStatus: 409 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('production Test Event 对所有 post-deploy 资源、rollout 与 incident 门禁都在 fetch 前失败', async () => {
    const complete = createProductionPostDeployMetaResourcesSummary()
    const requiredReadyFields = [
      'liveAttestation', 'migrationsReady', 'd1Ready', 'r2Ready', 'queuesReady', 'secretsReady',
      'migrationsCurrent', 'migrationsApplied', 'noOpenCriticalIncident', 'initialRolloutZero',
      'secureOutboxReady', 'previousKeyReferencesExplainable', 'rolloutZero',
    ] as const
    const requiredFalseFields = ['bootstrapReady', 'connectionVerified', 'capiEnabled', 'initialMetaRollout'] as const
    const cases = [
      ...requiredReadyFields.map(field => ({ productionBootstrapEvidence: { ...complete, [field]: false } })),
      ...requiredFalseFields.map(field => ({ productionBootstrapEvidence: { ...complete, [field]: true } })),
      ...META_RESOURCES_ISOLATION_FIELDS.map(field => ({
        productionBootstrapEvidence: {
          ...complete,
          environmentIsolation: { ...complete.environmentIsolation, [field]: false },
        },
      })),
      { productionBootstrapEvidence: complete, productionRollout: 10 },
      { productionBootstrapEvidence: complete, productionIncidentCount: 1 },
    ]

    for (const options of cases) {
      const db = createConnectionDb({ trackingMode: 'test', ...options })
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(verifyMetaConnection(connectionEnv(db, { APP_ENV: 'production' }), 1, 'Contact'))
        .rejects.toMatchObject({ code: 'META_PRODUCTION_TEST_GATE_BLOCKED', httpStatus: 409 })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(db.verifications.size).toBe(0)
    }
  })

  it.each([
    createProductionPostDeployMetaResourcesSummary({ schemaVersion: 1 }),
    createProductionPostDeployMetaResourcesSummary({ verificationPhase: 'bootstrap' }),
    createProductionPostDeployMetaResourcesSummary({ verificationPhase: 'full' }),
    { ...createProductionPostDeployMetaResourcesSummary(), raw: 'must-reject' },
    { liveAttestation: true, environmentIsolation: { d1: true } },
  ])('production Test Event 拒绝旧格式、非 post-deploy phase 与额外 raw 字段', async productionBootstrapEvidence => {
    const db = createConnectionDb({ trackingMode: 'test', productionBootstrapEvidence })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, { APP_ENV: 'production' }), 1, 'Contact'))
      .rejects.toMatchObject({ code: 'META_PRODUCTION_TEST_GATE_BLOCKED', httpStatus: 409 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.verifications.size).toBe(0)
  })

  it('未知环境绝不复用 dev verification', async () => {
    const db = createConnectionDb()
    await seedVerification(db)

    await expect(requireVerifiedMetaConnection(connectionEnv(db, { APP_ENV: 'preview' })))
      .rejects.toMatchObject({ code: 'META_CONNECTION_ENV_INVALID' })
    expect(db.calls.filter(call => call.sql.includes('meta_connection_verifications'))).toEqual([])
  })

  it('dev 与 production 精确读取各自 verification row', async () => {
    const db = createConnectionDb({ trackingMode: 'production' })
    await seedVerification(db, { environment: 'dev' }, TOKEN)
    await seedVerification(db, { environment: 'production' }, 'production-token')

    const dev = await getMetaConnectionStatus(connectionEnv(db, { APP_ENV: 'dev' }))
    const production = await getMetaConnectionStatus(connectionEnv(db, {
      APP_ENV: 'production',
      META_CAPI_ACCESS_TOKEN: 'production-token',
    }))

    expect(dev.environment).toBe('dev')
    expect(production).toMatchObject({ environment: 'production', state: 'verified' })
    expect(db.calls.filter(call => call.sql.includes('meta_connection_verifications')).map(call => call.params[0]))
      .toEqual(['dev', 'production'])
  })

  it('状态与错误对象不泄漏 token、fingerprint、Test Event Code、data key 或 Graph trace', async () => {
    const db = createConnectionDb()
    await seedVerification(db)
    const status = await getMetaConnectionStatus(connectionEnv(db))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      events_received: 0,
      fbtrace_id: 'graph-trace-must-not-leak',
    }), { status: 200 })))
    const error = await verifyMetaConnection(connectionEnv(createConnectionDb()), 1, 'Contact')
      .catch(value => value as MetaConnectionError)
    const serialized = JSON.stringify({ status, error })
    const fingerprint = await metaConnectionFingerprint(PIXEL_ID, TOKEN)

    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain(TEST_EVENT_CODE)
    expect(serialized).not.toContain(DATA_KEY)
    expect(serialized).not.toContain(fingerprint)
    expect(serialized).not.toContain('graph-trace-must-not-leak')
    expect(status).not.toHaveProperty('tokenFingerprint')
    expect(status).not.toHaveProperty('fingerprint')
    expect(status).not.toHaveProperty('traceId')
  })
})
