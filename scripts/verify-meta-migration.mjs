import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './release-verification-lib.mjs'

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const PRE_MIGRATION_FILE = 'pre-0039.sql'
const ALL_MIGRATIONS_FILE = 'empty-0001-0051.sql'
const FOLLOW_UP_MIGRATIONS = [
  '0039_meta_capi_v2_operations.sql',
  '0040_meta_capi_circuit_indexes.sql',
  '0041_meta_live_challenges.sql',
  '0042_meta_resource_attestation_tickets.sql',
  '0043_meta_capi_delivery_lease.sql',
  '0044_meta_dataset_quality_contract_digest.sql',
  '0045_meta_live_production.sql',
  '0046_meta_live_match_coverage.sql',
  '0047_ad_platform_delivery_core.sql',
  '0048_tiktok_pixel_connection.sql',
  '0049_tiktok_events_api.sql',
  '0050_strict_ad_source_routing.sql',
  '0051_unified_attribution_expand.sql',
]
const REMOTE_PREFLIGHT_CONFIG = {
  dev: {
    database: 'meigallery-db-dev',
    envArgs: ['--env', 'dev'],
  },
  production: {
    database: 'meigallery-db',
    envArgs: ['--env', ''],
  },
}
const TABLE_PRESENT_SQL = `
SELECT
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'analytics_conversion_deliveries') AS table_present,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_deliveries') WHERE name IN ('provider', 'transport')) AS platform_core_column_count;
`.trim()
const DUPLICATE_GROUP_SQL = `
SELECT COUNT(*) AS duplicate_group_count
FROM (
  SELECT 1
  FROM analytics_conversion_deliveries
  GROUP BY conversion_action_id, channel
  HAVING COUNT(*) > 1
);
`.trim()
const PLATFORM_DUPLICATE_GROUP_SQL = `
SELECT COUNT(*) AS duplicate_group_count
FROM (
  SELECT 1
  FROM analytics_conversion_deliveries
  GROUP BY conversion_action_id, provider, transport
  HAVING COUNT(*) > 1
);
`.trim()

