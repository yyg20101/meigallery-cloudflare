import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTRIBUTION_BOOTSTRAP_SECRET_NAMES,
  bootstrapAttributionWorker,
} from './bootstrap-attribution-worker.mjs'

test('首次部署在一个版本中注入三把独立 Secret 且不写入日志', async () => {
  const logs = []
  let deployedSecrets = null
  let sequence = 0

  const result = await bootstrapAttributionWorker({
    apply: true,
    workerExists: async () => false,
    generateSecret: () => `secret-${++sequence}-${'x'.repeat(40)}`,
    deployWithSecrets: async (secrets) => {
      deployedSecrets = secrets
    },
    log: message => logs.push(message),
  })

  assert.equal(result.applied, true)
  assert.deepEqual(
    Object.keys(deployedSecrets).sort(),
    [...ATTRIBUTION_BOOTSTRAP_SECRET_NAMES].sort(),
  )
  assert.equal(new Set(Object.values(deployedSecrets)).size, 3)
  for (const value of Object.values(deployedSecrets)) {
    assert.ok(value.length >= 32)
    assert.ok(logs.every(message => !message.includes(value)))
  }
})

test('已有 Worker 时拒绝覆盖 Secret，dry-run 不生成或部署', async () => {
  let generated = 0
  let deployed = 0

  await assert.rejects(
    bootstrapAttributionWorker({
      apply: true,
      workerExists: async () => true,
      generateSecret: () => {
        generated += 1
        return 'x'.repeat(48)
      },
      deployWithSecrets: async () => {
        deployed += 1
      },
      log: () => {},
    }),
    /ATTRIBUTION_BOOTSTRAP_WORKER_ALREADY_EXISTS/,
  )

  const dryRun = await bootstrapAttributionWorker({
    apply: false,
    workerExists: async () => false,
    generateSecret: () => {
      generated += 1
      return 'x'.repeat(48)
    },
    deployWithSecrets: async () => {
      deployed += 1
    },
    log: () => {},
  })

  assert.equal(dryRun.applied, false)
  assert.equal(generated, 0)
  assert.equal(deployed, 0)
})
