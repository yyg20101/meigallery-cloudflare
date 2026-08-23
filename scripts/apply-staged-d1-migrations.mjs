#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { loadWranglerResourceConfig } from './verify-dev-resources.mjs'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(SCRIPTS_DIR)
const API_DIR = join(ROOT_DIR, 'packages', 'api')
const API_WRANGLER_CONFIG = join(API_DIR, 'wrangler.toml')
const MIGRATIONS_DIR = join(API_DIR, 'migrations')
const MIGRATION_NAME_PATTERN = /^\d{4}_[A-Za-z0-9_]+\.sql$/u

export async function applyStagedD1Migrations(options = {}) {
  const environment = options.environment
  const through = options.through
  if (environment !== 'dev' && environment !== 'production') {
    throw new Error('STAGED_D1_ENVIRONMENT_INVALID')
  }
  if (!MIGRATION_NAME_PATTERN.test(through || '')) {
    throw new Error('STAGED_D1_CUTOFF_INVALID')
  }

  const target = await resolveTarget(environment, options)
  if (options.confirmDatabase !== target.databaseName) {
    throw new Error('STAGED_D1_DATABASE_CONFIRMATION_REQUIRED')
  }

  const localMigrations = await (options.listLocalMigrations || listLocalMigrations)()
  const pendingBefore = await (options.listPendingMigrations || (() => listRemotePendingMigrations(environment, target.databaseName, options)))()
  const selected = selectMigrationsThrough(localMigrations, pendingBefore, through)

  if (!options.apply || selected.length === 0) {
    return {
      status: options.apply ? 'already_applied' : 'planned',
      environment,
      database: target.databaseName,
      through,
      selected,
      remaining: pendingBefore.slice(selected.length),
    }
  }

  const applySelected = options.applySelectedMigrations || (names => applySelectedMigrations(target, names, options))
  await applySelected(selected)

  const pendingAfter = await (options.listPendingMigrationsAfter
    || options.listPendingMigrations
    || (() => listRemotePendingMigrations(environment, target.databaseName, options)))()
  const expectedRemaining = pendingBefore.slice(selected.length)
  assertSameArray(pendingAfter, expectedRemaining, 'STAGED_D1_POST_APPLY_MISMATCH')

  return {
    status: 'applied',
    environment,
    database: target.databaseName,
    through,
    selected,
    remaining: pendingAfter,
  }
}

export function selectMigrationsThrough(localMigrations, pendingMigrations, through) {
  assertMigrationList(localMigrations, 'STAGED_D1_LOCAL_MIGRATIONS_INVALID')
  assertMigrationList(pendingMigrations, 'STAGED_D1_PENDING_MIGRATIONS_INVALID')
  if (!localMigrations.includes(through)) throw new Error('STAGED_D1_CUTOFF_NOT_FOUND')
  if (pendingMigrations.length === 0) return []

  const firstPendingIndex = localMigrations.indexOf(pendingMigrations[0])
  if (firstPendingIndex < 0) throw new Error('STAGED_D1_PENDING_MIGRATION_UNKNOWN')
  const expectedPending = localMigrations.slice(firstPendingIndex)
  assertSameArray(pendingMigrations, expectedPending, 'STAGED_D1_PENDING_MIGRATIONS_NOT_CONTIGUOUS')

  const cutoffIndex = localMigrations.indexOf(through)
  if (cutoffIndex < firstPendingIndex) return []
  return pendingMigrations.slice(0, cutoffIndex - firstPendingIndex + 1)
}

export function parsePendingMigrations(output) {
  const matches = String(output).match(/\b\d{4}_[A-Za-z0-9_]+\.sql\b/gu) || []
  return [...new Set(matches)]
}

