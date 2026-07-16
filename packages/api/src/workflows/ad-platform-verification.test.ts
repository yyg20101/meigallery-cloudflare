import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import { saveAttributionCredential } from '../services/ad-platform/credential-vault'

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    protected env: unknown
    constructor(_ctx: unknown, env: unknown) { this.env = env }
  },
}))

import {
  AdPlatformVerificationWorkflow,
  createWorkflowId,
  startPlatformVerification,
  submitPlatformVerificationEvidence,
  type AdPlatformVerificationEnv,
} from './ad-platform-verification'

const MIGRATION = readFileSync(new URL('../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const MASTER_KEY = btoa(Array.from({ length: 32 }, (_, index) => String.fromCharCode(index + 1)).join(''))
const CONNECTION_REVISION = 'r_1234567890abcdef12345678'
const CREDENTIAL_REVISION = 'c_1234567890abcdef12345678'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000059' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const statement of unstable_splitSqlQuery(MIGRATION)) await db.prepare(statement).run()
  await db.prepare(`
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, action TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      before_value TEXT NOT NULL, after_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run()
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM admin_audit_logs;
    DELETE FROM attribution_verifications;
    DELETE FROM attribution_credentials;
    DELETE FROM attribution_event_bindings;
    DELETE FROM attribution_platform_connections;
  `)
  await db.prepare(`
    INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
      rollout_target_percentage, rollout_effective_percentage, connection_revision, credential_revision
    ) VALUES ('conn_meta', 'meta', 1, 'production', 1, 1, ?, 0, 0, ?, ?)
  `).bind(JSON.stringify({ pixelId: '1277657707436781' }), CONNECTION_REVISION, CREDENTIAL_REVISION).run()
  await db.batch((['Contact', 'CompleteRegistration'] as const).map(event => db.prepare(`
    INSERT INTO attribution_event_bindings (
      id, connection_id, provider, canonical_event, enabled,
      browser_destination, server_destination, mapping_revision, config_json
    ) VALUES (?, 'conn_meta', 'meta', ?, 1, 'meta_pixel', 'meta_capi', ?, '{}')
  `).bind(`binding_${event}`, event, CONNECTION_REVISION)))
  await saveAttributionCredential(baseEnv(), {
    connectionId: 'conn_meta',
    provider: 'meta',
    credentialType: 'access_token',
    plaintext: 'meta-access-token',
    credentialRevision: CREDENTIAL_REVISION,
    createdBy: 1,
  })
})

afterAll(async () => miniflare.dispose())

