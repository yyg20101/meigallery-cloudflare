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
    assert.equal(report.capiEnabled, false)
    assert.equal(report.secretsPresent, true)
    assert.deepEqual(findCall(calls, 'secret', 'list').args.slice(-4), ['--env', '', '--format', 'json'])
    const d1Calls = calls.filter(call => call.args.includes('d1'))
    assert.equal(d1Calls.every(call => call.args.includes('meigallery-db')), true)
    assert.equal(d1Calls.every(call => hasAdjacent(call.args, '--env', '')), true)
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
      runCommand: createPassingRunner(calls, { capiEnabled: true }),
      recordSummary: async () => ({ status: 'passed' }),
    })

    assert.equal(report.status, 'passed')
    assert.equal(report.database, 'meigallery-db-dev')
    assert.deepEqual(report.queues, ['meigallery-meta-capi-dev', 'meigallery-meta-capi-dev-dlq'])
    assert.deepEqual(findCall(calls, 'secret', 'list').args.slice(-4), ['--env', 'dev', '--format', 'json'])
    assert.equal(calls.filter(call => call.args.includes('d1')).every(call => hasAdjacent(call.args, '--env', 'dev')), true)
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

  it('缺 token 或 Test Code 时 release 资源检查失败且不记录摘要', async () => {
    for (const secretNames of [
      ['META_CAPI_ACCESS_TOKEN'],
      ['META_CAPI_TEST_EVENT_CODE'],
      [],
    ]) {
      let stored = false
      const report = await runMetaResourceVerification({
        environment: 'production',
        commit: COMMIT,
        runCommand: createPassingRunner([], { capiEnabled: false, secretNames }),
        recordSummary: async () => {
          stored = true
        },
      })
      assert.equal(report.status, 'failed')
      assert.equal(stored, false)
    }
  })

  it('待应用 migration、consumer 缺失或命令失败时保守失败', async () => {
    for (const overrides of [
      { migrationPending: true },
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
      stdout = JSON.stringify(options.missingConsumer ? [] : [{ service_name: worker, resource_id: RESOURCE_ID }])
    } else if (text.includes('secret list')) {
      const secretNames = options.secretNames ?? ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_TEST_EVENT_CODE']
      stdout = JSON.stringify(secretNames.map(name => ({ name, value: name === 'META_CAPI_ACCESS_TOKEN' ? TOKEN : TEST_CODE })))
    } else if (text.includes('migrations list')) {
      stdout = options.migrationPending ? 'Migrations to be applied:\n0034.sql' : 'No migrations to apply!'
    } else if (text.includes('d1 execute')) {
      stdout = JSON.stringify([{ results: [{ value: options.capiEnabled ? 'true' : 'false', raw: `${TOKEN}-${TEST_CODE}-${RESOURCE_ID}` }] }])
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
