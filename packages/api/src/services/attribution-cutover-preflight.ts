import type {
  AttributionRuntimeReadiness,
  AttributionServiceClient,
} from './attribution-service-client'
import {
  readAttributionRuntimeOwner,
  type AttributionRuntimeOwner,
  type AttributionRuntimeOwnerState,
} from './attribution-runtime-owner'

export type AttributionCutoverTargetOwner = 'draining' | 'new'

export interface AttributionCutoverPreflightCounts {
  missingRegistrationFacts: number
  oldBusinessOutboxPending: number
  oldServerWorkPending: number
  oldEncryptedOutboxPending: number
}

export interface AttributionCutoverPreflight {
  current: AttributionRuntimeOwnerState
  targetOwner: AttributionCutoverTargetOwner
  targetEpoch: number
  remote: AttributionRuntimeReadiness
  checks: {
    ownerSequenceReady: boolean
    migrationReconciled: boolean
    remoteModeReady: boolean
    remoteEpochReady: boolean
    registrationFactsReady: boolean
    oldBusinessOutboxReady: boolean
    oldServerWorkReady: boolean
    oldEncryptedOutboxReady: boolean
  }
  counts: AttributionCutoverPreflightCounts
  localReady: boolean
  ready: boolean
}

export interface AttributionRestorePreflight {
  current: AttributionRuntimeOwnerState
  restoredEpoch: number
  remote: AttributionRuntimeReadiness
  pendingForwardBusinessOutbox: number
  checks: {
    ownerRestorable: boolean
    migrationReconciled: boolean
    remoteOwnershipReady: boolean
    remoteFenced: boolean
    remoteInFlightDrained: boolean
    forwardBusinessOutboxDrained: boolean
  }
  safeToFence: boolean
  ready: boolean
}

interface CountRow {
  value: number
}

const NEXT_OWNER: Readonly<
  Record<AttributionRuntimeOwner, AttributionRuntimeOwner | null>
> = Object.freeze({
  old: 'draining',
  draining: 'new',
  new: null,
})

export async function readAttributionCutoverPreflight(
  db: D1Database,
  client: Pick<AttributionServiceClient, 'readRuntimeState'>,
  targetOwner: AttributionCutoverTargetOwner,
): Promise<AttributionCutoverPreflight> {
  const [current, remote, counts] = await Promise.all([
    readAttributionRuntimeOwner(db),
    client.readRuntimeState(),
    readCutoverCounts(db, targetOwner),
  ])
  const sameOwner = current.owner === targetOwner
  const targetEpoch = sameOwner ? current.epoch : current.epoch + 1
  const ownerSequenceReady =
    sameOwner || NEXT_OWNER[current.owner] === targetOwner
  const remoteModeReady = targetOwner === 'draining'
    ? (
      remote.mode === 'bridge'
      || (
        sameOwner
        && remote.mode === 'active'
      )
    )
    : remote.mode === 'active'
  const remoteEpochReady = targetOwner === 'draining'
    ? remote.bridgeOwnerEpoch === targetEpoch
    : remote.activeOwnerEpoch === targetEpoch
  const registrationFactsReady =
    counts.missingRegistrationFacts === 0
  const oldBusinessOutboxReady =
    counts.oldBusinessOutboxPending === 0
  const oldServerWorkReady = targetOwner === 'draining'
    || counts.oldServerWorkPending === 0
  const oldEncryptedOutboxReady = targetOwner === 'draining'
    || counts.oldEncryptedOutboxPending === 0
  const checks = {
    ownerSequenceReady,
    migrationReconciled: remote.migrationReconciled,
    remoteModeReady,
    remoteEpochReady,
    registrationFactsReady,
    oldBusinessOutboxReady,
    oldServerWorkReady,
    oldEncryptedOutboxReady,
  }
  const localReady = Object.entries(checks)
    .filter(([key]) =>
      key !== 'remoteModeReady' && key !== 'remoteEpochReady')
    .every(([, value]) => value)

  return {
    current,
    targetOwner,
    targetEpoch,
    remote,
    checks,
    counts,
    localReady,
    ready: Object.values(checks).every(Boolean),
  }
}

