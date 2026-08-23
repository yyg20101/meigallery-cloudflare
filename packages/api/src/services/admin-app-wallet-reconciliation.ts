import {
  createAdminAppWalletAdjustment,
  getAdminAppWalletAdjustment,
  type AdminWalletAdjustmentView,
} from './admin-app-wallet'
import {
  AppWalletError,
  requireAppWalletPolicy,
  type AppWalletRuntimeConfig,
} from './app-wallet'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const CASE_ID = /^wrd_[A-Za-z0-9_-]{1,91}$/u
const SCAN_LEASE_MS = 10 * 60 * 1000

export type WalletReconciliationDifferenceType = 'balance_mismatch' | 'sequence_mismatch' | 'entry_chain_break'
export type WalletReconciliationCaseStatus = 'open' | 'claimed' | 'creating_forward_fix' | 'forward_fix_requested' | 'resolved' | 'dismissed'

export interface AdminWalletReconciliationScanInput {
  limit?: unknown
}

export interface AdminWalletReconciliationClaimInput {
  expectedVersion?: unknown
}

export interface AdminWalletReconciliationForwardFixInput {
  expectedVersion?: unknown
  userVisibleNote?: unknown
  internalNote?: unknown
}

export interface AdminWalletReconciliationVerifyInput {
  expectedVersion?: unknown
  resolutionNote?: unknown
}

export interface AdminWalletReconciliationRecoveryInput {
  expectedVersion?: unknown
  caseSetDigest?: unknown
  resolutionNote?: unknown
  evidenceReference?: unknown
}

export interface AdminWalletReconciliationRunView {
  runId: string
  status: 'running' | 'completed' | 'failed'
  walletCount: number
  differenceCount: number
  createdBy: { id: number; label: string }
  leaseExpiresAt: string | null
  executionRecoverable: boolean
  failureCode: string | null
  completedAt: string | null
  createdAt: string
}

export interface AdminWalletReconciliationCaseView {
  caseId: string
  runId: string
  accountId: string
  differenceType: WalletReconciliationDifferenceType
  severity: 'p0' | 'p1' | 'p2'
  walletBalance: number
  expectedBalance: number
  walletSequence: number
  expectedSequence: number
  evidenceSha256: string
  status: WalletReconciliationCaseStatus
  version: number
  assignedTo: { id: number; label: string } | null
  claimedAt: string | null
  resolutionNote: string | null
  forwardFixAdjustmentId: string | null
  walletStatus: 'active' | 'frozen' | null
  latestRecovery: {
    commandId: string
    appliedAt: string
  } | null
  forwardFix: {
    eligible: boolean
    direction: 'credit' | 'debit' | null
    amount: number
    reason: string
  }
  createdAt: string
  updatedAt: string
}

export interface AdminWalletReconciliationRecoveryPreviewView {
  caseId: string
  accountId: string
  anchorVersion: number
  walletStatus: 'active' | 'frozen'
  walletBalance: number
  walletSequence: number
  rebuiltBalance: number
  rebuiltSequence: number
  snapshotChangeRequired: boolean
  coveredCases: Array<{
    caseId: string
    differenceType: WalletReconciliationDifferenceType
    status: WalletReconciliationCaseStatus
    version: number
  }>
  caseSetDigest: string
  eligible: boolean
  blockers: string[]
}

export interface AdminWalletRecoveryView {
  commandId: string
  caseId: string
  accountId: string
  status: 'applied'
  previousSnapshot: { status: 'frozen'; balance: number; sequence: number }
  rebuiltSnapshot: { status: 'active'; balance: number; sequence: number }
  coveredCaseCount: number
  resolutionNote: string
  evidenceReference: string
  appliedAt: string
}

type Actor = { id: number; role: string | null }

type RunRow = {
  id: string
  status: string
  wallet_count: number
  difference_count: number
  created_by: number
  creator_label: string
  lease_expires_at: string | null
  failure_code: string | null
  completed_at: string | null
  created_at: string
}

type CaseRow = {
  id: string
  run_id: string
  wallet_id: string | null
  account_id: number
  account_public_id: string
  difference_type: string
  severity: string
  wallet_balance: number
  expected_balance: number
  wallet_sequence: number
  expected_sequence: number
  evidence_sha256: string
  status: string
  version: number
  assigned_to: number | null
  assignee_label: string | null
  claimed_at: string | null
  resolution_note: string | null
  forward_fix_adjustment_id: string | null
  mutation_token: string | null
  wallet_status: string | null
  recovery_command_id: string | null
  recovery_applied_at: string | null
  created_at: string
  updated_at: string
}

type RecoveryCaseEvidenceRow = {
  id: string
  wallet_id: string | null
  account_id: number
  account_public_id: string
  difference_type: string
  evidence_sha256: string
  status: string
  version: number
  assigned_to: number | null
}

type WalletRecoveryStateRow = {
  wallet_id: string
  account_id: number
  account_public_id: string
  wallet_status: 'active' | 'frozen'
  wallet_balance: number
  wallet_sequence: number
  rebuilt_balance: number
  rebuilt_sequence: number
  entry_count: number
  chain_break_count: number
}

type RecoveryCommandRow = {
  id: string
  account_public_id: string
  anchor_case_id: string
  actor_id: number
  request_hash: string
  covered_case_count: number
  resolution_note: string
  evidence_reference: string
  expected_balance: number
  expected_sequence: number
  rebuilt_balance: number
  rebuilt_sequence: number
  status: string
  applied_at: string | null
}

type WalletRecoveryContext = {
  anchor: CaseRow
  wallet: WalletRecoveryStateRow
  coveredCases: RecoveryCaseEvidenceRow[]
  activeCases: RecoveryCaseEvidenceRow[]
  preview: AdminWalletReconciliationRecoveryPreviewView
}

type CandidateRow = {
  wallet_id: string
  account_id: number
  account_public_id: string
  wallet_balance: number
  wallet_sequence: number
  expected_balance: number
  expected_sequence: number
  entry_count: number
  chain_break_count: number
}

