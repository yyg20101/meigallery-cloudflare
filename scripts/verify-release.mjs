#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  assertReportCanGateProduction,
  collectVersions,
  getGitState,
  readLatestReport,
  runCommand,
  writeReport,
} from './release-verification-lib.mjs'
import { runDevRehearsalVerification } from './verify-dev-rehearsal.mjs'
import { runLocalRuntimeVerification } from './verify-local-runtime.mjs'
import {
  assertReleaseVerificationRow,
  recordReleaseVerificationSummary,
} from './release-verification-store.mjs'
import { runMetaResourceVerification } from './verify-meta-resources.mjs'
import { verifyApprovedMetaDatasetQualityContract } from './meta-dataset-quality-contract-lib.mjs'
import { verifyProductionReleaseIdentity } from './record-meta-live-verification.mjs'

const QUICK_STEPS = [
  {
    name: 'dependency-install',
    command: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile'],
  },
  {
    name: 'lint',
    command: 'corepack',
    args: ['pnpm', 'lint'],
  },
  {
    name: 'dev-resource-isolation',
    command: 'node',
    args: ['scripts/verify-dev-resources.mjs'],
  },
  {
    name: 'meta-secret-leaks',
    command: 'node',
    args: ['scripts/verify-meta-secret-leaks.mjs'],
  },
  {
    name: 'scripts-test',
    command: 'corepack',
    args: ['pnpm', 'test:scripts'],
  },
  {
    name: 'api-unit',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/api', 'test'],
  },
  {
    name: 'api-coverage',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/api', 'run', 'test:coverage'],
  },
  {
    name: 'api-typecheck',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/api', 'exec', 'tsc', '--noEmit'],
  },
  {
    name: 'web-typecheck',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/web', 'exec', 'nuxt', 'typecheck'],
  },
  {
    name: 'web-unit',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/web', 'run', 'test:unit'],
  },
  {
    name: 'web-e2e',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/web', 'exec', 'playwright', 'test'],
  },
  {
    name: 'web-build',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/web', 'exec', 'nuxt', 'build'],
  },
  {
    name: 'api-dry-run-deploy',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'deploy', '--env=', '--dry-run', '--outdir=dist'],
  },
]

if (isCliEntry()) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const [mode] = argv

  if (!mode || mode === '--help' || mode === '-h') {
    printHelp()
    return
  }

  if (mode === 'assert-production-allowed') {
    await assertProductionAllowed(options)
    console.log('最近一次发布验证报告允许生产部署。')
    return
  }

  if (mode === 'assert-production-identity') {
    await assertProductionReleaseIdentity(options)
    console.log('production API/Web 发布 commit 与本地 Git HEAD 一致。')
    return
  }

  let report
  if (mode === 'quick') {
    report = await runQuickVerification({ ...options, mode })
  } else if (mode === 'dev-rehearsal') {
    report = await runDevRehearsalReleaseVerification({ ...options, mode })
  } else if (mode === 'local-runtime') {
    report = await runLocalRuntimeReleaseVerification({ ...options, mode })
  } else if (mode === 'release') {
    report = await runReleaseVerification({ ...options, mode })
  } else {
    throw new Error(`模式 ${mode} 尚未实现`)
  }

  if (report.status !== 'passed') {
    throw new Error(`发布快速验证失败，报告已写入：${report.reportFile}`)
  }

  console.log(`发布快速验证通过，报告已写入：${report.reportFile}`)
}