export async function runMetaMigrationVerification(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR
  const apiDir = path.join(rootDir, 'packages', 'api')
  const migrationDir = path.join(apiDir, 'migrations')
  const stateDir = options.stateDir || path.join(rootDir, '.wrangler-release-verify', 'meta-migration')
  const preMigrationPath = path.join(stateDir, PRE_MIGRATION_FILE)
  const allMigrationsPath = path.join(stateDir, ALL_MIGRATIONS_FILE)
  const oldPersistTo = path.relative(apiDir, path.join(stateDir, 'old'))
  const emptyPersistTo = path.relative(apiDir, path.join(stateDir, 'empty'))
  const preMigrationRelativePath = path.relative(apiDir, preMigrationPath)
  const allMigrationsRelativePath = path.relative(apiDir, allMigrationsPath)
  const runCommandFn = options.runCommand || runCommand
  const steps = []

  try {
    await rm(stateDir, { recursive: true, force: true })
    await mkdir(stateDir, { recursive: true })
    await writeFile(preMigrationPath, await buildPreMigrationSql(migrationDir))
    await writeFile(allMigrationsPath, await buildMigrationSql(migrationDir, 51))

    if (!await runD1Step(runCommandFn, rootDir, oldPersistTo, 'meta-migration-apply-0001-0038', [
      '--file', preMigrationRelativePath,
      '--yes',
    ], steps)) return failedResult(steps, stateDir)

    if (!await runD1Step(runCommandFn, rootDir, oldPersistTo, 'meta-migration-seed', [
      '--command', seedSql(options.includeDuplicateFixture === true),
      '--yes',
    ], steps)) return failedResult(steps, stateDir)

    const preflightStep = await runD1Step(
      runCommandFn,
      rootDir,
      oldPersistTo,
      'meta-migration-preflight-0039',
      ['--command', DUPLICATE_GROUP_SQL, '--json', '--yes'],
      steps,
    )
    if (!preflightStep) return failedResult(steps, stateDir)

    const duplicateGroupCount = parseDuplicateGroupCount(preflightStep.stdout)
    if (duplicateGroupCount > 0) {
      return failedResult(
        steps,
        stateDir,
        new Error(`duplicate_group_count=${duplicateGroupCount}`),
        duplicateGroupCount,
      )
    }

    for (const migrationName of FOLLOW_UP_MIGRATIONS) {
      const number = migrationName.slice(0, 4)
      if (!await runD1Step(runCommandFn, rootDir, oldPersistTo, `meta-migration-apply-${number}`, [
        '--file', path.relative(apiDir, path.join(migrationDir, migrationName)),
        '--yes',
      ], steps)) return failedResult(steps, stateDir, undefined, duplicateGroupCount)
      if (number === '0039' && !await runD1Step(
        runCommandFn,
        rootDir,
        oldPersistTo,
        'meta-migration-seed-0039-history',
        ['--command', seedPost0039Sql(), '--yes'],
        steps,
      )) return failedResult(steps, stateDir, undefined, duplicateGroupCount)
      if (number === '0048' && !await runD1Step(
        runCommandFn,
        rootDir,
        oldPersistTo,
        'meta-migration-seed-0049-bridge',
        ['--command', seedPre0049BridgeSql(), '--yes'],
        steps,
      )) return failedResult(steps, stateDir, undefined, duplicateGroupCount)
      if (number === '0049' && !await runD1Step(
        runCommandFn,
        rootDir,
        oldPersistTo,
        'meta-migration-exercise-0049-bridge',
        ['--command', exercise0049BridgeSql(), '--yes'],
        steps,
      )) return failedResult(steps, stateDir, undefined, duplicateGroupCount)
    }

    const historyStep = await runD1Step(runCommandFn, rootDir, oldPersistTo, 'meta-migration-query-history', [
      '--command', historyQuerySql(),
      '--json',
      '--yes',
    ], steps)
    if (!historyStep) return failedResult(steps, stateDir, undefined, duplicateGroupCount)

    const schemaStep = await runD1Step(runCommandFn, rootDir, oldPersistTo, 'meta-migration-query-schema', [
      '--command', schemaQuerySql(),
      '--json',
      '--yes',
    ], steps)
    if (!schemaStep) return failedResult(steps, stateDir, undefined, duplicateGroupCount)

    assertMigrationResult({
      history: parseWranglerResults(historyStep.stdout, '历史事实查询'),
      schema: parseWranglerResults(schemaStep.stdout, 'schema 查询'),
    })

    if (!await runD1Step(runCommandFn, rootDir, emptyPersistTo, 'meta-migration-empty-apply-0001-0051', [
      '--file', allMigrationsRelativePath,
      '--yes',
    ], steps)) return failedResult(steps, stateDir, undefined, duplicateGroupCount)
    const emptySchemaStep = await runD1Step(runCommandFn, rootDir, emptyPersistTo, 'meta-migration-empty-query-schema', [
      '--command', schemaQuerySql(),
      '--json',
      '--yes',
    ], steps)
    if (!emptySchemaStep) return failedResult(steps, stateDir, undefined, duplicateGroupCount)
    assertSchemaResult(parseWranglerResults(emptySchemaStep.stdout, '空库 schema 查询'))

    return { status: 'passed', steps, artifacts: [stateDir], duplicateGroupCount }
  }
  catch (error) {
    return failedResult(steps, stateDir, error)
  }
  finally {
    await rm(preMigrationPath, { force: true })
    await rm(allMigrationsPath, { force: true })
  }
}

