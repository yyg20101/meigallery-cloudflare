#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const OLD_DATABASE = 'meigallery-db'
const NEW_DATABASE = 'meigallery-attribution-db'
const DEFAULT_RUN_ID = 'migration-production-v1'
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024

export function evaluatePreflight(input) {
  const result = {
    oldRuntimeOwner: input.oldRuntimeOwner,
    oldOwnerEpoch: positiveInteger(input.oldOwnerEpoch),
    newRuntimeMode: input.newRuntimeMode,
    bridgeOwnerEpoch: nullablePositiveInteger(input.bridgeOwnerEpoch),
    activeOwnerEpoch: nullablePositiveInteger(input.activeOwnerEpoch),
    fencedOwnerEpoch: nullablePositiveInteger(input.fencedOwnerEpoch),
    productionDeliveryCountNew: nonNegativeInteger(
      input.productionDeliveryCountNew,
    ),
    openCriticalCountNew: nonNegativeInteger(
      input.openCriticalCountNew,
    ),
    targetDataCountNew: nonNegativeInteger(
      input.targetDataCountNew ?? 0,
    ),
    requireEmptyTarget: input.requireEmptyTarget !== false,
  }
  return {
    ...result,
    ready:
      result.oldRuntimeOwner === 'old'
      && result.newRuntimeMode === 'shadow'
      && result.bridgeOwnerEpoch === null
      && result.activeOwnerEpoch === null
      && result.fencedOwnerEpoch === null
      && result.productionDeliveryCountNew === 0
      && result.openCriticalCountNew === 0
      && (
        !result.requireEmptyTarget
        || result.targetDataCountNew === 0
      ),
  }
}

export function buildOldCutoverSummary(rows) {
  const connections = buildConnectionSummary(
    rows.connections,
    rows.bindings,
    'old',
  )
  const connectionByProvider = uniqueConnectionByProvider(connections)
  const managedSources = sortedById(
    requiredRows(rows.managedSources).map(row => {
      const provider = providerValue(row.ad_provider)
      const connectionId = connectionByProvider.get(provider)
      if (!connectionId) throw cutoverError('SOURCE_CONNECTION_MISSING')
      return {
        id: identifier(row.id),
        connectionId,
        proofHash: digestHex(
          `managed-source:v1:${proofValue(row.link_proof)}`,
        ),
        stateHash: digest({
          provider,
          campaign: safeText(row.utm_campaign || row.id),
          medium: safeText(row.utm_medium),
          content: optionalText(row.utm_content),
          enabled: row.status === 'active',
          expiresAt: null,
        }),
      }
    }),
  )
  return summaryResult({
    connections,
    managedSources,
    historyDaily: requiredRows(rows.historyDaily).map(historyRow),
    pendingDeliveries: rows.pendingDeliveries,
    openCriticalIncidents: rows.openCriticalIncidents,
    privacyPolicy: rows.privacyPolicy,
  })
}

export function buildNewCutoverSummary(rows) {
  const connections = buildConnectionSummary(
    rows.connections,
    rows.bindings,
    'new',
    desiredRuntimePolicies(rows.migrationManifest),
  )
  const managedSources = sortedById(
    requiredRows(rows.managedSources).map(row => ({
      id: identifier(row.id),
      connectionId: identifier(row.connection_id),
      proofHash: publicDigest(row.proof_hash),
      stateHash: digest({
        provider: providerValue(row.provider),
        campaign: safeText(row.campaign),
        medium: safeText(row.medium),
        content: optionalText(row.content),
        enabled: booleanInteger(row.enabled),
        expiresAt: nullableTimestamp(row.expires_at),
      }),
    })),
  )
  return summaryResult({
    connections,
    managedSources,
    historyDaily: requiredRows(rows.historyDaily).map(historyRow),
    pendingDeliveries: rows.pendingDeliveries,
    openCriticalIncidents: rows.openCriticalIncidents,
    privacyPolicy: rows.privacyPolicy,
  })
}

