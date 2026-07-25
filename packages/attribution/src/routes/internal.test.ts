import { readFileSync } from 'node:fs'
import type {
  AttributionBusinessEventV1,
} from '@meigallery/shared'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import { Hono } from 'hono'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import {
  verifyAttributionToken,
} from '../security/signed-token'
import {
  issueAttributionContextResponse,
  resolveAttributionContext,
} from '../services/context-service'
import {
  verifyContactCapability,
} from '../services/contact-capability'
import {
  issuePrivacyChoiceToken,
} from '../services/privacy-choice'
import {
  clearAttributionRuntimeDatabase,
} from '../test/attribution-schema'
import {
  createInternalAttributionRoutes,
  type InternalAttributionVariables,
} from './internal'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0005_migration_history.sql',
  '../../migrations/0006_runtime_owner_epoch.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const fixedNow = new Date('2026-07-24T08:00:00.000Z')
const signingKey = 'internal-route-signing-key-current-32-bytes'
const dataKey = 'internal-route-data-encryption-key-32-bytes'
const credentialKey = 'internal-route-credential-key-at-least-32-bytes'
let miniflare: Miniflare
let db: D1Database
let sequence = 0

const metaQueue = queue()
const tiktokQueue = queue()
const googleQueue = queue()
const queues = {
  meta: metaQueue as unknown as AttributionEnvironment['queues']['meta'],
  tiktok:
    tiktokQueue as unknown as AttributionEnvironment['queues']['tiktok'],
  google:
    googleQueue as unknown as AttributionEnvironment['queues']['google'],
}

const runtime: AttributionEnvironment = {
  appEnvironment: 'local',
  publicOrigins: ['http://localhost:3000'],
  cookieDomain: null,
  credentialMasterKeys: { current: credentialKey },
  signingKeys: { current: signingKey },
  dataEncryptionKeys: { current: dataKey },
  queues,
  validationWorkflow: {
    createBatch: async () => [],
  } as unknown as AttributionEnvironment['validationWorkflow'],
}

