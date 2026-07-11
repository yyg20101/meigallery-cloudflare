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
  runQuickVerification,
  runReleaseVerification,
} from './verify-release.mjs'
import { writeReport } from './release-verification-lib.mjs'

const DEPLOY_SCRIPT_PATH = fileURLToPath(new URL('./deploy.sh', import.meta.url))
const VITEST_CONFIG_PATH = fileURLToPath(new URL('../packages/api/vitest.config.ts', import.meta.url))
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
const API_PACKAGE_JSON_PATH = fileURLToPath(new URL('../packages/api/package.json', import.meta.url))
const RELEASE_COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

describe('发布验证 CLI', () => {
  it('production deploy gate 会显式清空 VERIFY_RELEASE_ALLOW_BRANCH', async () => {
    const deployScript = await readFile(DEPLOY_SCRIPT_PATH, 'utf8')

    assert.match(
      deployScript,
      /env -u VERIFY_RELEASE_ALLOW_BRANCH node scripts\/verify-release\.mjs assert-production-allowed/,
    )
  })

  it('dev 部署迁移目标必须使用独立 dev D1', async () => {
    const deployScript = await readFile(DEPLOY_SCRIPT_PATH, 'utf8')
    const devBlock = deployScript.match(/if \[ "\$IS_PRODUCTION" = "false" \]; then([\s\S]*?)else/)

    assert.ok(devBlock, '未找到 dev 部署分支')
    assert.match(devBlock[1], /D1_DB="meigallery-db-dev"/)
    assert.doesNotMatch(devBlock[1], /D1_DB="meigallery-db"\s*(?:\n|$)/)
  })

  it('deploy 将当前 commit 传给 API Worker，且生产 gate/preflight 均早于 D1 migration', async () => {
    const deployScript = await readFile(DEPLOY_SCRIPT_PATH, 'utf8')
    assert.match(deployScript, /GIT_COMMIT="\$\(git rev-parse HEAD\)"/)
    const deployLines = deployScript.split('\n').filter(line => /wrangler deploy "\$\{ENV_ARGS\[@\]\}" --var/.test(line))
    assert.equal(deployLines.length, 2)
    assert.equal(deployLines.some(line => line.includes('--filter @meigallery/api')), true)
    assert.equal(deployLines.some(line => line.includes('--filter @meigallery/web')), true)
    assert.equal(deployLines.every(line => line.includes('--var "RELEASE_COMMIT:${GIT_COMMIT}"')), true)
    assert.match(deployScript, /ENV_ARGS=\(--env dev\)/)
    assert.match(deployScript, /ENV_ARGS=\(--env ""\)/)

    const gateIndex = deployScript.indexOf('verify-release.mjs assert-production-allowed')
    const preflightIndex = deployScript.indexOf('verify-meta-migration.mjs preflight --env "$ENV"')
    const migrationIndex = deployScript.indexOf('wrangler d1 migrations apply')
    const deployIndex = deployScript.indexOf('wrangler deploy "${ENV_ARGS[@]}" --var')
    assert.ok(gateIndex >= 0)
    assert.ok(preflightIndex > gateIndex)
    assert.ok(migrationIndex > preflightIndex)
    assert.ok(deployIndex > gateIndex)
  })

  it('所有部署路径都不写 site setting、rollout 或 incident', async () => {
    const [deployScript, rootPackage, apiPackage] = await Promise.all([
      readFile(DEPLOY_SCRIPT_PATH, 'utf8'),
      readFile(PACKAGE_JSON_PATH, 'utf8'),
      readFile(API_PACKAGE_JSON_PATH, 'utf8'),
    ])
    const deploymentPaths = [deployScript, rootPackage, apiPackage].join('\n')
    assert.doesNotMatch(deployScript, /(?:INSERT|UPDATE|DELETE)[^\n]*(?:site_settings|meta_capi_incidents)/i)
    assert.doesNotMatch(deployScript, /d1 execute[^\n]*(?:meta_capi_rollout_percentage|meta_capi_incidents)/i)
    assert.doesNotMatch(deploymentPaths, /wrangler d1 execute[^\n]*(?:meta_capi_rollout_percentage|meta_capi_incidents)/i)
  })

  it('API remote migration package script 在 production apply 前执行只读 preflight', async () => {
    const packageJson = JSON.parse(await readFile(API_PACKAGE_JSON_PATH, 'utf8'))
    const command = packageJson.scripts['db:migrate:remote']

    const preflightIndex = command.indexOf('verify-meta-migration.mjs preflight --env production')
    const migrationIndex = command.indexOf('wrangler d1 migrations apply meigallery-db --env="" --remote')
    assert.ok(preflightIndex >= 0)
    assert.ok(migrationIndex > preflightIndex)
    assert.match(command.slice(preflightIndex, migrationIndex), /&&/)
  })

  it('API coverage 显式包含八个 Meta 文件和独立阈值', async () => {
    const config = await readFile(VITEST_CONFIG_PATH, 'utf8')
    for (const file of [
      'src/utils/conversions.ts',
      'src/utils/pixel-receipt.ts',
      'src/utils/meta-browser-identifiers.ts',
      'src/services/conversions.ts',
      'src/services/meta-capi.ts',
      'src/services/meta-capi-queue.ts',
      'src/routes/conversions.ts',
      'src/routes/admin/attribution.ts',
    ]) assert.match(config, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(config, /META_COVERAGE_GLOB/)
    assert.match(config, /statements:\s*85/)
    assert.match(config, /branches:\s*80/)
    assert.match(config, /functions:\s*85/)
    assert.match(config, /lines:\s*85/)
  })

  it('quick 报告包含 api-coverage 步骤', async () => {
    const names = []
    const report = await runQuickVerification({
      collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
      getGitState: async () => ({ branch: 'dev', commit: RELEASE_COMMIT, isClean: true, remote: 'origin' }),
      runCommand: async (_command, _args, options) => {
        names.push(options.name)
        return { name: options.name, status: 'passed', durationMs: 1, command: 'safe', exitCode: 0, summary: 'ok' }
      },
      writeReport: async () => ({ reportFile: '/tmp/quick.json', latestFile: '/tmp/latest.json' }),
    })

    assert.equal(report.status, 'passed')
    assert.equal(names.includes('api-coverage'), true)
    assert.equal(names[0], 'dependency-install')
    assert.equal(names[1], 'lint')
    assert.equal(names.includes('meta-secret-leaks'), true)
    assert.equal(report.steps.some(step => step.name === 'api-coverage'), true)
    assert.equal(report.steps.some(step => step.name === 'meta-secret-leaks'), true)
  })

  it('根脚本提供 Meta secret scanner 交互命令', async () => {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))

    assert.equal(packageJson.scripts['verify:meta-secrets'], 'node scripts/verify-meta-secret-leaks.mjs')
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

  it('assertProductionAllowed 最终部署只接受 main', async () => {
    await assert.rejects(async () => {
      await assertProductionAllowed({
        getGitState: async () => ({
          branch: 'release/v1.0.0',
          commit: RELEASE_COMMIT,
          isClean: true,
          remote: 'origin',
        }),
        readLatestReport: async () => assert.fail('非 main 不得读取放行报告'),
      })
    }, /只允许 main/)
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

  it('runLocalRuntimeReleaseVerification 在 steps 为空时判定为 failed', async () => {
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
        steps: [],
        notes: [],
        artifacts: [],
      }),
      writeReport: async () => ({
        reportFile: '/tmp/local-runtime.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.equal(report.mode, 'local-runtime')
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.steps, [])
  })

  it('runDevRehearsalReleaseVerification 会生成 dev-rehearsal 报告', async () => {
    let receivedCommit = ''
    const report = await runDevRehearsalReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'dev',
        commit: RELEASE_COMMIT,
        isClean: true,
        remote: 'origin',
      }),
      runDevRehearsalVerification: async (options) => {
        receivedCommit = options.releaseCommit
        return {
        steps: [
          { name: 'dev-d1-migrate', status: 'passed', durationMs: 1, command: 'migrate', exitCode: 0, summary: 'ok' },
          { name: 'dev-admin-attribution', status: 'passed', durationMs: 1, command: 'attribution', exitCode: 200, summary: 'ok' },
        ],
        notes: ['meta-test-event-code-missing'],
        artifacts: [],
        }
      },
      writeReport: async () => ({
        reportFile: '/tmp/dev-rehearsal.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.equal(report.mode, 'dev-rehearsal')
    assert.equal(report.status, 'passed')
    assert.equal(report.reportFile, '/tmp/dev-rehearsal.json')
    assert.equal(receivedCommit, RELEASE_COMMIT)
  })

  it('runDevRehearsalReleaseVerification 在 steps 为空时判定为 failed', async () => {
    const report = await runDevRehearsalReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'dev',
        commit: RELEASE_COMMIT,
        isClean: true,
        remote: 'origin',
      }),
      runDevRehearsalVerification: async () => ({
        steps: [],
        notes: [],
        artifacts: [],
      }),
      writeReport: async () => ({
        reportFile: '/tmp/dev-rehearsal.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.equal(report.mode, 'dev-rehearsal')
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.steps, [])
  })

  it('runDevRehearsalReleaseVerification 缺少合法 commit 时保守失败', async () => {
    let called = false
    const report = await runDevRehearsalReleaseVerification({
      collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
      getGitState: async () => ({ branch: 'dev', commit: 'short-sha', isClean: true, remote: 'origin' }),
      runDevRehearsalVerification: async () => {
        called = true
        return { steps: [], notes: [], artifacts: [] }
      },
      writeReport: async () => ({ reportFile: '/tmp/dev-rehearsal.json', latestFile: '/tmp/latest.json' }),
    })

    assert.equal(report.status, 'failed')
    assert.equal(called, false)
    assert.match(report.notes.join('；'), /40 位 commit/)
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
        branch: 'release/v1.0.0',
        commit: RELEASE_COMMIT,
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
      runDevRehearsalReleaseVerification: async (options) => {
        assert.equal(options.releaseCommit, RELEASE_COMMIT)
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
      runMetaResourceVerification: async ({ environment }) => {
        order.push(`meta-resources-${environment}`)
        return {
          status: 'passed',
          environment,
          capiEnabled: false,
          migrationsApplied: true,
          connectionVerified: true,
          openCriticalIncidentCount: 0,
          targetRolloutPercentage: 0,
          effectiveRolloutPercentage: 0,
          trackingMode: environment === 'dev' ? 'test' : 'disabled',
          database: environment === 'dev' ? 'meigallery-db-dev' : 'meigallery-db',
          queues: [],
        }
      },
      readLatestMetaLiveEvidence: async () => ({
        schemaVersion: 2,
        commitSha: RELEASE_COMMIT,
        environment: 'dev',
        capturedAt: '2026-07-10T00:00:00.000Z',
        expiresAt: '2026-07-11T00:00:00.000Z',
        events: ['Contact', 'CompleteRegistration'].map(eventName => ({ eventName })),
        enhancedMatch: {
          completeRegistrationEmail: true,
          completeRegistrationExternalId: true,
          contactContainsRegistrationIdentity: false,
        },
        forbiddenEventsAbsent: { Lead: true, StartTrial: true },
        datasetQualityContractVersion: 1,
        datasetQualityCollectorCurrent: true,
      }),
      assertMetaLiveEvidenceCanGateProduction: () => {},
      recordReleaseVerificationSummary: async ({ environment, verificationType }) => {
        order.push(`${verificationType}-${environment}`)
        return { status: 'passed' }
      },
      writeReport: async () => ({
        reportFile: '/tmp/release.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.deepEqual(order, [
      'quick',
      'local-runtime',
      'dev-rehearsal',
      'meta-resources-dev',
      'meta-resources-production',
      'meta_live-dev',
      'meta_live-production',
    ])
    assert.equal(report.mode, 'release')
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.artifacts, ['/tmp/quick.json', '/tmp/local-runtime.json', '/tmp/dev-rehearsal.json'])
    assert.deepEqual(report.steps.map(step => step.name), [
      'quick',
      'local-runtime',
      'dev-rehearsal',
      'meta-resources-dev',
      'meta-live-evidence',
      'meta-dataset-quality',
      'meta-open-incident-gate',
      'meta-resources-production',
      'meta-initial-rollout-zero',
      'meta-live-store-dev',
      'meta-live-store-production',
    ])
    assert.deepEqual(report.releaseSubModes.map(item => item.mode), ['quick', 'local-runtime', 'dev-rehearsal'])
    assert.deepEqual(report.releaseSubModes[0].passedStepNames, ['scripts-test'])
    assert.match(report.steps[0].summary, /scripts-test/)
    assert.equal(report.metaLiveVerification.commit, RELEASE_COMMIT)
    assert.deepEqual(report.metaLiveVerification.events, ['Contact', 'CompleteRegistration'])
    assert.match(report.steps.find(step => step.name === 'meta-live-evidence')?.summary || '', /同 commit 两事件/)
    assert.doesNotMatch(report.steps.find(step => step.name === 'meta-live-evidence')?.summary || '', /三事件/)
    assert.equal(report.metaResources.dev.status, 'passed')
    assert.equal(report.metaResources.production.status, 'passed')
    assert.equal(report.metaResources.dev.migrationsApplied, true)
    assert.equal(report.metaResources.dev.connectionVerified, true)
    assert.equal(report.metaResources.dev.trackingMode, 'test')
    assert.equal(report.metaResources.production.trackingMode, 'disabled')
  })

  it('首次上线允许 dev CAPI 开启但要求 production CAPI 关闭', async () => {
    const resourceCalls = []
    const child = mode => async () => ({
      mode,
      status: 'passed',
      durationMs: 1,
      reportFile: `/tmp/${mode}.json`,
      steps: [{ name: `${mode}-passed`, status: 'passed' }],
      notes: [],
    })
    const report = await runReleaseVerification({
      env: { META_INITIAL_ROLLOUT: '1' },
      collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
      getGitState: async () => ({ branch: 'release/v1.0.0', commit: RELEASE_COMMIT, isClean: true, remote: 'origin' }),
      runQuickVerification: child('quick'),
      runLocalRuntimeReleaseVerification: child('local-runtime'),
      runDevRehearsalReleaseVerification: child('dev-rehearsal'),
      runMetaResourceVerification: async ({ environment, initialMetaRollout }) => {
        resourceCalls.push({ environment, initialMetaRollout })
        return {
          status: 'passed',
          environment,
          capiEnabled: environment === 'dev',
          initialMetaRollout,
          database: environment === 'dev' ? 'meigallery-db-dev' : 'meigallery-db',
          queues: [],
          connectionVerified: true,
          openCriticalIncidentCount: 0,
          targetRolloutPercentage: 0,
          effectiveRolloutPercentage: 0,
        }
      },
      readLatestMetaLiveEvidence: async () => ({
        schemaVersion: 2,
        commitSha: RELEASE_COMMIT,
        environment: 'dev',
        capturedAt: '2026-07-10T00:00:00.000Z',
        expiresAt: '2026-07-11T00:00:00.000Z',
        events: ['Contact', 'CompleteRegistration'].map(eventName => ({ eventName })),
        enhancedMatch: { completeRegistrationEmail: true, completeRegistrationExternalId: true, contactContainsRegistrationIdentity: false },
        forbiddenEventsAbsent: { Lead: true, StartTrial: true },
        datasetQualityContractVersion: 1,
        datasetQualityCollectorCurrent: true,
      }),
      assertMetaLiveEvidenceCanGateProduction: () => {},
      recordReleaseVerificationSummary: async () => ({ status: 'passed' }),
      writeReport: async () => ({ reportFile: '/tmp/release.json', latestFile: '/tmp/latest.json' }),
    })

    assert.equal(report.status, 'passed')
    assert.equal(report.initialMetaRollout, true)
    assert.deepEqual(resourceCalls, [
      { environment: 'dev', initialMetaRollout: false },
      { environment: 'production', initialMetaRollout: true },
    ])
    assert.equal(report.metaResources.dev.capiEnabled, true)
    assert.equal(report.metaResources.dev.initialMetaRollout, false)
    assert.equal(report.metaResources.production.capiEnabled, false)
    assert.equal(report.metaResources.production.initialMetaRollout, true)
  })

  it('首次上线 production CAPI 开启时 release 失败', async () => {
    const child = mode => async () => ({
      mode,
      status: 'passed',
      durationMs: 1,
      reportFile: `/tmp/${mode}.json`,
      steps: [{ name: `${mode}-passed`, status: 'passed' }],
      notes: [],
    })
    const report = await runReleaseVerification({
      env: { META_INITIAL_ROLLOUT: '1' },
      collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
      getGitState: async () => ({ branch: 'release/v1.0.0', commit: RELEASE_COMMIT, isClean: true, remote: 'origin' }),
      runQuickVerification: child('quick'),
      runLocalRuntimeReleaseVerification: child('local-runtime'),
      runDevRehearsalReleaseVerification: child('dev-rehearsal'),
      runMetaResourceVerification: async ({ environment }) => ({
        status: environment === 'production' ? 'failed' : 'passed',
        environment,
        capiEnabled: true,
        database: environment === 'dev' ? 'meigallery-db-dev' : 'meigallery-db',
        queues: [],
        connectionVerified: true,
        openCriticalIncidentCount: 0,
        targetRolloutPercentage: 0,
        effectiveRolloutPercentage: 0,
      }),
      readLatestMetaLiveEvidence: async () => ({
        schemaVersion: 2,
        commitSha: RELEASE_COMMIT,
        environment: 'dev',
        capturedAt: '2026-07-10T00:00:00.000Z',
        expiresAt: '2026-07-11T00:00:00.000Z',
        events: ['Contact', 'CompleteRegistration'].map(eventName => ({ eventName })),
        enhancedMatch: { completeRegistrationEmail: true, completeRegistrationExternalId: true, contactContainsRegistrationIdentity: false },
        forbiddenEventsAbsent: { Lead: true, StartTrial: true },
        datasetQualityContractVersion: 1,
        datasetQualityCollectorCurrent: true,
      }),
      assertMetaLiveEvidenceCanGateProduction: () => {},
      writeReport: async () => ({ reportFile: '/tmp/release.json', latestFile: '/tmp/latest.json' }),
    })

    assert.equal(report.status, 'failed')
    assert.equal(report.metaResources.production.capiEnabled, true)
  })

  it('dev 分支不能生成 passed release 报告', async () => {
    let childCalled = false
    const report = await runReleaseVerification({
      collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
      getGitState: async () => ({ branch: 'dev', commit: RELEASE_COMMIT, isClean: true, remote: 'origin' }),
      runQuickVerification: async () => {
        childCalled = true
        return { status: 'passed', steps: [{ name: 'quick', status: 'passed' }] }
      },
      writeReport: async () => ({ reportFile: '/tmp/release.json', latestFile: '/tmp/latest.json' }),
    })

    assert.equal(report.status, 'failed')
    assert.equal(childCalled, false)
    assert.match(report.notes.join('；'), /分支不是 main 或 release/)
  })

  it('release 在缺少 Meta 资源配置时失败，且不读取或记录 live evidence', async () => {
    const order = []
    const child = mode => async () => ({
      mode,
      status: 'passed',
      durationMs: 1,
      reportFile: `/tmp/${mode}.json`,
      steps: [{ name: `${mode}-passed`, status: 'passed' }],
      notes: [],
    })
    const report = await runReleaseVerification({
      collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
      getGitState: async () => ({ branch: 'release/v1.0.0', commit: RELEASE_COMMIT, isClean: true, remote: 'origin' }),
      runQuickVerification: child('quick'),
      runLocalRuntimeReleaseVerification: child('local-runtime'),
      runDevRehearsalReleaseVerification: child('dev-rehearsal'),
      runMetaResourceVerification: async ({ environment }) => {
        order.push(environment)
        return { status: 'failed', environment, capiEnabled: false, database: 'safe', queues: [] }
      },
      readLatestMetaLiveEvidence: async () => assert.fail('资源检查失败后不得读取 live evidence'),
      recordReleaseVerificationSummary: async () => assert.fail('资源检查失败后不得写摘要'),
      writeReport: async () => ({ reportFile: '/tmp/release.json', latestFile: '/tmp/latest.json' }),
    })

    assert.equal(report.status, 'failed')
    assert.deepEqual(order, ['dev'])
  })

  it('META_INITIAL_ROLLOUT 只接受精确值 1', async () => {
    await assert.rejects(async () => {
      await runReleaseVerification({
        env: { META_INITIAL_ROLLOUT: 'true' },
        collectVersions: async () => ({ node: 'v24', pnpm: '10', wrangler: '4' }),
        getGitState: async () => ({ branch: 'release/v1', commit: RELEASE_COMMIT, isClean: true, remote: 'origin' }),
        writeReport: async () => ({ reportFile: '/tmp/release.json', latestFile: '/tmp/latest.json' }),
      })
    }, /META_INITIAL_ROLLOUT.*1/)
  })

  it('runReleaseVerification 在子模式没有 passed step 时不会生成 passed release 报告', async () => {
    const order = []
    const report = await runReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'release/v1.0.0',
        commit: RELEASE_COMMIT,
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
          steps: [{ name: 'dev-admin-attribution', status: 'passed' }],
          notes: [],
        }
      },
      writeReport: async () => ({
        reportFile: '/tmp/release.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.deepEqual(order, ['quick', 'local-runtime'])
    assert.equal(report.mode, 'release')
    assert.equal(report.status, 'failed')
    assert.equal(report.steps[1].status, 'failed')
    assert.deepEqual(report.steps[1].passedStepNames, [])
    assert.deepEqual(report.releaseSubModes[1].passedStepNames, [])
    assert.match(report.notes.join('；'), /没有真实 passed step/)
  })

  it('runReleaseVerification 在工作区不干净时写出 failed release 报告', async () => {
    const report = await runReleaseVerification({
      collectVersions: async () => ({
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      }),
      getGitState: async () => ({
        branch: 'release/v0.1.0',
        commit: RELEASE_COMMIT,
        isClean: false,
        remote: 'origin',
      }),
      runQuickVerification: async () => ({
        mode: 'quick',
        status: 'passed',
        durationMs: 10,
        reportFile: '/tmp/quick.json',
        steps: [{ name: 'scripts-test', status: 'passed' }],
        notes: [],
      }),
      runLocalRuntimeReleaseVerification: async () => ({
        mode: 'local-runtime',
        status: 'passed',
        durationMs: 20,
        reportFile: '/tmp/local-runtime.json',
        steps: [{ name: 'local-d1-migrate', status: 'passed' }],
        notes: [],
      }),
      runDevRehearsalReleaseVerification: async () => ({
        mode: 'dev-rehearsal',
        status: 'passed',
        durationMs: 30,
        reportFile: '/tmp/dev-rehearsal.json',
        steps: [{ name: 'dev-admin-attribution', status: 'passed' }],
        notes: [],
      }),
      writeReport: async () => ({
        reportFile: '/tmp/release.json',
        latestFile: '/tmp/latest.json',
      }),
    })

    assert.equal(report.mode, 'release')
    assert.equal(report.status, 'failed')
    assert.match(report.notes.join('；'), /工作区不是干净状态/)
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
        branch: 'release/v1.0.0',
        commit: RELEASE_COMMIT,
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