export async function listAdminAppWalletReconciliationRuns(
  db: D1Database,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AdminWalletReconciliationRunView[]> {
  await requireAppWalletPolicy(db, config)
  const result = await db.prepare(`
    SELECT run.id, run.status, run.wallet_count, run.difference_count,
           run.created_by, COALESCE(creator.nickname, creator.email) AS creator_label,
           run.lease_expires_at, run.failure_code,
           run.completed_at, run.created_at
    FROM app_wallet_reconciliation_runs run
    JOIN users creator ON creator.id = run.created_by
    ORDER BY run.created_at DESC, run.id DESC LIMIT 100
  `).all<RunRow>()
  return result.results.map(row => toRunView(row, now))
}

export async function listAdminAppWalletReconciliationCases(
  db: D1Database,
  status: string | undefined,
  actor: Actor,
  config: AppWalletRuntimeConfig,
): Promise<AdminWalletReconciliationCaseView[]> {
  const policy = await requireAppWalletPolicy(db, config)
  const normalizedStatus = normalizeCaseStatusFilter(status)
  const conditions = normalizedStatus ? ['reconciliation.status = ?'] : []
  const bindings: unknown[] = normalizedStatus ? [normalizedStatus] : []
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const result = await db.prepare(`
    ${caseSelect()}
    ${where}
    ORDER BY
      CASE reconciliation.status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 WHEN 'forward_fix_requested' THEN 2 ELSE 3 END,
      CASE reconciliation.severity WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 ELSE 2 END,
      reconciliation.created_at ASC, reconciliation.id ASC
    LIMIT 200
  `).bind(...bindings).all<CaseRow>()
  return result.results.map(row => toCaseView(row, actor, policy.max_single_amount))
}

export async function scanAdminAppWalletReconciliation(
  db: D1Database,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletReconciliationScanInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ run: AdminWalletReconciliationRunView; cases: AdminWalletReconciliationCaseView[]; replayed: boolean }> {
  requireOwner(actor)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const limit = normalizeLimit(input.limit)
  const policy = await requireAppWalletPolicy(db, config)
  const requestHash = await sha256Hex(JSON.stringify({ policyId: policy.id, limit }))
  const replay = await findRunByKey(db, actor.id, key)
  if (replay) {
    if (replay.request_hash !== requestHash) throw idempotencyConflict()
    const existing = await requireRun(db, replay.id, now)
    if (existing.status === 'running' && existing.executionRecoverable) {
      await db.batch([
        db.prepare(`
          UPDATE app_wallet_reconciliation_runs
          SET status = 'failed', lease_expires_at = NULL, execution_token = NULL,
              failure_code = 'SCAN_LEASE_EXPIRED', completed_at = ?
          WHERE id = ? AND status = 'running' AND lease_expires_at <= ?
        `).bind(now.toISOString(), replay.id, now.toISOString()),
        db.prepare(`
          INSERT INTO admin_audit_logs (
            id, admin_id, action, target_type, target_id, before_value, after_value, created_at
          )
          SELECT ?, ?, 'app.wallet.reconciliation.scan_expired', 'app_wallet_reconciliation_run', id, ?, ?, ?
          FROM app_wallet_reconciliation_runs
          WHERE id = ? AND status = 'failed' AND failure_code = 'SCAN_LEASE_EXPIRED'
        `).bind(
          randomId('log'),
          actor.id,
          JSON.stringify({ status: 'running' }),
          JSON.stringify({ status: 'failed', failureCode: 'SCAN_LEASE_EXPIRED' }),
          now.toISOString(),
          replay.id,
        ),
      ])
      throw new AppWalletError(409, 'WALLET_RECONCILIATION_SCAN_EXPIRED', '上次扫描执行已超时并标记失败，请使用新的幂等键重新扫描', true)
    }
    return {
      run: existing,
      cases: await listCasesForRun(db, replay.id, actor, policy.max_single_amount),
      replayed: true,
    }
  }
  const timestamp = now.toISOString()
  const runId = randomId('wrc')
  const executionToken = randomId('wrcx')
  const leaseExpiresAt = new Date(now.getTime() + SCAN_LEASE_MS).toISOString()
  await closeExpiredReconciliationRuns(db, actor.id, timestamp)
  const activeRun = await db.prepare(`
    SELECT id FROM app_wallet_reconciliation_runs
    WHERE status = 'running' AND lease_expires_at > ?
    ORDER BY created_at ASC, id ASC LIMIT 1
  `).bind(timestamp).first<{ id: string }>()
  if (activeRun) {
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_SCAN_IN_PROGRESS', '已有对账扫描正在执行，请等待完成后再试', true)
  }
  await db.prepare(`
    INSERT INTO app_wallet_reconciliation_runs (
      id, policy_id, status, wallet_count, difference_count,
      request_idempotency_key, request_hash, created_by,
      lease_expires_at, execution_token, created_at
    ) VALUES (?, ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?)
  `).bind(runId, policy.id, key, requestHash, actor.id, leaseExpiresAt, executionToken, timestamp).run()

  try {
    const candidates = await loadCandidates(db, limit)
    const differences: Array<{
      candidate: CandidateRow
      type: WalletReconciliationDifferenceType
      severity: 'p0' | 'p1' | 'p2'
      evidenceSha256: string
    }> = []
    for (const candidate of candidates) {
      const types: Array<{ type: WalletReconciliationDifferenceType; severity: 'p0' | 'p1' | 'p2' }> = []
      if (Number(candidate.wallet_balance) !== Number(candidate.expected_balance)) types.push({ type: 'balance_mismatch', severity: 'p0' })
      if (Number(candidate.wallet_sequence) !== Number(candidate.expected_sequence)) types.push({ type: 'sequence_mismatch', severity: 'p0' })
      if (Number(candidate.chain_break_count) > 0 || Number(candidate.entry_count) !== Number(candidate.expected_sequence)) {
        types.push({ type: 'entry_chain_break', severity: 'p1' })
      }
      for (const difference of types) {
        differences.push({
          candidate,
          ...difference,
          evidenceSha256: await sha256Hex(JSON.stringify({
            walletId: candidate.wallet_id,
            accountId: Number(candidate.account_id),
            differenceType: difference.type,
            walletBalance: Number(candidate.wallet_balance),
            expectedBalance: Number(candidate.expected_balance),
            walletSequence: Number(candidate.wallet_sequence),
            expectedSequence: Number(candidate.expected_sequence),
            entryCount: Number(candidate.entry_count),
            chainBreakCount: Number(candidate.chain_break_count),
          })),
        })
      }
    }

    const statements: D1PreparedStatement[] = []
    for (const difference of differences) {
      const caseId = randomId('wrd')
      statements.push(
        db.prepare(`
          INSERT INTO app_wallet_reconciliation_cases (
            id, run_id, wallet_id, account_id, account_public_id, difference_type,
            severity, wallet_balance, expected_balance, wallet_sequence, expected_sequence,
            evidence_sha256, status, version, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM app_wallet_reconciliation_cases existing
            WHERE existing.account_id = ? AND existing.difference_type = ?
              AND existing.evidence_sha256 = ?
              AND existing.status IN ('open', 'claimed', 'creating_forward_fix', 'forward_fix_requested', 'resolved')
          )
        `).bind(
          caseId,
          runId,
          difference.candidate.wallet_id,
          Number(difference.candidate.account_id),
          difference.candidate.account_public_id,
          difference.type,
          difference.severity,
          Number(difference.candidate.wallet_balance),
          Number(difference.candidate.expected_balance),
          Number(difference.candidate.wallet_sequence),
          Number(difference.candidate.expected_sequence),
          difference.evidenceSha256,
          timestamp,
          timestamp,
          Number(difference.candidate.account_id),
          difference.type,
          difference.evidenceSha256,
        ),
        db.prepare(`
          INSERT INTO app_wallet_reconciliation_events (
            id, case_id, sequence, event_type, actor_id, detail_json, created_at
          )
          SELECT ?, id, 1, 'detected', ?, ?, ?
          FROM app_wallet_reconciliation_cases WHERE id = ?
        `).bind(
          randomId('wre'),
          actor.id,
          JSON.stringify({ runId, evidenceSha256: difference.evidenceSha256 }),
          timestamp,
          caseId,
        ),
      )
    }
    statements.push(
      db.prepare(`
        UPDATE app_wallet_reconciliation_runs
        SET status = 'completed', wallet_count = ?, difference_count = ?,
            lease_expires_at = NULL, execution_token = NULL, completed_at = ?
        WHERE id = ? AND status = 'running' AND execution_token = ?
      `).bind(candidates.length, differences.length, timestamp, runId, executionToken),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app.wallet.reconciliation.scan', 'app_wallet_reconciliation_run', id, NULL, ?, ?
        FROM app_wallet_reconciliation_runs WHERE id = ? AND status = 'completed'
      `).bind(
        randomId('log'),
        actor.id,
        JSON.stringify({ walletCount: candidates.length, differenceCount: differences.length, limit }),
        timestamp,
        runId,
      ),
    )
    await db.batch(statements)
    return {
      run: await requireRun(db, runId, now),
      cases: await listCasesForRun(db, runId, actor, policy.max_single_amount),
      replayed: false,
    }
  }
  catch (error) {
    const failureCode = error instanceof AppWalletError ? error.code : 'SCAN_EXECUTION_FAILED'
    await db.batch([
      db.prepare(`
        UPDATE app_wallet_reconciliation_runs
        SET status = 'failed', lease_expires_at = NULL, execution_token = NULL,
            failure_code = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND execution_token = ?
      `).bind(failureCode.slice(0, 80), timestamp, runId, executionToken),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app.wallet.reconciliation.scan_failed', 'app_wallet_reconciliation_run', id, NULL, ?, ?
        FROM app_wallet_reconciliation_runs
        WHERE id = ? AND status = 'failed' AND failure_code = ?
      `).bind(
        randomId('log'),
        actor.id,
        JSON.stringify({ failureCode }),
        timestamp,
        runId,
        failureCode.slice(0, 80),
      ),
    ])
    throw error
  }
}