const app = new Hono<{
  Bindings: AttributionBindings
  Variables: InternalAttributionVariables
}>()
app.use('*', async (c, next) => {
  c.set('attributionEnvironment', runtime)
  await next()
})
app.route('/internal/v1', createInternalAttributionRoutes({
  now: () => fixedNow,
}))

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'internal-routes' },
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
    SET mode = 'bridge',
        activated_at = NULL,
        updated_at = ?,
        bridge_owner_epoch = 2,
        active_owner_epoch = NULL,
        fenced_owner_epoch = NULL
    WHERE id = 'global'
  `).bind(fixedNow.toISOString()).run()
  sequence = 0
  metaQueue.send.mockClear()
  tiktokQueue.send.mockClear()
  googleQueue.send.mockClear()
  await seedMetaConnection()
})

describe('Attribution Worker 内部 Service Binding 路由', () => {
  it('只读返回运行模式、owner epoch 与最终对账状态', async () => {
    const response = await request(
      '/internal/v1/runtime-state',
      'GET',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      mode: 'bridge',
      activatedAt: null,
      bridgeOwnerEpoch: 2,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: null,
      updatedAt: fixedNow.toISOString(),
      migrationReconciled: false,
      inFlightServerDeliveries: 0,
    })
  })

  it('只依据签名隐私选择、地区策略与 GPC 返回权威判定', async () => {
    const privacyToken = await issuePrivacyChoiceToken({
      signingKeys: { current: signingKey },
      nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
    }, 'granted')

    const granted = await request(
      '/internal/v1/privacy-decision',
      'POST',
      {
        privacyToken,
        country: 'US',
        gpc: false,
      },
    )
    expect(granted.status).toBe(200)
    expect(await granted.json()).toEqual({
      state: 'granted',
      reason: 'explicit',
    })

    const unsigned = await request(
      '/internal/v1/privacy-decision',
      'POST',
      {
        privacyToken: 'unsigned-browser-value',
        country: 'US',
        gpc: false,
      },
    )
    expect(await unsigned.json()).toEqual({
      state: 'choice_required',
      reason: 'policy_default',
    })

    const gpc = await request(
      '/internal/v1/privacy-decision',
      'POST',
      {
        privacyToken,
        country: 'US',
        gpc: true,
      },
    )
    expect(await gpc.json()).toEqual({
      state: 'denied',
      reason: 'gpc',
    })
  })

  it('严格拒绝带额外字段或非规范地区的隐私判定请求', async () => {
    for (const body of [
      {
        privacyToken: null,
        country: 'usa',
        gpc: false,
      },
      {
        privacyToken: null,
        country: null,
        gpc: false,
        consentState: 'granted',
      },
    ]) {
      const response = await request(
        '/internal/v1/privacy-decision',
        'POST',
        body,
      )
      expect(response.status).toBe(400)
    }
  })

  it('注册只接受共享 guard 的 CompleteRegistration 并进入加密 outbox 与对应 Queue', async () => {
    const event = await registrationEvent()
    const response = await request(
      '/internal/v1/registration-events',
      'POST',
      event,
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      accepted: true,
      eventId: event.eventId,
    })
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_deliveries',
    )).toBe(2)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_outbox',
    )).toBe(2)
    expect(metaQueue.send).toHaveBeenCalledOnce()
    expect(metaQueue.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      provider: 'meta',
      deliveryId: expect.any(String),
    })
    expect(tiktokQueue.send).not.toHaveBeenCalled()
    expect(googleQueue.send).not.toHaveBeenCalled()

    const outbox = await db.prepare(`
      SELECT ciphertext
      FROM attribution_outbox
      INNER JOIN attribution_deliveries
        ON attribution_deliveries.id = attribution_outbox.delivery_id
      WHERE attribution_deliveries.transport = 'server'
    `).first<{ ciphertext: string }>()
    expect(outbox?.ciphertext).not.toContain(
      event.sourceContextToken as string,
    )
  })

  it('重复注册事件复用同一事实且不会重复发送 Queue', async () => {
    const event = await registrationEvent()

    expect((await request(
      '/internal/v1/registration-events',
      'POST',
      event,
    )).status).toBe(202)
    expect((await request(
      '/internal/v1/registration-events',
      'POST',
      event,
    )).status).toBe(202)

    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_deliveries',
    )).toBe(2)
    expect(metaQueue.send).toHaveBeenCalledOnce()
  })

  it('注册、联系和浏览器指令严格拒绝缺失或错误的运行所有权', async () => {
    const event = await registrationEvent()
    const missing = await request(
      '/internal/v1/registration-events',
      'POST',
      event,
      { includeOwnership: false },
    )
    expect(missing.status).toBe(503)

    const stale = await request(
      '/internal/v1/registration-events',
      'POST',
      event,
      { owner: 'draining', epoch: 3 },
    )
    expect(stale.status).toBe(503)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(0)
  })

  it('桥接期将旧 provider 上下文幂等翻译为新运行时 token', async () => {
    const body = {
      provider: 'meta',
      identifiers: {
        fbclid: 'legacy-fb-click',
      },
      idempotencyKey: 'legacy_context_1001',
    }
    const first = await request(
      '/internal/v1/legacy-context',
      'POST',
      body,
    )
    const second = await request(
      '/internal/v1/legacy-context',
      'POST',
      body,
    )
    const firstBody = await first.json<{
      sourceContextToken: string
    }>()
    const secondBody = await second.json<{
      sourceContextToken: string
    }>()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(secondBody).toEqual(firstBody)
    expect(await resolveAttributionContext({
      db,
      signingKeys: { current: signingKey },
      encryptionKeys: { current: dataKey },
      nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
    }, firstBody.sourceContextToken)).toMatchObject({
      provider: 'meta',
      connectionId: 'conn_meta',
      sourceId: null,
      identifiers: {
        fbclid: 'legacy-fb-click',
      },
    })
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_contexts',
    )).toBe(1)
  })

  it('桥接期内部 Contact 只按上下文 provider 创建投递并保留请求匹配数据', async () => {
    const sourceContextToken = await contextToken()
    const event: AttributionBusinessEventV1 = {
      schemaVersion: 1,
      eventId: 'contact_event_1001',
      eventName: 'Contact',
      occurredAt: fixedNow.toISOString(),
      pagePath: '/gallery',
      dedupeKey: 'contact:session:1001',
      sourceContextToken,
      consent: {
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: false,
      },
      payload: {
        contactMethodId: 'contact_telegram_1',
        contactPlatform: 'telegram',
        contactAction: 'open_link',
      },
    }
    const response = await request(
      '/internal/v1/contact-events',
      'POST',
      {
        event,
        requestMetadata: {
          clientIp: '192.0.2.10',
          userAgent: 'Attribution bridge test',
        },
      },
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      accepted: true,
      eventId: event.eventId,
    })
    expect(await db.prepare(`
      SELECT provider, event_name
      FROM attribution_facts
      WHERE event_id = ?
    `).bind(event.eventId).first()).toEqual({
      provider: 'meta',
      event_name: 'Contact',
    })
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_deliveries
      WHERE provider = 'meta'
    `)).toBe(2)
    expect(metaQueue.send).toHaveBeenCalledOnce()
    expect(tiktokQueue.send).not.toHaveBeenCalled()
    expect(googleQueue.send).not.toHaveBeenCalled()
  })

  it.each([
    ['Contact', () => ({
      ...baseRegistrationEvent(),
      eventName: 'Contact',
      payload: {
        contactMethodId: 'contact_1',
        contactPlatform: 'telegram',
        contactAction: 'open_link',
      },
    })],
    ['多余字段', () => ({
      ...baseRegistrationEvent(),
      unexpected: true,
    })],
    ['非法 payload', () => ({
      ...baseRegistrationEvent(),
      payload: { userId: 0 },
    })],
  ])('拒绝非权威注册事件：%s', async (_label, build) => {
    const response = await request(
      '/internal/v1/registration-events',
      'POST',
      build(),
    )

    expect(response.status).toBe(400)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_facts',
    )).toBe(0)
    expect(metaQueue.send).not.toHaveBeenCalled()
  })

  it('Browser instruction 从既有 delivery 经 Adapter 构建并只返回短期签名 token', async () => {
    const event = await registrationEvent()
    await request('/internal/v1/registration-events', 'POST', event)

    const response = await request(
      `/internal/v1/events/${event.eventId}/browser-instruction`,
      'GET',
    )
    const body = await response.json<{ instructionToken: string }>()
    const payload = await verifyAttributionToken(
      { current: signingKey },
      'browser-instruction',
      body.instructionToken,
    )
    const instruction = payload?.instruction as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      schemaVersion: 1,
      eventId: event.eventId,
      issuedAt: Math.floor(fixedNow.getTime() / 1_000),
      expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 300,
      instruction: {
        provider: 'meta',
        canonicalEvent: 'CompleteRegistration',
        eventName: 'CompleteRegistration',
        destination: 'meta_pixel',
        externalEventId: expect.any(String),
        receiptToken: expect.any(String),
      },
    })
    expect(await verifyAttributionToken(
      { current: signingKey },
      'browser-receipt',
      instruction.receiptToken as string,
    )).toMatchObject({
      eventId: event.eventId,
      deliveryId: instruction.deliveryId,
    })
    const serialized = JSON.stringify({ body, payload })
    expect(serialized).not.toContain(event.sourceContextToken as string)
    expect(serialized).not.toContain(credentialKey)
    expect(serialized).not.toMatch(/credential|sourceContextToken/)
  })

  it('不存在、过期或无 Browser delivery 的事件不签发 instruction', async () => {
    expect((await request(
      '/internal/v1/events/missing_event/browser-instruction',
      'GET',
    )).status).toBe(404)

    const event = {
      ...baseRegistrationEvent(),
      consent: {
        marketingAllowed: false,
        adUserDataAllowed: false,
        adPersonalizationAllowed: false,
      },
    }
    expect((await request(
      '/internal/v1/registration-events',
      'POST',
      event,
    )).status).toBe(202)
    expect((await request(
      `/internal/v1/events/${event.eventId}/browser-instruction`,
      'GET',
    )).status).toBe(404)
  })

  it('按输入顺序逐项签发最长 24 小时并绑定三项联系人字段', async () => {
    const contacts = [
      {
        contactMethodId: 'contact_telegram_1',
        platform: 'telegram',
        destinationDigest: 'a'.repeat(64),
      },
      {
        contactMethodId: 'contact_email_1',
        platform: 'email',
        destinationDigest: 'b'.repeat(64),
      },
    ]
    const response = await request(
      '/internal/v1/contact-capabilities',
      'POST',
      { contacts },
    )
    const body = await response.json<{
      capabilities: Array<{
        contactMethodId: string
        platform: string
        destinationDigest: string
        attributionCapability: string
      }>
    }>()

    expect(response.status).toBe(200)
    expect(body.capabilities.map(item => ({
      contactMethodId: item.contactMethodId,
      platform: item.platform,
      destinationDigest: item.destinationDigest,
    }))).toEqual(contacts)
    for (const [index, item] of body.capabilities.entries()) {
      expect(await verifyContactCapability({
        signingKeys: { current: signingKey },
        nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
      }, item.attributionCapability)).toEqual({
        schemaVersion: 1,
        ...contacts[index],
        issuedAt: Math.floor(fixedNow.getTime() / 1_000),
        expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 86_400,
      })
    }
  })

  it.each([
    ['直接数组', []],
    ['非数组', { contacts: {} }],
    ['空数组', { contacts: [] }],
    ['顶层多余字段', { contacts: [{
      contactMethodId: 'contact_1',
      platform: 'telegram',
      destinationDigest: 'a'.repeat(64),
    }], unexpected: true }],
    ['超出数量', { contacts: Array.from({ length: 101 }, (_, index) => ({
      contactMethodId: `contact_${index}`,
      platform: 'telegram',
      destinationDigest: 'a'.repeat(64),
    })) }],
    ['多余字段', { contacts: [{
      contactMethodId: 'contact_1',
      platform: 'telegram',
      destinationDigest: 'a'.repeat(64),
      destination: 'https://sensitive.invalid',
    }] }],
    ['重复项', { contacts: [
      {
        contactMethodId: 'contact_1',
        platform: 'telegram',
        destinationDigest: 'a'.repeat(64),
      },
      {
        contactMethodId: 'contact_1',
        platform: 'telegram',
        destinationDigest: 'a'.repeat(64),
      },
    ] }],
    ['非规范摘要', { contacts: [{
      contactMethodId: 'contact_1',
      platform: 'telegram',
      destinationDigest: 'A'.repeat(64),
    }] }],
  ])('严格拒绝联系人请求：%s', async (_label, body) => {
    const response = await request(
      '/internal/v1/contact-capabilities',
      'POST',
      body,
    )
    expect(response.status).toBe(400)
  })
})