export function compareMigrationSets(oldSummary, newSummary) {
  const comparable = [
    'connections',
    'managedSources',
    'history',
    'privacyPolicyHash',
  ]
  const mismatches = comparable.filter(key =>
    stableJson(oldSummary[key]) !== stableJson(newSummary[key]))
  return {
    matched: mismatches.length === 0,
    mismatches,
  }
}

export function parseCutoverArgs(args) {
  const parsed = {
    mode: 'preflight',
    runId: DEFAULT_RUN_ID,
  }
  let index = 0
  if (args[0] && !args[0].startsWith('--')) {
    parsed.mode = args[0]
    index = 1
  }
  while (index < args.length) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument !== '--run-id' || !value) {
      throw cutoverError('ARGUMENT_INVALID')
    }
    parsed.runId = value
    index += 2
  }
  if (
    !['preflight', 'migrated'].includes(parsed.mode)
    || !IDENTIFIER_PATTERN.test(parsed.runId)
  ) {
    throw cutoverError('ARGUMENT_INVALID')
  }
  return parsed
}

export async function runCutoverVerification(options = {}) {
  const parsed = options.parsed ?? parseCutoverArgs(
    options.argv ?? process.argv.slice(2),
  )
  const queryOld = options.queryOld ?? createD1Query(
    '@meigallery/api',
    OLD_DATABASE,
    options,
  )
  const queryNew = options.queryNew ?? createD1Query(
    '@meigallery/attribution',
    NEW_DATABASE,
    options,
  )
  const preflight = await readPreflight(
    queryOld,
    queryNew,
    parsed.mode === 'preflight',
  )
  if (!preflight.ready) {
    throw cutoverError('PREFLIGHT_BLOCKED')
  }
  if (parsed.mode === 'preflight') {
    return {
      status: 'ATTRIBUTION_CUTOVER_PREFLIGHT_PASSED',
      preflight,
    }
  }

  const receipt = await readMigrationReceipt(queryNew, parsed.runId)
  const [oldRows, newRows] = await Promise.all([
    readOldRows(queryOld, receipt),
    readNewRows(queryNew, receipt),
  ])
  const oldSummary = buildOldCutoverSummary(oldRows)
  const newSummary = buildNewCutoverSummary(newRows)
  const comparison = compareMigrationSets(oldSummary, newSummary)
  const receiptCheck = compareReceipt(receipt, oldRows, newRows)
  if (!comparison.matched || !receiptCheck.matched) {
    throw cutoverError('MIGRATION_SET_MISMATCH')
  }
  return {
    status: 'MIGRATION_SET_MATCHED',
    runId: receipt.runId,
    snapshotHash: `sha256:${receipt.snapshotHash}`,
    capturedAt: receipt.capturedAt,
    preflight,
    old: oldSummary,
    current: newSummary,
    receipt: {
      counts: receipt.counts,
      matched: true,
    },
  }
}

async function readPreflight(queryOld, queryNew, requireEmptyTarget) {
  const [
    oldRuntimeState,
    runtimeState,
    newDeliveryCount,
    newCriticalCount,
    newTargetCount,
  ] = await Promise.all([
    queryOld(`
      SELECT owner, owner_epoch
      FROM attribution_runtime_cutover
      WHERE id = 'global'
      LIMIT 1
    `),
    queryNew(`
      SELECT mode, bridge_owner_epoch, active_owner_epoch,
             fenced_owner_epoch
      FROM attribution_runtime_state
      WHERE id = 'global'
      LIMIT 1
    `),
    queryNew(`
      SELECT COUNT(*) AS row_count
      FROM attribution_deliveries AS delivery
      INNER JOIN attribution_facts AS fact
        ON fact.id = delivery.fact_id
      WHERE fact.fact_origin = 'live'
    `),
    queryNew(`
      SELECT COUNT(*) AS row_count
      FROM attribution_incidents
      WHERE status = 'open' AND severity = 'critical'
    `),
    queryNew(`
      SELECT
        (SELECT COUNT(*) FROM attribution_connections)
        + (SELECT COUNT(*) FROM attribution_managed_sources)
        + (SELECT COUNT(*) FROM attribution_facts)
        + (SELECT COUNT(*) FROM attribution_history_daily)
        + (SELECT COUNT(*) FROM attribution_migration_manifests)
        AS row_count
    `),
  ])
  return evaluatePreflight({
    oldRuntimeOwner: stringCell(oldRuntimeState, 'owner'),
    oldOwnerEpoch: integerCell(oldRuntimeState, 'owner_epoch'),
    newRuntimeMode: stringCell(runtimeState, 'mode'),
    bridgeOwnerEpoch: nullablePositiveIntegerCell(
      runtimeState,
      'bridge_owner_epoch',
    ),
    activeOwnerEpoch: nullablePositiveIntegerCell(
      runtimeState,
      'active_owner_epoch',
    ),
    fencedOwnerEpoch: nullablePositiveIntegerCell(
      runtimeState,
      'fenced_owner_epoch',
    ),
    productionDeliveryCountNew: integerCell(
      newDeliveryCount,
      'row_count',
    ),
    openCriticalCountNew: integerCell(
      newCriticalCount,
      'row_count',
    ),
    targetDataCountNew: integerCell(newTargetCount, 'row_count'),
    requireEmptyTarget,
  })
}