describe('广告平台验证 Workflow', () => {
  it('重复验证返回同一实例，重新验证才增加 attempt', async () => {
    const workflow = workflowBinding()
    const env = fullEnv(workflow)
    const first = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST90001' })
    const repeated = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST99999' })
    const restarted = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST90002', reverify: true })

    expect(repeated.id).toBe(first.id)
    expect(repeated.attempt).toBe(1)
    expect(restarted.attempt).toBe(2)
    expect(restarted.id).not.toBe(first.id)
    expect(workflow.ids).toEqual([first.id, restarted.id])
    const rows = await db.prepare('SELECT evidence_json FROM attribution_verifications ORDER BY attempt').all<{ evidence_json: string }>()
    expect(JSON.stringify(rows.results)).not.toMatch(/TEST90001|TEST90002|TEST99999/)
  })

  it('自动验证后清除测试码密文，人工证据完成后 revision 仍一致才通过', async () => {
    const workflow = workflowBinding()
    const env = fullEnv(workflow)
    await db.prepare(`
      UPDATE attribution_platform_connections SET rollout_target_percentage = 10
      WHERE provider = 'meta'
    `).run()
    const started = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST90001' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events_received: 2 }), { status: 200 })))

    const instance = new AdPlatformVerificationWorkflow({} as ExecutionContext, env)
    const result = await instance.run(workflowEvent(started.id), workflowStep({ confirmed: true, actorId: 1, reference: 'Events Manager 已确认成对事件' }))
    const row = await db.prepare('SELECT status, evidence_json FROM attribution_verifications WHERE id = ?')
      .bind(started.id).first<{ status: string; evidence_json: string }>()

    expect(result).toEqual({ status: 'verified' })
    expect(row?.status).toBe('verified')
    expect(row?.evidence_json).not.toMatch(/ciphertext|verificationInput|TEST90001|meta-access-token/)
    expect(JSON.parse(row!.evidence_json)).toMatchObject({
      schemaVersion: 1,
      automatic: { provider: 'meta', testEventsSent: 2 },
      human: { confirmed: true },
    })
    const rollout = await db.prepare(`
      SELECT rollout_target_percentage, rollout_effective_percentage
      FROM attribution_platform_connections WHERE provider = 'meta'
    `).first<{ rollout_target_percentage: number; rollout_effective_percentage: number }>()
    expect(rollout).toMatchObject({ rollout_target_percentage: 10, rollout_effective_percentage: 10 })
    vi.unstubAllGlobals()
  })

  it('等待人工证据超时后只保留脱敏结果，测试输入不可读取', async () => {
    const env = fullEnv(workflowBinding())
    const started = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST90001' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events_received: 2 }), { status: 200 })))
    const instance = new AdPlatformVerificationWorkflow({} as ExecutionContext, env)
    const result = await instance.run(workflowEvent(started.id), workflowStep(new Error('timeout')))
    const row = await db.prepare('SELECT status, evidence_json FROM attribution_verifications WHERE id = ?')
      .bind(started.id).first<{ status: string; evidence_json: string }>()

    expect(result).toEqual({ status: 'timed_out' })
    expect(row?.status).toBe('timed_out')
    expect(row?.evidence_json).not.toMatch(/ciphertext|verificationInput|TEST90001|meta-access-token/)
    vi.unstubAllGlobals()
  })

  it('平台拒绝自动验证后清除测试码密文和凭证明文', async () => {
    const env = fullEnv(workflowBinding())
    const started = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST90001' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events_received: 0 }), { status: 400 })))
    const instance = new AdPlatformVerificationWorkflow({} as ExecutionContext, env)
    const result = await instance.run(workflowEvent(started.id), workflowStep({ confirmed: true, actorId: 1 }))
    const row = await db.prepare('SELECT status, evidence_json FROM attribution_verifications WHERE id = ?')
      .bind(started.id).first<{ status: string; evidence_json: string }>()

    expect(result).toMatchObject({ status: 'failed' })
    expect(row?.status).toBe('failed')
    expect(row?.evidence_json).not.toMatch(/ciphertext|verificationInput|TEST90001|meta-access-token/)
    expect(JSON.parse(row!.evidence_json)).toMatchObject({
      schemaVersion: 1,
      failureCode: 'AD_PLATFORM_VERIFICATION_PROVIDER_REJECTED',
    })
    const rollout = await db.prepare(`
      SELECT rollout_effective_percentage FROM attribution_platform_connections WHERE provider = 'meta'
    `).first<{ rollout_effective_percentage: number }>()
    expect(rollout?.rollout_effective_percentage).toBe(0)
    vi.unstubAllGlobals()
  })

  it('人工确认只向所属 Workflow 发送最小事件', async () => {
    const workflow = workflowBinding()
    const env = fullEnv(workflow)
    const started = await startPlatformVerification(env, { provider: 'meta', actorId: 1, testEventCode: 'TEST90001' })
    await db.prepare("UPDATE attribution_verifications SET status = 'awaiting_human_evidence' WHERE id = ?")
      .bind(started.id).run()
    await submitPlatformVerificationEvidence(env, {
      provider: 'meta',
      verificationId: started.id,
      actorId: 1,
      reference: 'Meta 后台已确认',
    })
    expect(workflow.events).toEqual([{
      id: started.id,
      event: { type: 'human-evidence', payload: { confirmed: true, actorId: 1, reference: 'Meta 后台已确认' } },
    }])
  })

  it('超长业务元组使用固定摘要，始终满足 Cloudflare 100 字符限制', async () => {
    const id = await createWorkflowId({
      provider: 'google',
      connectionId: 'connection_' + 'a'.repeat(150),
      connectionRevision: 'revision_' + 'b'.repeat(150),
      credentialRevision: 'credential_' + 'c'.repeat(150),
      attempt: 999,
    })
    expect(id).toMatch(/^verify-google-[A-Za-z0-9_-]{43}$/)
    expect(id.length).toBeLessThanOrEqual(100)
  })

  it('普通业务元组同样生成不含冒号的稳定 Workflow ID', async () => {
    const input = {
      provider: 'meta' as const,
      connectionId: 'conn_meta',
      connectionRevision: CONNECTION_REVISION,
      credentialRevision: CREDENTIAL_REVISION,
      attempt: 1,
    }
    const first = await createWorkflowId(input)
    const repeated = await createWorkflowId(input)

    expect(first).toBe(repeated)
    expect(first).toMatch(/^verify-meta-[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain(':')
  })
})

function baseEnv() {
  return {
    DB: db,
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  }
}

function fullEnv(workflow: ReturnType<typeof workflowBinding>): AdPlatformVerificationEnv {
  return {
    ...baseEnv(),
    APP_ENV: 'production',
    SITE_URL: 'https://616618.xyz',
    AD_PLATFORM_VERIFICATION_WORKFLOW: workflow as unknown as Workflow<{ verificationId: string }>,
  }
}

function workflowBinding() {
  const ids: string[] = []
  const events: Array<{ id: string; event: unknown }> = []
  const instances = new Set<string>()
  return {
    ids,
    events,
    async createBatch(items: Array<{ id: string }>) {
      const created = []
      for (const item of items) {
        if (instances.has(item.id)) continue
        instances.add(item.id)
        ids.push(item.id)
        created.push({ id: item.id })
      }
      return created
    },
    async get(id: string) {
      if (!instances.has(id)) throw new Error('not found')
      return {
        id,
        async sendEvent(event: unknown) { events.push({ id, event }) },
      }
    },
  }
}

function workflowEvent(verificationId: string) {
  return {
    payload: { verificationId },
    timestamp: new Date(),
    instanceId: verificationId,
    workflowName: 'test',
  }
}

function workflowStep(evidence: unknown) {
  return {
    async do(_name: string, configOrCallback: unknown, maybeCallback?: unknown) {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback
      return (callback as () => Promise<unknown>)()
    },
    async waitForEvent() {
      if (evidence instanceof Error) throw evidence
      return { payload: evidence, timestamp: new Date(), type: 'human-evidence' }
    },
  } as unknown as WorkflowStep
}
