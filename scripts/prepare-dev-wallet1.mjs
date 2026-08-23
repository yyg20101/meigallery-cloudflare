#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path, { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { loadWranglerResourceConfig } from './verify-dev-resources.mjs'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(SCRIPTS_DIR)
const API_WRANGLER_CONFIG = join(ROOT_DIR, 'packages', 'api', 'wrangler.toml')
const MIGRATIONS_DIR = join(ROOT_DIR, 'packages', 'api', 'migrations')

export const WALLET1_DEV_DATABASE = 'meigallery-db-dev'
export const WALLET1_POLICY_ID = 'wlp_app_1_0_wallet_1_dev_1'
export const WALLET1_READINESS_KIND = 'wallet1-dev-migration-readiness'
export const WALLET1_READINESS_SCHEMA_VERSION = 2
export const WALLET1_EXPECTED_PENDING_MIGRATIONS = Object.freeze([
  '0075_app_membership_applications.sql',
  '0076_app_in_app_notifications.sql',
  '0077_app_wallet_ledger.sql',
])

const MANIFEST_MAX_AGE_MS = 30 * 60 * 1000
const DEFAULT_BACKUP_DIR = join(homedir(), '.meigallery', 'dev-backups', 'd1', 'wallet1')

export async function createWallet1DevReadiness(options = {}) {
  requireDevConfirmation(options.confirmDev)

  const backupDir = resolve(options.backupDir || process.env.MEIGALLERY_DEV_BACKUP_DIR || DEFAULT_BACKUP_DIR)
  assertOutsideRepository(backupDir)

  const now = options.now || (() => new Date())
  const createdAtDate = now()
  const createdAt = createdAtDate.toISOString()
  const expiresAt = new Date(createdAtDate.getTime() + MANIFEST_MAX_AGE_MS).toISOString()
  const repository = await (options.getRepositoryState || (() => getRepositoryState(options)))()
  validateRepositoryState(repository)

  const localBoundary = await (options.validateLocalBoundary || (() => validateLocalWallet1Boundary(options)))()
  const expectedPendingMigrations = await (options.listExpectedPendingMigrations || listLocalWallet1PendingMigrations)()
  const pendingMigrations = await (options.listPendingMigrations || (() => listRemotePendingMigrations(options)))()
  assertExpectedPendingMigrations(pendingMigrations, expectedPendingMigrations)

  const timeTravelBookmark = await (options.getBookmark || (() => getRemoteBookmark(options)))()
  validateBookmark(timeTravelBookmark)

  const exportDatabase = options.exportDatabase || (output => exportRemoteDevDatabase(output, options))

  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await chmod(backupDir, 0o700)
  const physicalBackupDir = await realpath(backupDir)
  assertOutsideRepository(physicalBackupDir)

  const timestamp = createdAt.replaceAll(':', '-').replaceAll('.', '-')
  const basename = `meigallery-db-dev-before-wallet1-${timestamp}-${repository.commit.slice(0, 12)}`
  const sqlPath = join(physicalBackupDir, `${basename}.sql`)
  const manifestPath = join(physicalBackupDir, `${basename}.manifest.json`)
  const temporarySqlPath = join(physicalBackupDir, `.${basename}.${randomUUID()}.partial`)

  try {
    await exportDatabase(temporarySqlPath)
    const sql = await readFile(temporarySqlPath)
    validatePreMigrationBackupSql(sql)
    const sha256 = createHash('sha256').update(sql).digest('hex')

    const manifest = {
      schemaVersion: WALLET1_READINESS_SCHEMA_VERSION,
      kind: WALLET1_READINESS_KIND,
      purpose: 'wallet1-dev-before-migrations-0075-onward',
      environment: 'dev',
      database: WALLET1_DEV_DATABASE,
      databaseId: localBoundary.databaseId,
      createdAt,
      expiresAt,
      git: {
        branch: repository.branch,
        commit: repository.commit,
      },
      pendingMigrations,
      timeTravelBookmark,
      backup: {
        sqlFile: path.basename(sqlPath),
        byteLength: sql.byteLength,
        sha256,
      },
      verifiedBoundary: {
        walletUserRuntimeEnabled: false,
        walletAdminRuntimeEnabled: false,
        walletProductionReady: false,
        walletPolicyId: WALLET1_POLICY_ID,
        immutableLedgerCleanup: 'time_travel_or_disposable_database_only',
      },
    }

    await rename(temporarySqlPath, sqlPath)
    await chmod(sqlPath, 0o600)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await chmod(manifestPath, 0o600)

    return {
      status: 'passed',
      manifestPath,
      sqlPath,
      sha256,
      byteLength: sql.byteLength,
      pendingMigrations,
      timeTravelBookmark,
    }
  }
  catch (error) {
    await Promise.all([
      rm(temporarySqlPath, { force: true }),
      rm(sqlPath, { force: true }),
      rm(manifestPath, { force: true }),
    ])
    throw error
  }
}

