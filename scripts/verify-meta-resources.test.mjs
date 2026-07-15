import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hasNoPendingMigrations,
  hasVerifiedMetaConnection,
  main,
  requestLiveResourceAttestations,
  resolveFullSecretIsolation,
  runMetaResourceVerification,
  validateProductionAttestation,
} from './verify-meta-resources.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const NOW = '2026-07-11T00:00:00.000Z'
const NONCE = `nonce_${'a'.repeat(64)}`
const IDENTITIES = {
  pixel: `hmac-sha256:${'1'.repeat(64)}`,
  token: `hmac-sha256:${'2'.repeat(64)}`,
  dataKey: `hmac-sha256:${'4'.repeat(64)}`,
}

describe('Meta production 资源检查', () => {
  it('默认使用 production，并拒绝 dev 远端验证', async () => {
    await assert.rejects(
      runMetaResourceVerification({ environment: 'dev' }),
      /仅支持 production/,
    )
    await assert.rejects(
      main(['--env', 'dev'], { runCommand: async () => ({ status: 'failed' }) }),
      /仅支持 production|用法/,
    )
  })

  it('production attestation 校验当前 commit、TTL 和全部摘要', () => {
    assert.deepEqual(validateProductionAttestation({
      schemaVersion: 2,
      environment: 'production',
      commitSha: COMMIT,
      nonce: NONCE,
      issuedAt: NOW,
      expiresAt: '2026-07-11T00:05:00.000Z',
      identities: IDENTITIES,
    }, { commit: COMMIT, nonce: NONCE, now: NOW }), {
      pixel: true,
      token: true,
      dataKey: true,
    })
  })

  it('attestation 只访问 production origin，最终请求不携带 Cookie', async () => {
    const calls = []
    const origin = 'https://production.example'
    const fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/resource-attestation-ticket')) {
        return responseAt(url, { data: {
          schemaVersion: 1,
          environment: 'production',
          commitSha: COMMIT,
          nonce: NONCE,
          ticket: `mrat_${'b'.repeat(64)}`,
          issuedAt: NOW,
          expiresAt: '2026-07-11T00:01:00.000Z',
        } })
      }
      return responseAt(url, { data: {
        schemaVersion: 2,
        environment: 'production',
        commitSha: COMMIT,
        nonce: NONCE,
        issuedAt: NOW,
        expiresAt: '2026-07-11T00:05:00.000Z',
        identities: IDENTITIES,
      } })
    }

    const result = await requestLiveResourceAttestations({
      commit: COMMIT,
      nonce: NONCE,
      now: NOW,
      fetch,
      env: {
        VERIFY_META_API_URL: origin,
        VERIFY_PRODUCTION_OWNER_SESSION_COOKIE: 'mei_session=owner',
      },
    })

    assert.deepEqual(result, { pixel: true, token: true, dataKey: true })
    assert.equal(calls.length, 2)
    assert.equal(calls.every(call => call.url.startsWith(origin)), true)
    assert.equal(calls[0].init.headers.Cookie, 'mei_session=owner')
    assert.equal(Object.hasOwn(calls[1].init.headers, 'Cookie'), false)
  })

  it('attestation 拒绝跳转后的响应地址', async () => {
    await assert.rejects(requestLiveResourceAttestations({
      commit: COMMIT,
      nonce: NONCE,
      now: NOW,
      env: {
        VERIFY_META_API_URL: 'https://production.example',
        VERIFY_PRODUCTION_OWNER_SESSION_COOKIE: 'mei_session=owner',
      },
      fetch: async () => responseAt('https://attacker.example/ticket', {}),
    }), /URL|origin|path|响应/)
  })

  it('migration 输出只接受明确的无待应用状态', () => {
    assert.equal(hasNoPendingMigrations('No migrations to apply!'), true)
    assert.equal(hasNoPendingMigrations('0046_meta_live_match_coverage.sql'), false)
    assert.equal(hasNoPendingMigrations('warning: unknown state'), false)
  })

  it('bootstrap 允许新迁移待应用和已有有效连接，但仍要求旧迁移基线完整', async () => {
    const resourceConfig = {
      envArgs: ['--env', ''],
      database: 'meigallery-db',
      d1Id: 'production-d1-id',
      worker: 'meigallery-api',
      mainQueue: 'meigallery-ad-meta',
      dlq: 'meigallery-ad-meta-dlq',
      r2: 'meigallery-media',
      apiOrigin: 'https://api.example.test',
      mainConsumer: { batchSize: 10, maxWaitTimeMs: 30_000, maxRetries: 3, retryDelay: 60 },
      dlqConsumer: { batchSize: 10, maxWaitTimeMs: 5_000 },
    }
    const result = await runMetaResourceVerification({
      environment: 'production',
      initialMetaRollout: true,
      reportOnly: true,
      resourceConfig,
      commit: COMMIT,
      runCommand: async (_command, _args, options) => resourceStep(options.name),
    })

    assert.equal(result.status, 'passed')
    assert.equal(result.phase, 'bootstrap')
    assert.equal(result.migrationsCurrent, false)
    assert.equal(result.migrationsApplied, true)
    assert.equal(result.connectionVerified, true)
    assert.equal(result.targetRolloutPercentage, 0)
    assert.equal(result.effectiveRolloutPercentage, 0)
  })

  it('常规发布复用有效 Meta 连接，不要求 verification commit 等于待发布 commit', () => {
    const pixelId = '1234567890'
    const output = JSON.stringify([{ results: [{
      environment: 'production',
      pixel_id: pixelId,
      graph_api_version: 'v25.0',
      verified_commit: 'a'.repeat(40),
      verified_at: '2026-07-13 09:07:35',
      invalidated_at: null,
      invalidation_reason: '',
      revision: 'b'.repeat(32),
    }] }])

    assert.equal(hasVerifiedMetaConnection(output, 'production', pixelId), true)
  })

  it('常规发布只从有效连接和 Cloudflare secret 名称推导隔离状态', () => {
    const secrets = JSON.stringify([
      { name: 'META_CAPI_ACCESS_TOKEN' },
      { name: 'META_CAPI_DATA_KEY_CURRENT' },
    ])
    assert.deepEqual(resolveFullSecretIsolation(secrets, true), {
      pixel: true,
      token: true,
      dataKey: true,
    })
    assert.equal(resolveFullSecretIsolation(secrets, false).token, false)
  })
})