export async function runReleaseVerification(options = {}) {
  const initialMetaRollout = parseInitialMetaRollout(options.env || process.env)
  const mode = options.mode || 'release'
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const collectVersionsFn = options.collectVersions || collectVersions
  const getGitStateFn = options.getGitState || getGitState
  const writeReportFn = options.writeReport || writeReport
  const runQuickVerificationFn = options.runQuickVerification || runQuickVerification
  const runLocalRuntimeReleaseVerificationFn = options.runLocalRuntimeReleaseVerification || runLocalRuntimeReleaseVerification
  const runDevRehearsalReleaseVerificationFn = options.runDevRehearsalReleaseVerification || runDevRehearsalReleaseVerification
  const verifyApprovedMetaDatasetQualityContractFn = options.verifyApprovedMetaDatasetQualityContract || verifyApprovedMetaDatasetQualityContract
  const runMetaResourceVerificationFn = options.runMetaResourceVerification || runMetaResourceVerification
  const readRemoteProductionLiveGateFn = options.readRemoteProductionLiveGate || readRemoteProductionLiveGate
  const recordReleaseVerificationSummaryFn = options.recordReleaseVerificationSummary || recordReleaseVerificationSummary
  const versions = await collectVersionsFn(options)
  const git = await getGitStateFn(options)
  const steps = []
  const artifacts = []
  const notes = []
  const releaseSubModes = []
  const releaseGitBlockers = []
  const metaResources = {
    dev: skippedMetaResource('dev'),
    production: skippedMetaResource('production'),
  }
  let metaLiveVerification = {
    status: 'skipped',
    commit: git.commit || '',
    verifiedAt: '',
    expiresAt: '',
    events: [],
  }
  let datasetQualityContract = {
    status: 'failed',
    path: '',
    version: null,
    digest: '',
  }

  if (typeof git.branch !== 'string' || git.branch.trim() === '') releaseGitBlockers.push('无法获取当前 Git branch')
  else if (!isReleaseReportBranchAllowed(git.branch, options.env || process.env)) releaseGitBlockers.push('release 报告生成分支不是 main 或 release/*')
  if (!isValidCommit(git.commit)) releaseGitBlockers.push('release 报告需要 40 位 Git commit')
  if (git.isClean !== true) releaseGitBlockers.push('release 报告对应工作区不是干净状态')

  const childRuns = [
    ['quick', runQuickVerificationFn],
    ['local-runtime', runLocalRuntimeReleaseVerificationFn],
    ['dev-rehearsal', runDevRehearsalReleaseVerificationFn],
  ]

  if (releaseGitBlockers.length > 0) {
    notes.push(`${releaseGitBlockers.join('；')}，已跳过 release 子模式编排。`)
  } else {
    for (const [childMode, runChild] of childRuns) {
      const childReport = await runChild({ ...options, mode: childMode, releaseCommit: git.commit })
      if (childReport.reportFile) artifacts.push(childReport.reportFile)

      const passedSteps = Array.isArray(childReport.steps)
        ? childReport.steps
          .filter(step => step?.status === 'passed' && typeof step?.name === 'string' && step.name.trim() !== '')
          .map(step => step.name)
        : []
      const childStatus = childReport.status === 'passed' && passedSteps.length > 0 ? 'passed' : 'failed'
      const childSummary = {
        mode: childMode,
        status: childStatus,
        passedStepNames: passedSteps,
        reportFile: childReport.reportFile || '',
      }
      releaseSubModes.push(childSummary)

      steps.push({
        name: childMode,
        status: childStatus,
        durationMs: childReport.durationMs ?? 0,
        command: `node scripts/verify-release.mjs ${childMode}`,
        exitCode: childStatus === 'passed' ? 0 : 1,
        summary: passedSteps.length > 0
          ? `通过步骤：${passedSteps.join('、')}；报告：${childReport.reportFile}`
          : `没有真实通过步骤；报告：${childReport.reportFile}`,
        passedStepNames: passedSteps,
      })

      if (Array.isArray(childReport.notes) && childReport.notes.length > 0) {
        notes.push(`[${childMode}] ${childReport.notes.join('；')}`)
      }

      if (childReport.status === 'passed' && passedSteps.length === 0) {
        notes.push(`[${childMode}] 子模式没有真实 passed step，release 不能通过。`)
      }

      if (childStatus !== 'passed') {
        notes.push(`release 编排在 ${childMode} 阶段停止，请先修复该阶段失败项。`)
        break
      }
    }
  }

  const childModesPassed = releaseSubModes.length === childRuns.length && releaseSubModes.every(item => item.status === 'passed')
  if (releaseGitBlockers.length === 0 && childModesPassed) {
    const contractStartedMs = Date.now()
    try {
      const contract = await verifyApprovedMetaDatasetQualityContractFn({ cwd: options.cwd })
      datasetQualityContract = { status: 'passed', ...contract }
      steps.push({
        name: 'meta-dataset-quality-contract', status: 'passed', durationMs: Date.now() - contractStartedMs,
        command: '验证 Git tracked approved Dataset Quality contract artifact/digest', exitCode: 0,
        summary: `Dataset Quality contract v${contract.version} digest 已验证`,
      })
    } catch (error) {
      steps.push({
        name: 'meta-dataset-quality-contract', status: 'failed', durationMs: Date.now() - contractStartedMs,
        command: '验证 Git tracked approved Dataset Quality contract artifact/digest', exitCode: 1,
        summary: error instanceof Error ? error.message : String(error),
      })
      notes.push('Dataset Quality approved contract artifact/digest 校验失败。')
    }
  }

  if (!initialMetaRollout && releaseGitBlockers.length === 0 && childModesPassed && datasetQualityContract.status === 'passed') {
    const liveStartedMs = Date.now()
    try {
      const evidence = await readRemoteProductionLiveGateFn({ ...options, contract: datasetQualityContract })
      if (evidence?.status !== 'passed') throw new Error('production 远端 live evidence 不可用')
      metaLiveVerification = {
        status: 'passed',
        commit: evidence.commit,
        environment: 'production',
        verifiedAt: evidence.verifiedAt,
        expiresAt: evidence.expiresAt,
        events: ['Contact', 'CompleteRegistration'],
        enhancedMatchVerified: true,
        forbiddenEventsAbsent: true,
      }
      steps.push({
        name: 'meta-live-evidence',
        status: 'passed',
        durationMs: Date.now() - liveStartedMs,
        command: '读取 production D1 最新有效 Meta live evidence',
        exitCode: 0,
        summary: `当前 Meta 连接两事件 live evidence 通过：${metaLiveVerification.events.join('、')}`,
      })
    } catch (error) {
      steps.push({
        name: 'meta-live-evidence',
        status: 'failed',
        durationMs: Date.now() - liveStartedMs,
        command: '读取 reports/meta-live-verification/latest.json',
        exitCode: 1,
        summary: error instanceof Error ? error.message : String(error),
      })
      notes.push('Meta live evidence 校验失败。')
    }
  }

  const productionEvidenceGatePassed = initialMetaRollout
    ? datasetQualityContract.status === 'passed'
    : metaLiveVerification.status === 'passed'
  if (productionEvidenceGatePassed) {
    const startedResourceMs = Date.now()
    const result = await runMetaResourceVerificationFn({
      ...options,
      environment: 'production',
      commit: git.commit,
      initialMetaRollout,
      reportOnly: false,
      expectedDatasetQualityContract: initialMetaRollout ? undefined : datasetQualityContract,
    })
    metaResources.production = sanitizeMetaResourceSummary(result, 'production', git.commit)
    steps.push({
      name: 'meta-resources-production', status: result?.status === 'passed' ? 'passed' : 'failed',
      durationMs: Date.now() - startedResourceMs,
      command: `node scripts/verify-meta-resources.mjs --env production${initialMetaRollout ? ' --initial-meta-rollout' : ''}`,
      exitCode: result?.status === 'passed' ? 0 : 1,
      summary: result?.status === 'passed' ? 'Meta production 资源检查通过' : 'Meta production 资源检查失败',
    })
    if (result?.status === 'passed') {
      if (!initialMetaRollout) {
        steps.push({
          name: 'meta-dataset-quality', status: result.datasetQualityCollectorCurrent === true ? 'passed' : 'failed', durationMs: 0,
          command: '校验 production Dataset Quality 当前快照', exitCode: result.datasetQualityCollectorCurrent === true ? 0 : 1,
          summary: result.datasetQualityCollectorCurrent === true ? 'production Dataset Quality 当前快照通过' : 'production Dataset Quality 当前快照缺失',
        })
        steps.push({
          name: 'meta-open-incident-gate', status: result.openCriticalIncidentCount === 0 ? 'passed' : 'failed', durationMs: 0,
          command: '校验 production open critical incident', exitCode: result.openCriticalIncidentCount === 0 ? 0 : 1,
          summary: result.openCriticalIncidentCount === 0 ? 'production 无 open critical incident' : 'production open critical incident 非零',
        })
      }
      const rolloutPassed = !initialMetaRollout || (
        result.targetRolloutPercentage === 0 && result.effectiveRolloutPercentage === 0
      )
      steps.push({
        name: 'meta-initial-rollout-zero', status: rolloutPassed ? 'passed' : 'failed', durationMs: 0,
        command: '校验 production target/effective rollout', exitCode: rolloutPassed ? 0 : 1,
        summary: rolloutPassed ? 'production initial rollout 为 0' : 'production initial rollout 非 0',
      })
    }
  }

  const resourcesPassed = metaResources.production.status === 'passed'
  if (metaLiveVerification.status === 'passed' && resourcesPassed) {
    for (const environment of ['production']) {
      const startedStoreMs = Date.now()
      const storeStep = await recordReleaseVerificationSummaryFn({
        environment,
        verificationType: 'meta_live',
        commit: git.commit,
        verifiedAt: metaLiveVerification.verifiedAt,
        summary: {
          schemaVersion: 2,
          commitSha: git.commit,
          environment,
          events: ['Contact', 'CompleteRegistration'],
          eventsVerified: true,
          forbiddenEventsAbsent: true,
          datasetQualityContractVersion: datasetQualityContract.version,
          datasetQualityContractDigest: datasetQualityContract.digest,
        },
        cwd: options.cwd,
        runCommand: options.runCommand,
      })
      steps.push({
        name: `meta-live-store-${environment}`,
        status: storeStep?.status === 'passed' ? 'passed' : 'failed',
        durationMs: Date.now() - startedStoreMs,
        command: `写入 ${environment} D1 Meta live 脱敏摘要`,
        exitCode: storeStep?.status === 'passed' ? 0 : 1,
        summary: storeStep?.status === 'passed' ? 'Meta live 脱敏摘要写入成功' : 'Meta live 脱敏摘要写入失败',
      })
      if (storeStep?.status !== 'passed') {
        notes.push(`Meta live 脱敏摘要写入 ${environment} D1 失败。`)
        break
      }
    }
  }

  const finishedAt = new Date().toISOString()
  const requiredMetaSteps = initialMetaRollout
    ? ['meta-dataset-quality-contract', 'meta-resources-production', 'meta-initial-rollout-zero']
    : [
        'meta-dataset-quality-contract',
        'meta-resources-production',
        'meta-live-evidence',
        'meta-dataset-quality',
        'meta-open-incident-gate',
        'meta-live-store-production',
      ]
  const metaStepsPassed = requiredMetaSteps.every(name => steps.some(step => step.name === name && step.status === 'passed'))
  const report = {
    schemaVersion: 1,
    mode,
    status: releaseGitBlockers.length === 0 && childModesPassed && metaStepsPassed ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    git,
    versions,
    steps,
    releaseSubModes,
    initialMetaRollout,
    metaLiveVerification,
    datasetQualityContract,
    metaResources,
    artifacts,
    notes,
  }
  const files = await writeReportFn(report, options)

  return {
    ...report,
    ...files,
  }
}

