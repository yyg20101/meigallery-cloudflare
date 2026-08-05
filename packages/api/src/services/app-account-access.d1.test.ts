import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import type { Bindings } from '../index'
import { hashPassword } from '../utils/password'
import {
  authenticateAppAccessToken,
  getAppAccount,
  listAppDevices,
  loginAppAccount,
  refreshAppSession,
  registerAppAccount,
  revokeAppDevice,
} from './app-account-access'

const MIGRATION = readFileSync(
  new URL('../../migrations/0069_app_account_access.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-02T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-account-access' },
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
    CREATE TABLE persons (id TEXT PRIMARY KEY);
  `))
  await db.exec(executableSql(MIGRATION))
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
    DELETE FROM persons;
    DELETE FROM users;
  `)
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('App 账号与设备会话 D1 服务', () => {
  it('migration 只创建空权威表且不回填现有用户', async () => {
    expect(MIGRATION).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\s/imu)
    const tableNames = [
      'app_account_security',
      'app_account_identities',
      'app_account_consents',
      'app_devices',
      'app_sessions',
      'app_refresh_token_history',
      'app_account_security_events',
    ]
    for (const tableName of tableNames) {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
        .first<{ count: number }>()
      expect(row?.count).toBe(0)
    }
  })

  it('注册只创建观看者账号、同意、设备和会话，不创建真人', async () => {
    await seedVerificationCode('new@example.com')

    const result = await registerAppAccount(
      env(),
      registrationInput('new@example.com', 'installation_new_123456'),
      'req_register',
      NOW,
    )

    expect(result).toMatchObject({
      account: {
        accountId: expect.stringMatching(/^acc_/u),
        email: 'new@example.com',
        role: 'user',
      },
      device: {
        deviceId: expect.stringMatching(/^dev_/u),
        current: true,
        signedIn: true,
      },
      tokens: {
        tokenType: 'Bearer',
        accessToken: expect.stringMatching(/^mga_/u),
        refreshToken: expect.stringMatching(/^mgr_/u),
      },
    })
    await expect(count('users')).resolves.toBe(1)
    await expect(count('app_account_consents')).resolves.toBe(4)
    await expect(count('persons')).resolves.toBe(0)

    const stored = await db.prepare('SELECT access_token_hash, refresh_token_hash FROM app_sessions')
      .first<{ access_token_hash: string; refresh_token_hash: string }>()
    expect(stored?.access_token_hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(stored?.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(stored?.access_token_hash).not.toBe(result.tokens.accessToken)
    expect(stored?.refresh_token_hash).not.toBe(result.tokens.refreshToken)

    const principal = await authenticateAppAccessToken(db, result.tokens.accessToken, NOW)
    const me = await getAppAccount(db, principal)
    expect(me).toMatchObject({
      account: { accountId: result.account.accountId },
      membership: { code: 'free', rank: 0 },
      currentDeviceId: result.device.deviceId,
    })
  })

  it('续期旋转两种凭证，旧续期凭证重放会撤销新会话', async () => {
    await seedVerificationCode('rotate@example.com')
    const registered = await registerAppAccount(
      env(),
      registrationInput('rotate@example.com', 'installation_rotate_123'),
      'req_register',
      NOW,
    )

    const refreshed = await refreshAppSession(
      db,
      registered.tokens.refreshToken,
      'req_refresh',
      new Date(NOW.getTime() + 60_000),
    )
    expect(refreshed.tokens.accessToken).not.toBe(registered.tokens.accessToken)
    await expect(authenticateAppAccessToken(
      db,
      registered.tokens.accessToken,
      new Date(NOW.getTime() + 60_000),
    )).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await expect(authenticateAppAccessToken(
      db,
      refreshed.tokens.accessToken,
      new Date(NOW.getTime() + 60_000),
    )).resolves.toMatchObject({ accountId: registered.account.accountId })

    await expect(refreshAppSession(
      db,
      registered.tokens.refreshToken,
      'req_replay',
      new Date(NOW.getTime() + 120_000),
    )).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    await expect(authenticateAppAccessToken(
      db,
      refreshed.tokens.accessToken,
      new Date(NOW.getTime() + 120_000),
    )).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })

    const event = await db.prepare(`
      SELECT event_type, reason_code FROM app_account_security_events
      WHERE event_type = 'refresh_token_reuse_detected'
    `).first<{ event_type: string; reason_code: string }>()
    expect(event).toEqual({
      event_type: 'refresh_token_reuse_detected',
      reason_code: 'credential_replay',
    })
  })

  it('已有 Web 账号只有在密码验证通过后才建立 App 身份映射', async () => {
    const userId = await seedLegacyUser('legacy@example.com', 'correct-password')

    await expect(loginAppAccount(
      env(),
      loginInput('legacy@example.com', 'wrong-password', 'installation_legacy_123', false),
      'req_wrong',
      NOW,
    )).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    await expect(count('app_account_identities')).resolves.toBe(0)

    await expect(loginAppAccount(
      env(),
      loginInput('legacy@example.com', 'correct-password', 'installation_legacy_123', false),
      'req_consent_required',
      NOW,
    )).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })

    const loggedIn = await loginAppAccount(
      env(),
      loginInput('legacy@example.com', 'correct-password', 'installation_legacy_123'),
      'req_login',
      NOW,
    )
    expect(loggedIn.account.accountId).toMatch(/^acc_/u)
    const identity = await db.prepare(`
      SELECT account_id, provider, verified_at FROM app_account_identities
    `).first<{ account_id: number; provider: string; verified_at: string | null }>()
    expect(identity).toEqual({ account_id: userId, provider: 'email', verified_at: null })
    await expect(count('app_account_consents')).resolves.toBe(4)
  })

  it('本人可幂等远程退出其他设备，不能越权或用该接口退出当前设备', async () => {
    await seedVerificationCode('devices@example.com')
    const first = await registerAppAccount(
      env(),
      registrationInput('devices@example.com', 'installation_first_1234'),
      'req_register',
      NOW,
    )
    const second = await loginAppAccount(
      env(),
      loginInput('devices@example.com', 'password123', 'installation_second_123'),
      'req_second',
      new Date(NOW.getTime() + 60_000),
    )
    const principal = await authenticateAppAccessToken(
      db,
      second.tokens.accessToken,
      new Date(NOW.getTime() + 60_000),
    )

    const devices = await listAppDevices(db, principal, new Date(NOW.getTime() + 60_000))
    expect(devices).toHaveLength(2)
    expect(devices.find(device => device.deviceId === second.device.deviceId)?.current).toBe(true)

    await expect(revokeAppDevice(
      db,
      principal,
      second.device.deviceId,
      'req_current',
      NOW,
    )).rejects.toMatchObject({ code: 'CURRENT_DEVICE_LOGOUT_REQUIRED' })

    const revoked = await revokeAppDevice(
      db,
      principal,
      first.device.deviceId,
      'req_remote',
      new Date(NOW.getTime() + 120_000),
    )
    expect(revoked.status).toBe('revoked')
    await expect(revokeAppDevice(
      db,
      principal,
      first.device.deviceId,
      'req_remote_again',
      new Date(NOW.getTime() + 180_000),
    )).resolves.toMatchObject({ status: 'revoked' })
    await expect(authenticateAppAccessToken(
      db,
      first.tokens.accessToken,
      new Date(NOW.getTime() + 180_000),
    )).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })

    const otherUser = principalWithDifferentAccount(principal)
    await expect(revokeAppDevice(
      db,
      otherUser,
      second.device.deviceId,
      'req_cross_account',
      NOW,
    )).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
  })
})