export async function claimAdminAppWalletReconciliationCase(
  db: D1Database,
  caseId: string,
  actor: Actor,
  input: AdminWalletReconciliationClaimInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AdminWalletReconciliationCaseView> {
  validateCaseId(caseId)
  requireOwner(actor)
  const policy = await requireAppWalletPolicy(db, config)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_reconciliation_cases
      SET status = 'claimed', version = version + 1, assigned_to = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'open' AND version = ?
    `).bind(actor.id, timestamp, timestamp, caseId, expectedVersion),
    db.prepare(`
      INSERT INTO app_wallet_reconciliation_events (
        id, case_id, sequence, event_type, actor_id, detail_json, created_at
      )
      SELECT ?, id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_reconciliation_events WHERE case_id = app_wallet_reconciliation_cases.id), 0) + 1,
             'claimed', ?, ?, ?
      FROM app_wallet_reconciliation_cases
      WHERE id = ? AND status = 'claimed' AND assigned_to = ? AND claimed_at = ?
    `).bind(randomId('wre'), actor.id, JSON.stringify({ expectedVersion }), timestamp, caseId, actor.id, timestamp),
    auditCaseStatement(db, actor.id, 'app.wallet.reconciliation.claim', caseId, { status: 'open', version: expectedVersion }, { status: 'claimed' }, timestamp, 'claimed'),
  ])
  const row = await findCase(db, caseId)
  if (!row || row.status !== 'claimed' || Number(row.assigned_to) !== actor.id) throw versionConflict()
  return toCaseView(row, actor, policy.max_single_amount)
}

export async function createAdminAppWalletReconciliationForwardFix(
  db: D1Database,
  caseId: string,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletReconciliationForwardFixInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ reconciliationCase: AdminWalletReconciliationCaseView; adjustment: AdminWalletAdjustmentView; replayed: boolean }> {
  validateCaseId(caseId)
  requireOwner(actor)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const caseRow = await requireCase(db, caseId)
  const policy = await requireAppWalletPolicy(db, config, { writable: true })
  // 关联令牌只绑定案件与负责人。这样浏览器刷新或网络中断后，即使客户端生成了
  // 新的幂等键，也能通过唯一业务单号找回已经创建、但尚未关联回案件的申请。
  const expectedMutationToken = mutationTokenFor(caseId, actor.id)
  if (caseRow.status === 'forward_fix_requested' && caseRow.forward_fix_adjustment_id) {
    const adjustment = await getAdminAppWalletAdjustment(db, caseRow.forward_fix_adjustment_id, config)
    if (adjustment.requestedBy.id !== actor.id) {
      throw new AppWalletError(409, 'WALLET_RECONCILIATION_ALREADY_LINKED', '该案件已由其他管理员创建纠正申请')
    }
    return {
      reconciliationCase: toCaseView(caseRow, actor, policy.max_single_amount),
      adjustment,
      replayed: true,
    }
  }
  if (caseRow.status === 'creating_forward_fix' && caseRow.mutation_token) {
    return recoverForwardFixLink(db, caseRow, actor, config, policy.max_single_amount, now)
  }
  if (caseRow.status !== 'claimed' || Number(caseRow.version) !== expectedVersion || Number(caseRow.assigned_to) !== actor.id) throw versionConflict()
  const proposal = resolveForwardFix(caseRow, policy.max_single_amount)
  if (!proposal.eligible || !proposal.direction || proposal.amount < 1) {
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_FORWARD_FIX_UNAVAILABLE', proposal.reason)
  }
  const userVisibleNote = normalizeText(input.userVisibleNote, 'userVisibleNote', 2, 160)
  const internalNote = normalizeText(input.internalNote, 'internalNote', 2, 320)
  const timestamp = now.toISOString()
  const mutationToken = expectedMutationToken
  const claimed = await db.prepare(`
    UPDATE app_wallet_reconciliation_cases
    SET status = 'creating_forward_fix', version = version + 1, mutation_token = ?, updated_at = ?
    WHERE id = ? AND status = 'claimed' AND version = ? AND assigned_to = ?
      AND forward_fix_adjustment_id IS NULL
  `).bind(mutationToken, timestamp, caseId, expectedVersion, actor.id).run()
  if (!claimed.meta.changes) throw versionConflict()
  let adjustmentResult: Awaited<ReturnType<typeof createAdminAppWalletAdjustment>>
  try {
    adjustmentResult = await createAdminAppWalletAdjustment(
      db,
      actor.id,
      key,
      {
        accountId: caseRow.account_public_id,
        actionType: proposal.direction === 'credit' ? 'admin_credit' : 'admin_debit',
        amount: proposal.amount,
        reasonCode: 'correction',
        userVisibleNote,
        internalNote: `${internalNote}\n对账案件：${caseId}\n证据：${caseRow.evidence_sha256}`,
        businessReference: `RECON-${caseId}`,
      },
      config,
      now,
    )
  }
  catch (error) {
    await db.prepare(`
      UPDATE app_wallet_reconciliation_cases
      SET status = 'claimed', version = version + 1, mutation_token = NULL, updated_at = ?
      WHERE id = ? AND status = 'creating_forward_fix' AND mutation_token = ?
    `).bind(timestamp, caseId, mutationToken).run()
    throw error
  }
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_reconciliation_cases
      SET status = 'forward_fix_requested', version = version + 1,
          forward_fix_adjustment_id = ?, mutation_token = NULL, updated_at = ?
      WHERE id = ? AND status = 'creating_forward_fix' AND mutation_token = ? AND assigned_to = ?
        AND forward_fix_adjustment_id IS NULL
    `).bind(adjustmentResult.adjustment.adjustmentId, timestamp, caseId, mutationToken, actor.id),
    db.prepare(`
      INSERT INTO app_wallet_reconciliation_events (
        id, case_id, sequence, event_type, actor_id, detail_json, created_at
      )
      SELECT ?, id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_reconciliation_events WHERE case_id = app_wallet_reconciliation_cases.id), 0) + 1,
             'forward_fix_requested', ?, ?, ?
      FROM app_wallet_reconciliation_cases
      WHERE id = ? AND status = 'forward_fix_requested' AND forward_fix_adjustment_id = ?
    `).bind(
      randomId('wre'),
      actor.id,
      JSON.stringify({ adjustmentId: adjustmentResult.adjustment.adjustmentId, direction: proposal.direction, amount: proposal.amount }),
      timestamp,
      caseId,
      adjustmentResult.adjustment.adjustmentId,
    ),
    auditCaseStatement(
      db,
      actor.id,
      'app.wallet.reconciliation.forward_fix_request',
      caseId,
      { status: 'claimed', version: expectedVersion },
      { status: 'forward_fix_requested', adjustmentId: adjustmentResult.adjustment.adjustmentId },
      timestamp,
      'forward_fix_requested',
    ),
  ])
  const updated = await findCase(db, caseId)
  if (!updated || updated.forward_fix_adjustment_id !== adjustmentResult.adjustment.adjustmentId) {
    return recoverForwardFixLink(db, await requireCase(db, caseId), actor, config, policy.max_single_amount, now)
  }
  return {
    reconciliationCase: toCaseView(updated, actor, policy.max_single_amount),
    adjustment: adjustmentResult.adjustment,
    replayed: adjustmentResult.replayed,
  }
}

