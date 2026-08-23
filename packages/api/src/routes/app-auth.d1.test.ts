import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Miniflare } from 'miniflare'
import type { Bindings, Variables } from '../index'
import { hashPassword } from '../utils/password'
import { appV2Routes } from './app-v2'

const MIGRATION = readFileSync(
  new URL('../../migrations/0069_app_account_access.sql', import.meta.url),
  'utf8',
)

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-auth-routes' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT UNIQUE,
      nickname TEXT,
      password_hash TEXT NOT NULL,
      avatar_key TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      email_verified INTEGER NOT NULL DEFAULT 0,
      notification_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE membership_levels (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      rank INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_memberships (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      level_id TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE email_verification_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE galleries (id TEXT PRIMARY KEY, cover_key TEXT, status TEXT NOT NULL);
  `))
  await db.exec(executableSql(MIGRATION))
  await db.exec(executableSql(`
    ALTER TABLE app_account_security
      ADD COLUMN restriction_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE app_account_security
      ADD COLUMN restriction_reference TEXT;
    CREATE TABLE app_realtime_tickets (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      consumed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT
    );
  `))
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM app_account_security_events;
    DELETE FROM app_refresh_token_history;
    DELETE FROM app_sessions;
    DELETE FROM app_devices;
    DELETE FROM app_account_consents;
    DELETE FROM app_account_identities;
    DELETE FROM app_account_security;
    DELETE FROM email_verification_codes;
    DELETE FROM user_memberships;
    DELETE FROM membership_levels;
    DELETE FROM users;
  `)
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('App Auth HTTP 路由', () => {
  it('默认关闭时 bootstrap 不暴露登录入口，认证命令稳定拒绝', async () => {
    const { app, env } = testApp({ APP_AUTH_ENABLED: 'false' })
    const bootstrap = await app.request('/api/v2/app/bootstrap', {}, env)
    const bootstrapBody = await bootstrap.json<{
      data: {
        capabilities: { auth: boolean }
        auth: { methods: string[]; registrationEnabled: boolean; documents: unknown }
      }
    }>()
    expect(bootstrapBody.data).toMatchObject({
      capabilities: { auth: false },
      auth: { methods: [], registrationEnabled: false, documents: null },
    })

    const login = await app.request('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, env)
    expect(login.status).toBe(403)
    expect(await login.json()).toMatchObject({
      error: { code: 'FEATURE_DISABLED', retryable: false },
      meta: { requestId: 'req_app_auth_test' },
    })
  })

  it('配置完整时只启用邮箱身份并返回版本化同意要求', async () => {
    const { app, env } = testApp()
    const response = await app.request('/api/v2/app/bootstrap', {}, env)
    const body = await response.json<{
      data: {
        capabilities: { auth: boolean }
        auth: Record<string, unknown>
      }
    }>()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.data).toMatchObject({
      capabilities: { auth: true },
      auth: {
        methods: ['email'],
        registrationEnabled: true,
        deviceManagementEnabled: true,
        challenge: { type: 'none' },
        documents: {
          termsVersion: 'terms-draft-1',
          privacyVersion: 'privacy-draft-1',
          platformOperationVersion: 'platform-draft-1',
          eligibilityVersion: 'eligibility-draft-1',
          termsUrl: 'https://legal.test/terms',
          privacyUrl: 'https://legal.test/privacy',
          platformOperationUrl: 'https://legal.test/platform-operation',
          eligibilityUrl: 'https://legal.test/eligibility',
        },
      },
    })
  })

  it('Turnstile 挑战页只接受白名单用途并应用受控页面安全策略', async () => {
    const { app, env } = testApp({
      TURNSTILE_SECRET_KEY: 'test-secret-must-not-appear',
      APP_AUTH_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    })
    const response = await app.request(
      '/api/v2/auth/turnstile?purpose=login',
      {},
      env,
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com')
    expect(html).toContain('1x00000000000000000000AA')
    expect(html).toContain('app_login')
    expect(html).toContain('/api/v2/auth/turnstile/result')
    expect(html).not.toContain('test-secret-must-not-appear')
    expect(html).not.toContain('addJavascriptInterface')

    const invalid = await app.request(
      '/api/v2/auth/turnstile?purpose=arbitrary_action',
      {},
      env,
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain('arbitrary_action')
  })

  it('登录、本人信息和当前设备退出形成完整 Bearer 会话闭环', async () => {
    await seedUser('route@example.com', 'password123')
    const { app, env } = testApp()
    const login = await app.request('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginBody()),
    }, env)
    const loginBodyResult = await login.json<{
      data: {
        account: { accountId: string }
        device: { deviceId: string }
        tokens: { accessToken: string; refreshToken: string }
      }
    }>()
    expect(login.status).toBe(200)
    expect(loginBodyResult.data.account.accountId).toMatch(/^acc_/u)

    const authorization = `Bearer ${loginBodyResult.data.tokens.accessToken}`
    const me = await app.request('/api/v2/me', {
      headers: { Authorization: authorization },
    }, env)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      data: {
        account: { email: 'route@example.com' },
        currentDeviceId: loginBodyResult.data.device.deviceId,
      },
    })

    const currentDevice = await app.request(
      `/api/v2/me/devices/${loginBodyResult.data.device.deviceId}`,
      { method: 'DELETE', headers: { Authorization: authorization } },
      env,
    )
    expect(currentDevice.status).toBe(409)
    expect(await currentDevice.json()).toMatchObject({
      error: { code: 'CURRENT_DEVICE_LOGOUT_REQUIRED' },
    })

    const logout = await app.request('/api/v2/auth/logout', {
      method: 'POST',
      headers: { Authorization: authorization },
    }, env, {
      waitUntil() {},
    } as unknown as ExecutionContext)
    expect(logout.status).toBe(200)
    expect(await logout.json()).toMatchObject({ data: { loggedOut: true } })

    const afterLogout = await app.request('/api/v2/me', {
      headers: { Authorization: authorization },
    }, env)
    expect(afterLogout.status).toBe(401)
    expect(await afterLogout.json()).toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
  })
})