export async function runRemoteMetaMigrationPreflight(options = {}) {
  const environment = String(options.environment || '')
  const config = REMOTE_PREFLIGHT_CONFIG[environment]
  if (!config) throw new Error('preflight --env 只允许 dev 或 production')
  const runCommandFn = options.runCommand || runCommand
  const cwd = options.cwd || ROOT_DIR

  const tableStep = await runRemoteD1Query(
    runCommandFn,
    cwd,
    config,
    'meta-migration-remote-table-check',
    TABLE_PRESENT_SQL,
  )
  if (tableStep.status !== 'passed') return remotePreflightReport('check_failed', false, 0)

  let tablePresent
  let platformCorePresent
  try {
    tablePresent = parseRemoteCount(tableStep.stdout, 'table_present', { boolean: true }) === 1
    platformCorePresent = parseRemoteCount(tableStep.stdout, 'platform_core_column_count') === 2
  }
  catch {
    return remotePreflightReport('check_failed', false, 0)
  }
  if (!tablePresent) return remotePreflightReport('ready', false, 0)

  const duplicateStep = await runRemoteD1Query(
    runCommandFn,
    cwd,
    config,
    'meta-migration-remote-duplicate-check',
    platformCorePresent ? PLATFORM_DUPLICATE_GROUP_SQL : DUPLICATE_GROUP_SQL,
  )
  if (duplicateStep.status !== 'passed') return remotePreflightReport('check_failed', true, 0)

  let duplicateGroupCount
  try {
    duplicateGroupCount = parseRemoteCount(duplicateStep.stdout, 'duplicate_group_count')
  }
  catch {
    return remotePreflightReport('check_failed', true, 0)
  }
  return remotePreflightReport(
    duplicateGroupCount > 0 ? 'blocked_duplicates' : 'ready',
    true,
    duplicateGroupCount,
  )
}

async function runRemoteD1Query(runCommandFn, cwd, config, name, sql) {
  return runCommandFn('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'd1', 'execute', config.database,
    ...config.envArgs,
    '--remote',
    '--command', sql,
    '--json',
    '--yes',
  ], {
    cwd,
    name,
    reportCommand: `目标 D1 Meta migration 只读 preflight：${name}`,
  })
}

function remotePreflightReport(status, tablePresent, duplicateGroupCount) {
  return { status, tablePresent, duplicateGroupCount }
}

function parseRemoteCount(stdout, key, options = {}) {
  const rows = parseWranglerResults(stdout, '远端 migration preflight')
  const count = rows[0]?.[key]
  if (rows.length !== 1 || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('远端 migration preflight 结果非法')
  }
  if (options.boolean === true && count !== 0 && count !== 1) {
    throw new Error('远端 migration preflight 表状态非法')
  }
  return count
}

async function buildPreMigrationSql(migrationDir) {
  return buildMigrationSql(migrationDir, 38)
}

async function buildMigrationSql(migrationDir, lastMigration) {
  const migrationNames = (await readdir(migrationDir))
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= lastMigration)
    .sort()

  if (migrationNames.length !== lastMigration) {
    throw new Error(`预期读取 0001 到 ${String(lastMigration).padStart(4, '0')} 共 ${lastMigration} 个 migration，实际为 ${migrationNames.length}`)
  }
  const indexes = migrationNames.map(name => Number(name.slice(0, 4)))
  if (!indexes.every((value, index) => value === index + 1)) {
    throw new Error(`0001 到 ${String(lastMigration).padStart(4, '0')} migration 编号不连续`)
  }

  const migrations = await Promise.all(migrationNames.map(name => readFile(path.join(migrationDir, name), 'utf8')))
  return `${migrations.join('\n\n')}\n`
}

async function runD1Step(runCommandFn, cwd, persistTo, name, extraArgs, steps) {
  const step = await runCommandFn('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'd1', 'execute', 'meigallery-db',
    '--local',
    '--persist-to', persistTo,
    ...extraArgs,
  ], {
    cwd,
    name,
    reportCommand: `本地 D1 Meta migration 演练：${name}`,
  })
  steps.push(step)
  return step.status === 'passed' ? step : null
}

