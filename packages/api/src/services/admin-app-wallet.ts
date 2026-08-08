import type {
  AppWalletDirection,
  AppWalletEntrySummary,
  AppWalletEntryType,
  AppWalletReasonCode,
  AppWalletSummary,
} from '@meigallery/shared'
import {
  AppWalletError,
  getAppWalletSummary,
  listAppWalletEntries,
  parseAppWalletEntryListQuery,
  requireAppWalletPolicy,
  walletReasonLabel,
  type AppWalletRuntimeConfig,
} from './app-wallet'

const ACCOUNT_PUBLIC_ID = /^acc_[A-Za-z0-9_-]{1,76}$/u
const ENTRY_ID = /^wle_[A-Za-z0-9_-]{1,92}$/u
const ADJUSTMENT_ID = /^wad_[A-Za-z0-9_-]{1,92}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u
const BUSINESS_REFERENCE = /^[A-Za-z0-9._:/-]{3,80}$/u

export type AdminWalletAdjustmentStatus =
  | 'pending_review'
  | 'executing'
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'failed'

export interface AdminWalletAdjustmentInput {
  accountId?: unknown
  actionType?: unknown
  amount?: unknown
  reasonCode?: unknown
  userVisibleNote?: unknown
  internalNote?: unknown
  businessReference?: unknown
  originalEntryId?: unknown
}

export interface AdminWalletReviewInput {
  expectedVersion?: unknown
  reviewNote?: unknown
}

export interface AdminWalletAccountSummary {
  accountId: string
  emailMasked: string
  nickname: string | null
  accountStatus: string
  balance: number
  ledgerVersion: number
  walletStatus: 'active' | 'frozen'
  lastEntryAt: string | null
}

export interface AdminWalletAdjustmentPreview {
  account: AdminWalletAccountSummary
  actionType: AppWalletEntryType
  direction: AppWalletDirection
  amount: number
  reason: { code: AppWalletReasonCode; label: string }
  userVisibleNote: string
  businessReference: string
  originalEntryId: string | null
  balanceBefore: number
  balanceAfter: number
  ledgerVersion: number
  requiresIndependentReview: true
  canSubmit: boolean
  riskCodes: Array<
    | 'POLICY_UNRESOLVED_ALL_REVIEW'
    | 'NEGATIVE_BALANCE'
    | 'WALLET_FROZEN'
    | 'DUPLICATE_BUSINESS_REFERENCE'
    | 'ORIGINAL_ENTRY_NOT_REVERSIBLE'
  >
}

export interface AdminWalletAdjustmentView {
  adjustmentId: string
  account: AdminWalletAccountSummary
  actionType: AppWalletEntryType
  direction: AppWalletDirection
  amount: number
  reason: { code: AppWalletReasonCode; label: string }
  userVisibleNote: string
  internalNote: string
  businessReference: string
  originalEntryId: string | null
  balanceBefore: number
  balanceAfter: number
  previewLedgerVersion: number
  currentBalance: number
  currentLedgerVersion: number
  status: AdminWalletAdjustmentStatus
  version: number
  requestedBy: { id: number; label: string }
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  entryId: string | null
  createdAt: string
  reviewedAt: string | null
  appliedAt: string | null
}

type PolicyRow = Awaited<ReturnType<typeof requireAppWalletPolicy>>

type AccountRow = {
  user_id: number
  account_public_id: string
  email: string
  nickname: string | null
  account_status: string
  balance: number | null
  sequence: number | null
  wallet_status: string | null
  last_entry_at: string | null
}

type PreparedAdjustment = {
  account: AccountRow
  actionType: AppWalletEntryType
  direction: AppWalletDirection
  amount: number
  reasonCode: AppWalletReasonCode
  userVisibleNote: string
  internalNote: string
  businessReference: string
  originalEntryId: string | null
  balanceBefore: number
  ledgerVersion: number
  balanceAfter: number
  riskCodes: AdminWalletAdjustmentPreview['riskCodes']
}

type AdjustmentRow = AccountRow & {
  adjustment_id: string
  action_type: string
  direction: string
  amount: number
  reason_code: string
  user_visible_note: string
  internal_note: string
  business_reference: string
  original_entry_id: string | null
  preview_balance: number
  preview_sequence: number
  projected_balance: number
  status: string
  version: number
  request_hash: string
  requested_by: number
  requester_label: string
  reviewed_by: number | null
  reviewer_label: string | null
  review_note: string | null
  entry_id: string | null
  created_at: string
  reviewed_at: string | null
  applied_at: string | null
}

type ReviewRequestRow = {
  adjustment_id: string
  request_hash: string
  result_status: string
  entry_id: string | null
}

export async function searchAdminAppWalletAccounts(
  db: D1Database,
  query: string | undefined,
  config: AppWalletRuntimeConfig,
): Promise<AdminWalletAccountSummary[]> {
  await requireAppWalletPolicy(db, config)
  const normalized = query?.trim() ?? ''
  if (normalized.length > 254) {
    throw new AppWalletError(400, 'INVALID_QUERY', '账号查询条件过长')
  }
  const like = `%${escapeLike(normalized)}%`
  const rows = await db.prepare(`
    SELECT users.id AS user_id, security.account_public_id, users.email, users.nickname,
           users.status AS account_status, wallet.balance, wallet.sequence,
           wallet.status AS wallet_status, wallet.last_entry_at
    FROM app_account_security security
    JOIN users ON users.id = security.account_id
    LEFT JOIN app_wallets wallet ON wallet.account_id = users.id
    WHERE (? = '' OR security.account_public_id = ? OR users.email LIKE ? ESCAPE '\\' OR users.nickname LIKE ? ESCAPE '\\')
    ORDER BY COALESCE(wallet.updated_at, users.created_at) DESC, users.id DESC
    LIMIT 20
  `).bind(normalized, normalized, like, like).all<AccountRow>()
  return rows.results.map(toAccountSummary)
}

