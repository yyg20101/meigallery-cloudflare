import type { AttributionEncryptionKeys } from './security/data-envelope'
import {
  readCapacityGate,
  type CapacityGate,
} from './services/capacity-monitor'
import { enforceCredentialRetention } from './services/credential-retention'
import {
  collectQualitySignals,
  type QualityCollectionResult,
} from './services/quality-collector'
import {
  purgeExpiredServerOutbox,
  recoverPendingServerOutbox,
  type AttributionProviderQueues,
  type OutboxRecoveryResult,
} from './services/secure-outbox'
import { retireDrainedVersions } from './services/version-retirement'

export interface AttributionMaintenanceEnvironment {
  db: D1Database
  queues: AttributionProviderQueues
  credentialMasterKeys: AttributionEncryptionKeys
}

export type AttributionMaintenanceTask =
  | 'interval'
  | 'daily'
  | 'all'

export interface AttributionMaintenanceResult {
  versionRetirement: {
    retired: number
  } | null
  credentialRetention: {
    deleted: number
    scheduled: number
  } | null
  outboxRecovery: OutboxRecoveryResult | null
  expiredOutbox: number | null
  capacityGate: CapacityGate | null
  qualityCollection: QualityCollectionResult | null
  failures: string[]
}

export async function runAttributionMaintenance(
  environment: AttributionMaintenanceEnvironment,
  now: Date,
  task: AttributionMaintenanceTask = 'all',
): Promise<AttributionMaintenanceResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('ATTRIBUTION_MAINTENANCE_NOW_INVALID')
  }
  const runInterval = task === 'interval' || task === 'all'
  const runDaily = task === 'daily' || task === 'all'
  const failures: string[] = []
  const versionRetirement = runInterval
    ? await maintenanceStep(
        environment.db,
        now,
        'version_retirement_failed',
        failures,
        () => retireDrainedVersions(environment.db, now),
      )
    : null
  const expiredOutbox = runInterval
    ? await maintenanceStep(
        environment.db,
        now,
        'expired_outbox_purge_failed',
        failures,
        () => purgeExpiredServerOutbox(environment.db, now),
      )
    : null
  const outboxRecovery = runInterval
    ? await maintenanceStep(
        environment.db,
        now,
        'outbox_recovery_failed',
        failures,
        () => recoverPendingServerOutbox({
          db: environment.db,
          queues: environment.queues,
          now: () => now,
        }),
      )
    : null
  const credentialRetention = runInterval
    ? await maintenanceStep(
        environment.db,
        now,
        'credential_retention_failed',
        failures,
        () => enforceCredentialRetention(environment.db, now),
      )
    : null
  const capacityGate = runDaily
    ? await maintenanceStep(
        environment.db,
        now,
        'capacity_gate_read_failed',
        failures,
        () => readCapacityGate(
          environment.db,
          now.toISOString().slice(0, 10),
        ),
      )
    : null
  const qualityCollection = runDaily
    && (!capacityGate?.observed || capacityGate.allowNonEssential)
    ? await maintenanceStep(
        environment.db,
        now,
        'quality_collection_failed',
        failures,
        () => collectQualitySignals({
          db: environment.db,
          credentialMasterKeys: environment.credentialMasterKeys,
        }, now),
      )
    : null
  return {
    versionRetirement,
    credentialRetention,
    outboxRecovery,
    expiredOutbox,
    capacityGate,
    qualityCollection,
    failures,
  }
}

async function maintenanceStep<T>(
  db: D1Database,
  now: Date,
  code: string,
  failures: string[],
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation()
  } catch {
    failures.push(code)
    await recordMaintenanceIncident(db, now, code)
    return null
  }
}

async function recordMaintenanceIncident(
  db: D1Database,
  now: Date,
  code: string,
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO attribution_incidents (
        id,
        provider,
        connection_id,
        severity,
        status,
        code,
        affected_transport,
        opened_at,
        detected_at
      ) VALUES (?, 'system', NULL, 'warning', 'open', ?, 'all', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'open',
        detected_at = excluded.detected_at,
        resolved_at = NULL,
        resolution = ''
    `).bind(
      `maintenance:${code}`,
      code,
      now.toISOString(),
      now.toISOString(),
    ).run()
  } catch {
    // 维护步骤已经隔离；Incident 写入失败不能阻断后续恢复任务。
  }
}