async function readMigrationReceipt(queryNew, runId) {
  const rows = await queryNew(`
    SELECT command_type, request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = 'migration:${runId}'
    LIMIT 1
  `)
  if (rows.length !== 1) {
    throw cutoverError('MIGRATION_RECEIPT_MISSING')
  }
  let result
  try {
    result = JSON.parse(rows[0].result_json)
  } catch {
    throw cutoverError('MIGRATION_RECEIPT_INVALID')
  }
  if (
    !isPlainRecord(result)
    || result.runId !== runId
    || (
      result.phase !== 'initial'
      && result.phase !== 'reconcile'
    )
    || rows[0]?.command_type !== (
      result.phase === 'initial'
        ? 'migration_import'
        : 'migration_reconcile'
    )
    || !DIGEST_PATTERN.test(result.snapshotHash)
    || result.snapshotHash !== rows[0].request_hash
    || !DIGEST_PATTERN.test(result.sourceConfigurationHash)
    || !DIGEST_PATTERN.test(result.credentialSetHash)
    || !isCanonicalTimestamp(result.capturedAt)
    || !validCounts(result.counts)
  ) {
    throw cutoverError('MIGRATION_RECEIPT_INVALID')
  }
  return result
}

async function readOldRows(query, receipt) {
  const capturedAt = sqlTimestamp(receipt.capturedAt)
  return {
    connections: await query(`
      SELECT connection.id, connection.provider, connection.enabled,
             connection.mode, connection.browser_enabled,
             connection.server_enabled, connection.public_config_json,
             connection.attribution_window_days,
             connection.rollout_target_percentage,
             connection.rollout_effective_percentage,
             connection.credential_revision
      FROM attribution_platform_connections AS connection
      ORDER BY connection.provider, connection.id
    `),
    bindings: await query(`
      SELECT connection_id, provider, canonical_event, enabled,
             browser_destination, server_destination
      FROM attribution_event_bindings
      ORDER BY connection_id, canonical_event
    `),
    credentials: await query(`
      SELECT connection_id, provider, credential_type,
             credential_revision
      FROM attribution_credentials
      ORDER BY connection_id, credential_type
    `),
    managedSources: await query(`
      SELECT id, ad_provider, link_proof, utm_campaign, utm_medium,
             utm_content, status
      FROM analytics_tracking_sources
      WHERE channel = 'ad'
        AND ad_provider IN ('meta','tiktok','google')
      ORDER BY id
    `),
    historyDaily: await query(`
      SELECT
        date(datetime(occurred_at, '+8 hours')) AS date,
        canonical_event AS event_name,
        CASE
          WHEN fact_origin = 'live' THEN 'archived_live'
          ELSE fact_origin
        END AS fact_origin,
        COALESCE(attribution_provider, 'none') AS provider,
        attribution_source,
        COUNT(*) AS fact_count,
        MIN(occurred_at) AS first_occurred_at,
        MAX(occurred_at) AS last_occurred_at
      FROM attribution_conversion_facts
      WHERE fact_origin IN ('live','historical_backfill')
        AND julianday(occurred_at) <= julianday('${capturedAt}')
      GROUP BY
        date(datetime(occurred_at, '+8 hours')),
        canonical_event,
        CASE
          WHEN fact_origin = 'live' THEN 'archived_live'
          ELSE fact_origin
        END,
        attribution_provider,
        attribution_source
      ORDER BY date, event_name, provider, attribution_source
    `),
    pendingDeliveries: await query(`
      SELECT id
      FROM attribution_deliveries
      WHERE status IN ('planned','queued','retrying')
         OR (provider = 'google' AND status = 'accepted')
      ORDER BY id
    `),
    openCriticalIncidents: await query(`
      SELECT id
      FROM attribution_incidents
      WHERE status = 'open' AND severity = 'critical'
      ORDER BY id
    `),
    privacyPolicy: await query(`
      SELECT default_mode, prior_consent_country_codes_json,
             policy_version, updated_at
      FROM attribution_privacy_policy
      WHERE id = 'global'
      LIMIT 1
    `),
  }
}

