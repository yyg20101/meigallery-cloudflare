#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_WRANGLER_PATH = path.resolve(__dirname, '../packages/api/wrangler.toml')

if (isCliEntry()) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function main(options = {}) {
  const config = await loadWranglerResourceConfig(options)

  assert.equal(config.production.d1.databaseName, 'meigallery-db', '生产 D1 名称必须保持 meigallery-db')
  assert.equal(config.dev.d1.databaseName, 'meigallery-db-dev', '开发 D1 名称必须为 meigallery-db-dev')
  assert.equal(config.production.r2.bucketName, 'meigallery-media', '生产 R2 名称必须保持 meigallery-media')
  assert.equal(config.dev.r2.bucketName, 'meigallery-media-dev', '开发 R2 名称必须为 meigallery-media-dev')
  assert.notEqual(config.production.d1.databaseId, config.dev.d1.databaseId, '开发 D1 database_id 不得与生产相同')
  assert.notEqual(config.production.r2.bucketName, config.dev.r2.bucketName, '开发 R2 bucket 不得与生产相同')

  return config
}

export async function loadWranglerResourceConfig(options = {}) {
  const wranglerPath = options.wranglerPath || DEFAULT_WRANGLER_PATH
  const source = await readFile(wranglerPath, 'utf8')

  return {
    production: {
      d1: extractNamedFields(source, '[[d1_databases]]', ['database_name', 'database_id']),
      r2: extractNamedFields(source, '[[r2_buckets]]', ['bucket_name']),
    },
    dev: {
      d1: extractNamedFields(source, '[[env.dev.d1_databases]]', ['database_name', 'database_id']),
      r2: extractNamedFields(source, '[[env.dev.r2_buckets]]', ['bucket_name']),
    },
  }
}

function extractNamedFields(source, sectionHeader, fieldNames) {
  const section = extractSection(source, sectionHeader)
  const values = Object.fromEntries(fieldNames.map(fieldName => [camelCaseFieldName(fieldName), extractQuotedField(section, fieldName, sectionHeader)]))
  return values
}

function extractSection(source, sectionHeader) {
  const lines = source.split(/\r?\n/)
  const headerIndex = lines.findIndex(line => line.trim() === sectionHeader)

  if (headerIndex === -1) {
    throw new Error(`未找到配置段：${sectionHeader}`)
  }

  const sectionLines = []
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().startsWith('[')) {
      break
    }
    sectionLines.push(line)
  }

  return sectionLines.join('\n')
}

function extractQuotedField(sectionSource, fieldName, sectionHeader) {
  const escapedFieldName = escapeRegExp(fieldName)
  const match = sectionSource.match(new RegExp(`^\\s*${escapedFieldName}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))

  if (!match) {
    throw new Error(`在 ${sectionHeader} 中未找到字段 ${fieldName}`)
  }

  return match[1]
}

function camelCaseFieldName(fieldName) {
  return fieldName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
