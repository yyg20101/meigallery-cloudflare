import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertReleaseVerificationSummary,
  recordReleaseVerificationSummary,
} from './release-verification-store.mjs'
import {
  createProductionPostDeployMetaResourcesSummary,
  PRODUCTION_POST_DEPLOY_META_RESOURCES_FIELDS,
} from './meta-resources-summary-fixture.mjs'
import { readRemoteProductionLiveGate } from './verify-release.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

function liveGateRow(overrides = {}) {
  return {
    summary: JSON.stringify(metaLiveSummary('production')),
    verified_at: '2026-07-10T00:00:00.000Z',
    expires_at: '2026-07-11T00:00:00.000Z',
    connection_verified_commit: COMMIT,
    connection_verified_at: '2026-07-09 23:00:00',
    ...overrides,
  }
}

describe('发布验证 D1 摘要存储', () => {
  it('production 使用空命名环境和生产 D1，并只写布尔摘要', async () => {
    let captured
    const result = await recordReleaseVerificationSummary({
      environment: 'production',
      verificationType: 'meta_resources',
      commit: COMMIT,
      verifiedAt: '2026-07-10T00:00:00.000Z',
      summary: metaResourcesSummary(),
      runCommand: async (command, args, options) => {
        captured = { command, args, options }
        return { name: options.name, status: 'passed', exitCode: 0, stdout: 'resource-id-sensitive', stderr: '', summary: 'raw output' }
      },
    })

    assert.equal(captured.command, 'corepack')
    assert.deepEqual(captured.args.slice(0, 8), [
      'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    ])
    assert.deepEqual(captured.args.slice(8, 10), ['--env', ''])
    const sql = captured.args[captured.args.indexOf('--command') + 1]
    assert.match(sql, new RegExp(`rvf_production_meta_resources_${COMMIT}`))
    assert.match(sql, /2026-07-11T00:00:00\.000Z/)
    assert.equal(sql.includes('resource-id-sensitive'), false)
    assert.equal(result.stdout, undefined)
    assert.equal(result.stderr, undefined)
  })

  it('dev 使用 dev 命名环境和独立 D1', async () => {
    let args
    await recordReleaseVerificationSummary({
      environment: 'dev',
      verificationType: 'meta_live',
      commit: COMMIT,
      verifiedAt: '2026-07-10T00:00:00.000Z',
      summary: metaLiveSummary('dev'),
      runCommand: async (_command, commandArgs, options) => {
        args = commandArgs
        return { name: options.name, status: 'passed', exitCode: 0, stdout: '', stderr: '', summary: 'ok' }
      },
    })

    assert.equal(args.includes('meigallery-db-dev'), true)
    assert.deepEqual(args.slice(args.indexOf('meigallery-db-dev') + 1, args.indexOf('meigallery-db-dev') + 3), ['--env', 'dev'])
  })

  it('真实 production store 接受严格 V2 meta_live 摘要，写入后可由远端 gate 读取通过', async () => {
    let storedSummary = ''
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    const result = await recordReleaseVerificationSummary({
      environment: 'production',
      verificationType: 'meta_live',
      commit: COMMIT,
      verifiedAt: '2026-07-10T00:00:00.000Z',
      summary: metaLiveSummary('production', contract),
      runCommand: async (_command, args, options) => {
        const sql = args[args.indexOf('--command') + 1]
        const match = sql.match(/'((?:[^']|'')*)', '2026-07-10T00:00:00\.000Z'/)
        assert.ok(match)
        storedSummary = match[1].replaceAll("''", "'")
        return { name: options.name, status: 'passed', exitCode: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.status, 'passed')

    const gate = await readRemoteProductionLiveGate({
      commit: COMMIT,
      contract,
      now: '2026-07-10T12:00:00.000Z',
      runCommand: async (_command, _args, options) => ({
        name: options.name,
        status: 'passed',
        stdout: JSON.stringify([{ results: [liveGateRow({ summary: storedSummary })] }]),
        stderr: '',
        exitCode: 0,
      }),
    })
    assert.equal(gate.status, 'passed')
  })

  it('远端 production gate 不把待发布 commit 写入 D1 查询', async () => {
    const gate = await readRemoteProductionLiveGate({
      commit: "a' OR 1=1 --",
      contract: { version: 3, digest: `sha256:${'9'.repeat(64)}` },
      now: '2026-07-10T12:00:00.000Z',
      runCommand: async (_command, args, options) => {
        const sql = args[args.indexOf('--command') + 1]
        assert.doesNotMatch(sql, /OR 1=1|commit_sha\s*=/)
        return {
          name: options.name,
          status: 'passed',
          stdout: JSON.stringify([{ results: [liveGateRow({
            summary: JSON.stringify(metaLiveSummary('production', { version: 3, digest: `sha256:${'9'.repeat(64)}` })),
          })] }]),
          stderr: '',
          exitCode: 0,
        }
      },
    })
    assert.equal(gate.status, 'passed')
  })

  it('远端 production gate 复用 store schema，拒绝 false、乱序、raw ID 和额外字段', async () => {
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    for (const summary of [
      { ...metaLiveSummary('production', contract), eventsVerified: false },
      { ...metaLiveSummary('production', contract), events: ['CompleteRegistration', 'Contact'] },
      { ...metaLiveSummary('production', contract), browserEventId: `mlv_${'a'.repeat(32)}` },
      { ...metaLiveSummary('production', contract), raw: { eventId: 'raw-id' } },
    ]) {
      const gate = await readRemoteProductionLiveGate({
        commit: COMMIT,
        contract,
        now: '2026-07-10T12:00:00.000Z',
        runCommand: async (_command, _args, options) => ({
          name: options.name,
          status: 'passed',
          stdout: JSON.stringify([{ results: [liveGateRow({ summary: JSON.stringify(summary) })] }]),
        }),
      })
      assert.equal(gate.status, 'failed', JSON.stringify(summary))
    }
  })

  it('远端 production gate 允许连接未变化的 30 天内人工确认复用', async () => {
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    const gate = await readRemoteProductionLiveGate({
      commit: COMMIT,
      contract,
      now: '2026-07-20T00:00:00.000Z',
      runCommand: async (_command, _args, options) => ({
        name: options.name,
        status: 'passed',
        stdout: JSON.stringify([{ results: [liveGateRow({
          summary: JSON.stringify(metaLiveSummary('production', contract)),
        })] }]),
      }),
    })

    assert.equal(gate.status, 'passed')
    assert.equal(gate.expiresAt, '2026-08-09T00:00:00.000Z')
  })

  it('远端 production gate 严格校验来源 TTL、30 天时效与连接身份', async () => {
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    for (const [row, now] of [
      [liveGateRow({ verified_at: '2026-07-10T12:01:00.000Z', expires_at: '2026-07-11T12:01:00.000Z' }), '2026-07-10T12:00:00.000Z'],
      [liveGateRow({ expires_at: '2026-07-10T23:59:59.000Z' }), '2026-07-10T12:00:00.000Z'],
      [liveGateRow({ verified_at: 'not-a-date' }), '2026-07-10T12:00:00.000Z'],
      [liveGateRow(), '2026-08-09T00:00:00.000Z'],
      [liveGateRow({ connection_verified_at: '2026-07-10 00:00:01' }), '2026-07-10T12:00:00.000Z'],
      [liveGateRow({ connection_verified_commit: 'b'.repeat(40) }), '2026-07-10T12:00:00.000Z'],
    ]) {
      const gate = await readRemoteProductionLiveGate({
        commit: COMMIT,
        contract,
        now,
        runCommand: async (_command, _args, options) => ({
          name: options.name,
          status: 'passed',
          stdout: JSON.stringify([{ results: [{
            ...row,
            summary: JSON.stringify(metaLiveSummary('production', contract)),
          }] }]),
        }),
      })
      assert.equal(gate.status, 'failed', `${JSON.stringify(row)} / ${now}`)
    }
  })

  it('meta_resources 对 bootstrap/post-deploy/full 使用严格 phase 语义', () => {
    const bootstrap = metaResourcesSummary('bootstrap')
    assert.doesNotThrow(() => assertReleaseVerificationSummary({
      environment: 'production', verificationType: 'meta_resources', commit: COMMIT, summary: bootstrap,
    }))
    assert.doesNotThrow(() => assertReleaseVerificationSummary({
      environment: 'production', verificationType: 'meta_resources', commit: COMMIT,
      summary: { ...bootstrap, connectionVerified: true },
    }))
    for (const summary of [
      { ...bootstrap, migrationsApplied: false },
      { ...bootstrap, liveAttestation: true },
      { ...bootstrap, environmentIsolation: { ...bootstrap.environmentIsolation, pixel: true } },
      { ...metaResourcesSummary('post-deploy'), verificationPhase: 'bootstrap' },
      { ...metaResourcesSummary('post-deploy'), migrationsCurrent: false },
      { ...metaResourcesSummary('full'), migrationsCurrent: false },
      { ...metaResourcesSummary('full'), verificationPhase: 'post-deploy' },
      { ...metaResourcesSummary('full'), liveAttestation: true },
    ]) {
      assert.throws(() => assertReleaseVerificationSummary({
        environment: 'production', verificationType: 'meta_resources', commit: COMMIT, summary,
      }), /summary|bootstrap|post-deploy|full|门禁|语义/)
    }
  })

  it('production post-deploy 共享摘要 fixture 只接受完整精确字段集', () => {
    const summary = createProductionPostDeployMetaResourcesSummary()
    assert.deepEqual(Object.keys(summary).sort(), [...PRODUCTION_POST_DEPLOY_META_RESOURCES_FIELDS].sort())
    assert.doesNotThrow(() => assertReleaseVerificationSummary({
      environment: 'production', verificationType: 'meta_resources', commit: COMMIT, summary,
    }))
  })

  it('V2 meta_live 只接受精确 allowlist，拒绝 secret、PII、raw ID 与任意对象', async () => {
    for (const summary of [
      { ...metaLiveSummary('dev'), accessToken: 'secret-token' },
      { ...metaLiveSummary('dev'), email: 'owner@example.com' },
      { ...metaLiveSummary('dev'), browserEventId: `mlv_${'a'.repeat(32)}` },
      { ...metaLiveSummary('dev'), events: [{ eventName: 'Contact' }] },
      { ...metaLiveSummary('dev'), environment: 'production' },
      { ...metaLiveSummary('dev'), commitSha: 'b'.repeat(40) },
    ]) {
      await assert.rejects(recordReleaseVerificationSummary({
        environment: 'dev', verificationType: 'meta_live', commit: COMMIT,
        verifiedAt: '2026-07-10T00:00:00.000Z', summary,
        runCommand: async () => assert.fail('非法摘要不得执行写入'),
      }), /summary|字段|Meta live|非法|一致/)
    }
  })

  it('拒绝非法 type、commit 和非布尔摘要，避免敏感值进入 SQL', async () => {
    for (const overrides of [
      { verificationType: 'other' },
      { commit: 'short-sha' },
      { summary: { tokenPresent: 'SECRET_TOKEN_VALUE' } },
    ]) {
      await assert.rejects(async () => {
        await recordReleaseVerificationSummary({
          environment: 'dev',
          verificationType: 'meta_live',
          commit: COMMIT,
          verifiedAt: '2026-07-10T00:00:00.000Z',
          summary: metaLiveSummary('dev'),
          runCommand: async () => assert.fail('非法输入不得执行命令'),
          ...overrides,
        })
      })
    }
  })
})

function metaLiveSummary(environment, contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }) {
  return {
    schemaVersion: 2,
    commitSha: COMMIT,
    environment,
    events: ['Contact', 'CompleteRegistration'],
    eventsVerified: true,
    forbiddenEventsAbsent: true,
    datasetQualityContractVersion: contract.version,
    datasetQualityContractDigest: contract.digest,
  }
}

function metaResourcesSummary(phase = 'full') {
  const bootstrap = phase === 'bootstrap'
  const postDeploy = phase === 'post-deploy'
  return {
    schemaVersion: 3,
    verificationPhase: phase,
    bootstrapReady: bootstrap,
    liveAttestation: postDeploy,
    migrationsReady: true,
    d1Ready: true,
    r2Ready: true,
    queuesReady: true,
    secretsReady: true,
    migrationsCurrent: !bootstrap,
    migrationsApplied: true,
    connectionVerified: phase === 'full',
    capiEnabled: false,
    initialMetaRollout: bootstrap,
    noOpenCriticalIncident: true,
    initialRolloutZero: true,
    secureOutboxReady: true,
    previousKeyReferencesExplainable: true,
    rolloutZero: true,
    environmentIsolation: {
      d1: true, r2: true, queue: true, dlq: true,
      pixel: !bootstrap, token: !bootstrap, dataKey: !bootstrap,
    },
  }
}
