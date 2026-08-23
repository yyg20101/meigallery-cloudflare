import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import {
  AppDataRightsError,
  type AppDataRightsRequestRow,
} from './app-data-rights'
import { cancelPendingAppMessageModerationCasesForAccount } from './app-message-moderation'
import { disconnectAppRealtimeAccount } from './app-realtime'
import {
  countAppRecommendationEvidenceForAccount,
  isRecommendationEvidenceSigningSecretReady,
  purgeAppRecommendationEvidenceForAccount,
} from './app-recommendation-evidence'

export const APP_DATA_RIGHTS_DELETION_QUEUE_NAME = 'meigallery-app-data-rights-deletion'

const DELETION_MESSAGE_KIND = 'app_data_rights_deletion'
const EXECUTION_ID = /^drde_[A-Za-z0-9_-]{1,91}$/u
const MAX_QUEUE_ATTEMPTS = 5
const LEASE_TTL_MS = 2 * 60_000
const RECOVERY_LIMIT = 100

export type AppDataRightsDeletionQueueMessage = {
  schemaVersion: 1
  kind: typeof DELETION_MESSAGE_KIND
  executionId: string
}

type DeletionEnvironment = Pick<
  Bindings,
  | 'DB'
  | 'R2'
  | 'DATA_RIGHTS_DELETION_QUEUE'
  | 'DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT'
  | 'DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS'
  | 'APP_REALTIME_HUB'
  | 'SESSION_SECRET'
>

type DeletionDisposition =
  | 'delete'
  | 'anonymize'
  | 'revoke'
  | 'close'
  | 'retain_isolated'
  | 'external_purge'

type DeletionProfileRow = {
  id: string
  policy_id: string
  version_code: string
  state: 'development' | 'published' | 'retired'
  production_ready: number
  schema_version: number
  executor_version: string
  expected_step_count: number
  retention_decision_status: 'unresolved' | 'approved'
  backup_decision_status: 'unresolved' | 'approved'
  third_party_decision_status: 'unresolved' | 'approved'
  identity_reuse_decision_status: 'unresolved' | 'approved'
  evidence_decision_status: 'unresolved' | 'approved'
  identity_reuse_mode: 'unresolved' | 'release' | 'seal'
  identity_seal_days: number | null
  retention_policy_reference: string | null
  backup_policy_reference: string | null
  third_party_policy_reference: string | null
  identity_reuse_policy_reference: string | null
  evidence_policy_reference: string | null
  policy_state: string
  policy_production_ready: number
  policy_deletion_requests_enabled: number
  policy_deletion_processing_enabled: number
}

type DeletionProfileStepRow = {
  profile_id: string
  ordinal: number
  step_code: string
  handler_code: string
  disposition: DeletionDisposition
  decision_status: 'unresolved' | 'approved'
  governance_reference: string | null
}

type DeletionExecutionRow = {
  id: string
  request_id: string
  request_version_snapshot: number
  account_id: number
  profile_id: string
  profile_version_snapshot: string
  executor_version_snapshot: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  version: number
  execution_token: string
  current_step_ordinal: number
  expected_step_count: number
  completed_step_count: number
  attempt_count: number
  lease_token: string | null
  lease_expires_at: string | null
  last_error_code: string | null
  started_at: string | null
  completed_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
  request_status: string
  current_request_version: number
  request_mutation_token: string
  account_public_id: string
}

type DeletionStepRow = {
  execution_id: string
  ordinal: number
  step_code: string
  handler_code: string
  disposition_snapshot: DeletionDisposition
  governance_reference_snapshot: string
  status: 'pending' | 'processing' | 'completed'
  attempt_count: number
  initial_item_count: number | null
  final_item_count: number | null
  affected_item_count: number | null
  evidence_digest: string | null
  started_at: string | null
  completed_at: string | null
}

type ClaimedDeletionState = {
  execution: DeletionExecutionRow
  profile: DeletionProfileRow
  step: DeletionStepRow | null
}

type QueueMessageLike = {
  body: unknown
  attempts: number
  ack?: () => void
  retry?: (options?: { delaySeconds?: number }) => void
}

type HandlerResult = {
  finalItemCount: number
  safeDetails?: Record<string, string | number | boolean | null>
}

class FatalDeletionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const DELETION_STEPS = [
  { code: 'revoke_access', disposition: 'revoke' },
  { code: 'purge_private_exports', disposition: 'external_purge' },
  { code: 'purge_notifications', disposition: 'delete' },
  { code: 'purge_discovery_activity', disposition: 'delete' },
  { code: 'purge_account_preferences', disposition: 'delete' },
  { code: 'anonymize_analytics', disposition: 'anonymize' },
  { code: 'close_managed_conversations', disposition: 'close' },
  { code: 'isolate_regulated_records', disposition: 'retain_isolated' },
  { code: 'tombstone_account', disposition: 'anonymize' },
] as const satisfies readonly { code: string; disposition: DeletionDisposition }[]

export async function resolveAppDataRightsDeletionExecutorReadiness(
  env: DeletionEnvironment,
  policyId: string,
) {
  const profile = await loadDeletionProfile(env.DB, policyId)
  if (!profile) return deletionNotReady(null, 'deletion_profile_missing')
  if (
    profile.policy_state !== 'published'
    || profile.policy_production_ready !== 1
    || profile.policy_deletion_requests_enabled !== 1
    || profile.policy_deletion_processing_enabled !== 1
  ) return deletionNotReady(profile, 'deletion_policy_gate_closed')
  if (profile.state !== 'published' || profile.production_ready !== 1) {
    return deletionNotReady(profile, 'deletion_profile_not_published')
  }
  const governanceApproved = [
    profile.retention_decision_status,
    profile.backup_decision_status,
    profile.third_party_decision_status,
    profile.identity_reuse_decision_status,
    profile.evidence_decision_status,
  ].every(value => value === 'approved')
  if (!governanceApproved || profile.identity_reuse_mode === 'unresolved') {
    return deletionNotReady(profile, 'deletion_governance_unresolved')
  }
  const steps = await loadDeletionProfileSteps(env.DB, profile.id)
  if (!deletionStepsMatch(steps, profile.expected_step_count)) {
    return deletionNotReady(profile, 'deletion_step_contract_mismatch')
  }
  if (!env.DATA_RIGHTS_DELETION_QUEUE) {
    return deletionNotReady(profile, 'deletion_queue_binding_missing')
  }
  if (!isRecommendationEvidenceSigningSecretReady(env.SESSION_SECRET)) {
    return deletionNotReady(profile, 'recommendation_evidence_signing_secret_missing')
  }
  if (
    profile.identity_reuse_mode === 'seal'
    && !validRetentionMasterKey(env.DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT)
  ) return deletionNotReady(profile, 'deletion_retention_key_missing')
  return {
    ready: true,
    profileVersion: profile.version_code,
    executorVersion: profile.executor_version,
    identityReuseMode: profile.identity_reuse_mode,
    expectedSteps: profile.expected_step_count,
    reasonCode: null,
  }
}

