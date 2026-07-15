export const ATTRIBUTION_TABLE_NAMES = [
  'attribution_platform_connections',
  'attribution_event_bindings',
  'attribution_credentials',
  'attribution_conversion_facts',
  'attribution_deliveries',
  'attribution_outbox',
  'attribution_provider_receipts',
  'attribution_verifications',
  'attribution_incidents',
  'attribution_quality_snapshots',
  'attribution_usage_daily',
] as const

export type AttributionTableName = typeof ATTRIBUTION_TABLE_NAMES[number]
