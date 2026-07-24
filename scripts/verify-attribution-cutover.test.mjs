import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  buildNewCutoverSummary,
  buildOldCutoverSummary,
  compareMigrationSets,
  compareReceipt,
  evaluatePreflight,
  parseCutoverArgs,
  parseD1Rows,
  runCutoverVerification,
  sourceConfigurationHash,
} from './verify-attribution-cutover.mjs'

const CONNECTION_ID = 'connection_meta_primary'
const PUBLIC_CONFIG = JSON.stringify({
  pixelId: '1234567890123456',
})
const PROOF = 'a'.repeat(64)
const PROOF_HASH = createHash('sha256')
  .update(`managed-source:v1:${PROOF}`)
  .digest('hex')

function oldRows() {
  return {
    connections: [{
      id: CONNECTION_ID,
      provider: 'meta',
      enabled: 1,
      mode: 'production',
      browser_enabled: 1,
      server_enabled: 1,
      public_config_json: PUBLIC_CONFIG,
      attribution_window_days: 30,
      rollout_target_percentage: 10,
      rollout_effective_percentage: 10,
      credential_revision: 'credential_meta_v1',
    }],
    bindings: [
      {
        connection_id: CONNECTION_ID,
        provider: 'meta',
        canonical_event: 'Contact',
        enabled: 1,
        browser_destination: 'Contact',
        server_destination: 'Contact',
      },
      {
        connection_id: CONNECTION_ID,
        provider: 'meta',
        canonical_event: 'CompleteRegistration',
        enabled: 1,
        browser_destination: 'CompleteRegistration',
        server_destination: 'CompleteRegistration',
      },
    ],
    credentials: [{
      connection_id: CONNECTION_ID,
      provider: 'meta',
      credential_type: 'access_token',
      credential_revision: 'credential_meta_v1',
    }],
    managedSources: [{
      id: 'source_meta_campaign',
      ad_provider: 'meta',
      link_proof: PROOF,
      utm_campaign: 'campaign_us',
      utm_medium: 'paid_social',
      utm_content: 'creative_a',
      status: 'active',
    }],
    historyDaily: [{
      date: '2026-07-20',
      event_name: 'Contact',
      fact_origin: 'archived_live',
      provider: 'meta',
      attribution_source: 'managed_link',
      fact_count: 2,
      first_occurred_at: '2026-07-20T12:00:00.000Z',
      last_occurred_at: '2026-07-20T12:00:01.000Z',
    }, {
      date: '2026-07-01',
      event_name: 'Contact',
      fact_origin: 'historical_backfill',
      provider: 'meta',
      attribution_source: 'managed_link',
      fact_count: 7,
      first_occurred_at: '2026-07-01T01:00:00.000Z',
      last_occurred_at: '2026-07-01T10:00:00.000Z',
    }],
    pendingDeliveries: [],
    openCriticalIncidents: [],
    privacyPolicy: [{
      default_mode: 'notice_opt_out',
      prior_consent_country_codes_json: '["DE","FR"]',
      policy_version: 2,
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
  }
}

function newRows() {
  return {
    connections: [{
      id: CONNECTION_ID,
      provider: 'meta',
      public_config_json: PUBLIC_CONFIG,
      enabled: 1,
      browser_enabled: 1,
      server_enabled: 1,
      server_target_percentage: 10,
      server_effective_percentage: 0,
      circuit_state: 'closed',
      credential_fingerprint: 'f'.repeat(64),
    }],
    bindings: [
      {
        connection_id: CONNECTION_ID,
        canonical_event: 'Contact',
        enabled: 1,
        browser_destination: 'Contact',
        server_destination: 'Contact',
      },
      {
        connection_id: CONNECTION_ID,
        canonical_event: 'CompleteRegistration',
        enabled: 1,
        browser_destination: 'CompleteRegistration',
        server_destination: 'CompleteRegistration',
      },
    ],
    managedSources: [{
      id: 'source_meta_campaign',
      connection_id: CONNECTION_ID,
      proof_hash: PROOF_HASH,
      provider: 'meta',
      campaign: 'campaign_us',
      medium: 'paid_social',
      content: 'creative_a',
      enabled: 1,
      expires_at: null,
    }],
    activeLiveFacts: [],
    historyDaily: [{
      date: '2026-07-20',
      event_name: 'Contact',
      fact_origin: 'archived_live',
      provider: 'meta',
      attribution_source: 'managed_link',
      fact_count: 2,
      first_occurred_at: '2026-07-20T12:00:00.000Z',
      last_occurred_at: '2026-07-20T12:00:01.000Z',
    }, {
      date: '2026-07-01',
      event_name: 'Contact',
      fact_origin: 'historical_backfill',
      provider: 'meta',
      attribution_source: 'managed_link',
      fact_count: 7,
      first_occurred_at: '2026-07-01T01:00:00.000Z',
      last_occurred_at: '2026-07-01T10:00:00.000Z',
    }],
    pendingDeliveries: [],
    openCriticalIncidents: [],
    privacyPolicy: [{
      default_mode: 'notice_opt_out',
      prior_consent_country_codes_json: '["DE","FR"]',
      policy_version: 2,
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
    migrationManifest: [{
      initial_run_id: 'migration-production-v1',
      initial_snapshot_hash: 'b'.repeat(64),
      source_configuration_hash: 'c'.repeat(64),
      credential_set_hash: 'd'.repeat(64),
      desired_runtime_policies_json: JSON.stringify([{
        connectionId: CONNECTION_ID,
        enabled: true,
        browserEnabled: true,
        serverEnabled: true,
        serverTargetPercentage: 10,
        serverEffectivePercentage: 10,
        circuitState: 'closed',
      }]),
      status: 'initial_imported',
      reconcile_run_id: null,
      reconcile_snapshot_hash: null,
      reconciled_captured_at: null,
    }],
  }
}

describe('归因生产切换核验', () => {
  it('命令行只接受核验模式和非敏感 runId', () => {
    assert.deepEqual(parseCutoverArgs([]), {
      mode: 'preflight',
      runId: 'migration-production-v1',
    })
    assert.deepEqual(parseCutoverArgs([
      'migrated',
      '--run-id',
      'migration-production-v2',
    ]), {
      mode: 'migrated',
      runId: 'migration-production-v2',
    })
    assert.throws(
      () => parseCutoverArgs(['--token', 'private']),
      /ATTRIBUTION_CUTOVER_ARGUMENT_INVALID/,
    )
  })

  it('解析 Wrangler D1 JSON 且拒绝非结构化输出', () => {
    assert.deepEqual(parseD1Rows(JSON.stringify([{
      results: [{ row_count: 1 }],
      success: true,
    }])), [{ row_count: 1 }])
    assert.throws(
      () => parseD1Rows('not-json'),
      /ATTRIBUTION_CUTOVER_D1_RESPONSE_INVALID/,
    )
  })

  it('preflight 要求旧写者唯一且新运行时为 shadow', () => {
    const result = evaluatePreflight({
      oldWriter: 'active',
      newRuntimeMode: 'shadow',
      productionDeliveryCountNew: 0,
      openCriticalCountNew: 0,
    })

    assert.equal(result.oldWriter, 'active')
    assert.equal(result.newRuntimeMode, 'shadow')
    assert.equal(result.productionDeliveryCountNew, 0)
    assert.equal(result.ready, true)
  })

  it('远程 preflight 只读查询并返回机器可判定结果', async () => {
    const result = await runCutoverVerification({
      parsed: {
        mode: 'preflight',
        runId: 'migration-production-v1',
      },
      queryOld: async () => [{ row_count: 1 }],
      queryNew: async (sql) => {
        if (sql.includes('SELECT mode')) return [{ mode: 'shadow' }]
        return [{ row_count: 0 }]
      },
    })

    assert.equal(
      result.status,
      'ATTRIBUTION_CUTOVER_PREFLIGHT_PASSED',
    )
    assert.equal(result.preflight.ready, true)
  })

  it('拒绝 bridge/active 或已经产生普通投递的目标运行时', () => {
    assert.equal(evaluatePreflight({
      oldWriter: 'active',
      newRuntimeMode: 'active',
      productionDeliveryCountNew: 0,
      openCriticalCountNew: 0,
    }).ready, false)
    assert.equal(evaluatePreflight({
      oldWriter: 'active',
      newRuntimeMode: 'shadow',
      productionDeliveryCountNew: 1,
      openCriticalCountNew: 0,
    }).ready, false)
  })

  it('使用稳定 ID 和摘要验证完整迁移集合', () => {
    const oldSummary = buildOldCutoverSummary(oldRows())
    const newSummary = buildNewCutoverSummary(newRows())
    const result = compareMigrationSets(oldSummary, newSummary)

    assert.equal(result.matched, true)
    assert.deepEqual(result.mismatches, [])
    assert.equal(oldSummary.history.factCount, 9)
  })

  it('空投放活动名与迁移导出一致回退到来源 ID', () => {
    const source = oldRows()
    const target = newRows()
    source.managedSources[0].utm_campaign = ''
    target.managedSources[0].campaign = source.managedSources[0].id

    assert.equal(compareMigrationSets(
      buildOldCutoverSummary(source),
      buildNewCutoverSummary(target),
    ).matched, true)
  })

  it('集合成员不同但数量相同时仍然阻断', () => {
    const target = newRows()
    target.historyDaily[1].attribution_source = 'click_id'

    const result = compareMigrationSets(
      buildOldCutoverSummary(oldRows()),
      buildNewCutoverSummary(target),
    )

    assert.equal(result.matched, false)
    assert.deepEqual(result.mismatches, ['history'])
  })

  it('回执同时核对源配置、目标凭证和零活动事实', () => {
    const source = oldRows()
    const target = newRows()
    const configurationHash = sourceConfigurationHash(source)
    const credentialSetHash = createHash('sha256')
      .update(JSON.stringify([{
        connectionId: CONNECTION_ID,
        fingerprint: 'f'.repeat(64),
      }]))
      .digest('hex')
    Object.assign(target.migrationManifest[0], {
      source_configuration_hash: configurationHash,
      credential_set_hash: credentialSetHash,
    })
    const receipt = {
      runId: 'migration-production-v1',
      phase: 'initial',
      snapshotHash: 'b'.repeat(64),
      sourceConfigurationHash: configurationHash,
      credentialSetHash,
      capturedAt: '2026-07-24T12:00:00.000Z',
      counts: {
        connections: 1,
        versions: 1,
        credentials: 1,
        bindings: 2,
        managedSources: 1,
        historyRows: 2,
        historyFacts: 9,
      },
    }

    assert.equal(compareReceipt(receipt, source, target).matched, true)
    target.activeLiveFacts.push({ id: 'unexpected_live_fact' })
    assert.deepEqual(
      compareReceipt(receipt, source, target).mismatches,
      ['activeLiveFacts'],
    )
  })

  it('核验摘要不暴露 public target 或来源 proof', () => {
    const serialized = JSON.stringify(buildOldCutoverSummary(oldRows()))

    assert.doesNotMatch(serialized, /1234567890123456/)
    assert.doesNotMatch(serialized, new RegExp(PROOF))
    assert.match(serialized, /sha256:[0-9a-f]{64}/)
  })
})