async function readNewRows(query, receipt) {
  const capturedAt = sqlTimestamp(receipt.capturedAt)
  return {
    connections: await query(`
      SELECT connection.id, connection.provider,
             version.public_config_json,
             policy.enabled, policy.browser_enabled,
             policy.server_enabled,
             policy.server_target_percentage,
             policy.server_effective_percentage,
             policy.circuit_state,
             credential.credential_fingerprint
      FROM attribution_connections AS connection
      INNER JOIN attribution_connection_versions AS version
        ON version.connection_id = connection.id
       AND version.status IN ('candidate','validating','ready','active')
      INNER JOIN attribution_runtime_policies AS policy
        ON policy.connection_id = connection.id
      INNER JOIN attribution_version_credentials AS credential
        ON credential.version_id = version.id
      ORDER BY connection.provider, connection.id
    `),
    bindings: await query(`
      SELECT version.connection_id, binding.canonical_event,
             binding.enabled, binding.browser_destination,
             binding.server_destination
      FROM attribution_version_bindings AS binding
      INNER JOIN attribution_connection_versions AS version
        ON version.id = binding.version_id
       AND version.status IN ('candidate','validating','ready','active')
      ORDER BY version.connection_id, binding.canonical_event
    `),
    managedSources: await query(`
      SELECT id, provider, connection_id, campaign, medium, content,
             proof_hash, enabled, expires_at
      FROM attribution_managed_sources
      ORDER BY id
    `),
    activeLiveFacts: await query(`
      SELECT id
      FROM attribution_facts
      WHERE fact_origin = 'live'
      ORDER BY id
    `),
    historyDaily: await query(`
      SELECT date, event_name, fact_origin, provider,
             attribution_source, fact_count, first_occurred_at,
             last_occurred_at
      FROM attribution_history_daily
      WHERE captured_at = '${capturedAt}'
      ORDER BY date, event_name, provider, attribution_source
    `),
    pendingDeliveries: await query(`
      SELECT id
      FROM attribution_deliveries
      WHERE status IN ('planned','queued','retrying')
         OR (provider = 'google' AND status = 'accepted')
      ORDER BY id
    `),
    openCriticalIncidents: await query(`
      SELECT id
      FROM attribution_incidents
      WHERE status = 'open' AND severity = 'critical'
      ORDER BY id
    `),
    privacyPolicy: await query(`
      SELECT default_mode, prior_consent_country_codes_json,
             policy_version, updated_at
      FROM attribution_privacy_policy
      WHERE id = 'global'
      LIMIT 1
    `),
    migrationManifest: await query(`
      SELECT initial_run_id, initial_snapshot_hash,
             source_configuration_hash, credential_set_hash,
             desired_runtime_policies_json, status,
             reconcile_run_id, reconcile_snapshot_hash,
             reconciled_captured_at
      FROM attribution_migration_manifests
      WHERE initial_run_id = '${receipt.runId}'
         OR reconcile_run_id = '${receipt.runId}'
      LIMIT 1
    `),
  }
}

