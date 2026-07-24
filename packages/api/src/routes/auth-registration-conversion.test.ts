import { Hono } from 'hono'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Bindings, Variables } from '../index'
import {
  buildCompleteRegistrationOutboxStatement,
  dispatchAttributionBusinessOutboxImmediately,
} from '../services/attribution-business-outbox'
import { hashInviteCode } from '../services/invite-codes'
import { createMarketingConsentReceipt } from '../utils/marketing-consent-receipt'
import { authRoutes } from './auth'

vi.mock('../services/attribution-business-outbox', () => ({
  buildCompleteRegistrationOutboxStatement: vi.fn((
    db: D1Database,
    input: unknown,
  ) => db.prepare(
    'INSERT INTO attribution_business_outbox (payload_json) VALUES (?)',
  ).bind(JSON.stringify(input))),
  dispatchAttributionBusinessOutboxImmediately: vi.fn(),
}))

const buildOutboxMock = vi.mocked(
  buildCompleteRegistrationOutboxStatement,
)
const dispatchOutboxMock = vi.mocked(
  dispatchAttributionBusinessOutboxImmediately,
)

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/auth', authRoutes)
  return app
}

describe('注册 API 权威创建 CompleteRegistration', () => {
  beforeEach(() => {
    buildOutboxMock.mockClear()
    dispatchOutboxMock.mockReset()
    dispatchOutboxMock.mockResolvedValue({
      outboxId: 'registration_user_42',
      eventId: 'registration_user_42',
      accepted: true,
      instructionToken: 'instruction_token_0123456789',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('用户与 CompleteRegistration outbox 同一 batch 提交后才绑定邀请码、创建 session 和投递', async () => {
    const db = createRegisterDb(await hashInviteCode('ACTIVE1'))
    dispatchOutboxMock.mockImplementationOnce(async () => {
      db.events.push('attribution_dispatch')
      return {
        outboxId: 'registration_user_42',
        eventId: 'registration_user_42',
        accepted: true,
        instructionToken: 'instruction_token_0123456789',
      }
    })

    const response = await register(db, {
      inviteCode: 'ACTIVE1',
      attribution: grantedAttribution(),
    })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(db.batchCalls).toHaveLength(1)
    expect(db.batchCalls[0]?.map(call => call.sql)).toEqual([
      expect.stringContaining('INSERT INTO users'),
      expect.stringContaining('INSERT INTO attribution_business_outbox'),
    ])
    expect(buildOutboxMock).toHaveBeenCalledOnce()
    expect(buildOutboxMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        pagePath: '/register',
        sourceContextToken: 'opaque_context_token',
        consent: expect.objectContaining({
          marketingAllowed: true,
          adUserDataAllowed: true,
          adPersonalizationAllowed: true,
        }),
        hashedEmail: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )
    expect(dispatchOutboxMock).toHaveBeenCalledWith(
      db,
      expect.anything(),
      'registration_user_42',
    )
    expect(db.events).toEqual([
      'registration_transaction',
      'invite_registration',
      'invite_counter_update',
      'session_insert',
      'attribution_dispatch',
    ])
    expect(body).toMatchObject({
      id: 42,
      attributionInstructionToken: 'instruction_token_0123456789',
    })
    expect(body).not.toHaveProperty('trackingInstructions')
    expect(JSON.stringify(body)).not.toContain('opaque_context_token')
  })

  it('用户插入失败时原子回滚且不投递归因', async () => {
    const db = createRegisterDb(undefined, { failRegistrationBatch: true })

    const response = await register(db, {
      attribution: grantedAttribution(),
    })

    expect(response.status).toBe(500)
    expect(db.persistedUser).toBe(false)
    expect(db.persistedOutbox).toBe(false)
    expect(dispatchOutboxMock).not.toHaveBeenCalled()
  })

  it('只原样保存新归因 Cookie，不解析、验签、回显或记录其内容', async () => {
    const privateToken = 'opaque_private_context_token_987654321'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(
      () => undefined,
    )
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(
      () => undefined,
    )
    const db = createRegisterDb()

    const response = await register(
      db,
      {
        attribution: {
          ...grantedAttribution(),
          attributionProvider: 'tiktok',
          sourceContextToken: 'forged_body_token',
        },
      },
      { contextToken: privateToken },
    )
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(buildOutboxMock.mock.calls[0]?.[1]).toMatchObject({
      sourceContextToken: privateToken,
    })
    expect(JSON.stringify(body)).not.toContain(privateToken)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateToken)
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(privateToken)
    expect(JSON.stringify(buildOutboxMock.mock.calls[0]?.[1]))
      .not.toContain('forged_body_token')
  })

  it('Cookie 缺失或不满足不透明载荷边界时写 null，不阻断注册', async () => {
    const missingDb = createRegisterDb()
    expect((await register(
      missingDb,
      { attribution: grantedAttribution() },
      { contextToken: null },
    )).status).toBe(201)
    expect(buildOutboxMock.mock.calls[0]?.[1]).toMatchObject({
      sourceContextToken: null,
    })

    buildOutboxMock.mockClear()
    const shortDb = createRegisterDb()
    expect((await register(
      shortDb,
      { attribution: grantedAttribution() },
      { contextToken: 'x' },
    )).status).toBe(201)
    expect(buildOutboxMock.mock.calls[0]?.[1]).toMatchObject({
      sourceContextToken: null,
    })
  })

  it('未获得营销授权时仍创建第一方业务事件，但不包含邮箱摘要', async () => {
    const db = createRegisterDb()
    const response = await register(db, {
      attribution: {
        ...grantedAttribution(),
        consentState: 'denied',
      },
    })

    expect(response.status).toBe(201)
    expect(buildOutboxMock.mock.calls[0]?.[1]).toMatchObject({
      consent: {
        marketingAllowed: false,
        adUserDataAllowed: false,
        adPersonalizationAllowed: false,
      },
      hashedEmail: undefined,
    })
  })

  it('营销授权 receipt 解析异常时按拒绝状态完成注册', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(
      () => undefined,
    )
    const db = createRegisterDb()
    const response = await register(
      db,
      { attribution: grantedAttribution() },
      { failConsentResolution: true },
    )

    expect(response.status).toBe(201)
    expect(buildOutboxMock.mock.calls[0]?.[1]).toMatchObject({
      consent: {
        marketingAllowed: false,
        adUserDataAllowed: false,
        adPersonalizationAllowed: false,
      },
    })
    expect(consoleWarn).toHaveBeenCalledWith(
      '[auth.register] 营销授权解析失败，按拒绝状态继续注册',
      { code: 'REGISTRATION_MARKETING_CONSENT_RESOLUTION_FAILED' },
    )
  })

  it('即时 Binding 投递失败不回滚用户、outbox 或 session', async () => {
    dispatchOutboxMock.mockRejectedValueOnce(
      new Error('private-upstream-detail'),
    )
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(
      () => undefined,
    )
    const db = createRegisterDb()

    const response = await register(db, {
      attribution: grantedAttribution(),
    })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(db.persistedUser).toBe(true)
    expect(db.persistedOutbox).toBe(true)
    expect(db.events).toContain('session_insert')
    expect(body.attributionInstructionToken).toBeNull()
    expect(consoleWarn).toHaveBeenCalledWith(
      '[auth.register] 注册归因即时投递失败，保留 outbox 重试',
      { userId: 42, code: 'REGISTRATION_ATTRIBUTION_DISPATCH_FAILED' },
    )
    expect(JSON.stringify(consoleWarn.mock.calls))
      .not.toContain('private-upstream-detail')
  })

  it('即时投递未接受时保留 outbox，并只记录稳定待重试状态', async () => {
    dispatchOutboxMock.mockResolvedValueOnce({
      outboxId: 'registration_user_42',
      eventId: 'registration_user_42',
      accepted: false,
      instructionToken: null,
    })
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(
      () => undefined,
    )
    const db = createRegisterDb()

    const response = await register(db, {
      attribution: grantedAttribution(),
    })

    expect(response.status).toBe(201)
    expect(db.persistedOutbox).toBe(true)
    expect(consoleWarn).toHaveBeenCalledWith(
      '[auth.register] 注册归因等待 outbox 重试',
      { userId: 42, code: 'REGISTRATION_ATTRIBUTION_PENDING' },
    )
  })

  it('邀请码绑定异常只记录稳定 code，不记录注册或归因敏感值', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(
      () => undefined,
    )
    const db = createRegisterDb(
      await hashInviteCode('ACTIVE1'),
      { failInviteRegistration: true },
    )

    const response = await register(db, {
      inviteCode: 'ACTIVE1',
      attribution: grantedAttribution(),
    }, {
      contextToken: 'opaque_invite_private_context',
    })
    const logs = JSON.stringify(consoleWarn.mock.calls)

    expect(response.status).toBe(201)
    expect(consoleWarn).toHaveBeenCalledWith(
      '[auth.register] 邀请码注册绑定失败',
      { userId: 42, code: 'INVITE_REGISTRATION_BIND_FAILED' },
    )
    for (const sensitive of [
      'new@example.com',
      'ACTIVE1',
      'opaque_invite_private_context',
    ]) expect(logs).not.toContain(sensitive)
  })
})

function grantedAttribution() {
  return {
    visitorId: 'visitor_registration_42',
    sessionId: 'session_registration_42',
    occurredAt: '2026-07-10T08:00:00.000Z',
    routeName: 'register',
    path: '/register',
    sourceChannel: 'ad',
    sourceName: 'release-dev-fb',
    trackingSourceSlug: 'release-dev-fb',
    utmSource: 'release-dev-fb',
    utmMedium: 'paid_social',
    utmCampaign: 'registration',
    utmContent: 'hero',
    consentState: 'granted',
  }
}

async function register(
  db: ReturnType<typeof createRegisterDb>,
  extra: Record<string, unknown>,
  options: {
    withTrustedReceipt?: boolean
    failConsentResolution?: boolean
    contextToken?: string | null
  } = {},
) {
  const requestedConsent = (
    extra.attribution as { consentState?: unknown } | undefined
  )?.consentState
  const withTrustedReceipt = options.withTrustedReceipt ?? true
  const receipt = withTrustedReceipt && requestedConsent === 'granted'
    ? await createMarketingConsentReceipt(
        'test-session-secret',
        'granted',
      )
    : ''
  const bindings = {
    APP_ENV: 'local',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
    ATTRIBUTION: {
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    },
  } as unknown as Bindings
  if (options.failConsentResolution) {
    Object.defineProperty(bindings, 'SESSION_SECRET', {
      get() {
        throw new Error('secret unavailable')
      },
    })
  }
  const cookies = [
    receipt ? `mei_marketing_consent_receipt=${receipt}` : '',
    options.contextToken === null
      ? ''
      : `__Secure-mg_attribution_context=${
        options.contextToken ?? 'opaque_context_token'
      }`,
  ].filter(Boolean)

  return createApp().request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies.join('; '),
    },
    body: JSON.stringify({
      email: 'new@example.com',
      username: 'newuser',
      password: 'password123',
      ...extra,
    }),
  }, bindings)
}