export async function getAdminAppWalletState(
  db: D1Database,
  accountPublicId: string,
  adminId: number,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{
  account: AdminWalletAccountSummary
  wallet: AppWalletSummary
  entries: AppWalletEntrySummary[]
  adjustments: AdminWalletAdjustmentView[]
}> {
  const account = await requireAccount(db, accountPublicId)
  await requireAppWalletPolicy(db, config)
  const [wallet, entryPage, adjustments] = await Promise.all([
    getAppWalletSummary(db, account.user_id, config, now),
    listAppWalletEntries(
      db,
      account.user_id,
      account.account_public_id,
      config,
      parseAppWalletEntryListQuery({ accountScope: account.account_public_id, limit: '20' }),
    ),
    listAdjustmentRows(db, { accountId: account.user_id, limit: 20 }),
  ])
  await writeReadAudit(db, adminId, account.account_public_id, now)
  return {
    account: toAccountSummary(account),
    wallet,
    entries: entryPage.data,
    adjustments: adjustments.map(toAdjustmentView),
  }
}

export async function previewAdminAppWalletAdjustment(
  db: D1Database,
  input: AdminWalletAdjustmentInput,
  config: AppWalletRuntimeConfig,
): Promise<AdminWalletAdjustmentPreview> {
  const policy = await requireAppWalletPolicy(db, config, { writable: true })
  const prepared = await prepareAdjustment(db, input, policy)
  return toPreview(prepared)
}

export async function createAdminAppWalletAdjustment(
  db: D1Database,
  adminId: number,
  idempotencyKey: string | null,
  input: AdminWalletAdjustmentInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ adjustment: AdminWalletAdjustmentView; replayed: boolean }> {
  const key = requireIdempotencyKey(idempotencyKey)
  const policy = await requireAppWalletPolicy(db, config, { writable: true })
  const requestHash = await sha256Hex(JSON.stringify(normalizedAdjustmentRequestInput(input)))
  const replay = await db.prepare(`
    SELECT id, request_hash
    FROM app_wallet_adjustments
    WHERE requested_by = ? AND request_idempotency_key = ?
    LIMIT 1
  `).bind(adminId, key).first<{ id: string; request_hash: string }>()
  if (replay) {
    if (replay.request_hash !== requestHash) throw idempotencyConflict()
    return { adjustment: await requireAdjustment(db, replay.id), replayed: true }
  }
  const prepared = await prepareAdjustment(db, input, policy)
  const blockingRisk = prepared.riskCodes.find(code => code !== 'POLICY_UNRESOLVED_ALL_REVIEW')
  if (blockingRisk) throw blockingRiskError(blockingRisk)
  const duplicateBusinessReference = await db.prepare(`
    SELECT id FROM app_wallet_adjustments WHERE account_id = ? AND business_reference = ? LIMIT 1
  `).bind(prepared.account.user_id, prepared.businessReference).first<{ id: string }>()
  if (duplicateBusinessReference) {
    throw new AppWalletError(409, 'BUSINESS_REFERENCE_CONFLICT', '该账号的业务单号已被使用')
  }

  const timestamp = now.toISOString()
  const adjustmentId = randomId('wad')
  const eventId = randomId('wae')
  const auditId = randomId('log')
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_wallet_adjustments (
          id, policy_id, account_id, action_type, direction, amount, reason_code,
          user_visible_note, internal_note, business_reference, original_entry_id,
          preview_balance, preview_sequence, projected_balance, status, version,
          request_idempotency_key, request_hash, requested_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 1, ?, ?, ?, ?, ?)
      `).bind(
        adjustmentId,
        policy.id,
        prepared.account.user_id,
        prepared.actionType,
        prepared.direction,
        prepared.amount,
        prepared.reasonCode,
        prepared.userVisibleNote,
        prepared.internalNote,
        prepared.businessReference,
        prepared.originalEntryId,
        prepared.balanceBefore,
        prepared.ledgerVersion,
        prepared.balanceAfter,
        key,
        requestHash,
        adminId,
        timestamp,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_wallet_adjustment_events (
          id, adjustment_id, sequence, event_type, actor_id, result_code, created_at
        ) VALUES (?, ?, 1, 'submitted', ?, 'pending_review', ?)
      `).bind(eventId, adjustmentId, adminId, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app.wallet.adjustment.request', 'app_wallet_adjustment', ?, NULL, ?, ?)
      `).bind(auditId, adminId, adjustmentId, JSON.stringify({
        accountId: prepared.account.account_public_id,
        actionType: prepared.actionType,
        direction: prepared.direction,
        amount: prepared.amount,
        reasonCode: prepared.reasonCode,
        balanceBefore: prepared.balanceBefore,
        balanceAfter: prepared.balanceAfter,
        status: 'pending_review',
      }), timestamp),
    ])
  }
  catch (error) {
    const raced = await db.prepare(`
      SELECT id, request_hash
      FROM app_wallet_adjustments
      WHERE requested_by = ? AND request_idempotency_key = ?
      LIMIT 1
    `).bind(adminId, key).first<{ id: string; request_hash: string }>()
    if (raced?.request_hash === requestHash) {
      return { adjustment: await requireAdjustment(db, raced.id), replayed: true }
    }
    if (raced) throw idempotencyConflict()
    throw error
  }
  return { adjustment: await requireAdjustment(db, adjustmentId), replayed: false }
}

export async function listAdminAppWalletAdjustments(
  db: D1Database,
  status: string | undefined,
  config: AppWalletRuntimeConfig,
): Promise<AdminWalletAdjustmentView[]> {
  await requireAppWalletPolicy(db, config)
  const normalizedStatus = normalizeAdjustmentStatus(status)
  return (await listAdjustmentRows(db, { status: normalizedStatus, limit: 100 })).map(toAdjustmentView)
}

export async function getAdminAppWalletAdjustment(
  db: D1Database,
  adjustmentId: string,
  config: AppWalletRuntimeConfig,
): Promise<AdminWalletAdjustmentView> {
  await requireAppWalletPolicy(db, config)
  validateAdjustmentId(adjustmentId)
  return requireAdjustment(db, adjustmentId)
}

export async function reviewAdminAppWalletAdjustment(
  db: D1Database,
  adjustmentId: string,
  reviewerId: number,
  decision: 'approve' | 'reject',
  idempotencyKey: string | null,
  input: AdminWalletReviewInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ adjustment: AdminWalletAdjustmentView; replayed: boolean }> {
  validateAdjustmentId(adjustmentId)
  const key = requireIdempotencyKey(idempotencyKey)
  const expectedVersion = requirePositiveInteger(input.expectedVersion, 'expectedVersion')
  const reviewNote = requireText(input.reviewNote, 'reviewNote', 2, 300)
  const policy = await requireAppWalletPolicy(db, config, { writable: true })
  const requestHash = await sha256Hex(JSON.stringify({ adjustmentId, decision, expectedVersion, reviewNote }))
  const replay = await findReviewRequest(db, reviewerId, key)
  if (replay) {
    if (replay.adjustment_id !== adjustmentId || replay.request_hash !== requestHash) {
      throw idempotencyConflict()
    }
    return { adjustment: await requireAdjustment(db, adjustmentId), replayed: true }
  }
  const current = await requireAdjustment(db, adjustmentId)
  if (current.requestedBy.id === reviewerId) {
    throw new AppWalletError(403, 'SELF_REVIEW_FORBIDDEN', '调币发起人不能复核自己的申请')
  }
  if (current.status !== 'pending_review') {
    throw new AppWalletError(409, 'ADJUSTMENT_ALREADY_REVIEWED', '调币申请已被处理，请刷新后查看')
  }
  if (current.version !== expectedVersion) {
    throw new AppWalletError(409, 'VERSION_CONFLICT', '调币申请版本已变化，请刷新后复核')
  }
  if (decision === 'reject') {
    return rejectAdjustment(db, current, reviewerId, key, requestHash, reviewNote, now)
  }
  return approveAdjustment(db, current, reviewerId, key, requestHash, reviewNote, policy, now)
}

async function approveAdjustment(
  db: D1Database,
  current: AdminWalletAdjustmentView,
  reviewerId: number,
  key: string,
  requestHash: string,
  reviewNote: string,
  policy: PolicyRow,
  now: Date,
): Promise<{ adjustment: AdminWalletAdjustmentView; replayed: boolean }> {
  if (current.amount > policy.max_single_amount) {
    throw new AppWalletError(422, 'AMOUNT_LIMIT_EXCEEDED', '调币数量超过当前策略上限')
  }
  const timestamp = now.toISOString()
  const mutationToken = randomId('wmt')
  const walletId = randomId('wlt')
  const entryId = randomId('wle')
  const publicReference = `WAL-${crypto.randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`
  const reviewRequestId = randomId('wrr')
  const eventAppliedId = randomId('wae')
  const eventConflictId = randomId('wae')
  const auditAppliedId = randomId('log')
  const auditConflictId = randomId('log')
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_adjustments
      SET status = 'executing', mutation_token = ?, reviewed_by = ?, review_note = ?,
          reviewed_at = ?, updated_at = ?
      WHERE id = ?
        AND status = 'pending_review'
        AND version = ?
        AND requested_by <> ?
        AND preview_balance = COALESCE((SELECT balance FROM app_wallets WHERE account_id = app_wallet_adjustments.account_id), 0)
        AND preview_sequence = COALESCE((SELECT sequence FROM app_wallets WHERE account_id = app_wallet_adjustments.account_id), 0)
        AND COALESCE((SELECT status FROM app_wallets WHERE account_id = app_wallet_adjustments.account_id), 'active') = 'active'
        AND EXISTS (SELECT 1 FROM users WHERE id = app_wallet_adjustments.account_id AND status = 'active')
        AND (
          original_entry_id IS NULL
          OR (
            EXISTS (
              SELECT 1 FROM app_wallet_entries original
              WHERE original.id = app_wallet_adjustments.original_entry_id
                AND original.account_id = app_wallet_adjustments.account_id
                AND original.action_type <> 'reversal'
            )
            AND NOT EXISTS (
              SELECT 1 FROM app_wallet_entries reversal
              WHERE reversal.original_entry_id = app_wallet_adjustments.original_entry_id
            )
          )
        )
    `).bind(
      mutationToken,
      reviewerId,
      reviewNote,
      timestamp,
      timestamp,
      current.adjustmentId,
      current.version,
      reviewerId,
    ),
    db.prepare(`
      INSERT OR IGNORE INTO app_wallets (
        id, account_id, currency_code, balance, sequence, status, created_at, updated_at
      )
      SELECT ?, account_id, 'mei_coin', 0, 0, 'active', ?, ?
      FROM app_wallet_adjustments
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(walletId, timestamp, timestamp, current.adjustmentId, mutationToken),
    db.prepare(`
      INSERT OR IGNORE INTO app_wallet_entries (
        id, wallet_id, account_id, sequence, action_type, direction, amount, reason_code,
        user_visible_note, public_reference, business_reference, adjustment_id,
        original_entry_id, requested_by, reviewed_by, balance_before, balance_after,
        status, posted_at, created_at
      )
      SELECT
        ?, wallet.id, adjustment.account_id, wallet.sequence + 1,
        adjustment.action_type, adjustment.direction, adjustment.amount, adjustment.reason_code,
        adjustment.user_visible_note, ?, adjustment.business_reference, adjustment.id,
        adjustment.original_entry_id, adjustment.requested_by, adjustment.reviewed_by,
        wallet.balance,
        CASE adjustment.direction
          WHEN 'credit' THEN wallet.balance + adjustment.amount
          ELSE wallet.balance - adjustment.amount
        END,
        'posted', ?, ?
      FROM app_wallet_adjustments adjustment
      JOIN app_wallets wallet ON wallet.account_id = adjustment.account_id
      WHERE adjustment.id = ?
        AND adjustment.status = 'executing'
        AND adjustment.mutation_token = ?
        AND wallet.status = 'active'
        AND wallet.balance = adjustment.preview_balance
        AND wallet.sequence = adjustment.preview_sequence
        AND (adjustment.direction = 'credit' OR wallet.balance >= adjustment.amount)
        AND (
          adjustment.original_entry_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM app_wallet_entries reversal
            WHERE reversal.original_entry_id = adjustment.original_entry_id
          )
        )
    `).bind(
      entryId,
      publicReference,
      timestamp,
      timestamp,
      current.adjustmentId,
      mutationToken,
    ),
    db.prepare(`
      UPDATE app_wallets
      SET balance = (SELECT balance_after FROM app_wallet_entries WHERE id = ?),
          sequence = (SELECT sequence FROM app_wallet_entries WHERE id = ?),
          last_entry_at = ?, updated_at = ?
      WHERE id = (SELECT wallet_id FROM app_wallet_entries WHERE id = ?)
        AND balance = (SELECT balance_before FROM app_wallet_entries WHERE id = ?)
        AND sequence + 1 = (SELECT sequence FROM app_wallet_entries WHERE id = ?)
    `).bind(entryId, entryId, timestamp, timestamp, entryId, entryId, entryId),
    db.prepare(`
      UPDATE app_wallet_adjustments
      SET status = 'applied', entry_id = ?, version = version + 1,
          applied_at = ?, updated_at = ?
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
        AND EXISTS (
          SELECT 1
          FROM app_wallet_entries entry
          JOIN app_wallets wallet ON wallet.id = entry.wallet_id
          WHERE entry.id = ?
            AND wallet.balance = entry.balance_after
            AND wallet.sequence = entry.sequence
        )
    `).bind(entryId, timestamp, timestamp, current.adjustmentId, mutationToken, entryId),
    db.prepare(`
      INSERT INTO app_wallet_adjustment_events (
        id, adjustment_id, sequence, event_type, actor_id, result_code, entry_id, created_at
      )
      SELECT ?, adjustment.id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_adjustment_events WHERE adjustment_id = adjustment.id), 0) + 1,
             'approved_applied', ?, 'applied', ?, ?
      FROM app_wallet_adjustments adjustment
      WHERE adjustment.id = ? AND adjustment.status = 'applied' AND adjustment.mutation_token = ?
    `).bind(eventAppliedId, reviewerId, entryId, timestamp, current.adjustmentId, mutationToken),
    db.prepare(`
      INSERT INTO app_wallet_review_requests (
        id, adjustment_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, entry_id, created_at
      )
      SELECT ?, id, ?, 'approve', ?, ?, 'applied', entry_id, ?
      FROM app_wallet_adjustments
      WHERE id = ? AND status = 'applied' AND mutation_token = ?
    `).bind(
      reviewRequestId,
      reviewerId,
      key,
      requestHash,
      timestamp,
      current.adjustmentId,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.adjustment.approve', 'app_wallet_adjustment', id, ?, ?, ?
      FROM app_wallet_adjustments
      WHERE id = ? AND status = 'applied' AND mutation_token = ?
    `).bind(
      auditAppliedId,
      reviewerId,
      JSON.stringify({ status: 'pending_review', version: current.version }),
      JSON.stringify({
        status: 'applied',
        entryId,
        direction: current.direction,
        amount: current.amount,
        balanceBefore: current.balanceBefore,
        balanceAfter: current.balanceAfter,
      }),
      timestamp,
      current.adjustmentId,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO app_wallet_adjustment_events (
        id, adjustment_id, sequence, event_type, actor_id, result_code, created_at
      )
      SELECT ?, adjustment.id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_adjustment_events WHERE adjustment_id = adjustment.id), 0) + 1,
             'execution_conflict', ?, 'wallet_changed', ?
      FROM app_wallet_adjustments adjustment
      WHERE adjustment.id = ? AND adjustment.status = 'executing' AND adjustment.mutation_token = ?
    `).bind(eventConflictId, reviewerId, timestamp, current.adjustmentId, mutationToken),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.adjustment.execution_conflict', 'app_wallet_adjustment', id, ?, ?, ?
      FROM app_wallet_adjustments
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(
      auditConflictId,
      reviewerId,
      JSON.stringify({ status: 'pending_review', version: current.version }),
      JSON.stringify({ status: 'pending_review', resultCode: 'wallet_changed' }),
      timestamp,
      current.adjustmentId,
      mutationToken,
    ),
    db.prepare(`
      UPDATE app_wallet_adjustments
      SET status = 'pending_review', mutation_token = NULL, reviewed_by = NULL,
          review_note = NULL, reviewed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(timestamp, current.adjustmentId, mutationToken),
  ])

  const review = await findReviewRequest(db, reviewerId, key)
  if (review?.adjustment_id === current.adjustmentId && review.request_hash === requestHash) {
    return { adjustment: await requireAdjustment(db, current.adjustmentId), replayed: false }
  }
  throw new AppWalletError(
    409,
    'WALLET_BALANCE_CHANGED',
    '钱包余额或冲正关系已变化，请拒绝旧申请并重新创建',
  )
}