export async function prepareAppDataRightsDeletionStart(
  env: DeletionEnvironment,
  request: AppDataRightsRequestRow,
  nextRequestVersion: number,
  nextMutationToken: string,
  timestamp: string,
): Promise<{ executionId: string; statements: D1PreparedStatement[] }> {
  if (request.request_type !== 'deletion') {
    throw new AppDataRightsError(409, 'DELETION_REQUEST_REQUIRED', '只有注销申请可以创建删除执行任务')
  }
  const profile = await requireReadyDeletionProfile(env, request.policy_id)
  const existing = await env.DB.prepare(`
    SELECT id, status
    FROM app_data_rights_deletion_executions
    WHERE request_id = ?
    LIMIT 1
  `).bind(request.id).first<{ id: string; status: string }>()
  if (existing) {
    if (!['failed', 'pending', 'processing'].includes(existing.status)) {
      throw new AppDataRightsError(409, 'DELETION_EXECUTION_TERMINAL', '注销执行任务已经结束')
    }
    const statements: D1PreparedStatement[] = []
    if (existing.status === 'failed') {
      statements.push(
        env.DB.prepare(`
          UPDATE app_data_rights_deletion_steps
          SET status = 'pending', started_at = NULL, updated_at = ?
          WHERE execution_id = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM app_data_rights_requests request
              WHERE request.id = ? AND request.status = 'processing'
                AND request.version = ? AND request.mutation_token = ?
            )
        `).bind(timestamp, existing.id, request.id, nextRequestVersion, nextMutationToken),
        env.DB.prepare(`
          UPDATE app_data_rights_deletion_executions
          SET request_version_snapshot = ?, status = 'pending', version = version + 1,
              lease_token = NULL, lease_expires_at = NULL,
              last_error_code = NULL, failed_at = NULL, updated_at = ?
          WHERE id = ? AND request_id = ? AND status = 'failed'
            AND profile_id = ?
            AND EXISTS (
              SELECT 1 FROM app_data_rights_requests request
              WHERE request.id = app_data_rights_deletion_executions.request_id
                AND request.status = 'processing' AND request.version = ?
                AND request.mutation_token = ?
            )
        `).bind(
          nextRequestVersion,
          timestamp,
          existing.id,
          request.id,
          profile.id,
          nextRequestVersion,
          nextMutationToken,
        ),
      )
    }
    return { executionId: existing.id, statements }
  }

  const executionId = generateId('drde')
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO app_data_rights_deletion_executions (
        id, request_id, request_version_snapshot, account_id,
        profile_id, profile_version_snapshot, executor_version_snapshot,
        status, version, execution_token, current_step_ordinal,
        expected_step_count, completed_step_count, attempt_count,
        created_at, updated_at
      )
      SELECT ?, request.id, request.version, request.account_id,
             ?, ?, ?, 'pending', 1, ?, 0, ?, 0, 0, ?, ?
      FROM app_data_rights_requests request
      WHERE request.id = ? AND request.request_type = 'deletion'
        AND request.status = 'processing' AND request.version = ?
        AND request.mutation_token = ?
    `).bind(
      executionId,
      profile.id,
      profile.version_code,
      profile.executor_version,
      crypto.randomUUID(),
      profile.expected_step_count,
      timestamp,
      timestamp,
      request.id,
      nextRequestVersion,
      nextMutationToken,
    ),
  ]
  const steps = await loadDeletionProfileSteps(env.DB, profile.id)
  for (const step of steps) {
    statements.push(env.DB.prepare(`
      INSERT INTO app_data_rights_deletion_steps (
        execution_id, ordinal, step_code, handler_code,
        disposition_snapshot, governance_reference_snapshot,
        status, attempt_count, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?
      WHERE EXISTS (
        SELECT 1 FROM app_data_rights_deletion_executions execution
        JOIN app_data_rights_requests request ON request.id = execution.request_id
        WHERE execution.id = ? AND execution.request_version_snapshot = ?
          AND request.status = 'processing' AND request.version = ?
          AND request.mutation_token = ?
      )
    `).bind(
      executionId,
      step.ordinal,
      step.step_code,
      step.handler_code,
      step.disposition,
      step.governance_reference!,
      timestamp,
      executionId,
      nextRequestVersion,
      nextRequestVersion,
      nextMutationToken,
    ))
  }
  return { executionId, statements }
}

export async function dispatchAppDataRightsDeletion(
  env: Pick<Bindings, 'DB' | 'DATA_RIGHTS_DELETION_QUEUE'>,
  requestId: string,
) {
  if (!env.DATA_RIGHTS_DELETION_QUEUE) {
    throw new AppDataRightsError(503, 'DELETION_QUEUE_UNAVAILABLE', '注销执行队列暂时不可用', true)
  }
  const execution = await env.DB.prepare(`
    SELECT id
    FROM app_data_rights_deletion_executions
    WHERE request_id = ? AND status IN ('pending', 'processing')
    LIMIT 1
  `).bind(requestId).first<{ id: string }>()
  if (!execution) {
    throw new AppDataRightsError(409, 'DELETION_EXECUTION_NOT_FOUND', '注销执行任务尚未创建')
  }
  await env.DATA_RIGHTS_DELETION_QUEUE.send(deletionQueueMessage(execution.id))
}

export async function handleAppDataRightsDeletionQueueBatch(
  batch: MessageBatch<AppDataRightsDeletionQueueMessage>,
  env: DeletionEnvironment,
): Promise<void> {
  for (const rawMessage of batch.messages as unknown as QueueMessageLike[]) {
    const message = parseDeletionQueueMessage(rawMessage.body)
    if (!message) {
      safeAck(rawMessage)
      continue
    }
    try {
      const outcome = await processNextDeletionStep(env, message)
      if (outcome === 'retry' && rawMessage.attempts < MAX_QUEUE_ATTEMPTS) safeRetry(rawMessage)
      else safeAck(rawMessage)
    }
    catch (error) {
      if (error instanceof FatalDeletionError || rawMessage.attempts >= MAX_QUEUE_ATTEMPTS) {
        await failAppDataRightsDeletion(
          env.DB,
          message.executionId,
          error instanceof FatalDeletionError ? error.code : 'queue_attempts_exhausted',
          new Date(),
        )
        safeAck(rawMessage)
      }
      else {
        safeRetry(rawMessage)
      }
    }
  }
}

async function processNextDeletionStep(
  env: DeletionEnvironment,
  message: AppDataRightsDeletionQueueMessage,
): Promise<'ack' | 'retry'> {
  const initial = await loadDeletionState(env.DB, message.executionId)
  if (!initial) return 'ack'
  if (initial.execution.request_status !== 'processing') return 'ack'
  if (initial.execution.status === 'completed' || initial.execution.status === 'failed') return 'ack'

  const readiness = await resolveAppDataRightsDeletionExecutorReadiness(env, initial.profile.policy_id)
  if (!readiness.ready || readiness.profileVersion !== initial.execution.profile_version_snapshot) {
    await failAppDataRightsDeletion(
      env.DB,
      initial.execution.id,
      'deletion_authorization_changed',
      new Date(),
    )
    return 'ack'
  }

  const claimed = await claimDeletionExecution(env.DB, initial, new Date())
  if (!claimed) return 'ack'
  try {
    if (claimed.execution.current_step_ordinal >= claimed.execution.expected_step_count) {
      await finalizeDeletionExecution(env.DB, claimed, new Date())
      return 'ack'
    }
    if (!claimed.step) {
      throw new FatalDeletionError('deletion_step_missing', '注销执行步骤不存在')
    }
    const reconciled = await reconcileDeletionEvidence(env.DB, claimed, new Date())
    if (reconciled) return enqueueNextDeletionStep(env, claimed.execution.id)

    const initialItemCount = claimed.step.initial_item_count
      ?? await measureDeletionHandlerItems(env, claimed.execution, claimed.step)
    const started = await markDeletionStepStarted(
      env.DB,
      claimed,
      initialItemCount,
      new Date(),
    )
    if (!started) return 'ack'
    const result = await runDeletionHandler(env, claimed.execution, claimed.profile, claimed.step, new Date())
    await completeDeletionStep(
      env.DB,
      claimed,
      initialItemCount,
      result,
      new Date(),
    )
    return enqueueNextDeletionStep(env, claimed.execution.id)
  }
  catch (error) {
    await releaseDeletionLease(
      env.DB,
      claimed.execution.id,
      claimed.execution.lease_token!,
      normalizeInternalErrorCode(error),
      new Date(),
    )
    throw error
  }
}

async function enqueueNextDeletionStep(
  env: Pick<Bindings, 'DATA_RIGHTS_DELETION_QUEUE'>,
  executionId: string,
): Promise<'ack' | 'retry'> {
  if (!env.DATA_RIGHTS_DELETION_QUEUE) return 'retry'
  try {
    await env.DATA_RIGHTS_DELETION_QUEUE.send(deletionQueueMessage(executionId))
    return 'ack'
  }
  catch {
    return 'retry'
  }
}

async function claimDeletionExecution(
  db: D1Database,
  current: ClaimedDeletionState,
  now: Date,
): Promise<ClaimedDeletionState | null> {
  const leaseToken = crypto.randomUUID()
  const timestamp = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString()
  const updated = await db.prepare(`
    UPDATE app_data_rights_deletion_executions
    SET status = 'processing', version = version + 1,
        lease_token = ?, lease_expires_at = ?,
        attempt_count = attempt_count + 1, last_error_code = NULL,
        started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ? AND version = ? AND status IN ('pending', 'processing')
      AND (lease_token IS NULL OR datetime(lease_expires_at) <= datetime(?))
      AND EXISTS (
        SELECT 1
        FROM app_data_rights_requests request
        JOIN app_data_rights_policies policy ON policy.id = request.policy_id
        JOIN app_data_rights_deletion_profiles profile
          ON profile.id = app_data_rights_deletion_executions.profile_id
        WHERE request.id = app_data_rights_deletion_executions.request_id
          AND request.status = 'processing'
          AND policy.state = 'published' AND policy.production_ready = 1
          AND policy.deletion_processing_enabled = 1
          AND profile.state = 'published' AND profile.production_ready = 1
      )
  `).bind(
    leaseToken,
    leaseExpiresAt,
    timestamp,
    timestamp,
    current.execution.id,
    current.execution.version,
    timestamp,
  ).run()
  if (changes(updated) !== 1) return null
  return loadDeletionState(db, current.execution.id)
}

async function markDeletionStepStarted(
  db: D1Database,
  claimed: ClaimedDeletionState,
  initialItemCount: number,
  now: Date,
) {
  const result = await db.prepare(`
    UPDATE app_data_rights_deletion_steps
    SET status = 'processing', attempt_count = attempt_count + 1,
        initial_item_count = COALESCE(initial_item_count, ?),
        started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE execution_id = ? AND ordinal = ? AND status IN ('pending', 'processing')
      AND EXISTS (
        SELECT 1 FROM app_data_rights_deletion_executions execution
        WHERE execution.id = app_data_rights_deletion_steps.execution_id
          AND execution.version = ? AND execution.status = 'processing'
          AND execution.lease_token = ?
          AND execution.current_step_ordinal = app_data_rights_deletion_steps.ordinal
      )
  `).bind(
    initialItemCount,
    now.toISOString(),
    now.toISOString(),
    claimed.execution.id,
    claimed.step!.ordinal,
    claimed.execution.version,
    claimed.execution.lease_token,
  ).run()
  return changes(result) === 1
}

async function completeDeletionStep(
  db: D1Database,
  claimed: ClaimedDeletionState,
  initialItemCount: number,
  result: HandlerResult,
  now: Date,
) {
  const step = claimed.step!
  const finalItemCount = Math.max(0, Math.trunc(result.finalItemCount))
  const affectedItemCount = Math.max(0, initialItemCount - finalItemCount)
  const timestamp = now.toISOString()
  const safeSummary = {
    stepCode: step.step_code,
    handlerCode: step.handler_code,
    disposition: step.disposition_snapshot,
    initialItemCount,
    finalItemCount,
    affectedItemCount,
    ...result.safeDetails,
  }
  const resultDigest = await sha256Hex(JSON.stringify({
    executionId: claimed.execution.id,
    requestId: claimed.execution.request_id,
    ordinal: step.ordinal,
    attempt: step.attempt_count + 1,
    safeSummary,
  }))
  const evidenceId = generateId('drdv')
  const results = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO app_data_rights_deletion_evidence (
        id, execution_id, request_id, account_id, step_ordinal,
        step_code, handler_code, disposition_snapshot, attempt,
        initial_item_count, final_item_count, affected_item_count,
        result_digest, safe_summary_json, created_at
      )
      SELECT ?, execution.id, execution.request_id, execution.account_id, step.ordinal,
             step.step_code, step.handler_code, step.disposition_snapshot, step.attempt_count,
             ?, ?, ?, ?, ?, ?
      FROM app_data_rights_deletion_executions execution
      JOIN app_data_rights_deletion_steps step ON step.execution_id = execution.id
      WHERE execution.id = ? AND execution.version = ?
        AND execution.status = 'processing' AND execution.lease_token = ?
        AND execution.current_step_ordinal = ?
        AND step.ordinal = execution.current_step_ordinal
        AND step.status = 'processing'
    `).bind(
      evidenceId,
      initialItemCount,
      finalItemCount,
      affectedItemCount,
      resultDigest,
      JSON.stringify(safeSummary),
      timestamp,
      claimed.execution.id,
      claimed.execution.version,
      claimed.execution.lease_token,
      step.ordinal,
    ),
    db.prepare(`
      UPDATE app_data_rights_deletion_steps
      SET status = 'completed',
          initial_item_count = (
            SELECT evidence.initial_item_count FROM app_data_rights_deletion_evidence evidence
            WHERE evidence.execution_id = app_data_rights_deletion_steps.execution_id
              AND evidence.step_ordinal = app_data_rights_deletion_steps.ordinal
          ),
          final_item_count = (
            SELECT evidence.final_item_count FROM app_data_rights_deletion_evidence evidence
            WHERE evidence.execution_id = app_data_rights_deletion_steps.execution_id
              AND evidence.step_ordinal = app_data_rights_deletion_steps.ordinal
          ),
          affected_item_count = (
            SELECT evidence.affected_item_count FROM app_data_rights_deletion_evidence evidence
            WHERE evidence.execution_id = app_data_rights_deletion_steps.execution_id
              AND evidence.step_ordinal = app_data_rights_deletion_steps.ordinal
          ),
          evidence_digest = (
            SELECT evidence.result_digest FROM app_data_rights_deletion_evidence evidence
            WHERE evidence.execution_id = app_data_rights_deletion_steps.execution_id
              AND evidence.step_ordinal = app_data_rights_deletion_steps.ordinal
          ),
          completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE execution_id = ? AND ordinal = ? AND status = 'processing'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_deletion_evidence evidence
          WHERE evidence.execution_id = app_data_rights_deletion_steps.execution_id
            AND evidence.step_ordinal = app_data_rights_deletion_steps.ordinal
        )
    `).bind(timestamp, timestamp, claimed.execution.id, step.ordinal),
    db.prepare(`
      UPDATE app_data_rights_deletion_executions
      SET status = 'pending', version = version + 1,
          current_step_ordinal = current_step_ordinal + 1,
          completed_step_count = completed_step_count + 1,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'processing' AND lease_token = ?
        AND current_step_ordinal = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_deletion_steps step
          WHERE step.execution_id = app_data_rights_deletion_executions.id
            AND step.ordinal = app_data_rights_deletion_executions.current_step_ordinal
            AND step.status = 'completed'
        )
    `).bind(
      timestamp,
      claimed.execution.id,
      claimed.execution.version,
      claimed.execution.lease_token,
      step.ordinal,
    ),
  ])
  if (changes(results[1]) !== 1 || changes(results[2]) !== 1) {
    throw new Error('DELETION_STEP_CHECKPOINT_CONFLICT')
  }
}

