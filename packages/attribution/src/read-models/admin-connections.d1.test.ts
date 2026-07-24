import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  listAdminAttributionConnections,
  readAdminAttributionConnection,
} from './admin-connections'
import {
  listAdminAttributionIncidents,
  parseAdminAttributionIncidentProvider,
} from './admin-incidents'
import { readAdminAttributionPrivacyPolicy } from './admin-privacy'
import { listAdminAttributionQuality } from './admin-quality'

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
    d1Databases: { DB: 'admin-attribution-read-models' },
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
      id,
      default_mode,
      prior_consent_country_codes_json,
      policy_version,
      updated_at
    ) VALUES (
      'global',
      'prior_consent',
      '[]',
      1,
      '2026-07-24T00:00:00.000Z'
    )
  `).run()
})

describe('管理员归因只读模型', () => {
  it('无连接、质量和 Incident 时返回稳定空态', async () => {
    await expect(listAdminAttributionConnections(db)).resolves.toEqual([])
    await expect(
      readAdminAttributionConnection(db, 'connection_missing'),
    ).resolves.toBeNull()
    await expect(
      listAdminAttributionQuality(db, {}),
    ).resolves.toEqual([])
    await expect(
      listAdminAttributionIncidents(db, {}),
    ).resolves.toEqual([])
    await expect(
      readAdminAttributionPrivacyPolicy(db),
    ).resolves.toEqual({
      availability: 'available',
      defaultMode: 'prior_consent',
      priorConsentCountryCodes: [],
      policyVersion: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
    })
  })

  it('无 Active 的新连接即使 runtime disabled 仍是未配置', async () => {
    await db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, is_default
      ) VALUES ('connection_new', 'meta', 'Meta 新连接', 0)
    `).run()
    await db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id,
        enabled,
        browser_enabled,
        server_enabled,
        server_target_percentage,
        server_effective_percentage,
        circuit_state,
        updated_by
      ) VALUES ('connection_new', 0, 0, 0, 0, 0, 'closed', 7)
    `).run()

    await expect(
      readAdminAttributionConnection(db, 'connection_new'),
    ).resolves.toMatchObject({
      state: 'not_configured',
      activeTarget: '',
      runtime: { enabled: false },
    })
  })

  it('已有 Active 且 runtime disabled 时才显示停用', async () => {
    await seedConnection({
      id: 'connection_disabled',
      provider: 'meta',
      name: 'Meta 停用连接',
      activeId: 'active_disabled',
      publicConfig: { pixelId: '1615446443914929' },
    })
    await db.prepare(`
      UPDATE attribution_runtime_policies
      SET enabled = 0,
          browser_enabled = 0,
          server_enabled = 0,
          server_target_percentage = 0,
          server_effective_percentage = 0
      WHERE connection_id = 'connection_disabled'
    `).run()

    await expect(
      readAdminAttributionConnection(db, 'connection_disabled'),
    ).resolves.toMatchObject({
      state: 'disabled',
      activeTarget: '1615446443914929',
      runtime: { enabled: false },
    })
  })

  it('同 provider 多连接并列且覆盖四种候选状态', async () => {
    await seedConnection({
      id: 'connection_meta_a',
      provider: 'meta',
      name: 'Meta 美国团队',
      activeId: 'active_meta_a',
      publicConfig: { pixelId: '1615446443914929' },
    })
    await seedConnection({
      id: 'connection_meta_b',
      provider: 'meta',
      name: 'Meta 欧洲团队',
      activeId: 'active_meta_b',
      publicConfig: { pixelId: '1566612068298913' },
      candidate: {
        id: 'candidate_meta_b',
        status: 'candidate',
        createdAt: '2026-07-24T01:00:00.000Z',
      },
      circuitState: 'server_open',
    })
    await seedConnection({
      id: 'connection_tiktok',
      provider: 'tiktok',
      name: 'TikTok 团队',
      activeId: 'active_tiktok',
      publicConfig: { pixelCode: 'D9AF43RC77U133LMNMM0' },
      candidate: {
        id: 'candidate_tiktok',
        status: 'validating',
        createdAt: '2026-07-24T02:00:00.000Z',
      },
    })
    await seedConnection({
      id: 'connection_google',
      provider: 'google',
      name: 'Google 团队',
      activeId: 'active_google',
      publicConfig: {
        tagId: 'AW-123456789',
        customerId: '1234567890',
        cloudProjectId: 'meigallery-ads',
      },
      candidate: {
        id: 'candidate_google',
        status: 'ready',
        createdAt: '2026-07-24T03:00:00.000Z',
      },
    })
    await seedFailedVersion(
      'failed_meta_old',
      'connection_meta_a',
      'meta',
      'META_OLD_FAILURE',
      '2026-07-24T04:00:00.000Z',
    )
    await seedFailedVersion(
      'failed_meta_latest',
      'connection_meta_a',
      'meta',
      'META_LATEST_FAILURE',
      '2026-07-24T05:00:00.000Z',
    )

    const views = await listAdminAttributionConnections(db)
    expect(views).toHaveLength(4)
    expect(views.filter(view => view.provider === 'meta')).toHaveLength(2)
    expect(candidateState(views, 'connection_meta_a')).toEqual({
      state: 'failed',
      createdAt: '2026-07-24T05:00:00.000Z',
      failureCode: 'META_LATEST_FAILURE',
      productionContinues: true,
    })
    expect(candidateState(views, 'connection_meta_b')?.state).toBe(
      'candidate',
    )
    expect(candidateState(views, 'connection_tiktok')?.state).toBe(
      'validating',
    )
    expect(candidateState(views, 'connection_google')?.state).toBe(
      'ready',
    )
    expect(connection(views, 'connection_meta_a')).toMatchObject({
      state: 'active',
      activeTarget: '1615446443914929',
      runtime: { enabled: true },
    })
    expect(connection(views, 'connection_meta_b').health.level).toBe(
      'warning',
    )
  })

  it('严格输出公开目标且不泄露版本、候选或凭据材料', async () => {
    await seedConnection({
      id: 'connection_google',
      provider: 'google',
      name: 'Google 团队',
      activeId: 'active_google',
      publicConfig: {
        tagId: 'AW-123456789',
        customerId: '1234567890',
        cloudProjectId: 'meigallery-ads',
      },
    })
    await db.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id,
        provider,
        schema_version,
        key_id,
        iv,
        ciphertext,
        tag,
        credential_fingerprint
      ) VALUES (?, 'google', 1, ?, ?, ?, ?, ?)
    `).bind(
      'active_google',
      'credential-key-secret',
      'credential-iv-secret',
      'credential-ciphertext-secret',
      'credential-tag-secret',
      'credential-fingerprint-secret',
    ).run()

    const view = await readAdminAttributionConnection(
      db,
      'connection_google',
    )
    expect(view?.activeTarget).toBe('AW-123456789')
    expect(JSON.stringify(view)).not.toMatch(
      /versionId|candidateId|fingerprint|keyId|ciphertext|token|commit|revision/i,
    )
    expect(JSON.stringify(view)).not.toContain('1234567890')
    expect(JSON.stringify(view)).not.toContain('meigallery-ads')
    expect(JSON.stringify(view)).not.toContain('credential-')
  })

  it('Active 公开配置损坏时按快照错误关闭，不伪装成请求错误', async () => {
    await seedConnection({
      id: 'connection_invalid',
      provider: 'meta',
      name: 'Meta 损坏连接',
      activeId: 'active_invalid',
      publicConfig: { pixelId: 'invalid-pixel' },
    })

    await expect(readAdminAttributionConnection(
      db,
      'connection_invalid',
    )).rejects.toMatchObject({
      code: 'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
    })
  })

  it('健康状态优先 critical 并读取最后一次 delivery 时间', async () => {
    await seedConnection({
      id: 'connection_meta',
      provider: 'meta',
      name: 'Meta 团队',
      activeId: 'active_meta',
      publicConfig: { pixelId: '1615446443914929' },
    })
    await seedDelivery(
      'connection_meta',
      'active_meta',
      '2026-07-24T08:30:00.000Z',
    )
    await seedIncident({
      id: 'incident_warning',
      connectionId: 'connection_meta',
      provider: 'meta',
      severity: 'warning',
      status: 'open',
      code: 'quality_unavailable',
    })
    await seedIncident({
      id: 'incident_critical',
      connectionId: 'connection_meta',
      provider: 'meta',
      severity: 'critical',
      status: 'open',
      code: 'server_delivery_failed',
    })

    const view = await readAdminAttributionConnection(
      db,
      'connection_meta',
    )
    expect(view?.health).toEqual({
      level: 'critical',
      lastDeliveryAt: '2026-07-24T08:30:00.000Z',
    })
  })

  it('质量、Incident 和隐私 View 只返回日报与稳定脱敏字段', async () => {
    await seedConnection({
      id: 'connection_meta',
      provider: 'meta',
      name: 'Meta 团队',
      activeId: 'active_meta',
      publicConfig: { pixelId: '1615446443914929' },
    })
    await db.prepare(`
      INSERT INTO attribution_quality_daily (
        date,
        provider,
        connection_id,
        metric_key,
        numerator,
        denominator,
        value,
        availability
      ) VALUES (
        '2026-07-24',
        'meta',
        'connection_meta',
        'event_match_quality',
        8,
        10,
        0.8,
        'available'
      )
    `).run()
    await seedIncident({
      id: 'incident_resolved',
      connectionId: 'connection_meta',
      provider: 'meta',
      severity: 'warning',
      status: 'resolved',
      code: 'quality_unavailable',
      resolution: 'quality_recovered',
      resolvedAt: '2026-07-24T09:00:00.000Z',
    })
    await db.prepare(`
      UPDATE attribution_privacy_policy
      SET default_mode = 'notice_opt_out',
          prior_consent_country_codes_json = '["DE","FR"]',
          policy_version = 2,
          updated_at = '2026-07-24T09:30:00.000Z'
      WHERE id = 'global'
    `).run()

    const quality = await listAdminAttributionQuality(db, {
      dateFrom: '2026-07-24',
      dateTo: '2026-07-24',
      provider: 'meta',
      connectionId: 'connection_meta',
    })
    const incidents = await listAdminAttributionIncidents(db, {
      status: 'resolved',
      provider: 'meta',
    })
    const privacy = await readAdminAttributionPrivacyPolicy(db)

    expect(quality).toEqual([{
      date: '2026-07-24',
      provider: 'meta',
      connectionId: 'connection_meta',
      connectionName: 'Meta 团队',
      metricKey: 'event_match_quality',
      numerator: 8,
      denominator: 10,
      value: 0.8,
      availability: 'available',
    }])
    expect(incidents).toEqual([{
      id: 'incident_resolved',
      provider: 'meta',
      connectionId: 'connection_meta',
      connectionName: 'Meta 团队',
      severity: 'warning',
      code: 'quality_unavailable',
      affectedChannel: 'server',
      affectedEvent: '',
      openedAt: '2026-07-24T08:00:00.000Z',
      detectedAt: '2026-07-24T08:01:00.000Z',
      recoveredAt: '2026-07-24T09:00:00.000Z',
      affectedFactCount: 3,
      affectedDeliveryCount: 2,
      automaticAction: 'quality_recovered',
      recoveryStatus: 'recovered',
    }])
    expect(privacy).toEqual({
      availability: 'available',
      defaultMode: 'notice_opt_out',
      priorConsentCountryCodes: ['DE', 'FR'],
      policyVersion: 2,
      updatedAt: '2026-07-24T09:30:00.000Z',
    })
    expect(JSON.stringify({
      quality,
      incidents,
      privacy,
    })).not.toMatch(
      /versionId|candidateId|fingerprint|keyId|ciphertext|token|commit|revision/i,
    )
  })

  it('系统 Incident 来源安全透传且未知平台仍严格拒绝', () => {
    expect(parseAdminAttributionIncidentProvider('cloudflare')).toBe(
      'cloudflare',
    )
    expect(parseAdminAttributionIncidentProvider('system')).toBe('system')
    expect(parseAdminAttributionIncidentProvider('meta')).toBe('meta')
    expect(() => parseAdminAttributionIncidentProvider('meta-typo'))
      .toThrow('ATTRIBUTION_PROVIDER_UNSUPPORTED')
  })

  it('隐私策略缺失或 D1 异常时显式返回不可用', async () => {
    await db.prepare(`
      DELETE FROM attribution_privacy_policy
      WHERE id = 'global'
    `).run()
    await expect(readAdminAttributionPrivacyPolicy(db)).resolves.toEqual({
      availability: 'unavailable',
      defaultMode: null,
      priorConsentCountryCodes: [],
      policyVersion: null,
      updatedAt: '',
    })

    const failedDb = {
      prepare() {
        throw new Error('D1 unavailable')
      },
    } as unknown as D1Database
    await expect(
      readAdminAttributionPrivacyPolicy(failedDb),
    ).resolves.toEqual({
      availability: 'error',
      defaultMode: null,
      priorConsentCountryCodes: [],
      policyVersion: null,
      updatedAt: '',
    })
  })
})