export async function readAttributionRestorePreflight(
  db: D1Database,
  client: Pick<AttributionServiceClient, 'readRuntimeState'>,
): Promise<AttributionRestorePreflight> {
  const [current, remote, pendingRow] = await Promise.all([
    readAttributionRuntimeOwner(db),
    client.readRuntimeState(),
    db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_business_outbox
      WHERE routing_owner IN ('draining', 'new')
        AND status IN ('pending', 'dispatching')
    `).first<CountRow>(),
  ])
  if (!isCount(pendingRow?.value)) {
    throw new Error('ATTRIBUTION_RESTORE_PREFLIGHT_INVALID')
  }
  const pendingForwardBusinessOutbox = Number(pendingRow?.value)
  const restoredEpoch = current.owner === 'old'
    ? current.epoch
    : current.epoch + 1
  const remoteFenced = remote.mode === 'fenced'
    && remote.fencedOwnerEpoch === restoredEpoch
  const remoteOwnershipReady = remoteFenced || (
    current.owner === 'draining'
      ? (
        (remote.mode === 'bridge' || remote.mode === 'active')
        && remote.bridgeOwnerEpoch === current.epoch
      )
      : current.owner === 'new'
        ? (
          remote.mode === 'active'
          && remote.activeOwnerEpoch === current.epoch
        )
        : current.owner === 'old'
          ? (
            remote.mode === 'active'
            && remote.activeOwnerEpoch === current.epoch
          )
          : false
  )
  const checks = {
    ownerRestorable: current.owner !== 'old' || remoteFenced,
    migrationReconciled: remote.migrationReconciled,
    remoteOwnershipReady,
    remoteFenced,
    remoteInFlightDrained:
      remote.inFlightServerDeliveries === 0,
    forwardBusinessOutboxDrained:
      pendingForwardBusinessOutbox === 0,
  }
  const safeToFence = checks.ownerRestorable
    && checks.migrationReconciled
    && checks.remoteOwnershipReady
    && checks.remoteInFlightDrained
    && checks.forwardBusinessOutboxDrained
  return {
    current,
    restoredEpoch,
    remote,
    pendingForwardBusinessOutbox,
    checks,
    safeToFence,
    ready: Object.values(checks).every(Boolean),
  }
}

async function readCutoverCounts(
  db: D1Database,
  targetOwner: AttributionCutoverTargetOwner,
): Promise<AttributionCutoverPreflightCounts> {
  const registrationPredicate = targetOwner === 'draining'
    ? ''
    : `
      AND EXISTS (
        SELECT 1
        FROM attribution_business_outbox AS old_outbox
        WHERE old_outbox.routing_owner = 'old'
          AND CAST(json_extract(
            old_outbox.payload_json,
            '$.payload.userId'
          ) AS INTEGER) = users.id
      )
    `
  const results = await db.batch<CountRow>([
    db.prepare(`
      SELECT COUNT(*) AS value
      FROM users
      WHERE NOT EXISTS (
        SELECT 1
        FROM attribution_conversion_facts AS fact
        WHERE fact.canonical_event = 'CompleteRegistration'
          AND CAST(json_extract(
            fact.analytics_dimensions_json,
            '$.userId'
          ) AS INTEGER) = users.id
      )
      ${registrationPredicate}
    `),
    db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_business_outbox
      WHERE (
          (
            ? = 'draining'
            AND routing_owner = 'old'
          )
          OR (
            ? = 'new'
            AND routing_owner IN ('old', 'draining', 'new')
          )
        )
        AND status IN ('pending', 'dispatching')
    `).bind(targetOwner, targetOwner),
    db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_deliveries
      WHERE transport = 'server'
        AND (
          status IN ('planned', 'queued', 'retrying', 'dead_letter')
          OR (provider = 'google' AND status = 'accepted')
        )
    `),
    db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_outbox
    `),
  ])
  if (
    results.length !== 4
    || results.some(result => !isCount(result.results?.[0]?.value))
  ) {
    throw new Error('ATTRIBUTION_CUTOVER_PREFLIGHT_INVALID')
  }
  return {
    missingRegistrationFacts: Number(results[0]!.results![0]!.value),
    oldBusinessOutboxPending: Number(results[1]!.results![0]!.value),
    oldServerWorkPending: Number(results[2]!.results![0]!.value),
    oldEncryptedOutboxPending: Number(results[3]!.results![0]!.value),
  }
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
