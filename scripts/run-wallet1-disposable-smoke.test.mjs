import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  WALLET1_DISPOSABLE_CONFIRMATION,
  WALLET1_DISPOSABLE_RUN_KIND,
  cleanupDisposableResources,
  createDisposableResourceIdentity,
  createTemporaryWorkerConfig,
  parseD1DatabaseInfo,
  parseTemporaryWorkerUrl,
  runDisposableWallet1Smoke,
  validateDisposableResourceIdentity,
  validateDisposableSmokeGate,
  validateTemporaryWorkerConfig,
} from './run-wallet1-disposable-smoke.mjs'

const NOW = new Date('2026-08-08T06:30:00.000Z')
const COMMIT = 'c'.repeat(40)
const SUFFIX = 'a1b2c3d4e5f6'
const DATABASE_ID = '11111111-2222-3333-4444-555555555555'

describe('Wallet-1 一次性 D1 + Worker 冒烟门禁', () => {
  it('默认 gate 保持 fail-closed，三个开放决策和位置缺一不可', () => {
    const gate = approvedGate()
    gate.remoteSmokeAuthorized = false
    assert.throws(() => validateDisposableSmokeGate(gate, NOW), /WALLET1_SMOKE_GATE_NOT_AUTHORIZED/u)

    for (const decisionId of ['OQ-018', 'OQ-020', 'OQ-024']) {
      const candidate = approvedGate()
      candidate.decisions[decisionId].status = 'unresolved'
      assert.throws(
        () => validateDisposableSmokeGate(candidate, NOW),
        new RegExp(`WALLET1_SMOKE_GATE_${decisionId.replace('-', '_')}_UNRESOLVED`, 'u'),
      )
    }

    const placement = approvedGate()
    placement.placement = { mode: 'unresolved', value: null }
    assert.throws(() => validateDisposableSmokeGate(placement, NOW), /WALLET1_SMOKE_GATE_PLACEMENT_UNRESOLVED/u)
  })

  it('只接受短期授权、合成数据、聚合证据和保守钱包边界', () => {
    assert.equal(validateDisposableSmokeGate(approvedGate(), NOW).placement.value, 'apac')

    const stale = approvedGate()
    stale.authorization.expiresAt = '2026-08-16T00:00:00.000Z'
    assert.throws(() => validateDisposableSmokeGate(stale, NOW), /AUTHORIZATION_EXPIRED/u)

    const unsafe = approvedGate()
    unsafe.resourcePolicy.allowNegativeBalance = true
    assert.throws(() => validateDisposableSmokeGate(unsafe, NOW), /RESOURCE_POLICY_INVALID/u)
  })
})

describe('Wallet-1 一次性资源边界', () => {
  it('资源名高熵且不能指向 production/dev 共享资源', () => {
    const identity = createDisposableResourceIdentity(NOW, SUFFIX)
    assert.equal(validateDisposableResourceIdentity(identity), true)
    assert.match(identity.databaseName, /^mei-w1-db-/u)
    assert.match(identity.workerName, /^mei-w1-api-/u)
    assert.throws(
      () => validateDisposableResourceIdentity({
        ...identity,
        databaseName: 'meigallery-db-dev',
      }),
      /DATABASE_NAME_INVALID/u,
    )
  })

  it('临时 Worker 配置只绑定一次性 D1，不包含路由、R2、队列或密钥', () => {
    const identity = createDisposableResourceIdentity(NOW, SUFFIX)
    const config = createTemporaryWorkerConfig({
      workerName: identity.workerName,
      databaseName: identity.databaseName,
      databaseId: DATABASE_ID,
      commit: COMMIT,
    })
    assert.equal(validateTemporaryWorkerConfig(config), true)
    assert.equal(config.d1_databases.length, 1)
    assert.equal(config.vars.APP_WALLET_ENABLED, 'true')
    assert.equal(config.vars.APP_AUTH_REGISTRATION_ENABLED, 'false')
    assert.equal(Object.hasOwn(config, 'routes'), false)
    assert.equal(Object.hasOwn(config, 'r2_buckets'), false)
    assert.equal(Object.hasOwn(config, 'triggers'), false)
    assert.doesNotMatch(JSON.stringify(config), /SESSION_SECRET|STREAM_API_TOKEN|meigallery-db-dev/u)
  })

  it('稳健解析 D1 UUID 与精确 workers.dev 地址', () => {
    const identity = createDisposableResourceIdentity(NOW, SUFFIX)
    assert.deepEqual(
      parseD1DatabaseInfo(JSON.stringify({ result: { uuid: DATABASE_ID, name: identity.databaseName } })),
      { id: DATABASE_ID, name: identity.databaseName },
    )
    const url = `https://${identity.workerName}.wajie.workers.dev`
    assert.equal(parseTemporaryWorkerUrl(`Deployed ${url}`, identity.workerName), url)
    assert.throws(
      () => parseTemporaryWorkerUrl('https://meigallery-api-dev.wajie.workers.dev', identity.workerName),
      /WORKER_URL_NOT_FOUND/u,
    )
  })
})

