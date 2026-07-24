import { describe, expect, it, vi } from 'vitest'
import {
  exportAndImportAttributionMigration,
} from './attribution-migration-export'

const CREDENTIAL = 'old-api-plaintext-credential'

describe('旧归因运行时导出', () => {
  it('只通过 Service Binding 传递内存凭证，结果和日志不含明文', async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (request.method === 'GET') return migrationNotFound()
      const body = await request.json() as {
        snapshot: {
          connections: Array<{
            credential: { plaintext: string }
          }>
        }
      }
      expect(body.snapshot.connections[0]?.credential.plaintext)
        .toBe(CREDENTIAL)
      expect(body.snapshot.connections[0]?.enabled).toBe(true)
      expect(body.snapshot.liveFacts).toHaveLength(1)
      expect(body.snapshot.historyDaily).toHaveLength(1)
      return Response.json({
        data: {
          runId: 'migration-production-v1',
          snapshotHash: 'a'.repeat(64),
          replayed: false,
          counts: {
            connections: 1,
            versions: 1,
            credentials: 1,
            bindings: 2,
            managedSources: 1,
            liveFacts: 1,
            historyRows: 1,
          },
        },
      })
    })
    const logger = { info: vi.fn(), error: vi.fn() }

    const result = await exportAndImportAttributionMigration(
      fixtureEnvironment(fetch),
      {
        runId: 'migration-production-v1',
        actorId: 1,
        now: new Date('2026-07-24T12:00:00.000Z'),
        logger,
      },
    )

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL)
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(CREDENTIAL)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(CREDENTIAL)
  })

  it('只透传安全上游错误码，不泄漏错误正文或凭证', async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    const fetch = vi.fn(async (request: Request) =>
      request.method === 'GET'
        ? migrationNotFound()
        : Response.json({
            error: {
              code: 'ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY',
              detail: `private-${CREDENTIAL}`,
            },
          }, { status: 409 }))

    await expect(exportAndImportAttributionMigration(
      fixtureEnvironment(fetch),
      {
        runId: 'migration-production-v1',
        actorId: 1,
        now: new Date('2026-07-24T12:00:00.000Z'),
        logger,
      },
    )).rejects.toThrow('ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY')

    expect(JSON.stringify(logger.error.mock.calls))
      .not.toContain(CREDENTIAL)
  })

  it('已完成的 runId 直接返回目标回执且不读取旧库凭证', async () => {
    const readCredential = vi.fn(async () => CREDENTIAL)
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('GET')
      return Response.json({
        data: migrationResult(true),
      })
    })

    const result = await exportAndImportAttributionMigration(
      fixtureEnvironment(fetch, readCredential),
      {
        runId: 'migration-production-v1',
        actorId: 1,
        now: new Date('2026-07-25T12:00:00.000Z'),
      },
    )

    expect(fetch).toHaveBeenCalledOnce()
    expect(readCredential).not.toHaveBeenCalled()
    expect(result).toEqual(migrationResult(true))
  })
})

function fixtureEnvironment(
  fetch: (request: Request) => Promise<Response>,
  readCredential = async () => CREDENTIAL,
) {
  const rows = {
    connections: [{
      id: 'conn_meta',
      provider: 'meta',
      enabled: 1,
      mode: 'production',
      browser_enabled: 1,
      server_enabled: 1,
      public_config_json: '{"pixelId":"1234567890123456"}',
      attribution_window_days: 30,
      rollout_target_percentage: 10,
      rollout_effective_percentage: 10,
      credential_revision: 'credential_meta_v1',
      created_at: '2026-07-16 00:14:19',
      updated_at: '2026-07-23 06:33:27',
    }],
    bindings: [{
      connection_id: 'conn_meta',
      provider: 'meta',
      canonical_event: 'Contact',
      enabled: 1,
      browser_destination: 'meta_pixel',
      server_destination: 'meta_capi',
    }, {
      connection_id: 'conn_meta',
      provider: 'meta',
      canonical_event: 'CompleteRegistration',
      enabled: 1,
      browser_destination: 'meta_pixel',
      server_destination: 'meta_capi',
    }],
    credentials: [{
      connection_id: 'conn_meta',
      provider: 'meta',
      credential_type: 'access_token',
      credential_revision: 'credential_meta_v1',
    }],
    sources: [{
      id: 'ats_meta_us_bj',
      ad_provider: 'meta',
      utm_campaign: 'meta-us-bj',
      utm_medium: 'paid_social',
      utm_content: 'bj',
      link_proof: 'a'.repeat(64),
      status: 'active',
      created_at: '2026-07-21 00:54:56',
    }],
    facts: [{
      id: 'fact_meta_contact',
      canonical_event: 'Contact',
      external_event_id: 'event_meta_contact',
      attribution_provider: 'meta',
      occurred_at: '2026-07-23T03:14:10.336Z',
      dedupe_key: 'contact:visitor:test',
      consent_snapshot_json:
        '{"marketingAllowed":true,"adUserDataAllowed":true,"adPersonalizationAllowed":true}',
      analytics_dimensions_json: '{"sourceChannel":"ad"}',
      created_at: '2026-07-23 03:14:10',
    }],
    history: [{
      date: '2026-07-14',
      canonical_event: 'Contact',
      fact_origin: 'historical_backfill',
      attribution_provider: null,
      attribution_source: 'none',
      fact_count: 37,
      first_occurred_at: '2026-07-12T07:29:19.354Z',
      last_occurred_at: '2026-07-14T10:14:22.743Z',
    }],
    privacy: [{
      default_mode: 'notice_opt_out',
      prior_consent_country_codes_json: '["CH","DE"]',
      policy_version: 2,
      updated_at: '2026-07-18 06:43:16',
    }],
  }
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this },
        async all() {
          if (sql.includes('FROM attribution_platform_connections')) {
            return { results: rows.connections }
          }
          if (sql.includes('FROM attribution_event_bindings')) {
            return { results: rows.bindings }
          }
          if (sql.includes('FROM attribution_credentials')) {
            return { results: rows.credentials }
          }
          if (sql.includes('FROM analytics_tracking_sources')) {
            return { results: rows.sources }
          }
          if (sql.includes('FROM attribution_conversion_facts')) {
            if (sql.includes('COUNT(*) AS fact_count')) {
              expect(sql).toContain(
                "date(datetime(occurred_at, '+8 hours'))",
              )
              return { results: rows.history }
            }
            return { results: rows.facts }
          }
          return { results: [] }
        },
        async first() {
          if (sql.includes('FROM attribution_privacy_policy')) {
            return rows.privacy[0]
          }
          return null
        },
      }
    },
  } as unknown as D1Database

  return {
    DB: db,
    ATTRIBUTION: { fetch },
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT:
      'unused-in-export-test',
    readCredential,
  }
}

function migrationNotFound() {
  return Response.json({
    error: { code: 'ATTRIBUTION_MIGRATION_NOT_FOUND' },
  }, { status: 404 })
}

function migrationResult(replayed: boolean) {
  return {
    runId: 'migration-production-v1',
    snapshotHash: 'a'.repeat(64),
    replayed,
    counts: {
      connections: 1,
      versions: 1,
      credentials: 1,
      bindings: 2,
      managedSources: 1,
      liveFacts: 1,
      historyRows: 1,
    },
  }
}