async function reconcileDeletionEvidence(
  db: D1Database,
  claimed: ClaimedDeletionState,
  now: Date,
) {
  const step = claimed.step
  if (!step) return false
  const evidence = await db.prepare(`
    SELECT initial_item_count, final_item_count, affected_item_count, result_digest, created_at
    FROM app_data_rights_deletion_evidence
    WHERE execution_id = ? AND step_ordinal = ?
    LIMIT 1
  `).bind(claimed.execution.id, step.ordinal).first<{
    initial_item_count: number
    final_item_count: number
    affected_item_count: number
    result_digest: string
    created_at: string
  }>()
  if (!evidence) return false
  const timestamp = now.toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE app_data_rights_deletion_steps
      SET status = 'completed', initial_item_count = ?, final_item_count = ?,
          affected_item_count = ?, evidence_digest = ?,
          started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?
      WHERE execution_id = ? AND ordinal = ? AND status <> 'completed'
    `).bind(
      evidence.initial_item_count,
      evidence.final_item_count,
      evidence.affected_item_count,
      evidence.result_digest,
      evidence.created_at,
      evidence.created_at,
      timestamp,
      claimed.execution.id,
      step.ordinal,
    ),
    db.prepare(`
      UPDATE app_data_rights_deletion_executions
      SET status = 'pending', version = version + 1,
          current_step_ordinal = current_step_ordinal + 1,
          completed_step_count = completed_step_count + 1,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'processing' AND lease_token = ?
        AND current_step_ordinal = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_deletion_steps step
          WHERE step.execution_id = app_data_rights_deletion_executions.id
            AND step.ordinal = app_data_rights_deletion_executions.current_step_ordinal
            AND step.status = 'completed'
        )
    `).bind(
      timestamp,
      claimed.execution.id,
      claimed.execution.version,
      claimed.execution.lease_token,
      step.ordinal,
    ),
  ])
  return changes(results[1]) === 1
}

async function finalizeDeletionExecution(
  db: D1Database,
  claimed: ClaimedDeletionState,
  now: Date,
) {
  const evidence = await db.prepare(`
    SELECT step_ordinal, result_digest
    FROM app_data_rights_deletion_evidence
    WHERE execution_id = ?
    ORDER BY step_ordinal ASC
  `).bind(claimed.execution.id).all<{ step_ordinal: number; result_digest: string }>()
  if (
    evidence.results.length !== claimed.execution.expected_step_count
    || evidence.results.some((item, index) => item.step_ordinal !== index)
  ) throw new FatalDeletionError('deletion_evidence_incomplete', '注销完成证据不完整')
  const completedSteps = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_data_rights_deletion_steps
    WHERE execution_id = ? AND status = 'completed'
  `).bind(claimed.execution.id).first<{ count: number }>()
  if (Number(completedSteps?.count ?? 0) !== claimed.execution.expected_step_count) {
    throw new FatalDeletionError('deletion_checkpoints_incomplete', '注销检查点不完整')
  }
  const evidenceRoot = await sha256Hex(evidence.results.map(item => item.result_digest).join(':'))
  const retained = await db.prepare(`
    SELECT COUNT(*) AS domain_count
    FROM app_data_rights_retained_domains
    WHERE execution_id = ?
  `).bind(claimed.execution.id).first<{ domain_count: number }>()
  const retainedDomainCount = Number(retained?.domain_count ?? 0)
  if (retainedDomainCount !== RETAINED_DOMAIN_DEFINITIONS.length) {
    throw new FatalDeletionError('retained_domain_evidence_incomplete', '保留隔离域证据不完整')
  }

  const timestamp = now.toISOString()
  const nextRequestVersion = claimed.execution.current_request_version + 1
  const nextRequestMutationToken = crypto.randomUUID()
  const eventId = generateId('dre')
  const securityEventId = generateId('ase')
  const results = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO app_data_rights_account_tombstones (
        account_id, request_id, execution_id, profile_id,
        account_public_id_snapshot, identity_reuse_mode,
        evidence_root_sha256, retained_domain_count, completed_at
      )
      SELECT execution.account_id, execution.request_id, execution.id, execution.profile_id,
             security.account_public_id, profile.identity_reuse_mode,
             ?, ?, ?
      FROM app_data_rights_deletion_executions execution
      JOIN app_data_rights_deletion_profiles profile ON profile.id = execution.profile_id
      JOIN app_account_security security ON security.account_id = execution.account_id
      JOIN users account ON account.id = execution.account_id
      WHERE execution.id = ? AND execution.version = ?
        AND execution.status = 'processing' AND execution.lease_token = ?
        AND execution.current_step_ordinal = execution.expected_step_count
        AND execution.completed_step_count = execution.expected_step_count
        AND account.status = 'deleted' AND security.status = 'deletion_pending'
    `).bind(
      evidenceRoot,
      retainedDomainCount,
      timestamp,
      claimed.execution.id,
      claimed.execution.version,
      claimed.execution.lease_token,
    ),
    db.prepare(`
      UPDATE app_data_rights_requests
      SET status = 'completed', status_message_code = 'deletion_completed',
          version = ?, mutation_token = ?, failure_code = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND request_type = 'deletion' AND status = 'processing'
        AND version = ? AND mutation_token = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_account_tombstones tombstone
          WHERE tombstone.request_id = app_data_rights_requests.id
            AND tombstone.execution_id = ?
            AND tombstone.evidence_root_sha256 = ?
        )
    `).bind(
      nextRequestVersion,
      nextRequestMutationToken,
      timestamp,
      timestamp,
      claimed.execution.request_id,
      claimed.execution.current_request_version,
      claimed.execution.request_mutation_token,
      claimed.execution.id,
      evidenceRoot,
    ),
    db.prepare(`
      INSERT INTO app_data_rights_request_events (
        id, request_id, sequence, request_version, status_snapshot,
        event_type, visibility, actor_type, actor_id, reason_code,
        user_message, internal_note, safe_summary_json, created_at
      )
      SELECT ?, request.id,
             COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = request.id), 0) + 1,
             request.version, 'completed', 'deletion_completed', 'user', 'system', NULL,
             'irreversible_deletion_evidence_verified',
             '账号注销已完成，本机将清理账号状态并退出。',
             NULL, ?, ?
      FROM app_data_rights_requests request
      WHERE request.id = ? AND request.status = 'completed'
        AND request.version = ? AND request.mutation_token = ?
    `).bind(
      eventId,
      JSON.stringify({
        executionId: claimed.execution.id,
        evidenceRootSha256: evidenceRoot,
        completedSteps: claimed.execution.expected_step_count,
        retainedDomainCount,
      }),
      timestamp,
      claimed.execution.request_id,
      nextRequestVersion,
      nextRequestMutationToken,
    ),
    db.prepare(`
      UPDATE app_data_rights_deletion_executions
      SET status = 'completed', version = version + 1,
          lease_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, completed_at = ?, failed_at = NULL, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'processing' AND lease_token = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_requests request
          WHERE request.id = app_data_rights_deletion_executions.request_id
            AND request.status = 'completed' AND request.version = ?
            AND request.mutation_token = ?
        )
    `).bind(
      timestamp,
      timestamp,
      claimed.execution.id,
      claimed.execution.version,
      claimed.execution.lease_token,
      nextRequestVersion,
      nextRequestMutationToken,
    ),
    db.prepare(`
      INSERT INTO app_account_security_events (
        id, account_id, device_id, session_id,
        event_type, reason_code, request_id, created_at
      )
      SELECT ?, execution.account_id, NULL, NULL,
             'account_deletion_completed', 'irreversible_deletion_evidence_verified',
             execution.request_id, ?
      FROM app_data_rights_deletion_executions execution
      WHERE execution.id = ? AND execution.status = 'completed'
    `).bind(securityEventId, timestamp, claimed.execution.id),
  ])
  if (changes(results[1]) !== 1 || changes(results[2]) !== 1 || changes(results[3]) !== 1) {
    throw new Error('DELETION_FINALIZATION_CONFLICT')
  }
}

async function failAppDataRightsDeletion(
  db: D1Database,
  executionId: string,
  failureCodeValue: string,
  now: Date,
) {
  const state = await loadDeletionState(db, executionId)
  if (!state || state.execution.status === 'completed' || state.execution.status === 'failed') return
  const failureCode = normalizeFailureCode(failureCodeValue)
  const timestamp = now.toISOString()
  const requestCanFail = state.execution.request_status === 'processing'
  const nextRequestVersion = state.execution.current_request_version + 1
  const requestMutationToken = crypto.randomUUID()
  const eventId = generateId('dre')
  const statements: D1PreparedStatement[] = []
  if (requestCanFail) {
    statements.push(
      db.prepare(`
        UPDATE app_data_rights_requests
        SET status = 'failed', status_message_code = 'processing_failed',
            version = ?, mutation_token = ?, failure_code = ?, updated_at = ?
        WHERE id = ? AND request_type = 'deletion' AND status = 'processing'
          AND version = ? AND mutation_token = ?
      `).bind(
        nextRequestVersion,
        requestMutationToken,
        failureCode,
        timestamp,
        state.execution.request_id,
        state.execution.current_request_version,
        state.execution.request_mutation_token,
      ),
      db.prepare(`
        INSERT INTO app_data_rights_request_events (
          id, request_id, sequence, request_version, status_snapshot,
          event_type, visibility, actor_type, actor_id, reason_code,
          user_message, internal_note, safe_summary_json, created_at
        )
        SELECT ?, request.id,
               COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = request.id), 0) + 1,
               request.version, 'failed', 'processing_failed', 'user', 'system', NULL,
               'irreversible_deletion_forward_fix_required',
               '账号注销处理遇到问题，账号仍保持受限；平台会从安全检查点继续处理，不会恢复已删除的数据。',
               NULL, ?, ?
        FROM app_data_rights_requests request
        WHERE request.id = ? AND request.status = 'failed'
          AND request.version = ? AND request.mutation_token = ?
      `).bind(
        eventId,
        JSON.stringify({
          executionId,
          failureCode,
          completedSteps: state.execution.completed_step_count,
          nextStepOrdinal: state.execution.current_step_ordinal,
          accountRestored: false,
        }),
        timestamp,
        state.execution.request_id,
        nextRequestVersion,
        requestMutationToken,
      ),
    )
  }
  statements.push(
    db.prepare(`
      UPDATE app_data_rights_deletion_steps
      SET status = 'pending', started_at = NULL, updated_at = ?
      WHERE execution_id = ? AND ordinal = ? AND status = 'processing'
    `).bind(timestamp, executionId, state.execution.current_step_ordinal),
    db.prepare(`
      UPDATE app_data_rights_deletion_executions
      SET status = 'failed', version = version + 1,
          lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ?, failed_at = ?, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('pending', 'processing')
        AND EXISTS (
          SELECT 1 FROM app_data_rights_requests request
          WHERE request.id = app_data_rights_deletion_executions.request_id
            AND request.status = 'failed'
        )
    `).bind(
      failureCode,
      timestamp,
      timestamp,
      executionId,
      state.execution.version,
    ),
  )
  await db.batch(statements)
}

async function releaseDeletionLease(
  db: D1Database,
  executionId: string,
  leaseToken: string,
  errorCode: string,
  now: Date,
) {
  await db.prepare(`
    UPDATE app_data_rights_deletion_executions
    SET status = 'pending', version = version + 1,
        lease_token = NULL, lease_expires_at = NULL,
        last_error_code = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'processing'
  `).bind(normalizeFailureCode(errorCode), now.toISOString(), executionId, leaseToken).run()
}

async function loadDeletionState(
  db: D1Database,
  executionId: string,
): Promise<ClaimedDeletionState | null> {
  const execution = await db.prepare(`
    SELECT execution.id, execution.request_id, execution.request_version_snapshot,
           execution.account_id, execution.profile_id, execution.profile_version_snapshot,
           execution.executor_version_snapshot, execution.status, execution.version,
           execution.execution_token, execution.current_step_ordinal,
           execution.expected_step_count, execution.completed_step_count,
           execution.attempt_count, execution.lease_token, execution.lease_expires_at,
           execution.last_error_code, execution.started_at, execution.completed_at,
           execution.failed_at, execution.created_at, execution.updated_at,
           request.status AS request_status, request.version AS current_request_version,
           request.mutation_token AS request_mutation_token,
           security.account_public_id
    FROM app_data_rights_deletion_executions execution
    JOIN app_data_rights_requests request ON request.id = execution.request_id
    JOIN app_account_security security ON security.account_id = execution.account_id
    WHERE execution.id = ?
    LIMIT 1
  `).bind(executionId).first<DeletionExecutionRow>()
  if (!execution) return null
  const [profile, step] = await Promise.all([
    loadDeletionProfileById(db, execution.profile_id),
    execution.current_step_ordinal < execution.expected_step_count
      ? db.prepare(`
          SELECT execution_id, ordinal, step_code, handler_code,
                 disposition_snapshot, governance_reference_snapshot,
                 status, attempt_count, initial_item_count, final_item_count,
                 affected_item_count, evidence_digest, started_at, completed_at
          FROM app_data_rights_deletion_steps
          WHERE execution_id = ? AND ordinal = ?
          LIMIT 1
        `).bind(execution.id, execution.current_step_ordinal).first<DeletionStepRow>()
      : Promise.resolve(null),
  ])
  return profile ? { execution, profile, step: step ?? null } : null
}

async function loadDeletionProfile(db: D1Database, policyId: string) {
  return db.prepare(`${deletionProfileSelect()}
    WHERE profile.policy_id = ?
    ORDER BY profile.production_ready DESC,
             CASE profile.state WHEN 'published' THEN 0 WHEN 'development' THEN 1 ELSE 2 END,
             datetime(profile.created_at) DESC, profile.id DESC
    LIMIT 1
  `).bind(policyId).first<DeletionProfileRow>()
}

async function loadDeletionProfileById(db: D1Database, profileId: string) {
  return db.prepare(`${deletionProfileSelect()}
    WHERE profile.id = ?
    LIMIT 1
  `).bind(profileId).first<DeletionProfileRow>()
}

function deletionProfileSelect() {
  return `
    SELECT profile.id, profile.policy_id, profile.version_code,
           profile.state, profile.production_ready, profile.schema_version,
           profile.executor_version, profile.expected_step_count,
           profile.retention_decision_status, profile.backup_decision_status,
           profile.third_party_decision_status, profile.identity_reuse_decision_status,
           profile.evidence_decision_status, profile.identity_reuse_mode,
           profile.identity_seal_days, profile.retention_policy_reference,
           profile.backup_policy_reference, profile.third_party_policy_reference,
           profile.identity_reuse_policy_reference, profile.evidence_policy_reference,
           policy.state AS policy_state,
           policy.production_ready AS policy_production_ready,
           policy.deletion_requests_enabled AS policy_deletion_requests_enabled,
           policy.deletion_processing_enabled AS policy_deletion_processing_enabled
    FROM app_data_rights_deletion_profiles profile
    JOIN app_data_rights_policies policy ON policy.id = profile.policy_id
  `
}

async function loadDeletionProfileSteps(db: D1Database, profileId: string) {
  const rows = await db.prepare(`
    SELECT profile_id, ordinal, step_code, handler_code, disposition,
           decision_status, governance_reference
    FROM app_data_rights_deletion_profile_steps
    WHERE profile_id = ?
    ORDER BY ordinal ASC
  `).bind(profileId).all<DeletionProfileStepRow>()
  return rows.results
}

async function requireReadyDeletionProfile(
  env: DeletionEnvironment,
  policyId: string,
) {
  const readiness = await resolveAppDataRightsDeletionExecutorReadiness(env, policyId)
  if (!readiness.ready) {
    throw new AppDataRightsError(
      503,
      'DELETION_PROFILE_NOT_READY',
      '不可逆注销的保留、地区、备份、第三方和身份复用策略尚未全部通过生产门禁',
      true,
    )
  }
  const profile = await loadDeletionProfile(env.DB, policyId)
  if (!profile) {
    throw new AppDataRightsError(503, 'DELETION_PROFILE_NOT_READY', '注销执行 profile 不可用', true)
  }
  return profile
}

function deletionStepsMatch(steps: DeletionProfileStepRow[], expectedStepCount: number) {
  if (expectedStepCount !== DELETION_STEPS.length || steps.length !== DELETION_STEPS.length) return false
  return steps.every((step, ordinal) => {
    const expected = DELETION_STEPS[ordinal]
    return expected
      && step.ordinal === ordinal
      && step.step_code === expected.code
      && step.handler_code === expected.code
      && step.disposition === expected.disposition
      && step.decision_status === 'approved'
      && Boolean(step.governance_reference)
  })
}

function deletionNotReady(profile: DeletionProfileRow | null, reasonCode: string) {
  return {
    ready: false,
    profileVersion: profile?.version_code ?? null,
    executorVersion: profile?.executor_version ?? null,
    identityReuseMode: profile?.identity_reuse_mode ?? null,
    expectedSteps: profile?.expected_step_count ?? DELETION_STEPS.length,
    reasonCode,
  }
}

async function measureDeletionHandlerItems(
  env: DeletionEnvironment,
  execution: DeletionExecutionRow,
  step: DeletionStepRow,
) {
  const db = env.DB
  const accountId = execution.account_id
  switch (step.handler_code) {
    case 'revoke_access':
      return countAccountItems(db, accountId, [
        'SELECT COUNT(*) FROM app_sessions WHERE account_id = ? AND status = \'active\'',
        'SELECT COUNT(*) FROM app_devices WHERE account_id = ? AND status = \'active\'',
        'SELECT COUNT(*) FROM app_realtime_tickets WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_data_rights_step_up_tokens WHERE account_id = ?',
        'SELECT COUNT(*) FROM sessions WHERE user_id = ?',
      ])
    case 'purge_private_exports':
      return countPrivateExportItems(db, accountId)
    case 'purge_notifications':
      return countAccountItems(db, accountId, [
        'SELECT COUNT(*) FROM app_notification_read_events WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_notification_preference_events WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_notifications WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_notification_outbox WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_notification_preferences WHERE account_id = ?',
      ])
    case 'purge_discovery_activity': {
      const directItems = await countAccountItems(db, accountId, [
        'SELECT COUNT(*) FROM app_viewer_interactions WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_favorite_folder_items WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_favorite_folders WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_profile_view_history WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_person_search_history WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_saved_person_filters WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_profile_blocks WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_profile_block_events WHERE account_id = ?',
        'SELECT COUNT(*) FROM gallery_likes WHERE user_id = ?',
      ])
      const recommendationItems = await countAppRecommendationEvidenceForAccount(
        db,
        env.SESSION_SECRET,
        execution.account_public_id,
      )
      return directItems + recommendationItems
    }
    case 'purge_account_preferences':
      return countAccountItems(db, accountId, [
        'SELECT COUNT(*) FROM app_recommendation_preferences WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_view_history_preferences WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_search_history_preferences WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_account_profile_preferences WHERE account_id = ?',
        'SELECT COUNT(*) FROM app_conversation_viewer_settings WHERE account_id = ?',
      ])
    case 'anonymize_analytics':
      return countAccountItems(db, accountId, [
        'SELECT COUNT(*) FROM analytics_visitors WHERE user_id = ?',
        'SELECT COUNT(*) FROM analytics_sessions WHERE user_id = ?',
        'SELECT COUNT(*) FROM analytics_page_summaries WHERE user_id = ?',
        'SELECT COUNT(*) FROM analytics_session_summaries WHERE user_id = ?',
        'SELECT COUNT(*) FROM analytics_events WHERE user_id = ?',
        'SELECT COUNT(*) FROM analytics_conversion_actions WHERE user_id = ?',
        'SELECT COUNT(*) FROM invite_registrations WHERE invited_user_id = ?',
        'SELECT COUNT(*) FROM invite_codes WHERE inviter_user_id = ?',
      ])
    case 'close_managed_conversations':
      return countConversationItems(db, accountId)
    case 'isolate_regulated_records':
      return countRetainedDomainItems(db, accountId)
    case 'tombstone_account':
      return countTombstoneIdentifiers(db, accountId)
    default:
      throw new FatalDeletionError('deletion_handler_unknown', '注销执行处理器不受支持')
  }
}

async function runDeletionHandler(
  env: DeletionEnvironment,
  execution: DeletionExecutionRow,
  profile: DeletionProfileRow,
  step: DeletionStepRow,
  now: Date,
): Promise<HandlerResult> {
  switch (step.handler_code) {
    case 'revoke_access':
      await revokeAccountAccess(env.DB, execution.account_id, now)
      try {
        await disconnectAppRealtimeAccount(env, execution.account_id)
      }
      catch {
        // D1 凭证已撤销即完成权威访问收口；连接关闭是额外的尽力而为加速路径。
      }
      break
    case 'purge_private_exports':
      await purgePrivateExportsForDeletion(env, execution.account_id, now)
      break
    case 'purge_notifications':
      await purgeAccountNotifications(env.DB, execution.account_id)
      break
    case 'purge_discovery_activity':
      await purgeAccountDiscoveryActivity(
        env,
        execution.account_id,
        execution.account_public_id,
      )
      break
    case 'purge_account_preferences':
      await purgeAccountPreferences(env.DB, execution.account_id)
      break
    case 'anonymize_analytics':
      await anonymizeAccountAnalytics(env.DB, execution.account_id)
      break
    case 'close_managed_conversations':
      await closeAccountConversations(env.DB, execution.account_id, now)
      break
    case 'isolate_regulated_records': {
      const finalItemCount = await isolateRegulatedRecords(
        env.DB,
        execution,
        step.governance_reference_snapshot,
        now,
      )
      return {
        finalItemCount,
        safeDetails: {
          retainedDomainCount: RETAINED_DOMAIN_DEFINITIONS.length,
          accessScope: 'compliance_only',
        },
      }
    }
    case 'tombstone_account':
      await tombstoneAccount(env, execution, profile, now)
      break
    default:
      throw new FatalDeletionError('deletion_handler_unknown', '注销执行处理器不受支持')
  }
  const finalItemCount = await measureDeletionHandlerItems(env, execution, step)
  if (finalItemCount !== 0) {
    throw new FatalDeletionError(
      'deletion_step_incomplete',
      `注销步骤 ${step.step_code} 仍有未处理项目`,
    )
  }
  return { finalItemCount }
}

async function revokeAccountAccess(db: D1Database, accountId: number, now: Date) {
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_realtime_tickets
      SET cancelled_at = ?, cancellation_reason = 'account_deletion'
      WHERE account_id = ? AND consumed_at IS NULL AND cancelled_at IS NULL
    `).bind(timestamp, accountId),
    db.prepare(`
      DELETE FROM app_realtime_tickets
      WHERE account_id = ?
    `).bind(accountId),
    db.prepare(`
      DELETE FROM app_refresh_token_history
      WHERE session_id IN (SELECT id FROM app_sessions WHERE account_id = ?)
    `).bind(accountId),
    db.prepare(`
      UPDATE app_sessions
      SET access_token_hash = lower(hex(randomblob(32))),
          refresh_token_hash = lower(hex(randomblob(32))),
          status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
          revoke_reason = 'account_deletion', updated_at = ?
      WHERE account_id = ?
    `).bind(timestamp, timestamp, accountId),
    db.prepare(`
      UPDATE app_devices
      SET installation_hash = 'deleted:' || id,
          display_name = '已注销设备', app_version = '0',
          status = 'revoked', session_version = session_version + 1,
          revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE account_id = ?
    `).bind(timestamp, timestamp, accountId),
    db.prepare('DELETE FROM app_data_rights_step_up_tokens WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(accountId),
    db.prepare(`
      UPDATE app_account_security
      SET status = 'deletion_pending', session_version = session_version + 1,
          restriction_reason_code = 'account_deletion', restricted_until = NULL,
          updated_at = ?
      WHERE account_id = ?
    `).bind(timestamp, accountId),
  ])
}

