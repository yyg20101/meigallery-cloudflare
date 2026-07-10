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
  assertMetaLiveEvidenceCanGateProduction,
  readLatestMetaLiveEvidence,
} from './meta-live-verification-lib.mjs'
import { recordReleaseVerificationSummary } from './release-verification-store.mjs'
import { runMetaResourceVerification } from './verify-meta-resources.mjs'

const QUICK_STEPS = [
  {
    name: 'dev-resource-isolation',
    command: 'node',
    args: ['scripts/verify-dev-resources.mjs'],
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
  const runMetaResourceVerificationFn = options.runMetaResourceVerification || runMetaResourceVerification
  const readLatestMetaLiveEvidenceFn = options.readLatestMetaLiveEvidence || readLatestMetaLiveEvidence
  const assertMetaLiveEvidenceCanGateProductionFn = options.assertMetaLiveEvidenceCanGateProduction || assertMetaLiveEvidenceCanGateProduction
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

  if (typeof git.branch !== 'string' || git.branch.trim() === '') releaseGitBlockers.push('无法获取当前 Git branch')
  if (typeof git.commit !== 'string' || git.commit.trim() === '') releaseGitBlockers.push('无法获取当前 Git commit')
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
      const childReport = await runChild({ ...options, mode: childMode })
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
    for (const environment of ['dev', 'production']) {
      const startedResourceMs = Date.now()
      const result = await runMetaResourceVerificationFn({
        ...options,
        environment,
        commit: git.commit,
        initialMetaRollout,
        reportOnly: false,
      })
      metaResources[environment] = sanitizeMetaResourceSummary(result, environment, git.commit)
      steps.push({
        name: `meta-resources-${environment}`,
        status: result?.status === 'passed' ? 'passed' : 'failed',
        durationMs: Date.now() - startedResourceMs,
        command: `node scripts/verify-meta-resources.mjs --env ${environment}${initialMetaRollout ? ' --initial-meta-rollout' : ''}`,
        exitCode: result?.status === 'passed' ? 0 : 1,
        summary: result?.status === 'passed' ? `Meta ${environment} 资源检查通过` : `Meta ${environment} 资源检查失败`,
      })
      if (result?.status !== 'passed') {
        notes.push(`Meta ${environment} 资源检查失败，已停止后续生产门禁。`)
        break
      }
    }
  }

  const resourcesPassed = metaResources.dev.status === 'passed' && metaResources.production.status === 'passed'
  if (resourcesPassed) {
    const liveStartedMs = Date.now()
    try {
      const evidence = await readLatestMetaLiveEvidenceFn(options)
      assertMetaLiveEvidenceCanGateProductionFn(evidence, {
        expectedCommit: git.commit,
        now: options.now,
      })
      metaLiveVerification = {
        status: 'passed',
        commit: evidence.commit,
        verifiedAt: evidence.verifiedAt,
        expiresAt: evidence.expiresAt,
        events: evidence.events.map(event => event.eventName),
      }
      steps.push({
        name: 'meta-live-evidence',
        status: 'passed',
        durationMs: Date.now() - liveStartedMs,
        command: '读取 reports/meta-live-verification/latest.json',
        exitCode: 0,
        summary: `同 commit 三事件 live evidence 通过：${metaLiveVerification.events.join('、')}`,
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

  if (metaLiveVerification.status === 'passed') {
    for (const environment of ['dev', 'production']) {
      const startedStoreMs = Date.now()
      const storeStep = await recordReleaseVerificationSummaryFn({
        environment,
        verificationType: 'meta_live',
        commit: git.commit,
        verifiedAt: metaLiveVerification.verifiedAt,
        summary: {
          eventsVerified: true,
          noStartTrial: true,
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
  const requiredMetaSteps = [
    'meta-resources-dev',
    'meta-resources-production',
    'meta-live-evidence',
    'meta-live-store-dev',
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
    secretsPresent: result?.secretsPresent === true,
    migrationsCurrent: result?.migrationsCurrent === true,
    capiEnabled: typeof result?.capiEnabled === 'boolean' ? result.capiEnabled : null,
    initialMetaRollout: result?.initialMetaRollout === true,
  }
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
  const { steps, notes, artifacts, sensitiveValues = [] } = await runDevRehearsalVerificationFn(options)
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