async function registrationEvent(): Promise<AttributionBusinessEventV1> {
  return {
    ...baseRegistrationEvent(),
    sourceContextToken: await contextToken(),
  }
}

function baseRegistrationEvent(): AttributionBusinessEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'registration_event_1001',
    eventName: 'CompleteRegistration',
    occurredAt: fixedNow.toISOString(),
    pagePath: '/register',
    dedupeKey: 'complete_registration:user:1001',
    sourceContextToken: null,
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    payload: {
      userId: 1001,
      hashedEmail: 'c'.repeat(64),
    },
  }
}

async function contextToken(): Promise<string> {
  const response = await issueAttributionContextResponse({
    db,
    signingKeys: { current: signingKey },
    encryptionKeys: { current: dataKey },
    nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
    idFactory: prefix => `${prefix}_${++sequence}`,
  }, {
    privacyDecision: {
      state: 'granted',
      reason: 'regional_default',
      policyVersion: 1,
    },
    route: {
      provider: 'meta',
      connectionId: 'conn_meta',
    },
    sourceId: null,
    identifiers: { fbclid: 'fbclid-meta-registration' },
    idempotencyKey: `registration-context-${sequence}`,
  })
  return response.headers.get('Set-Cookie')!
    .split(';', 1)[0]!
    .split('=', 2)[1]!
}

