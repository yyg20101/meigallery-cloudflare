import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../index'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import {
  GRAPH_API_VERSION,
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
}

type DbCall = { sql: string; params: unknown[] }

function createConnectionDb(options: {
  pixelId?: string
  trackingMode?: 'disabled' | 'test' | 'production'
} = {}) {
  const settings = new Map<string, string>([
    ['facebook_pixel_id', JSON.stringify(options.pixelId ?? PIXEL_ID)],
    ['meta_tracking_mode', JSON.stringify(options.trackingMode ?? 'test')],
  ])
  const verifications = new Map<string, VerificationRow>()
  const calls: DbCall[] = []

  const db = {
    calls,
    settings,
    verifications,
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM site_settings')) {
            const literalKey = sql.match(/key\s*=\s*'([^']+)'/)?.[1]
            const key = literalKey || String(call.params[0] ?? '')
            const value = settings.get(key)
            return value === undefined ? null : ({ value } as T)
          }
          if (sql.includes('FROM meta_connection_verifications')) {
            return (verifications.get(String(call.params[0] ?? '')) ?? null) as T | null
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
          if (sql.includes('INSERT INTO meta_connection_verifications')) {
            const environment = String(call.params[0]) as VerificationRow['environment']
            verifications.set(environment, {
              environment,
              pixel_id: String(call.params[1]),
              token_fingerprint: String(call.params[2]),
              graph_api_version: String(call.params[3]),
              verified_event_name: String(call.params[4]),
              verified_commit: String(call.params[5]),
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: Number(call.params[6]),
              invalidated_at: null,
              invalidation_reason: '',
            })
          }
          if (sql.includes('UPDATE meta_connection_verifications') && sql.includes('invalidated_at')) {
            const reason = String(call.params[0] ?? '')
            const environment = String(call.params[1] ?? '')
            const row = verifications.get(environment)
            if (row) {
              row.invalidated_at = '2026-07-11T00:00:00.000Z'
              row.invalidation_reason = reason
            }
          }
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
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
    graph_api_version: input.graph_api_version ?? GRAPH_API_VERSION,
    verified_event_name: input.verified_event_name ?? 'Contact',
    verified_commit: input.verified_commit ?? RELEASE_COMMIT,
    dataset_quality_status: input.dataset_quality_status ?? 'not_checked',
    verified_at: input.verified_at ?? '2026-07-11T00:00:00.000Z',
    verified_by_user_id: input.verified_by_user_id ?? 1,
    invalidated_at: input.invalidated_at ?? null,
    invalidation_reason: input.invalidation_reason ?? '',
  })
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

  it.each([
    ['pixel_id_changed', async (db: ReturnType<typeof createConnectionDb>) => db.settings.set('facebook_pixel_id', JSON.stringify('9988776655'))],
    ['access_token_changed', async (_db: ReturnType<typeof createConnectionDb>, env: Bindings) => { env.META_CAPI_ACCESS_TOKEN = 'rotated-token' }],
    ['graph_api_version_changed', async (db: ReturnType<typeof createConnectionDb>) => { db.verifications.get('dev')!.graph_api_version = 'v24.0' }],
    ['release_commit_changed', async (_db: ReturnType<typeof createConnectionDb>, env: Bindings) => { env.RELEASE_COMMIT = 'b'.repeat(40) }],
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

  it('production bootstrap 在任何读取、业务记录、fetch 和 verification upsert 前固定阻断', async () => {
    const db = createConnectionDb({ trackingMode: 'production' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyMetaConnection(connectionEnv(db, { APP_ENV: 'production' }), 1, 'Contact'))
      .rejects.toMatchObject({ code: 'META_PRODUCTION_TEST_GATE_PENDING', httpStatus: 409 })

    expect(db.calls).toEqual([])
    expect(db.verifications.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
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
