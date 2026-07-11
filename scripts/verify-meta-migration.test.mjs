import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { runMetaMigrationVerification } from './verify-meta-migration.mjs'

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
    }] }])
  }
  if (name === 'meta-migration-query-indexes') {
    return JSON.stringify([{ results: [{ name: 'idx_conversion_delivery_action_channel', unique: 1 }] }])
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
    'meta-migration-query-history',
    'meta-migration-query-indexes',
    'meta-migration-query-setting',
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
          }] }])
        : mockJsonFor(options.name)
      return passedStep(options.name, stdout)
    }

    const result = await runMetaMigrationVerification({ runCommand })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /历史 Meta 事实未完整保留/)
  })

  it('在真实 D1 上顺序执行 0001-0039 并通过无重复 preflight', async () => {
    const result = await runMetaMigrationVerification({
      stateDir: path.join(integrationDir, 'clean'),
    })

    assert.equal(result.status, 'passed', result.error)
    assert.equal(result.duplicateGroupCount, 0)
  })

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