async function rejectAdjustment(
  db: D1Database,
  current: AdminWalletAdjustmentView,
  reviewerId: number,
  key: string,
  requestHash: string,
  reviewNote: string,
  now: Date,
): Promise<{ adjustment: AdminWalletAdjustmentView; replayed: boolean }> {
  const timestamp = now.toISOString()
  const mutationToken = randomId('wmt')
  const reviewRequestId = randomId('wrr')
  const eventId = randomId('wae')
  const auditId = randomId('log')
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_adjustments
      SET status = 'rejected', version = version + 1, mutation_token = ?,
          reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_review' AND version = ? AND requested_by <> ?
    `).bind(
      mutationToken,
      reviewerId,
      reviewNote,
      timestamp,
      timestamp,
      current.adjustmentId,
      current.version,
      reviewerId,
    ),
    db.prepare(`
      INSERT INTO app_wallet_adjustment_events (
        id, adjustment_id, sequence, event_type, actor_id, result_code, created_at
      )
      SELECT ?, adjustment.id,
             COALESCE((SELECT MAX(sequence) FROM app_wallet_adjustment_events WHERE adjustment_id = adjustment.id), 0) + 1,
             'rejected', ?, 'rejected', ?
      FROM app_wallet_adjustments adjustment
      WHERE adjustment.id = ? AND adjustment.status = 'rejected' AND adjustment.mutation_token = ?
    `).bind(eventId, reviewerId, timestamp, current.adjustmentId, mutationToken),
    db.prepare(`
      INSERT INTO app_wallet_review_requests (
        id, adjustment_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, entry_id, created_at
      )
      SELECT ?, id, ?, 'reject', ?, ?, 'rejected', NULL, ?
      FROM app_wallet_adjustments
      WHERE id = ? AND status = 'rejected' AND mutation_token = ?
    `).bind(
      reviewRequestId,
      reviewerId,
      key,
      requestHash,
      timestamp,
      current.adjustmentId,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.adjustment.reject', 'app_wallet_adjustment', id, ?, ?, ?
      FROM app_wallet_adjustments
      WHERE id = ? AND status = 'rejected' AND mutation_token = ?
    `).bind(
      auditId,
      reviewerId,
      JSON.stringify({ status: 'pending_review', version: current.version }),
      JSON.stringify({ status: 'rejected' }),
      timestamp,
      current.adjustmentId,
      mutationToken,
    ),
  ])
  const review = await findReviewRequest(db, reviewerId, key)
  if (!review || review.adjustment_id !== current.adjustmentId || review.request_hash !== requestHash) {
    throw new AppWalletError(409, 'VERSION_CONFLICT', '调币申请已被其他复核人处理')
  }
  return { adjustment: await requireAdjustment(db, current.adjustmentId), replayed: false }
}

