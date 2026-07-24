import { enforceCredentialRetention } from './services/credential-retention'
import {
  purgeExpiredServerOutbox,
  recoverPendingServerOutbox,
  type AttributionProviderQueues,
  type OutboxRecoveryResult,
} from './services/secure-outbox'

export interface AttributionMaintenanceEnvironment {
  db: D1Database
  queues: AttributionProviderQueues
}

export type AttributionMaintenanceTask =
  | 'queue'
  | 'credentials'
  | 'all'

export interface AttributionMaintenanceResult {
  credentialRetention: {
    deleted: number
    scheduled: number
  } | null
  outboxRecovery: OutboxRecoveryResult | null
  expiredOutbox: number | null
}

export async function runAttributionMaintenance(
  environment: AttributionMaintenanceEnvironment,
  now: Date,
  task: AttributionMaintenanceTask = 'all',
): Promise<AttributionMaintenanceResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('ATTRIBUTION_MAINTENANCE_NOW_INVALID')
  }
  const runCredentials = task === 'credentials' || task === 'all'
  const runQueue = task === 'queue' || task === 'all'
  const credentialRetention = runCredentials
    ? await enforceCredentialRetention(environment.db, now)
    : null
  const expiredOutbox = runQueue
    ? await purgeExpiredServerOutbox(environment.db, now)
    : null
  const outboxRecovery = runQueue
    ? await recoverPendingServerOutbox({
        db: environment.db,
        queues: environment.queues,
        now: () => now,
      })
    : null
  return {
    credentialRetention,
    outboxRecovery,
    expiredOutbox,
  }
}
