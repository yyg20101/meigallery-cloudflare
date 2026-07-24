import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  listAdminAttributionAudit,
} from './admin-audit'
import {
  listAdminAttributionBindings,
} from './admin-bindings'
import {
  listAdminAttributionIncidents,
} from './admin-incidents'
import {
  listAdminAttributionOperations,
} from './admin-operations'
import {
  listAdminAttributionVerifications,
} from './admin-verifications'

const MIGRATION = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
].map(path => readFileSync(
  new URL(path, import.meta.url),
  'utf8',
)).join('\n')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'admin-attribution-operations' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
})

describe('管理员归因运营读模型', () => {
  it('空库返回稳定空集合', async () => {
    await expect(
      listAdminAttributionOperations(db, {
        dateFrom: '2026-07-24',
        dateTo: '2026-07-24',
      }),
    ).resolves.toEqual([])
    await expect(listAdminAttributionBindings(db, {}))
      .resolves.toEqual([])
    await expect(listAdminAttributionVerifications(db, {}))
      .resolves.toEqual([])
    await expect(listAdminAttributionAudit(db, {}))
      .resolves.toEqual([])
  })

  it('业务事实、归因事实和投递阶段使用独立口径', async () => {
    await seedConnection()
    await seedFact({
      id: 'fact_contact',
      eventName: 'Contact',
      connectionId: 'connection_meta_us',
      versionId: 'version_meta_active',
      provider: 'meta',
      externalEventId: 'external_contact',
      dedupeChar: 'a',
    })
    await seedFact({
      id: 'fact_registration',
      eventName: 'CompleteRegistration',
      connectionId: 'connection_meta_us',
      versionId: 'version_meta_active',
      provider: 'meta',
      externalEventId: 'external_registration',
      dedupeChar: 'b',
    })
    await seedFact({
      id: 'fact_unattributed',
      eventName: 'Contact',
      connectionId: null,
      versionId: null,
      provider: null,
      externalEventId: null,
      dedupeChar: 'c',
    })
    await seedFact({
      id: 'fact_synthetic',
      eventName: 'Contact',
      connectionId: 'connection_meta_us',
      versionId: 'version_meta_candidate',
      provider: 'meta',
      externalEventId: 'external_synthetic',
      dedupeChar: 'd',
      factOrigin: 'synthetic',
    })
    await seedDelivery({
      id: 'delivery_browser_contact',
      factId: 'fact_contact',
      transport: 'browser',
      status: 'accepted',
      queueAttemptCount: 0,
    })
    await db.prepare(`
      INSERT INTO attribution_browser_receipts (
        delivery_id, attempted_at, created_at
      ) VALUES (
        'delivery_browser_contact',
        '2026-07-23T16:10:00.000Z',
        '2026-07-23T16:10:00.000Z'
      )
    `).run()
    await seedDelivery({
      id: 'delivery_server_contact',
      factId: 'fact_contact',
      transport: 'server',
      status: 'processed',
      queueAttemptCount: 1,
    })
    await seedDelivery({
      id: 'delivery_server_registration',
      factId: 'fact_registration',
      transport: 'server',
      status: 'accepted',
      queueAttemptCount: 1,
    })
    await seedDelivery({
      id: 'delivery_server_synthetic',
      factId: 'fact_synthetic',
      transport: 'server',
      status: 'processed',
      queueAttemptCount: 1,
      versionId: 'version_meta_candidate',
    })

    const rows = await listAdminAttributionOperations(db, {
      dateFrom: '2026-07-24',
      dateTo: '2026-07-24',
    })

    expect(rows).toEqual([
      {
        date: '2026-07-24',
        provider: 'meta',
        connectionId: 'connection_meta_us',
        connectionName: '美国 BJ 团队',
        contactCount: 1,
        completeRegistrationCount: 1,
        factCount: 2,
        attributedFactCount: 2,
        unattributedFactCount: 0,
        browserAttempted: 1,
        serverPlanned: 2,
        serverQueued: 2,
        serverProcessed: 2,
        serverRejected: 0,
        serverDeadLetter: 0,
      },
      {
        date: '2026-07-24',
        provider: null,
        connectionId: '',
        connectionName: '',
        contactCount: 1,
        completeRegistrationCount: 0,
        factCount: 1,
        attributedFactCount: 0,
        unattributedFactCount: 1,
        browserAttempted: 0,
        serverPlanned: 0,
        serverQueued: 0,
        serverProcessed: 0,
        serverRejected: 0,
        serverDeadLetter: 0,
      },
    ])
  })

  it('事件映射只返回 Active 与候选差异，不泄露内部版本', async () => {
    await seedConnection()
    await seedBindings(
      'version_meta_active',
      'meta_pixel',
      'meta_capi',
    )
    await seedBindings(
      'version_meta_candidate',
      'meta_pixel_v2',
      'meta_capi_v2',
    )

    const rows = await listAdminAttributionBindings(db, {
      connectionId: 'connection_meta_us',
    })

    expect(rows).toEqual([{
      provider: 'meta',
      connectionId: 'connection_meta_us',
      connectionName: '美国 BJ 团队',
      active: {
        state: 'active',
        bindings: expect.arrayContaining([
          expect.objectContaining({
            canonicalEvent: 'Contact',
            browserDestination: 'meta_pixel',
            serverDestination: 'meta_capi',
          }),
        ]),
      },
      candidate: {
        state: 'validating',
        bindings: expect.arrayContaining([
          expect.objectContaining({
            canonicalEvent: 'Contact',
            browserDestination: 'meta_pixel_v2',
            serverDestination: 'meta_capi_v2',
          }),
        ]),
      },
    }])
    expect(JSON.stringify(rows)).not.toMatch(
      /versionId|candidateId|credential|fingerprint|token|commit|revision/i,
    )
  })

  it('验证历史只公开状态与证据摘要', async () => {
    await seedConnection()
    await db.prepare(`
      INSERT INTO attribution_validations (
        id,
        candidate_version_id,
        provider,
        status,
        evidence_json,
        failure_code,
        started_at,
        completed_at,
        created_at
      ) VALUES (
        'validation_internal_secret',
        'version_meta_candidate',
        'meta',
        'verified',
        '{"candidate":{"connected":true},"browserPairing":{"pairedEvents":2,"externalEventIds":["secret-a","secret-b"]}}',
        '',
        '2026-07-24T01:01:00.000Z',
        '2026-07-24T01:03:00.000Z',
        '2026-07-24T01:00:00.000Z'
      )
    `).run()

    const rows = await listAdminAttributionVerifications(db, {
      dateFrom: '2026-07-24',
      dateTo: '2026-07-24',
    })

    expect(rows).toEqual([{
      provider: 'meta',
      connectionId: 'connection_meta_us',
      connectionName: '美国 BJ 团队',
      status: 'verified',
      failureCode: '',
      candidateChecked: true,
      pairedEventCount: 2,
      createdAt: '2026-07-24T01:00:00.000Z',
      startedAt: '2026-07-24T01:01:00.000Z',
      completedAt: '2026-07-24T01:03:00.000Z',
    }])
    expect(JSON.stringify(rows)).not.toContain('validation_internal_secret')
    expect(JSON.stringify(rows)).not.toContain('secret-a')
  })

  it('审计日志不返回内部命令详情和身份材料', async () => {
    await seedConnection()
    await db.prepare(`
      INSERT INTO attribution_audit_logs (
        id,
        actor_id,
        command_type,
        connection_id,
        outcome,
        detail_json,
        created_at
      ) VALUES (
        'audit_internal',
        7,
        'create_candidate',
        'connection_meta_us',
        'candidate',
        '{"versionId":"version_internal","configHash":"hash_internal"}',
        '2026-07-24T02:00:00.000Z'
      )
    `).run()

    const rows = await listAdminAttributionAudit(db, {
      dateFrom: '2026-07-24',
      dateTo: '2026-07-24',
    })

    expect(rows).toEqual([{
      provider: 'meta',
      connectionId: 'connection_meta_us',
      connectionName: '美国 BJ 团队',
      actorId: 7,
      commandType: 'create_candidate',
      outcome: 'candidate',
      summary: '创建身份候选',
      createdAt: '2026-07-24T02:00:00.000Z',
    }])
    expect(JSON.stringify(rows)).not.toContain('version_internal')
    expect(JSON.stringify(rows)).not.toContain('hash_internal')
  })

  it('Incident 单日筛选使用北京时间自然日', async () => {
    await seedConnection()
    await db.prepare(`
      INSERT INTO attribution_incidents (
        id,
        provider,
        connection_id,
        severity,
        status,
        code,
        affected_transport,
        affected_fact_count,
        affected_delivery_count,
        opened_at,
        detected_at
      ) VALUES
        (
          'incident_before_day',
          'meta',
          'connection_meta_us',
          'warning',
          'open',
          'before_beijing_day',
          'server',
          1,
          1,
          '2026-07-23T15:59:59.000Z',
          '2026-07-23T15:59:59.000Z'
        ),
        (
          'incident_in_day',
          'meta',
          'connection_meta_us',
          'critical',
          'open',
          'inside_beijing_day',
          'server',
          2,
          3,
          '2026-07-23T16:00:00.000Z',
          '2026-07-23T16:00:00.000Z'
        )
    `).run()

    const rows = await listAdminAttributionIncidents(db, {
      dateFrom: '2026-07-24',
      dateTo: '2026-07-24',
    })

    expect(rows).toEqual([{
      id: 'incident_in_day',
      provider: 'meta',
      connectionId: 'connection_meta_us',
      connectionName: '美国 BJ 团队',
      severity: 'critical',
      code: 'inside_beijing_day',
      affectedChannel: 'server',
      affectedEvent: '',
      openedAt: '2026-07-23T16:00:00.000Z',
      detectedAt: '2026-07-23T16:00:00.000Z',
      recoveredAt: '',
      affectedFactCount: 2,
      affectedDeliveryCount: 3,
      automaticAction: '',
      recoveryStatus: 'active',
    }])
  })
})

