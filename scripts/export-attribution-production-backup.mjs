#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path, { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCommand as defaultRunCommand } from './release-verification-lib.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(SCRIPTS_DIR)
const API_WRANGLER_CONFIG = join(ROOT_DIR, 'packages', 'api', 'wrangler.toml')
const PRODUCTION_DATABASE = 'meigallery-db'
const DEFAULT_BACKUP_DIR = join(homedir(), '.meigallery', 'production-backups', 'attribution-v3')

export async function runProductionBackup(options = {}) {
  const backupDir = resolve(options.backupDir || process.env.ATTRIBUTION_BACKUP_DIR || DEFAULT_BACKUP_DIR)
  if (isInside(backupDir, ROOT_DIR)) throw new Error('ATTRIBUTION_BACKUP_DIR_INSIDE_REPOSITORY')

  const now = options.now || (() => new Date())
  const createdAt = now().toISOString()
  const timestamp = createdAt.replaceAll(':', '-')
  const basename = `meigallery-db-attribution-v3-${timestamp}`
  const sqlPath = join(backupDir, `${basename}.sql`)
  const manifestPath = join(backupDir, `${basename}.manifest.json`)
  const temporarySqlPath = join(backupDir, `.${basename}.${randomUUID()}.partial`)
  const exportDatabase = options.exportDatabase || (output => exportProductionDatabase(output, options))
  const getBookmark = options.getBookmark || (() => getProductionBookmark(options))
  const getCommit = options.getCommit || (() => getGitCommit(options))

  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await chmod(backupDir, 0o700)

  try {
    await exportDatabase(temporarySqlPath)
    const sql = await readFile(temporarySqlPath)
    validateBackupSql(sql)
    const [timeTravelBookmark, gitCommit] = await Promise.all([getBookmark(), getCommit()])
    if (!String(timeTravelBookmark).trim()) throw new Error('ATTRIBUTION_BACKUP_BOOKMARK_INVALID')
    if (!/^[0-9a-f]{40}$/.test(String(gitCommit))) throw new Error('ATTRIBUTION_BACKUP_COMMIT_INVALID')

    const sha256 = createHash('sha256').update(sql).digest('hex')
    const manifest = {
      schemaVersion: 1,
      database: PRODUCTION_DATABASE,
      purpose: 'attribution-v3-expand',
      createdAt,
      gitCommit: String(gitCommit),
      timeTravelBookmark: String(timeTravelBookmark),
      sqlFile: path.basename(sqlPath),
      byteLength: sql.byteLength,
      sha256,
    }

    await rename(temporarySqlPath, sqlPath)
    await chmod(sqlPath, 0o600)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await chmod(manifestPath, 0o600)
    return { status: 'passed', sqlPath, manifestPath, sha256, byteLength: sql.byteLength }
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

export function validateBackupSql(sql) {
  const text = Buffer.isBuffer(sql) ? sql.toString('utf8') : String(sql)
  if (Buffer.byteLength(text) < 32 || !/\bCREATE\s+TABLE\b/i.test(text)) {
    throw new Error('ATTRIBUTION_BACKUP_SQL_INVALID')
  }
  return true
}

export async function main(options = {}) {
  const stdout = options.stdout || process.stdout
  try {
    const result = await runProductionBackup(options)
    stdout.write(`ATTRIBUTION_PRODUCTION_BACKUP_PASSED manifest=${result.manifestPath} sha256=${result.sha256} bytes=${result.byteLength}\n`)
    return 0
  }
  catch (error) {
    stdout.write(`ATTRIBUTION_PRODUCTION_BACKUP_FAILED code=${safeErrorCode(error)}\n`)
    return 1
  }
}

async function exportProductionDatabase(output, options = {}) {
  const step = await runWrangler([
    'd1', 'export', PRODUCTION_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', '',
    '--remote',
    '--skip-confirmation',
    '--output', output,
  ], 'attribution-v3-production-backup', options)
  ensurePassed(step, 'ATTRIBUTION_BACKUP_EXPORT_FAILED')
}

async function getProductionBookmark(options = {}) {
  const step = await runWrangler([
    'd1', 'time-travel', 'info', PRODUCTION_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', '',
    '--json',
  ], 'attribution-v3-time-travel-bookmark', options)
  ensurePassed(step, 'ATTRIBUTION_BACKUP_BOOKMARK_FAILED')
  const parsed = JSON.parse(step.stdout)
  const bookmark = parsed.bookmark || parsed.result?.bookmark
  if (typeof bookmark !== 'string' || !bookmark) throw new Error('ATTRIBUTION_BACKUP_BOOKMARK_INVALID')
  return bookmark
}

async function getGitCommit(options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  const step = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT_DIR,
    name: 'attribution-v3-backup-git-commit',
  })
  ensurePassed(step, 'ATTRIBUTION_BACKUP_COMMIT_FAILED')
  return step.stdout.trim()
}

async function runWrangler(args, name, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  return runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args], {
    cwd: ROOT_DIR,
    name,
  })
}

function ensurePassed(step, code) {
  if (step?.status !== 'passed') throw new Error(code)
}

function isInside(candidate, parent) {
  const relative = path.relative(resolve(parent), resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function safeErrorCode(error) {
  const code = error instanceof Error ? error.message : String(error)
  return /^[A-Z0-9_]{3,96}$/.test(code) ? code : 'ATTRIBUTION_BACKUP_UNKNOWN_ERROR'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