function seedSql(includeDuplicateFixture) {
  const statements = [
    "INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id) VALUES ('action_legacy', 'contact', 'contact:legacy', '2026-07-09T00:00:00.000Z', '2026-07-09', 'visitor_legacy', 'session_legacy');",
    "INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, channel, external_event_id, event_name, status, skip_reason, error_code, error_message, attempt_count, last_attempt_at, sent_at, created_at, updated_at) VALUES ('delivery_pixel', 'action_legacy', 'meta_pixel', 'meta:Contact:old_pixel', 'Contact', 'attempted', '', '', '', 2, '2026-07-10T00:00:00.000Z', NULL, '2026-07-09T00:00:00.000Z', '2026-07-10T00:01:00.000Z'), ('delivery_capi', 'action_legacy', 'meta_capi', 'meta:Contact:old_capi', 'Contact', 'pending', '', '', '', 0, NULL, NULL, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');",
    "INSERT INTO meta_connection_verifications (environment, pixel_id, token_fingerprint, graph_api_version, verified_event_name, verified_commit, verified_at, revision) VALUES ('dev', '1234567890', lower(hex(randomblob(32))), 'v25.0', 'Contact', lower(hex(randomblob(20))), '2026-07-10T00:00:00.000Z', lower(hex(randomblob(16))));",
    "INSERT OR REPLACE INTO site_settings (key, value) VALUES ('facebook_pixel_enabled', 'true'), ('facebook_pixel_id', '\"1234567890\"'), ('facebook_pixel_debug_enabled', 'false'), ('meta_tracking_mode', '\"production\"'), ('meta_capi_enabled', 'true'), ('meta_capi_rollout_percentage', '50'), ('meta_capi_test_event_enabled', 'false');",
    "INSERT INTO meta_capi_secure_outbox (delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES ('delivery_capi', 2, 'key-current', 'iv-redacted', 'ciphertext-redacted', 'tag-redacted', '2026-07-12T00:00:00.000Z');",
    `INSERT INTO analytics_conversion_dedupe_claims (dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at) VALUES ('${'a'.repeat(64)}', 'action_legacy', '${'b'.repeat(32)}', '2026-07-10T00:00:00.000Z', '2026-07-10T00:01:00.000Z');`,
  ]
  if (includeDuplicateFixture) {
    statements.push("INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, channel, external_event_id, event_name, status) VALUES ('delivery_duplicate', 'action_legacy', 'meta_capi', 'meta:Contact:duplicate', 'Contact', 'pending');")
  }
  return statements.join('\n')
}

function seedPost0039Sql() {
  return [
    "INSERT INTO meta_capi_incidents (id, environment, status, severity, trigger_code, trigger_summary, target_rollout_percentage, effective_rollout_percentage, evidence, opened_at, last_observed_at) VALUES ('incident_legacy', 'dev', 'open', 'warning', 'legacy_warning', '历史 warning', 0, 0, '{}', '2026-07-10T00:00:00.000Z', '2026-07-10T00:01:00.000Z');",
    "INSERT INTO meta_dataset_quality_snapshots (id, environment, dataset_id, event_name, metric_key, metric_value, collection_status, error_category, collected_at, contract_version) VALUES ('quality_legacy', 'dev', '1234567890', 'Contact', 'emq_score', 8.5, 'success', '', '2026-07-10T00:02:00.000Z', 1);",
  ].join('\n')
}

function seedPre0049BridgeSql() {
  return [
    `INSERT INTO users (email, password_hash, meta_external_id) VALUES ('bridge-existing@invalid.local', 'hash_bridge_existing', '${'1'.repeat(32)}');`,
    "INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id) VALUES ('action_bridge_meta', 'contact', 'contact:bridge-meta', '2026-07-13T00:00:00.000Z', '2026-07-13', 'visitor_bridge_meta', 'session_bridge_meta');",
    "INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, provider, transport, external_event_id, event_name, status, tracking_mode, encryption_key_id) VALUES ('delivery_bridge_meta', 'action_bridge_meta', 'meta', 'server', 'meta:Contact:bridge', 'Contact', 'pending', 'production', 'bridge-key');",
    "INSERT INTO meta_capi_secure_outbox (delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES ('delivery_bridge_meta', 2, 'bridge-key', 'legacy-iv', 'legacy-ciphertext', 'legacy-tag', '2026-07-14T00:00:00.000Z');",
  ].join('\n')
}

