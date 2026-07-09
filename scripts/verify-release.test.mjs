import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  assertProductionAllowed,
  runDevRehearsalReleaseVerification,
  runLocalRuntimeReleaseVerification,
  runReleaseVerification,
} from './verify-release.mjs'
import { writeReport } from './release-verification-lib.mjs'

const DEPLOY_SCRIPT_PATH = fileURLToPath(new URL('./deploy.sh', import.meta.url))

describe('发布验证 CLI', () => {
  it('production deploy gate 会显式清空 VERIFY_RELEASE_ALLOW_BRANCH', async () => {
    const deployScript = await readFile(DEPLOY_SCRIPT_PATH, 'utf8')

    assert.match(
      deployScript,
      /env -u VERIFY_RELEASE_ALLOW_BRANCH node scripts\/verify-release\.mjs assert-production-allowed/,
    )
  })

  it('assertProductionAllowed 会绑定当前 Git commit', async () => {
    await assert.rejects(async () => {
      await assertProductionAllowed({
        getGitState: async () => ({
          branch: 'main',
          commit: 'current-commit-sha',
          isClean: true,
          remote: 'origin',
        }),
        readLatestReport: async () => ({
          schemaVersion: 1,
          mode: 'release',
          status: 'passed',
          startedAt: '2026-07-09T00:00:00.000Z',
          finishedAt: '2026-07-09T00:05:00.000Z',
          durationMs: 300000,
          git: {
            branch: 'main',
            commit: 'old-commit-sha',
            isClean: true,
            remote: 'origin',
          },
          versions: {
            node: 'v24.0.0',
            pnpm: '10.0.0',
            wrangler: '4.0.0',
          },
          steps: [],
          artifacts: [],
          notes: [],
        }),
      })
    }, /报告 commit 与当前待发布 commit 不一致/)
  })

  it('assertProductionAllowed 在当前 Git commit 为空时保守失败', async () => {
    await assert.rejects(async () => {
      await assertProductionAllowed({
        getGitState: async () => ({
          branch: 'main',
          commit: '   ',
          isClean: false,
          remote: 'origin',
        }),
      })
    }, /无法获取当前 Git commit/)
  })

  it('assertProductionAllowed 在当前 Git branch 为空时保守失败', async () => {
    await assert.rejects(async () => {
      await assertProductionAllowed({
        getGitState: async () => ({
          branch: '   ',
          commit: 'current-commit-sha',
          isClean: true,
          remote: 'origin',
        }),
      })
    }, /无法获取当前 Git branch/)
  })

  it('assertProductionAllowed 在当前工作区不干净时保守失败', async () => {
    await assert.rejects(async () => {
      await assertProductionAllowed({
        getGitState: async () => ({
          branch: 'main',
          commit: 'current-commit-sha',
          isClean: false,
          remote: 'origin',
        }),
        readLatestReport: async () => ({
          schemaVersion: 1,
          mode: 'release',
          status: 'passed',
          startedAt: '2026-07-09T00:00:00.000Z',
          finishedAt: '2026-07-09T00:05:00.000Z',
          durationMs: 300000,
          git: {
            branch: 'main',
            commit: 'current-commit-sha',
            isClean: true,
            remote: 'origin',
          },
          versions: {
            node: 'v24.0.0',
            pnpm: '10.0.0',
            wrangler: '4.0.0',
          },
          steps: [],
          artifacts: [],
          notes: [],
        }),
      })
    }, /当前工作区不是干净状态/)
  })

  it('runLocalRuntimeReleaseVerification 会生成 local-runtime 报告', async () => {
    const report = await runLocalRuntimeReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'dev',
        commit: 'local-runtime-commit',
        isClean: true,
        remote: 'origin',
      }),
      runLocalRuntimeVerification: async () => ({
        steps: [
          { name: 'local-d1-migrate', status: 'passed', durationMs: 1, command: 'migrate', exitCode: 0, summary: 'ok' },
          { name: 'local-admin-attribution', status: 'passed', durationMs: 1, command: 'attribution', exitCode: 200, summary: 'ok' },
        ],
        notes: ['meta-capi-disabled-in-local'],
        artifacts: ['/.wrangler-release-verify/local-runtime'],
      }),
      writeReport: async (payload) => ({
        reportFile: '/tmp/local-runtime.json',
        latestFile: '/tmp/latest.json',
        payload,
      }),
    })

    assert.equal(report.mode, 'local-runtime')
    assert.equal(report.status, 'passed')
    assert.equal(report.reportFile, '/tmp/local-runtime.json')
  })

  it('runDevRehearsalReleaseVerification 会生成 dev-rehearsal 报告', async () => {
    const report = await runDevRehearsalReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'dev',
        commit: 'dev-rehearsal-commit',
        isClean: true,
        remote: 'origin',
      }),
      runDevRehearsalVerification: async () => ({
        steps: [
          { name: 'dev-d1-migrate', status: 'passed', durationMs: 1, command: 'migrate', exitCode: 0, summary: 'ok' },
          { name: 'dev-admin-attribution', status: 'passed', durationMs: 1, command: 'attribution', exitCode: 200, summary: 'ok' },
        ],
        notes: ['meta-test-event-code-missing'],
        artifacts: [],
      }),
      writeReport: async () => ({
        reportFile: '/tmp/dev-rehearsal.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.equal(report.mode, 'dev-rehearsal')
    assert.equal(report.status, 'passed')
    assert.equal(report.reportFile, '/tmp/dev-rehearsal.json')
  })

  it('runReleaseVerification 会按顺序编排 quick、local-runtime、dev-rehearsal 并生成 release 报告', async () => {
    const order = []
    const report = await runReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'dev',
        commit: 'release-commit',
        isClean: true,
        remote: 'origin',
      }),
      runQuickVerification: async () => {
        order.push('quick')
        return {
          mode: 'quick',
          status: 'passed',
          durationMs: 10,
          reportFile: '/tmp/quick.json',
          steps: [{ name: 'scripts-test', status: 'passed' }],
          notes: [],
        }
      },
      runLocalRuntimeReleaseVerification: async () => {
        order.push('local-runtime')
        return {
          mode: 'local-runtime',
          status: 'passed',
          durationMs: 20,
          reportFile: '/tmp/local-runtime.json',
          steps: [{ name: 'local-d1-migrate', status: 'passed' }],
          notes: [],
        }
      },
      runDevRehearsalReleaseVerification: async () => {
        order.push('dev-rehearsal')
        return {
          mode: 'dev-rehearsal',
          status: 'passed',
          durationMs: 30,
          reportFile: '/tmp/dev-rehearsal.json',
          steps: [{ name: 'dev-admin-attribution', status: 'passed' }],
          notes: [],
        }
      },
      writeReport: async () => ({
        reportFile: '/tmp/release.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.deepEqual(order, ['quick', 'local-runtime', 'dev-rehearsal'])
    assert.equal(report.mode, 'release')
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.artifacts, ['/tmp/quick.json', '/tmp/local-runtime.json', '/tmp/dev-rehearsal.json'])
    assert.deepEqual(report.steps.map(step => step.name), ['quick', 'local-runtime', 'dev-rehearsal'])
    assert.match(report.steps[0].summary, /scripts-test/)
  })

  it('runReleaseVerification 在子模式失败时停止后续编排，但仍写出 failed release 报告', async () => {
    const order = []
    const report = await runReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'dev',
        commit: 'release-commit',
        isClean: true,
        remote: 'origin',
      }),
      runQuickVerification: async () => {
        order.push('quick')
        return {
          mode: 'quick',
          status: 'failed',
          durationMs: 10,
          reportFile: '/tmp/quick.json',
          steps: [{ name: 'scripts-test', status: 'failed' }],
          notes: ['scripts-test failed'],
        }
      },
      runLocalRuntimeReleaseVerification: async () => {
        order.push('local-runtime')
        return {
          mode: 'local-runtime',
          status: 'passed',
          durationMs: 20,
          reportFile: '/tmp/local-runtime.json',
          steps: [],
          notes: [],
        }
      },
      runDevRehearsalReleaseVerification: async () => {
        order.push('dev-rehearsal')
        return {
          mode: 'dev-rehearsal',
          status: 'passed',
          durationMs: 30,
          reportFile: '/tmp/dev-rehearsal.json',
          steps: [],
          notes: [],
        }
      },
      writeReport: async () => ({
        reportFile: '/tmp/release.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.deepEqual(order, ['quick'])
    assert.equal(report.mode, 'release')
    assert.equal(report.status, 'failed')
    assert.equal(report.steps.length, 1)
    assert.match(report.notes.join('；'), /release 编排在 quick 阶段停止/)
  })

  it('runLocalRuntimeReleaseVerification 会拒绝把 session token 或 token_hash 写入报告', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'verify-local-runtime-'))

    try {
      const report = await runLocalRuntimeReleaseVerification({
        reportDir,
        collectVersions: async () => ({
          node: 'v24.0.0',
          pnpm: '10.0.0',
          wrangler: '4.0.0',
        }),
        getGitState: async () => ({
          branch: 'dev',
          commit: 'local-runtime-commit',
          isClean: true,
          remote: 'origin',
        }),
        runLocalRuntimeVerification: async () => ({
          steps: [
            { name: 'local-session-seed', status: 'passed', durationMs: 1, command: 'safe command', exitCode: 0, summary: 'ok' },
          ],
          notes: [],
          artifacts: [],
          sensitiveValues: ['plain-session-token', 'plain-token-hash'],
        }),
        writeReport,
      })

      const latestContent = await readFile(report.latestFile, 'utf8')
      assert.equal(latestContent.includes('plain-session-token'), false)
      assert.equal(latestContent.includes('plain-token-hash'), false)
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })
})