type PreparedCall = {
  sql: string
  params: unknown[]
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number; last_row_id?: number } }>
  bind(...params: unknown[]): PreparedCall
}

function createRegisterDb(
  activeInviteHash?: string,
  options: {
    failInviteRegistration?: boolean
    failRegistrationBatch?: boolean
  } = {},
) {
  const calls: PreparedCall[] = []
  const batchCalls: PreparedCall[][] = []
  const events: string[] = []
  const state = {
    persistedUser: false,
    persistedOutbox: false,
  }
  const db = {
    calls,
    batchCalls,
    events,
    get persistedUser() {
      return state.persistedUser
    },
    get persistedOutbox() {
      return state.persistedOutbox
    },
    prepare(sql: string): PreparedCall {
      const call: PreparedCall = {
        sql,
        params: [],
        bind(...params: unknown[]) {
          call.params = params
          return call
        },
        async first<T>() {
          if (
            sql.includes('FROM invite_codes')
            && call.params[0] === activeInviteHash
          ) {
            return {
              id: 'inv_1',
              name: '活动',
              channel: 'telegram',
              status: 'active',
              max_uses: 10,
              used_count: 0,
              expires_at: null,
            } as T
          }
          return null
        },
        async run() {
          if (
            options.failInviteRegistration
            && sql.includes(
              'INSERT OR IGNORE INTO invite_registrations',
            )
          ) {
            throw new Error(
              'new@example.com|ACTIVE1|opaque_invite_private_context',
            )
          }
          if (
            sql.includes(
              'INSERT OR IGNORE INTO invite_registrations',
            )
          ) events.push('invite_registration')
          if (sql.includes('UPDATE invite_codes SET used_count')) {
            events.push('invite_counter_update')
          }
          if (sql.includes('INSERT INTO sessions')) {
            events.push('session_insert')
          }
          return { meta: { changes: 1 } }
        },
      }
      calls.push(call)
      return call
    },
    async batch(statements: PreparedCall[]) {
      batchCalls.push(statements)
      if (options.failRegistrationBatch) {
        throw new Error('duplicate user')
      }
      state.persistedUser = true
      state.persistedOutbox = true
      events.push('registration_transaction')
      return [
        { meta: { changes: 1, last_row_id: 42 }, results: [] },
        {
          meta: { changes: 1 },
          results: [{
            id: 'registration_user_42',
            event_id: 'registration_user_42',
          }],
        },
      ]
    },
  }
  return db
}