async function seedConnection(): Promise<void> {
  await db.prepare(`
    INSERT INTO attribution_connections (
      id, provider, name, is_default, active_version_id
    ) VALUES (
      'connection_meta_us',
      'meta',
      '美国 BJ 团队',
      1,
      NULL
    )
  `).run()
  await db.prepare(`
    INSERT INTO attribution_connection_versions (
      id,
      connection_id,
      provider,
      status,
      public_config_json,
      config_hash,
      created_by,
      created_at,
      activated_at
    ) VALUES (
      'version_meta_active',
      'connection_meta_us',
      'meta',
      'active',
      '{"pixelId":"1615446443914929"}',
      'active_hash',
      7,
      '2026-07-24T00:00:00.000Z',
      '2026-07-24T00:00:00.000Z'
    )
  `).run()
  await db.prepare(`
    UPDATE attribution_connections
    SET active_version_id = 'version_meta_active'
    WHERE id = 'connection_meta_us'
  `).run()
  await db.prepare(`
    INSERT INTO attribution_connection_versions (
      id,
      connection_id,
      provider,
      base_active_version_id,
      status,
      public_config_json,
      config_hash,
      created_by,
      created_at
    ) VALUES (
      'version_meta_candidate',
      'connection_meta_us',
      'meta',
      'version_meta_active',
      'validating',
      '{"pixelId":"1566612068298913"}',
      'candidate_hash',
      7,
      '2026-07-24T01:00:00.000Z'
    )
  `).run()
}

