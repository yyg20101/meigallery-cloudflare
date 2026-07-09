import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertReportCanGateProduction,
  fetchWithTimeout,
  redact,
  runCommand,
  writeReport,
} from './release-verification-lib.mjs'

function createValidReleaseReport() {
  return {
    schemaVersion: 1,
    mode: 'release',
    status: 'passed',
    startedAt: '2026-07-09T00:00:00.000Z',
    finishedAt: '2026-07-09T00:05:00.000Z',
    durationMs: 300000,
    git: {
      branch: 'main',
      commit: 'abcdef1234567890',
      isClean: true,
      remote: 'origin',
    },
    versions: {
      node: 'v24.0.0',
      pnpm: '10.0.0',
      wrangler: '4.0.0',
    },
    steps: [
      {
        name: 'quick',
        status: 'passed',
        durationMs: 1200,
        command: 'node scripts/verify-release.mjs quick',
        summary: '通过步骤：scripts-test、web-build',
        passedStepNames: ['scripts-test', 'web-build'],
      },
      {
        name: 'local-runtime',
        status: 'passed',
        durationMs: 800,
        command: 'node scripts/verify-release.mjs local-runtime',
        summary: '通过步骤：local-d1-migrate、local-admin-attribution',
        passedStepNames: ['local-d1-migrate', 'local-admin-attribution'],
      },
      {
        name: 'dev-rehearsal',
        status: 'passed',
        durationMs: 900,
        command: 'node scripts/verify-release.mjs dev-rehearsal',
        summary: '通过步骤：dev-d1-migrate、dev-admin-attribution',
        passedStepNames: ['dev-d1-migrate', 'dev-admin-attribution'],
      },
    ],
    releaseSubModes: [
      {
        mode: 'quick',
        status: 'passed',
        passedStepNames: ['scripts-test', 'web-build'],
        reportFile: '/tmp/quick.json',
      },
      {
        mode: 'local-runtime',
        status: 'passed',
        passedStepNames: ['local-d1-migrate', 'local-admin-attribution'],
        reportFile: '/tmp/local-runtime.json',
      },
      {
        mode: 'dev-rehearsal',
        status: 'passed',
        passedStepNames: ['dev-d1-migrate', 'dev-admin-attribution'],
        reportFile: '/tmp/dev-rehearsal.json',
      },
    ],
    artifacts: ['reports/release-verification/latest.json'],
    notes: ['全部校验通过'],
  }
}