function exercise0049BridgeSql() {
  return [
    'PRAGMA recursive_triggers = ON;',
    `UPDATE users SET meta_external_id = '${'2'.repeat(32)}' WHERE email = 'bridge-existing@invalid.local';`,
    `UPDATE users SET conversion_external_id = '${'3'.repeat(32)}' WHERE email = 'bridge-existing@invalid.local';`,
    `INSERT INTO users (email, password_hash, meta_external_id) VALUES ('bridge-legacy@invalid.local', 'hash_bridge_legacy', '${'4'.repeat(32)}');`,
    `INSERT INTO users (email, password_hash, conversion_external_id) VALUES ('bridge-current@invalid.local', 'hash_bridge_current', '${'5'.repeat(32)}');`,
    "UPDATE meta_capi_secure_outbox SET ciphertext = 'legacy-update' WHERE delivery_id = 'delivery_bridge_meta';",
    "UPDATE ad_platform_secure_outbox SET tag = 'current-update' WHERE delivery_id = 'delivery_bridge_meta' AND provider = 'meta';",
    "DELETE FROM meta_capi_secure_outbox WHERE delivery_id = 'delivery_bridge_meta';",
    "INSERT INTO ad_platform_secure_outbox (delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES ('delivery_bridge_meta', 'meta', 2, 'current-key', 'current-iv', 'current-ciphertext', 'current-tag', '2026-07-15T00:00:00.000Z');",
    "DELETE FROM ad_platform_secure_outbox WHERE delivery_id = 'delivery_bridge_meta' AND provider = 'meta';",
    "INSERT INTO meta_capi_secure_outbox (delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES ('delivery_bridge_meta', 2, 'final-key', 'final-iv', 'final-ciphertext', 'final-tag', '2026-07-16T00:00:00.000Z');",
  ].join('\n')
}

function historyQuerySql() {
  return `
SELECT
  (SELECT COUNT(*) FROM analytics_conversion_actions WHERE id = 'action_legacy' AND action_type = 'contact') AS action_count,
  (SELECT COUNT(*) FROM analytics_conversion_deliveries WHERE conversion_action_id = 'action_legacy') AS delivery_count,
  (SELECT COUNT(*) FROM meta_connection_verifications WHERE environment = 'dev') AS verification_count,
  (SELECT COUNT(*) FROM ad_platform_secure_outbox WHERE provider = 'meta') AS outbox_count,
  (SELECT COUNT(*) FROM meta_capi_secure_outbox) AS bridge_outbox_count,
  (SELECT COUNT(*) FROM users WHERE email IN (
    'bridge-existing@invalid.local', 'bridge-legacy@invalid.local', 'bridge-current@invalid.local'
  ) AND meta_external_id = conversion_external_id) AS bridge_identity_count,
  (SELECT COUNT(*) FROM ad_platform_secure_outbox current_outbox
    JOIN meta_capi_secure_outbox legacy_outbox ON legacy_outbox.delivery_id = current_outbox.delivery_id
    WHERE current_outbox.delivery_id = 'delivery_bridge_meta' AND current_outbox.provider = 'meta'
      AND current_outbox.key_id = legacy_outbox.key_id AND current_outbox.iv = legacy_outbox.iv
      AND current_outbox.ciphertext = legacy_outbox.ciphertext AND current_outbox.tag = legacy_outbox.tag
      AND current_outbox.expires_at = legacy_outbox.expires_at) AS bridge_outbox_match,
  (SELECT COUNT(*) FROM analytics_conversion_dedupe_claims WHERE owner_action_id = 'action_legacy') AS claim_count,
  (SELECT COUNT(*) FROM meta_capi_incidents WHERE id = 'incident_legacy') AS incident_count,
  (SELECT COUNT(*) FROM meta_dataset_quality_snapshots WHERE id = 'quality_legacy') AS quality_count,
  (SELECT COUNT(*) FROM ad_platform_connections WHERE provider = 'meta' AND enabled = 1
    AND mode = 'production' AND browser_enabled = 1 AND server_enabled = 1
    AND destination_id = '1234567890' AND rollout_percentage = 50) AS connection_count,
  (SELECT COUNT(*) FROM site_settings WHERE key IN (
    'facebook_pixel_enabled', 'facebook_pixel_id', 'facebook_pixel_debug_enabled',
    'meta_tracking_mode', 'meta_capi_enabled', 'meta_capi_rollout_percentage',
    'meta_capi_test_event_enabled'
  )) AS legacy_setting_count;
`.trim()
}

