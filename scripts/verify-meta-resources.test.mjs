import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareLiveAttestations,
  requestLiveResourceAttestations,
  runMetaResourceVerification as runMetaResourceVerificationImpl,
} from './verify-meta-resources.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const TOKEN = 'META_ACCESS_TOKEN_SHOULD_NOT_LEAK'
const TEST_CODE = 'META_TEST_CODE_SHOULD_NOT_LEAK'
const RESOURCE_ID = '714929cb-sensitive-resource-id'

function runMetaResourceVerification(options) {
  return runMetaResourceVerificationImpl({
    requestResourceAttestations: async input => passingLiveIsolation(input.commit),
    ...options,
  })
}

describe('Meta Cloudflare 资源检查', () => {
  it('live attestation 只向固定可信 origin 换票，并以无 Cookie 的一次性 ticket 完成最终请求', async () => {
    const calls = []
    const now = '2026-07-11T00:00:00.000Z'
    const nonce = `nonce_${'a'.repeat(64)}`
    const identities = environment => ({
      pixel: `hmac-sha256:${environment === 'dev' ? '1' : '5'}`.padEnd(76, environment === 'dev' ? '1' : '5'),
      token: `hmac-sha256:${environment === 'dev' ? '2' : '6'}`.padEnd(76, environment === 'dev' ? '2' : '6'),
      testEventCode: `hmac-sha256:${environment === 'dev' ? '3' : '7'}`.padEnd(76, environment === 'dev' ? '3' : '7'),
      dataKey: `hmac-sha256:${environment === 'dev' ? '4' : '8'}`.padEnd(76, environment === 'dev' ? '4' : '8'),
    })
    const trusted = {
      dev: 'https://meigallery-api-dev.wajie.workers.dev',
      production: 'https://api.616618.xyz',
    }
    const fetchFn = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      const environment = url.startsWith(trusted.dev) ? 'dev' : 'production'
      if (url.endsWith('/resource-attestation-ticket')) {
        return responseAt(url, { data: {
          schemaVersion: 1,
          environment,
          commitSha: COMMIT,
          nonce,
          ticket: `mrat_${environment === 'dev' ? 'a' : 'b'}`.padEnd(69, environment === 'dev' ? 'a' : 'b'),
          issuedAt: now,
          expiresAt: '2026-07-11T00:01:00.000Z',
        } })
      }
      return responseAt(url, { data: {
        schemaVersion: 1,
        environment,
        commitSha: COMMIT,
        nonce,
        issuedAt: now,
        expiresAt: '2026-07-11T00:05:00.000Z',
        identities: identities(environment),
      } })
    }

    const result = await requestLiveResourceAttestations({
      commit: COMMIT,
      now,
      nonce,
      fetch: fetchFn,
      env: {
        VERIFY_DEV_API_URL: 'https://attacker.example',
        VERIFY_PRODUCTION_API_URL: 'https://other.example',
        VERIFY_DEV_OWNER_SESSION_COOKIE: 'session=dev-owner',
        VERIFY_PRODUCTION_OWNER_SESSION_COOKIE: 'session=production-owner',
      },
    })

    assert.deepEqual(result, { pixel: true, token: true, testEventCode: true, dataKey: true })
    assert.equal(calls.length, 4)
    assert.equal(calls.some(call => call.url.includes('attacker.example') || call.url.includes('other.example')), false)
    for (const [environment, origin] of Object.entries(trusted)) {
      const ticketCall = calls.find(call => call.url === `${origin}/api/admin/attribution/meta/resource-attestation-ticket`)
      const finalCall = calls.find(call => call.url === `${origin}/api/meta/resource-attestation`)
      assert.ok(ticketCall, `${environment} 应向固定 origin 换票`)
      assert.ok(finalCall, `${environment} 应向固定 origin 使用 ticket`)
      assert.equal(ticketCall.init.redirect, 'manual')
      assert.equal(finalCall.init.redirect, 'manual')
      assert.match(String(ticketCall.init.headers.Cookie), /owner/)
      assert.equal(Object.hasOwn(finalCall.init.headers, 'Cookie'), false)
      assert.match(String(finalCall.init.body), /mrat_/)
    }
  })

  it('live attestation 对 redirect 或响应 final URL/origin/path 漂移 fail closed', async () => {
    const trustedUrl = 'https://meigallery-api-dev.wajie.workers.dev/api/admin/attribution/meta/resource-attestation-ticket'
    await assert.rejects(requestLiveResourceAttestations({
      commit: COMMIT,
      nonce: `nonce_${'b'.repeat(64)}`,
      env: {
        VERIFY_DEV_OWNER_SESSION_COOKIE: 'session=dev-owner',
        VERIFY_PRODUCTION_OWNER_SESSION_COOKIE: 'session=production-owner',
      },
      fetch: async (input) => responseAt(String(input) === trustedUrl ? 'https://attacker.example/ticket' : String(input), {
        data: {
          schemaVersion: 1, environment: 'dev', commitSha: COMMIT,
          nonce: `nonce_${'b'.repeat(64)}`, ticket: `mrat_${'c'.repeat(64)}`,
          issuedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-11T00:01:00.000Z',
        },
      }),
    }), /URL|origin|path|响应/)
  })

  it('production 固定空 env、生产 D1，且报告和 SQL 不含敏感输出', async () => {
    const calls = []
    let stored
    const report = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      runCommand: createPassingRunner(calls, { capiEnabled: false }),
      recordSummary: async options => {
        stored = options
        return { status: 'passed', name: 'store' }
      },
    })

    assert.equal(report.status, 'passed')
    assert.equal(report.environment, 'production')
    assert.equal(report.commit, COMMIT)
    assert.equal(report.database, 'meigallery-db')
    assert.deepEqual(report.queues, ['meigallery-meta-capi', 'meigallery-meta-capi-dlq'])
    assert.equal(calls.filter(call => call.args.includes('queues') && call.args.includes('info'))
      .every(call => !call.args.includes('--json')), true)
    assert.equal(report.capiEnabled, false)
    assert.equal(report.secretsPresent, true)
    assert.equal(report.requiredSecretsPresent, true)
    assert.equal(report.migrationsApplied, true)
    assert.equal(report.connectionVerified, true)
    assert.equal(report.trackingMode, 'production')
    assert.deepEqual(findCall(calls, 'secret', 'list').args.slice(-4), ['--env', '', '--format', 'json'])
    const d1Calls = calls.filter(call => call.args.includes('d1'))
    assert.equal(d1Calls.every(call => call.args.includes('meigallery-db')), true)
    assert.equal(d1Calls.every(call => hasAdjacent(call.args, '--env', '')), true)
    const settingCall = findCall(calls, 'd1', 'execute')
    assert.equal(settingCall.args.includes('--json'), true)
    const migrationCall = calls.find(call => call.options.name.endsWith('migration-names'))
    const connectionCall = calls.find(call => call.options.name.endsWith('meta-connection'))
    assert.ok(migrationCall)
    assert.ok(connectionCall)
    assert.match(migrationCall.args.join(' '), /SELECT name FROM d1_migrations/)
    assert.doesNotMatch(connectionCall.args.join(' '), /token_fingerprint/)
    assert.equal(stored.environment, 'production')
    assert.equal(stored.verificationType, 'meta_resources')
    const serialized = JSON.stringify({ report, stored })
    for (const sensitive of [TOKEN, TEST_CODE, RESOURCE_ID]) assert.equal(serialized.includes(sensitive), false)
  })

  it('dev 固定 dev env、独立 D1，并检查独立 Queue/DLQ', async () => {
    const calls = []
    const report = await runMetaResourceVerification({
      environment: 'dev',
      commit: COMMIT,
      runCommand: createPassingRunner(calls, { capiEnabled: true, consumerField: 'service' }),
      recordSummary: async () => ({ status: 'passed' }),
    })

    assert.equal(report.status, 'passed')
    assert.equal(report.database, 'meigallery-db-dev')
    assert.deepEqual(report.queues, ['meigallery-meta-capi-dev', 'meigallery-meta-capi-dev-dlq'])
    assert.deepEqual(findCall(calls, 'secret', 'list').args.slice(-4), ['--env', 'dev', '--format', 'json'])
    assert.equal(calls.filter(call => call.args.includes('d1')).every(call => hasAdjacent(call.args, '--env', 'dev')), true)
  })

  it('consumer 兼容当前 script/service 字段、嵌套结果和 JSON 前置日志', async () => {
    for (const options of [
      { consumerField: 'script' },
      { consumerField: 'service' },
      { nestedService: true },
      { consumerField: 'script', nestedConsumers: true },
      { consumerField: 'service', leadingLog: true, deadLetterInSettings: true },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...options }),
      })
      assert.equal(report.status, 'passed')
      assert.equal(report.consumersPresent, true)
    }
  })

  it('主 Queue consumer 的重试、延迟、DLQ 与环境 batch 配置漂移时失败', async () => {
    for (const consumerDrift of [
      'max_retries',
      'retry_delay',
      'dead_letter_queue',
      'batch_size',
      'max_wait_time_ms',
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, consumerDrift }),
      })
      assert.equal(report.status, 'failed', `${consumerDrift} 漂移必须失败`)
    }
  })

  it('dev 使用 batch=5，production 使用 batch=10，DLQ consumer 同步校验', async () => {
    for (const environment of ['dev', 'production']) {
      const report = await runMetaResourceVerification({
        environment,
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false }),
      })
      assert.equal(report.status, 'passed')
    }

    const driftedDlq = await runMetaResourceVerification({
      environment: 'dev',
      commit: COMMIT,
      reportOnly: true,
      runCommand: createPassingRunner([], { capiEnabled: false, dlqBatchDrift: true }),
    })
    assert.equal(driftedDlq.status, 'failed')
  })

  it('未知 consumer envelope 即使含期望 Worker 名也保守失败', async () => {
    const report = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      reportOnly: true,
      runCommand: createPassingRunner([], { capiEnabled: false, unknownConsumerEnvelope: true }),
    })

    assert.equal(report.status, 'failed')
  })

  it('consumer 或 D1 的非法 JSON 保守失败', async () => {
    for (const options of [
      { invalidConsumerJson: true },
      { invalidSettingJson: true },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...options }),
      })
      assert.equal(report.status, 'failed')
    }
  })

  it('首次上线要求 CAPI 关闭，report-only 不写 D1 摘要', async () => {
    let stored = false
    const failed = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      initialMetaRollout: true,
      reportOnly: true,
      runCommand: createPassingRunner([], { capiEnabled: true }),
      recordSummary: async () => {
        stored = true
      },
    })

    assert.equal(failed.status, 'failed')
    assert.equal(failed.initialMetaRollout, true)
    assert.equal(stored, false)
  })

  it('production initial gate 同时要求 target/effective=0、无 critical incident、无过期 outbox', async () => {
    const passed = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      initialMetaRollout: true,
      reportOnly: true,
      resourceIdentities: completeResourceIdentities(),
      runCommand: createPassingRunner([], { capiEnabled: false }),
    })
    assert.equal(passed.status, 'passed')
    assert.equal(passed.targetRolloutPercentage, 0)
    assert.equal(passed.effectiveRolloutPercentage, 0)
    assert.equal(passed.openCriticalIncidentCount, 0)
    assert.equal(passed.expiredSecureOutboxCount, 0)

    for (const overrides of [
      { targetRolloutPercentage: 10 },
      { effectiveRolloutPercentage: 10 },
      { openCriticalIncidentCount: 1 },
      { expiredSecureOutboxCount: 1 },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        initialMetaRollout: true,
        reportOnly: true,
        resourceIdentities: completeResourceIdentities(),
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'failed', JSON.stringify(overrides))
    }
  })

  it('production bootstrap 不要求 connection/live endpoint，但要求 Wrangler 资源身份和全部 bootstrap secret', async () => {
    const calls = []
    const passed = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      phase: 'bootstrap',
      reportOnly: true,
      resourceIdentities: completeResourceIdentities(),
      runCommand: createPassingRunner(calls, {
        capiEnabled: false,
        connectionVerified: false,
      }),
    })

    assert.equal(passed.status, 'passed')
    assert.equal(passed.phase, 'bootstrap')
    assert.equal(passed.connectionVerified, false)
    assert.equal(calls.some(call => call.options.name.endsWith('r2-bucket')), true)

    for (const overrides of [
      { secretNames: ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATA_KEY_CURRENT'] },
      { r2NameDrift: true },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        phase: 'bootstrap',
        reportOnly: true,
        runCommand: createPassingRunner([], {
          capiEnabled: false,
          connectionVerified: false,
          ...(overrides.secretNames ? { secretNames: overrides.secretNames } : {}),
          ...(overrides.r2NameDrift ? { r2NameDrift: true } : {}),
        }),
      })
      assert.equal(report.status, 'failed')
    }
  })

  it('full resources 仍要求当前 commit connection', async () => {
    const report = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      phase: 'full',
      reportOnly: true,
      resourceIdentities: completeResourceIdentities(),
      runCommand: createPassingRunner([], { capiEnabled: false, connectionVerified: false }),
    })

    assert.equal(report.status, 'failed')
  })

  it('production post-deploy 仅在 trackingMode=test、rollout=0 和 live attestation 下放行且不要求 connection', async () => {
    const passed = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      phase: 'post-deploy',
      reportOnly: true,
      runCommand: createPassingRunner([], { capiEnabled: false, trackingMode: 'test', connectionVerified: false }),
    })
    assert.equal(passed.status, 'passed')
    assert.equal(passed.connectionVerified, false)
    assert.equal(Object.values(passed.environmentIsolation).every(Boolean), true)

    for (const overrides of [
      { trackingMode: 'disabled' },
      { trackingMode: 'production' },
      { trackingMode: 'test', targetRolloutPercentage: 10 },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        phase: 'post-deploy',
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, connectionVerified: false, ...overrides }),
      })
      assert.equal(report.status, 'failed', JSON.stringify(overrides))
    }
  })

  it('任意 META_RESOURCE_IDENTITIES_FILE 不能替代 production live Worker attestation', async () => {
    const report = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      phase: 'full',
      reportOnly: true,
      env: { META_RESOURCE_IDENTITIES_FILE: '/tmp/forged-identities.json' },
      requestResourceAttestations: async () => { throw new Error('endpoint unavailable') },
      runCommand: createPassingRunner([], { capiEnabled: false }),
    })
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.environmentIsolation, {
      d1: true, r2: true, queue: true, dlq: true,
      pixel: false, token: false, testEventCode: false, dataKey: false,
    })
  })

  it('dev Dataset Quality 从真实 resource query 读取 contract version 与 freshness，不读取 Evidence 布尔', async () => {
    const digest = `sha256:${'9'.repeat(64)}`
    const passing = await runMetaResourceVerification({
      environment: 'dev',
      commit: COMMIT,
      reportOnly: true,
      expectedDatasetQualityContract: { version: 3, digest },
      runCommand: createPassingRunner([], { capiEnabled: true, datasetQualityContractVersion: 3, datasetQualityContractDigest: digest }),
    })
    assert.equal(passing.status, 'passed')
    assert.equal(passing.datasetQualityContractVersion, 3)
    assert.equal(passing.datasetQualityContractDigest, digest)
    assert.equal(passing.datasetQualityCollectorCurrent, true)

    for (const overrides of [
      { datasetQualityContractVersion: 2 },
      { datasetQualityContractDigest: `sha256:${'8'.repeat(64)}` },
      { datasetQualityCollectorCurrent: false },
      { datasetQualityEventCount: 1 },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'dev',
        commit: COMMIT,
        reportOnly: true,
        expectedDatasetQualityContract: { version: 3, digest },
        runCommand: createPassingRunner([], { capiEnabled: true, datasetQualityContractDigest: digest, ...overrides }),
      })
      assert.equal(report.status, 'failed')
    }
  })

  it('previous key active count 必须至多一把且由 previous secret 解释', async () => {
    const explained = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      initialMetaRollout: true,
      reportOnly: true,
      resourceIdentities: completeResourceIdentities(),
      runCommand: createPassingRunner([], {
        capiEnabled: false,
        previousKeyActiveCount: 2,
        activeKeyCount: 2,
        secretNames: ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_TEST_EVENT_CODE', 'META_CAPI_DATA_KEY_CURRENT', 'META_CAPI_DATA_KEY_PREVIOUS'],
      }),
    })
    assert.equal(explained.status, 'passed')
    assert.equal(explained.previousKeyActiveCountExplainable, true)

    for (const overrides of [
      { previousKeyActiveCount: 2, activeKeyCount: 2 },
      { previousKeyActiveCount: 2, activeKeyCount: 3, secretNames: ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATA_KEY_CURRENT', 'META_CAPI_DATA_KEY_PREVIOUS'] },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        initialMetaRollout: true,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'failed')
    }
  })

  it('首次上线标记在 dev 环境不要求关闭 CAPI', async () => {
    const report = await runMetaResourceVerification({
      environment: 'dev',
      commit: COMMIT,
      initialMetaRollout: true,
      reportOnly: true,
      runCommand: createPassingRunner([], { capiEnabled: true, consumerField: 'service' }),
    })

    assert.equal(report.status, 'passed')
    assert.equal(report.capiEnabled, true)
    assert.equal(report.initialMetaRollout, false)
  })

  it('test mode 要求 Test Event Code，production mode 不要求', async () => {
    for (const secretNames of [
      ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATA_KEY_CURRENT'],
      ['META_CAPI_TEST_EVENT_CODE', 'META_CAPI_DATA_KEY_CURRENT'],
      [],
    ]) {
      let stored = false
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        runCommand: createPassingRunner([], { capiEnabled: false, trackingMode: 'test', secretNames }),
        recordSummary: async () => {
          stored = true
        },
      })
      assert.equal(report.status, 'failed')
      assert.equal(stored, false)
    }

    const production = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      reportOnly: true,
      runCommand: createPassingRunner([], {
        capiEnabled: false,
        trackingMode: 'production',
        secretNames: ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATA_KEY_CURRENT'],
      }),
    })
    assert.equal(production.status, 'passed')
  })

  it('current data key 在所有 mode 都必需', async () => {
    for (const trackingMode of ['disabled', 'test', 'production']) {
      const secretNames = trackingMode === 'test'
        ? ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_TEST_EVENT_CODE']
        : ['META_CAPI_ACCESS_TOKEN']
      const report = await runMetaResourceVerification({
        environment: 'dev',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, trackingMode, secretNames }),
      })
      assert.equal(report.status, 'failed', `${trackingMode} 缺 current data key 必须失败`)
    }
  })

  it('待应用 migration、consumer 缺失或命令失败时保守失败', async () => {
    for (const overrides of [
      { migrationPending: true },
      { missingAppliedMigration: '0037_meta_connection_revision.sql' },
      { missingAppliedMigration: '0039_meta_capi_v2_operations.sql' },
      { missingAppliedMigration: '0040_meta_capi_circuit_indexes.sql' },
      { missingAppliedMigration: '0041_meta_live_challenges.sql' },
      { missingAppliedMigration: '0042_meta_resource_attestation_tickets.sql' },
      { missingAppliedMigration: '0043_meta_capi_delivery_lease.sql' },
      { missingAppliedMigration: '0044_meta_dataset_quality_contract_digest.sql' },
      { connectionInvalidated: true },
      { connectionPixelDrift: true },
      { missingConsumer: true },
      { failQueueInfo: true },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'dev',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'failed')
    }
  })

  it('兼容 Wrangler 4.103.0 带 ANSI/前缀的无 migration 输出，含糊或 pending 输出仍失败', async () => {
    const actual = await runMetaResourceVerification({
      environment: 'dev', commit: COMMIT, reportOnly: true,
      runCommand: createPassingRunner([], {
        capiEnabled: false,
        migrationOutput: '\u001b[32m✅ No migrations to apply!\u001b[0m',
      }),
    })
    assert.equal(actual.status, 'passed')

    for (const migrationOutput of [
      '⛅️ wrangler 4.103.0\n✅ No migrations to apply!',
      '✅ No migrations to apply!\nMigrations to be applied:\n0043_pending.sql',
      'No migrations to apply, probably',
      'migration status unavailable',
      'WARNING: migration status unavailable\nNo migrations to apply!',
      'No migrations to apply!\nError: unable to verify migration state',
      'No migrations to apply!\npartial result returned',
      'No migrations to apply!\nstatus unknown',
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'dev', commit: COMMIT, reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, migrationOutput }),
      })
      assert.equal(report.status, migrationOutput.includes('wrangler 4.103.0') ? 'passed' : 'failed', migrationOutput)
    }
  })

  it('migrationsCurrent 合并 stdout/stderr 判定，stderr 冲突即使 exit 0 和 stdout 成功也 fail closed', async () => {
    for (const migrationStderr of [
      'WARNING: migration status unavailable',
      'Error: unable to verify migration state',
      'partial result returned',
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'dev',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], {
          capiEnabled: false,
          migrationOutput: 'No migrations to apply!',
          migrationStderr,
        }),
      })
      assert.equal(report.migrationsCurrent, false, migrationStderr)
      assert.equal(report.status, 'failed', migrationStderr)
    }
  })

  it('secret、D1 JSON envelope 或 DLQ consumer 字段漂移时 fail closed', async () => {
    for (const overrides of [
      { unknownSecretEnvelope: true },
      { unknownD1Envelope: true },
      { dlqHasDeadLetter: true },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'failed', JSON.stringify(overrides))
    }
  })

  it('DLQ 仅允许 dead_letter_queue 缺失或明确空字符串', async () => {
    for (const overrides of [
      { dlqTopDeadLetter: null },
      { dlqTopDeadLetter: { name: '' } },
      { dlqTopDeadLetter: 0 },
      { dlqSettingsDeadLetter: null },
      { dlqSettingsDeadLetter: { unknown: '' } },
      { dlqTopDeadLetter: '', dlqSettingsDeadLetter: null },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'failed', JSON.stringify(overrides))
    }

    for (const overrides of [
      { dlqTopDeadLetter: '' },
      { dlqSettingsDeadLetter: '' },
      { dlqTopDeadLetter: '', dlqSettingsDeadLetter: '' },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'passed', JSON.stringify(overrides))
    }
  })

  it('主 Queue 的 top/settings DLQ 必须都是一致的字符串', async () => {
    const expected = 'meigallery-meta-capi-dlq'
    for (const overrides of [
      { mainTopDeadLetter: null },
      { mainTopDeadLetter: { name: expected } },
      { mainTopDeadLetter: 1 },
      { mainTopDeadLetter: expected, mainSettingsDeadLetter: 'wrong-dlq' },
      { mainTopDeadLetter: expected, mainSettingsDeadLetter: null },
    ]) {
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        reportOnly: true,
        runCommand: createPassingRunner([], { capiEnabled: false, ...overrides }),
      })
      assert.equal(report.status, 'failed', JSON.stringify(overrides))
    }

    const consistent = await runMetaResourceVerification({
      environment: 'production',
      commit: COMMIT,
      reportOnly: true,
      runCommand: createPassingRunner([], {
        capiEnabled: false,
        mainTopDeadLetter: expected,
        mainSettingsDeadLetter: expected,
      }),
    })
    assert.equal(consistent.status, 'passed')
  })
})

