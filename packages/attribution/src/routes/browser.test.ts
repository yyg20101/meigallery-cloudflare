import { readFileSync } from 'node:fs'
import {
  type AttributionBusinessEventV1,
} from '@meigallery/shared'
import {
  digestAttributionContactDestination,
} from '@meigallery/shared/utils'
import { Hono } from 'hono'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import { issueContactCapability } from '../services/contact-capability'
import { createManagedSource } from '../services/managed-source-service'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  createBrowserAttributionRoutes,
  type BrowserAttributionVariables,
} from './browser'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const fixedNow = new Date('2026-07-24T08:00:00.000Z')
const signingKey = 'browser-route-signing-key-current-at-least-32-bytes'
const encryptionKey = 'browser-route-encryption-key-current-32-bytes'
const credentialKey = 'browser-route-credential-key-current-32-bytes'
const origin = 'http://localhost:3000'
let miniflare: Miniflare
let db: D1Database
let sequence = 0

const runtime: AttributionEnvironment = {
  appEnvironment: 'local',
  publicOrigins: [origin],
  cookieDomain: null,
  credentialMasterKeys: { current: credentialKey },
  signingKeys: { current: signingKey },
  dataEncryptionKeys: { current: encryptionKey },
  queues: {
    meta: queue(),
    tiktok: queue(),
    google: queue(),
  },
  validationWorkflow: {
    createBatch: async () => [],
  } as unknown as AttributionEnvironment['validationWorkflow'],
}

const app = new Hono<{
  Bindings: AttributionBindings
  Variables: BrowserAttributionVariables
}>()
app.use('*', async (c, next) => {
  c.set('attributionEnvironment', runtime)
  await next()
})
app.route('/', createBrowserAttributionRoutes({
  now: () => fixedNow,
  country: () => 'CN',
}))

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'browser-routes' },
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
  await seedMetaConnection()
  await db.prepare(`
    INSERT INTO attribution_privacy_policy (
      id, default_mode, prior_consent_country_codes_json, policy_version
    ) VALUES ('global', 'notice_opt_out', '[]', 1)
  `).run()
})