async function prepareAdjustment(
  db: D1Database,
  input: AdminWalletAdjustmentInput,
  policy: PolicyRow,
): Promise<PreparedAdjustment> {
  const accountPublicId = requireAccountPublicId(input.accountId)
  const account = await requireAccount(db, accountPublicId)
  const actionType = requireActionType(input.actionType)
  let amount = actionType === 'reversal'
    ? 1
    : requirePositiveInteger(input.amount, 'amount')
  let direction: AppWalletDirection
  let reasonCode: AppWalletReasonCode = actionType === 'reversal'
    ? 'reversal'
    : requireReasonCode(input.reasonCode)
  let originalEntryId: string | null = null
  let originalReversible = true
  if (actionType === 'reversal') {
    originalEntryId = requireEntryId(input.originalEntryId)
    const original = await db.prepare(`
      SELECT entry.id, entry.direction, entry.amount, entry.action_type,
             reversal.id AS reversal_entry_id
      FROM app_wallet_entries entry
      LEFT JOIN app_wallet_entries reversal ON reversal.original_entry_id = entry.id
      WHERE entry.id = ? AND entry.account_id = ? AND entry.status = 'posted'
      LIMIT 1
    `).bind(originalEntryId, account.user_id).first<{
      id: string
      direction: string
      amount: number
      action_type: string
      reversal_entry_id: string | null
    }>()
    originalReversible = Boolean(original && original.action_type !== 'reversal' && !original.reversal_entry_id)
    if (original) {
      direction = original.direction === 'credit' ? 'debit' : 'credit'
      amount = original.amount
    } else {
      direction = 'debit'
    }
    reasonCode = 'reversal'
  } else {
    direction = actionType === 'admin_debit' ? 'debit' : 'credit'
    if (actionType === 'compensation' && reasonCode !== 'service_compensation') {
      throw new AppWalletError(400, 'INVALID_REASON_CODE', '服务补偿必须使用对应标准原因')
    }
    if (reasonCode === 'reversal') {
      throw new AppWalletError(400, 'INVALID_REASON_CODE', '只有冲正操作可以使用冲正原因')
    }
  }
  if (amount > policy.max_single_amount) {
    throw new AppWalletError(422, 'AMOUNT_LIMIT_EXCEEDED', '调币数量超过当前策略上限')
  }
  const userVisibleNote = requireText(input.userVisibleNote, 'userVisibleNote', 2, 160)
  const internalNote = requireText(input.internalNote, 'internalNote', 2, 500)
  const businessReference = requireBusinessReference(input.businessReference)
  const balanceBefore = safeNonNegative(account.balance ?? 0, 'balance')
  const ledgerVersion = safeNonNegative(account.sequence ?? 0, 'sequence')
  const balanceAfter = direction === 'credit' ? balanceBefore + amount : balanceBefore - amount
  const duplicate = await db.prepare(`
    SELECT 1 AS found FROM app_wallet_adjustments
    WHERE account_id = ? AND business_reference = ?
    LIMIT 1
  `).bind(account.user_id, businessReference).first<{ found: number }>()
  const riskCodes: PreparedAdjustment['riskCodes'] = ['POLICY_UNRESOLVED_ALL_REVIEW']
  if (balanceAfter < 0) riskCodes.push('NEGATIVE_BALANCE')
  if (account.wallet_status === 'frozen') riskCodes.push('WALLET_FROZEN')
  if (duplicate) riskCodes.push('DUPLICATE_BUSINESS_REFERENCE')
  if (!originalReversible) riskCodes.push('ORIGINAL_ENTRY_NOT_REVERSIBLE')
  return {
    account,
    actionType,
    direction,
    amount,
    reasonCode,
    userVisibleNote,
    internalNote,
    businessReference,
    originalEntryId,
    balanceBefore,
    ledgerVersion,
    balanceAfter,
    riskCodes,
  }
}

