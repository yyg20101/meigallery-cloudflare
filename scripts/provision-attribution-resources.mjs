#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const WRANGLER_CONFIG_URL = new URL(
  '../packages/attribution/wrangler.toml',
  import.meta.url,
)

const REQUIRED_RESOURCES = Object.freeze({
  d1: Object.freeze([
    'meigallery-attribution-db',
    'meigallery-attribution-db-dev',
  ]),
  queues: Object.freeze([
    'meigallery-attribution-meta',
    'meigallery-attribution-meta-dlq',
    'meigallery-attribution-tiktok',
    'meigallery-attribution-tiktok-dlq',
    'meigallery-attribution-google',
    'meigallery-attribution-google-dlq',
  ]),
})

export function buildResourcePlan() {
  return {
    d1: REQUIRED_RESOURCES.d1.map((name) => ({ name })),
    queues: REQUIRED_RESOURCES.queues.map((name) => ({ name })),
  }
}

export function parseD1List(output) {
  const jsonStart = output.indexOf('[')
  const jsonEnd = output.lastIndexOf(']')
  if (jsonStart === -1 || jsonEnd < jsonStart) {
    throw new Error('ATTRIBUTION_D1_LIST_INVALID')
  }

  let parsed
  try {
    parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1))
  } catch {
    throw new Error('ATTRIBUTION_D1_LIST_INVALID')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('ATTRIBUTION_D1_LIST_INVALID')
  }

  return parsed.flatMap((database) => {
    const name = normalizeResourceValue(database?.name)
    const id = normalizeResourceValue(database?.uuid ?? database?.id)
    return name && id ? [{ name, id }] : []
  })
}

export function parseQueueList(output) {
  const rows = stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => line.includes('│'))
    .map((line) => line.split('│').slice(1, -1).map((value) => value.trim()))
    .filter((columns) => columns.length > 0)

  const headerIndex = rows.findIndex(
    (columns) => columns.includes('id') && columns.includes('name'),
  )
  if (headerIndex === -1) {
    if (/no queues/i.test(output)) {
      return []
    }
    throw new Error('ATTRIBUTION_QUEUE_LIST_INVALID')
  }

  const header = rows[headerIndex]
  const idIndex = header.indexOf('id')
  const nameIndex = header.indexOf('name')

  return rows.slice(headerIndex + 1).flatMap((columns) => {
    const name = normalizeResourceValue(columns[nameIndex])
    const id = normalizeResourceValue(columns[idIndex])
    return name && id ? [{ name, id }] : []
  })
}

export function updateAttributionDatabaseIds(source, databaseIds) {
  let updated = source

  for (const name of REQUIRED_RESOURCES.d1) {
    const id = normalizeResourceValue(databaseIds.get(name))
    if (!id) {
      throw new Error(`ATTRIBUTION_D1_ID_INVALID:${name}`)
    }

    const pattern = buildDatabaseIdPattern(name)
    const matches = [...updated.matchAll(pattern)]
    if (matches.length === 0) {
      throw new Error(`ATTRIBUTION_D1_CONFIG_NOT_FOUND:${name}`)
    }
    if (matches.length > 1) {
      throw new Error(`ATTRIBUTION_D1_CONFIG_DUPLICATED:${name}`)
    }

    updated = updated.replace(
      pattern,
      (_match, prefix, _currentId, suffix) => `${prefix}${id}${suffix}`,
    )
  }

  for (const name of REQUIRED_RESOURCES.d1) {
    const expected = databaseIds.get(name)
    const match = [...updated.matchAll(buildDatabaseIdPattern(name))]
    if (match.length !== 1 || match[0][2] !== expected) {
      throw new Error(`ATTRIBUTION_D1_CONFIG_VERIFY_FAILED:${name}`)
    }
  }

  return updated
}

