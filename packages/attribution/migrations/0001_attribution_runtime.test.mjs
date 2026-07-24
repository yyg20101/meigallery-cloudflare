import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('./0001_attribution_runtime.sql', import.meta.url)

test('基线 Schema 不包含 Git 或旧 revision 门禁', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.doesNotMatch(
    migration,
    /release_commit|verified_commit|connection_revision|credential_revision/i,
  )
  for (const table of [
    'attribution_connections',
    'attribution_connection_versions',
    'attribution_version_credentials',
    'attribution_version_bindings',
    'attribution_runtime_policies',
    'attribution_command_receipts',
    'attribution_activation_fences',
    'attribution_audit_logs',
    'attribution_incidents',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
  }
  assert.match(
    migration,
    /CREATE TRIGGER attribution_activation_fence_validate/,
  )
  assert.match(migration, /ATTRIBUTION_ACTIVE_VERSION_CHANGED/)
})
