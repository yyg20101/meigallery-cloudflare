#!/usr/bin/env node
/**
 * R2 真实案例对象前缀迁移脚本。
 *
 * 生产顺序：
 * 1. node scripts/migrate-cases-r2.mjs --dry-run --remote
 * 2. node scripts/migrate-cases-r2.mjs --remote
 * 3. 执行 D1 remote migration 0017_cases_cleanup.sql
 * 4. 部署和 smoke 后执行 node scripts/migrate-cases-r2.mjs --remote --delete-old --confirm-delete-old=testimonials-to-cases
 *
 * 如果 D1 migration 已先执行，普通复制模式会从 case_images / external_import_files 的 cases/
 * key 反推旧 testimonials/ key，并补齐目标 R2 对象。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawArgs = process.argv.slice(2)
const args = new Set(rawArgs)
const dryRun = args.has('--dry-run')
const remote = args.has('--remote')
const deleteOld = args.has('--delete-old')
const confirmDeleteOld = args.has('--confirm-delete-old=testimonials-to-cases')
const bucket = process.env.R2_BUCKET || 'meigallery-media'
const database = process.env.D1_DATABASE || 'meigallery-db'

const ALLOWED_ARGS = new Set([
  '--dry-run',
  '--remote',
  '--delete-old',
  '--confirm-delete-old=testimonials-to-cases',
  '--help',
])

const OLD_PREFIX = 'testimonials/'
const NEW_PREFIX = 'cases/'

const TESTIMONIAL_IMAGES_SQL = `
SELECT id, r2_key, mime_type FROM testimonial_case_images
WHERE substr(r2_key, 1, length('testimonials/')) = 'testimonials/'
ORDER BY case_id, sort_order;
`

const EXTERNAL_IMPORT_TESTIMONIALS_SQL = `
SELECT id, r2_key, COALESCE(actual_mime_type, declared_mime_type) AS mime_type FROM external_import_files
WHERE substr(r2_key, 1, length('testimonials/')) = 'testimonials/'
ORDER BY import_id, sort_order;
`

const CASE_IMAGES_SQL = `
SELECT id, r2_key, mime_type FROM case_images
WHERE substr(r2_key, 1, length('cases/')) = 'cases/'
ORDER BY case_id, sort_order;
`

const EXTERNAL_IMPORT_CASES_SQL = `
SELECT id, r2_key, COALESCE(actual_mime_type, declared_mime_type) AS mime_type FROM external_import_files
WHERE substr(r2_key, 1, length('cases/')) = 'cases/'
ORDER BY import_id, sort_order;
`

function showHelp() {
  console.log(`用法: node scripts/migrate-cases-r2.mjs [--dry-run] [--remote] [--delete-old --confirm-delete-old=testimonials-to-cases]

选项:
  --dry-run     只打印将复制和将删除的映射，不修改 R2 或 D1
  --remote      D1 查询和 R2 对象操作使用远程资源；不带则使用本地 D1/R2
  --delete-old  删除旧 testimonials/ 对象；仅在复制、验证、D1 migration、部署和 smoke 后使用
  --confirm-delete-old=testimonials-to-cases
                删除旧对象的二次确认令牌，必须与 --delete-old 一起使用
  --help        输出帮助信息

环境变量:
  R2_BUCKET     R2 bucket 名称，默认 meigallery-media
  D1_DATABASE   D1 database 名称，默认 meigallery-db`)
}

function validateArgs() {
  const unknownArgs = rawArgs.filter((arg) => !ALLOWED_ARGS.has(arg))
  if (unknownArgs.length > 0) {
    console.error(`错误：未知参数 ${unknownArgs.join(', ')}`)
    console.error('请运行 node scripts/migrate-cases-r2.mjs --help 查看允许的参数。')
    process.exit(1)
  }

  if (deleteOld && !remote) {
    console.error('错误：--delete-old 只能用于远程 D1 查询，必须同时带 --remote。')
    process.exit(1)
  }

  if (deleteOld && !confirmDeleteOld) {
    console.error('错误：--delete-old 必须同时带 --confirm-delete-old=testimonials-to-cases。')
    process.exit(1)
  }
}

validateArgs()

if (args.has('--help')) {
  showHelp()
  process.exit(0)
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-9;]*m/g, '')
}

function firstUsefulLine(error) {
  const text = stripAnsi(`${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`)
  return text.split('\n').map(line => line.trim()).find(line => line && line !== '{' && line !== '}') || error.message
}

function isExpectedSqlShapeError(error) {
  const text = stripAnsi(`${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`).toLowerCase()
  return text.includes('no such table:')
}

function runWrangler(wranglerArgs, options = {}) {
  const commandArgs = ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...wranglerArgs]
  const retries = options.retries || 1
  let lastError

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return execFileSync('corepack', commandArgs, {
        encoding: 'utf8',
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      lastError = error
      if (isExpectedSqlShapeError(error)) break
      if (attempt >= retries) break
      console.warn(`Wrangler 命令失败，准备重试 ${attempt + 1}/${retries}：${firstUsefulLine(error)}`)
      wait(attempt * 1500)
    }
  }

  throw lastError
}

function parseD1Rows(output) {
  const trimmed = output.trim()
  if (!trimmed) return []

  const jsonStart = trimmed.search(/[\[{]/)
  if (jsonStart === -1) {
    throw new Error(`无法解析 D1 查询输出：${trimmed}`)
  }

  const data = JSON.parse(trimmed.slice(jsonStart))
  const firstResult = Array.isArray(data) ? data[0] : data
  const result = firstResult?.result

  if (Array.isArray(result?.results)) return result.results
  if (Array.isArray(result)) return result
  if (Array.isArray(firstResult?.results)) return firstResult.results
  if (Array.isArray(data?.results)) return data.results

  return []
}

function isMissingTableError(error) {
  const text = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`
  return text.includes('no such table:')
}

function queryRows(sql, label) {
  const d1Args = ['d1', 'execute', database, '--command', sql, '--json']
  if (remote) d1Args.push('--remote')

  try {
    return parseD1Rows(runWrangler(d1Args, { retries: 2 }))
  } catch (error) {
    if (isMissingTableError(error)) {
      console.log(`提示：${label} 不存在，当前数据库可能已经执行过 0017 迁移。`)
      return []
    }
    throw error
  }
}

function buildMappingsFromRows(rows, direction) {
  return rows.map((row) => {
    const key = String(row.r2_key || '')
    if (direction === 'legacy') {
      return {
        id: row.id,
        oldKey: key,
        newKey: `${NEW_PREFIX}${key.slice(OLD_PREFIX.length)}`,
        mimeType: row.mime_type,
      }
    }

    return {
      id: row.id,
      oldKey: `${OLD_PREFIX}${key.slice(NEW_PREFIX.length)}`,
      newKey: key,
      mimeType: row.mime_type,
    }
  })
}

function dedupeMappings(mappings) {
  const seen = new Map()
  for (const mapping of mappings) {
    if (!seen.has(mapping.oldKey)) {
      seen.set(mapping.oldKey, mapping)
    }
  }
  return [...seen.values()]
}

function loadMappings() {
  const testimonialImageRows = queryRows(TESTIMONIAL_IMAGES_SQL, '旧表 testimonial_case_images')
  const externalImportTestimonialsRows = queryRows(EXTERNAL_IMPORT_TESTIMONIALS_SQL, '表 external_import_files')
  const legacyMappings = dedupeMappings([
    ...buildMappingsFromRows(testimonialImageRows, 'legacy'),
    ...buildMappingsFromRows(externalImportTestimonialsRows, 'legacy'),
  ])

  if (legacyMappings.length > 0 && !deleteOld) return legacyMappings

  if (legacyMappings.length === 0 && !deleteOld) {
    console.log('提示：未从旧 testimonials/ key 找到映射，当前数据库可能已执行 0017 迁移。')
    console.log('将从 cases/ key 反推旧 testimonials/ key，用于补齐目标 R2 对象。')
  } else if (deleteOld) {
    console.log('提示：删除阶段会同时读取旧 testimonials/ key 和新 cases/ key，合并生成待删除映射。')
  }

  const caseImageRows = queryRows(CASE_IMAGES_SQL, '新表 case_images')
  const externalImportCasesRows = queryRows(EXTERNAL_IMPORT_CASES_SQL, '表 external_import_files')
  return dedupeMappings([
    ...legacyMappings,
    ...buildMappingsFromRows(caseImageRows, 'cases'),
    ...buildMappingsFromRows(externalImportCasesRows, 'cases'),
  ])
}

function objectPath(key) {
  return `${bucket}/${key}`
}

function getObject(key, filePath) {
  const locationArgs = remote ? ['--remote'] : []
  runWrangler(['r2', 'object', 'get', objectPath(key), ...locationArgs, '--file', filePath], { retries: 3 })
}

function isR2ObjectMissingError(error) {
  const text = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`.toLowerCase()
  return text.includes('nosuchkey')
    || text.includes('not found')
    || text.includes('object not found')
    || text.includes('specified key does not exist')
    || text.includes('404')
}

function inferContentType(key) {
  const lowerKey = key.toLowerCase()
  if (lowerKey.endsWith('.png')) return 'image/png'
  if (lowerKey.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

function putObject(mapping, filePath) {
  const locationArgs = remote ? ['--remote'] : []
  const contentType = mapping.mimeType || inferContentType(mapping.newKey)
  runWrangler([
    'r2',
    'object',
    'put',
    objectPath(mapping.newKey),
    ...locationArgs,
    '--file',
    filePath,
    '--content-type',
    contentType,
    '--force',
  ], { retries: 3 })
}

function deleteObject(key) {
  const locationArgs = remote ? ['--remote'] : []
  runWrangler(['r2', 'object', 'delete', objectPath(key), ...locationArgs, '--force'], { retries: 3 })
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function printMappings(mappings) {
  console.log(`映射数量：${mappings.length}`)
  for (const mapping of mappings) {
    console.log(`复制：${mapping.oldKey} -> ${mapping.newKey}`)
    console.log(`删除：${mapping.oldKey}`)
  }
}

function copyAndVerify(mappings) {
  const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-cases-r2-'))

  try {
    for (const [index, mapping] of mappings.entries()) {
      const sourceFile = join(tempDir, `${index}-source`)
      const verifyFile = join(tempDir, `${index}-verify`)

      console.log(`[${index + 1}/${mappings.length}] 复制 ${mapping.oldKey} -> ${mapping.newKey}`)
      getObject(mapping.oldKey, sourceFile)
      putObject(mapping, sourceFile)
      getObject(mapping.newKey, verifyFile)

      const oldHash = sha256(sourceFile)
      const newHash = sha256(verifyFile)
      if (oldHash !== newHash) {
        console.error(`复制验证失败：${mapping.oldKey} 与 ${mapping.newKey} 内容 hash 不一致。`)
        console.error(`旧对象 sha256：${oldHash}`)
        console.error(`新对象 sha256：${newHash}`)
        throw new Error(`复制后对象内容不一致：${mapping.oldKey} -> ${mapping.newKey}`)
      }

      console.log(`已验证目标对象：${mapping.newKey}，sha256=${newHash}`)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function deleteOldObjects(mappings) {
  console.log('警告：即将删除旧 testimonials/ R2 对象。')
  console.log('仅应在 R2 复制、目标对象验证、D1 migration、部署和 smoke 测试全部完成后执行。')
  console.log('删除前将先完整验证所有新旧对象内容 hash 一致；任一失败都不会删除任何旧对象。')

  const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-cases-r2-delete-'))
  const deletableMappings = []

  try {
    for (const [index, mapping] of mappings.entries()) {
      const oldFile = join(tempDir, `${index}-old`)
      const newFile = join(tempDir, `${index}-new`)
      console.log(`[${index + 1}/${mappings.length}] 验证对象一致性 ${mapping.oldKey} <-> ${mapping.newKey}`)

      try {
        getObject(mapping.oldKey, oldFile)
      } catch (error) {
        if (!isR2ObjectMissingError(error)) {
          console.error(`验证失败：无法读取旧对象 ${mapping.oldKey}`)
          console.error('已中止删除，未删除任何旧对象。')
          throw error
        }

        try {
          getObject(mapping.newKey, newFile)
        } catch (newError) {
          console.error(`验证失败：旧对象 ${mapping.oldKey} 不存在，且无法读取新对象 ${mapping.newKey}`)
          console.error('已中止删除，未删除任何旧对象。')
          throw newError
        }

        console.log(`跳过：旧对象不存在，可能是迁移后新增对象。${mapping.oldKey}`)
        continue
      }

      try {
        getObject(mapping.newKey, newFile)
      } catch (error) {
        console.error(`验证失败：旧对象存在但无法读取新对象 ${mapping.newKey}`)
        console.error('已中止删除，未删除任何旧对象。')
        throw error
      }

      const oldHash = sha256(oldFile)
      const newHash = sha256(newFile)
      if (oldHash !== newHash) {
        console.error(`验证失败：${mapping.oldKey} 与 ${mapping.newKey} 内容 hash 不一致。`)
        console.error(`旧对象 sha256：${oldHash}`)
        console.error(`新对象 sha256：${newHash}`)
        console.error('已中止删除，未删除任何旧对象。')
        throw new Error(`对象内容不一致：${mapping.oldKey} -> ${mapping.newKey}`)
      }

      console.log(`验证通过：sha256=${newHash}，${mapping.oldKey} 与 ${mapping.newKey} 内容一致`)
      deletableMappings.push(mapping)
    }

    if (deletableMappings.length === 0) {
      console.log('没有旧 testimonials/ 对象需要删除，正常退出。')
      return
    }

    console.log('所有待删除旧对象均已通过 hash 校验，开始删除旧对象。')
    for (const [index, mapping] of deletableMappings.entries()) {
      console.log(`[${index + 1}/${deletableMappings.length}] 删除 ${mapping.oldKey}`)
      deleteObject(mapping.oldKey)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function main() {
  console.log('R2 真实案例对象前缀迁移')
  console.log(`模式：${dryRun ? 'dry-run' : deleteOld ? '删除旧对象' : '复制并验证'}`)
  console.log(`D1：${database}（${remote ? '远程' : '本地'}）`)
  console.log(`R2 bucket：${bucket}`)

  if (deleteOld && !dryRun) {
    console.log('已显式带 --delete-old、--remote 和确认令牌，将执行旧对象删除。')
  }

  const mappings = loadMappings()

  if (mappings.length === 0) {
    console.log('没有找到需要迁移的 R2 对象映射，正常退出。')
    return
  }

  if (dryRun) {
    printMappings(mappings)
    return
  }

  if (deleteOld) {
    deleteOldObjects(mappings)
    return
  }

  copyAndVerify(mappings)
  console.log('复制和目标对象验证完成。请确认后再执行 D1 migration；脚本不会自动执行 D1 migration。')
}

try {
  main()
} catch (error) {
  console.error('脚本失败：', error.message)
  process.exit(1)
}