function parseInitialMetaRollout(env) {
  const value = env?.META_INITIAL_ROLLOUT
  if (value === undefined || value === '') return false
  if (value !== '1') throw new Error('META_INITIAL_ROLLOUT 只接受精确值 1')
  return true
}

function isReleaseReportBranchAllowed(branch, env) {
  const value = String(branch || '').trim()
  const override = String(env?.VERIFY_RELEASE_ALLOW_BRANCH || '').trim()
  return value === 'main' || value.startsWith('release/') || Boolean(override && value === override)
}

function isValidCommit(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || '').trim())
}

function skippedMetaResource(environment) {
  return {
    status: 'skipped',
    environment,
    commit: '',
    database: environment === 'dev' ? 'meigallery-db-dev' : 'meigallery-db',
    queues: [],
    capiEnabled: null,
  }
}

function sanitizeMetaResourceSummary(result, environment, commit) {
  return {
    status: result?.status === 'passed' ? 'passed' : 'failed',
    environment,
    commit,
    database: String(result?.database || (environment === 'dev' ? 'meigallery-db-dev' : 'meigallery-db')),
    queues: Array.isArray(result?.queues) ? result.queues.map(String) : [],
    consumersPresent: result?.consumersPresent === true,
    r2Present: result?.r2Present === true,
    secretsPresent: result?.secretsPresent === true,
    migrationsCurrent: result?.migrationsCurrent === true,
    migrationsApplied: result?.migrationsApplied === true,
    connectionVerified: result?.connectionVerified === true,
    openCriticalIncidentCount: Number.isSafeInteger(result?.openCriticalIncidentCount) ? result.openCriticalIncidentCount : null,
    targetRolloutPercentage: Number.isSafeInteger(result?.targetRolloutPercentage) ? result.targetRolloutPercentage : null,
    effectiveRolloutPercentage: Number.isSafeInteger(result?.effectiveRolloutPercentage) ? result.effectiveRolloutPercentage : null,
    trackingMode: ['disabled', 'test', 'production'].includes(result?.trackingMode)
      ? result.trackingMode
      : null,
    capiEnabled: typeof result?.capiEnabled === 'boolean' ? result.capiEnabled : null,
    initialMetaRollout: result?.initialMetaRollout === true,
    phase: result?.phase === 'bootstrap' ? 'bootstrap' : 'full',
    datasetQualityContractVersion: Number.isSafeInteger(result?.datasetQualityContractVersion) ? result.datasetQualityContractVersion : null,
    datasetQualityContractDigest: /^sha256:[0-9a-f]{64}$/.test(String(result?.datasetQualityContractDigest || '')) ? result.datasetQualityContractDigest : '',
    datasetQualityCollectorCurrent: result?.datasetQualityCollectorCurrent === true,
    environmentIsolation: sanitizeEnvironmentIsolation(result?.environmentIsolation),
  }
}