export async function validateWallet1DevReadinessManifest(manifestPath, options = {}) {
  requireDevConfirmation(options.confirmDev)
  if (!manifestPath) throw new Error('WALLET1_READINESS_MANIFEST_REQUIRED')

  const resolvedManifestPath = resolve(manifestPath)
  assertOutsideRepository(resolvedManifestPath)
  if ((await lstat(resolvedManifestPath)).isSymbolicLink()) {
    throw new Error('WALLET1_READINESS_MANIFEST_SYMLINK_FORBIDDEN')
  }
  const physicalManifestPath = await realpath(resolvedManifestPath)
  assertOutsideRepository(physicalManifestPath)

  const manifest = JSON.parse(await readFile(physicalManifestPath, 'utf8'))
  const expectedPendingMigrations = await (options.listExpectedPendingMigrations || listLocalWallet1PendingMigrations)()
  validateManifestShape(manifest, expectedPendingMigrations)

  const now = options.now || (() => new Date())
  const nowMs = now().getTime()
  const createdAtMs = Date.parse(manifest.createdAt)
  const expiresAtMs = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || nowMs < createdAtMs || nowMs > expiresAtMs) {
    throw new Error('WALLET1_READINESS_MANIFEST_EXPIRED')
  }
  if (expiresAtMs - createdAtMs !== MANIFEST_MAX_AGE_MS) {
    throw new Error('WALLET1_READINESS_MANIFEST_WINDOW_INVALID')
  }

  const repository = await (options.getRepositoryState || (() => getRepositoryState(options)))()
  validateRepositoryState(repository)
  if (manifest.git.branch !== repository.branch || manifest.git.commit !== repository.commit) {
    throw new Error('WALLET1_READINESS_GIT_MISMATCH')
  }

  const localBoundary = await (options.validateLocalBoundary || (() => validateLocalWallet1Boundary(options)))()
  if (manifest.databaseId !== localBoundary.databaseId) {
    throw new Error('WALLET1_READINESS_DATABASE_ID_MISMATCH')
  }

  const pendingMigrations = await (options.listPendingMigrations || (() => listRemotePendingMigrations(options)))()
  assertExpectedPendingMigrations(pendingMigrations, expectedPendingMigrations)
  if (!sameArray(manifest.pendingMigrations, pendingMigrations)) {
    throw new Error('WALLET1_READINESS_PENDING_MIGRATIONS_CHANGED')
  }

  const currentBookmark = await (options.getBookmark || (() => getRemoteBookmark(options)))()
  validateBookmark(currentBookmark)
  if (manifest.timeTravelBookmark !== currentBookmark) {
    throw new Error('WALLET1_READINESS_BOOKMARK_CHANGED')
  }

  const sqlPath = resolve(dirname(physicalManifestPath), manifest.backup.sqlFile)
  assertOutsideRepository(sqlPath)
  if ((await lstat(sqlPath)).isSymbolicLink()) {
    throw new Error('WALLET1_READINESS_BACKUP_SYMLINK_FORBIDDEN')
  }
  const physicalSqlPath = await realpath(sqlPath)
  assertOutsideRepository(physicalSqlPath)
  const fileStat = await stat(physicalSqlPath)
  const sql = await readFile(physicalSqlPath)
  validatePreMigrationBackupSql(sql)
  const sha256 = createHash('sha256').update(sql).digest('hex')
  if (fileStat.size !== manifest.backup.byteLength || sha256 !== manifest.backup.sha256) {
    throw new Error('WALLET1_READINESS_BACKUP_MISMATCH')
  }

  return {
    status: 'passed',
    manifestPath: physicalManifestPath,
    sqlPath: physicalSqlPath,
    gitCommit: repository.commit,
    pendingMigrations,
    timeTravelBookmark: currentBookmark,
  }
}