export async function provisionAttributionResources({
  apply,
  runWrangler = runProjectWrangler,
  readConfig = () => readFile(WRANGLER_CONFIG_URL, 'utf8'),
  writeConfig = writeWranglerConfig,
  log = console.log,
} = {}) {
  if (typeof apply !== 'boolean') {
    throw new Error('ATTRIBUTION_RESOURCE_MODE_REQUIRED')
  }

  const plan = buildResourcePlan()
  log(`资源计划：${plan.d1.length} D1 / ${plan.queues.length} Queues`)

  let databases = await listD1(runWrangler)
  let queues = await listQueues(runWrangler)
  const databaseByName = indexByName(databases)
  const queueByName = indexByName(queues)

  printPlan({
    resources: plan.d1,
    existing: databaseByName,
    type: 'D1',
    apply,
    log,
  })
  printPlan({
    resources: plan.queues,
    existing: queueByName,
    type: 'Queue',
    apply,
    log,
  })

  if (!apply) {
    log('dry-run 完成：未创建远端资源，未修改 wrangler.toml')
    return { applied: false, d1: databases, queues }
  }

  for (const { name } of plan.d1) {
    if (!databaseByName.has(name)) {
      await runWrangler(['d1', 'create', name])
    }
  }
  for (const { name } of plan.queues) {
    if (!queueByName.has(name)) {
      await runWrangler(['queues', 'create', name])
    }
  }

  databases = await listD1(runWrangler)
  queues = await listQueues(runWrangler)
  const verifiedDatabases = requireResources(
    plan.d1,
    indexByName(databases),
    'ATTRIBUTION_D1_CREATE_VERIFY_FAILED',
  )
  const verifiedQueues = requireResources(
    plan.queues,
    indexByName(queues),
    'ATTRIBUTION_QUEUE_CREATE_VERIFY_FAILED',
  )

  const source = await readConfig()
  const updated = updateAttributionDatabaseIds(
    source,
    new Map(verifiedDatabases.map(({ name, id }) => [name, id])),
  )
  await writeConfig(updated)

  for (const resource of verifiedDatabases) {
    log(`D1 ${resource.name}: ready (${resource.id})`)
  }
  for (const resource of verifiedQueues) {
    log(`Queue ${resource.name}: ready (${resource.id})`)
  }
  log('apply 完成：独立归因资源已核验，D1 ID 已写入 wrangler.toml')

  return {
    applied: true,
    d1: verifiedDatabases,
    queues: verifiedQueues,
  }
}

async function listD1(runWrangler) {
  return parseD1List(await runWrangler(['d1', 'list', '--json']))
}

async function listQueues(runWrangler) {
  return parseQueueList(await runWrangler(['queues', 'list']))
}

async function runProjectWrangler(args) {
  try {
    const { stdout } = await execFileAsync(
      'corepack',
      [
        'pnpm',
        '--filter',
        '@meigallery/attribution',
        'exec',
        'wrangler',
        ...args,
      ],
      {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    return stdout
  } catch (error) {
    const message = stripAnsi(error?.stderr || error?.message || '')
      .trim()
      .slice(0, 2_000)
    throw new Error(
      `ATTRIBUTION_WRANGLER_FAILED:${args.slice(0, 2).join(' ')}${
        message ? `\n${message}` : ''
      }`,
    )
  }
}

async function writeWranglerConfig(source) {
  const configPath = fileURLToPath(WRANGLER_CONFIG_URL)
  const temporaryPath = `${configPath}.attribution-resource-tmp`
  await writeFile(temporaryPath, source, 'utf8')
  await rename(temporaryPath, configPath)
}

function printPlan({ resources, existing, type, apply, log }) {
  for (const { name } of resources) {
    const current = existing.get(name)
    const status = current
      ? `reused (${current.id})`
      : apply
        ? 'create'
        : 'would-create'
    log(`${type} ${name}: ${status}`)
  }
}

function requireResources(resources, existing, errorCode) {
  return resources.map(({ name }) => {
    const resource = existing.get(name)
    if (!resource) {
      throw new Error(`${errorCode}:${name}`)
    }
    return resource
  })
}

function indexByName(resources) {
  return new Map(resources.map((resource) => [resource.name, resource]))
}

function buildDatabaseIdPattern(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(^[ \\t]*database_name[ \\t]*=[ \\t]*"${escapedName}"[ \\t]*\\r?\\n[ \\t]*database_id[ \\t]*=[ \\t]*")([^"\\r\\n]+)("[ \\t]*$)`,
    'gm',
  )
}

function normalizeResourceValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function stripAnsi(value) {
  return String(value).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

function parseMode(args) {
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const unknown = args.filter(
    (argument) => argument !== '--dry-run' && argument !== '--apply',
  )
  if (unknown.length > 0 || dryRun === apply) {
    throw new Error(
      '用法：node scripts/provision-attribution-resources.mjs --dry-run|--apply',
    )
  }
  return { apply }
}

async function main() {
  const { apply } = parseMode(process.argv.slice(2))
  await provisionAttributionResources({ apply })
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