describe('Attribution Worker Browser 公开路由', () => {
  it('仅允许配置的 CORS 来源并为上下文签发安全 Cookie', async () => {
    const denied = await request('/v1/privacy-decision', 'GET', undefined, {
      Origin: 'https://untrusted.example',
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const response = await request('/v1/context', 'PUT', {
      idempotencyKey: 'context_1',
      identifiers: { fbclid: 'meta-click-1' },
      unexpected: true,
    })
    expect(response.status).toBe(400)
    expect(await scalar('SELECT COUNT(*) AS value FROM attribution_contexts'))
      .toBe(0)

    const issued = await request('/v1/context', 'PUT', {
      idempotencyKey: 'context_2',
      identifiers: { fbclid: 'meta-click-2' },
    })
    expect(issued.status).toBe(200)
    expect(issued.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(issued.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(issued.headers.get('Set-Cookie')).toMatch(
      /HttpOnly; Secure; SameSite=Lax/,
    )
    expect(await issued.json()).toEqual({
      data: {
        issued: true,
        expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 30 * 24 * 60 * 60,
      },
    })
  })

  it('管理投放来源凭证无需依赖平台点击标识即可签发上下文', async () => {
    const source = await createManagedSource({
      db,
      now: () => fixedNow,
    }, {
      connectionId: 'conn_meta',
      campaign: 'us_bj',
      medium: 'paid_social',
      content: 'creative_a',
    })

    const response = await request('/v1/context', 'PUT', {
      idempotencyKey: 'context_managed_source',
      proof: source.proof,
      identifiers: {},
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        issued: true,
        expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 30 * 24 * 60 * 60,
      },
    })
    expect(response.headers.get('Set-Cookie')).toMatch(
      /HttpOnly; Secure; SameSite=Lax/,
    )
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_contexts
      WHERE source_id = '${source.id}'
    `)).toBe(1)
  })

  it('GPC 优先于显式授权并且 runtime-config fail closed', async () => {
    const response = await request('/v1/privacy-decision', 'PUT', {
      choice: 'granted',
      idempotencyKey: 'privacy_1',
    }, { 'Sec-GPC': '1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        state: 'denied',
        reason: 'gpc',
        policyMode: 'notice_opt_out',
        policyVersion: 1,
        requiresChoice: false,
      },
    })

    const runtimeConfig = await request('/v1/runtime-config', 'GET', undefined, {
      Cookie: cookieHeader(response),
      'Sec-GPC': '1',
    })
    expect(await runtimeConfig.json()).toEqual({ data: null })
  })

  it('只返回已解析来源对应的唯一 Active 公开配置和 30 分钟租约', async () => {
    const cookies = await contextCookies()
    const response = await request('/v1/runtime-config', 'GET', undefined, {
      Cookie: cookies,
    })
    expect(response.status).toBe(200)
    const body = await response.json<{
      data: {
        provider: string
        connectionId: string
        versionId: string
        publicConfig: Record<string, string>
        runtimeLeaseToken: string
        expiresAt: number
      }
    }>()
    expect(body.data).toEqual({
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta',
      publicConfig: {
        provider: 'meta',
        pixelId: '1615446443914929',
      },
      runtimeLeaseToken: expect.any(String),
      expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 30 * 60,
    })
  })

  it('Contact 验证 capability 与目标摘要，且只生成一条 Browser 指令', async () => {
    const cookies = await contextCookies()
    const runtimeConfig = await request('/v1/runtime-config', 'GET', undefined, {
      Cookie: cookies,
    })
    const runtimeBody = await runtimeConfig.json<{
      data: { runtimeLeaseToken: string }
    }>()
    const destination = {
      value: '@meigallery',
      linkUrl: 'https://t.me/meigallery',
    }
    const digest = await digestAttributionContactDestination(destination)
    const capability = await issueContactCapability({
      signingKeys: { current: signingKey },
      nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
    }, {
      contactMethodId: 'contact_telegram',
      platform: 'telegram',
      destinationDigest: digest,
    })
    const response = await request('/v1/events/contact', 'POST', {
      event: contactEvent(),
      attributionCapability: capability,
      destination,
      destinationDigest: digest,
      runtimeLeaseToken: runtimeBody.data.runtimeLeaseToken,
    }, { Cookie: cookies })
    expect(response.status).toBe(202)
    const body = await response.json<{
      accepted: boolean
      eventId: string
      instruction: {
        provider: string
        deliveryId: string
        receiptToken: string
      } | null
    }>()
    expect(body).toMatchObject({
      accepted: true,
      eventId: 'evt_contact_1',
      instruction: {
        provider: 'meta',
        deliveryId: expect.any(String),
        receiptToken: expect.any(String),
      },
    })
    expect(await scalar('SELECT COUNT(*) AS value FROM attribution_facts'))
      .toBe(1)
    expect(await scalar('SELECT COUNT(*) AS value FROM attribution_deliveries'))
      .toBe(2)
  })

  it('篡改 capability、不安全 URL 或空目标都不会创建事实', async () => {
    const unsafeDestination = {
      value: '@meigallery',
      linkUrl: 'javascript:alert(1)',
    }
    const digest = await digestAttributionContactDestination(
      unsafeDestination,
    )
    const capability = await issueContactCapability({
      signingKeys: { current: signingKey },
      nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
    }, {
      contactMethodId: 'contact_telegram',
      platform: 'telegram',
      destinationDigest: digest,
    })
    const unsafe = await request('/v1/events/contact', 'POST', {
      event: contactEvent(),
      attributionCapability: capability,
      destination: unsafeDestination,
      destinationDigest: digest,
      runtimeLeaseToken: null,
    })
    expect(unsafe.status).toBe(400)

    const tampered = await request('/v1/events/contact', 'POST', {
      event: contactEvent(),
      attributionCapability: `${capability}x`,
      destination: {
        value: '@meigallery',
        linkUrl: 'https://t.me/meigallery',
      },
      destinationDigest: await digestAttributionContactDestination({
        value: '@meigallery',
        linkUrl: 'https://t.me/meigallery',
      }),
      runtimeLeaseToken: null,
    })
    expect(tampered.status).toBe(400)
    expect(await scalar('SELECT COUNT(*) AS value FROM attribution_facts'))
      .toBe(0)
  })

  it('仅在验签 receipt token 后记录浏览器回执', async () => {
    const contact = await acceptedContact()
    const invalid = await request('/v1/browser-receipts', 'POST', {
      receiptToken: `${contact.instruction.receiptToken}x`,
      attemptedAt: fixedNow.toISOString(),
    })
    expect(invalid.status).toBe(400)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_browser_receipts',
    )).toBe(0)

    const receipt = await request('/v1/browser-receipts', 'POST', {
      receiptToken: contact.instruction.receiptToken,
      attemptedAt: fixedNow.toISOString(),
    })
    expect(receipt.status).toBe(202)
    expect(await receipt.json()).toEqual({ accepted: true })
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_browser_receipts',
    )).toBe(1)
  })
})

async function contextCookies(): Promise<string> {
  const context = await request('/v1/context', 'PUT', {
    idempotencyKey: `context_${++sequence}`,
    identifiers: { fbclid: `meta-click-${sequence}` },
  })
  return cookieHeader(context)
}

async function acceptedContact(): Promise<{
  instruction: { receiptToken: string }
}> {
  const cookies = await contextCookies()
  const runtimeConfig = await request('/v1/runtime-config', 'GET', undefined, {
    Cookie: cookies,
  })
  const runtimeBody = await runtimeConfig.json<{
    data: { runtimeLeaseToken: string }
  }>()
  const destination = {
    value: '@meigallery',
    linkUrl: 'https://t.me/meigallery',
  }
  const digest = await digestAttributionContactDestination(destination)
  const capability = await issueContactCapability({
    signingKeys: { current: signingKey },
    nowSeconds: () => Math.floor(fixedNow.getTime() / 1_000),
  }, {
    contactMethodId: 'contact_telegram',
    platform: 'telegram',
    destinationDigest: digest,
  })
  const response = await request('/v1/events/contact', 'POST', {
    event: contactEvent(),
    attributionCapability: capability,
    destination,
    destinationDigest: digest,
    runtimeLeaseToken: runtimeBody.data.runtimeLeaseToken,
  }, { Cookie: cookies })
  const body = await response.json<{
    instruction: { receiptToken: string } | null
  }>()
  expect(response.status).toBe(202)
  expect(body.instruction).not.toBeNull()
  return { instruction: body.instruction! }
}

function contactEvent(): AttributionBusinessEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt_contact_1',
    eventName: 'Contact',
    occurredAt: fixedNow.toISOString(),
    pagePath: '/gallery/contact',
    dedupeKey: 'contact:browser-route:1',
    sourceContextToken: null,
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    payload: {
      contactMethodId: 'contact_telegram',
      contactPlatform: 'telegram',
      contactAction: 'open_link',
    },
  }
}

async function seedMetaConnection(): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta', 'meta', 'Meta production', 'ver_meta')
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
    `).bind(fixedNow.toISOString()),
  ])
}

async function request(
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, bindings())
}

function cookieHeader(response: Response): string {
  const cookie = response.headers.get('Set-Cookie')
  expect(cookie).toBeTruthy()
  return cookie!.split(';', 1)[0]!
}

function bindings(): AttributionBindings {
  return {
    DB: db,
    APP_ENV: 'local',
    ATTRIBUTION_PUBLIC_ORIGINS: origin,
    ATTRIBUTION_COOKIE_DOMAIN: '',
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: credentialKey,
    ATTRIBUTION_SIGNING_KEY_CURRENT: signingKey,
    ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT: encryptionKey,
    META_QUEUE: runtime.queues.meta,
    TIKTOK_QUEUE: runtime.queues.tiktok,
    GOOGLE_QUEUE: runtime.queues.google,
    ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW: runtime.validationWorkflow,
  }
}

function queue() {
  return { send: async () => undefined } as unknown as AttributionEnvironment['queues']['meta']
}

async function scalar(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