describe('发布验证基础库', () => {
  it('redact 会隐藏 token、secret、cookie 和 session', () => {
    const input = 'access_token=abc token:123 secret=xyz cookie=foo session=bar password=baz'
    const output = redact(input)

    assert.match(output, /access_token=\[REDACTED\]/i)
    assert.match(output, /token:\[REDACTED\]/i)
    assert.match(output, /secret=\[REDACTED\]/i)
    assert.match(output, /cookie=\[REDACTED\]/i)
    assert.match(output, /session=\[REDACTED\]/i)
    assert.match(output, /password=\[REDACTED\]/i)
  })

  it('redact 会隐藏带凭证的 Git remote URL', () => {
    const input = 'https://user:ghp_secret-token@github.com/yyg20101/meigallery-cloudflare.git https://ghp_directtoken@github.com/yyg20101/meigallery-cloudflare.git'
    const output = redact(input)

    assert.equal(output.includes('ghp_secret-token'), false)
    assert.equal(output.includes('ghp_directtoken'), false)
    assert.match(output, /https:\/\/\[REDACTED]@github\.com\/yyg20101\/meigallery-cloudflare\.git/)
  })

  it('runCommand 支持使用安全的 reportCommand 覆盖报告命令', async () => {
    const step = await runCommand('node', ['-e', 'console.log("ok")'], {
      reportCommand: 'node -e "[REDACTED]"',
    })

    assert.equal(step.command, 'node -e "[REDACTED]"')
    assert.equal(step.status, 'passed')
  })

  it('fetchWithTimeout 会中止长期无响应的请求', async () => {
    await assert.rejects(async () => {
      await fetchWithTimeout(
        () => new Promise(() => {}),
        'https://example.test/never',
        {},
        5,
      )
    }, /请求超时：5ms/)
  })

  it('writeReport 同时写入时间戳文件和 latest.json', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'release-verify-'))
    const report = {
      schemaVersion: 1,
      mode: 'quick',
      status: 'passed',
      startedAt: '2026-07-09T00:00:00.000Z',
      finishedAt: '2026-07-09T00:05:00.000Z',
      durationMs: 300000,
      git: {
        branch: 'dev',
        commit: 'abcdef1234567890',
        isClean: true,
        remote: 'git@github.com:yyg20101/meigallery-cloudflare.git',
      },
      versions: {
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      },
      steps: [],
      artifacts: [],
      notes: [],
    }

    try {
      const { reportFile, latestFile } = await writeReport(report, { reportDir })
      const [timestampContent, latestContent] = await Promise.all([
        readFile(reportFile, 'utf8'),
        readFile(latestFile, 'utf8'),
      ])

      assert.deepEqual(JSON.parse(timestampContent), report)
      assert.deepEqual(JSON.parse(latestContent), report)
      assert.notEqual(path.basename(reportFile), 'latest.json')
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })

  it('assertReportCanGateProduction 拒绝失败报告、非 release 报告、脏工作区和过期报告', () => {
    const baseReport = createValidReleaseReport()

    assert.throws(() => {
      assertReportCanGateProduction({
        ...baseReport,
        status: 'failed',
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /报告状态不是 passed/)

    assert.throws(() => {
      assertReportCanGateProduction({
        ...baseReport,
        mode: 'quick',
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /只接受 release 模式/)

    assert.throws(() => {
      assertReportCanGateProduction({
        ...baseReport,
        git: {
          ...baseReport.git,
          isClean: false,
        },
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /不是干净状态/)

    assert.throws(() => {
      assertReportCanGateProduction(baseReport, {
        now: '2026-07-10T00:06:00.000Z',
        maxAgeMs: 60 * 60 * 1000,
      })
    }, /报告已过期/)
  })

  it('assertReportCanGateProduction 按 startedAt 而不是 finishedAt 校验报告时效', () => {
    assert.throws(() => {
      assertReportCanGateProduction({
        ...createValidReleaseReport(),
        startedAt: '2026-07-08T23:59:00.000Z',
        finishedAt: '2026-07-10T00:05:00.000Z',
      }, {
        now: '2026-07-10T00:06:00.000Z',
      })
    }, /报告已过期/)
  })

  it('assertReportCanGateProduction 拒绝畸形 release 报告', () => {
    const malformedReport = {
      schemaVersion: 2,
      mode: 'release',
      status: 'passed',
      startedAt: 123,
      finishedAt: null,
      durationMs: '300000',
      git: {
        branch: ['main'],
        commit: 123,
        isClean: 'true',
      },
      versions: [],
      steps: {},
      artifacts: 'none',
      notes: {},
    }

    assert.throws(() => {
      assertReportCanGateProduction(malformedReport, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /schemaVersion|startedAt|finishedAt|durationMs|git\.commit|git\.branch|git\.isClean|versions|steps|artifacts|notes/)
  })

  it('assertReportCanGateProduction 拒绝空 branch 或 commit 的 release 报告', () => {
    const invalidGitReport = {
      ...createValidReleaseReport(),
      git: {
        branch: '',
        commit: '   ',
        isClean: true,
        remote: 'origin',
      },
    }

    assert.throws(() => {
      assertReportCanGateProduction(invalidGitReport, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /git\.commit 缺失、为空或类型非法|git\.branch 缺失、为空或类型非法/)
  })

  it('assertReportCanGateProduction 拒绝与 expectedCommit 不一致的 release 报告', () => {
    const report = {
      ...createValidReleaseReport(),
      git: {
        ...createValidReleaseReport().git,
        commit: 'report-commit-sha',
      },
    }

    assert.throws(() => {
      assertReportCanGateProduction(report, {
        now: '2026-07-09T01:00:00.000Z',
        expectedCommit: 'current-commit-sha',
      })
    }, /报告 commit 与当前待发布 commit 不一致/)
  })

  it('assertReportCanGateProduction 拒绝分支不在 main 或 release/* 的生产放行', () => {
    assert.throws(() => {
      assertReportCanGateProduction(createValidReleaseReport(), {
        now: '2026-07-09T01:00:00.000Z',
        currentBranch: 'dev',
      })
    }, /当前分支不是 main 或 release/)
  })

  it('assertReportCanGateProduction 允许通过 VERIFY_RELEASE_ALLOW_BRANCH 绕过测试分支限制', () => {
    assert.doesNotThrow(() => {
      assertReportCanGateProduction(createValidReleaseReport(), {
        now: '2026-07-09T01:00:00.000Z',
        currentBranch: 'dev',
        env: {
          VERIFY_RELEASE_ALLOW_BRANCH: 'dev',
        },
      })
    })
  })

  it('assertReportCanGateProduction 拒绝缺少 release 子模式摘要的报告', () => {
    const report = {
      ...createValidReleaseReport(),
      steps: [
        {
          name: 'quick',
          status: 'passed',
          durationMs: 1,
          command: 'node scripts/verify-release.mjs quick',
          summary: '通过步骤：scripts-test',
          passedStepNames: ['scripts-test'],
        },
      ],
      releaseSubModes: [
        {
          mode: 'quick',
          status: 'passed',
          passedStepNames: ['scripts-test'],
          reportFile: '/tmp/quick.json',
        },
      ],
    }

    assert.throws(() => {
      assertReportCanGateProduction(report, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /缺少 local-runtime 子模式摘要|缺少 dev-rehearsal 子模式摘要/)
  })

  it('assertReportCanGateProduction 拒绝 release 子模式未通过的报告', () => {
    const report = {
      ...createValidReleaseReport(),
      steps: [
        {
          name: 'quick',
          status: 'passed',
          durationMs: 1,
          command: 'node scripts/verify-release.mjs quick',
          summary: '通过步骤：scripts-test',
          passedStepNames: ['scripts-test'],
        },
        {
          name: 'local-runtime',
          status: 'failed',
          durationMs: 1,
          command: 'node scripts/verify-release.mjs local-runtime',
          summary: '失败',
          passedStepNames: [],
        },
        {
          name: 'dev-rehearsal',
          status: 'passed',
          durationMs: 1,
          command: 'node scripts/verify-release.mjs dev-rehearsal',
          summary: '通过步骤：dev-admin-attribution',
          passedStepNames: ['dev-admin-attribution'],
        },
      ],
      releaseSubModes: [
        {
          mode: 'quick',
          status: 'passed',
          passedStepNames: ['scripts-test'],
          reportFile: '/tmp/quick.json',
        },
        {
          mode: 'local-runtime',
          status: 'failed',
          passedStepNames: [],
          reportFile: '/tmp/local-runtime.json',
        },
        {
          mode: 'dev-rehearsal',
          status: 'passed',
          passedStepNames: ['dev-admin-attribution'],
          reportFile: '/tmp/dev-rehearsal.json',
        },
      ],
    }

    assert.throws(() => {
      assertReportCanGateProduction(report, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /local-runtime 子模式未通过/)
  })

  it('assertReportCanGateProduction 拒绝没有真实 passed step 的 release 子模式摘要', () => {
    const report = {
      ...createValidReleaseReport(),
      steps: createValidReleaseReport().steps.map(step => step.name === 'local-runtime'
        ? {
            ...step,
            summary: '未生成通过步骤摘要；报告：/tmp/local-runtime.json',
            passedStepNames: [],
          }
        : step),
      releaseSubModes: createValidReleaseReport().releaseSubModes.map(item => item.mode === 'local-runtime'
        ? {
            ...item,
            passedStepNames: [],
          }
        : item),
    }

    assert.throws(() => {
      assertReportCanGateProduction(report, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /占位摘要|缺少真实 passed step 摘要|缺少 passedStepNames/)
  })

  it('assertReportCanGateProduction 拒绝缺少 versions 子字段的 release 报告', () => {
    const report = {
      ...createValidReleaseReport(),
      versions: {
        node: 'v24.0.0',
        pnpm: '',
      },
    }

    assert.throws(() => {
      assertReportCanGateProduction(report, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /versions\.pnpm|versions\.wrangler/)
  })

  it('assertReportCanGateProduction 拒绝 step 字段不完整的 release 报告', () => {
    const report = {
      ...createValidReleaseReport(),
      steps: [
        {
          name: '',
          status: 'done',
          durationMs: -1,
          command: 123,
          summary: {},
        },
      ],
    }

    assert.throws(() => {
      assertReportCanGateProduction(report, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /steps\[0\]\.name|steps\[0\]\.status|steps\[0\]\.durationMs|steps\[0\]\.command|steps\[0\]\.summary/)
  })

  it('assertReportCanGateProduction 拒绝 notes 非字符串或 artifact 非字符串的 release 报告', () => {
    const invalidNotesReport = {
      ...createValidReleaseReport(),
      notes: ['ok', 123],
    }
    const invalidArtifactsReport = {
      ...createValidReleaseReport(),
      artifacts: ['ok', { path: 'report.json' }],
    }

    assert.throws(() => {
      assertReportCanGateProduction(invalidNotesReport, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /notes\[1\]/)

    assert.throws(() => {
      assertReportCanGateProduction(invalidArtifactsReport, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /artifacts\[1\]/)
  })
})