function testApp(overrides: Partial<Bindings> = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('appRequestId', 'req_app_auth_test')
    await next()
  })
  app.route('/api/v2', appV2Routes)
  const env = {
    DB: db,
    APP_ENV: 'local',
    APP_AUTH_ENABLED: 'true',
    APP_AUTH_REGISTRATION_ENABLED: 'true',
    APP_AUTH_TERMS_VERSION: 'terms-draft-1',
    APP_AUTH_PRIVACY_VERSION: 'privacy-draft-1',
    APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-draft-1',
    APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-draft-1',
    APP_AUTH_TERMS_URL: 'https://legal.test/terms',
    APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
    APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform-operation',
    APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
    TURNSTILE_SECRET_KEY: '',
    ...overrides,
  } as unknown as Bindings
  return { app, env }
}

function loginBody() {
  return {
    email: 'route@example.com',
    password: 'password123',
    consents: {
      termsVersion: 'terms-draft-1',
      privacyVersion: 'privacy-draft-1',
      platformOperationVersion: 'platform-draft-1',
      eligibilityVersion: 'eligibility-draft-1',
      eligibilityConfirmed: true,
    },
    device: {
      installationId: 'installation_route_12345',
      platform: 'android',
      displayName: 'Pixel 路由测试机',
      appVersion: '1.0',
    },
  }
}

async function seedUser(email: string, password: string) {
  await db.prepare(`
    INSERT INTO users (
      email, username, nickname, password_hash, role, status, email_verified
    ) VALUES (?, NULL, '路由用户', ?, 'user', 'active', 1)
  `).bind(email, await hashPassword(password)).run()
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
