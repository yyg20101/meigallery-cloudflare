import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertReportCanGateProduction,
  fetchWithTimeout,
  redact,
  redactMachineOutput,
  runCommand,
  writeReport,
} from './release-verification-lib.mjs'

const RELEASE_COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const CONTRACT_DIGEST = `sha256:${'9'.repeat(64)}`

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
      commit: RELEASE_COMMIT,
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
    initialMetaRollout: true,
    datasetQualityContract: {
      status: 'passed',
      path: 'docs/superpowers/specs/2026-07-10-meta-dataset-quality-contract.md',
      version: 1,
      digest: CONTRACT_DIGEST,
    },
    metaLiveVerification: {
      status: 'passed',
      commit: RELEASE_COMMIT,
      environment: 'production',
      verifiedAt: '2026-07-09T00:00:00.000Z',
      expiresAt: '2026-07-10T00:00:00.000Z',
      events: ['Contact', 'CompleteRegistration'],
      enhancedMatchVerified: true,
      forbiddenEventsAbsent: true,
      datasetQualityContractVersion: 1,
      datasetQualityCollectorCurrent: true,
    },
    metaResources: {
      dev: {
        status: 'passed',
        environment: 'production',
        commit: RELEASE_COMMIT,
        capiEnabled: true,
        connectionVerified: true,
        openCriticalIncidentCount: 0,
        datasetQualityContractVersion: 1,
        datasetQualityContractDigest: CONTRACT_DIGEST,
        datasetQualityCollectorCurrent: true,
      },
      production: {
        status: 'passed',
        environment: 'production',
        commit: RELEASE_COMMIT,
        capiEnabled: false,
        connectionVerified: true,
        phase: 'bootstrap',
        r2Present: true,
        secretsPresent: true,
        environmentIsolation: {
          d1: true, r2: true, queue: true, dlq: true,
          pixel: true, token: true, dataKey: true,
        },
        openCriticalIncidentCount: 0,
        targetRolloutPercentage: 0,
        effectiveRolloutPercentage: 0,
        datasetQualityContractVersion: 1,
        datasetQualityCollectorCurrent: true,
      },
    },
    artifacts: ['reports/release-verification/latest.json'],
    notes: ['全部校验通过'],
  }
}