async function recoverForwardFixLink(
  db: D1Database,
  caseRow: CaseRow,
  actor: Actor,
  config: AppWalletRuntimeConfig,
  maxSingleAmount: number,
  now: Date,
): Promise<{ reconciliationCase: AdminWalletReconciliationCaseView; adjustment: AdminWalletAdjustmentView; replayed: boolean }> {
  const expectedToken = mutationTokenFor(caseRow.id, actor.id)
  if (caseRow.status !== 'creating_forward_fix' || caseRow.mutation_token !== expectedToken || Number(caseRow.assigned_to) !== actor.id) {
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_LINK_CONFLICT', '纠正申请关联状态异常，请人工核对调币队列')
  }
  const adjustment = await findAdjustmentForCase(db, actor.id, caseRow.id, config)
  if (!adjustment) {
    const creatingAt = Date.parse(caseRow.updated_at)
    const staleAfterMs = 5 * 60 * 1000
    if (Number.isFinite(creatingAt) && now.getTime() - creatingAt < staleAfterMs) {
      throw new AppWalletError(
        409,
        'WALLET_RECONCILIATION_FIX_CREATING',
        '纠正申请仍在创建中，请稍后刷新案件；系统不会并发重置正在执行的申请',
        true,
      )
    }
    const timestamp = now.toISOString()
    await db.batch([
      db.prepare(`
        UPDATE app_wallet_reconciliation_cases
        SET status = 'claimed', version = version + 1, mutation_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'creating_forward_fix' AND mutation_token = ?
      `).bind(timestamp, caseRow.id, expectedToken),
      auditCaseStatement(
        db,
        actor.id,
        'app.wallet.reconciliation.forward_fix_recovery_reset',
        caseRow.id,
        { status: 'creating_forward_fix' },
        { status: 'claimed', reason: 'stale_adjustment_not_found' },
        timestamp,
        'claimed',
      ),
    ])
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_FIX_NOT_CREATED', '创建状态已超过 5 分钟且未找到对应申请，案件已恢复为可重试状态', true)
  }
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_reconciliation_cases
      SET status = 'forward_fix_requested', version = version + 1,
          forward_fix_adjustment_id = ?, mutation_token = NULL, updated_at = ?
      WHERE id = ? AND status = 'creating_forward_fix' AND mutation_token = ?
        AND forward_fix_adjustment_id IS NULL
    `).bind(adjustment.adjustmentId, timestamp, caseRow.id, expectedToken),
    db.prepare(`
      INSERT INTO app_wallet_reconciliation_events (
        id, case_id, sequence, event_type, actor_id, detail_json, created_at
      )
      SELECT ?, id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_reconciliation_events WHERE case_id = app_wallet_reconciliation_cases.id), 0) + 1,
             'forward_fix_requested', ?, ?, ?
      FROM app_wallet_reconciliation_cases
      WHERE id = ? AND status = 'forward_fix_requested' AND forward_fix_adjustment_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM app_wallet_reconciliation_events event
          WHERE event.case_id = app_wallet_reconciliation_cases.id AND event.event_type = 'forward_fix_requested'
        )
    `).bind(randomId('wre'), actor.id, JSON.stringify({ adjustmentId: adjustment.adjustmentId, recovered: true }), timestamp, caseRow.id, adjustment.adjustmentId),
    auditCaseStatement(
      db,
      actor.id,
      'app.wallet.reconciliation.forward_fix_link_recovered',
      caseRow.id,
      { status: 'creating_forward_fix' },
      { status: 'forward_fix_requested', adjustmentId: adjustment.adjustmentId },
      timestamp,
      'forward_fix_requested',
    ),
  ])
  const updated = await requireCase(db, caseRow.id)
  if (updated.status !== 'forward_fix_requested' || updated.forward_fix_adjustment_id !== adjustment.adjustmentId) {
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_LINK_CONFLICT', '纠正申请已创建但案件关联仍未恢复，请人工核对')
  }
  return { reconciliationCase: toCaseView(updated, actor, maxSingleAmount), adjustment, replayed: true }
}

async function findAdjustmentForCase(
  db: D1Database,
  actorId: number,
  caseId: string,
  config: AppWalletRuntimeConfig,
) {
  const row = await db.prepare(`
    SELECT id FROM app_wallet_adjustments
    WHERE requested_by = ? AND business_reference = ? LIMIT 1
  `).bind(actorId, `RECON-${caseId}`).first<{ id: string }>()
  return row ? getAdminAppWalletAdjustment(db, row.id, config) : null
}

export async function verifyAdminAppWalletReconciliationCase(
  db: D1Database,
  caseId: string,
  actor: Actor,
  input: AdminWalletReconciliationVerifyInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AdminWalletReconciliationCaseView> {
  validateCaseId(caseId)
  requireOwner(actor)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const resolutionNote = normalizeText(input.resolutionNote, 'resolutionNote', 2, 500)
  const policy = await requireAppWalletPolicy(db, config)
  const reconciliationCase = await requireCase(db, caseId)
  if (reconciliationCase.status !== 'forward_fix_requested' || Number(reconciliationCase.version) !== expectedVersion || !reconciliationCase.forward_fix_adjustment_id) throw versionConflict()
  const adjustment = await getAdminAppWalletAdjustment(db, reconciliationCase.forward_fix_adjustment_id, config)
  if (adjustment.status !== 'applied') {
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_FIX_NOT_APPLIED', '纠正调币申请尚未独立复核入账')
  }
  const current = await loadCurrentWalletState(db, reconciliationCase.account_public_id)
  if (!current || current.wallet_balance !== current.expected_balance || current.wallet_sequence !== current.expected_sequence) {
    throw new AppWalletError(409, 'WALLET_RECONCILIATION_STILL_MISMATCHED', '纠正申请入账后仍存在当前差异，请重新扫描并升级 Runbook')
  }
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_reconciliation_cases
      SET status = 'resolved', version = version + 1, resolution_note = ?, updated_at = ?
      WHERE id = ? AND status = 'forward_fix_requested' AND version = ?
        AND forward_fix_adjustment_id = ?
    `).bind(resolutionNote, timestamp, caseId, expectedVersion, adjustment.adjustmentId),
    db.prepare(`
      INSERT INTO app_wallet_reconciliation_events (
        id, case_id, sequence, event_type, actor_id, detail_json, created_at
      )
      SELECT ?, id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_reconciliation_events WHERE case_id = app_wallet_reconciliation_cases.id), 0) + 1,
             'resolved', ?, ?, ?
      FROM app_wallet_reconciliation_cases
      WHERE id = ? AND status = 'resolved' AND updated_at = ?
    `).bind(randomId('wre'), actor.id, JSON.stringify({ adjustmentId: adjustment.adjustmentId, resolutionNote }), timestamp, caseId, timestamp),
    auditCaseStatement(db, actor.id, 'app.wallet.reconciliation.resolve', caseId, { status: 'forward_fix_requested' }, { status: 'resolved', adjustmentId: adjustment.adjustmentId }, timestamp, 'resolved'),
  ])
  const updated = await findCase(db, caseId)
  if (!updated || updated.status !== 'resolved') throw versionConflict()
  return toCaseView(updated, actor, policy.max_single_amount)
}

export async function previewAdminAppWalletReconciliationRecovery(
  db: D1Database,
  caseId: string,
  actor: Actor,
  config: AppWalletRuntimeConfig,
): Promise<AdminWalletReconciliationRecoveryPreviewView> {
  validateCaseId(caseId)
  requireOwner(actor)
  await requireAppWalletPolicy(db, config)
  return (await buildWalletRecoveryContext(db, caseId, actor)).preview
}