function toPreview(prepared: PreparedAdjustment): AdminWalletAdjustmentPreview {
  return {
    account: toAccountSummary(prepared.account),
    actionType: prepared.actionType,
    direction: prepared.direction,
    amount: prepared.amount,
    reason: { code: prepared.reasonCode, label: walletReasonLabel(prepared.reasonCode) },
    userVisibleNote: prepared.userVisibleNote,
    businessReference: prepared.businessReference,
    originalEntryId: prepared.originalEntryId,
    balanceBefore: prepared.balanceBefore,
    balanceAfter: prepared.balanceAfter,
    ledgerVersion: prepared.ledgerVersion,
    requiresIndependentReview: true,
    canSubmit: prepared.riskCodes.length === 1,
    riskCodes: prepared.riskCodes,
  }
}

function normalizedAdjustmentRequestInput(input: AdminWalletAdjustmentInput) {
  const actionType = requireActionType(input.actionType)
  return {
    accountId: requireAccountPublicId(input.accountId),
    actionType,
    amount: actionType === 'reversal' ? null : requirePositiveInteger(input.amount, 'amount'),
    reasonCode: actionType === 'reversal' ? 'reversal' : requireReasonCode(input.reasonCode),
    userVisibleNote: requireText(input.userVisibleNote, 'userVisibleNote', 2, 160),
    internalNote: requireText(input.internalNote, 'internalNote', 2, 500),
    businessReference: requireBusinessReference(input.businessReference),
    originalEntryId: actionType === 'reversal' ? requireEntryId(input.originalEntryId) : null,
  }
}