function sanitizeEnvironmentIsolation(value) {
  const fields = ['d1', 'r2', 'queue', 'dlq', 'pixel', 'token', 'testEventCode', 'dataKey']
  return Object.fromEntries(fields.map(field => [field, value?.[field] === true]))
}

export async function runLocalRuntimeReleaseVerification(options = {}) {
  const mode = options.mode || 'local-runtime'
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const collectVersionsFn = options.collectVersions || collectVersions
  const getGitStateFn = options.getGitState || getGitState
  const runLocalRuntimeVerificationFn = options.runLocalRuntimeVerification || runLocalRuntimeVerification
  const writeReportFn = options.writeReport || writeReport
  const versions = await collectVersionsFn(options)
  const git = await getGitStateFn(options)
  const { steps, notes, artifacts, sensitiveValues = [] } = await runLocalRuntimeVerificationFn(options)
  const normalizedSteps = Array.isArray(steps) ? steps : []
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    mode,
    status: normalizedSteps.length > 0 && normalizedSteps.every(step => step.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    git,
    versions,
    steps: normalizedSteps,
    artifacts,
    notes,
  }
  const files = await writeReportFn(report, options)
  await assertReportOmitsSecrets(files, sensitiveValues)

  return {
    ...report,
    ...files,
  }
}

