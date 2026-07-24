import type { AttributionBindings } from './env'
import { enforceCredentialRetention } from './services/credential-retention'

export type AttributionMaintenanceBindings = Pick<AttributionBindings, 'DB'>

export async function runAttributionMaintenance(
  env: AttributionMaintenanceBindings,
  now: Date,
): Promise<{ deleted: number; scheduled: number }> {
  return enforceCredentialRetention(env.DB, now)
}
