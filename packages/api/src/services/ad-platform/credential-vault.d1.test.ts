import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import {
  readAttributionCredential,
  saveAttributionCredential,
} from './credential-vault'

const MASTER_KEY = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const CONNECTION_ID = 'connection-001'
const CREDENTIAL_REVISION = 'credential-revision-001'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000051' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  const schema = `
    CREATE TABLE attribution_platform_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE
    );
    CREATE TABLE attribution_credentials (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      key_id TEXT NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      tag TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      credential_revision TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (connection_id, credential_type, credential_revision)
    );
  `
  for (const statement of unstable_splitSqlQuery(schema)) await db.prepare(statement).run()
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM attribution_credentials;
    DELETE FROM attribution_platform_connections;
    INSERT INTO attribution_platform_connections (id, provider) VALUES ('${CONNECTION_ID}', 'meta');
  `)
})

afterAll(async () => miniflare.dispose())

describe('归因凭证 D1 库', () => {
  it('将 Meta access_token 加密保存，数据库只含密文元数据和截断指纹', async () => {
    const plaintext = `token-${crypto.randomUUID()}`
    const saved = await saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      plaintext,
      credentialRevision: CREDENTIAL_REVISION,
      createdBy: 41,
    })
    const row = await db.prepare(`SELECT * FROM attribution_credentials`).first<Record<string, unknown>>()

    expect(saved).toMatchObject({ credentialRevision: CREDENTIAL_REVISION })
    expect(row).toMatchObject({
      connection_id: CONNECTION_ID,
      provider: 'meta',
      credential_type: 'access_token',
      schema_version: 1,
      credential_revision: CREDENTIAL_REVISION,
      created_by: 41,
    })
    expect(String(row?.fingerprint)).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(row)).not.toContain(plaintext)
    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: CREDENTIAL_REVISION,
    })).resolves.toBe(plaintext)
  })

  it('替换凭证使用单个 D1 原子 batch，并保留失败前的凭证', async () => {
    const first = `token-${crypto.randomUUID()}`
    const second = `token-${crypto.randomUUID()}`
    await saveAttributionCredential(env(), metaInput(first, CREDENTIAL_REVISION))

    await expect(saveAttributionCredential(env(), {
      ...metaInput(second, 'credential-revision-002'),
      credentialType: 'service_account_json',
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID' })
    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: CREDENTIAL_REVISION,
    })).resolves.toBe(first)

    await saveAttributionCredential(env(), metaInput(second, 'credential-revision-002'))
    const rows = await db.prepare(`SELECT credential_revision FROM attribution_credentials`).all<{ credential_revision: string }>()
    expect(rows.results).toEqual([{ credential_revision: 'credential-revision-002' }])
  })

  it('Google 仅接受完整且结构有效的 service_account_json', async () => {
    await db.prepare(`UPDATE attribution_platform_connections SET provider = 'google' WHERE id = ?`)
      .bind(CONNECTION_ID).run()
    const serviceAccount = await validGoogleServiceAccount()

    await expect(saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'google',
      credentialType: 'service_account_json',
      plaintext: serviceAccount,
      credentialRevision: CREDENTIAL_REVISION,
      createdBy: 41,
    })).resolves.toMatchObject({ credentialRevision: CREDENTIAL_REVISION })
    await expect(saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'google',
      credentialType: 'access_token',
      plaintext: `token-${crypto.randomUUID()}`,
      credentialRevision: 'credential-revision-002',
      createdBy: 41,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID' })

    const forgedKey = await validGoogleServiceAccount({
      private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-pkcs8-key\n-----END PRIVATE KEY-----',
    })
    const forgedError = await captureError(() => saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'google',
      credentialType: 'service_account_json',
      plaintext: forgedKey,
      credentialRevision: 'credential-revision-003',
      createdBy: 41,
    }))
    expect(forgedError).toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID' })
    expect(String((forgedError as Error).message)).not.toMatch(/private_key|client_email|token_uri/i)

    await expect(saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'google',
      credentialType: 'service_account_json',
      plaintext: await validGoogleServiceAccount({ type: 'user_account' }),
      credentialRevision: 'credential-revision-004',
      createdBy: 41,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID' })
    await expect(saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'google',
      credentialType: 'service_account_json',
      plaintext: await validGoogleServiceAccount({ client_email: 'service@example.com' }),
      credentialRevision: 'credential-revision-005',
      createdBy: 41,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID' })
    await expect(saveAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'google',
      credentialType: 'service_account_json',
      plaintext: await validGoogleServiceAccount({ token_uri: 'https://example.com/token' }),
      credentialRevision: 'credential-revision-006',
      createdBy: 41,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID' })
  })

  it('precheck 后连接 provider 被替换时，原子写入拒绝且旧凭证保持不变', async () => {
    const first = `token-${crypto.randomUUID()}`
    await saveAttributionCredential(env(), metaInput(first, CREDENTIAL_REVISION))
    const racingDb = replaceConnectionBeforeBatch()

    await expect(saveAttributionCredential(env(racingDb), metaInput(
      `token-${crypto.randomUUID()}`,
      'credential-revision-002',
    ))).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_WRITE_FAILED' })
    await expect(db.prepare(`
      SELECT credential_revision FROM attribution_credentials
      WHERE connection_id = ? AND provider = ? AND credential_type = ?
    `).bind(CONNECTION_ID, 'meta', 'access_token').first<{ credential_revision: string }>())
      .resolves.toEqual({ credential_revision: CREDENTIAL_REVISION })
    await db.prepare(`UPDATE attribution_platform_connections SET provider = 'meta' WHERE id = ?`)
      .bind(CONNECTION_ID).run()
    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: CREDENTIAL_REVISION,
    })).resolves.toBe(first)
  })

  it('读取凭证时连接 provider 不匹配视为不存在', async () => {
    const plaintext = `token-${crypto.randomUUID()}`
    await saveAttributionCredential(env(), metaInput(plaintext, CREDENTIAL_REVISION))
    await db.prepare(`UPDATE attribution_platform_connections SET provider = 'tiktok' WHERE id = ?`)
      .bind(CONNECTION_ID).run()

    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: CREDENTIAL_REVISION,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_NOT_FOUND' })
  })

  it('错误 provider、错误 revision 和篡改密文均不泄漏内部细节', async () => {
    const plaintext = `token-${crypto.randomUUID()}`
    await saveAttributionCredential(env(), metaInput(plaintext, CREDENTIAL_REVISION))
    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'tiktok',
      credentialType: 'access_token',
      credentialRevision: CREDENTIAL_REVISION,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_NOT_FOUND' })
    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: 'credential-revision-002',
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_NOT_FOUND' })

    await db.prepare(`UPDATE attribution_credentials SET ciphertext = 'AA' WHERE connection_id = ?`)
      .bind(CONNECTION_ID).run()
    await expect(readAttributionCredential(env(), {
      connectionId: CONNECTION_ID,
      provider: 'meta',
      credentialType: 'access_token',
      credentialRevision: CREDENTIAL_REVISION,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CREDENTIAL_DECRYPT_FAILED' })
  })
})

function env(database: D1Database = db) {
  return {
    DB: database,
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  }
}

function metaInput(plaintext: string, credentialRevision: string) {
  return {
    connectionId: CONNECTION_ID,
    provider: 'meta' as const,
    credentialType: 'access_token' as const,
    plaintext,
    credentialRevision,
    createdBy: 41,
  }
}

function toBase64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}

function replaceConnectionBeforeBatch() {
  let replaced = false
  return {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      if (!replaced) {
        replaced = true
        await db.prepare(`UPDATE attribution_platform_connections SET provider = 'tiktok' WHERE id = ?`)
          .bind(CONNECTION_ID).run()
      }
      return db.batch(statements)
    },
  } as D1Database
}

async function validGoogleServiceAccount(overrides: Record<string, string> = {}) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return JSON.stringify({
    type: 'service_account',
    client_email: 'service@example-project.iam.gserviceaccount.com',
    private_key: toPem(pkcs8),
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  })
}

function toPem(bytes: Uint8Array) {
  const body = toBase64(bytes).match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

async function captureError(run: () => Promise<unknown>) {
  try {
    await run()
  }
  catch (error) {
    return error
  }
  throw new Error('EXPECTED_ERROR_NOT_THROWN')
}