async function purgeAccountNotifications(db: D1Database, accountId: number) {
  await db.batch([
    db.prepare('DELETE FROM app_notification_read_events WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_notification_preference_events WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_notifications WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_notification_outbox WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_notification_preferences WHERE account_id = ?').bind(accountId),
  ])
}

async function purgeAccountDiscoveryActivity(
  env: DeletionEnvironment,
  accountId: number,
  accountPublicId: string,
) {
  await purgeAppRecommendationEvidenceForAccount(
    env.DB,
    env.SESSION_SECRET,
    accountPublicId,
  )
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE galleries
      SET like_count = MAX(0, like_count - (
        SELECT COUNT(*) FROM gallery_likes account_like
        WHERE account_like.gallery_id = galleries.id AND account_like.user_id = ?
      ))
      WHERE EXISTS (
        SELECT 1 FROM gallery_likes account_like
        WHERE account_like.gallery_id = galleries.id AND account_like.user_id = ?
      )
    `).bind(accountId, accountId),
    env.DB.prepare('DELETE FROM gallery_likes WHERE user_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_favorite_folder_items WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_favorite_folders WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_viewer_interactions WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_profile_view_history WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_person_search_history WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_saved_person_filters WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_profile_block_events WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM app_profile_blocks WHERE account_id = ?').bind(accountId),
  ])
}

async function purgeAccountPreferences(db: D1Database, accountId: number) {
  await db.batch([
    db.prepare('DELETE FROM app_conversation_viewer_settings WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_recommendation_preferences WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_view_history_preferences WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_search_history_preferences WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM app_account_profile_preferences WHERE account_id = ?').bind(accountId),
  ])
}

async function anonymizeAccountAnalytics(db: D1Database, accountId: number) {
  await db.batch([
    db.prepare('UPDATE analytics_events SET user_id = NULL WHERE user_id = ?').bind(accountId),
    db.prepare('UPDATE analytics_page_summaries SET user_id = NULL WHERE user_id = ?').bind(accountId),
    db.prepare('UPDATE analytics_session_summaries SET user_id = NULL WHERE user_id = ?').bind(accountId),
    db.prepare('UPDATE analytics_sessions SET user_id = NULL WHERE user_id = ?').bind(accountId),
    db.prepare('UPDATE analytics_visitors SET user_id = NULL WHERE user_id = ?').bind(accountId),
    db.prepare('UPDATE analytics_conversion_actions SET user_id = NULL WHERE user_id = ?').bind(accountId),
    db.prepare('DELETE FROM invite_registrations WHERE invited_user_id = ?').bind(accountId),
    db.prepare('UPDATE invite_codes SET inviter_user_id = NULL WHERE inviter_user_id = ?').bind(accountId),
  ])
}

async function closeAccountConversations(db: D1Database, accountId: number, now: Date) {
  const timestamp = now.toISOString()
  await cancelPendingAppMessageModerationCasesForAccount(db, accountId, now)
  await db.batch([
    db.prepare(`
      DELETE FROM app_messaging_idempotency
      WHERE conversation_id IN (SELECT id FROM app_conversations WHERE account_id = ?)
    `).bind(accountId),
    db.prepare(`
      INSERT INTO app_conversation_assignment_events (
        id, conversation_id, version, event_type, subject_admin_id,
        actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
      )
      SELECT 'cae_' || lower(hex(randomblob(16))), assignment.conversation_id,
             assignment.version + 1, 'released', assignment.assigned_admin_id,
             'system', NULL, 'account_deletion', NULL, ?
      FROM app_conversation_assignment_state assignment
      JOIN app_conversations owner ON owner.id = assignment.conversation_id
      WHERE owner.account_id = ? AND assignment.status = 'active'
    `).bind(timestamp, accountId),
    db.prepare(`
      UPDATE app_conversation_assignment_state
      SET assigned_admin_id = NULL, status = 'released', version = version + 1,
          lease_expires_at = NULL,
          mutation_token = ?, released_at = COALESCE(released_at, ?), updated_at = ?
      WHERE conversation_id IN (SELECT id FROM app_conversations WHERE account_id = ?)
        AND status = 'active'
    `).bind(crypto.randomUUID(), timestamp, timestamp, accountId),
    db.prepare(`
      UPDATE app_conversations
      SET status = 'closed', queue_status = 'closed',
          restriction_reason_code = 'account_deletion',
          restriction_source = 'runtime_control',
          closed_reason_code = 'account_deletion', closed_by_type = 'system',
          closed_at = COALESCE(closed_at, ?), updated_at = ?
      WHERE account_id = ? AND status <> 'closed'
    `).bind(timestamp, timestamp, accountId),
  ])
}

const RETAINED_DOMAIN_DEFINITIONS = [
  {
    code: 'consent',
    countSql: 'SELECT COUNT(*) AS count FROM app_account_consents WHERE account_id = ?',
  },
  {
    code: 'membership',
    countSql: `
      SELECT
        (SELECT COUNT(*) FROM app_membership_grants WHERE user_id = ?)
        + (SELECT COUNT(*) FROM app_membership_applications WHERE user_id = ?)
        + (SELECT COUNT(*) FROM app_membership_application_events event
           JOIN app_membership_applications owner ON owner.id = event.application_id
           WHERE owner.user_id = ?)
        + (SELECT COUNT(*) FROM app_membership_grant_batch_items WHERE target_user_id = ?)
        AS count
    `,
    bindingCount: 4,
  },
  {
    code: 'wallet',
    countSql: `
      SELECT
        (SELECT COUNT(*) FROM app_wallets WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_wallet_entries WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_wallet_adjustments WHERE account_id = ?)
        AS count
    `,
    bindingCount: 3,
  },
  {
    code: 'messaging_evidence',
    countSql: `
      SELECT
        (SELECT COUNT(*) FROM app_conversations WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_conversation_messages message
           JOIN app_conversations owner ON owner.id = message.conversation_id
           WHERE owner.account_id = ?)
        AS count
    `,
    bindingCount: 2,
  },
  {
    code: 'safety',
    countSql: `
      SELECT
        (SELECT COUNT(*) FROM app_safety_reports WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_safety_appeals WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_service_appeals WHERE account_id = ?)
        AS count
    `,
    bindingCount: 3,
  },
  {
    code: 'data_rights',
    countSql: `
      SELECT
        (SELECT COUNT(*) FROM app_data_rights_requests WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_data_rights_request_events event
           JOIN app_data_rights_requests owner ON owner.id = event.request_id
           WHERE owner.account_id = ?)
        AS count
    `,
    bindingCount: 2,
  },
  {
    code: 'security_audit',
    countSql: `
      SELECT
        (SELECT COUNT(*) FROM app_account_security_events WHERE account_id = ?)
        + (SELECT COUNT(*) FROM app_data_rights_verification_attempts WHERE account_id = ?)
        AS count
    `,
    bindingCount: 2,
  },
] as const

async function isolateRegulatedRecords(
  db: D1Database,
  execution: DeletionExecutionRow,
  governanceReference: string,
  now: Date,
) {
  await db.prepare(`
    UPDATE app_wallets
    SET status = 'frozen', updated_at = ?
    WHERE account_id = ? AND status = 'active'
  `).bind(now.toISOString(), execution.account_id).run()
  for (const definition of RETAINED_DOMAIN_DEFINITIONS) {
    const bindingCount = 'bindingCount' in definition ? definition.bindingCount : 1
    const row = await db.prepare(definition.countSql)
      .bind(...Array.from({ length: bindingCount }, () => execution.account_id))
      .first<{ count: number }>()
    let itemCount = Number(row?.count ?? 0)
    if (definition.code === 'messaging_evidence') {
      itemCount += await countMessageModerationEvidence(db, execution.account_id)
    }
    const countDigest = await sha256Hex(JSON.stringify({
      executionId: execution.id,
      domainCode: definition.code,
      itemCount,
      accessScope: 'compliance_only',
      governanceReference,
    }))
    await db.prepare(`
      INSERT OR IGNORE INTO app_data_rights_retained_domains (
        execution_id, domain_code, item_count, access_scope,
        governance_reference, count_digest, created_at
      ) VALUES (?, ?, ?, 'compliance_only', ?, ?, ?)
    `).bind(
      execution.id,
      definition.code,
      itemCount,
      governanceReference,
      countDigest,
      now.toISOString(),
    ).run()
  }
  const retained = await db.prepare(`
    SELECT COUNT(*) AS domain_count, COALESCE(SUM(item_count), 0) AS item_count
    FROM app_data_rights_retained_domains
    WHERE execution_id = ?
  `).bind(execution.id).first<{ domain_count: number; item_count: number }>()
  if (Number(retained?.domain_count ?? 0) !== RETAINED_DOMAIN_DEFINITIONS.length) {
    throw new Error('RETAINED_DOMAIN_CHECKPOINT_CONFLICT')
  }
  return Number(retained?.item_count ?? 0)
}

async function tombstoneAccount(
  env: DeletionEnvironment,
  execution: DeletionExecutionRow,
  profile: DeletionProfileRow,
  now: Date,
) {
  const account = await env.DB.prepare(`
    SELECT email, avatar_key, status
    FROM users
    WHERE id = ?
    LIMIT 1
  `).bind(execution.account_id).first<{
    email: string
    avatar_key: string | null
    status: string
  }>()
  if (!account) throw new FatalDeletionError('deletion_account_missing', '待注销账号不存在')
  if (account.status === 'deleted') return
  if (profile.identity_reuse_mode === 'unresolved') {
    throw new FatalDeletionError('identity_reuse_policy_unresolved', '身份复用策略未批准')
  }
  if (profile.identity_reuse_mode === 'seal') {
    const key = env.DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT
    if (!validRetentionMasterKey(key)) {
      throw new FatalDeletionError('deletion_retention_key_missing', '身份封存密钥不可用')
    }
    const subjectHmac = await hmacSha256Hex(key!, account.email.trim().toLowerCase())
    const releaseAfter = new Date(
      now.getTime() + Number(profile.identity_seal_days) * 24 * 60 * 60_000,
    ).toISOString()
    await env.DB.prepare(`
      INSERT OR IGNORE INTO app_data_rights_identity_seals (
        id, provider, subject_hmac, request_id, account_id,
        profile_id, release_after, created_at
      ) VALUES (?, 'email', ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('dris'),
      subjectHmac,
      execution.request_id,
      execution.account_id,
      profile.id,
      releaseAfter,
      now.toISOString(),
    ).run()
    const storedSeal = await env.DB.prepare(`
      SELECT request_id
      FROM app_data_rights_identity_seals
      WHERE provider = 'email' AND subject_hmac = ?
      LIMIT 1
    `).bind(subjectHmac).first<{ request_id: string }>()
    if (storedSeal?.request_id !== execution.request_id) {
      throw new FatalDeletionError('identity_seal_conflict', '身份封存摘要与其他申请冲突')
    }
  }
  if (account.avatar_key) await env.R2.delete(account.avatar_key)
  const tombstoneEmail = `deleted+${execution.account_id}.${execution.request_id.slice(4, 20)}@tombstone.meigallery.invalid`
  const timestamp = now.toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_verification_codes WHERE email = ?').bind(account.email),
    env.DB.prepare('DELETE FROM app_account_identities WHERE account_id = ?').bind(execution.account_id),
    env.DB.prepare(`
      UPDATE users
      SET email = ?, username = NULL, nickname = NULL,
          password_hash = '!deleted:' || lower(hex(randomblob(32))),
          avatar_key = NULL, status = 'deleted', email_verified = 0,
          notification_enabled = 0, conversion_external_id = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'deletion_pending'
    `).bind(tombstoneEmail, timestamp, execution.account_id),
  ])
  const updated = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
    .bind(execution.account_id)
    .first<{ status: string }>()
  if (updated?.status !== 'deleted') {
    throw new FatalDeletionError('account_tombstone_conflict', '账号墓碑写入冲突')
  }
}