function createPassingRunner(calls, options = {}) {
  return async (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions })
    const text = args.join(' ')
    let stdout = ''
    let stderr = ''
    let status = 'passed'
    if (runOptions.name.endsWith('r2-bucket')) {
      stdout = JSON.stringify({ name: options.r2NameDrift ? 'wrong-bucket' : text.includes('meigallery-media-dev') ? 'meigallery-media-dev' : 'meigallery-media' })
    } else if (text.includes('queues info')) {
      stdout = `Queue Name: ${args.at(-1)}\nQueue ID: ${RESOURCE_ID}`
      if (options.failQueueInfo) status = 'failed'
    } else if (runOptions.name.endsWith('d1-info')) {
      const isDev = text.includes('meigallery-db-dev')
      stdout = JSON.stringify({
        name: isDev ? 'meigallery-db-dev' : 'meigallery-db',
        uuid: isDev ? '9ff61317-0c62-491b-8b29-e0d119f306c9' : '714929cb-003b-4cb1-bd9f-545fa1895e8c',
      })
    } else if (text.includes('consumer worker list')) {
      const queue = args[args.indexOf('list') + 1]
      const worker = queue.includes('-dev') ? 'meigallery-api-dev' : 'meigallery-api'
      const isDev = queue.includes('-dev')
      const isDlq = queue.endsWith('-dlq')
      const expectedBatchSize = isDev ? 5 : 10
      if (options.invalidConsumerJson) {
        stdout = 'wrangler warning\nnot-json'
      } else {
        const field = options.consumerField ?? 'script'
        const settings = {
          batch_size: options.consumerDrift === 'batch_size' || (isDlq && options.dlqBatchDrift) ? 99 : expectedBatchSize,
          max_wait_time_ms: options.consumerDrift === 'max_wait_time_ms' ? 999 : isDlq ? 5000 : 30000,
          ...(!isDlq ? {
            max_retries: options.consumerDrift === 'max_retries' ? 4 : 5,
            retry_delay: options.consumerDrift === 'retry_delay' ? 30 : 60,
            ...(options.deadLetterInSettings ? {
              dead_letter_queue: options.consumerDrift === 'dead_letter_queue' ? 'wrong-dlq' : `${queue}-dlq`,
            } : {}),
          } : options.dlqHasDeadLetter ? { dead_letter_queue: `${queue}-again` } : {}),
        }
        const identity = options.unknownConsumerEnvelope
          ? { consumer: { name: worker } }
          : options.nestedService ? { service: { name: worker } } : { [field]: worker }
        const consumer = {
          type: 'worker',
          consumer_id: RESOURCE_ID,
          ...identity,
          settings,
          ...(!isDlq && !options.deadLetterInSettings ? {
            dead_letter_queue: options.consumerDrift === 'dead_letter_queue' ? 'wrong-dlq' : `${queue}-dlq`,
          } : {}),
        }
        if (!isDlq && Object.hasOwn(options, 'mainTopDeadLetter')) consumer.dead_letter_queue = options.mainTopDeadLetter
        if (!isDlq && Object.hasOwn(options, 'mainSettingsDeadLetter')) settings.dead_letter_queue = options.mainSettingsDeadLetter
        if (isDlq && Object.hasOwn(options, 'dlqTopDeadLetter')) consumer.dead_letter_queue = options.dlqTopDeadLetter
        if (isDlq && Object.hasOwn(options, 'dlqSettingsDeadLetter')) settings.dead_letter_queue = options.dlqSettingsDeadLetter
        const consumers = options.missingConsumer ? [] : [consumer]
        const payload = options.nestedConsumers ? { result: { consumers } } : consumers
        stdout = `${options.leadingLog ? 'wrangler warning\n' : ''}${JSON.stringify(payload)}`
      }
    } else if (text.includes('secret list')) {
      const secretNames = options.secretNames ?? ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_TEST_EVENT_CODE', 'META_CAPI_DATA_KEY_CURRENT']
      const rows = secretNames.map(name => ({ name, value: name === 'META_CAPI_ACCESS_TOKEN' ? TOKEN : TEST_CODE }))
      stdout = JSON.stringify(options.unknownSecretEnvelope ? { items: rows } : rows)
    } else if (text.includes('migrations list')) {
      stdout = options.migrationOutput ?? (options.migrationPending ? 'Migrations to be applied:\n0034.sql' : 'No migrations to apply!')
      stderr = options.migrationStderr ?? ''
    } else if (text.includes('d1 execute')) {
      let results
      if (runOptions.name.endsWith('migration-names')) {
        const names = [
          '0036_meta_capi_v2_secure_delivery.sql',
          '0037_meta_connection_revision.sql',
          '0038_conversion_dedupe_claims.sql',
          '0039_meta_capi_v2_operations.sql',
          '0040_meta_capi_circuit_indexes.sql',
          '0041_meta_live_challenges.sql',
          '0042_meta_resource_attestation_tickets.sql',
          '0043_meta_capi_delivery_lease.sql',
          '0044_meta_dataset_quality_contract_digest.sql',
        ].filter(name => name !== options.missingAppliedMigration)
        results = names.map(name => ({ name }))
      } else if (runOptions.name.endsWith('dataset-quality')) {
        results = [{
          contract_version: options.datasetQualityContractVersion ?? 1,
          contract_digest: options.datasetQualityContractDigest ?? `sha256:${'9'.repeat(64)}`,
          event_count: options.datasetQualityEventCount ?? 2,
          all_success: 1,
          collector_current: options.datasetQualityCollectorCurrent === false ? 0 : 1,
          oldest_collected_at: '2026-07-11T00:00:00.000Z',
          newest_collected_at: '2026-07-11T00:05:00.000Z',
        }]
      } else if (runOptions.name.endsWith('meta-connection')) {
        results = options.connectionVerified === false ? [] : [{
          environment: text.includes('--env dev') ? 'dev' : 'production',
          pixel_id: options.connectionPixelDrift ? '9999999999' : '1234567890',
          graph_api_version: 'v25.0',
          verified_commit: COMMIT,
          verified_at: '2026-07-11T00:00:00.000Z',
          invalidated_at: options.connectionInvalidated ? '2026-07-11T00:01:00.000Z' : null,
          invalidation_reason: options.connectionInvalidated ? 'verification_invalidated' : '',
          revision: 'a'.repeat(32),
        }]
      } else if (runOptions.name.endsWith('meta-operations')) {
        results = [{
          target_rollout_percentage: options.targetRolloutPercentage ?? 0,
          effective_rollout_percentage: options.effectiveRolloutPercentage ?? options.targetRolloutPercentage ?? 0,
          open_critical_incident_count: options.openCriticalIncidentCount ?? 0,
          expired_secure_outbox_count: options.expiredSecureOutboxCount ?? 0,
          previous_key_active_count: options.previousKeyActiveCount ?? 0,
          active_key_count: options.activeKeyCount ?? 1,
        }]
      } else {
        results = [
          { key: 'meta_capi_enabled', value: options.capiEnabled ? 'true' : 'false' },
          { key: 'meta_tracking_mode', value: options.trackingMode ?? (options.capiEnabled ? 'test' : 'production') },
          { key: 'facebook_pixel_id', value: '1234567890' },
        ]
      }
      const payload = options.unknownD1Envelope ? { data: results } : [{ results }]
      stdout = options.invalidSettingJson
        ? 'wrangler warning\nnot-json'
        : `${options.leadingLog ? 'wrangler warning\n' : ''}${JSON.stringify(payload)}`
    }
    return {
      name: runOptions.name,
      status,
      durationMs: 1,
      command: runOptions.reportCommand || [command, ...args].join(' '),
      exitCode: status === 'passed' ? 0 : 1,
      summary: stdout,
      stdout,
      stderr,
    }
  }
}

