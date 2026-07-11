import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertReleaseVerificationSummary,
  recordReleaseVerificationSummary,
} from './release-verification-store.mjs'
import { readRemoteDevGate } from './verify-release.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

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

  it('真实 store 接受严格 V2 meta_live 摘要，写入后可由远端 gate 读取通过', async () => {
    let storedSummary = ''
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    const result = await recordReleaseVerificationSummary({
      environment: 'dev',
      verificationType: 'meta_live',
      commit: COMMIT,
      verifiedAt: '2026-07-10T00:00:00.000Z',
      summary: metaLiveSummary('dev', contract),
      runCommand: async (_command, args, options) => {
        const sql = args[args.indexOf('--command') + 1]
        const match = sql.match(/'((?:[^']|'')*)', '2026-07-10T00:00:00\.000Z'/)
        assert.ok(match)
        storedSummary = match[1].replaceAll("''", "'")
        return { name: options.name, status: 'passed', exitCode: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.status, 'passed')

    const gate = await readRemoteDevGate({
      commit: COMMIT,
      contract,
      now: '2026-07-10T12:00:00.000Z',
      runCommand: async (_command, _args, options) => ({
        name: options.name,
        status: 'passed',
        stdout: JSON.stringify([{ results: [{
          summary: storedSummary,
          verified_at: '2026-07-10T00:00:00.000Z',
          expires_at: '2026-07-11T00:00:00.000Z',
        }] }]),
        stderr: '',
        exitCode: 0,
      }),
    })
    assert.equal(gate.status, 'passed')
  })

  it('远端 dev gate 先拒绝非 40 位 commit，且不执行 D1 查询', async () => {
    await assert.rejects(readRemoteDevGate({
      commit: "a' OR 1=1 --",
      contract: { version: 3, digest: `sha256:${'9'.repeat(64)}` },
      runCommand: async () => assert.fail('非法 commit 不得进入 SQL'),
    }), /40 位 commit/)
  })

  it('远端 dev gate 复用 store schema，拒绝 false、乱序、raw ID 和额外字段', async () => {
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    for (const summary of [
      { ...metaLiveSummary('dev', contract), eventsVerified: false },
      { ...metaLiveSummary('dev', contract), events: ['CompleteRegistration', 'Contact'] },
      { ...metaLiveSummary('dev', contract), browserEventId: `mlv_${'a'.repeat(32)}` },
      { ...metaLiveSummary('dev', contract), raw: { eventId: 'raw-id' } },
    ]) {
      const gate = await readRemoteDevGate({
        commit: COMMIT,
        contract,
        now: '2026-07-10T12:00:00.000Z',
        runCommand: async (_command, _args, options) => ({
          name: options.name,
          status: 'passed',
          stdout: JSON.stringify([{ results: [{
            summary: JSON.stringify(summary),
            verified_at: '2026-07-10T00:00:00.000Z',
            expires_at: '2026-07-11T00:00:00.000Z',
          }] }]),
        }),
      })
      assert.equal(gate.status, 'failed', JSON.stringify(summary))
    }
  })

  it('远端 dev gate 应用层严格校验 verified_at/expires_at 及固定 TTL', async () => {
    const contract = { version: 3, digest: `sha256:${'9'.repeat(64)}` }
    for (const [verifiedAt, expiresAt, now] of [
      ['2026-07-10T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'],
      ['2026-07-10T12:01:00.000Z', '2026-07-11T12:01:00.000Z', '2026-07-10T12:00:00.000Z'],
      ['2026-07-10T00:00:00.000Z', '2026-07-10T23:59:59.000Z', '2026-07-10T12:00:00.000Z'],
      ['not-a-date', '2026-07-11T00:00:00.000Z', '2026-07-10T12:00:00.000Z'],
    ]) {
      const gate = await readRemoteDevGate({
        commit: COMMIT,
        contract,
        now,
        runCommand: async (_command, _args, options) => ({
          name: options.name,
          status: 'passed',
          stdout: JSON.stringify([{ results: [{
            summary: JSON.stringify(metaLiveSummary('dev', contract)),
            verified_at: verifiedAt,
            expires_at: expiresAt,
          }] }]),
        }),
      })
      assert.equal(gate.status, 'failed', `${verifiedAt} / ${expiresAt} / ${now}`)
    }
  })

  it('meta_resources 对 bootstrap/post-deploy/full 使用严格 phase 语义', () => {
    const bootstrap = metaResourcesSummary('bootstrap')
    assert.doesNotThrow(() => assertReleaseVerificationSummary({
      environment: 'production', verificationType: 'meta_resources', commit: COMMIT, summary: bootstrap,
    }))
    for (const summary of [
      { ...bootstrap, migrationsApplied: false },
      { ...bootstrap, connectionVerified: true },
      { ...bootstrap, liveAttestation: true },
      { ...bootstrap, environmentIsolation: { ...bootstrap.environmentIsolation, pixel: true } },
      { ...metaResourcesSummary('post-deploy'), verificationPhase: 'bootstrap' },
      { ...metaResourcesSummary('full'), verificationPhase: 'post-deploy' },
    ]) {
      assert.throws(() => assertReleaseVerificationSummary({
        environment: 'production', verificationType: 'meta_resources', commit: COMMIT, summary,
      }), /summary|bootstrap|post-deploy|full|门禁|语义/)
    }
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
    schemaVersion: 2,
    verificationPhase: phase,
    bootstrapReady: bootstrap,
    liveAttestation: !bootstrap,
    migrationsReady: true,
    d1Ready: true,
    r2Ready: true,
    queuesReady: true,
    secretsReady: true,
    migrationsCurrent: true,
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
      pixel: !bootstrap, token: !bootstrap, testEventCode: !bootstrap, dataKey: !bootstrap,
    },
  }
}
