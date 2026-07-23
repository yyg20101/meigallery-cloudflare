import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import {
  getPlatformConnection,
  listPlatformConnections,
  savePlatformConnection,
  type SavePlatformConnectionCommand,
} from './connection-service'
import { readAttributionCredential } from './credential-vault'

const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const MASTER_KEY = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const ACTOR_ID = 41
const META_TOKEN = 'meta-token-must-never-leak'
const ROTATED_META_TOKEN = 'rotated-meta-token-must-never-leak'

let miniflare: Miniflare
let db: D1Database
let googleCredential: string

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'connection-service' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
  const supportSchema = `
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `
  for (const statement of unstable_splitSqlQuery(supportSchema)) await db.prepare(statement).run()
  googleCredential = await validGoogleServiceAccount()
}, 30_000)

beforeEach(async () => {
  await db.exec(`
    DELETE FROM attribution_verifications;
    DELETE FROM attribution_event_bindings;
    DELETE FROM attribution_credentials;
    DELETE FROM attribution_platform_connections;
    DELETE FROM admin_audit_logs;
    DELETE FROM users;
    INSERT INTO users (id) VALUES (${ACTOR_ID});
  `)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.exec('DROP TRIGGER IF EXISTS reject_connection_audit;')
})

afterAll(async () => miniflare.dispose())

