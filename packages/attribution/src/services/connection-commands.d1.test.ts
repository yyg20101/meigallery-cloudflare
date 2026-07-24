import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  createAttributionConnectionCommands,
  type CreateCandidateInput,
  type CreateConnectionInput,
} from './connection-commands'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'

const MIGRATION = readFileSync(
  new URL('../../migrations/0001_attribution_runtime.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-07-24T00:00:00.000Z')

let miniflare: Miniflare
let db: D1Database
let idSequence = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'connection-commands' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  idSequence = 0
})

describe('归因连接命令', () => {
  it('新候选 supersede 旧候选且同 provider 可有多个连接', async () => {
    const commands = createCommands()
    await commands.createConnection(connectionInput('conn_meta_a', 'meta', true))
    const first = await commands.createCandidate(
      candidateInput('conn_meta_a', 'pixel-a', 'candidate-a'),
    )
    const second = await commands.createCandidate(
      candidateInput('conn_meta_a', 'pixel-b', 'candidate-b'),
    )

    expect((await version(first.id)).status).toBe('superseded')
    expect((await version(second.id)).status).toBe('candidate')
    expect(await credentialExists(first.id)).toBe(false)
    expect(await credentialExists(second.id)).toBe(true)

    await commands.createConnection(connectionInput('conn_meta_b', 'meta', false))
    expect(await connectionCount('meta')).toBe(2)
  })

  it('同 provider 不允许两个默认连接', async () => {
    const commands = createCommands()
    await commands.createConnection(connectionInput('conn_meta_a', 'meta', true))

    await expect(commands.createConnection(
      connectionInput('conn_meta_b', 'meta', true),
    )).rejects.toThrow('ATTRIBUTION_DEFAULT_CONNECTION_CONFLICT')
  })

  it('候选语义幂等不新增版本或审计，idempotency key 冲突 fail closed', async () => {
    const commands = createCommands()
    await commands.createConnection(connectionInput('conn_meta', 'meta', true))
    const input = candidateInput('conn_meta', 'pixel-a', 'candidate-a')
    const first = await commands.createCandidate(input)
    const versionCountBefore = await scalar(
      'SELECT COUNT(*) AS value FROM attribution_connection_versions',
    )
    const auditCountBefore = await scalar(
      'SELECT COUNT(*) AS value FROM attribution_audit_logs',
    )

    const duplicate = await commands.createCandidate({
      ...input,
      idempotencyKey: 'candidate-a-retry',
    })

    expect(duplicate.id).toBe(first.id)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_connection_versions',
    )).toBe(versionCountBefore)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_audit_logs',
    )).toBe(auditCountBefore)

    await expect(commands.createCandidate({
      ...candidateInput('conn_meta', 'pixel-b', 'candidate-a'),
    })).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  })

  it('stale base 激活失败且故障注入会原子回滚旧 Active', async () => {
    const commands = createCommands()
    await commands.createConnection(connectionInput('conn_meta', 'meta', true))
    const oldActive = await readyCandidate(commands, 'pixel-a', 'first')
    await commands.activateCandidate({
      connectionId: 'conn_meta',
      candidateId: oldActive.id,
      expectedBaseActiveVersionId: null,
      idempotencyKey: 'activate-first',
      actorId: 1,
    })

    const next = await readyCandidate(commands, 'pixel-b', 'second')
    expect(await activeVersionId('conn_meta')).toBe(oldActive.id)
    await expect(commands.activateCandidate({
      connectionId: 'conn_meta',
      candidateId: next.id,
      expectedBaseActiveVersionId: 'other_active',
      idempotencyKey: 'activate-stale',
      actorId: 1,
    })).rejects.toThrow('ATTRIBUTION_ACTIVE_VERSION_CHANGED')
    expect(await activeVersionId('conn_meta')).toBe(oldActive.id)

    await db.prepare(`
      CREATE TRIGGER inject_activation_failure
      BEFORE UPDATE OF status ON attribution_connection_versions
      WHEN OLD.id = '${next.id}' AND NEW.status = 'active'
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_ACTIVATION_FAILURE');
      END;
    `).run()
    await expect(commands.activateCandidate({
      connectionId: 'conn_meta',
      candidateId: next.id,
      expectedBaseActiveVersionId: oldActive.id,
      idempotencyKey: 'activate-injected',
      actorId: 1,
    })).rejects.toThrow()
    expect(await activeVersionId('conn_meta')).toBe(oldActive.id)
    expect((await version(oldActive.id)).status).toBe('active')
    expect((await version(next.id)).status).toBe('ready')
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_activation_fences',
    )).toBe(0)
    await db.exec('DROP TRIGGER inject_activation_failure')
  })

  it('激活、重试、回滚和禁用均保持原子与幂等', async () => {
    const commands = createCommands()
    await commands.createConnection(connectionInput('conn_meta', 'meta', true))
    const first = await readyCandidate(commands, 'pixel-a', 'first')
    await commands.activateCandidate({
      connectionId: 'conn_meta',
      candidateId: first.id,
      expectedBaseActiveVersionId: null,
      idempotencyKey: 'activate-first',
      actorId: 1,
    })
    const second = await readyCandidate(commands, 'pixel-b', 'second')
    const activation = {
      connectionId: 'conn_meta',
      candidateId: second.id,
      expectedBaseActiveVersionId: first.id,
      idempotencyKey: 'activate-second',
      actorId: 1,
    } as const
    const activated = await commands.activateCandidate(activation)
    const auditCount = await scalar(
      'SELECT COUNT(*) AS value FROM attribution_audit_logs',
    )

    expect((await commands.activateCandidate(activation)).activeVersionId)
      .toBe(activated.activeVersionId)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_audit_logs',
    )).toBe(auditCount)
    expect((await version(first.id)).status).toBe('draining')

    const rolledBack = await commands.rollbackActiveVersion({
      connectionId: 'conn_meta',
      targetVersionId: first.id,
      expectedActiveVersionId: second.id,
      idempotencyKey: 'rollback-first',
      actorId: 1,
    })
    expect(rolledBack.activeVersionId).toBe(first.id)
    expect((await version(first.id)).status).toBe('active')
    expect((await version(second.id)).status).toBe('retired')

    const policy = await commands.disableConnection({
      connectionId: 'conn_meta',
      idempotencyKey: 'disable-meta',
      actorId: 1,
    })
    expect(policy.enabled).toBe(false)
    expect(policy.serverEffectivePercentage).toBe(0)
  })
})

