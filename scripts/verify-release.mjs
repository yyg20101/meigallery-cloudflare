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
import { runLocalRuntimeVerification } from './verify-local-runtime.mjs'

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
  } else if (mode === 'local-runtime') {
    report = await runLocalRuntimeReleaseVerification({ ...options, mode })
  } else {
    throw new Error(`模式 ${mode} 尚未实现`)
  }

  if (report.status !== 'passed') {
    throw new Error(`发布快速验证失败，报告已写入：${report.reportFile}`)
  }

  console.log(`发布快速验证通过，报告已写入：${report.reportFile}`)
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
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    mode,
    status: steps.every(step => step.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    git,
    versions,
    steps,
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

  const report = await readLatestReportFn(options)
  assertReportCanGateProductionFn(report, {
    ...options,
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
  node scripts/verify-release.mjs local-runtime
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