function schemaQuerySql() {
  return `
SELECT
  (SELECT COUNT(*) FROM pragma_index_list('analytics_conversion_deliveries') WHERE name = 'idx_conversion_delivery_action_destination' AND [unique] = 1) AS delivery_unique_index,
  (SELECT COUNT(*) FROM pragma_index_list('analytics_conversion_deliveries') WHERE name = 'idx_conversion_delivery_provider_external' AND [unique] = 1) AS provider_external_unique_index,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_deliveries') WHERE name IN ('provider', 'transport', 'connection_revision')) AS ad_platform_core_columns,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_deliveries') WHERE name IN ('has_ttclid', 'has_ttp')) AS tiktok_match_columns,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'ad_platform_connections') AS connection_table,
  (SELECT COUNT(*) FROM ad_platform_connections WHERE provider = 'tiktok') AS tiktok_connection,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'tiktok_connection_verifications') AS tiktok_verification_table,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'ad_platform_secure_outbox') AS secure_outbox_table,
  (SELECT COUNT(*) FROM pragma_table_info('ad_platform_secure_outbox') WHERE name = 'provider' AND upper(type) = 'TEXT' AND [notnull] = 1) AS secure_outbox_provider_column,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_ad_platform_secure_outbox_provider_expiry') AS secure_outbox_index,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta_capi_secure_outbox') AS legacy_secure_outbox_table,
  (SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'conversion_external_id') AS conversion_external_id_column,
  (SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'meta_external_id') AS legacy_meta_external_id_column,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name GLOB 'trg_0049_bridge_*') AS bridge_trigger_count,
  (SELECT COUNT(*) FROM pragma_index_list('users') WHERE name = 'idx_users_conversion_external_id' AND [unique] = 1) AS conversion_external_id_index,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_deliveries') WHERE name IN ('channel', 'meta_connection_revision')) AS legacy_delivery_columns,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_tracking_sources')
    WHERE name = 'ad_provider' AND upper(type) = 'TEXT' AND [notnull] = 1 AND dflt_value = "''") AS tracking_source_provider_column,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_actions')
    WHERE name = 'attribution_provider' AND upper(type) = 'TEXT' AND [notnull] = 1 AND dflt_value = "''") AS action_attribution_provider_column,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_tracking_sources_ad_provider') AS tracking_source_provider_index,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_conversion_actions_attribution_provider') AS action_attribution_provider_index,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name IN (
    'trg_0050_delivery_provider_insert_guard',
    'trg_0050_delivery_provider_update_guard',
    'trg_0050_action_provider_immutable'
  )) AS strict_routing_trigger_count,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta_live_challenges') AS challenge_table,
  (SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'meta_live_challenges') AS challenge_table_sql,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_meta_live_challenges_expiry') AS challenge_index,
  (SELECT COUNT(*) FROM pragma_table_info('meta_live_challenges') WHERE name IN (
    'registration_email_covered', 'registration_external_id_covered', 'contact_registration_identity_absent'
  ) AND upper(type) = 'INTEGER' AND [notnull] = 1 AND dflt_value = '0') AS challenge_match_coverage_columns,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta_resource_attestation_tickets') AS ticket_table,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_meta_resource_attestation_tickets_expiry') AS ticket_index,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_conversion_delivery_lease_expiry') AS delivery_lease_index,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_deliveries')
    WHERE name = 'delivery_lease_token' AND upper(type) = 'TEXT' AND [notnull] = 1 AND dflt_value = "''") AS delivery_lease_token_column,
  (SELECT COUNT(*) FROM pragma_table_info('analytics_conversion_deliveries')
    WHERE name = 'delivery_lease_expires_at' AND upper(type) = 'TEXT' AND [notnull] = 0) AS delivery_lease_expires_column,
  (SELECT group_concat(name, ',') FROM pragma_index_info('idx_conversion_delivery_lease_expiry') ORDER BY seqno) AS delivery_lease_index_columns,
  (SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_conversion_delivery_lease_expiry') AS delivery_lease_index_sql,
  (SELECT value FROM site_settings WHERE key = 'registration_conversion_recovery_cursor') AS registration_recovery_cursor,
  (SELECT COUNT(*) FROM pragma_table_info('meta_dataset_quality_snapshots')
    WHERE name = 'contract_digest' AND upper(type) = 'TEXT' AND [notnull] = 1 AND dflt_value = "''") AS quality_contract_digest_column,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_meta_dataset_quality_contract') AS quality_contract_digest_index,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta_capi_incidents') AS incident_table,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta_dataset_quality_snapshots') AS quality_table,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name GLOB 'attribution_*') AS attribution_table_count,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name IN (
    'attribution_fact_provider_immutable',
    'attribution_connection_provider_immutable',
    'attribution_delivery_provider_guard',
    'attribution_delivery_provider_update_guard',
    'attribution_outbox_provider_guard',
    'attribution_outbox_provider_update_guard'
  )) AS attribution_trigger_count,
  (SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attribution_platform_connections') AS attribution_connection_sql,
  (SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attribution_conversion_facts') AS attribution_fact_sql,
  (SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attribution_deliveries') AS attribution_delivery_sql;
`.trim()
}