export function buildTemporaryWranglerConfig(target) {
  return [
    'name = "meigallery-d1-migration-stage"',
    'compatibility_date = "2026-05-26"',
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = ${tomlString(target.databaseName)}`,
    `database_id = ${tomlString(target.databaseId)}`,
    'migrations_dir = "migrations"',
    '',
  ].join('\n')
}

async function resolveTarget(environment, options) {
  if (options.target) return options.target
  const resources = await loadWranglerResourceConfig({ wranglerPath: API_WRANGLER_CONFIG })
  return environment === 'dev' ? resources.dev.d1 : resources.production.d1
}

async function listLocalMigrations() {
  return (await readdir(MIGRATIONS_DIR))
    .filter(name => MIGRATION_NAME_PATTERN.test(name))
    .sort()
}

async function listRemotePendingMigrations(environment, databaseName, options = {}) {
  const args = [
    'd1', 'migrations', 'list', databaseName,
    '--config', API_WRANGLER_CONFIG,
  ]
  if (environment === 'dev') args.push('--env', 'dev')
  args.push('--remote')
  const step = await runWrangler(args, options)
  ensurePassed(step, 'STAGED_D1_MIGRATION_LIST_FAILED')
  return parsePendingMigrations(`${step.stdout}\n${step.stderr}`)
}

async function applySelectedMigrations(target, names, options = {}) {
  const stageDir = await mkdtemp(join(tmpdir(), 'meigallery-d1-migrations-'))
  const stageMigrationsDir = join(stageDir, 'migrations')
  const stageConfig = join(stageDir, 'wrangler.toml')
  try {
    await mkdir(stageMigrationsDir, { mode: 0o700 })
    await Promise.all(names.map(name => copyVerifiedMigration(name, stageMigrationsDir)))
    await writeFile(stageConfig, buildTemporaryWranglerConfig(target), { mode: 0o600 })
    const step = await runWrangler([
      'd1', 'migrations', 'apply', target.databaseName,
      '--config', stageConfig,
      '--remote',
    ], options)
    ensurePassed(step, 'STAGED_D1_MIGRATION_APPLY_FAILED')
  }
  finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

async function copyVerifiedMigration(name, destinationDir) {
  if (!MIGRATION_NAME_PATTERN.test(name) || path.basename(name) !== name) {
    throw new Error('STAGED_D1_MIGRATION_NAME_INVALID')
  }
  const sourcePath = join(MIGRATIONS_DIR, name)
  const source = await readFile(sourcePath, 'utf8')
  if (!source.trim()) throw new Error('STAGED_D1_MIGRATION_EMPTY')
  await copyFile(sourcePath, join(destinationDir, name))
}

async function runWrangler(args, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  return runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args], {
    cwd: ROOT_DIR,
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

function assertMigrationList(value, code) {
  if (!Array.isArray(value)
    || value.some(name => !MIGRATION_NAME_PATTERN.test(name))
    || new Set(value).size !== value.length
    || value.some((name, index) => index > 0 && value[index - 1].localeCompare(name) >= 0)) {
    throw new Error(code)
  }
}

function assertSameArray(actual, expected, code) {
  if (actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) {
    throw new Error(code)
  }
}

function ensurePassed(step, code) {
  if (step?.status !== 'passed') throw new Error(code)
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function readArgument(argv, name) {
  const prefix = `${name}=`
  return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

export async function main(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const stdout = options.stdout || process.stdout
  try {
    const result = await applyStagedD1Migrations({
      ...options,
      environment: readArgument(argv, '--environment'),
      confirmDatabase: readArgument(argv, '--confirm-database'),
      through: readArgument(argv, '--through'),
      apply: argv.includes('--apply'),
    })
    stdout.write(`STAGED_D1_${result.status.toUpperCase()} database=${result.database} through=${result.through} selected=${result.selected.join(',') || 'none'} remaining=${result.remaining.length}\n`)
    return 0
  }
  catch (error) {
    stdout.write(`STAGED_D1_FAILED code=${error instanceof Error ? error.message : 'STAGED_D1_UNKNOWN'}\n`)
    return 1
  }
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isCliEntry()) {
  process.exitCode = await main()
}
