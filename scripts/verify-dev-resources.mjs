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
  assertQueueConfig(config.production.queues.meta, 'meigallery-ad-meta', 'meigallery-ad-meta-dlq', 'Meta')
  assertQueueConfig(config.production.queues.tiktok, 'meigallery-ad-tiktok', 'meigallery-ad-tiktok-dlq', 'TikTok')
  assertQueueConfig(config.production.queues.google, 'meigallery-ad-google', 'meigallery-ad-google-dlq', 'Google')
  assertBusinessQueueConfig(config.production.queues.importZip, 'meigallery-import-zip', 3, 15, 'ZIP 导入 production')
  assertBusinessQueueConfig(config.production.queues.dataRightsExport, 'meigallery-app-data-rights-export', 5, 15, '数据导出 production')
  assertBusinessQueueConfig(config.production.queues.dataRightsDeletion, 'meigallery-app-data-rights-deletion', 5, 15, '数据删除 production')
  assertBusinessQueueConfig(config.production.queues.telegramImport, 'meigallery-import-telegram', 5, 60, 'Telegram 导入 production')
  assertBusinessQueueConfig(config.dev.queues.importZip, 'meigallery-import-zip-dev', 3, 15, 'ZIP 导入 dev')
  assertBusinessQueueConfig(config.dev.queues.dataRightsExport, 'meigallery-app-data-rights-export-dev', 5, 15, '数据导出 dev')
  assertBusinessQueueConfig(config.dev.queues.dataRightsDeletion, 'meigallery-app-data-rights-deletion-dev', 5, 15, '数据删除 dev')
  assertBusinessQueueConfig(config.dev.queues.telegramImport, 'meigallery-import-telegram-dev', 5, 60, 'Telegram 导入 dev')
  assert.equal(config.production.realtimeHub.bindingName, 'APP_REALTIME_HUB', 'production 实时 Durable Object binding 不正确')
  assert.equal(config.dev.realtimeHub.bindingName, 'APP_REALTIME_HUB', 'dev 实时 Durable Object binding 不正确')
  assert.equal(config.production.realtimeHub.className, 'AppRealtimeHub', 'production 实时 Durable Object class 不正确')
  assert.equal(config.dev.realtimeHub.className, 'AppRealtimeHub', 'dev 实时 Durable Object class 不正确')
  assert.deepEqual(config.realtimeExport, { type: 'durable-object', storage: 'sqlite' }, '实时 Durable Object 必须使用声明式 SQLite export')

  return config
}

export async function loadWranglerResourceConfig(options = {}) {
  const wranglerPath = options.wranglerPath || DEFAULT_WRANGLER_PATH
  const source = await readFile(wranglerPath, 'utf8')

  return {
    production: {
      workerName: extractRootQuotedField(source, 'name'),
      apiOrigin: extractCustomDomainOrigin(source),
      d1: extractNamedFields(source, '[[d1_databases]]', ['database_name', 'database_id']),
      r2: extractNamedFields(source, '[[r2_buckets]]', ['bucket_name']),
      queues: {
        meta: extractQueueConfig(source, '', 'AD_META_QUEUE'),
        tiktok: extractQueueConfig(source, '', 'AD_TIKTOK_QUEUE'),
        google: extractQueueConfig(source, '', 'AD_GOOGLE_QUEUE'),
        importZip: extractBusinessQueueConfig(source, '', 'IMPORT_QUEUE'),
        dataRightsExport: extractBusinessQueueConfig(source, '', 'DATA_RIGHTS_EXPORT_QUEUE'),
        dataRightsDeletion: extractBusinessQueueConfig(source, '', 'DATA_RIGHTS_DELETION_QUEUE'),
        telegramImport: extractBusinessQueueConfig(source, '', 'TELEGRAM_IMPORT_QUEUE'),
      },
      realtimeHub: extractDurableObjectBinding(source, ''),
    },
    dev: {
      d1: extractNamedFields(source, '[[env.dev.d1_databases]]', ['database_name', 'database_id']),
      r2: extractNamedFields(source, '[[env.dev.r2_buckets]]', ['bucket_name']),
      queues: {
        importZip: extractBusinessQueueConfig(source, 'env.dev.', 'IMPORT_QUEUE'),
        dataRightsExport: extractBusinessQueueConfig(source, 'env.dev.', 'DATA_RIGHTS_EXPORT_QUEUE'),
        dataRightsDeletion: extractBusinessQueueConfig(source, 'env.dev.', 'DATA_RIGHTS_DELETION_QUEUE'),
        telegramImport: extractBusinessQueueConfig(source, 'env.dev.', 'TELEGRAM_IMPORT_QUEUE'),
      },
      realtimeHub: extractDurableObjectBinding(source, 'env.dev.'),
    },
    realtimeExport: extractNamedFields(source, '[exports.AppRealtimeHub]', ['type', 'storage']),
  }
}