function buildConnectionSummary(
  connectionRows,
  bindingRows,
  schema,
  desiredPolicies = new Map(),
) {
  const bindings = groupBindings(bindingRows)
  return sortedById(requiredRows(connectionRows).map(row => {
    const id = identifier(row.id)
    const provider = providerValue(row.provider)
    const eventBindings = bindings.get(id) ?? []
    if (eventBindings.length !== 2) {
      throw cutoverError('CONNECTION_BINDINGS_INVALID')
    }
    const runtimePolicy = schema === 'old'
      ? {
          enabled:
            booleanInteger(row.enabled)
            && row.mode === 'production',
          browserEnabled: booleanInteger(row.browser_enabled),
          serverEnabled: booleanInteger(row.server_enabled),
          serverTargetPercentage: percentage(
            row.rollout_target_percentage,
          ),
          serverEffectivePercentage: percentage(
            row.rollout_effective_percentage,
          ),
          circuitState: 'closed',
        }
      : desiredPolicies.get(id) ?? {
          enabled: booleanInteger(row.enabled),
          browserEnabled: booleanInteger(row.browser_enabled),
          serverEnabled: booleanInteger(row.server_enabled),
          serverTargetPercentage: percentage(
            row.server_target_percentage,
          ),
          serverEffectivePercentage: percentage(
            row.server_effective_percentage,
          ),
          circuitState: circuitState(row.circuit_state),
        }
    return {
      id,
      provider,
      activeTargetHash: digest({
        publicConfig: jsonValue(row.public_config_json),
        eventBindings,
      }),
      runtimePolicyHash: digest(runtimePolicy),
    }
  }))
}

function desiredRuntimePolicies(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw cutoverError('MIGRATION_MANIFEST_INVALID')
  }
  const policies = jsonValue(rows[0].desired_runtime_policies_json)
  if (!Array.isArray(policies)) {
    throw cutoverError('MIGRATION_MANIFEST_INVALID')
  }
  const result = new Map()
  for (const policy of policies) {
    if (!isPlainRecord(policy)) {
      throw cutoverError('MIGRATION_MANIFEST_INVALID')
    }
    const connectionId = identifier(policy.connectionId)
    if (result.has(connectionId)) {
      throw cutoverError('MIGRATION_MANIFEST_INVALID')
    }
    result.set(connectionId, {
      enabled: booleanValue(policy.enabled),
      browserEnabled: booleanValue(policy.browserEnabled),
      serverEnabled: booleanValue(policy.serverEnabled),
      serverTargetPercentage: percentage(
        policy.serverTargetPercentage,
      ),
      serverEffectivePercentage: percentage(
        policy.serverEffectivePercentage,
      ),
      circuitState: circuitState(policy.circuitState),
    })
  }
  return result
}

function groupBindings(rows) {
  const grouped = new Map()
  for (const row of requiredRows(rows)) {
    const connectionId = identifier(row.connection_id)
    const current = grouped.get(connectionId) ?? []
    current.push({
      canonicalEvent: canonicalEvent(row.canonical_event),
      enabled: booleanInteger(row.enabled),
      browserDestination: safeText(row.browser_destination),
      serverDestination: safeText(row.server_destination),
    })
    grouped.set(connectionId, current)
  }
  for (const [connectionId, bindings] of grouped) {
    grouped.set(
      connectionId,
      bindings.sort((left, right) =>
        left.canonicalEvent.localeCompare(right.canonicalEvent)),
    )
  }
  return grouped
}

function summaryResult(input) {
  const history = historySummary(input.historyDaily)
  return {
    connections: input.connections,
    managedSources: input.managedSources,
    history,
    pendingDeliveries: idSummary(input.pendingDeliveries ?? []),
    incidents: {
      openCriticalCount: requiredRows(
        input.openCriticalIncidents ?? [],
      ).length,
    },
    privacyPolicyHash: privacyPolicyHash(input.privacyPolicy),
  }
}

