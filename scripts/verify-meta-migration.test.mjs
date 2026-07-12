import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  main,
  metaMigrationExitCode,
  runMetaMigrationVerification,
  runRemoteMetaMigrationPreflight,
} from './verify-meta-migration.mjs'

const integrationDir = await mkdtemp(path.join(tmpdir(), 'meigallery-meta-verifier-'))

after(() => rm(integrationDir, { recursive: true, force: true }))

function passedStep(name, stdout = '') {
  return { name, status: 'passed', stdout, stderr: '', exitCode: 0, command: name, summary: stdout }
}

function failedStep(name) {
  return { name, status: 'failed', stdout: '', stderr: 'mock failure', exitCode: 1, command: name, summary: '' }
}

function createRunCommand(options = {}) {
  return async (_command, _args, runOptions = {}) => (
    runOptions.name === options.failName
      ? failedStep(runOptions.name)
      : passedStep(runOptions.name, mockJsonFor(runOptions.name, options))
  )
}

function mockJsonFor(name, options = {}) {
  if (name === 'meta-migration-preflight-0039') {
    return JSON.stringify([{ results: [{ duplicate_group_count: options.duplicateGroupCount ?? 0 }] }])
  }
  if (name === 'meta-migration-query-history') {
    return JSON.stringify([{ results: [{
      action_count: 1,
      delivery_count: 2,
      verification_count: 1,
      outbox_count: 1,
      claim_count: 1,
      pixel_target: 0,
      pixel_effective: 0,
      pixel_bucket: null,
      capi_target: 0,
      capi_effective: 0,
      capi_bucket: null,
      incident_count: 1,
      quality_count: 1,
    }] }])
  }
  if (name === 'meta-migration-query-schema' || name === 'meta-migration-empty-query-schema') {
    return JSON.stringify([{ results: [{
      delivery_unique_index: 1,
      circuit_index_count: 4,
      challenge_table: 1,
      challenge_table_sql: "CREATE TABLE meta_live_challenges (... CHECK (environment = 'production'))",
      challenge_index: 1,
      ticket_table: 1,
      ticket_index: 1,
      delivery_lease_index: 1,
      delivery_lease_token_column: 1,
      delivery_lease_expires_column: 1,
      delivery_lease_index_columns: 'delivery_lease_expires_at',
      delivery_lease_index_sql: "CREATE INDEX idx_meta_capi_delivery_lease_expiry ON analytics_conversion_deliveries(delivery_lease_expires_at) WHERE channel = 'meta_capi' AND delivery_lease_token <> ''",
      registration_recovery_cursor: '0',
      quality_contract_digest_column: 1,
      quality_contract_digest_index: 1,
      incident_table: 1,
      quality_table: 1,
    }] }])
  }
  if (name === 'meta-migration-query-setting') {
    return JSON.stringify([{ results: [{ value: '0' }] }])
  }
  return ''
}