interface SeedFactInput {
  id: string
  eventName: 'Contact' | 'CompleteRegistration'
  connectionId: string | null
  versionId: string | null
  provider: 'meta' | null
  externalEventId: string | null
  dedupeChar: string
  factOrigin?: 'live' | 'synthetic'
}

async function seedFact(input: SeedFactInput): Promise<void> {
  await db.prepare(`
    INSERT INTO attribution_facts (
      id,
      event_id,
      event_name,
      fact_origin,
      dedupe_hash,
      event_fingerprint,
      connection_id,
      version_id,
      provider,
      external_event_id,
      occurred_at,
      consent_json,
      analytics_dimensions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}')
  `).bind(
    input.id,
    `event_${input.id}`,
    input.eventName,
    input.factOrigin ?? 'live',
    input.dedupeChar.repeat(64),
    input.dedupeChar.toUpperCase().repeat(64).toLowerCase(),
    input.connectionId,
    input.versionId,
    input.provider,
    input.externalEventId,
    '2026-07-23T16:05:00.000Z',
  ).run()
}

interface SeedDeliveryInput {
  id: string
  factId: string
  transport: 'browser' | 'server'
  status: 'accepted' | 'processed'
  queueAttemptCount: number
  versionId?: string
}

async function seedDelivery(
  input: SeedDeliveryInput,
): Promise<void> {
  await db.prepare(`
    INSERT INTO attribution_deliveries (
      id,
      fact_id,
      connection_id,
      version_id,
      provider,
      transport,
      destination,
      external_event_id,
      status,
      queue_attempt_count,
      created_at,
      updated_at
    ) VALUES (
      ?,
      ?,
      'connection_meta_us',
      ?,
      'meta',
      ?,
      ?,
      ?,
      ?,
      ?,
      '2026-07-23T16:06:00.000Z',
      '2026-07-23T16:10:00.000Z'
    )
  `).bind(
    input.id,
    input.factId,
    input.versionId ?? 'version_meta_active',
    input.transport,
    input.transport === 'browser' ? 'meta_pixel' : 'meta_capi',
    `external_${input.id}`,
    input.status,
    input.queueAttemptCount,
  ).run()
}

async function seedBindings(
  versionId: string,
  browserDestination: string,
  serverDestination: string,
): Promise<void> {
  for (const eventName of ['Contact', 'CompleteRegistration'] as const) {
    await db.prepare(`
      INSERT INTO attribution_version_bindings (
        version_id,
        canonical_event,
        enabled,
        browser_destination,
        server_destination
      ) VALUES (?, ?, 1, ?, ?)
    `).bind(
      versionId,
      eventName,
      browserDestination,
      serverDestination,
    ).run()
  }
}