type Provider = 'meta' | 'tiktok' | 'google'
type CandidateState = 'candidate' | 'validating' | 'ready'

interface SeedConnectionInput {
  id: string
  provider: Provider
  name: string
  activeId: string
  publicConfig: Record<string, string>
  candidate?: {
    id: string
    status: CandidateState
    createdAt: string
  }
  circuitState?: 'closed' | 'server_open'
}

async function seedConnection(
  input: SeedConnectionInput,
): Promise<void> {
  await db.prepare(`
    INSERT INTO attribution_connections (
      id, provider, name, is_default
    ) VALUES (?, ?, ?, 0)
  `).bind(input.id, input.provider, input.name).run()
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
    ) VALUES (?, ?, ?, 'active', ?, ?, 7, ?, ?)
  `).bind(
    input.activeId,
    input.id,
    input.provider,
    JSON.stringify(input.publicConfig),
    `hash_${input.activeId}`,
    '2026-07-24T00:00:00.000Z',
    '2026-07-24T00:00:00.000Z',
  ).run()
  await db.prepare(`
    UPDATE attribution_connections
    SET active_version_id = ?
    WHERE id = ?
  `).bind(input.activeId, input.id).run()
  await db.prepare(`
    INSERT INTO attribution_runtime_policies (
      connection_id,
      enabled,
      browser_enabled,
      server_enabled,
      server_target_percentage,
      server_effective_percentage,
      circuit_state,
      updated_by
    ) VALUES (?, 1, 1, 1, 10, ?, ?, 7)
  `).bind(
    input.id,
    input.circuitState === 'server_open' ? 0 : 10,
    input.circuitState ?? 'closed',
  ).run()
  if (input.candidate) {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 7, ?)
    `).bind(
      input.candidate.id,
      input.id,
      input.provider,
      input.activeId,
      input.candidate.status,
      JSON.stringify(input.publicConfig),
      `hash_${input.candidate.id}`,
      input.candidate.createdAt,
    ).run()
  }
}

