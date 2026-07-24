import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('./0002_event_delivery.sql', import.meta.url)

test('事件 Schema 具备完整事实、投递和隐私边界', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  for (const table of [
    'attribution_managed_sources',
    'attribution_contexts',
    'attribution_facts',
    'attribution_deliveries',
    'attribution_outbox',
    'attribution_browser_receipts',
    'attribution_validations',
    'attribution_validation_secrets',
    'attribution_quality_daily',
    'attribution_capacity_daily',
    'attribution_privacy_policy',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
  }

  assert.match(migration, /dedupe_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i)
  assert.doesNotMatch(migration, /\bdedupe_key\b/i)
  assert.match(
    migration,
    /UNIQUE\s*\(fact_id,\s*connection_id,\s*transport\)/i,
  )
  assert.match(
    migration,
    /CHECK\s*\(transport IN \('browser','server'\)\)/i,
  )
  assert.match(
    migration,
    /CHECK\s*\(\s*event_name\s+IN\s*\('Contact','CompleteRegistration'\)\s*\)/i,
  )
  assert.match(
    migration,
    /CHECK\s*\(fact_origin IN \('live','synthetic'\)\)/i,
  )
  assert.match(
    migration,
    /event_fingerprint\s+TEXT\s+NOT NULL[\s\S]*length\(event_fingerprint\)\s*=\s*64/i,
  )
  assert.match(migration, /event_id\s+TEXT\s+NOT NULL\s+UNIQUE/i)
  assert.match(
    migration,
    /CREATE UNIQUE INDEX attribution_facts_external_event_unique[\s\S]*WHERE external_event_id IS NOT NULL/i,
  )
  assert.match(migration, /\bproof_hash\s+TEXT\s+NOT NULL\s+UNIQUE\b/i)
  assert.doesNotMatch(migration, /\bproof_hmac\b/i)
  assert.match(migration, /\bidentifiers_envelope_json\b/i)
  assert.doesNotMatch(migration, /\bidentifiers_json\b/i)
  assert.match(
    migration,
    /json_extract\(identifiers_envelope_json,\s*'\$\.schemaVersion'\)\s+IS\s+1/i,
  )
  assert.match(migration, /json_type\(identifiers_envelope_json,\s*'\$\.tag'\)/i)
  assert.match(
    migration,
    /source_id\s+TEXT\s+REFERENCES attribution_managed_sources\(id\)\s+ON DELETE CASCADE/i,
  )
  assert.doesNotMatch(
    migration,
    /release_commit|verified_commit|connection_revision|credential_revision/i,
  )
})

test('敏感投递数据只存在于加密 envelope', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  const outbox = migration.match(
    /CREATE TABLE attribution_outbox \(([\s\S]*?)\n\);/i,
  )?.[1] ?? ''

  for (const column of ['key_id', 'iv', 'ciphertext', 'tag', 'expires_at']) {
    assert.match(outbox, new RegExp(`\\b${column}\\b`, 'i'))
  }
  assert.doesNotMatch(
    migration,
    /\b(access_token|email|phone|client_ip|user_agent)\b/i,
  )
})