describe('Wallet-1 一次性资源生命周期', () => {
  it('按 D1 创建、迁移、合成 seed、Worker 部署、冒烟、先 Worker 后 D1 销毁执行', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'wallet1-disposable-state-'))
    const commands = []
    let capturedConfig = null
    try {
      const identity = createDisposableResourceIdentity(NOW, SUFFIX)
      const result = await runDisposableWallet1Smoke(baseRunOptions({
        stateRoot,
        identity,
        runCommand: async (_command, args, context) => {
          const wranglerArgs = args.slice(5)
          commands.push({ name: context.name, args: wranglerArgs })
          if (context.name === 'wallet1-disposable-d1-info') {
            return passed(JSON.stringify({ uuid: DATABASE_ID, name: identity.databaseName }))
          }
          if (context.name === 'wallet1-disposable-migrations-list') return passed('No migrations to apply!')
          if (context.name === 'wallet1-disposable-worker-deploy') {
            const configIndex = wranglerArgs.indexOf('--config')
            capturedConfig = JSON.parse(await readFile(wranglerArgs[configIndex + 1], 'utf8'))
            return passed(`Deployed https://${identity.workerName}.wajie.workers.dev`)
          }
          return passed('ok')
        },
      }))

      assert.equal(result.status, 'passed')
      assert.deepEqual(commands.map(command => command.name), [
        'wallet1-disposable-d1-create',
        'wallet1-disposable-d1-info',
        'wallet1-disposable-migrations-apply',
        'wallet1-disposable-migrations-list',
        'wallet1-disposable-seed',
        'wallet1-disposable-worker-deploy',
        'wallet1-disposable-worker-delete',
        'wallet1-disposable-d1-delete',
      ])
      assert.equal(capturedConfig.name, identity.workerName)
      assert.equal(capturedConfig.d1_databases[0].database_id, DATABASE_ID)
      const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'))
      assert.equal(evidence.result.status, 'passed')
      assert.equal(evidence.cleanup.worker, 'deleted')
      assert.equal(evidence.cleanup.database, 'deleted')
      assert.equal(Object.hasOwn(evidence, 'resources'), false)
      await assert.rejects(access(path.join(stateRoot, 'runs', identity.runId)))
    }
    finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it('业务冒烟失败仍销毁 Worker 和 D1，并只保留聚合失败证据', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'wallet1-disposable-state-'))
    const commands = []
    try {
      const identity = createDisposableResourceIdentity(NOW, SUFFIX)
      await assert.rejects(
        runDisposableWallet1Smoke(baseRunOptions({
          stateRoot,
          identity,
          runFunctionalSmoke: async () => { throw new Error('FUNCTIONAL_SMOKE_FAILED_FOR_TEST') },
          runCommand: async (_command, args, context) => {
            commands.push(context.name)
            if (context.name === 'wallet1-disposable-d1-info') {
              return passed(JSON.stringify({ uuid: DATABASE_ID, name: identity.databaseName }))
            }
            if (context.name === 'wallet1-disposable-migrations-list') return passed('No migrations')
            if (context.name === 'wallet1-disposable-worker-deploy') {
              return passed(`https://${identity.workerName}.wajie.workers.dev`)
            }
            return passed('ok')
          },
        })),
        /FUNCTIONAL_SMOKE_FAILED_FOR_TEST/u,
      )
      assert.ok(commands.indexOf('wallet1-disposable-worker-delete') > commands.indexOf('wallet1-disposable-worker-deploy'))
      assert.ok(commands.indexOf('wallet1-disposable-d1-delete') > commands.indexOf('wallet1-disposable-worker-delete'))
      const evidenceFiles = await import('node:fs/promises').then(fs => fs.readdir(path.join(stateRoot, 'evidence')))
      assert.equal(evidenceFiles.length, 1)
      const evidence = JSON.parse(await readFile(path.join(stateRoot, 'evidence', evidenceFiles[0]), 'utf8'))
      assert.equal(evidence.result.status, 'failed')
      assert.equal(evidence.result.errorCode, 'FUNCTIONAL_SMOKE_FAILED_FOR_TEST')
    }
    finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it('恢复销毁只接受严格的一次性 manifest，并始终先删 Worker', async () => {
    const identity = createDisposableResourceIdentity(NOW, SUFFIX)
    const manifest = validManifest(identity)
    const commands = []
    const cleanup = await cleanupDisposableResources(manifest, {
      runCommand: async (_command, _args, context) => {
        commands.push(context.name)
        return passed('ok')
      },
    })
    assert.equal(cleanup.status, 'passed')
    assert.deepEqual(commands, ['wallet1-disposable-worker-delete', 'wallet1-disposable-d1-delete'])

    const dangerous = validManifest(identity)
    dangerous.resources.database.name = 'meigallery-db-dev'
    await assert.rejects(
      cleanupDisposableResources(dangerous, { runCommand: async () => passed('ok') }),
      /DATABASE_NAME_INVALID/u,
    )
  })
})