export async function recoverAdminAppWalletReconciliation(
  db: D1Database,
  caseId: string,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletReconciliationRecoveryInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{
    recovery: AdminWalletRecoveryView
    reconciliationCase: AdminWalletReconciliationCaseView
    replayed: boolean
  }> {
  validateCaseId(caseId)
  requireOwner(actor)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const caseSetDigest = normalizeSha256(input.caseSetDigest, 'caseSetDigest')
  const resolutionNote = normalizeText(input.resolutionNote, 'resolutionNote', 2, 500)
  const evidenceReference = normalizeText(input.evidenceReference, 'evidenceReference', 3, 300)
  const policy = await requireAppWalletPolicy(db, config)
  const requestHash = await sha256Hex(JSON.stringify({
    caseId,
    expectedVersion,
    caseSetDigest,
    resolutionNote,
    evidenceReference,
  }))

  const replay = await findRecoveryCommandByKey(db, actor.id, key)
  if (replay) {
    if (replay.request_hash !== requestHash) throw recoveryIdempotencyConflict()
    const recovery = toRecoveryView(replay)
    const reconciliationCase = toCaseView(await requireCase(db, replay.anchor_case_id), actor, policy.max_single_amount)
    return { recovery, reconciliationCase, replayed: true }
  }

  const context = await buildWalletRecoveryContext(db, caseId, actor)
  const concurrentReplay = await findRecoveryCommandByKey(db, actor.id, key)
  if (concurrentReplay) {
    if (concurrentReplay.request_hash !== requestHash) throw recoveryIdempotencyConflict()
    const recovery = toRecoveryView(concurrentReplay)
    const reconciliationCase = toCaseView(await requireCase(db, concurrentReplay.anchor_case_id), actor, policy.max_single_amount)
    return { recovery, reconciliationCase, replayed: true }
  }
  if (Number(context.anchor.version) !== expectedVersion) throw versionConflict()
  if (context.preview.caseSetDigest !== caseSetDigest) {
    throw new AppWalletError(409, 'WALLET_RECOVERY_PREVIEW_STALE', '钱包或对账案件已变化，请重新检查恢复条件', true)
  }
  if (!context.preview.eligible) {
    throw new AppWalletError(409, 'WALLET_RECOVERY_BLOCKED', context.preview.blockers.join('；') || '钱包当前不满足恢复条件')
  }
  if (context.coveredCases.some(reconciliationCase => reconciliationCase.status !== 'claimed' && reconciliationCase.status !== 'resolved')) {
    throw invalidData()
  }

  const commandId = randomId('wrec')
  const timestamp = now.toISOString()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_wallet_recovery_commands (
        id, wallet_id, account_id, anchor_case_id, actor_id,
        idempotency_key, request_hash, case_set_digest, covered_case_count,
        reason_code, resolution_note, evidence_reference,
        expected_wallet_status, expected_balance, expected_sequence,
        rebuilt_balance, rebuilt_sequence, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified_snapshot_rebuild', ?, ?,
                'frozen', ?, ?, ?, ?, 'executing', ?)
    `).bind(
      commandId,
      context.wallet.wallet_id,
      context.wallet.account_id,
      caseId,
      actor.id,
      key,
      requestHash,
      caseSetDigest,
      context.coveredCases.length,
      resolutionNote,
      evidenceReference,
      context.wallet.wallet_balance,
      context.wallet.wallet_sequence,
      context.wallet.rebuilt_balance,
      context.wallet.rebuilt_sequence,
      timestamp,
    ),
  ]

  for (const reconciliationCase of context.coveredCases) {
    statements.push(db.prepare(`
      INSERT INTO app_wallet_recovery_case_links (
        command_id, case_id, expected_version, previous_status, evidence_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      commandId,
      reconciliationCase.id,
      Number(reconciliationCase.version),
      reconciliationCase.status,
      reconciliationCase.evidence_sha256,
      timestamp,
    ))
  }

  statements.push(db.prepare(`
    UPDATE app_wallets
    SET balance = ?, sequence = ?, status = 'active', updated_at = ?
    WHERE id = ? AND account_id = ? AND status = 'frozen'
      AND balance = ? AND sequence = ?
      AND EXISTS (
        SELECT 1 FROM app_wallet_recovery_commands recovery
        WHERE recovery.id = ? AND recovery.status = 'executing'
      )
  `).bind(
    context.wallet.rebuilt_balance,
    context.wallet.rebuilt_sequence,
    timestamp,
    context.wallet.wallet_id,
    context.wallet.account_id,
    context.wallet.wallet_balance,
    context.wallet.wallet_sequence,
    commandId,
  ))

  for (const reconciliationCase of context.activeCases) {
    statements.push(
      db.prepare(`
        UPDATE app_wallet_reconciliation_cases
        SET status = 'resolved', version = version + 1,
            resolution_note = ?, updated_at = ?
        WHERE id = ? AND wallet_id = ? AND account_id = ?
          AND status = 'claimed' AND version = ? AND assigned_to = ?
      `).bind(
        resolutionNote,
        timestamp,
        reconciliationCase.id,
        context.wallet.wallet_id,
        context.wallet.account_id,
        Number(reconciliationCase.version),
        actor.id,
      ),
      db.prepare(`
        INSERT INTO app_wallet_reconciliation_events (
          id, case_id, sequence, event_type, actor_id, detail_json, created_at
        )
        SELECT ?, id,
               COALESCE((SELECT MAX(sequence) FROM app_wallet_reconciliation_events WHERE case_id = app_wallet_reconciliation_cases.id), 0) + 1,
               'resolved', ?, ?, ?
        FROM app_wallet_reconciliation_cases
        WHERE id = ? AND status = 'resolved' AND updated_at = ?
      `).bind(
        randomId('wre'),
        actor.id,
        JSON.stringify({ commandId, reasonCode: 'verified_snapshot_rebuild', evidenceReference }),
        timestamp,
        reconciliationCase.id,
        timestamp,
      ),
      auditCaseStatement(
        db,
        actor.id,
        'app.wallet.reconciliation.recover_case',
        reconciliationCase.id,
        { status: 'claimed', version: Number(reconciliationCase.version) },
        { status: 'resolved', recoveryCommandId: commandId },
        timestamp,
        'resolved',
      ),
    )
  }

  statements.push(
    db.prepare(`
      UPDATE app_wallet_recovery_commands
      SET status = 'applied', applied_at = ?
      WHERE id = ? AND status = 'executing'
    `).bind(timestamp, commandId),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.recovery.apply', 'app_wallet', wallet.id, ?, ?, ?
      FROM app_wallet_recovery_commands recovery
      JOIN app_wallets wallet ON wallet.id = recovery.wallet_id
      WHERE recovery.id = ? AND recovery.status = 'applied'
    `).bind(
      randomId('log'),
      actor.id,
      JSON.stringify({
        status: 'frozen',
        balance: context.wallet.wallet_balance,
        sequence: context.wallet.wallet_sequence,
      }),
      JSON.stringify({
        status: 'active',
        balance: context.wallet.rebuilt_balance,
        sequence: context.wallet.rebuilt_sequence,
        recoveryCommandId: commandId,
        caseSetDigest,
        evidenceReference,
      }),
      timestamp,
      commandId,
    ),
  )

  try {
    await db.batch(statements)
  }
  catch (error) {
    const concurrentReplay = await findRecoveryCommandByKey(db, actor.id, key)
    if (concurrentReplay && concurrentReplay.request_hash === requestHash) {
      const recovery = toRecoveryView(concurrentReplay)
      const reconciliationCase = toCaseView(await requireCase(db, concurrentReplay.anchor_case_id), actor, policy.max_single_amount)
      return { recovery, reconciliationCase, replayed: true }
    }
    if (isRecoveryConflictError(error)) {
      throw new AppWalletError(409, 'WALLET_RECOVERY_CONFLICT', '恢复执行期间钱包或案件已变化，请刷新并重新检查', true)
    }
    throw error
  }

  const recovery = toRecoveryView(await requireRecoveryCommand(db, commandId))
  const reconciliationCase = toCaseView(await requireCase(db, caseId), actor, policy.max_single_amount)
  return { recovery, reconciliationCase, replayed: false }
}

async function buildWalletRecoveryContext(
  db: D1Database,
  caseId: string,
  actor: Actor,
): Promise<WalletRecoveryContext> {
  const anchor = await requireCase(db, caseId)
  if (!anchor.wallet_id) throw invalidData()
  const wallet = await loadWalletRecoveryState(db, anchor.wallet_id)
  if (!wallet || Number(wallet.account_id) !== Number(anchor.account_id)) throw invalidData()
  if (wallet.wallet_status !== 'active' && wallet.wallet_status !== 'frozen') throw invalidData()

  const activeCases = await loadActiveWalletRecoveryCases(db, wallet.wallet_id)
  const blockers: string[] = []
  if (activeCases.length > 200) blockers.push('未终结案件超过单次恢复上限，必须拆分 Runbook 处置')
  if (wallet.wallet_status !== 'frozen') blockers.push('钱包当前不是冻结状态，无需执行恢复')
  if (anchor.status !== 'claimed' && anchor.status !== 'resolved') blockers.push('锚点案件必须已认领或已验证解决')
  if (anchor.status === 'claimed' && Number(anchor.assigned_to) !== actor.id) blockers.push('锚点案件必须由当前 Owner 认领')
  if (Number(wallet.entry_count) !== Number(wallet.rebuilt_sequence) || Number(wallet.chain_break_count) > 0) {
    blockers.push('不可变分录链仍有断点，禁止通过快照重建解冻')
  }

  for (const reconciliationCase of activeCases) {
    if (!isDifferenceType(reconciliationCase.difference_type) || !isCaseStatus(reconciliationCase.status)) throw invalidData()
    if (reconciliationCase.status !== 'claimed') blockers.push(`案件 ${reconciliationCase.id} 尚未进入已认领状态`)
    else if (Number(reconciliationCase.assigned_to) !== actor.id) blockers.push(`案件 ${reconciliationCase.id} 由其他管理员负责`)
  }

  const coveredById = new Map<string, RecoveryCaseEvidenceRow>()
  for (const reconciliationCase of activeCases) coveredById.set(reconciliationCase.id, reconciliationCase)
  if (anchor.status === 'resolved') {
    coveredById.set(anchor.id, {
      id: anchor.id,
      wallet_id: anchor.wallet_id,
      account_id: anchor.account_id,
      account_public_id: anchor.account_public_id,
      difference_type: anchor.difference_type,
      evidence_sha256: anchor.evidence_sha256,
      status: anchor.status,
      version: anchor.version,
      assigned_to: anchor.assigned_to,
    })
  }
  const coveredCases = [...coveredById.values()].sort((left, right) => left.id.localeCompare(right.id))
  if (!coveredCases.length) blockers.push('没有可由本次恢复命令覆盖的对账案件')
  if (coveredCases.length > 200) blockers.push('本次恢复覆盖案件超过 200 条上限')

  const caseSetDigest = await sha256Hex(JSON.stringify({
    anchor: { id: anchor.id, status: anchor.status, version: Number(anchor.version) },
    wallet: {
      id: wallet.wallet_id,
      status: wallet.wallet_status,
      balance: Number(wallet.wallet_balance),
      sequence: Number(wallet.wallet_sequence),
      rebuiltBalance: Number(wallet.rebuilt_balance),
      rebuiltSequence: Number(wallet.rebuilt_sequence),
      entryCount: Number(wallet.entry_count),
      chainBreakCount: Number(wallet.chain_break_count),
    },
    cases: coveredCases.map(reconciliationCase => ({
      id: reconciliationCase.id,
      status: reconciliationCase.status,
      version: Number(reconciliationCase.version),
      assignedTo: reconciliationCase.assigned_to === null ? null : Number(reconciliationCase.assigned_to),
      evidenceSha256: reconciliationCase.evidence_sha256,
    })),
  }))

  const preview: AdminWalletReconciliationRecoveryPreviewView = {
    caseId: anchor.id,
    accountId: wallet.account_public_id,
    anchorVersion: Number(anchor.version),
    walletStatus: wallet.wallet_status,
    walletBalance: Number(wallet.wallet_balance),
    walletSequence: Number(wallet.wallet_sequence),
    rebuiltBalance: Number(wallet.rebuilt_balance),
    rebuiltSequence: Number(wallet.rebuilt_sequence),
    snapshotChangeRequired: Number(wallet.wallet_balance) !== Number(wallet.rebuilt_balance)
      || Number(wallet.wallet_sequence) !== Number(wallet.rebuilt_sequence),
    coveredCases: coveredCases.map(reconciliationCase => ({
      caseId: reconciliationCase.id,
      differenceType: reconciliationCase.difference_type as WalletReconciliationDifferenceType,
      status: reconciliationCase.status as WalletReconciliationCaseStatus,
      version: Number(reconciliationCase.version),
    })),
    caseSetDigest,
    eligible: blockers.length === 0,
    blockers,
  }
  return { anchor, wallet, coveredCases, activeCases, preview }
}

async function loadCandidates(db: D1Database, limit: number) {
  const result = await db.prepare(`
    SELECT wallet.id AS wallet_id, wallet.account_id, security.account_public_id,
           wallet.balance AS wallet_balance, wallet.sequence AS wallet_sequence,
           COALESCE((
             SELECT latest.balance_after FROM app_wallet_entries latest
             WHERE latest.wallet_id = wallet.id ORDER BY latest.sequence DESC LIMIT 1
           ), 0) AS expected_balance,
           COALESCE((
             SELECT latest.sequence FROM app_wallet_entries latest
             WHERE latest.wallet_id = wallet.id ORDER BY latest.sequence DESC LIMIT 1
           ), 0) AS expected_sequence,
           (SELECT COUNT(*) FROM app_wallet_entries counted WHERE counted.wallet_id = wallet.id) AS entry_count,
           (
             SELECT COUNT(*) FROM app_wallet_entries entry
             WHERE entry.wallet_id = wallet.id
               AND (
                 (entry.sequence = 1 AND entry.balance_before <> 0)
                 OR (
                   entry.sequence > 1
                   AND NOT EXISTS (
                     SELECT 1 FROM app_wallet_entries previous
                     WHERE previous.wallet_id = entry.wallet_id
                       AND previous.sequence = entry.sequence - 1
                       AND previous.balance_after = entry.balance_before
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM app_wallet_reconciliation_cases covered
                     JOIN app_wallet_adjustments adjustment ON adjustment.id = covered.forward_fix_adjustment_id
                     WHERE covered.status = 'resolved' AND adjustment.entry_id = entry.id
                   )
                 )
               )
           ) AS chain_break_count
    FROM app_wallets wallet
    JOIN app_account_security security ON security.account_id = wallet.account_id
    ORDER BY wallet.updated_at ASC, wallet.id ASC
    LIMIT ?
  `).bind(limit).all<CandidateRow>()
  return result.results
}

async function loadCurrentWalletState(db: D1Database, accountPublicId: string) {
  return db.prepare(`
    SELECT wallet.balance AS wallet_balance, wallet.sequence AS wallet_sequence,
           COALESCE((SELECT balance_after FROM app_wallet_entries WHERE wallet_id = wallet.id ORDER BY sequence DESC LIMIT 1), 0) AS expected_balance,
           COALESCE((SELECT sequence FROM app_wallet_entries WHERE wallet_id = wallet.id ORDER BY sequence DESC LIMIT 1), 0) AS expected_sequence
    FROM app_wallets wallet
    JOIN app_account_security security ON security.account_id = wallet.account_id
    WHERE security.account_public_id = ? LIMIT 1
  `).bind(accountPublicId).first<{
    wallet_balance: number
    wallet_sequence: number
    expected_balance: number
    expected_sequence: number
  }>()
}

async function loadWalletRecoveryState(db: D1Database, walletId: string) {
  return db.prepare(`
    SELECT wallet.id AS wallet_id, wallet.account_id, security.account_public_id,
           wallet.status AS wallet_status,
           wallet.balance AS wallet_balance, wallet.sequence AS wallet_sequence,
           COALESCE((
             SELECT latest.balance_after FROM app_wallet_entries latest
             WHERE latest.wallet_id = wallet.id ORDER BY latest.sequence DESC LIMIT 1
           ), 0) AS rebuilt_balance,
           COALESCE((
             SELECT latest.sequence FROM app_wallet_entries latest
             WHERE latest.wallet_id = wallet.id ORDER BY latest.sequence DESC LIMIT 1
           ), 0) AS rebuilt_sequence,
           (SELECT COUNT(*) FROM app_wallet_entries counted WHERE counted.wallet_id = wallet.id) AS entry_count,
           (
             SELECT COUNT(*) FROM app_wallet_entries entry
             WHERE entry.wallet_id = wallet.id
               AND (
                 (entry.sequence = 1 AND entry.balance_before <> 0)
                 OR (
                   entry.sequence > 1
                   AND NOT EXISTS (
                     SELECT 1 FROM app_wallet_entries previous
                     WHERE previous.wallet_id = entry.wallet_id
                       AND previous.sequence = entry.sequence - 1
                       AND previous.balance_after = entry.balance_before
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM app_wallet_reconciliation_cases covered
                     JOIN app_wallet_adjustments adjustment ON adjustment.id = covered.forward_fix_adjustment_id
                     WHERE covered.status = 'resolved' AND adjustment.entry_id = entry.id
                   )
                 )
               )
           ) AS chain_break_count
    FROM app_wallets wallet
    JOIN app_account_security security ON security.account_id = wallet.account_id
    WHERE wallet.id = ? LIMIT 1
  `).bind(walletId).first<WalletRecoveryStateRow>()
}

async function loadActiveWalletRecoveryCases(db: D1Database, walletId: string) {
  const result = await db.prepare(`
    SELECT id, wallet_id, account_id, account_public_id, difference_type,
           evidence_sha256, status, version, assigned_to
    FROM app_wallet_reconciliation_cases
    WHERE wallet_id = ? AND status NOT IN ('resolved', 'dismissed')
    ORDER BY created_at ASC, id ASC
    LIMIT 201
  `).bind(walletId).all<RecoveryCaseEvidenceRow>()
  return result.results
}

async function findRecoveryCommandByKey(db: D1Database, actorId: number, key: string) {
  return db.prepare(`${recoveryCommandSelect()} WHERE recovery.actor_id = ? AND recovery.idempotency_key = ? LIMIT 1`)
    .bind(actorId, key).first<RecoveryCommandRow>()
}

async function requireRecoveryCommand(db: D1Database, commandId: string) {
  const row = await db.prepare(`${recoveryCommandSelect()} WHERE recovery.id = ? LIMIT 1`)
    .bind(commandId).first<RecoveryCommandRow>()
  if (!row) throw new AppWalletError(409, 'WALLET_RECOVERY_NOT_APPLIED', '钱包恢复命令未完成，请刷新后核对', true)
  return row
}

function recoveryCommandSelect() {
  return `
    SELECT recovery.id, security.account_public_id, recovery.anchor_case_id,
           recovery.actor_id, recovery.request_hash, recovery.covered_case_count,
           recovery.resolution_note, recovery.evidence_reference,
           recovery.expected_balance, recovery.expected_sequence,
           recovery.rebuilt_balance, recovery.rebuilt_sequence,
           recovery.status, recovery.applied_at
    FROM app_wallet_recovery_commands recovery
    JOIN app_account_security security ON security.account_id = recovery.account_id
  `
}

async function listCasesForRun(db: D1Database, runId: string, actor: Actor, maxSingleAmount: number) {
  const result = await db.prepare(`${caseSelect()} WHERE reconciliation.run_id = ? ORDER BY reconciliation.created_at ASC, reconciliation.id ASC`)
    .bind(runId).all<CaseRow>()
  return result.results.map(row => toCaseView(row, actor, maxSingleAmount))
}

function caseSelect() {
  return `
    SELECT reconciliation.id, reconciliation.run_id, reconciliation.wallet_id,
           reconciliation.account_id, reconciliation.account_public_id,
           reconciliation.difference_type, reconciliation.severity,
           reconciliation.wallet_balance, reconciliation.expected_balance,
           reconciliation.wallet_sequence, reconciliation.expected_sequence,
           reconciliation.evidence_sha256, reconciliation.status, reconciliation.version,
           reconciliation.assigned_to,
           CASE WHEN assignee.id IS NULL THEN NULL ELSE COALESCE(assignee.nickname, assignee.email) END AS assignee_label,
           reconciliation.claimed_at, reconciliation.resolution_note,
           reconciliation.forward_fix_adjustment_id, reconciliation.mutation_token,
           wallet.status AS wallet_status,
           (
             SELECT recovery.id FROM app_wallet_recovery_commands recovery
             WHERE recovery.wallet_id = reconciliation.wallet_id AND recovery.status = 'applied'
             ORDER BY recovery.applied_at DESC, recovery.id DESC LIMIT 1
           ) AS recovery_command_id,
           (
             SELECT recovery.applied_at FROM app_wallet_recovery_commands recovery
             WHERE recovery.wallet_id = reconciliation.wallet_id AND recovery.status = 'applied'
             ORDER BY recovery.applied_at DESC, recovery.id DESC LIMIT 1
           ) AS recovery_applied_at,
           reconciliation.created_at, reconciliation.updated_at
    FROM app_wallet_reconciliation_cases reconciliation
    LEFT JOIN users assignee ON assignee.id = reconciliation.assigned_to
    LEFT JOIN app_wallets wallet ON wallet.id = reconciliation.wallet_id
  `
}

async function findCase(db: D1Database, caseId: string) {
  return db.prepare(`${caseSelect()} WHERE reconciliation.id = ? LIMIT 1`).bind(caseId).first<CaseRow>()
}

async function requireCase(db: D1Database, caseId: string) {
  const row = await findCase(db, caseId)
  if (!row) throw new AppWalletError(404, 'WALLET_RECONCILIATION_CASE_NOT_FOUND', '钱包对账案件不存在')
  return row
}

async function requireRun(db: D1Database, runId: string, now = new Date()) {
  const row = await db.prepare(`
    SELECT run.id, run.status, run.wallet_count, run.difference_count,
           run.created_by, COALESCE(creator.nickname, creator.email) AS creator_label,
           run.lease_expires_at, run.failure_code,
           run.completed_at, run.created_at
    FROM app_wallet_reconciliation_runs run
    JOIN users creator ON creator.id = run.created_by
    WHERE run.id = ? LIMIT 1
  `).bind(runId).first<RunRow>()
  if (!row) throw new AppWalletError(404, 'WALLET_RECONCILIATION_RUN_NOT_FOUND', '钱包对账扫描不存在')
  return toRunView(row, now)
}

async function findRunByKey(db: D1Database, actorId: number, key: string) {
  return db.prepare(`SELECT id, request_hash FROM app_wallet_reconciliation_runs WHERE created_by = ? AND request_idempotency_key = ? LIMIT 1`)
    .bind(actorId, key).first<{ id: string; request_hash: string }>()
}

async function closeExpiredReconciliationRuns(db: D1Database, actorId: number, timestamp: string) {
  const expired = await db.prepare(`
    SELECT id FROM app_wallet_reconciliation_runs
    WHERE status = 'running' AND lease_expires_at <= ?
    ORDER BY created_at ASC, id ASC LIMIT 100
  `).bind(timestamp).all<{ id: string }>()
  if (!expired.results.length) return
  const statements: D1PreparedStatement[] = []
  for (const run of expired.results) {
    statements.push(
      db.prepare(`
        UPDATE app_wallet_reconciliation_runs
        SET status = 'failed', lease_expires_at = NULL, execution_token = NULL,
            failure_code = 'SCAN_LEASE_EXPIRED', completed_at = ?
        WHERE id = ? AND status = 'running' AND lease_expires_at <= ?
      `).bind(timestamp, run.id, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app.wallet.reconciliation.scan_expired', 'app_wallet_reconciliation_run', id, ?, ?, ?
        FROM app_wallet_reconciliation_runs
        WHERE id = ? AND status = 'failed' AND failure_code = 'SCAN_LEASE_EXPIRED' AND completed_at = ?
      `).bind(
        randomId('log'),
        actorId,
        JSON.stringify({ status: 'running' }),
        JSON.stringify({ status: 'failed', failureCode: 'SCAN_LEASE_EXPIRED' }),
        timestamp,
        run.id,
        timestamp,
      ),
    )
  }
  await db.batch(statements)
}