function env(): Bindings {
  return {
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
  } as unknown as Bindings
}

function registrationInput(email: string, installationId: string) {
  return {
    email,
    password: 'password123',
    nickname: '观看者',
    verificationCode: '123456',
    consents: {
      termsVersion: 'terms-draft-1',
      privacyVersion: 'privacy-draft-1',
      platformOperationVersion: 'platform-draft-1',
      eligibilityVersion: 'eligibility-draft-1',
      eligibilityConfirmed: true,
    },
    device: {
      installationId,
      platform: 'android' as const,
      displayName: 'Pixel 测试机',
      appVersion: '1.0',
    },
  }
}

function loginInput(email: string, password: string, installationId: string, withConsents = true) {
  return {
    email,
    password,
    ...(withConsents
      ? {
          consents: {
            termsVersion: 'terms-draft-1',
            privacyVersion: 'privacy-draft-1',
            platformOperationVersion: 'platform-draft-1',
            eligibilityVersion: 'eligibility-draft-1',
            eligibilityConfirmed: true,
          },
        }
      : {}),
    device: {
      installationId,
      platform: 'android' as const,
      displayName: 'Pixel 测试机',
      appVersion: '1.0',
    },
  }
}

async function seedVerificationCode(email: string) {
  await db.prepare(`
    INSERT INTO email_verification_codes (
      id, email, code, purpose, expires_at, created_at
    ) VALUES (?, ?, '123456', 'register', ?, ?)
  `).bind(
    `evc_${email}`,
    email,
    new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    NOW.toISOString(),
  ).run()
}

async function seedLegacyUser(email: string, password: string): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO users (
      email, username, nickname, password_hash, role, status, email_verified
    ) VALUES (?, NULL, '旧站用户', ?, 'user', 'active', 0)
  `).bind(email, await hashPassword(password)).run()
  return Number(result.meta.last_row_id)
}

async function count(tableName: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .first<{ count: number }>()
  return row?.count ?? -1
}

function principalWithDifferentAccount<T extends { accountInternalId: number }>(principal: T): T {
  return { ...principal, accountInternalId: principal.accountInternalId + 999 }
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
