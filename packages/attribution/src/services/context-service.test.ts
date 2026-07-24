import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  ATTRIBUTION_CONTEXT_COOKIE,
  issueAttributionContextResponse,
  resolveAttributionContext,
} from './context-service'

const MIGRATION = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')

let miniflare: Miniflare
let db: D1Database
let sequence = 0
let idempotencySequence = 0

const signingKey = 'context-signing-key-current-32-bytes'
const encryptionKey = 'context-encryption-key-current-32-bytes'

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'attribution-context' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  await db.prepare(`
    INSERT INTO attribution_privacy_policy (
      id, default_mode, prior_consent_country_codes_json, policy_version
    ) VALUES ('global', 'prior_consent', '[]', 1)
  `).run()
  await seedConnection()
  sequence = 0
  idempotencySequence = 0
})

describe('第一方归因上下文', () => {
  it('只通过安全 HttpOnly Cookie 返回且篡改后失效', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'explicit' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_meta_a',
      identifiers: {
        fbclid: 'fb-click-a',
        ttclid: 'foreign-tiktok-click',
        gclid: 'foreign-google-click',
      },
      idempotencyKey: nextIdempotencyKey(),
    })
    const setCookie = response.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toMatch(
      /__Secure-mg_attribution_context=.*HttpOnly.*Secure.*SameSite=Lax.*Domain=\.616618\.xyz/i,
    )

    const token = cookieValue(setCookie)
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain(token)
    expect(body).not.toHaveProperty('sourceContextToken')

    const stored = await db.prepare(`
      SELECT identifiers_envelope_json
      FROM attribution_contexts
      LIMIT 1
    `).first<{ identifiers_envelope_json: string }>()
    expect(stored?.identifiers_envelope_json).not.toContain('fb-click-a')
    expect(stored?.identifiers_envelope_json)
      .not.toContain('foreign-tiktok-click')
    expect(stored?.identifiers_envelope_json)
      .not.toContain('foreign-google-click')
    expect(JSON.parse(stored?.identifiers_envelope_json ?? '{}')).toMatchObject({
      schemaVersion: 1,
    })

    expect(await resolveAttributionContext(environment(), token)).toMatchObject({
      provider: 'meta',
      connectionId: 'conn_meta_a',
      sourceId: 'source_meta_a',
      identifiers: { fbclid: 'fb-click-a' },
    })

    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    await expect(resolveAttributionContext(environment(), tampered))
      .rejects.toThrow('ATTRIBUTION_CONTEXT_INVALID')
  })

  it('D1 拒绝将 click ID 明文写入上下文字段', async () => {
    await expect(db.prepare(`
      INSERT INTO attribution_contexts (
        id, provider, connection_id, source_id,
        identifiers_envelope_json, issued_at, expires_at
      ) VALUES (
        'context_plaintext', 'meta', 'conn_meta_a', NULL,
        '{"fbclid":"plaintext-click"}', 1000, 2000
      )
    `).run()).rejects.toThrow()
    expect(await countContexts()).toBe(0)
  })

  it('非 granted 状态不签发上下文', async () => {
    await expect(issueAttributionContextResponse(environment(), {
      privacyDecision: {
        state: 'choice_required',
        reason: 'prior_consent_region',
      },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_meta_a',
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })).rejects.toThrow('ATTRIBUTION_CONTEXT_NOT_GRANTED')

    expect(await countContexts()).toBe(0)
  })

  it('来源 provider 与连接不一致时拒绝签发', async () => {
    await db.prepare(`
      INSERT INTO attribution_managed_sources (
        id, provider, connection_id, campaign, medium, content,
        proof_hash, enabled
      ) VALUES (
        'source_tiktok_wrong', 'tiktok', 'conn_meta_a', 'cross-provider',
        'paid_social', 'creative-wrong',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1
      )
    `).run()

    await expect(issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'regional_default' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_tiktok_wrong',
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })).rejects.toThrow('ATTRIBUTION_CONTEXT_INVALID')
    expect(await countContexts()).toBe(0)
  })

  it.each([
    [
      'tiktok',
      'conn_tiktok_a',
      {
        fbclid: 'foreign-meta-click',
        ttclid: 'tiktok-click',
        gclid: 'foreign-google-click',
      },
      { ttclid: 'tiktok-click' },
    ],
    [
      'google',
      'conn_google_a',
      {
        fbclid: 'foreign-meta-click',
        ttclid: 'foreign-tiktok-click',
        gclid: 'google-click',
        gbraid: 'google-gbraid',
        wbraid: 'google-wbraid',
      },
      {
        gclid: 'google-click',
        gbraid: 'google-gbraid',
        wbraid: 'google-wbraid',
      },
    ],
  ] as const)(
    '%s 上下文只保留本平台 click ID',
    async (provider, connectionId, identifiers, expected) => {
      await seedProviderConnection(provider, connectionId)
      const response = await issueAttributionContextResponse(environment(), {
        privacyDecision: { state: 'granted', reason: 'explicit' },
        route: { provider, connectionId },
        sourceId: null,
        identifiers,
        idempotencyKey: nextIdempotencyKey(),
      })
      const token = cookieValue(response.headers.get('Set-Cookie') ?? '')

      expect(await resolveAttributionContext(environment(), token))
        .toMatchObject({ provider, connectionId, identifiers: expected })
    },
  )

  it('连接停用后既有上下文不再建立路由', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'regional_default' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: null,
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })
    const token = cookieValue(response.headers.get('Set-Cookie') ?? '')

    await db.prepare(`
      UPDATE attribution_runtime_policies
      SET enabled = 0
      WHERE connection_id = 'conn_meta_a'
    `).run()

    await expect(resolveAttributionContext(environment(), token))
      .rejects.toThrow('ATTRIBUTION_CONTEXT_INVALID')
  })

  it('来源自然过期只阻止新访问，不追溯销毁已签发上下文', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'regional_default' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_meta_a',
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })
    const token = cookieValue(response.headers.get('Set-Cookie') ?? '')

    await db.prepare(`
      UPDATE attribution_managed_sources
      SET expires_at = '2025-01-01T00:00:00.000Z'
      WHERE id = 'source_meta_a'
    `).run()

    expect(await resolveAttributionContext(environment(), token)).toMatchObject({
      connectionId: 'conn_meta_a',
      sourceId: 'source_meta_a',
    })
  })

  it('来源被人工停用后立即撤销既有上下文', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'regional_default' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_meta_a',
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })
    const token = cookieValue(response.headers.get('Set-Cookie') ?? '')

    await db.prepare(`
      UPDATE attribution_managed_sources
      SET enabled = 0
      WHERE id = 'source_meta_a'
    `).run()

    await expect(resolveAttributionContext(environment(), token))
      .rejects.toThrow('ATTRIBUTION_CONTEXT_INVALID')
  })

  it('来源被删除后级联撤销既有上下文', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'regional_default' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_meta_a',
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })
    const token = cookieValue(response.headers.get('Set-Cookie') ?? '')

    await db.prepare(`
      DELETE FROM attribution_managed_sources
      WHERE id = 'source_meta_a'
    `).run()

    expect(await countContexts()).toBe(0)
    await expect(resolveAttributionContext(environment(), token))
      .rejects.toThrow('ATTRIBUTION_CONTEXT_INVALID')
  })

  it('Active 切换后上下文仍解析连接但明确区分签发版本', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'regional_default' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: null,
      identifiers: {},
      idempotencyKey: nextIdempotencyKey(),
    })
    const token = cookieValue(response.headers.get('Set-Cookie') ?? '')
    await db.batch([
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'draining',
            draining_at = '2026-07-24T06:00:00.000Z'
        WHERE id = 'ver_meta_a'
      `),
      db.prepare(`
        INSERT INTO attribution_connection_versions (
          id, connection_id, provider, status, public_config_json,
          config_hash, created_by, activated_at
        ) VALUES (
          'ver_meta_b', 'conn_meta_a', 'meta', 'active', '{}',
          'hash_meta_b', 1, '2026-07-24T06:00:00.000Z'
        )
      `),
      db.prepare(`
        UPDATE attribution_connections
        SET active_version_id = 'ver_meta_b'
        WHERE id = 'conn_meta_a'
      `),
    ])

    expect(await resolveAttributionContext(environment(), token)).toMatchObject({
      connectionId: 'conn_meta_a',
      issuedVersionId: 'ver_meta_a',
    })
  })

  it('签名密钥轮换后 previous 仍可验证既有上下文', async () => {
    const response = await issueAttributionContextResponse(environment(), {
      privacyDecision: { state: 'granted', reason: 'explicit' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: null,
      identifiers: { fbclid: 'fb-key-rotation' },
      idempotencyKey: nextIdempotencyKey(),
    })
    const token = cookieValue(response.headers.get('Set-Cookie') ?? '')

    expect(await resolveAttributionContext({
      ...environment(),
      signingKeys: {
        current: 'context-signing-key-next-with-32-bytes',
        previous: signingKey,
      },
      encryptionKeys: {
        current: 'context-encryption-key-next-with-32-bytes',
        previous: encryptionKey,
      },
    }, token)).toMatchObject({
      connectionId: 'conn_meta_a',
      identifiers: { fbclid: 'fb-key-rotation' },
    })
  })

  it('相同幂等命令返回同一上下文且不重复写入', async () => {
    const input = {
      privacyDecision: { state: 'granted', reason: 'explicit' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: 'source_meta_a',
      identifiers: { fbclid: 'fb-idempotent' },
      idempotencyKey: 'context-idempotent-a',
    } as const

    const [first, second] = await Promise.all([
      issueAttributionContextResponse(environment(), input),
      issueAttributionContextResponse(environment(), input),
    ])
    expect(cookieValue(first.headers.get('Set-Cookie') ?? '')).toBe(
      cookieValue(second.headers.get('Set-Cookie') ?? ''),
    )
    expect(await countContexts()).toBe(1)
    expect(await countContextReceipts()).toBe(1)
  })

  it('相同幂等键的不同请求被拒绝', async () => {
    const input = {
      privacyDecision: { state: 'granted', reason: 'explicit' },
      route: { provider: 'meta', connectionId: 'conn_meta_a' },
      sourceId: null,
      identifiers: { fbclid: 'fb-original' },
      idempotencyKey: 'context-conflict-a',
    } as const
    await issueAttributionContextResponse(environment(), input)

    await expect(issueAttributionContextResponse(environment(), {
      ...input,
      identifiers: { fbclid: 'fb-changed' },
    })).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
    expect(await countContexts()).toBe(1)
  })
})

function environment() {
  return {
    db,
    signingKeys: { current: signingKey },
    encryptionKeys: { current: encryptionKey },
    cookieDomain: '.616618.xyz',
    nowSeconds: () => 1_753_336_800,
    idFactory: (prefix: string) => `${prefix}_${++sequence}`,
  }
}

function cookieValue(setCookie: string): string {
  const match = new RegExp(`${ATTRIBUTION_CONTEXT_COOKIE}=([^;]+)`).exec(
    setCookie,
  )
  if (!match?.[1]) throw new Error('context cookie missing')
  return match[1]
}

async function countContexts(): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM attribution_contexts
  `).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function countContextReceipts(): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM attribution_command_receipts
    WHERE command_type = 'issue_attribution_context'
  `).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

function nextIdempotencyKey(): string {
  idempotencySequence += 1
  return `context-command-${idempotencySequence}`
}

async function seedConnection() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta_a', 'meta', 'meta-a', 'ver_meta_a')
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_meta_a', 'conn_meta_a', 'meta', 'active', '{}',
        'hash_meta_a', 1, '2026-07-24T06:00:00.000Z'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by
      ) VALUES ('conn_meta_a', 1, 1, 1, 10, 10, 'closed', 1)
    `),
    db.prepare(`
      INSERT INTO attribution_managed_sources (
        id, provider, connection_id, campaign, medium, content,
        proof_hash, enabled
      ) VALUES (
        'source_meta_a', 'meta', 'conn_meta_a', 'launch',
        'paid_social', 'creative-a',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1
      )
    `),
  ])
}

async function seedProviderConnection(
  provider: 'meta' | 'tiktok' | 'google',
  connectionId: string,
) {
  const versionId = `ver_${connectionId}`
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES (?, ?, ?, ?)
    `).bind(connectionId, provider, connectionId, versionId),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (?, ?, ?, 'active', '{}', ?, 1, ?)
    `).bind(
      versionId,
      connectionId,
      provider,
      `hash_${connectionId}`,
      '2026-07-24T06:00:00.000Z',
    ),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by
      ) VALUES (?, 1, 1, 1, 10, 10, 'closed', 1)
    `).bind(connectionId),
  ])
}
