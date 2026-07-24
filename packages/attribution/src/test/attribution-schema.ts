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
] as const

const DELETE_ORDER = [
  'attribution_activation_fences',
  'attribution_version_credentials',
  'attribution_version_bindings',
  'attribution_runtime_policies',
  'attribution_connection_versions',
  'attribution_command_receipts',
  'attribution_audit_logs',
  'attribution_incidents',
  'attribution_connections',
] as const

export async function clearAttributionRuntimeDatabase(
  db: D1Database,
): Promise<void> {
  await db.exec(DELETE_ORDER.map(table => `DELETE FROM ${table}`).join(';'))
}