describe('Meta migration 演练', () => {
  for (const name of [
    'meta-migration-apply-0001-0038',
    'meta-migration-seed',
    'meta-migration-preflight-0039',
    'meta-migration-apply-0039',
    'meta-migration-seed-0039-history',
    'meta-migration-apply-0040',
    'meta-migration-apply-0041',
    'meta-migration-apply-0042',
    'meta-migration-apply-0043',
    'meta-migration-apply-0044',
    'meta-migration-apply-0045',
    'meta-migration-query-history',
    'meta-migration-query-schema',
    'meta-migration-query-setting',
    'meta-migration-empty-apply-0001-0045',
    'meta-migration-empty-query-schema',
  ]) {
    it(`当 ${name} 命令失败时演练失败`, async () => {
      const result = await runMetaMigrationVerification({ runCommand: createRunCommand({ failName: name }) })
      assert.equal(result.status, 'failed')
      assert.equal(result.steps.at(-1)?.name, name)
    })
  }

  it('0039 前先执行只读 duplicate-group preflight', async () => {
    const calls = []
    const runCommand = async (command, args, options) => {
      calls.push({ command, args, options })
      return passedStep(options.name, mockJsonFor(options.name))
    }

    const result = await runMetaMigrationVerification({ runCommand })
    assert.equal(result.status, 'passed')
    const names = calls.map(call => call.options.name)
    assert.ok(names.indexOf('meta-migration-preflight-0039') < names.indexOf('meta-migration-apply-0039'))
    const preflight = calls.find(call => call.options.name === 'meta-migration-preflight-0039')
    assert.ok(preflight)
    const sql = preflight.args[preflight.args.indexOf('--command') + 1]
    assert.match(sql, /COUNT\(\*\) AS duplicate_group_count/i)
    assert.match(sql, /GROUP BY conversion_action_id, channel/i)
    assert.match(sql, /HAVING COUNT\(\*\) > 1/i)
    assert.doesNotMatch(sql, /external_event_id|SELECT\s+conversion_action_id/i)
  })

  it('发现重复组时只报告组数，立即停止且不自动修复', async () => {
    const calls = []
    const runCommand = async (command, args, options) => {
      calls.push({ command, args, options })
      return passedStep(options.name, mockJsonFor(options.name, { duplicateGroupCount: 2 }))
    }

    const result = await runMetaMigrationVerification({ runCommand })
    assert.equal(result.status, 'failed')
    assert.equal(result.duplicateGroupCount, 2)
    assert.equal(result.error, 'duplicate_group_count=2')
    assert.equal(calls.some(call => call.options.name === 'meta-migration-apply-0039'), false)
    assert.equal(calls.at(-1)?.options.name, 'meta-migration-preflight-0039')
    const serialized = JSON.stringify(result)
    for (const forbidden of ['action_duplicate', 'delivery_duplicate', 'external_event_id']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  })

  it('查询结果未保留任一历史事实时演练失败', async () => {
    const runCommand = async (_command, _args, options = {}) => {
      const stdout = options.name === 'meta-migration-query-history'
        ? JSON.stringify([{ results: [{
            action_count: 1,
            delivery_count: 2,
            verification_count: 0,
            outbox_count: 1,
            claim_count: 1,
            pixel_target: 0,
            pixel_effective: 0,
            pixel_bucket: null,
            capi_target: 0,
            capi_effective: 0,
            capi_bucket: null,
            incident_count: 1,
            quality_count: 1,
          }] }])
        : mockJsonFor(options.name)
      return passedStep(options.name, stdout)
    }

    const result = await runMetaMigrationVerification({ runCommand })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /历史 Meta 事实未完整保留/)
  })

  it('在真实 D1 上从旧库顺序执行 0039 至 0044 并保全历史事实', async () => {
    const result = await runMetaMigrationVerification({
      stateDir: path.join(integrationDir, 'clean'),
    })

    assert.equal(result.status, 'passed', result.error)
    assert.equal(result.duplicateGroupCount, 0)
    const names = result.steps.map(step => step.name)
    assert.ok(names.indexOf('meta-migration-apply-0039') < names.indexOf('meta-migration-apply-0040'))
    assert.ok(names.indexOf('meta-migration-apply-0040') < names.indexOf('meta-migration-apply-0041'))
    assert.ok(names.indexOf('meta-migration-apply-0041') < names.indexOf('meta-migration-apply-0042'))
    assert.ok(names.indexOf('meta-migration-apply-0042') < names.indexOf('meta-migration-apply-0043'))
    assert.ok(names.indexOf('meta-migration-apply-0043') < names.indexOf('meta-migration-apply-0044'))
    assert.ok(names.indexOf('meta-migration-apply-0044') < names.indexOf('meta-migration-apply-0045'))
    assert.ok(names.includes('meta-migration-empty-apply-0001-0045'))
    assert.ok(names.includes('meta-migration-empty-query-schema'))
  })

  for (const [label, field, value] of [
    ['delivery lease token 列', 'delivery_lease_token_column', 0],
    ['delivery lease expires 列', 'delivery_lease_expires_column', 0],
    ['delivery lease 索引目标列', 'delivery_lease_index_columns', 'delivery_lease_token'],
    ['delivery lease 部分索引 WHERE', 'delivery_lease_index_sql', 'CREATE INDEX broken'],
    ['registration recovery cursor', 'registration_recovery_cursor', '1'],
    ['Dataset Quality contract digest 列', 'quality_contract_digest_column', 0],
    ['Dataset Quality contract digest 索引', 'quality_contract_digest_index', 0],
  ]) {
    it(`${label} 不精确时旧库演练 fail closed`, async () => {
      const runCommand = async (_command, _args, options = {}) => {
        const stdout = mockJsonFor(options.name)
        if (options.name !== 'meta-migration-query-schema' && options.name !== 'meta-migration-empty-query-schema') {
          return passedStep(options.name, stdout)
        }
        const parsed = JSON.parse(stdout)
        parsed[0].results[0][field] = value
        return passedStep(options.name, JSON.stringify(parsed))
      }

      const result = await runMetaMigrationVerification({ runCommand })
      assert.equal(result.status, 'failed')
      assert.match(result.error, /0040-0045 schema/)
    })
  }

  it('在真实 D1 上阻断重复组且不执行 0039', async () => {
    const result = await runMetaMigrationVerification({
      stateDir: path.join(integrationDir, 'duplicate'),
      includeDuplicateFixture: true,
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.duplicateGroupCount, 1)
    assert.equal(result.error, 'duplicate_group_count=1')
    assert.equal(result.steps.some(step => step.name === 'meta-migration-apply-0039'), false)
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'action_legacy',
      'delivery_duplicate',
      'meta:Contact:duplicate',
      'external_event_id',
    ]) {
      assert.equal(serialized.includes(forbidden), false)
    }
  })
})