export function parsePendingMigrations(output) {
  const matches = String(output).match(/\b\d{4}_[A-Za-z0-9_]+\.sql\b/gu) || []
  return [...new Set(matches)]
}

export function assertExpectedPendingMigrations(migrations, expectedMigrations = WALLET1_EXPECTED_PENDING_MIGRATIONS) {
  const hasWalletPrefix = WALLET1_EXPECTED_PENDING_MIGRATIONS.every(
    (migration, index) => migrations?.[index] === migration,
  )
  if (!hasWalletPrefix || !sameArray(migrations, expectedMigrations)) {
    throw new Error('WALLET1_READINESS_PENDING_MIGRATIONS_UNEXPECTED')
  }
}

export function validatePreMigrationBackupSql(sql) {
  const text = Buffer.isBuffer(sql) ? sql.toString('utf8') : String(sql)
  if (Buffer.byteLength(text) < 32 || !/\bCREATE\s+TABLE\b/iu.test(text)) {
    throw new Error('WALLET1_READINESS_BACKUP_SQL_INVALID')
  }
  if (/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?app_wallets\b/iu.test(text)) {
    throw new Error('WALLET1_READINESS_BACKUP_ALREADY_HAS_WALLET_SCHEMA')
  }
  return true
}

export function validateWalletRuntimeFlags(wranglerSource) {
  const expected = {
    APP_WALLET_ENABLED: 'false',
    APP_WALLET_ADMIN_ENABLED: 'false',
    APP_WALLET_POLICY_VERSION: WALLET1_POLICY_ID,
    APP_WALLET_PRODUCTION_READY: 'false',
  }
  for (const header of ['[vars]', '[env.dev.vars]']) {
    const section = extractTomlSection(wranglerSource, header)
    for (const [key, value] of Object.entries(expected)) {
      if (extractTomlString(section, key) !== value) {
        throw new Error('WALLET1_READINESS_RUNTIME_FLAGS_NOT_CLOSED')
      }
    }
  }
  return true
}

export function validateWalletMigrationSources(sources) {
  if (!/CREATE\s+TABLE\s+app_membership_applications\b/iu.test(sources.membershipApplications)) {
    throw new Error('WALLET1_READINESS_0075_INVALID')
  }
  if (!/CREATE\s+TABLE\s+app_notification_event_definitions\b/iu.test(sources.notifications)) {
    throw new Error('WALLET1_READINESS_0076_INVALID')
  }
  for (const expected of [
    'CREATE TABLE app_wallet_policies',
    'CREATE TABLE app_wallets',
    'CREATE TABLE app_wallet_adjustments',
    'CREATE TABLE app_wallet_entries',
    'CREATE TABLE app_wallet_adjustment_events',
    'CREATE TABLE app_wallet_review_requests',
    'trg_app_wallet_entries_immutable_update',
    'trg_app_wallet_entries_immutable_delete',
    'trg_app_wallet_balance_requires_entry',
    'trg_app_wallet_adjustment_events_immutable_update',
    'trg_app_wallet_adjustment_events_immutable_delete',
    'trg_app_wallet_review_requests_immutable_update',
    'trg_app_wallet_review_requests_immutable_delete',
    'trg_app_wallet_entry_notification_outbox',
  ]) {
    if (!sources.wallet.includes(expected)) throw new Error('WALLET1_READINESS_0077_INVALID')
  }
  if (!sources.wallet.includes("'wlp_app_1_0_wallet_1_dev_1'") || !sources.wallet.includes("'unresolved'")) {
    throw new Error('WALLET1_READINESS_0077_POLICY_INVALID')
  }
  if (/INSERT\s+INTO\s+(?:app_wallets|app_wallet_adjustments|app_wallet_entries|app_wallet_adjustment_events|app_wallet_review_requests)\b/iu.test(sources.wallet)) {
    throw new Error('WALLET1_READINESS_0077_BUSINESS_SEED_FORBIDDEN')
  }
  return true
}