export async function runDevRehearsalReleaseVerification(options = {}) {
  const mode = options.mode || 'dev-rehearsal'
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const collectVersionsFn = options.collectVersions || collectVersions
  const getGitStateFn = options.getGitState || getGitState
  const runDevRehearsalVerificationFn = options.runDevRehearsalVerification || runDevRehearsalVerification
  const writeReportFn = options.writeReport || writeReport
  const versions = await collectVersionsFn(options)
  const git = await getGitStateFn(options)
  const verification = isValidCommit(git.commit)
    ? await runDevRehearsalVerificationFn({ ...options, releaseCommit: git.commit })
    : {
        steps: [{
          name: 'dev-release-commit',
          status: 'failed',
          durationMs: 0,
          command: 'git rev-parse HEAD',
          exitCode: 1,
          summary: 'dev rehearsal release 路径需要 40 位 commit',
        }],
        notes: ['dev rehearsal release 路径缺少合法的 40 位 commit'],
        artifacts: [],
      }
  const { steps, notes, artifacts, sensitiveValues = [] } = verification
  const normalizedSteps = Array.isArray(steps) ? steps : []
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    mode,
    status: normalizedSteps.length > 0 && normalizedSteps.every(step => step.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    git,
    versions,
    steps: normalizedSteps,
    artifacts,
    notes,
  }
  const files = await writeReportFn(report, options)
  await assertReportOmitsSecrets(files, sensitiveValues)

  return {
    ...report,
    ...files,
  }
}