type PrivateExportArtifactRow = {
  id: string
  status: string
  readme_r2_key: string | null
  manifest_r2_key: string | null
  archive_r2_key: string | null
}

async function purgePrivateExportsForDeletion(
  env: Pick<Bindings, 'DB' | 'R2'>,
  accountId: number,
  now: Date,
) {
  const artifacts = await env.DB.prepare(`
    SELECT id, status, readme_r2_key, manifest_r2_key, archive_r2_key
    FROM app_data_rights_export_artifacts
    WHERE account_id = ?
    ORDER BY created_at ASC, id ASC
  `).bind(accountId).all<PrivateExportArtifactRow>()
  for (const artifact of artifacts.results) {
    const parts = await env.DB.prepare(`
      SELECT r2_key FROM app_data_rights_export_parts
      WHERE artifact_id = ? ORDER BY ordinal ASC
    `).bind(artifact.id).all<{ r2_key: string }>()
    const keys = [
      ...parts.results.map(part => part.r2_key),
      artifact.readme_r2_key,
      artifact.manifest_r2_key,
      artifact.archive_r2_key,
    ].filter((key): key is string => Boolean(key))
    for (let offset = 0; offset < keys.length; offset += 1000) {
      await env.R2.delete(keys.slice(offset, offset + 1000))
    }
    const nextStatus = ['queued', 'collecting', 'finalizing'].includes(artifact.status)
      ? 'superseded'
      : ['ready', 'expired', 'purging'].includes(artifact.status)
        ? 'purged'
        : artifact.status
    const statements = [
      env.DB.prepare(`
        UPDATE app_data_rights_export_jobs
        SET status = 'failed', version = version + 1,
            lease_token = NULL, lease_expires_at = NULL,
            last_error_code = 'account_deletion', updated_at = ?
        WHERE artifact_id = ? AND status IN ('pending', 'processing', 'finalizing')
      `).bind(now.toISOString(), artifact.id),
    ]
    if (nextStatus !== artifact.status) {
      statements.unshift(env.DB.prepare(`
        UPDATE app_data_rights_export_artifacts
        SET status = ?, version = version + 1,
            failure_code = CASE WHEN ? = 'superseded' THEN 'account_deletion' ELSE failure_code END,
            updated_at = ?
        WHERE id = ? AND status = ?
      `).bind(nextStatus, nextStatus, now.toISOString(), artifact.id, artifact.status))
    }
    await env.DB.batch(statements)
  }
  await env.DB.prepare(`
    UPDATE app_data_rights_export_download_tickets
    SET expires_at = ?
    WHERE account_id = ? AND consumed_at IS NULL AND datetime(expires_at) > datetime(?)
  `).bind(now.toISOString(), accountId, now.toISOString()).run()

  const requests = await env.DB.prepare(`
    SELECT id, status, version, mutation_token
    FROM app_data_rights_requests
    WHERE account_id = ? AND request_type = 'export'
      AND status IN ('requested', 'verification_required', 'collecting', 'ready')
    ORDER BY requested_at ASC, id ASC
  `).bind(accountId).all<{
    id: string
    status: string
    version: number
    mutation_token: string
  }>()
  for (const request of requests.results) {
    const nextStatus = request.status === 'ready' ? 'expired' : 'cancelled'
    const nextVersion = request.version + 1
    const mutationToken = crypto.randomUUID()
    const eventId = generateId('dre')
    const timestamp = now.toISOString()
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE app_data_rights_requests
        SET status = ?, status_message_code = ?, version = ?, mutation_token = ?,
            cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
            failure_code = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = ?
      `).bind(
        nextStatus,
        nextStatus === 'expired' ? 'export_expired' : 'request_cancelled',
        nextVersion,
        mutationToken,
        nextStatus,
        timestamp,
        timestamp,
        request.id,
        request.version,
        request.mutation_token,
        request.status,
      ),
      env.DB.prepare(`
        INSERT INTO app_data_rights_request_events (
          id, request_id, sequence, request_version, status_snapshot,
          event_type, visibility, actor_type, actor_id, reason_code,
          user_message, internal_note, safe_summary_json, created_at
        )
        SELECT ?, id,
               COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = app_data_rights_requests.id), 0) + 1,
               version, ?, ?, 'user', 'system', NULL,
               'account_deletion_private_export_purged',
               '账号注销处理已清理关联的私有数据副本。', NULL, ?, ?
        FROM app_data_rights_requests
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = ?
      `).bind(
        eventId,
        nextStatus,
        nextStatus === 'expired' ? 'export_expired' : 'cancelled',
        JSON.stringify({ accountDeletion: true, privateObjectsPurged: true }),
        timestamp,
        request.id,
        nextVersion,
        mutationToken,
        nextStatus,
      ),
      env.DB.prepare(`
        UPDATE app_data_rights_status_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE request_id = ? AND account_id = ? AND revoked_at IS NULL
      `).bind(timestamp, request.id, accountId),
    ])
  }
}

export async function getAdminAppDataRightsDeletionState(
  db: D1Database,
  requestId: string,
) {
  const execution = await db.prepare(`
    SELECT execution.id, execution.status, execution.profile_version_snapshot,
           execution.executor_version_snapshot, execution.current_step_ordinal,
           execution.expected_step_count, execution.completed_step_count,
           execution.attempt_count, execution.last_error_code,
           execution.started_at, execution.completed_at, execution.failed_at,
           profile.identity_reuse_mode
    FROM app_data_rights_deletion_executions execution
    JOIN app_data_rights_deletion_profiles profile ON profile.id = execution.profile_id
    WHERE execution.request_id = ?
    LIMIT 1
  `).bind(requestId).first<{
    id: string
    status: 'pending' | 'processing' | 'completed' | 'failed'
    profile_version_snapshot: string
    executor_version_snapshot: string
    current_step_ordinal: number
    expected_step_count: number
    completed_step_count: number
    attempt_count: number
    last_error_code: string | null
    started_at: string | null
    completed_at: string | null
    failed_at: string | null
    identity_reuse_mode: 'release' | 'seal' | 'unresolved'
  }>()
  if (!execution) return null
  const [steps, tombstone] = await Promise.all([
    db.prepare(`
      SELECT ordinal, step_code, disposition_snapshot, status,
             attempt_count, initial_item_count, final_item_count,
             affected_item_count, evidence_digest, started_at, completed_at
      FROM app_data_rights_deletion_steps
      WHERE execution_id = ?
      ORDER BY ordinal ASC
    `).bind(execution.id).all<{
      ordinal: number
      step_code: string
      disposition_snapshot: DeletionDisposition
      status: 'pending' | 'processing' | 'completed'
      attempt_count: number
      initial_item_count: number | null
      final_item_count: number | null
      affected_item_count: number | null
      evidence_digest: string | null
      started_at: string | null
      completed_at: string | null
    }>(),
    db.prepare(`
      SELECT evidence_root_sha256, retained_domain_count, completed_at
      FROM app_data_rights_account_tombstones
      WHERE execution_id = ?
      LIMIT 1
    `).bind(execution.id).first<{
      evidence_root_sha256: string
      retained_domain_count: number
      completed_at: string
    }>(),
  ])
  return {
    executionId: execution.id,
    status: execution.status,
    profileVersion: execution.profile_version_snapshot,
    executorVersion: execution.executor_version_snapshot,
    identityReuseMode: execution.identity_reuse_mode,
    progress: {
      completedSteps: execution.completed_step_count,
      totalSteps: execution.expected_step_count,
      currentStep: steps.results.find(step => step.ordinal === execution.current_step_ordinal)?.step_code ?? null,
    },
    attempts: execution.attempt_count,
    lastErrorCode: execution.last_error_code,
    startedAt: execution.started_at,
    completedAt: execution.completed_at,
    failedAt: execution.failed_at,
    steps: steps.results.map(step => ({
      ordinal: step.ordinal,
      stepCode: step.step_code,
      disposition: step.disposition_snapshot,
      status: step.status,
      attempts: step.attempt_count,
      initialItemCount: step.initial_item_count,
      finalItemCount: step.final_item_count,
      affectedItemCount: step.affected_item_count,
      evidenceDigest: step.evidence_digest,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
    evidence: tombstone ? {
      rootSha256: tombstone.evidence_root_sha256,
      retainedDomainCount: tombstone.retained_domain_count,
      completedAt: tombstone.completed_at,
    } : null,
  }
}

export async function recoverAppDataRightsDeletions(
  env: Pick<Bindings, 'DB' | 'DATA_RIGHTS_DELETION_QUEUE'>,
  now = new Date(),
  limit = RECOVERY_LIMIT,
) {
  if (!env.DATA_RIGHTS_DELETION_QUEUE) return { skipped: true, dispatched: 0 }
  const rows = await env.DB.prepare(`
    SELECT execution.id
    FROM app_data_rights_deletion_executions execution
    JOIN app_data_rights_requests request ON request.id = execution.request_id
    WHERE execution.status IN ('pending', 'processing')
      AND (execution.lease_token IS NULL OR datetime(execution.lease_expires_at) <= datetime(?))
      AND request.status = 'processing'
    ORDER BY execution.updated_at ASC, execution.id ASC
    LIMIT ?
  `).bind(
    now.toISOString(),
    Math.max(1, Math.min(limit, RECOVERY_LIMIT)),
  ).all<{ id: string }>()
  let dispatched = 0
  for (const row of rows.results) {
    try {
      await env.DATA_RIGHTS_DELETION_QUEUE.send(deletionQueueMessage(row.id))
      dispatched += 1
    }
    catch {
      break
    }
  }
  return { skipped: false, dispatched }
}

export async function checkAppRegistrationIdentityReuse(
  env: Pick<
    Bindings,
    | 'DB'
    | 'DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT'
    | 'DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS'
  >,
  normalizedEmail: string,
  now = new Date(),
): Promise<{ allowed: boolean; configured: boolean; reasonCode: string | null }> {
  const activeSeal = await env.DB.prepare(`
    SELECT 1 AS present
    FROM app_data_rights_identity_seals
    WHERE provider = 'email'
      AND (release_after IS NULL OR datetime(release_after) > datetime(?))
    LIMIT 1
  `).bind(now.toISOString()).first<{ present: number }>()
  if (!activeSeal) return { allowed: true, configured: true, reasonCode: null }
  const keys = [
    env.DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT,
    env.DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS,
  ].filter((value): value is string => validRetentionMasterKey(value))
  if (keys.length === 0) {
    return { allowed: false, configured: false, reasonCode: 'identity_reuse_key_unavailable' }
  }
  const digests = await Promise.all(keys.map(key => hmacSha256Hex(key, normalizedEmail)))
  const placeholders = digests.map(() => '?').join(', ')
  const sealed = await env.DB.prepare(`
    SELECT 1 AS present
    FROM app_data_rights_identity_seals
    WHERE provider = 'email' AND subject_hmac IN (${placeholders})
      AND (release_after IS NULL OR datetime(release_after) > datetime(?))
    LIMIT 1
  `).bind(...digests, now.toISOString()).first<{ present: number }>()
  return sealed
    ? { allowed: false, configured: true, reasonCode: 'identity_reuse_sealed' }
    : { allowed: true, configured: true, reasonCode: null }
}

async function countAccountItems(
  db: D1Database,
  accountId: number,
  countQueries: string[],
) {
  const row = await db.prepare(`
    SELECT ${countQueries.map(query => `(${query})`).join(' + ')} AS count
  `).bind(...countQueries.map(() => accountId)).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function countPrivateExportItems(db: D1Database, accountId: number) {
  return countAccountItems(db, accountId, [
    `SELECT COUNT(*) FROM app_data_rights_export_artifacts
     WHERE account_id = ? AND status NOT IN ('purged', 'superseded', 'failed')`,
    `SELECT COUNT(*) FROM app_data_rights_export_download_tickets
     WHERE account_id = ? AND consumed_at IS NULL AND datetime(expires_at) > datetime('now')`,
    `SELECT COUNT(*) FROM app_data_rights_requests
     WHERE account_id = ? AND request_type = 'export'
       AND status IN ('requested', 'verification_required', 'collecting', 'ready')`,
  ])
}

async function countConversationItems(db: D1Database, accountId: number) {
  const queries = [
    `SELECT COUNT(*) FROM app_conversations
     WHERE account_id = ? AND status <> 'closed'`,
    `SELECT COUNT(*) FROM app_conversation_assignment_state assignment
     JOIN app_conversations owner ON owner.id = assignment.conversation_id
     WHERE owner.account_id = ? AND assignment.status = 'active'`,
    `SELECT COUNT(*) FROM app_messaging_idempotency command
     JOIN app_conversations owner ON owner.id = command.conversation_id
     WHERE owner.account_id = ?`,
  ]
  if (await appMessageModerationSchemaAvailable(db)) {
    queries.push(
      `SELECT COUNT(*) FROM app_message_moderation_cases review_case
       JOIN app_conversations owner ON owner.id = review_case.conversation_id
       WHERE owner.account_id = ? AND review_case.status IN ('pending', 'in_review')`,
      `SELECT COUNT(*) FROM app_message_moderation_idempotency command
       JOIN app_message_moderation_cases review_case ON review_case.id = command.case_id
       JOIN app_conversations owner ON owner.id = review_case.conversation_id
       WHERE owner.account_id = ?`,
    )
  }
  return countAccountItems(db, accountId, queries)
}

async function countRetainedDomainItems(db: D1Database, accountId: number) {
  let total = 0
  for (const definition of RETAINED_DOMAIN_DEFINITIONS) {
    const bindingCount = 'bindingCount' in definition ? definition.bindingCount : 1
    const row = await db.prepare(definition.countSql)
      .bind(...Array.from({ length: bindingCount }, () => accountId))
      .first<{ count: number }>()
    total += Number(row?.count ?? 0)
    if (definition.code === 'messaging_evidence') {
      total += await countMessageModerationEvidence(db, accountId)
    }
  }
  return total
}

async function countMessageModerationEvidence(db: D1Database, accountId: number) {
  if (!await appMessageModerationSchemaAvailable(db)) return 0
  return countAccountItems(db, accountId, [
    `SELECT COUNT(*) FROM app_message_moderation_evaluations evaluation
     JOIN app_conversations owner ON owner.id = evaluation.conversation_id
     WHERE owner.account_id = ?`,
    `SELECT COUNT(*) FROM app_message_moderation_cases review_case
     JOIN app_conversations owner ON owner.id = review_case.conversation_id
     WHERE owner.account_id = ?`,
    `SELECT COUNT(*) FROM app_message_moderation_case_events event
     JOIN app_message_moderation_cases review_case ON review_case.id = event.case_id
     JOIN app_conversations owner ON owner.id = review_case.conversation_id
     WHERE owner.account_id = ?`,
  ])
}

async function appMessageModerationSchemaAvailable(db: D1Database) {
  const row = await db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'app_message_moderation_cases'
    LIMIT 1
  `).first<{ present: number }>()
  return Boolean(row)
}