function extractRootQuotedField(source, fieldName) {
  const root = source.split(/^\s*\[/m, 1)[0]
  return extractQuotedField(root, fieldName, 'root')
}

function extractCustomDomainOrigin(source) {
  const match = source.match(/\{\s*pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain\s*=\s*true\s*\}/)
  if (!match) throw new Error('未找到 production API custom domain')
  return `https://${match[1]}`
}

function assertQueueConfig(queue, expectedMain, expectedDlq, label) {
  assert.equal(queue.producerName, expectedMain, `${label} 生产 Queue 名称不正确`)
  assert.equal(queue.mainConsumerName, queue.producerName, `${label} Queue producer/consumer 必须一致`)
  assert.equal(queue.deadLetterQueueName, expectedDlq, `${label} 生产 DLQ 名称不正确`)
  assert.equal(queue.dlqConsumerName, queue.deadLetterQueueName, `${label} DLQ 必须配置 consumer`)
  assert.equal(queue.maxRetries, 3, `${label} Queue max_retries 必须为 3`)
  assert.equal(queue.retryDelay, 60, `${label} Queue retry_delay 必须为 60`)
}

function assertBusinessQueueConfig(queue, expectedName, expectedRetries, expectedRetryDelay, label) {
  assert.equal(queue.producerName, expectedName, `${label} producer 名称不正确`)
  assert.equal(queue.mainConsumerName, expectedName, `${label} producer/consumer 必须一致`)
  assert.equal(queue.deadLetterQueueName, `${expectedName}-dlq`, `${label} DLQ 名称不正确`)
  assert.equal(queue.maxBatchSize, 1, `${label} 必须逐消息消费`)
  assert.equal(queue.maxBatchTimeout, 5, `${label} batch timeout 不正确`)
  assert.equal(queue.maxRetries, expectedRetries, `${label} max_retries 不正确`)
  assert.equal(queue.retryDelay, expectedRetryDelay, `${label} retry_delay 不正确`)
  assert.equal(queue.maxConcurrency, 1, `${label} 在容量审批前必须保持有界单并发`)
}

function extractQueueConfig(source, prefix, binding) {
  const producerHeader = `[[${prefix}queues.producers]]`
  const consumerHeader = `[[${prefix}queues.consumers]]`
  const producerSection = extractSections(source, producerHeader)
    .find(section => extractOptionalQuotedField(section, 'binding') === binding)
  if (!producerSection) throw new Error(`未找到 ${producerHeader} binding=${binding}`)
  const producerName = extractQuotedField(producerSection, 'queue', `${producerHeader} binding=${binding}`)
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

function extractBusinessQueueConfig(source, prefix, binding) {
  const producerHeader = `[[${prefix}queues.producers]]`
  const consumerHeader = `[[${prefix}queues.consumers]]`
  const producerSection = extractSections(source, producerHeader)
    .find(section => extractOptionalQuotedField(section, 'binding') === binding)
  if (!producerSection) throw new Error(`未找到 ${producerHeader} binding=${binding}`)
  const producerName = extractQuotedField(producerSection, 'queue', `${producerHeader} binding=${binding}`)
  const consumerSection = extractSections(source, consumerHeader)
    .find(section => extractOptionalQuotedField(section, 'queue') === producerName)
  if (!consumerSection) throw new Error(`未找到 ${producerName} 对应的 ${consumerHeader}`)
  return {
    producerName,
    mainConsumerName: producerName,
    deadLetterQueueName: extractQuotedField(consumerSection, 'dead_letter_queue', consumerHeader),
    maxBatchSize: extractIntegerField(consumerSection, 'max_batch_size', consumerHeader),
    maxBatchTimeout: extractIntegerField(consumerSection, 'max_batch_timeout', consumerHeader),
    maxRetries: extractIntegerField(consumerSection, 'max_retries', consumerHeader),
    retryDelay: extractIntegerField(consumerSection, 'retry_delay', consumerHeader),
    maxConcurrency: extractIntegerField(consumerSection, 'max_concurrency', consumerHeader),
  }
}

function extractDurableObjectBinding(source, prefix) {
  const header = `[[${prefix}durable_objects.bindings]]`
  const section = extractSections(source, header)
    .find(candidate => extractOptionalQuotedField(candidate, 'name') === 'APP_REALTIME_HUB')
  if (!section) throw new Error(`未找到 ${header} name=APP_REALTIME_HUB`)
  return {
    bindingName: 'APP_REALTIME_HUB',
    className: extractQuotedField(section, 'class_name', header),
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

function extractIntegerField(sectionSource, fieldName, sectionHeader) {
  const value = extractOptionalIntegerField(sectionSource, fieldName)
  if (value === undefined) throw new Error(`在 ${sectionHeader} 中未找到字段 ${fieldName}`)
  return value
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
