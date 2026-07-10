import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runMetaMigrationVerification } from './verify-meta-migration.mjs'

function passedStep(name, stdout = '') {
  return { name, status: 'passed', stdout, stderr: '', exitCode: 0 }
}

function failedStep(name) {
  return { name, status: 'failed', stdout: '', stderr: 'mock failure', exitCode: 1 }
}

function createRunCommand(failName) {
  return async (_command, _args, options = {}) => (
    options.name === failName ? failedStep(options.name) : passedStep(options.name, mockJsonFor(options.name))
  )
}

function mockJsonFor(name) {
  if (name === 'meta-migration-query-deliveries') {
    return JSON.stringify([{ results: [
      { id: 'delivery_pixel', conversion_action_id: 'action_legacy', channel: 'meta_pixel', external_event_id: 'meta:Contact:old_pixel', event_name: 'Contact', status: 'sent', skip_reason: '', error_code: '', error_message: '', attempt_count: 2, last_attempt_at: '2026-07-10T00:00:00.000Z', sent_at: '2026-07-10T00:01:00.000Z', created_at: '2026-07-09T00:00:00.000Z', updated_at: '2026-07-10T00:01:00.000Z', has_fbp: 0, has_fbc: 0 },
      { id: 'delivery_capi', conversion_action_id: 'action_legacy', channel: 'meta_capi', external_event_id: 'meta:Contact:old_capi', event_name: 'Contact', status: 'pending', skip_reason: '', error_code: '', error_message: '', attempt_count: 0, last_attempt_at: null, sent_at: null, created_at: '2026-07-09T00:00:00.000Z', updated_at: '2026-07-09T00:00:00.000Z', has_fbp: 0, has_fbc: 0 },
    ] }])
  }
  if (name === 'meta-migration-query-indexes') {
    return JSON.stringify([{ results: [
      { name: 'idx_analytics_conversion_deliveries_status' },
      { name: 'idx_analytics_conversion_deliveries_external' },
    ] }])
  }
  if (name === 'meta-migration-query-setting') {
    return JSON.stringify([{ results: [{ value: '"disabled"' }] }])
  }
  return ''
}

describe('Meta migration 演练', () => {
  for (const name of [
    'meta-migration-seed',
    'meta-migration-apply-0034',
    'meta-migration-query-deliveries',
    'meta-migration-query-indexes',
    'meta-migration-query-setting',
    'meta-migration-insert-attempted',
  ]) {
    it(`当 ${name} 失败时演练失败`, async () => {
      const result = await runMetaMigrationVerification({ runCommand: createRunCommand(name) })
      assert.equal(result.status, 'failed')
      assert.equal(result.steps.at(-1)?.name, name)
    })
  }

  it('当查询结果未保留历史字段时演练失败', async () => {
    const runCommand = async (_command, _args, options = {}) => {
      const stdout = options.name === 'meta-migration-query-deliveries'
        ? JSON.stringify([{ results: [] }])
        : mockJsonFor(options.name)
      return passedStep(options.name, stdout)
    }

    const result = await runMetaMigrationVerification({ runCommand })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /历史 delivery 数量不匹配/)
  })
})