export async function assertProductionAllowed(options = {}) {
  const readLatestReportFn = options.readLatestReport || readLatestReport
  const getGitStateFn = options.getGitState || getGitState
  const assertReportCanGateProductionFn = options.assertReportCanGateProduction || assertReportCanGateProduction
  const collectTrustedProductionGateFactsFn = options.collectTrustedProductionGateFacts || collectTrustedProductionGateFacts
  const currentGit = await getGitStateFn(options)
  const expectedBranch = currentGit.branch?.trim()
  const expectedCommit = currentGit.commit?.trim()

  if (!expectedBranch) {
    throw new Error('无法获取当前 Git branch，拒绝放行生产部署')
  }
  if (!expectedCommit) {
    throw new Error('无法获取当前 Git commit，拒绝放行生产部署')
  }
  if (currentGit.isClean !== true) {
    throw new Error('当前工作区不是干净状态，拒绝放行生产部署')
  }
  if (expectedBranch !== 'main') {
    throw new Error('最终生产部署只允许 main 分支')
  }

  const report = await readLatestReportFn(options)
  assertReportCanGateProductionFn(report, {
    ...options,
    currentBranch: expectedBranch,
    expectedCommit,
  })
  await collectTrustedProductionGateFactsFn({
    ...options,
    commit: expectedCommit,
  })
}

export async function collectTrustedProductionGateFacts(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('受信生产门禁需要当前 40 位 commit')
  const verifyContractFn = options.verifyApprovedMetaDatasetQualityContract || verifyApprovedMetaDatasetQualityContract
  const runMetaResourceVerificationFn = options.runMetaResourceVerification || runMetaResourceVerification
  const readRemoteProductionLiveGateFn = options.readRemoteProductionLiveGate || readRemoteProductionLiveGate
  const readTrustedProductionBootstrapPermitFn = options.readTrustedProductionBootstrapPermit || readTrustedProductionBootstrapPermit

  const contract = await verifyContractFn(options)
  const bootstrapPermitted = await readTrustedProductionBootstrapPermitFn({ ...options, commit })
  if (bootstrapPermitted) {
    const production = await runMetaResourceVerificationFn({
      ...options,
      environment: 'production',
      commit,
      phase: 'bootstrap',
      initialMetaRollout: true,
      reportOnly: true,
    })
    if (production?.status !== 'passed'
      || production.openCriticalIncidentCount !== 0
      || production.targetRolloutPercentage !== 0
      || production.effectiveRolloutPercentage !== 0) {
      throw new Error('当前 production bootstrap resource/incident/rollout 链未通过')
    }
    return { contract, production, bootstrapPermitted: true }
  }
  const live = await readRemoteProductionLiveGateFn({ ...options, commit, contract })
  if (live?.status !== 'passed') throw new Error('当前 production 远端 live evidence 链未通过')

  const production = await runMetaResourceVerificationFn({
    ...options,
    environment: 'production',
    commit,
    phase: 'full',
    initialMetaRollout: false,
    reportOnly: true,
    expectedDatasetQualityContract: contract,
  })
  if (production?.status !== 'passed'
    || production.openCriticalIncidentCount !== 0
    || (
      production.datasetQualityCollectorCurrent !== true
      || production.datasetQualityContractVersion !== contract.version
      || production.datasetQualityContractDigest !== contract.digest
    )) {
    throw new Error('当前 production 远端 resource/incident/rollout 链未通过')
  }
  return { status: 'passed', production, live, contract }
}

export async function assertProductionReleaseIdentity(options = {}) {
  const getGitStateFn = options.getGitState || getGitState
  const verifyProductionReleaseIdentityFn = options.verifyProductionReleaseIdentity || verifyProductionReleaseIdentity
  const git = await getGitStateFn(options)
  if (git.branch !== 'main' || git.isClean !== true || !isValidCommit(git.commit)) {
    throw new Error('production 发布后 identity 校验只允许干净的 main 40 位 commit')
  }
  await verifyProductionReleaseIdentityFn({ ...options, commit: git.commit.toLowerCase() })
}

export async function readRemoteProductionLiveGate(options = {}) {
  const sql = `
    SELECT summary, verified_at, expires_at
    FROM analytics_release_verifications
    WHERE environment = 'production' AND verification_type = 'meta_live'
      AND status = 'passed'
      AND datetime(expires_at) > datetime('now')
    ORDER BY verified_at DESC LIMIT 1
  `.replace(/\s+/g, ' ').trim()
  const step = await (options.runCommand || runCommand)('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    '--env', '', '--remote', '--command', sql, '--json',
  ], { cwd: options.cwd || process.cwd(), name: 'production-gate-production-live', reportCommand: '重查 production D1 当前 Meta 连接 live 脱敏摘要' })
  if (step.status !== 'passed') throw new Error('当前 production 远端 live evidence 查询失败')
  try {
    const payload = JSON.parse(String(step.stdout || ''))
    const rows = payload?.[0]?.results
    if (!Array.isArray(rows) || rows.length !== 1) return { status: 'failed' }
    const rawSummary = JSON.parse(String(rows[0].summary || ''))
    const evidenceCommit = String(rawSummary.commitSha || '').trim().toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(evidenceCommit)) return { status: 'failed' }
    const contract = options.contract
    const summary = assertReleaseVerificationRow({
      row: rows[0],
      environment: 'production',
      verificationType: 'meta_live',
      commit: evidenceCommit,
      now: options.now,
    })
    const valid = summary.datasetQualityContractVersion === contract?.version
      && summary.datasetQualityContractDigest === contract?.digest
    return {
      status: valid ? 'passed' : 'failed',
      commit: evidenceCommit,
      verifiedAt: String(rows[0].verified_at || ''),
      expiresAt: String(rows[0].expires_at || ''),
    }
  }
  catch {
    return { status: 'failed' }
  }
}