async function countTombstoneIdentifiers(db: D1Database, accountId: number) {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM app_account_identities WHERE account_id = ?)
      + (SELECT CASE WHEN status = 'deleted' THEN 0 ELSE 1 END FROM users WHERE id = ?)
      + (SELECT CASE WHEN avatar_key IS NULL THEN 0 ELSE 1 END FROM users WHERE id = ?)
      + (SELECT COUNT(*) FROM email_verification_codes
         WHERE email = (SELECT email FROM users WHERE id = ?))
      AS count
  `).bind(accountId, accountId, accountId, accountId).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

function deletionQueueMessage(executionId: string): AppDataRightsDeletionQueueMessage {
  return { schemaVersion: 1, kind: DELETION_MESSAGE_KIND, executionId }
}

function parseDeletionQueueMessage(value: unknown): AppDataRightsDeletionQueueMessage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AppDataRightsDeletionQueueMessage>
  if (
    candidate.schemaVersion !== 1
    || candidate.kind !== DELETION_MESSAGE_KIND
    || typeof candidate.executionId !== 'string'
    || !EXECUTION_ID.test(candidate.executionId)
  ) return null
  return candidate as AppDataRightsDeletionQueueMessage
}

function safeAck(message: QueueMessageLike) {
  try {
    message.ack?.()
  }
  catch {
    // ack 失败由 Queue 自身重投；业务步骤通过租约、版本和不可变证据保持幂等。
  }
}

function safeRetry(message: QueueMessageLike) {
  try {
    message.retry?.({ delaySeconds: 15 })
  }
  catch {
    // retry 失败时不 ack，让 Queue 使用默认重投语义。
  }
}

function changes(result: D1Result<unknown> | undefined) {
  return Number(result?.meta.changes ?? 0)
}

function normalizeFailureCode(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 120)
  return normalized.length >= 3 ? normalized : 'deletion_failed'
}

function normalizeInternalErrorCode(error: unknown) {
  return error instanceof FatalDeletionError ? error.code : 'deletion_step_failed'
}

function validRetentionMasterKey(value: string | undefined): value is string {
  return Boolean(value && value.trim().length >= 32 && value.trim().length <= 512)
}

async function hmacSha256Hex(secret: string, value: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
