import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runMetaResourceVerification } from './verify-meta-resources.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const TOKEN = 'META_ACCESS_TOKEN_SHOULD_NOT_LEAK'
const TEST_CODE = 'META_TEST_CODE_SHOULD_NOT_LEAK'
const RESOURCE_ID = '714929cb-sensitive-resource-id'

describe('Meta Cloudflare 资源检查', () => {
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
    let status = 'passed'
    if (text.includes('queues info')) {
      stdout = `queue ok ${RESOURCE_ID}`
      if (options.failQueueInfo) status = 'failed'
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
      stdout = options.migrationPending ? 'Migrations to be applied:\n0034.sql' : 'No migrations to apply!'
    } else if (text.includes('d1 execute')) {
      let results
      if (runOptions.name.endsWith('migration-names')) {
        const names = [
          '0036_meta_capi_v2_secure_delivery.sql',
          '0037_meta_connection_revision.sql',
          '0038_conversion_dedupe_claims.sql',
          '0039_meta_capi_v2_operations.sql',
          '0040_meta_capi_circuit_indexes.sql',
        ].filter(name => name !== options.missingAppliedMigration)
        results = names.map(name => ({ name }))
      } else if (runOptions.name.endsWith('meta-connection')) {
        results = [{
          environment: text.includes('--env dev') ? 'dev' : 'production',
          pixel_id: options.connectionPixelDrift ? '9999999999' : '1234567890',
          graph_api_version: 'v25.0',
          verified_commit: COMMIT,
          verified_at: '2026-07-11T00:00:00.000Z',
          invalidated_at: options.connectionInvalidated ? '2026-07-11T00:01:00.000Z' : null,
          invalidation_reason: options.connectionInvalidated ? 'verification_invalidated' : '',
          revision: 'a'.repeat(32),
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
      stderr: '',
    }
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