async function requireAccount(db: D1Database, accountPublicId: string): Promise<AccountRow> {
  if (!ACCOUNT_PUBLIC_ID.test(accountPublicId)) {
    throw new AppWalletError(404, 'ACCOUNT_NOT_FOUND', 'App 账号不存在')
  }
  const row = await db.prepare(`
    SELECT users.id AS user_id, security.account_public_id, users.email, users.nickname,
           users.status AS account_status, wallet.balance, wallet.sequence,
           wallet.status AS wallet_status, wallet.last_entry_at
    FROM app_account_security security
    JOIN users ON users.id = security.account_id
    LEFT JOIN app_wallets wallet ON wallet.account_id = users.id
    WHERE security.account_public_id = ?
    LIMIT 1
  `).bind(accountPublicId).first<AccountRow>()
  if (!row) throw new AppWalletError(404, 'ACCOUNT_NOT_FOUND', 'App 账号不存在')
  return row
}

async function requireAdjustment(db: D1Database, adjustmentId: string): Promise<AdminWalletAdjustmentView> {
  const row = await findAdjustment(db, adjustmentId)
  if (!row) throw new AppWalletError(404, 'WALLET_ADJUSTMENT_NOT_FOUND', '调币申请不存在')
  return toAdjustmentView(row)
}