function auditCaseStatement(
  db: D1Database,
  actorId: number,
  action: string,
  caseId: string,
  before: unknown,
  after: unknown,
  timestamp: string,
  expectedStatus: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_wallet_reconciliation_case', id, ?, ?, ?
    FROM app_wallet_reconciliation_cases WHERE id = ? AND status = ?
  `).bind(randomId('log'), actorId, action, JSON.stringify(before), JSON.stringify(after), timestamp, caseId, expectedStatus)
}

function toRunView(row: RunRow, now = new Date()): AdminWalletReconciliationRunView {
  if (row.status !== 'running' && row.status !== 'completed' && row.status !== 'failed') throw invalidData()
  return {
    runId: row.id,
    status: row.status,
    walletCount: Number(row.wallet_count),
    differenceCount: Number(row.difference_count),
    createdBy: { id: Number(row.created_by), label: row.creator_label },
    leaseExpiresAt: row.lease_expires_at,
    executionRecoverable: row.status === 'running'
      && Boolean(row.lease_expires_at)
      && Date.parse(row.lease_expires_at!) <= now.getTime(),
    failureCode: row.failure_code,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }
}

function toCaseView(row: CaseRow, actor: Actor, maxSingleAmount: number): AdminWalletReconciliationCaseView {
  if (!isDifferenceType(row.difference_type) || !isCaseStatus(row.status) || !isSeverity(row.severity)) throw invalidData()
  if (row.wallet_status !== null && row.wallet_status !== 'active' && row.wallet_status !== 'frozen') throw invalidData()
  if ((row.recovery_command_id === null) !== (row.recovery_applied_at === null)) throw invalidData()
  const forwardFix = resolveForwardFix(row, maxSingleAmount)
  return {
    caseId: row.id,
    runId: row.run_id,
    accountId: row.account_public_id,
    differenceType: row.difference_type,
    severity: row.severity,
    walletBalance: Number(row.wallet_balance),
    expectedBalance: Number(row.expected_balance),
    walletSequence: Number(row.wallet_sequence),
    expectedSequence: Number(row.expected_sequence),
    evidenceSha256: row.evidence_sha256,
    status: row.status,
    version: Number(row.version),
    assignedTo: row.assigned_to === null || !row.assignee_label
      ? null
      : { id: Number(row.assigned_to), label: row.assignee_label },
    claimedAt: row.claimed_at,
    resolutionNote: row.resolution_note,
    forwardFixAdjustmentId: row.forward_fix_adjustment_id,
    walletStatus: row.wallet_status,
    latestRecovery: row.recovery_command_id && row.recovery_applied_at
      ? { commandId: row.recovery_command_id, appliedAt: row.recovery_applied_at }
      : null,
    forwardFix: {
      ...forwardFix,
      eligible: forwardFix.eligible && row.status === 'claimed' && Number(row.assigned_to) === actor.id && actor.role === 'owner',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRecoveryView(row: RecoveryCommandRow): AdminWalletRecoveryView {
  if (row.status !== 'applied' || !row.applied_at) {
    throw new AppWalletError(409, 'WALLET_RECOVERY_IN_PROGRESS', '钱包恢复命令尚未完成，请稍后刷新', true)
  }
  return {
    commandId: row.id,
    caseId: row.anchor_case_id,
    accountId: row.account_public_id,
    status: 'applied',
    previousSnapshot: {
      status: 'frozen',
      balance: Number(row.expected_balance),
      sequence: Number(row.expected_sequence),
    },
    rebuiltSnapshot: {
      status: 'active',
      balance: Number(row.rebuilt_balance),
      sequence: Number(row.rebuilt_sequence),
    },
    coveredCaseCount: Number(row.covered_case_count),
    resolutionNote: row.resolution_note,
    evidenceReference: row.evidence_reference,
    appliedAt: row.applied_at,
  }
}

function resolveForwardFix(row: Pick<CaseRow, 'difference_type' | 'wallet_balance' | 'expected_balance' | 'wallet_sequence' | 'expected_sequence'>, maxSingleAmount: number) {
  const amount = Math.abs(Number(row.expected_balance) - Number(row.wallet_balance))
  if (row.difference_type !== 'balance_mismatch') return { eligible: false, direction: null, amount: 0, reason: 'sequence 或分录链差异必须按钱包 Runbook 人工处理' } as const
  if (Number(row.wallet_sequence) !== Number(row.expected_sequence)) return { eligible: false, direction: null, amount, reason: 'sequence 同时不一致，不能生成普通调币申请' } as const
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxSingleAmount) return { eligible: false, direction: null, amount, reason: '差额超出单笔纠正策略，必须升级人工 Runbook' } as const
  return {
    eligible: true,
    direction: Number(row.expected_balance) > Number(row.wallet_balance) ? 'credit' as const : 'debit' as const,
    amount,
    reason: '可创建追加式纠正申请；仍需另一位管理员独立复核',
  }
}

function normalizeCaseStatusFilter(value: string | undefined): WalletReconciliationCaseStatus | null {
  if (!value || value === 'all') return null
  if (!isCaseStatus(value)) throw new AppWalletError(400, 'WALLET_RECONCILIATION_STATUS_INVALID', '对账案件状态无效')
  return value
}

function normalizeLimit(value: unknown) {
  if (value === undefined || value === null || value === '') return 500
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) throw new AppWalletError(400, 'WALLET_RECONCILIATION_LIMIT_INVALID', 'limit 必须为 1–500')
  return parsed
}

function normalizePositiveInteger(value: unknown, field: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须为正整数`)
  return parsed
}