export async function main(options = {}) {
  const stdout = options.stdout || process.stdout
  const argv = options.argv || process.argv.slice(2)
  const confirmDev = readArgument(argv, '--confirm-dev')
  const manifestPath = readArgument(argv, '--validate-manifest')

  try {
    if (manifestPath) {
      const result = await validateWallet1DevReadinessManifest(manifestPath, { ...options, confirmDev })
      stdout.write(`WALLET1_DEV_READINESS_VALID manifest=${result.manifestPath} commit=${result.gitCommit}\n`)
    }
    else {
      const result = await createWallet1DevReadiness({ ...options, confirmDev })
      stdout.write(`WALLET1_DEV_READINESS_PREPARED manifest=${result.manifestPath} sha256=${result.sha256} bytes=${result.byteLength}\n`)
    }
    return 0
  }
  catch (error) {
    stdout.write(`WALLET1_DEV_READINESS_FAILED code=${safeErrorCode(error)}\n`)
    return 1
  }
}

async function validateLocalWallet1Boundary(options = {}) {
  const [wranglerSource, sources, resources] = await Promise.all([
    readFile(API_WRANGLER_CONFIG, 'utf8'),
    readMigrationSources(),
    loadWranglerResourceConfig({ wranglerPath: API_WRANGLER_CONFIG }),
  ])
  validateWalletRuntimeFlags(wranglerSource)
  validateWalletMigrationSources(sources)
  if (resources.dev.d1.databaseName !== WALLET1_DEV_DATABASE) {
    throw new Error('WALLET1_READINESS_DEV_DATABASE_INVALID')
  }
  if (resources.dev.d1.databaseId === resources.production.d1.databaseId) {
    throw new Error('WALLET1_READINESS_DATABASE_NOT_ISOLATED')
  }
  return { databaseId: resources.dev.d1.databaseId }
}

async function readMigrationSources() {
  const [membershipApplications, notifications, wallet] = await Promise.all([
    readFile(join(MIGRATIONS_DIR, WALLET1_EXPECTED_PENDING_MIGRATIONS[0]), 'utf8'),
    readFile(join(MIGRATIONS_DIR, WALLET1_EXPECTED_PENDING_MIGRATIONS[1]), 'utf8'),
    readFile(join(MIGRATIONS_DIR, WALLET1_EXPECTED_PENDING_MIGRATIONS[2]), 'utf8'),
  ])
  return { membershipApplications, notifications, wallet }
}

async function listLocalWallet1PendingMigrations() {
  const migrations = (await readdir(MIGRATIONS_DIR))
    .filter(name => /^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name))
    .sort()
  const walletBoundary = migrations.indexOf(WALLET1_EXPECTED_PENDING_MIGRATIONS[0])
  if (walletBoundary < 0) throw new Error('WALLET1_READINESS_0075_MISSING')
  const expected = migrations.slice(walletBoundary)
  assertExpectedPendingMigrations(expected, expected)
  return expected
}

async function getRepositoryState(options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  const [commitStep, branchStep, statusStep] = await Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, name: 'wallet1-readiness-git-commit' }),
    runCommand('git', ['branch', '--show-current'], { cwd: ROOT_DIR, name: 'wallet1-readiness-git-branch' }),
    runCommand('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT_DIR, name: 'wallet1-readiness-git-status' }),
  ])
  ensurePassed(commitStep, 'WALLET1_READINESS_GIT_COMMIT_FAILED')
  ensurePassed(branchStep, 'WALLET1_READINESS_GIT_BRANCH_FAILED')
  ensurePassed(statusStep, 'WALLET1_READINESS_GIT_STATUS_FAILED')
  return {
    commit: commitStep.stdout.trim(),
    branch: branchStep.stdout.trim(),
    trackedStatus: statusStep.stdout.trim(),
  }
}

function validateRepositoryState(repository) {
  if (!/^[0-9a-f]{40}$/u.test(repository.commit)) throw new Error('WALLET1_READINESS_GIT_COMMIT_INVALID')
  if (repository.branch !== 'dev') throw new Error('WALLET1_READINESS_BRANCH_NOT_DEV')
  if (repository.trackedStatus) throw new Error('WALLET1_READINESS_TRACKED_WORKTREE_DIRTY')
}

async function listRemotePendingMigrations(options = {}) {
  const step = await runWrangler([
    'd1', 'migrations', 'list', WALLET1_DEV_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', 'dev',
    '--remote',
  ], 'wallet1-readiness-list-migrations', options)
  ensurePassed(step, 'WALLET1_READINESS_MIGRATION_LIST_FAILED')
  return parsePendingMigrations(`${step.stdout}\n${step.stderr}`)
}