async function findAdjustment(db: D1Database, adjustmentId: string): Promise<AdjustmentRow | null> {
  return db.prepare(`${adjustmentSelect()} WHERE adjustment.id = ? LIMIT 1`)
    .bind(adjustmentId)
    .first<AdjustmentRow>()
}

async function listAdjustmentRows(
  db: D1Database,
  options: { status?: AdminWalletAdjustmentStatus | null; accountId?: number; limit: number },
): Promise<AdjustmentRow[]> {
  const conditions: string[] = []
  const bindings: unknown[] = []
  if (options.status) {
    conditions.push('adjustment.status = ?')
    bindings.push(options.status)
  }
  if (options.accountId) {
    conditions.push('adjustment.account_id = ?')
    bindings.push(options.accountId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const result = await db.prepare(`
    ${adjustmentSelect()}
    ${where}
    ORDER BY CASE adjustment.status WHEN 'pending_review' THEN 0 ELSE 1 END,
             adjustment.created_at DESC, adjustment.id DESC
    LIMIT ?
  `).bind(...bindings, options.limit).all<AdjustmentRow>()
  return result.results
}

function adjustmentSelect() {
  return `
    SELECT adjustment.id AS adjustment_id, adjustment.action_type, adjustment.direction,
           adjustment.amount, adjustment.reason_code, adjustment.user_visible_note,
           adjustment.internal_note, adjustment.business_reference, adjustment.original_entry_id,
           adjustment.preview_balance, adjustment.preview_sequence, adjustment.projected_balance,
           adjustment.status, adjustment.version, adjustment.request_hash,
           adjustment.requested_by, COALESCE(requester.nickname, requester.email) AS requester_label,
           adjustment.reviewed_by, COALESCE(reviewer.nickname, reviewer.email) AS reviewer_label,
           adjustment.review_note, adjustment.entry_id, adjustment.created_at,
           adjustment.reviewed_at, adjustment.applied_at,
           account.id AS user_id, security.account_public_id, account.email, account.nickname,
           account.status AS account_status, wallet.balance, wallet.sequence,
           wallet.status AS wallet_status, wallet.last_entry_at
    FROM app_wallet_adjustments adjustment
    JOIN users account ON account.id = adjustment.account_id
    JOIN app_account_security security ON security.account_id = account.id
    JOIN users requester ON requester.id = adjustment.requested_by
    LEFT JOIN users reviewer ON reviewer.id = adjustment.reviewed_by
    LEFT JOIN app_wallets wallet ON wallet.account_id = account.id
  `
}

function toAdjustmentView(row: AdjustmentRow): AdminWalletAdjustmentView {
  const actionType = requireStoredActionType(row.action_type)
  const direction = requireStoredDirection(row.direction)
  const reasonCode = requireStoredReasonCode(row.reason_code)
  return {
    adjustmentId: row.adjustment_id,
    account: toAccountSummary(row),
    actionType,
    direction,
    amount: safePositive(row.amount, 'amount'),
    reason: { code: reasonCode, label: walletReasonLabel(reasonCode) },
    userVisibleNote: row.user_visible_note,
    internalNote: row.internal_note,
    businessReference: row.business_reference,
    originalEntryId: row.original_entry_id,
    balanceBefore: safeNonNegative(row.preview_balance, 'preview_balance'),
    balanceAfter: safeNonNegative(row.projected_balance, 'projected_balance'),
    previewLedgerVersion: safeNonNegative(row.preview_sequence, 'preview_sequence'),
    currentBalance: safeNonNegative(row.balance ?? 0, 'balance'),
    currentLedgerVersion: safeNonNegative(row.sequence ?? 0, 'sequence'),
    status: requireStoredStatus(row.status),
    version: safePositive(row.version, 'version'),
    requestedBy: { id: row.requested_by, label: row.requester_label },
    reviewedBy: row.reviewed_by && row.reviewer_label
      ? { id: row.reviewed_by, label: row.reviewer_label }
      : null,
    reviewNote: row.review_note,
    entryId: row.entry_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    appliedAt: row.applied_at,
  }
}

function toAccountSummary(row: AccountRow): AdminWalletAccountSummary {
  return {
    accountId: row.account_public_id,
    emailMasked: maskEmail(row.email),
    nickname: row.nickname,
    accountStatus: row.account_status,
    balance: safeNonNegative(row.balance ?? 0, 'balance'),
    ledgerVersion: safeNonNegative(row.sequence ?? 0, 'sequence'),
    walletStatus: row.wallet_status === 'frozen' ? 'frozen' : 'active',
    lastEntryAt: row.last_entry_at,
  }
}

async function findReviewRequest(db: D1Database, reviewerId: number, key: string) {
  return db.prepare(`
    SELECT adjustment_id, request_hash, result_status, entry_id
    FROM app_wallet_review_requests
    WHERE reviewer_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(reviewerId, key).first<ReviewRequestRow>()
}

async function writeReadAudit(db: D1Database, adminId: number, accountPublicId: string, now: Date) {
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app.wallet.view', 'app_wallet', ?, NULL, ?, ?)
  `).bind(
    randomId('log'),
    adminId,
    accountPublicId,
    JSON.stringify({ purpose: 'service_operation', fields: ['balance', 'entries', 'adjustments'] }),
    now.toISOString(),
  ).run()
}

function normalizeAdjustmentStatus(value: string | undefined): AdminWalletAdjustmentStatus | null {
  if (!value || value === 'all') return null
  const allowed: AdminWalletAdjustmentStatus[] = [
    'pending_review', 'executing', 'applied', 'rejected', 'cancelled', 'failed',
  ]
  if (!allowed.some(item => item === value)) {
    throw new AppWalletError(400, 'INVALID_ADJUSTMENT_STATUS', '调币申请状态无效')
  }
  return value as AdminWalletAdjustmentStatus
}

function requireAccountPublicId(value: unknown) {
  if (typeof value !== 'string' || !ACCOUNT_PUBLIC_ID.test(value.trim())) {
    throw new AppWalletError(400, 'INVALID_ACCOUNT_ID', 'accountId 必须是稳定 App 账号 ID')
  }
  return value.trim()
}

function requireActionType(value: unknown): AppWalletEntryType {
  if (
    value === 'admin_credit'
    || value === 'admin_debit'
    || value === 'compensation'
    || value === 'reversal'
  ) return value
  throw new AppWalletError(400, 'INVALID_ADJUSTMENT_TYPE', '调币类型无效')
}

function requireStoredActionType(value: string): AppWalletEntryType {
  return requireActionType(value)
}

function requireReasonCode(value: unknown): AppWalletReasonCode {
  if (
    value === 'manual_adjustment'
    || value === 'service_compensation'
    || value === 'correction'
    || value === 'reversal'
  ) return value
  throw new AppWalletError(400, 'INVALID_REASON_CODE', '调币标准原因无效')
}

function requireStoredReasonCode(value: string): AppWalletReasonCode {
  return requireReasonCode(value)
}

function requireStoredDirection(value: string): AppWalletDirection {
  if (value === 'credit' || value === 'debit') return value
  throw new AppWalletError(503, 'WALLET_DATA_INVALID', '调币数据暂不可用')
}

function requireStoredStatus(value: string): AdminWalletAdjustmentStatus {
  const status = normalizeAdjustmentStatus(value)
  if (!status) throw new AppWalletError(503, 'WALLET_DATA_INVALID', '调币状态暂不可用')
  return status
}

function requirePositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是正整数`)
  }
  return Number(value)
}

function requireText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') {
    throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是文本`)
  }
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) {
    throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 长度必须为 ${min}–${max} 个字符`)
  }
  return normalized
}

function requireBusinessReference(value: unknown) {
  if (typeof value !== 'string' || !BUSINESS_REFERENCE.test(value.trim())) {
    throw new AppWalletError(400, 'INVALID_BUSINESS_REFERENCE', '业务单号格式无效')
  }
  return value.trim()
}

function requireEntryId(value: unknown) {
  if (typeof value !== 'string' || !ENTRY_ID.test(value.trim())) {
    throw new AppWalletError(400, 'INVALID_ORIGINAL_ENTRY', '原分录 ID 格式无效')
  }
  return value.trim()
}

function requireIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AppWalletError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要有效的 Idempotency-Key')
  }
  return normalized
}

function validateAdjustmentId(value: string) {
  if (!ADJUSTMENT_ID.test(value)) {
    throw new AppWalletError(404, 'WALLET_ADJUSTMENT_NOT_FOUND', '调币申请不存在')
  }
}

function safeNonNegative(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000) {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', `${field} 数据暂不可用`)
  }
  return value
}

function safePositive(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', `${field} 数据暂不可用`)
  }
  return value
}

function blockingRiskError(code: AdminWalletAdjustmentPreview['riskCodes'][number]) {
  if (code === 'NEGATIVE_BALANCE') {
    return new AppWalletError(422, 'NEGATIVE_BALANCE_FORBIDDEN', '扣币后余额不能小于 0')
  }
  if (code === 'WALLET_FROZEN') {
    return new AppWalletError(409, 'WALLET_FROZEN', '该钱包已冻结，不能创建调币申请')
  }
  if (code === 'DUPLICATE_BUSINESS_REFERENCE') {
    return new AppWalletError(409, 'BUSINESS_REFERENCE_CONFLICT', '该账号的业务单号已被使用')
  }
  if (code === 'ORIGINAL_ENTRY_NOT_REVERSIBLE') {
    return new AppWalletError(409, 'ORIGINAL_ENTRY_NOT_REVERSIBLE', '原分录不存在、已冲正或不能再次冲正')
  }
  return new AppWalletError(409, 'WALLET_POLICY_REVIEW_REQUIRED', '当前策略要求独立复核')
}

function idempotencyConflict() {
  return new AppWalletError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已用于不同请求')
}

function maskEmail(email: string) {
  const [local = '', domain = ''] = email.split('@')
  if (!domain) return '***'
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`
}

function escapeLike(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function randomId(prefix: 'wad' | 'wae' | 'wrr' | 'wmt' | 'wlt' | 'wle' | 'log') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