function normalizeText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是文本`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 长度必须为 ${min}–${max}`)
  return normalized
}

function normalizeSha256(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是有效的 SHA-256`)
  }
  return value
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) throw new AppWalletError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要有效的 Idempotency-Key')
  return normalized
}

function validateCaseId(value: string) {
  if (!CASE_ID.test(value)) throw new AppWalletError(404, 'WALLET_RECONCILIATION_CASE_NOT_FOUND', '钱包对账案件不存在')
}

function requireOwner(actor: Actor) {
  if (actor.role !== 'owner') throw new AppWalletError(403, 'OWNER_REQUIRED', '钱包对账处置仅限 Owner')
}

function isDifferenceType(value: string): value is WalletReconciliationDifferenceType {
  return value === 'balance_mismatch' || value === 'sequence_mismatch' || value === 'entry_chain_break'
}

function isCaseStatus(value: string): value is WalletReconciliationCaseStatus {
  return value === 'open' || value === 'claimed' || value === 'creating_forward_fix'
    || value === 'forward_fix_requested' || value === 'resolved' || value === 'dismissed'
}

function isSeverity(value: string): value is 'p0' | 'p1' | 'p2' {
  return value === 'p0' || value === 'p1' || value === 'p2'
}

function versionConflict() {
  return new AppWalletError(409, 'WALLET_RECONCILIATION_VERSION_CONFLICT', '对账案件状态已变化，请刷新后重试')
}

function idempotencyConflict() {
  return new AppWalletError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已用于其他对账扫描')
}

function recoveryIdempotencyConflict() {
  return new AppWalletError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已用于其他钱包恢复请求')
}

function invalidData() {
  return new AppWalletError(503, 'WALLET_RECONCILIATION_DATA_INVALID', '钱包对账数据异常', true)
}

function randomId(prefix: 'wrc' | 'wrcx' | 'wrd' | 'wre' | 'wrec' | 'wrm' | 'log') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

function isRecoveryConflictError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /wallet recovery|frozen wallet|reconciliation_cases invalid state transition|UNIQUE constraint failed/u.test(error.message)
}

function mutationTokenFor(caseId: string, actorId: number) {
  return `wrm_${caseId.slice(4)}_${actorId}`.slice(0, 95)
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