function historySummary(rows) {
  const normalized = rows
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  return {
    rowCount: normalized.length,
    factCount: normalized.reduce(
      (sum, row) => sum + row.factCount,
      0,
    ),
    contentHash: digest(normalized),
  }
}

function idSummary(rows) {
  const ids = requiredRows(rows)
    .map(row => identifier(row.id))
    .sort()
  return {
    count: ids.length,
    idSetHash: digest(ids),
  }
}

function historyRow(row) {
  return {
    date: dateValue(row.date),
    eventName: canonicalEvent(row.event_name),
    factOrigin: historyOrigin(row.fact_origin),
    provider: nullableProvider(
      row.provider === 'none' ? null : row.provider,
    ) ?? 'none',
    attributionSource: safeText(row.attribution_source),
    factCount: positiveInteger(row.fact_count),
    firstOccurredAt: canonicalTimestamp(row.first_occurred_at),
    lastOccurredAt: canonicalTimestamp(row.last_occurred_at),
  }
}

function privacyPolicyHash(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw cutoverError('PRIVACY_POLICY_INVALID')
  }
  const row = rows[0]
  const countries = jsonValue(row.prior_consent_country_codes_json)
  if (
    !Array.isArray(countries)
    || countries.some(country =>
      typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))
  ) {
    throw cutoverError('PRIVACY_POLICY_INVALID')
  }
  return digest({
    defaultMode: privacyMode(row.default_mode),
    priorConsentCountryCodes: [...new Set(countries)].sort(),
    policyVersion: positiveInteger(row.policy_version),
    updatedAt: canonicalTimestamp(row.updated_at),
  })
}

export function compareReceipt(receipt, oldRows, rows) {
  const initialCounts = receipt.phase === 'initial'
    ? {
        connections: rows.connections.length,
        versions: rows.connections.length,
        credentials: rows.connections.length,
        bindings: rows.bindings.length,
      }
    : {
        connections: 0,
        versions: 0,
        credentials: 0,
        bindings: 0,
      }
  const counts = {
    ...initialCounts,
    managedSources: rows.managedSources.length,
    historyRows: rows.historyDaily.length,
    historyFacts: rows.historyDaily.reduce(
      (total, row) => total + positiveInteger(row.fact_count),
      0,
    ),
  }
  const mismatches = Object.keys(counts).filter(
    key => counts[key] !== receipt.counts[key],
  )
  const manifest = requiredManifest(rows.migrationManifest)
  if (
    manifest.source_configuration_hash
      !== receipt.sourceConfigurationHash
    || manifest.credential_set_hash !== receipt.credentialSetHash
    || sourceConfigurationHash(oldRows)
      !== receipt.sourceConfigurationHash
  ) {
    mismatches.push('configurationHash')
  }
  if (
    targetCredentialSetHash(rows.connections)
      !== receipt.credentialSetHash
  ) {
    mismatches.push('credentialSetHash')
  }
  if (requiredRows(rows.activeLiveFacts).length !== 0) {
    mismatches.push('activeLiveFacts')
  }
  if (
    receipt.phase === 'initial'
      ? (
        manifest.initial_run_id !== receipt.runId
        || manifest.initial_snapshot_hash !== receipt.snapshotHash
        || manifest.status !== 'initial_imported'
      )
      : (
        manifest.reconcile_run_id !== receipt.runId
        || manifest.reconcile_snapshot_hash !== receipt.snapshotHash
        || manifest.status !== 'reconciled'
        || manifest.reconciled_captured_at !== receipt.capturedAt
      )
  ) {
    mismatches.push('manifest')
  }
  return {
    matched: mismatches.length === 0,
    mismatches,
  }
}

function requiredManifest(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw cutoverError('MIGRATION_MANIFEST_INVALID')
  }
  return rows[0]
}

