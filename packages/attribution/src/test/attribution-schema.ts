export const ATTRIBUTION_RUNTIME_TABLES = [
  'attribution_connections',
  'attribution_connection_versions',
  'attribution_version_credentials',
  'attribution_version_bindings',
  'attribution_runtime_policies',
  'attribution_command_receipts',
  'attribution_activation_fences',
  'attribution_audit_logs',
  'attribution_incidents',
  'attribution_circuit_observations',
] as const

export const ATTRIBUTION_EVENT_TABLES = [
  'attribution_managed_sources',
  'attribution_contexts',
  'attribution_facts',
  'attribution_deliveries',
  'attribution_outbox',
  'attribution_browser_receipts',
  'attribution_delivery_receipts',
  'attribution_validations',
  'attribution_validation_secrets',
  'attribution_quality_daily',
  'attribution_privacy_policy',
] as const

const DELETE_ORDER = [
  'attribution_browser_receipts',
  'attribution_delivery_receipts',
  'attribution_outbox',
  'attribution_deliveries',
  'attribution_facts',
  'attribution_contexts',
  'attribution_managed_sources',
  'attribution_validation_secrets',
  'attribution_validations',
  'attribution_quality_daily',
  'attribution_privacy_policy',
  'attribution_activation_fences',
  'attribution_version_credentials',
  'attribution_version_bindings',
  'attribution_runtime_policies',
  'attribution_connection_versions',
  'attribution_command_receipts',
  'attribution_audit_logs',
  'attribution_incidents',
  'attribution_circuit_observations',
  'attribution_connections',
] as const

export async function clearAttributionRuntimeDatabase(
  db: D1Database,
): Promise<void> {
  const rows = await db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name LIKE 'attribution_%'
  `).all<{ name: string }>()
  const existingTables = new Set(rows.results.map(row => row.name))
  const statements = DELETE_ORDER
    .filter(table => existingTables.has(table))
    .map(table => `DELETE FROM ${table}`)

  if (statements.length > 0) {
    await db.exec(statements.join(';'))
  }
}