describe('目标 D1 duplicate preflight', () => {
  for (const [environment, database, envArgs] of [
    ['dev', 'meigallery-db-dev', ['--env', 'dev']],
    ['production', 'meigallery-db', ['--env', '']],
  ]) {
    it(`${environment} 固定使用目标 D1/env 和 remote 只读查询`, async () => {
      const calls = []
      const report = await runRemoteMetaMigrationPreflight({
        environment,
        runCommand: remotePreflightRunner(calls, { tablePresent: true, duplicateGroupCount: 0 }),
      })

      assert.deepEqual(report, {
        status: 'ready',
        tablePresent: true,
        duplicateGroupCount: 0,
      })
      assert.equal(calls.length, 2)
      for (const call of calls) {
        assert.equal(call.args.includes(database), true)
        assert.equal(hasAdjacent(call.args, envArgs[0], envArgs[1]), true)
        assert.equal(call.args.includes('--remote'), true)
        assert.equal(call.args.includes('--json'), true)
        assert.doesNotMatch(call.args.join(' '), /external_event_id/)
      }
      assert.match(commandSql(calls[0]), /sqlite_schema/)
      assert.match(commandSql(calls[1]), /COUNT\(\*\) AS duplicate_group_count/i)
    })
  }

  it('全新库无 delivery 表时视为 0 个重复组且不执行 group query', async () => {
    const calls = []
    const report = await runRemoteMetaMigrationPreflight({
      environment: 'dev',
      runCommand: remotePreflightRunner(calls, { tablePresent: false }),
    })

    assert.deepEqual(report, {
      status: 'ready',
      tablePresent: false,
      duplicateGroupCount: 0,
    })
    assert.equal(calls.length, 1)
  })

  it('发现重复组时只返回稳定状态和数量', async () => {
    const report = await runRemoteMetaMigrationPreflight({
      environment: 'production',
      runCommand: remotePreflightRunner([], { tablePresent: true, duplicateGroupCount: 3 }),
    })

    assert.deepEqual(report, {
      status: 'blocked_duplicates',
      tablePresent: true,
      duplicateGroupCount: 3,
    })
    assert.deepEqual(Object.keys(report).sort(), ['duplicateGroupCount', 'status', 'tablePresent'])
    assert.doesNotMatch(JSON.stringify(report), /action|delivery_|external|row/i)
  })

  it('只读命令失败或返回异常 envelope 时 fail closed', async () => {
    for (const runCommand of [
      async (_command, _args, options) => failedStep(options.name),
      async (_command, _args, options) => passedStep(options.name, JSON.stringify([{ results: [{ table_present: 2 }] }])),
    ]) {
      const report = await runRemoteMetaMigrationPreflight({ environment: 'dev', runCommand })
      assert.deepEqual(report, {
        status: 'check_failed',
        tablePresent: false,
        duplicateGroupCount: 0,
      })
    }
  })

  it('CLI 仅输出 preflight JSON contract', async () => {
    const outputs = []
    const report = await main(['preflight', '--env', 'dev'], {
      runCommand: remotePreflightRunner([], { tablePresent: true, duplicateGroupCount: 0 }),
      writeOutput: value => outputs.push(value),
    })

    assert.equal(outputs.length, 1)
    assert.deepEqual(JSON.parse(outputs[0]), report)
    assert.deepEqual(Object.keys(JSON.parse(outputs[0])).sort(), [
      'duplicateGroupCount',
      'status',
      'tablePresent',
    ])
  })

  it('CLI 对 duplicate blocked 和 check failed 返回非 0', () => {
    assert.equal(metaMigrationExitCode({ status: 'ready' }), 0)
    assert.equal(metaMigrationExitCode({ status: 'passed' }), 0)
    assert.equal(metaMigrationExitCode({ status: 'blocked_duplicates' }), 1)
    assert.equal(metaMigrationExitCode({ status: 'check_failed' }), 1)
  })
})

function remotePreflightRunner(calls, options) {
  return async (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions })
    const stdout = runOptions.name === 'meta-migration-remote-table-check'
      ? JSON.stringify([{ results: [{ table_present: options.tablePresent ? 1 : 0 }] }])
      : JSON.stringify([{ results: [{ duplicate_group_count: options.duplicateGroupCount ?? 0 }] }])
    return passedStep(runOptions.name, stdout)
  }
}

function commandSql(call) {
  return call.args[call.args.indexOf('--command') + 1]
}

function hasAdjacent(args, key, value) {
  const index = args.indexOf(key)
  return index >= 0 && args[index + 1] === value
}