function responseAt(url, payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected: false,
    async json() { return payload },
  }
}

function findCall(calls, ...parts) {
  const call = calls.find(candidate => parts.every(part => candidate.args.includes(part)))
  assert.ok(call, `未找到命令：${parts.join(' ')}`)
  return call
}

function hasAdjacent(args, key, value) {
  const index = args.indexOf(key)
  return index >= 0 && args[index + 1] === value
}

function completeResourceIdentities(overrides = {}) {
  return {
    dev: {
      d1: 'd1-dev', r2: 'r2-dev', queue: 'queue-dev', dlq: 'dlq-dev',
      pixel: `sha256:${'1'.repeat(64)}`,
      token: `sha256:${'2'.repeat(64)}`,
      testEventCode: `sha256:${'3'.repeat(64)}`,
      dataKey: `sha256:${'4'.repeat(64)}`,
      ...(overrides.dev || {}),
    },
    production: {
      d1: 'd1-production', r2: 'r2-production', queue: 'queue-production', dlq: 'dlq-production',
      pixel: `sha256:${'5'.repeat(64)}`,
      token: `sha256:${'6'.repeat(64)}`,
      testEventCode: `sha256:${'7'.repeat(64)}`,
      dataKey: `sha256:${'8'.repeat(64)}`,
      ...(overrides.production || {}),
    },
  }
}

function passingLiveIsolation(commit = COMMIT) {
  const issuedAt = new Date().toISOString()
  const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60 * 1000).toISOString()
  const nonce = `nonce_${'a'.repeat(64)}`
  const attestation = (environment, seed) => ({
    schemaVersion: 1,
    environment,
    commitSha: commit,
    nonce,
    issuedAt,
    expiresAt,
    identities: {
      pixel: `hmac-sha256:${seed.repeat(64)}`,
      token: `hmac-sha256:${String(Number(seed) + 1).repeat(64)}`,
      testEventCode: `hmac-sha256:${String(Number(seed) + 2).repeat(64)}`,
      dataKey: `hmac-sha256:${String(Number(seed) + 3).repeat(64)}`,
    },
  })
  return compareLiveAttestations(attestation('dev', '1'), attestation('production', '5'), {
    commit,
    nonce,
    now: issuedAt,
  })
}