async function seedMetaConnection(): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, is_default, active_version_id
      ) VALUES (
        'conn_meta', 'meta', 'Meta production', 1, 'ver_meta'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_meta', 'conn_meta', 'meta', 'active',
        '{"pixelId":"1615446443914929"}',
        'config_meta', 1, ?
      )
    `).bind(fixedNow.toISOString()),
    db.prepare(`
      INSERT INTO attribution_version_bindings (
        version_id, canonical_event, enabled,
        browser_destination, server_destination
      ) VALUES (
        'ver_meta', 'CompleteRegistration', 1,
        'meta_pixel', 'meta_capi'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_version_bindings (
        version_id, canonical_event, enabled,
        browser_destination, server_destination
      ) VALUES (
        'ver_meta', 'Contact', 1,
        'meta_pixel', 'meta_capi'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by, updated_at
      ) VALUES (
        'conn_meta', 1, 1, 1, 100, 100,
        'closed', 1, ?
      )
    `).bind(fixedNow.toISOString()),
  ])
}

async function request(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  ownership: {
    includeOwnership?: boolean
    owner?: 'draining' | 'new'
    epoch?: number
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (ownership.includeOwnership !== false) {
    headers[
      ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_OWNER
    ] = ownership.owner ?? 'draining'
    headers[
      ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_EPOCH
    ] = String(ownership.epoch ?? 2)
  }
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, bindings())
}

function bindings(): AttributionBindings {
  return {
    DB: db,
    APP_ENV: 'local',
    ATTRIBUTION_PUBLIC_ORIGINS: 'http://localhost:3000',
    ATTRIBUTION_COOKIE_DOMAIN: '',
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: credentialKey,
    ATTRIBUTION_SIGNING_KEY_CURRENT: signingKey,
    ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT: dataKey,
    META_QUEUE: queues.meta,
    TIKTOK_QUEUE: queues.tiktok,
    GOOGLE_QUEUE: queues.google,
    ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW:
      runtime.validationWorkflow,
  }
}

function queue() {
  return {
    send: vi.fn<(message: unknown) => Promise<void>>(
      async () => undefined,
    ),
  }
}

async function scalar(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