function approvedGate() {
  const approval = {
    scope: 'wallet1_disposable_synthetic_smoke',
    status: 'approved',
    approvedAt: '2026-08-08T00:00:00.000Z',
    approvedBy: ['测试审批人'],
  }
  return {
    schemaVersion: 1,
    kind: 'wallet1-disposable-smoke-gate',
    remoteSmokeAuthorized: true,
    authorization: { ...approval, expiresAt: '2026-08-09T00:00:00.000Z' },
    decisions: Object.fromEntries(['OQ-018', 'OQ-020', 'OQ-024'].map(id => [id, { ...approval }])),
    placement: { mode: 'location', value: 'apac' },
    resourcePolicy: {
      syntheticDataOnly: true,
      evidenceMode: 'aggregate_only',
      maximumLifetimeMinutes: 30,
      requireIndependentReview: true,
      allowNegativeBalance: false,
      batchAdjustmentsEnabled: false,
    },
  }
}

function baseRunOptions(overrides = {}) {
  return {
    confirmDisposable: WALLET1_DISPOSABLE_CONFIRMATION,
    gate: approvedGate(),
    now: () => new Date(NOW),
    getRepositoryState: async () => ({
      branch: 'dev',
      commit: COMMIT,
      originDevCommit: COMMIT,
      trackedStatus: '',
    }),
    waitForWorker: async () => {},
    runFunctionalSmoke: async () => ({
      status: 'passed',
      aggregate: { walletBalance: 15, entryCount: 4 },
      checks: { immutableLedger: true },
    }),
    stdout: { write() {} },
    ...overrides,
  }
}

function validManifest(identity) {
  return {
    schemaVersion: 1,
    kind: WALLET1_DISPOSABLE_RUN_KIND,
    runId: identity.runId,
    resources: {
      database: { name: identity.databaseName, id: DATABASE_ID, state: 'created' },
      worker: {
        name: identity.workerName,
        url: `https://${identity.workerName}.wajie.workers.dev`,
        state: 'deployed',
      },
    },
    cleanup: { status: 'pending' },
  }
}

function passed(stdout = '') {
  return { status: 'passed', stdout, stderr: '' }
}