export function sourceConfigurationHash(rows) {
  const policyRows = requiredRows(rows.privacyPolicy)
  if (policyRows.length !== 1) {
    throw cutoverError('PRIVACY_POLICY_INVALID')
  }
  const policy = policyRows[0]
  const countries = jsonValue(
    policy.prior_consent_country_codes_json,
  )
  if (!Array.isArray(countries)) {
    throw cutoverError('PRIVACY_POLICY_INVALID')
  }
  return digestHex(stableJson({
    connections: requiredRows(rows.connections).map(row => ({
      id: row.id,
      provider: row.provider,
      enabled: row.enabled,
      mode: row.mode,
      browserEnabled: row.browser_enabled,
      serverEnabled: row.server_enabled,
      publicConfig: jsonValue(row.public_config_json),
      attributionWindowDays: row.attribution_window_days,
      rolloutTargetPercentage: row.rollout_target_percentage,
      rolloutEffectivePercentage: row.rollout_effective_percentage,
      credentialRevision: row.credential_revision,
    })),
    bindings: requiredRows(rows.bindings),
    credentials: requiredRows(rows.credentials),
    privacyPolicy: {
      defaultMode: policy.default_mode,
      priorConsentCountryCodes: [...new Set(countries)].sort(),
      policyVersion: policy.policy_version,
    },
  }))
}

function targetCredentialSetHash(rows) {
  return digestHex(stableJson(requiredRows(rows)
    .map(row => ({
      connectionId: identifier(row.id),
      fingerprint: publicDigest(row.credential_fingerprint),
    }))
    .sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId))))
}

function uniqueConnectionByProvider(connections) {
  const result = new Map()
  for (const connection of connections) {
    if (result.has(connection.provider)) {
      throw cutoverError('PROVIDER_CONNECTION_AMBIGUOUS')
    }
    result.set(connection.provider, connection.id)
  }
  return result
}

function createD1Query(packageName, database, options) {
  return async sql => {
    const runCommand = options.runCommand ?? runRawCommand
    const result = await runCommand('corepack', [
      'pnpm',
      '--filter',
      packageName,
      'exec',
      'wrangler',
      'd1',
      'execute',
      database,
      '--env',
      '',
      '--remote',
      '--command',
      compactSql(sql),
      '--json',
    ], {
      cwd: options.cwd ?? ROOT_DIR,
    })
    if (result?.status !== 'passed') {
      throw cutoverError('D1_QUERY_FAILED')
    }
    return parseD1Rows(result.stdout)
  }
}

export function parseD1Rows(output) {
  const trimmed = String(output ?? '').trim()
  const jsonStart = trimmed.search(/[\[{]/)
  if (jsonStart < 0) throw cutoverError('D1_RESPONSE_INVALID')
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart))
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const rows = first?.results ?? first?.result?.results
    if (!Array.isArray(rows)) throw new Error('missing rows')
    return rows
  } catch {
    throw cutoverError('D1_RESPONSE_INVALID')
  }
}

async function runRawCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = []
    let size = 0
    let overflow = false
    child.stdout.on('data', chunk => {
      size += chunk.byteLength
      if (size > MAX_COMMAND_OUTPUT_BYTES) {
        overflow = true
        child.kill()
        return
      }
      output.push(chunk)
    })
    child.stderr.resume()
    child.once('error', () => {
      resolve({ status: 'failed', stdout: '' })
    })
    child.once('close', code => {
      resolve({
        status: code === 0 && !overflow ? 'passed' : 'failed',
        stdout: Buffer.concat(output).toString('utf8'),
      })
    })
  })
}

function integerCell(rows, key) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw cutoverError('D1_RESPONSE_INVALID')
  }
  return nonNegativeInteger(rows[0]?.[key])
}

function nullablePositiveIntegerCell(rows, key) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw cutoverError('D1_RESPONSE_INVALID')
  }
  return nullablePositiveInteger(rows[0]?.[key])
}

function stringCell(rows, key) {
  if (
    !Array.isArray(rows)
    || rows.length !== 1
    || typeof rows[0]?.[key] !== 'string'
  ) {
    throw cutoverError('D1_RESPONSE_INVALID')
  }
  return rows[0][key]
}

function validCounts(value) {
  if (!isPlainRecord(value)) return false
  return [
    'connections',
    'versions',
    'credentials',
    'bindings',
    'managedSources',
    'historyRows',
    'historyFacts',
  ].every(key =>
    Number.isSafeInteger(value[key])
    && value[key] >= 0)
}