function parseDuplicateGroupCount(stdout) {
  const rows = parseWranglerResults(stdout, '重复组 preflight')
  const count = rows[0]?.duplicate_group_count
  if (rows.length !== 1 || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('重复组 preflight 结果非法')
  }
  return count
}

function parseWranglerResults(stdout, label) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  }
  catch {
    throw new Error(`${label}未返回有效 JSON`)
  }

  const result = Array.isArray(parsed) ? parsed[0]?.results : undefined
  if (!Array.isArray(result)) throw new Error(`${label} JSON 结构非法`)
  return result
}

function assertMigrationResult({ history, schema }) {
  const row = history[0]
  if (history.length !== 1 || [
    row?.action_count,
    row?.verification_count,
    row?.claim_count,
    row?.incident_count,
    row?.quality_count,
    row?.connection_count,
  ].some(value => value !== 1)
  || row?.delivery_count !== 0
  || row?.outbox_count !== 1
  || row?.bridge_outbox_count !== 1
  || row?.bridge_identity_count !== 3
  || row?.bridge_outbox_match !== 1
  || row?.legacy_setting_count !== 0) {
    throw new Error('业务事实或统一广告平台迁移结果不正确')
  }

  assertSchemaResult(schema)
}

function assertSchemaResult(rows) {
  const row = rows[0]
  const leaseIndexSql = String(row?.delivery_lease_index_sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const challengeTableSql = String(row?.challenge_table_sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const attributionConnectionSql = String(row?.attribution_connection_sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const attributionFactSql = String(row?.attribution_fact_sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const attributionDeliverySql = String(row?.attribution_delivery_sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (rows.length !== 1
    || row?.delivery_unique_index !== 1
    || row?.provider_external_unique_index !== 1
    || row?.ad_platform_core_columns !== 3
    || row?.tiktok_match_columns !== 2
    || row?.connection_table !== 1
    || row?.tiktok_connection !== 1
    || row?.tiktok_verification_table !== 1
    || row?.secure_outbox_table !== 1
    || row?.secure_outbox_provider_column !== 1
    || row?.secure_outbox_index !== 1
    || row?.legacy_secure_outbox_table !== 1
    || row?.conversion_external_id_column !== 1
    || row?.legacy_meta_external_id_column !== 1
    || row?.bridge_trigger_count !== 8
    || row?.conversion_external_id_index !== 1
    || row?.legacy_delivery_columns !== 0
    || row?.tracking_source_provider_column !== 1
    || row?.action_attribution_provider_column !== 1
    || row?.tracking_source_provider_index !== 1
    || row?.action_attribution_provider_index !== 1
    || row?.strict_routing_trigger_count !== 3
    || row?.delivery_lease_index !== 1
    || row?.delivery_lease_token_column !== 1
    || row?.delivery_lease_expires_column !== 1
    || row?.delivery_lease_index_columns !== 'provider,transport,delivery_lease_expires_at'
    || !leaseIndexSql.includes("where delivery_lease_token <> ''")
    || row?.registration_recovery_cursor !== '0'
    || row?.quality_contract_digest_column !== 1
    || row?.quality_contract_digest_index !== 1
    || row?.attribution_table_count !== 11
    || row?.attribution_trigger_count !== 6
    || attributionConnectionSql.includes("provider in ('meta', 'tiktok', 'google')")
    || attributionFactSql.includes("attribution_provider in ('meta', 'tiktok', 'google')")
    || !attributionFactSql.includes("fact_origin in ('live', 'historical_backfill')")
    || !attributionFactSql.includes("fact_origin = 'live' and external_event_id is not null")
    || !attributionDeliverySql.includes("status in ('planned', 'queued', 'accepted', 'processed', 'retrying', 'rejected', 'dead_letter', 'cancelled')")
    || !challengeTableSql.includes("check (environment = 'production')")
    || row?.challenge_match_coverage_columns !== 3
    || ['challenge_table', 'challenge_index', 'ticket_table', 'ticket_index', 'incident_table', 'quality_table']
      .some(field => row?.[field] !== 1)) {
    throw new Error('Meta/TikTok 广告平台 0040-0051 schema 不完整')
  }
}

function failedResult(steps, stateDir, error, duplicateGroupCount) {
  return {
    status: 'failed',
    steps,
    artifacts: [stateDir],
    ...(duplicateGroupCount === undefined ? {} : { duplicateGroupCount }),
    error: error instanceof Error ? error.message : undefined,
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const writeOutput = options.writeOutput || (value => console.log(value))
  const writeError = options.writeError || (value => console.error(value))

  if (argv[0] === 'preflight') {
    if (argv.length !== 3 || argv[1] !== '--env') {
      throw new Error('用法：verify-meta-migration.mjs preflight --env dev|production')
    }
    const report = await runRemoteMetaMigrationPreflight({
      environment: argv[2],
      cwd: options.cwd,
      runCommand: options.runCommand,
    })
    writeOutput(JSON.stringify(report))
    return report
  }
  if (argv.length > 0) throw new Error('用法：verify-meta-migration.mjs [preflight --env dev|production]')

  const result = await runMetaMigrationVerification(options)
  if (result.duplicateGroupCount > 0) writeError(result.error)
  else {
    for (const step of result.steps) writeOutput(`${step.status === 'passed' ? 'PASS' : 'FAIL'} ${step.name}`)
    if (result.status !== 'passed') writeError(result.error || 'Meta migration 演练失败')
  }
  return result
}

export function metaMigrationExitCode(result) {
  return result?.status === 'passed' || result?.status === 'ready' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main()
    process.exitCode = metaMigrationExitCode(result)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
