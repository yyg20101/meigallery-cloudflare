import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertProductionReleaseIdentity,
  collectTrustedProductionGateFacts,
  main,
  runLocalAttributionGates,
  runQuickVerification,
  runReleaseVerification,
  verifyProductionReleaseIdentity,
} from './verify-release.mjs'
import { assertReportCanGateProduction } from './release-verification-lib.mjs'

const COMMIT = 'a'.repeat(40)
const git = { branch: 'main', commit: COMMIT, isClean: true, remote: 'origin' }
const versions = { node: 'v24', pnpm: '10', wrangler: '4' }
const writeReport = async () => ({ reportFile: '/tmp/report.json', latestFile: '/tmp/latest.json' })

describe('通用发布验证', () => {
  it('quick 在首个失败步骤停止', async () => {
    const calls = []
    const report = await runQuickVerification({
      getGitState: async () => git,
      collectVersions: async () => versions,
      writeReport,
      runCommand: async (_command, _args, options) => {
        calls.push(options.name)
        return { name: options.name, status: options.name === 'lint' ? 'failed' : 'passed', durationMs: 1, command: '', exitCode: 0, summary: '' }
      },
    })
    assert.equal(report.status, 'failed')
    assert.deepEqual(calls, ['dependency-install', 'lint'])
  })

  it('本地归因门禁覆盖 0055-0057 三层数据完整性 migration', async () => {
    const commands = []
    const result = await runLocalAttributionGates({
      runCommand: async (command, args, options) => {
        commands.push([command, ...args].join(' '))
        return { name: options.name, status: 'passed', durationMs: 1, command: '', exitCode: 0, summary: '' }
      },
    })
    assert.equal(result.steps.length, 6)
    assert.match(commands[0], /0055_attribution_tracking_integrity\.test\.mjs/)
    assert.match(commands[1], /0056_attribution_fact_source_integrity\.test\.mjs/)
    assert.match(commands[2], /0057_contact_aggregate_integrity\.test\.mjs/)
  })

  it('生产归因门禁仅接受 Contract 后的健康通用状态', async () => {
    const state = {
      contractMigrationCount: 1,
      trackingIntegrityMigrationCount: 1,
      factSourceIntegrityMigrationCount: 1,
      contactAggregateIntegrityMigrationCount: 1,
      privacyPolicyMigrationCount: 1,
      privacyPolicyRowCount: 1,
      invalidConnectionCount: 0,
      openCriticalIncidentCount: 0,
      expiredOutboxCount: 0,
      deadLetterCount: 0,
      invalidFactSourceCount: 0,
      invalidContactDailyEventCount: 0,
      invalidSourceContactClickCount: 0,
      invalidRolloutCount: 0,
    }
    const passed = await collectTrustedProductionGateFacts({ commit: COMMIT, queryProductionAttributionState: async () => state })
    assert.equal(passed.status, 'passed')
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, openCriticalIncidentCount: 1 }),
    }), /openCriticalIncidentCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, trackingIntegrityMigrationCount: 0 }),
    }), /trackingIntegrityMigrationCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, factSourceIntegrityMigrationCount: 0 }),
    }), /factSourceIntegrityMigrationCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, invalidFactSourceCount: 1 }),
    }), /invalidFactSourceCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, contactAggregateIntegrityMigrationCount: 0 }),
    }), /contactAggregateIntegrityMigrationCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, invalidContactDailyEventCount: 1 }),
    }), /invalidContactDailyEventCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, invalidSourceContactClickCount: 1 }),
    }), /invalidSourceContactClickCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, privacyPolicyMigrationCount: 0 }),
    }), /privacyPolicyMigrationCount/)
    await assert.rejects(collectTrustedProductionGateFacts({
      commit: COMMIT,
      queryProductionAttributionState: async () => ({ ...state, privacyPolicyRowCount: -1 }),
    }), /privacyPolicyRowCount/)
    const preDeploy = await collectTrustedProductionGateFacts({
      commit: COMMIT,
      requireTrackingIntegrityMigration: false,
      requireFactSourceIntegrityMigration: false,
      requireContactAggregateIntegrityMigration: false,
      queryProductionAttributionState: async () => ({
        ...state,
        trackingIntegrityMigrationCount: 0,
        factSourceIntegrityMigrationCount: 0,
        invalidFactSourceCount: 2,
        contactAggregateIntegrityMigrationCount: 0,
        invalidContactDailyEventCount: 42,
        invalidSourceContactClickCount: 4,
      }),
    })
    assert.equal(preDeploy.status, 'passed')
  })

  it('release 串联三个通用子模式并生成可放行报告', async () => {
    const calls = []
    const child = async options => {
      calls.push(options.mode)
      return { status: 'passed', reportFile: `/tmp/${options.mode}.json` }
    }
    const report = await runReleaseVerification({
      getGitState: async () => git,
      collectVersions: async () => versions,
      writeReport,
      runQuickVerification: child,
      runLocalRuntimeReleaseVerification: child,
      runDevRehearsalReleaseVerification: child,
    })
    assert.deepEqual(calls, ['quick', 'local-runtime', 'dev-rehearsal'])
    assert.equal(report.status, 'passed')
    assert.doesNotThrow(() => assertReportCanGateProduction(report, {
      now: report.finishedAt,
      currentBranch: 'main',
      expectedCommit: COMMIT,
    }))
  })

  it('CLI 通用 production 状态检查不依赖 release 报告', async () => {
    let commit = ''
    await main(['assert-production-attribution'], {
      getGitState: async () => git,
      collectTrustedProductionGateFacts: async options => { commit = options.commit },
    })
    assert.equal(commit, COMMIT)
  })

  it('发布 identity 同时核对 API 和 Web commit', async () => {
    const paths = []
    await verifyProductionReleaseIdentity({
      commit: COMMIT,
      fetch: async (url) => {
        paths.push(new URL(url).pathname)
        return new Response(JSON.stringify({ status: 'ok', environment: 'production', commit: COMMIT }), { status: 200 })
      },
    })
    assert.deepEqual(paths.sort(), ['/__release', '/api/health'])
  })

  it('identity 重试达到上限后失败关闭', async () => {
    let attempts = 0
    await assert.rejects(assertProductionReleaseIdentity({
      getGitState: async () => git,
      verifyProductionReleaseIdentity: async () => { attempts += 1; throw new Error('传播中') },
      identityMaxAttempts: 2,
      identityRetryDelayMs: 0,
      sleep: async () => {},
    }), /连续 2 次/)
    assert.equal(attempts, 2)
  })
})
