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
    const serviceAccount = JSON.stringify({
      type: 'service_account',
      client_email: 'service@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nkey-material\n-----END PRIVATE KEY-----\n',
      token_uri: 'https://oauth2.googleapis.com/token',
    })

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

function env() {
  return {
    DB: db,
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