describe('统一广告平台连接原子服务', () => {
  it('通过同一服务保存三平台，并生成可安全用于 Workflow ID 的固定 revision', async () => {
    const meta = await savePlatformConnection(env(), metaCommand())
    const tiktok = await savePlatformConnection(env(), tiktokCommand())
    const google = await savePlatformConnection(env(), googleCommand())

    expect([meta.connectionId, tiktok.connectionId, google.connectionId]).toEqual([
      'conn_meta',
      'conn_tiktok',
      'conn_google',
    ])
    for (const connection of [meta, tiktok, google]) {
      expect(connection.connectionRevision).toMatch(/^[0-9a-f]{24}$/)
      expect(connection.credential.revision).toMatch(/^[0-9a-f]{24}$/)
      expect(`verify:${connection.provider}:${connection.connectionId}:${connection.connectionRevision}:${connection.credential.revision}:${Number.MAX_SAFE_INTEGER}`.length).toBeLessThan(100)
    }
    expect(await countRows('attribution_platform_connections')).toBe(3)
    expect(await countRows('attribution_event_bindings')).toBe(6)
    expect(await countRows('attribution_credentials')).toBe(3)
    expect(await countRows('admin_audit_logs')).toBe(3)

    const bindings = await db.prepare(`
      SELECT provider, canonical_event, browser_destination, server_destination
      FROM attribution_event_bindings ORDER BY provider, canonical_event
    `).all<Record<string, unknown>>()
    expect(bindings.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'meta', browser_destination: 'meta_pixel', server_destination: 'meta_capi' }),
      expect.objectContaining({ provider: 'tiktok', browser_destination: 'tiktok_pixel', server_destination: 'tiktok_events_api' }),
      expect.objectContaining({ provider: 'google', canonical_event: 'Contact', browser_destination: 'AW-123456789/CONTACT_LABEL', server_destination: '12345678901234567890' }),
      expect.objectContaining({ provider: 'google', canonical_event: 'CompleteRegistration', browser_destination: 'AW-123456789/REGISTRATION_LABEL', server_destination: '987654321' }),
    ]))

    const listed = await listPlatformConnections(env())
    expect(listed).toHaveLength(3)
    expect(await getPlatformConnection(env(), 'google')).toMatchObject({
      publicConfig: { provider: 'google', tagId: 'AW-123456789' },
      credential: { configured: true, type: 'service_account_json' },
    })
    expect(JSON.stringify(listed)).not.toMatch(/ciphertext|fingerprint|private_key|\biv\b/i)
  })

  it('首次保存未提供凭证时拒绝且不写入任何表', async () => {
    const command = metaCommand()
    delete command.credential

    await expect(savePlatformConnection(env(), command)).rejects.toMatchObject({
      code: 'AD_PLATFORM_CONNECTION_CREDENTIAL_REQUIRED',
    })
    expect(await countRows('attribution_platform_connections')).toBe(0)
    expect(await countRows('attribution_event_bindings')).toBe(0)
    expect(await countRows('admin_audit_logs')).toBe(0)
  })

  it('更新未带 credential 时保留原 credential revision 和原密文', async () => {
    const first = await savePlatformConnection(env(), metaCommand())
    const before = await db.prepare(`SELECT id, ciphertext FROM attribution_credentials`).first<{ id: string; ciphertext: string }>()
    const command = metaCommand({
      mode: 'test',
      rolloutTargetPercentage: 10,
      publicConfig: { provider: 'meta', pixelId: '1277657707436782' },
    })
    delete command.credential

    const updated = await savePlatformConnection(env(), command)
    const after = await db.prepare(`SELECT id, ciphertext FROM attribution_credentials`).first<{ id: string; ciphertext: string }>()

    expect(updated.connectionRevision).not.toBe(first.connectionRevision)
    expect(updated.credential.revision).toBe(first.credential.revision)
    expect(after).toEqual(before)
    await expect(readAttributionCredential(env(), {
      connectionId: 'conn_meta',
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: first.credential.revision,
    })).resolves.toBe(META_TOKEN)
  })

  it('显式 credential 轮换生成新 revision 并原子替换旧凭证', async () => {
    const first = await savePlatformConnection(env(), metaCommand())
    const rotated = await savePlatformConnection(env(), metaCommand({
      credential: { type: 'access_token', plaintext: ROTATED_META_TOKEN },
    }))

    expect(rotated.credential.revision).not.toBe(first.credential.revision)
    expect(await countRows('attribution_credentials')).toBe(1)
    await expect(readAttributionCredential(env(), {
      connectionId: 'conn_meta',
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: rotated.credential.revision,
    })).resolves.toBe(ROTATED_META_TOKEN)
    await expect(readAttributionCredential(env(), {
      connectionId: 'conn_meta',
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: first.credential.revision,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_NOT_FOUND' })
  })

  it('batch 最后一条 SQL 失败时回滚连接、凭证、绑定和审计', async () => {
    const first = await savePlatformConnection(env(), metaCommand())
    const beforeConnection = await tableRows('attribution_platform_connections')
    const beforeBindings = await tableRows('attribution_event_bindings')
    const beforeCredentials = await tableRows('attribution_credentials')
    await db.prepare(`
      CREATE TRIGGER reject_connection_audit
      BEFORE INSERT ON admin_audit_logs
      WHEN NEW.action = 'save_attribution_platform_connection'
      BEGIN
        SELECT RAISE(ABORT, 'FORCED_ATOMIC_FAILURE');
      END;
    `).run()

    await expect(savePlatformConnection(env(), metaCommand({
      publicConfig: { provider: 'meta', pixelId: '1277657707436783' },
      credential: { type: 'access_token', plaintext: ROTATED_META_TOKEN },
    }))).rejects.toMatchObject({ code: 'AD_PLATFORM_CONNECTION_WRITE_FAILED' })

    expect(await tableRows('attribution_platform_connections')).toEqual(beforeConnection)
    expect(await tableRows('attribution_event_bindings')).toEqual(beforeBindings)
    expect(await tableRows('attribution_credentials')).toEqual(beforeCredentials)
    expect(await countRows('admin_audit_logs')).toBe(1)
    await expect(readAttributionCredential(env(), {
      connectionId: 'conn_meta',
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: first.credential.revision,
    })).resolves.toBe(META_TOKEN)
  })

  it('凭证校验或加密失败时不发起 D1 batch', async () => {
    const batch = vi.fn(db.batch.bind(db))
    const observedDb = { prepare: db.prepare.bind(db), batch } as unknown as D1Database

    await expect(savePlatformConnection({ DB: observedDb }, metaCommand())).rejects.toMatchObject({
      code: 'AD_PLATFORM_CONNECTION_CREDENTIAL_CRYPTO_UNAVAILABLE',
    })
    expect(batch).not.toHaveBeenCalled()

    await expect(savePlatformConnection(env(observedDb), metaCommand({
      credential: { type: 'service_account_json', plaintext: '{}' },
    }))).rejects.toMatchObject({ code: 'AD_PLATFORM_CONNECTION_CREDENTIAL_INVALID' })
    expect(batch).not.toHaveBeenCalled()
  })

  it('任一保存原子失效旧 verification，并清除尚未完成的测试输入', async () => {
    const first = await savePlatformConnection(env(), metaCommand())
    await db.prepare(`
      INSERT INTO attribution_verifications (
        id, connection_id, provider, connection_revision, credential_revision,
        attempt, status, started_at
      ) VALUES ('verification_old', ?, 'meta', ?, ?, 1, 'verified', datetime('now'))
    `).bind(first.connectionId, first.connectionRevision, first.credential.revision).run()
    await db.prepare(`
      INSERT INTO attribution_verifications (
        id, connection_id, provider, connection_revision, credential_revision,
        attempt, status, evidence_json, started_at
      ) VALUES ('verification_queued', ?, 'meta', ?, ?, 2, 'queued', ?, datetime('now'))
    `).bind(
      first.connectionId,
      first.connectionRevision,
      first.credential.revision,
      JSON.stringify({ schemaVersion: 1, verificationInput: { ciphertext: 'must-clear' } }),
    ).run()

    const command = metaCommand({ mode: 'test' })
    delete command.credential
    const updated = await savePlatformConnection(env(), command)
    const currentVerification = await db.prepare(`
      SELECT verification.id
      FROM attribution_verifications AS verification
      JOIN attribution_platform_connections AS connection ON connection.id = verification.connection_id
      WHERE verification.connection_revision = connection.connection_revision
        AND verification.credential_revision = connection.credential_revision
    `).first<{ id: string }>()

    expect(updated.connectionRevision).not.toBe(first.connectionRevision)
    expect(updated.credential.revision).toBe(first.credential.revision)
    expect(currentVerification).toBeNull()
    const invalidated = await db.prepare(`
      SELECT id, status, evidence_json FROM attribution_verifications ORDER BY attempt
    `).all<{ id: string; status: string; evidence_json: string }>()
    expect(invalidated.results.map(row => row.status)).toEqual(['invalidated', 'invalidated'])
    expect(invalidated.results[1]?.evidence_json).not.toMatch(/ciphertext|must-clear|verificationInput/)
    expect(invalidated.results[1]?.evidence_json).toContain('AD_PLATFORM_VERIFICATION_REVISION_INVALID')
  })

  it('审计与服务返回值不包含明文、密文、IV 或指纹', async () => {
    const result = await savePlatformConnection(env(), metaCommand())
    const audit = await db.prepare(`SELECT before_value, after_value FROM admin_audit_logs`).first<Record<string, unknown>>()
    const exposed = JSON.stringify({ result, audit })

    expect(exposed).not.toContain(META_TOKEN)
    expect(exposed).not.toMatch(/ciphertext|fingerprint|plaintext|\biv\b/i)
    expect(audit?.after_value).toContain('credentialRotated')
  })

  it.each([
    ['未知 provider', () => ({ ...metaCommand(), provider: 'unknown' as never }), 'AD_PLATFORM_CONNECTION_PROVIDER_INVALID'],
    ['config provider 不一致', () => ({ ...metaCommand(), publicConfig: { provider: 'tiktok', pixelCode: 'ABCDEF1234' } as never }), 'AD_PLATFORM_CONNECTION_CONFIG_INVALID'],
    ['config schema 错误', () => ({ ...metaCommand(), publicConfig: { provider: 'meta', pixelId: '', token: META_TOKEN } as never }), 'AD_PLATFORM_CONNECTION_CONFIG_INVALID'],
    ['事件缺失', () => ({ ...metaCommand(), eventBindings: [{ canonicalEvent: 'Contact', enabled: true }] }), 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID'],
    ['事件重复', () => ({ ...metaCommand(), eventBindings: [{ canonicalEvent: 'Contact', enabled: true }, { canonicalEvent: 'Contact', enabled: true }] }), 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID'],
    ['Meta 跨平台 destination', () => ({ ...metaCommand(), eventBindings: [{ canonicalEvent: 'Contact', enabled: true, browserDestination: 'tiktok_pixel' }, { canonicalEvent: 'CompleteRegistration', enabled: true }] }), 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID'],
    ['非法 rollout', () => ({ ...metaCommand(), rolloutTargetPercentage: 25 as never }), 'AD_PLATFORM_CONNECTION_ROLLOUT_INVALID'],
    ['生产连接双出口关闭', () => ({ ...metaCommand(), browserEnabled: false, serverEnabled: false, rolloutTargetPercentage: 0 }), 'AD_PLATFORM_CONNECTION_STATE_INVALID'],
    ['生产连接没有实际投递出口', () => ({ ...metaCommand(), browserEnabled: false, serverEnabled: true, rolloutTargetPercentage: 0 }), 'AD_PLATFORM_CONNECTION_STATE_INVALID'],
  ] as const)('%s 被稳定错误码拒绝', async (_label, command, code) => {
    await expect(savePlatformConnection(env(), command() as SavePlatformConnectionCommand)).rejects.toMatchObject({ code })
    expect(await countRows('attribution_platform_connections')).toBe(0)
  })

  it.each([
    ['Browser 单出口', { browserEnabled: true, serverEnabled: false, rolloutTargetPercentage: 0 as const }],
    ['Server 单出口', { browserEnabled: false, serverEnabled: true, rolloutTargetPercentage: 10 as const }],
  ])('生产连接允许%s', async (_label, overrides) => {
    await expect(savePlatformConnection(env(), metaCommand(overrides))).resolves.toMatchObject(overrides)
  })

  it.each([
    ['tagId 不一致', 'AW-OTHER/CONTACT_LABEL', '123'],
    ['Label 为空', 'AW-123456789/', '123'],
    ['conversion action ID 非数字', 'AW-123456789/CONTACT_LABEL', 'customers/123/conversionActions/456'],
    ['conversion action ID 超长', 'AW-123456789/CONTACT_LABEL', '1'.repeat(21)],
  ])('Google destination %s 时拒绝', async (_label, browserDestination, serverDestination) => {
    const command = googleCommand()
    command.eventBindings[0] = {
      canonicalEvent: 'Contact',
      enabled: true,
      browserDestination,
      serverDestination,
    }
    await expect(savePlatformConnection(env(), command)).rejects.toMatchObject({
      code: 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID',
    })
  })

  it('Google 两个事件必须使用不同 Label 和 conversion action ID', async () => {
    const command = googleCommand()
    command.eventBindings[1] = { ...command.eventBindings[0]!, canonicalEvent: 'CompleteRegistration' }
    await expect(savePlatformConnection(env(), command)).rejects.toMatchObject({
      code: 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID',
    })
  })
})

function env(database: D1Database = db) {
  return {
    DB: database,
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  }
}

function metaCommand(overrides: Partial<SavePlatformConnectionCommand> = {}): SavePlatformConnectionCommand {
  return {
    provider: 'meta',
    enabled: true,
    mode: 'production',
    browserEnabled: true,
    serverEnabled: true,
    publicConfig: { provider: 'meta', pixelId: '1277657707436781' },
    eventBindings: [
      { canonicalEvent: 'Contact', enabled: true },
      { canonicalEvent: 'CompleteRegistration', enabled: true },
    ],
    credential: { type: 'access_token', plaintext: META_TOKEN },
    rolloutTargetPercentage: 100,
    actorId: ACTOR_ID,
    ...overrides,
  }
}

function tiktokCommand(): SavePlatformConnectionCommand {
  return {
    provider: 'tiktok',
    enabled: true,
    mode: 'test',
    browserEnabled: true,
    serverEnabled: true,
    publicConfig: { provider: 'tiktok', pixelCode: 'ABCDEF123456' },
    eventBindings: [
      { canonicalEvent: 'Contact', enabled: true, browserDestination: 'tiktok_pixel', serverDestination: 'tiktok_events_api' },
      { canonicalEvent: 'CompleteRegistration', enabled: true, browserDestination: 'tiktok_pixel', serverDestination: 'tiktok_events_api' },
    ],
    credential: { type: 'access_token', plaintext: 'tiktok-token' },
    rolloutTargetPercentage: 10,
    actorId: ACTOR_ID,
  }
}

function googleCommand(): SavePlatformConnectionCommand {
  return {
    provider: 'google',
    enabled: true,
    mode: 'test',
    browserEnabled: true,
    serverEnabled: true,
    publicConfig: {
      provider: 'google',
      tagId: 'AW-123456789',
      customerId: '1234567890',
      cloudProjectId: 'gallery-project',
    },
    eventBindings: [
      { canonicalEvent: 'Contact', enabled: true, browserDestination: 'AW-123456789/CONTACT_LABEL', serverDestination: '12345678901234567890' },
      { canonicalEvent: 'CompleteRegistration', enabled: true, browserDestination: 'AW-123456789/REGISTRATION_LABEL', serverDestination: '987654321' },
    ],
    credential: { type: 'service_account_json', plaintext: googleCredential },
    rolloutTargetPercentage: 50,
    actorId: ACTOR_ID,
  }
}

async function countRows(table: string) {
  const row = await db.prepare(`SELECT count(*) AS count FROM ${table}`).first<{ count: number }>()
  return row?.count ?? 0
}

async function tableRows(table: string) {
  const result = await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all<Record<string, unknown>>()
  return result.results
}

function toBase64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}

async function validGoogleServiceAccount() {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return JSON.stringify({
    type: 'service_account',
    client_email: 'service@gallery-project.iam.gserviceaccount.com',
    private_key: toPem(pkcs8),
    token_uri: 'https://oauth2.googleapis.com/token',
  })
}

function toPem(bytes: Uint8Array) {
  const body = toBase64(bytes).match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}
