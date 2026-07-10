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
  assert.notEqual(config.production.queue.producerName, config.dev.queue.producerName, '开发主 Queue 不得与生产相同')
  assert.notEqual(config.production.queue.deadLetterQueueName, config.dev.queue.deadLetterQueueName, '开发 DLQ 不得与生产相同')
  assert.equal(config.production.queue.producerName, 'meigallery-meta-capi', '生产 Queue 名称必须保持 meigallery-meta-capi')
  assert.equal(config.production.queue.mainConsumerName, config.production.queue.producerName, '生产 Queue producer/consumer 必须一致')
  assert.equal(config.production.queue.deadLetterQueueName, 'meigallery-meta-capi-dlq', '生产 DLQ 名称必须保持 meigallery-meta-capi-dlq')
  assert.equal(config.production.queue.dlqConsumerName, config.production.queue.deadLetterQueueName, '生产 DLQ 必须配置 consumer')
  assert.equal(config.dev.queue.producerName, 'meigallery-meta-capi-dev', '开发 Queue 名称必须为 meigallery-meta-capi-dev')
  assert.equal(config.dev.queue.mainConsumerName, config.dev.queue.producerName, '开发 Queue producer/consumer 必须一致')
  assert.equal(config.dev.queue.deadLetterQueueName, 'meigallery-meta-capi-dev-dlq', '开发 DLQ 名称必须为 meigallery-meta-capi-dev-dlq')
  assert.equal(config.dev.queue.dlqConsumerName, config.dev.queue.deadLetterQueueName, '开发 DLQ 必须配置 consumer')
  assert.equal(config.production.queue.maxRetries, 5, '生产 Queue max_retries 必须为 5')
  assert.equal(config.production.queue.retryDelay, 60, '生产 Queue retry_delay 必须为 60')
  assert.equal(config.dev.queue.maxRetries, 5, '开发 Queue max_retries 必须为 5')
  assert.equal(config.dev.queue.retryDelay, 60, '开发 Queue retry_delay 必须为 60')

  return config
}

export async function loadWranglerResourceConfig(options = {}) {
  const wranglerPath = options.wranglerPath || DEFAULT_WRANGLER_PATH
  const source = await readFile(wranglerPath, 'utf8')

  return {
    production: {
      d1: extractNamedFields(source, '[[d1_databases]]', ['database_name', 'database_id']),
      r2: extractNamedFields(source, '[[r2_buckets]]', ['bucket_name']),
      queue: extractQueueConfig(source, ''),
    },
    dev: {
      d1: extractNamedFields(source, '[[env.dev.d1_databases]]', ['database_name', 'database_id']),
      r2: extractNamedFields(source, '[[env.dev.r2_buckets]]', ['bucket_name']),
      queue: extractQueueConfig(source, 'env.dev.'),
    },
  }
}

function extractQueueConfig(source, prefix) {
  const producerHeader = `[[${prefix}queues.producers]]`
  const consumerHeader = `[[${prefix}queues.consumers]]`
  const producerName = extractQuotedField(extractSection(source, producerHeader), 'queue', producerHeader)
  const consumerSections = extractSections(source, consumerHeader)
  const consumers = consumerSections.map(section => ({
    queueName: extractQuotedField(section, 'queue', consumerHeader),
    deadLetterQueueName: extractOptionalQuotedField(section, 'dead_letter_queue'),
    maxRetries: extractOptionalIntegerField(section, 'max_retries'),
    retryDelay: extractOptionalIntegerField(section, 'retry_delay'),
  }))
  const mainConsumer = consumers.find(consumer => consumer.queueName === producerName)
  if (!mainConsumer) throw new Error(`未找到 ${producerHeader} 对应的主 Queue consumer`)
  if (!mainConsumer.deadLetterQueueName) throw new Error(`在 ${consumerHeader} 中未找到字段 dead_letter_queue`)
  const dlqConsumer = consumers.find(consumer => consumer.queueName === mainConsumer.deadLetterQueueName)
  if (!dlqConsumer) throw new Error(`未找到 ${mainConsumer.deadLetterQueueName} 对应的 DLQ consumer`)
  if (mainConsumer.maxRetries === undefined) throw new Error(`在 ${consumerHeader} 中未找到字段 max_retries`)
  if (mainConsumer.retryDelay === undefined) throw new Error(`在 ${consumerHeader} 中未找到字段 retry_delay`)

  return {
    producerName,
    mainConsumerName: mainConsumer.queueName,
    deadLetterQueueName: mainConsumer.deadLetterQueueName,
    dlqConsumerName: dlqConsumer.queueName,
    maxRetries: mainConsumer.maxRetries,
    retryDelay: mainConsumer.retryDelay,
  }
}

function extractNamedFields(source, sectionHeader, fieldNames) {
  const section = extractSection(source, sectionHeader)
  const values = Object.fromEntries(fieldNames.map(fieldName => [camelCaseFieldName(fieldName), extractQuotedField(section, fieldName, sectionHeader)]))
  return values
}

function extractSection(source, sectionHeader) {
  const sections = extractSections(source, sectionHeader)
  if (sections.length === 0) throw new Error(`未找到配置段：${sectionHeader}`)
  return sections[0]
}

function extractSections(source, sectionHeader) {
  const lines = source.split(/\r?\n/)
  const sections = []
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    if (lines[headerIndex].trim() !== sectionHeader) continue
    const sectionLines = []
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim().startsWith('[')) break
      sectionLines.push(line)
    }
    sections.push(sectionLines.join('\n'))
  }
  return sections
}

function extractQuotedField(sectionSource, fieldName, sectionHeader) {
  const escapedFieldName = escapeRegExp(fieldName)
  const match = sectionSource.match(new RegExp(`^\\s*${escapedFieldName}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))

  if (!match) {
    throw new Error(`在 ${sectionHeader} 中未找到字段 ${fieldName}`)
  }

  return match[1]
}

function extractOptionalQuotedField(sectionSource, fieldName) {
  const escapedFieldName = escapeRegExp(fieldName)
  return sectionSource.match(new RegExp(`^\\s*${escapedFieldName}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))?.[1]
}

function extractOptionalIntegerField(sectionSource, fieldName) {
  const escapedFieldName = escapeRegExp(fieldName)
  const value = sectionSource.match(new RegExp(`^\\s*${escapedFieldName}\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
  return value === undefined ? undefined : Number(value)
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