function requiredRows(value) {
  if (!Array.isArray(value)) throw cutoverError('ROWS_INVALID')
  return value
}

function sortedById(rows) {
  return rows.sort((left, right) => left.id.localeCompare(right.id))
}

function digest(value) {
  return `sha256:${digestHex(stableJson(value))}`
}

function digestHex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isPlainRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

function jsonValue(value) {
  if (typeof value !== 'string') {
    if (Array.isArray(value) || isPlainRecord(value)) return sortJson(value)
    throw cutoverError('JSON_INVALID')
  }
  try {
    return sortJson(JSON.parse(value))
  } catch {
    throw cutoverError('JSON_INVALID')
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw cutoverError('IDENTIFIER_INVALID')
  }
  return value
}

function safeText(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 1_000
    || /\p{Cc}/u.test(value)
  ) {
    throw cutoverError('TEXT_INVALID')
  }
  return value
}

function optionalText(value) {
  if (
    typeof value !== 'string'
    || value.length > 1_000
    || /\p{Cc}/u.test(value)
  ) {
    throw cutoverError('TEXT_INVALID')
  }
  return value
}

function providerValue(value) {
  if (!['meta', 'tiktok', 'google'].includes(value)) {
    throw cutoverError('PROVIDER_INVALID')
  }
  return value
}

function nullableProvider(value) {
  return value === null ? null : providerValue(value)
}

function canonicalEvent(value) {
  if (!['Contact', 'CompleteRegistration'].includes(value)) {
    throw cutoverError('EVENT_INVALID')
  }
  return value
}

function historyOrigin(value) {
  if (!['historical_backfill', 'archived_live'].includes(value)) {
    throw cutoverError('HISTORY_ORIGIN_INVALID')
  }
  return value
}

function privacyMode(value) {
  if (!['notice_opt_out', 'prior_consent', 'disabled'].includes(value)) {
    throw cutoverError('PRIVACY_POLICY_INVALID')
  }
  return value
}

function circuitState(value) {
  if (!['closed', 'server_open'].includes(value)) {
    throw cutoverError('CIRCUIT_STATE_INVALID')
  }
  return value
}

function percentage(value) {
  const parsed = Number(value)
  if (![0, 10, 50, 100].includes(parsed)) {
    throw cutoverError('PERCENTAGE_INVALID')
  }
  return parsed
}

function booleanInteger(value) {
  if (value !== 0 && value !== 1) {
    throw cutoverError('BOOLEAN_INVALID')
  }
  return value === 1
}

function booleanValue(value) {
  if (typeof value !== 'boolean') {
    throw cutoverError('BOOLEAN_INVALID')
  }
  return value
}

function nonNegativeInteger(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw cutoverError('INTEGER_INVALID')
  }
  return parsed
}

function positiveInteger(value) {
  const parsed = nonNegativeInteger(value)
  if (parsed < 1) throw cutoverError('INTEGER_INVALID')
  return parsed
}

function nullablePositiveInteger(value) {
  return value === null ? null : positiveInteger(value)
}

function publicDigest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw cutoverError('DIGEST_INVALID')
  }
  return value
}

function proofValue(value) {
  return publicDigest(value)
}

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw cutoverError('DATE_INVALID')
  }
  return value
}

function canonicalTimestamp(value) {
  if (!isCanonicalTimestamp(value)) {
    throw cutoverError('TIMESTAMP_INVALID')
  }
  return value
}

function nullableTimestamp(value) {
  return value === null ? null : canonicalTimestamp(value)
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
}

function sqlTimestamp(value) {
  return canonicalTimestamp(value)
}

function compactSql(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cutoverError(suffix) {
  return new Error(`ATTRIBUTION_CUTOVER_${suffix}`)
}

async function main() {
  try {
    const result = await runCutoverVerification()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const code = error instanceof Error
      && /^ATTRIBUTION_CUTOVER_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'ATTRIBUTION_CUTOVER_UNKNOWN_ERROR'
    process.stdout.write(`${JSON.stringify({
      status: 'failed',
      code,
    })}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