describe('发布验证基础库', () => {
  it('冷启动 release gate 强制 current commit、tracked contract 和 production bootstrap rollout 0 同链', () => {
    const valid = createValidReleaseReport()
    assert.doesNotThrow(() => assertReportCanGateProduction(valid, {
      currentBranch: 'main',
      expectedCommit: RELEASE_COMMIT,
      now: '2026-07-09T12:00:00.000Z',
    }))

    const candidates = [
      { ...valid, git: { ...valid.git, commit: 'short' } },
      { ...valid, datasetQualityContract: { ...valid.datasetQualityContract, status: 'failed' } },
      { ...valid, metaResources: { ...valid.metaResources, production: { ...valid.metaResources.production, openCriticalIncidentCount: 1 } } },
      { ...valid, metaResources: { ...valid.metaResources, production: { ...valid.metaResources.production, targetRolloutPercentage: 10 } } },
      { ...valid, metaResources: { ...valid.metaResources, production: { ...valid.metaResources.production, effectiveRolloutPercentage: 10 } } },
    ]
    for (const report of candidates) assert.throws(() => assertReportCanGateProduction(report, {
      currentBranch: 'main',
      expectedCommit: RELEASE_COMMIT,
      now: '2026-07-09T12:00:00.000Z',
    }))
  })
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

  it('redactMachineOutput 递归脱敏 credential 并保持完整 JSON 可解析', () => {
    const payload = [{
      access_token: 'machine-access-token',
      refreshToken: 'machine-refresh-token',
      clientSecret: 'machine-client-secret',
      databasePassword: 'machine-database-password',
      serviceApiKey: 'machine-api-key',
      signingPrivateKey: 'machine-private-key',
      serviceCredential: 'machine-service-credential',
      credentials: 'machine-credentials',
      authorization: 'Bearer machine-authorization',
      cookieHeader: 'session=machine-cookie',
      token_count: 2,
      session_id: 'machine-session-id',
      sessionId: 'machine-session-id-camel',
      secret_name: 'META_CAPI_ACCESS_TOKEN',
      token_fingerprint: 'machine-token-fingerprint',
      nested: {
        password: 'machine-password',
        revision: 'e'.repeat(32),
      },
    }]

    assert.deepEqual(JSON.parse(redactMachineOutput(JSON.stringify(payload))), [{
      access_token: '[REDACTED]',
      refreshToken: '[REDACTED]',
      clientSecret: '[REDACTED]',
      databasePassword: '[REDACTED]',
      serviceApiKey: '[REDACTED]',
      signingPrivateKey: '[REDACTED]',
      serviceCredential: '[REDACTED]',
      credentials: '[REDACTED]',
      authorization: '[REDACTED]',
      cookieHeader: '[REDACTED]',
      token_count: 2,
      session_id: 'machine-session-id',
      sessionId: 'machine-session-id-camel',
      secret_name: 'META_CAPI_ACCESS_TOKEN',
      token_fingerprint: 'machine-token-fingerprint',
      nested: {
        password: '[REDACTED]',
        revision: 'e'.repeat(32),
      },
    }])
    assert.equal(
      redactMachineOutput('access_token="machine-token" result={"ok":true} values=[1]'),
      'access_token="[REDACTED]" result={"ok":true} values=[1]',
    )
  })

  it('runCommand 保持 credential 脱敏后的机器 JSON 可解析，summary 使用完整隐私脱敏', async () => {
    const sensitiveValues = [
      'machine-access-token',
      'e'.repeat(32),
      '203.0.113.88',
      'f'.repeat(64),
      'opaque-runtime-agent',
      'opaque-browser-id',
      'opaque-click-id',
    ]
    const payload = {
      access_token: sensitiveValues[0],
      revision: sensitiveValues[1],
      localAddress: sensitiveValues[2],
      hash: sensitiveValues[3],
      userAgent: sensitiveValues[4],
      fbp: sensitiveValues[5],
      fbc: sensitiveValues[6],
    }

    const serializedPayload = JSON.stringify(payload)
    const step = await runCommand('node', ['-e', [
      `process.stdout.write(${JSON.stringify(serializedPayload)})`,
      `process.stderr.write(${JSON.stringify(serializedPayload)})`,
    ].join(';')])

    const expectedMachinePayload = { ...payload, access_token: '[REDACTED]' }
    assert.deepEqual(JSON.parse(step.stdout), expectedMachinePayload)
    assert.deepEqual(JSON.parse(step.stderr), expectedMachinePayload)
    for (const value of sensitiveValues) assert.equal(step.summary.includes(value), false)
    assert.match(step.summary, /\[PRIVATE_REDACTED\]/)
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

  it('fetchWithTimeout 会保留调用方 abort signal', async () => {
    const controller = new AbortController()
    let forwardedSignal = null
    const request = fetchWithTimeout(
      (_input, init) => {
        forwardedSignal = init.signal
        return new Promise(() => {})
      },
      'https://example.test/cancel',
      { signal: controller.signal },
      1000,
    )

    controller.abort(new Error('caller cancelled'))

    await assert.rejects(request, /caller cancelled/)
    assert.equal(forwardedSignal?.aborted, true)
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

  it('writeReport 在写盘前递归脱敏 report summary 中的匹配数据', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'release-verify-private-'))
    const sensitiveValues = [
      'nested-person@example.test',
      '198.51.100.27',
      '2001:db8::27',
      'NestedFixtureAgent/3.2',
      'Agent/1.0',
      'Browser/2.0',
      'Client/3.0',
      'fb.1.1700000000000.NestedBrowserId',
      'c'.repeat(32),
      'd'.repeat(64),
    ]
    const report = {
      schemaVersion: 1,
      mode: 'quick',
      status: 'passed',
      startedAt: '2026-07-11T00:00:00.000Z',
      finishedAt: '2026-07-11T00:01:00.000Z',
      durationMs: 60_000,
      git: {
        branch: 'dev',
        commit: 'abcdef1234567890',
        isClean: true,
        remote: 'ssh://git@github.com/example/repository.git',
      },
      versions: { node: 'v24.0.0', pnpm: '10.0.0', wrangler: '4.0.0' },
      steps: [{
        name: 'privacy-fixture',
        status: 'passed',
        durationMs: 1,
        command: 'node privacy-fixture',
        summary: `普通摘要 ${sensitiveValues.join(' ')}`,
      }],
      artifacts: [],
      notes: [{ nestedSummary: `完成 ${sensitiveValues.join(' ')}` }],
    }

    try {
      const { reportFile, latestFile } = await writeReport(report, { reportDir })
      const contents = await Promise.all([readFile(reportFile, 'utf8'), readFile(latestFile, 'utf8')])

      for (const content of contents) {
        for (const value of sensitiveValues) assert.equal(content.includes(value), false)
        assert.match(content, /普通摘要/)
        assert.equal(JSON.parse(content).git.remote, 'ssh://git@github.com/example/repository.git')
      }
      assert.equal(report.steps[0].summary.includes(sensitiveValues[0]), true)
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })

  it('writeReport 递归脱敏对象 key，并在脱敏冲突时保留全部字段', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'release-verify-private-keys-'))
    const sensitiveKeys = [
      'key-person@example.test',
      'key-198.51.100.27:443',
      'key-[2001:db8::27]:443',
      'key-Agent/1.0',
      'key-fb.1.1700000000000.KeyBrowserId',
      `key-${'c'.repeat(32)}`,
      `key-${'d'.repeat(64)}`,
    ]
    const keyedValues = Object.fromEntries(sensitiveKeys.map((key, index) => [key, `value-${index}`]))
    const report = {
      schemaVersion: 1,
      mode: 'quick',
      status: 'passed',
      startedAt: '2026-07-11T00:00:00.000Z',
      finishedAt: '2026-07-11T00:01:00.000Z',
      durationMs: 60_000,
      git: { branch: 'dev', commit: 'abcdef1234567890', isClean: true, remote: 'origin' },
      versions: { node: 'v24.0.0', pnpm: '10.0.0', wrangler: '4.0.0' },
      steps: [],
      artifacts: [],
      notes: [],
      evidence: {
        digest: CONTRACT_DIGEST,
        datasetQualityContractDigest: CONTRACT_DIGEST,
        private_redacted_1: '合法字段不得被覆盖',
        ...keyedValues,
        nested: { ...keyedValues },
        has_fbp: true,
        userAgent: false,
        contextual: {
          client_user_agent: { value: 'custom-runtime' },
          userAgent: ['opaque-runtime-agent'],
          fbp: { value: 'opaque-browser-value' },
          fbc: 42,
          browser: { fbp: false },
        },
      },
    }

    try {
      const { reportFile, latestFile } = await writeReport(report, { reportDir })
      const contents = await Promise.all([readFile(reportFile, 'utf8'), readFile(latestFile, 'utf8')])

      for (const content of contents) {
        for (const key of sensitiveKeys) assert.equal(content.includes(key), false)
        const parsed = JSON.parse(content)
        assert.equal(parsed.evidence.digest, CONTRACT_DIGEST)
        assert.equal(parsed.evidence.datasetQualityContractDigest, CONTRACT_DIGEST)
        assert.equal(parsed.evidence.private_redacted_1, '合法字段不得被覆盖')
        assert.deepEqual(Object.values(parsed.evidence).filter(value => /^value-\d$/.test(value)).sort(), Object.values(keyedValues).sort())
        assert.deepEqual(Object.values(parsed.evidence.nested).sort(), Object.values(keyedValues).sort())
        assert.equal(parsed.evidence.has_fbp, true)
        assert.equal(parsed.evidence.userAgent, '[PRIVATE_REDACTED]')
        assert.deepEqual(parsed.evidence.contextual, {
          client_user_agent: '[PRIVATE_REDACTED]',
          userAgent: '[PRIVATE_REDACTED]',
          fbp: '[PRIVATE_REDACTED]',
          fbc: '[PRIVATE_REDACTED]',
          browser: { fbp: '[PRIVATE_REDACTED]' },
        })
      }
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

  it('assertReportCanGateProduction 拒绝从 dev 生成后切到 main 的同 SHA 报告', () => {
    const report = createValidReleaseReport()
    assert.throws(() => {
      assertReportCanGateProduction({
        ...report,
        git: { ...report.git, branch: 'dev' },
      }, {
        now: '2026-07-09T01:00:00.000Z',
        currentBranch: 'main',
        expectedCommit: report.git.commit,
      })
    }, /报告生成分支不是 main 或 release/)
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

  it('assertReportCanGateProduction 强制完整 production live evidence 与当前 commit 资源摘要', () => {
    const base = createValidReleaseReport()

    for (const report of [
      { ...base, metaLiveVerification: { ...base.metaLiveVerification, commit: 'invalid-commit' } },
      { ...base, metaLiveVerification: { ...base.metaLiveVerification, status: 'failed' } },
      { ...base, metaLiveVerification: { ...base.metaLiveVerification, events: ['Contact', 'Lead', 'CompleteRegistration'] } },
      { ...base, metaLiveVerification: { ...base.metaLiveVerification, events: ['Contact', 'CompleteRegistration', 'StartTrial'] } },
      { ...base, metaResources: { ...base.metaResources, production: { ...base.metaResources.production, status: 'failed' } } },
    ]) {
      assert.throws(() => {
        assertReportCanGateProduction(report, {
          now: '2026-07-09T01:00:00.000Z',
          expectedCommit: base.git.commit,
        })
      }, /Meta|meta|资源|evidence|commit/)
    }
  })

  it('assertReportCanGateProduction 允许复用未过期且连接身份未变的历史 Meta evidence', () => {
    const base = createValidReleaseReport()
    assert.doesNotThrow(() => {
      assertReportCanGateProduction({
        ...base,
        metaLiveVerification: {
          ...base.metaLiveVerification,
          commit: 'a'.repeat(40),
        },
      }, {
        now: '2026-07-09T01:00:00.000Z',
        expectedCommit: base.git.commit,
      })
    })
  })

  it('assertReportCanGateProduction 在首次上线时强制生产 CAPI 关闭', () => {
    const base = createValidReleaseReport()
    assert.throws(() => {
      assertReportCanGateProduction({
        ...base,
        initialMetaRollout: true,
        metaResources: {
          ...base.metaResources,
          production: { ...base.metaResources.production, capiEnabled: true },
        },
      }, {
        now: '2026-07-09T01:00:00.000Z',
      })
    }, /首次上线|CAPI/)
  })

  it('assertReportCanGateProduction 拒绝过期 live evidence 或不同 commit 的资源摘要', () => {
    const base = createValidReleaseReport()
    assert.throws(() => {
      assertReportCanGateProduction({
        ...base,
        metaLiveVerification: {
          ...base.metaLiveVerification,
          expiresAt: '2026-07-09T00:30:00.000Z',
        },
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /live evidence 已过期/)

    assert.throws(() => {
      assertReportCanGateProduction({
        ...base,
        metaResources: {
          ...base.metaResources,
          production: { ...base.metaResources.production, commit: 'other-commit' },
        },
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /资源检查 commit/)
  })
})