async function seedFailedVersion(
  id: string,
  connectionId: string,
  provider: Provider,
  failureCode: string,
  createdAt: string,
): Promise<void> {
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
      failure_code
    ) VALUES (?, ?, ?, 'failed', '{}', ?, 7, ?, ?)
  `).bind(
    id,
    connectionId,
    provider,
    `hash_${id}`,
    createdAt,
    failureCode,
  ).run()
}

async function seedDelivery(
  connectionId: string,
  versionId: string,
  updatedAt: string,
): Promise<void> {
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
    ) VALUES (
      'fact_health',
      'event_health',
      'Contact',
      'live',
      ?,
      ?,
      ?,
      ?,
      'meta',
      'external_health',
      ?,
      '{}',
      '{}'
    )
  `).bind(
    'a'.repeat(64),
    'b'.repeat(64),
    connectionId,
    versionId,
    updatedAt,
  ).run()
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
      created_at,
      updated_at
    ) VALUES (
      'delivery_health',
      'fact_health',
      ?,
      ?,
      'meta',
      'server',
      'meta_capi',
      'external_health',
      'processed',
      ?,
      ?
    )
  `).bind(connectionId, versionId, updatedAt, updatedAt).run()
}

interface SeedIncidentInput {
  id: string
  connectionId: string
  provider: Provider
  severity: 'warning' | 'critical'
  status: 'open' | 'resolved'
  code: string
  resolution?: string
  resolvedAt?: string
}

async function seedIncident(input: SeedIncidentInput): Promise<void> {
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
      detected_at,
      resolved_at,
      resolution
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'server', 3, 2,
      '2026-07-24T08:00:00.000Z',
      '2026-07-24T08:01:00.000Z',
      ?,
      ?
    )
  `).bind(
    input.id,
    input.provider,
    input.connectionId,
    input.severity,
    input.status,
    input.code,
    input.resolvedAt ?? null,
    input.resolution ?? '',
  ).run()
}

function connection(
  views: Awaited<ReturnType<typeof listAdminAttributionConnections>>,
  id: string,
) {
  const view = views.find(item => item.id === id)
  if (!view) throw new Error(`missing connection ${id}`)
  return view
}

function candidateState(
  views: Awaited<ReturnType<typeof listAdminAttributionConnections>>,
  id: string,
) {
  return connection(views, id).candidate
}