async function getRemoteBookmark(options = {}) {
  const step = await runWrangler([
    'd1', 'time-travel', 'info', WALLET1_DEV_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', 'dev',
    '--json',
  ], 'wallet1-readiness-bookmark', options)
  ensurePassed(step, 'WALLET1_READINESS_BOOKMARK_FAILED')
  const parsed = JSON.parse(step.stdout)
  const bookmark = parsed.bookmark || parsed.result?.bookmark
  validateBookmark(bookmark)
  return bookmark
}

async function exportRemoteDevDatabase(output, options = {}) {
  const step = await runWrangler([
    'd1', 'export', WALLET1_DEV_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', 'dev',
    '--remote',
    '--skip-confirmation',
    '--output', output,
  ], 'wallet1-readiness-export', options)
  ensurePassed(step, 'WALLET1_READINESS_EXPORT_FAILED')
}

async function runWrangler(args, name, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  return runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args], {
    cwd: ROOT_DIR,
    name,
  })
}

async function defaultRunCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    })
    return { status: 'passed', stdout: result.stdout, stderr: result.stderr }
  }
  catch (error) {
    return {
      status: 'failed',
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    }
  }
}

function validateManifestShape(manifest, expectedPendingMigrations) {
  if (manifest?.schemaVersion !== WALLET1_READINESS_SCHEMA_VERSION || manifest?.kind !== WALLET1_READINESS_KIND) {
    throw new Error('WALLET1_READINESS_MANIFEST_INVALID')
  }
  if (manifest.environment !== 'dev' || manifest.database !== WALLET1_DEV_DATABASE) {
    throw new Error('WALLET1_READINESS_MANIFEST_TARGET_INVALID')
  }
  try {
    assertExpectedPendingMigrations(manifest.pendingMigrations, expectedPendingMigrations)
  }
  catch {
    throw new Error('WALLET1_READINESS_MANIFEST_MIGRATIONS_INVALID')
  }
  if (manifest.verifiedBoundary?.walletUserRuntimeEnabled !== false
    || manifest.verifiedBoundary?.walletAdminRuntimeEnabled !== false
    || manifest.verifiedBoundary?.walletProductionReady !== false
    || manifest.verifiedBoundary?.walletPolicyId !== WALLET1_POLICY_ID
    || manifest.verifiedBoundary?.immutableLedgerCleanup !== 'time_travel_or_disposable_database_only') {
    throw new Error('WALLET1_READINESS_MANIFEST_BOUNDARY_INVALID')
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.backup?.sha256 || '')
    || !Number.isSafeInteger(manifest.backup?.byteLength)
    || manifest.backup.byteLength <= 0
    || path.basename(manifest.backup?.sqlFile || '') !== manifest.backup?.sqlFile) {
    throw new Error('WALLET1_READINESS_MANIFEST_BACKUP_INVALID')
  }
  validateBookmark(manifest.timeTravelBookmark)
}

function validateBookmark(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{16,160}$/u.test(value)) {
    throw new Error('WALLET1_READINESS_BOOKMARK_INVALID')
  }
}

function requireDevConfirmation(value) {
  if (value !== WALLET1_DEV_DATABASE) throw new Error('WALLET1_READINESS_DEV_CONFIRMATION_REQUIRED')
}

function assertOutsideRepository(candidate) {
  const relative = path.relative(resolve(ROOT_DIR), resolve(candidate))
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('WALLET1_READINESS_PATH_INSIDE_REPOSITORY')
  }
}

function extractTomlSection(source, header) {
  const lines = String(source).split(/\r?\n/u)
  const start = lines.findIndex(line => line.trim() === header)
  if (start < 0) throw new Error('WALLET1_READINESS_WRANGLER_SECTION_MISSING')
  const section = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('[')) break
    section.push(lines[index])
  }
  return section.join('\n')
}

function extractTomlString(section, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return section.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, 'mu'))?.[1]
}

function readArgument(argv, name) {
  const prefix = `${name}=`
  return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function ensurePassed(step, code) {
  if (step?.status !== 'passed') throw new Error(code)
}

function safeErrorCode(error) {
  const code = error instanceof Error ? error.message : String(error)
  return /^[A-Z0-9_]{3,128}$/u.test(code) ? code : 'WALLET1_READINESS_UNKNOWN_ERROR'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