function createCommands() {
  return createAttributionConnectionCommands({
    db,
    credentialKeys: {
      current: '0123456789abcdef0123456789abcdef',
    },
    now: () => NOW,
    idFactory: prefix => `${prefix}_${++idSequence}`,
  })
}

function connectionInput(
  id: string,
  provider: 'meta' | 'tiktok' | 'google',
  isDefault: boolean,
): CreateConnectionInput {
  return {
    id,
    provider,
    name: id,
    isDefault,
    idempotencyKey: `create-${id}`,
    actorId: 1,
  }
}

function candidateInput(
  connectionId: string,
  pixelId: string,
  idempotencyKey: string,
): CreateCandidateInput {
  return {
    connectionId,
    publicConfig: { pixelId },
    bindings: [
      {
        canonicalEvent: 'Contact',
        enabled: true,
        browserDestination: 'meta_pixel',
        serverDestination: 'meta_capi',
      },
      {
        canonicalEvent: 'CompleteRegistration',
        enabled: true,
        browserDestination: 'meta_pixel',
        serverDestination: 'meta_capi',
      },
    ],
    credential: `token-${pixelId}`,
    idempotencyKey,
    actorId: 1,
  }
}

async function readyCandidate(
  commands: ReturnType<typeof createCommands>,
  pixelId: string,
  suffix: string,
) {
  const candidate = await commands.createCandidate(
    candidateInput('conn_meta', pixelId, `candidate-${suffix}`),
  )
  await commands.beginCandidateValidation({
    connectionId: 'conn_meta',
    candidateId: candidate.id,
    idempotencyKey: `validate-${suffix}`,
    actorId: 1,
  })
  return commands.markCandidateReady({
    connectionId: 'conn_meta',
    candidateId: candidate.id,
    idempotencyKey: `ready-${suffix}`,
    actorId: 1,
  })
}

async function version(id: string) {
  const row = await db.prepare(`
    SELECT id, status
    FROM attribution_connection_versions
    WHERE id = ?
  `).bind(id).first<{ id: string; status: string }>()
  if (!row) throw new Error('测试版本不存在')
  return row
}

async function activeVersionId(connectionId: string) {
  const row = await db.prepare(`
    SELECT active_version_id
    FROM attribution_connections
    WHERE id = ?
  `).bind(connectionId).first<{ active_version_id: string | null }>()
  return row?.active_version_id ?? null
}

async function connectionCount(provider: string) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS value
    FROM attribution_connections
    WHERE provider = ?
  `).bind(provider).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

async function credentialExists(versionId: string) {
  return Boolean(await db.prepare(`
    SELECT version_id
    FROM attribution_version_credentials
    WHERE version_id = ?
  `).bind(versionId).first())
}

async function scalar(sql: string) {
  const row = await db.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