function responseAt(url, body) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url,
    json: async () => body,
  }
}

const REQUIRED_MIGRATIONS = [
  '0036_meta_capi_v2_secure_delivery.sql',
  '0037_meta_connection_revision.sql',
  '0038_conversion_dedupe_claims.sql',
  '0039_meta_capi_v2_operations.sql',
  '0040_meta_capi_circuit_indexes.sql',
  '0041_meta_live_challenges.sql',
  '0042_meta_resource_attestation_tickets.sql',
  '0043_meta_capi_delivery_lease.sql',
  '0044_meta_dataset_quality_contract_digest.sql',
  '0045_meta_live_production.sql',
  '0046_meta_live_match_coverage.sql',
  '0047_ad_platform_delivery_core.sql',
  '0048_tiktok_pixel_connection.sql',
  '0049_tiktok_events_api.sql',
  '0050_strict_ad_source_routing.sql',
]

function resourceStep(name) {
  const outputs = {
    'meta-resources-production-queue-main': 'Queue: meigallery-ad-meta',
    'meta-resources-production-queue-dlq': 'Queue: meigallery-ad-meta-dlq',
    'meta-resources-production-d1-info': JSON.stringify({ name: 'meigallery-db', uuid: 'production-d1-id' }),
    'meta-resources-production-r2-bucket': JSON.stringify({ name: 'meigallery-media' }),
    'meta-resources-production-consumer-main': '[]',
    'meta-resources-production-consumer-dlq': '[]',
    'meta-resources-production-secrets': JSON.stringify([
      { name: 'META_CAPI_ACCESS_TOKEN' },
      { name: 'META_CAPI_DATA_KEY_CURRENT' },
    ]),
    'meta-resources-production-migrations': '0051_unified_attribution_expand.sql',
    'meta-resources-production-meta-settings': d1Rows([{
      server_enabled: 0,
      mode: 'production',
      destination_id: '1277657707436781',
    }]),
    'meta-resources-production-migration-names': d1Rows(REQUIRED_MIGRATIONS.map(migrationName => ({ name: migrationName }))),
    'meta-resources-production-meta-connection': d1Rows([{
      environment: 'production',
      pixel_id: '1277657707436781',
      graph_api_version: 'v25.0',
      verified_commit: COMMIT,
      verified_at: NOW,
      invalidated_at: null,
      invalidation_reason: '',
      revision: 'b'.repeat(32),
    }]),
    'meta-resources-production-meta-operations': d1Rows([{
      target_rollout_percentage: 0,
      effective_rollout_percentage: 0,
      open_critical_incident_count: 0,
      expired_secure_outbox_count: 0,
      previous_key_active_count: 0,
      active_key_count: 0,
    }]),
  }
  if (!(name in outputs)) throw new Error(`未覆盖的资源命令：${name}`)
  return { status: 'passed', stdout: outputs[name], stderr: '', exitCode: 0 }
}

function d1Rows(results) {
  return JSON.stringify([{ results }])
}