export async function readTrustedProductionBootstrapPermit(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('bootstrap permit 需要当前 40 位 commit')
  const sql = `
    SELECT summary, verified_at, expires_at
    FROM analytics_release_verifications
    WHERE environment = 'production' AND verification_type = 'meta_resources'
      AND status = 'passed' AND commit_sha = '${commit}'
      AND datetime(expires_at) > datetime('now')
    ORDER BY verified_at DESC LIMIT 1
  `.replace(/\s+/g, ' ').trim()
  const step = await (options.runCommand || runCommand)('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    '--env', '', '--remote', '--command', sql, '--json',
  ], { cwd: options.cwd || process.cwd(), name: 'production-gate-bootstrap-permit', reportCommand: '重查 production D1 当前 commit bootstrap permit' })
  if (step.status !== 'passed') throw new Error('production bootstrap permit 查询失败')
  try {
    const payload = JSON.parse(String(step.stdout || ''))
    const rows = payload?.[0]?.results
    if (!Array.isArray(rows) || rows.length !== 1) return false
    const summary = assertReleaseVerificationRow({
      row: rows[0], environment: 'production', verificationType: 'meta_resources', commit, now: options.now,
    })
    return summary.verificationPhase === 'bootstrap'
  }
  catch {
    return false
  }
}

export async function runQuickVerification(options = {}) {
  const mode = options.mode || 'quick'
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const collectVersionsFn = options.collectVersions || collectVersions
  const getGitStateFn = options.getGitState || getGitState
  const runCommandFn = options.runCommand || runCommand
  const writeReportFn = options.writeReport || writeReport
  const versions = await collectVersionsFn(options)
  const git = await getGitStateFn(options)
  const steps = []
  const notes = []

  for (const stepDefinition of QUICK_STEPS) {
    const step = await runCommandFn(stepDefinition.command, stepDefinition.args, {
      cwd: options.cwd || process.cwd(),
      name: stepDefinition.name,
    })
    steps.push(step)

    if (step.status !== 'passed') {
      notes.push(`步骤 ${step.name} 执行失败，后续步骤已停止。`)
      break
    }
  }

  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    mode,
    status: steps.every(step => step.status === 'passed') && steps.length === QUICK_STEPS.length ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    git,
    versions,
    steps: steps.map(({ stdout, stderr, ...step }) => step),
    artifacts: [],
    notes,
  }
  const files = await writeReportFn(report, options)

  return {
    ...report,
    ...files,
  }
}

function printHelp() {
  console.log(`
用法：
  node scripts/verify-release.mjs quick
  node scripts/verify-release.mjs dev-rehearsal
  node scripts/verify-release.mjs local-runtime
  node scripts/verify-release.mjs release
  node scripts/verify-release.mjs assert-production-allowed
  node scripts/verify-release.mjs assert-production-identity
`.trim())
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

async function assertReportOmitsSecrets(files, sensitiveValues) {
  const secrets = sensitiveValues.filter(value => typeof value === 'string' && value.trim() !== '')
  if (secrets.length === 0) return

  const [reportFileContent, latestFileContent] = await Promise.all([
    readFile(files.reportFile, 'utf8'),
    readFile(files.latestFile, 'utf8'),
  ])

  for (const secret of secrets) {
    assert.equal(reportFileContent.includes(secret), false, 'reportFile 包含敏感 token 信息')
    assert.equal(latestFileContent.includes(secret), false, 'latestFile 包含敏感 token 信息')
  }
}
