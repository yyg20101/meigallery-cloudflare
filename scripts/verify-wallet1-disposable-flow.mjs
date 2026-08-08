import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

export const WALLET1_CONTRACT_VERSION = '1.10.0'
export const WALLET1_POLICY_ID = 'wlp_app_1_0_wallet_1_dev_1'
export const WALLET1_NOTIFICATION_POLICY_ID = 'ntp_app_1_0_message_3_dev_1'
export const WALLET1_DOCUMENT_VERSION = 'wallet1-disposable-smoke-1'

/**
 * 生成只存在于一次性 D1 中的合成账号和会话。
 * 原始访问凭证只返回到内存；SQL 只包含 SHA-256，不包含明文凭证。
 */
export function createWallet1SyntheticFixture(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const suffix = String(options.suffix || randomBytes(6).toString('hex')).toLowerCase()
  if (!/^[a-f0-9]{8,24}$/u.test(suffix)) throw new Error('WALLET1_SMOKE_FIXTURE_SUFFIX_INVALID')

  const tokenFactory = options.tokenFactory || ((prefix) => `${prefix}_${randomBytes(32).toString('hex')}`)
  const viewerAccessToken = tokenFactory('mga')
  const viewerRefreshToken = tokenFactory('mgr')
  const requesterSessionToken = tokenFactory('admin_requester')
  const reviewerSessionToken = tokenFactory('admin_reviewer')
  for (const token of [viewerAccessToken, viewerRefreshToken, requesterSessionToken, reviewerSessionToken]) {
    if (typeof token !== 'string' || token.length < 40 || /\s/u.test(token)) {
      throw new Error('WALLET1_SMOKE_FIXTURE_TOKEN_INVALID')
    }
  }

  const numericSuffix = Number.parseInt(suffix.slice(0, 8), 16)
  const viewerId = -(2_000_000_000 + numericSuffix)
  const requesterId = viewerId - 1
  const reviewerId = viewerId - 2
  const nowIso = now.toISOString()
  const accessExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  const refreshExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const adminExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  const accountPublicId = `acc_wallet1_smoke_${suffix}`
  const deviceId = `dev_wallet1_smoke_${suffix}`
  const appSessionId = `aps_wallet1_smoke_${suffix}`

  const sql = `
INSERT INTO users (
  id, email, username, nickname, password_hash, role, status,
  email_verified, notification_enabled, created_at, updated_at
) VALUES
  (${viewerId}, ${q(`wallet1-viewer-${suffix}@example.invalid`)}, ${q(`w1viewer${suffix}`)}, 'Wallet-1 合成观看者', 'synthetic_not_for_login', 'user', 'active', 1, 0, ${q(nowIso)}, ${q(nowIso)}),
  (${requesterId}, ${q(`wallet1-requester-${suffix}@example.invalid`)}, ${q(`w1requester${suffix}`)}, 'Wallet-1 调币发起人', 'synthetic_not_for_login', 'admin', 'active', 1, 0, ${q(nowIso)}, ${q(nowIso)}),
  (${reviewerId}, ${q(`wallet1-reviewer-${suffix}@example.invalid`)}, ${q(`w1reviewer${suffix}`)}, 'Wallet-1 独立复核人', 'synthetic_not_for_login', 'admin', 'active', 1, 0, ${q(nowIso)}, ${q(nowIso)});

INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES
  (${q(`ses_w1_req_${suffix}`)}, ${requesterId}, ${q(sha256(requesterSessionToken))}, ${q(adminExpiresAt)}, ${q(nowIso)}),
  (${q(`ses_w1_rev_${suffix}`)}, ${reviewerId}, ${q(sha256(reviewerSessionToken))}, ${q(adminExpiresAt)}, ${q(nowIso)});

INSERT INTO app_account_security (
  account_id, account_public_id, status, session_version, created_at, updated_at
) VALUES (${viewerId}, ${q(accountPublicId)}, 'active', 1, ${q(nowIso)}, ${q(nowIso)});

INSERT INTO app_devices (
  id, account_id, installation_hash, platform, display_name, app_version,
  status, session_version, first_seen_at, last_seen_at, created_at, updated_at
) VALUES (
  ${q(deviceId)}, ${viewerId}, ${q(sha256(`installation-${suffix}`))}, 'android',
  'Wallet-1 Disposable Smoke', '1.0', 'active', 1,
  ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)}
);

INSERT INTO app_sessions (
  id, account_id, device_id, access_token_hash, refresh_token_hash,
  account_session_version, device_session_version, status,
  access_expires_at, refresh_expires_at, last_seen_at, created_at, updated_at
) VALUES (
  ${q(appSessionId)}, ${viewerId}, ${q(deviceId)}, ${q(sha256(viewerAccessToken))},
  ${q(sha256(viewerRefreshToken))}, 1, 1, 'active', ${q(accessExpiresAt)},
  ${q(refreshExpiresAt)}, ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)}
);

INSERT INTO app_account_consents (
  id, account_id, document_type, document_version, decision,
  source, request_id, accepted_at, created_at
) VALUES
  (${q(`con_w1_terms_${suffix}`)}, ${viewerId}, 'terms', ${q(WALLET1_DOCUMENT_VERSION)}, 'accepted', 'app', ${q(`w1-smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)}),
  (${q(`con_w1_privacy_${suffix}`)}, ${viewerId}, 'privacy', ${q(WALLET1_DOCUMENT_VERSION)}, 'accepted', 'app', ${q(`w1-smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)}),
  (${q(`con_w1_platform_${suffix}`)}, ${viewerId}, 'platform_operation', ${q(WALLET1_DOCUMENT_VERSION)}, 'accepted', 'app', ${q(`w1-smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)}),
  (${q(`con_w1_eligibility_${suffix}`)}, ${viewerId}, 'eligibility', ${q(WALLET1_DOCUMENT_VERSION)}, 'confirmed', 'app', ${q(`w1-smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)});

UPDATE app_wallet_policies
SET adjustments_enabled = 1
WHERE id = ${q(WALLET1_POLICY_ID)}
  AND state = 'development'
  AND production_ready = 0
  AND risk_decision_status = 'unresolved'
  AND retention_decision_status = 'unresolved'
  AND data_location_decision_status = 'unresolved'
  AND require_independent_review = 1
  AND allow_negative_balance = 0
  AND batch_adjustments_enabled = 0;
`.trim()

  for (const token of [viewerAccessToken, viewerRefreshToken, requesterSessionToken, reviewerSessionToken]) {
    if (sql.includes(token)) throw new Error('WALLET1_SMOKE_PLAINTEXT_TOKEN_IN_SQL')
  }

  return {
    suffix,
    sql,
    viewerId,
    requesterId,
    reviewerId,
    accountPublicId,
    viewerAccessToken,
    requesterSessionToken,
    reviewerSessionToken,
  }
}

/**
 * 通过临时 Worker 执行完整 Wallet-1 业务验收；D1 回调只承担策略切换、
 * 不可变触发器验证和最终聚合取证，不直接写入任何账本业务事实。
 */
export async function runWallet1FunctionalSmoke(options) {
  const {
    baseUrl,
    expectedCommit,
    fixture,
    requestJson,
    executeD1,
  } = options
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.workers\.dev$/u.test(baseUrl)) {
    throw new Error('WALLET1_SMOKE_WORKER_URL_INVALID')
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) throw new Error('WALLET1_SMOKE_COMMIT_INVALID')
  if (!fixture?.accountPublicId || !fixture?.viewerAccessToken) {
    throw new Error('WALLET1_SMOKE_FIXTURE_INVALID')
  }
  if (typeof requestJson !== 'function' || typeof executeD1 !== 'function') {
    throw new Error('WALLET1_SMOKE_DEPENDENCY_INVALID')
  }

  const viewerHeaders = {
    Authorization: `Bearer ${fixture.viewerAccessToken}`,
    'Content-Type': 'application/json',
  }
  const requesterHeaders = {
    Cookie: `mei_session=${fixture.requesterSessionToken}`,
    'Content-Type': 'application/json',
  }
  const reviewerHeaders = {
    Cookie: `mei_session=${fixture.reviewerSessionToken}`,
    'Content-Type': 'application/json',
  }
  const api = path => `${baseUrl}${path}`

  const health = await requestJson(api('/api/health'), { expectedStatus: 200 })
  assert.equal(health.status, 'ok')
  assert.equal(health.environment, 'dev')
  assert.equal(health.commit, expectedCommit)
  assert.equal(health.db, 'ok')

  const bootstrap = await requestJson(api('/api/v2/app/bootstrap'), { expectedStatus: 200 })
  assert.equal(bootstrap.meta?.contractVersion, WALLET1_CONTRACT_VERSION)
  assert.equal(bootstrap.data?.capabilities?.auth, true)
  assert.equal(bootstrap.data?.capabilities?.wallet, true)
  assert.equal(bootstrap.data?.capabilities?.notifications, true)
  assert.equal(bootstrap.data?.capabilities?.payments, false)
  assert.equal(bootstrap.data?.capabilities?.systemPush, false)
  assert.equal(bootstrap.data?.wallet?.policyVersion, WALLET1_POLICY_ID)
  for (const field of ['payments', 'recharge', 'spending', 'transfer', 'withdrawal']) {
    assert.equal(bootstrap.data?.wallet?.[field], false, `交易能力必须保持关闭：${field}`)
  }

  const initialWallet = await requestJson(api('/api/v2/me/wallet'), {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.match(initialWallet.data?.disclaimer ?? '', /不可购买、消费、转赠、兑换或提现/u)
  assert.deepEqual(
    pick(initialWallet.data, ['currencyCode', 'balance', 'ledgerVersion', 'status']),
    { currencyCode: 'mei_coin', balance: 0, ledgerVersion: 0, status: 'active' },
  )

  const accounts = await requestJson(
    api(`/api/admin/app/wallets/accounts?query=${encodeURIComponent(fixture.accountPublicId)}`),
    { expectedStatus: 200, headers: requesterHeaders },
  )
  assert.equal(accounts.data?.length, 1)
  assert.equal(accounts.data?.[0]?.accountId, fixture.accountPublicId)
  assert.equal(accounts.data?.[0]?.balance, 0)

  const accountState = await requestJson(
    api(`/api/admin/app/wallets/accounts/${fixture.accountPublicId}`),
    { expectedStatus: 200, headers: requesterHeaders },
  )
  assert.equal(accountState.data?.wallet?.balance, 0)
  assert.deepEqual(accountState.data?.entries, [])

  const initialCredit = adjustmentInput(fixture, 'credit', {
    actionType: 'admin_credit',
    amount: 100,
    reasonCode: 'manual_adjustment',
    userVisibleNote: '隔离验收加币 100 金币',
  })
  const initialPreview = await postJson(requestJson, api('/api/admin/app/wallets/adjustments/preview'), requesterHeaders, initialCredit, 200)
  assert.equal(initialPreview.data?.canSubmit, true)
  assert.equal(initialPreview.data?.balanceBefore, 0)
  assert.equal(initialPreview.data?.balanceAfter, 100)
  assert.equal(initialPreview.data?.requiresIndependentReview, true)
  assert.deepEqual(initialPreview.data?.riskCodes, ['POLICY_UNRESOLVED_ALL_REVIEW'])

  const initialCreated = await createAdjustment(requestJson, api, requesterHeaders, initialCredit, `create-credit-${fixture.suffix}`)
  assert.equal(initialCreated.replayed, false)
  assert.equal(initialCreated.adjustment.status, 'pending_review')
  assert.match(initialCreated.adjustment.adjustmentId, /^wad_[A-Za-z0-9_-]+$/u)

  const initialReplay = await createAdjustment(requestJson, api, requesterHeaders, initialCredit, `create-credit-${fixture.suffix}`)
  assert.equal(initialReplay.replayed, true)
  assert.equal(initialReplay.adjustment.adjustmentId, initialCreated.adjustment.adjustmentId)

  const selfReview = await reviewAdjustment(requestJson, api, requesterHeaders, initialCreated.adjustment, 'approve', `self-review-${fixture.suffix}`, 403)
  assert.equal(adminErrorCode(selfReview), 'SELF_REVIEW_FORBIDDEN')

  const initialApproved = await reviewAdjustment(requestJson, api, reviewerHeaders, initialCreated.adjustment, 'approve', `approve-credit-${fixture.suffix}`, 200)
  assert.equal(initialApproved.data?.replayed, false)
  assert.equal(initialApproved.data?.adjustment?.status, 'applied')
  assert.equal(initialApproved.data?.adjustment?.currentBalance, 100)
  const initialEntryId = initialApproved.data?.adjustment?.entryId
  assert.match(initialEntryId, /^wle_[A-Za-z0-9_-]+$/u)

  const approvalReplay = await reviewAdjustment(requestJson, api, reviewerHeaders, initialCreated.adjustment, 'approve', `approve-credit-${fixture.suffix}`, 200)
  assert.equal(approvalReplay.data?.replayed, true)
  assert.equal(approvalReplay.data?.adjustment?.entryId, initialEntryId)

  const walletAfterCredit = await requestJson(api('/api/v2/me/wallet'), {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(walletAfterCredit.data?.balance, 100)
  assert.equal(walletAfterCredit.data?.ledgerVersion, 1)

  const entriesAfterCredit = await requestJson(api('/api/v2/me/wallet/entries?limit=20'), {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(entriesAfterCredit.data?.length, 1)
  assert.equal(entriesAfterCredit.data?.[0]?.entryId, initialEntryId)
  assert.equal(entriesAfterCredit.data?.[0]?.balanceAfter, 100)
  const entryDetail = await requestJson(api(`/api/v2/me/wallet/entries/${initialEntryId}`), {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(entryDetail.data?.balanceBefore, 0)
  assert.equal(entryDetail.data?.balanceAfter, 100)

  const negativeDebit = adjustmentInput(fixture, 'negative', {
    actionType: 'admin_debit',
    amount: 101,
    reasonCode: 'correction',
    userVisibleNote: '隔离验收负余额拦截',
  })
  const negativePreview = await postJson(requestJson, api('/api/admin/app/wallets/adjustments/preview'), requesterHeaders, negativeDebit, 200)
  assert.equal(negativePreview.data?.canSubmit, false)
  assert.equal(negativePreview.data?.riskCodes?.includes('NEGATIVE_BALANCE'), true)
  const negativeCreate = await postJson(
    requestJson,
    api('/api/admin/app/wallets/adjustments'),
    { ...requesterHeaders, 'Idempotency-Key': `negative-${fixture.suffix}` },
    negativeDebit,
    422,
  )
  assert.equal(adminErrorCode(negativeCreate), 'NEGATIVE_BALANCE_FORBIDDEN')

  const rejectedInput = adjustmentInput(fixture, 'reject', {
    actionType: 'admin_credit', amount: 7, reasonCode: 'correction', userVisibleNote: '隔离验收拒绝申请',
  })
  const rejectedCreated = await createAdjustment(requestJson, api, requesterHeaders, rejectedInput, `create-reject-${fixture.suffix}`)
  const rejected = await reviewAdjustment(requestJson, api, reviewerHeaders, rejectedCreated.adjustment, 'reject', `reject-${fixture.suffix}`, 200)
  assert.equal(rejected.data?.adjustment?.status, 'rejected')
  assert.equal(rejected.data?.adjustment?.entryId, null)

  const staleAInput = adjustmentInput(fixture, 'stale-a', {
    actionType: 'admin_credit', amount: 10, reasonCode: 'correction', userVisibleNote: '隔离验收并发申请 A',
  })
  const staleBInput = adjustmentInput(fixture, 'stale-b', {
    actionType: 'admin_credit', amount: 20, reasonCode: 'correction', userVisibleNote: '隔离验收并发申请 B',
  })
  const staleA = await createAdjustment(requestJson, api, requesterHeaders, staleAInput, `create-stale-a-${fixture.suffix}`)
  const staleB = await createAdjustment(requestJson, api, requesterHeaders, staleBInput, `create-stale-b-${fixture.suffix}`)
  assert.equal(staleA.adjustment.previewLedgerVersion, 1)
  assert.equal(staleB.adjustment.previewLedgerVersion, 1)
  const staleAApproved = await reviewAdjustment(requestJson, api, reviewerHeaders, staleA.adjustment, 'approve', `approve-stale-a-${fixture.suffix}`, 200)
  assert.equal(staleAApproved.data?.adjustment?.currentBalance, 110)
  const staleConflict = await reviewAdjustment(requestJson, api, reviewerHeaders, staleB.adjustment, 'approve', `approve-stale-b-${fixture.suffix}`, 409)
  assert.equal(adminErrorCode(staleConflict), 'WALLET_BALANCE_CHANGED')

  const reversalInput = adjustmentInput(fixture, 'reversal', {
    actionType: 'reversal',
    originalEntryId: initialEntryId,
    userVisibleNote: '隔离验收完整冲正原加币',
  })
  const reversalPreview = await postJson(requestJson, api('/api/admin/app/wallets/adjustments/preview'), requesterHeaders, reversalInput, 200)
  assert.equal(reversalPreview.data?.direction, 'debit')
  assert.equal(reversalPreview.data?.amount, 100)
  assert.equal(reversalPreview.data?.balanceAfter, 10)
  assert.equal(reversalPreview.data?.canSubmit, true)
  const reversalCreated = await createAdjustment(requestJson, api, requesterHeaders, reversalInput, `create-reversal-${fixture.suffix}`)
  const reversalApproved = await reviewAdjustment(requestJson, api, reviewerHeaders, reversalCreated.adjustment, 'approve', `approve-reversal-${fixture.suffix}`, 200)
  const reversalEntryId = reversalApproved.data?.adjustment?.entryId
  assert.match(reversalEntryId, /^wle_[A-Za-z0-9_-]+$/u)
  assert.equal(reversalApproved.data?.adjustment?.currentBalance, 10)

  const duplicateReversalInput = adjustmentInput(fixture, 'reversal-twice', {
    actionType: 'reversal', originalEntryId: initialEntryId, userVisibleNote: '隔离验收重复冲正拦截',
  })
  const duplicateReversalPreview = await postJson(requestJson, api('/api/admin/app/wallets/adjustments/preview'), requesterHeaders, duplicateReversalInput, 200)
  assert.equal(duplicateReversalPreview.data?.canSubmit, false)
  assert.equal(duplicateReversalPreview.data?.riskCodes?.includes('ORIGINAL_ENTRY_NOT_REVERSIBLE'), true)
  const duplicateReversalCreate = await postJson(
    requestJson,
    api('/api/admin/app/wallets/adjustments'),
    { ...requesterHeaders, 'Idempotency-Key': `second-reversal-${fixture.suffix}` },
    duplicateReversalInput,
    422,
  )
  // 此时同时命中“余额不足”和“原流水不可再次冲正”，服务端按固定优先级返回前者。
  assert.equal(adminErrorCode(duplicateReversalCreate), 'NEGATIVE_BALANCE_FORBIDDEN')

  const outboxBefore = oneRow(await executeD1({
    name: 'wallet1-outbox-before-notification-enable',
    sql: `SELECT COUNT(*) AS count FROM app_notification_outbox WHERE event_type = 'wallet.entry_posted';`,
  }))
  assert.equal(Number(outboxBefore.count), 0)

  await executeD1({
    name: 'wallet1-enable-disposable-notification-policy',
    sql: `
UPDATE app_notification_policies
SET generation_enabled = 1,
    effective_at = ${q(new Date().toISOString())}
WHERE id = ${q(WALLET1_NOTIFICATION_POLICY_ID)}
  AND state = 'development'
  AND production_ready = 0
  AND decision_status = 'unresolved'
  AND retention_days IS NULL
  AND purge_enabled = 0;
`.trim(),
  })

  const compensationInput = adjustmentInput(fixture, 'compensation', {
    actionType: 'compensation', amount: 5, reasonCode: 'service_compensation', userVisibleNote: '隔离验收服务补偿 5 金币',
  })
  const compensationCreated = await createAdjustment(requestJson, api, requesterHeaders, compensationInput, `create-compensation-${fixture.suffix}`)
  const compensationApproved = await reviewAdjustment(requestJson, api, reviewerHeaders, compensationCreated.adjustment, 'approve', `approve-compensation-${fixture.suffix}`, 200)
  const compensationEntryId = compensationApproved.data?.adjustment?.entryId
  assert.match(compensationEntryId, /^wle_[A-Za-z0-9_-]+$/u)
  assert.equal(compensationApproved.data?.adjustment?.currentBalance, 15)

  const notifications = await requestJson(api('/api/v2/notifications?category=membership_coin&limit=20'), {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(notifications.data?.length, 1)
  const notification = notifications.data?.[0]
  assert.equal(notification?.eventType, 'wallet.entry_posted')
  assert.match(notification?.title ?? '', /金币已增加/u)
  assert.match(notification?.summary ?? '', /增加 5/u)
  assert.equal(notification?.target?.type, 'wallet_entry')
  assert.equal(notification?.target?.id, compensationEntryId)
  assert.equal(notification?.target?.action, 'open_wallet_entry')
  assert.equal(notification?.target?.available, true)
  const notificationDetail = await requestJson(api(`/api/v2/notifications/${notification.notificationId}`), {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.match(notificationDetail.data?.body ?? '', /不可购买、消费、转赠、兑换或提现/u)
  assert.doesNotMatch(notificationDetail.data?.body ?? '', /一次性合成数据|内部/u)

  await executeD1({
    name: 'wallet1-entry-update-immutability',
    sql: `UPDATE app_wallet_entries SET user_visible_note = '禁止修改' WHERE id = ${q(initialEntryId)};`,
    expectedFailurePattern: 'app_wallet_entries are immutable',
  })
  await executeD1({
    name: 'wallet1-entry-delete-immutability',
    sql: `DELETE FROM app_wallet_entries WHERE id = ${q(initialEntryId)};`,
    expectedFailurePattern: 'app_wallet_entries are immutable',
  })

  const snapshot = oneRow(await executeD1({
    name: 'wallet1-final-aggregate-evidence',
    sql: buildFinalEvidenceQuery(fixture.viewerId, fixture.requesterId, fixture.reviewerId),
  }))
  validateFinalSnapshot(snapshot)

  return {
    status: 'passed',
    contractVersion: WALLET1_CONTRACT_VERSION,
    checks: {
      health: true,
      bootstrapBoundary: true,
      zeroWallet: true,
      independentReview: true,
      idempotency: true,
      negativeBalanceBlocked: true,
      rejection: true,
      stalePreviewConflict: true,
      completeReversal: true,
      immutableLedger: true,
      notificationProjection: true,
    },
    aggregate: {
      walletBalance: Number(snapshot.wallet_balance),
      ledgerVersion: Number(snapshot.wallet_sequence),
      entryCount: Number(snapshot.wallet_entry_count),
      adjustmentCount: Number(snapshot.wallet_adjustment_count),
      auditCount: Number(snapshot.wallet_audit_count),
      notificationCount: Number(snapshot.wallet_notification_count),
    },
  }
}

export function buildFinalEvidenceQuery(viewerId, requesterId, reviewerId) {
  for (const value of [viewerId, requesterId, reviewerId]) {
    if (!Number.isSafeInteger(value)) throw new Error('WALLET1_SMOKE_EVIDENCE_ID_INVALID')
  }
  return `
SELECT
  (SELECT COUNT(*) FROM app_wallets WHERE account_id = ${viewerId}) AS wallet_count,
  (SELECT balance FROM app_wallets WHERE account_id = ${viewerId}) AS wallet_balance,
  (SELECT sequence FROM app_wallets WHERE account_id = ${viewerId}) AS wallet_sequence,
  (SELECT COUNT(*) FROM app_wallet_entries WHERE account_id = ${viewerId}) AS wallet_entry_count,
  (SELECT COUNT(*) FROM app_wallet_adjustments WHERE account_id = ${viewerId}) AS wallet_adjustment_count,
  (SELECT COUNT(*) FROM app_wallet_adjustments WHERE account_id = ${viewerId} AND status = 'applied') AS applied_adjustment_count,
  (SELECT COUNT(*) FROM app_wallet_adjustments WHERE account_id = ${viewerId} AND status = 'rejected') AS rejected_adjustment_count,
  (SELECT COUNT(*) FROM app_wallet_adjustments WHERE account_id = ${viewerId} AND status = 'pending_review') AS pending_adjustment_count,
  (SELECT COUNT(*) FROM app_wallet_adjustment_events WHERE adjustment_id IN (SELECT id FROM app_wallet_adjustments WHERE account_id = ${viewerId})) AS adjustment_event_count,
  (SELECT COUNT(*) FROM app_wallet_review_requests WHERE adjustment_id IN (SELECT id FROM app_wallet_adjustments WHERE account_id = ${viewerId})) AS review_request_count,
  (SELECT COUNT(*) FROM app_wallet_adjustments WHERE account_id = ${viewerId} AND requested_by = reviewed_by) AS self_review_count,
  (SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0) FROM app_wallet_entries WHERE account_id = ${viewerId}) AS signed_entry_total,
  (SELECT COUNT(*) FROM app_wallet_entries current_entry
    LEFT JOIN app_wallet_entries prior_entry
      ON prior_entry.account_id = current_entry.account_id
     AND prior_entry.sequence = current_entry.sequence - 1
    WHERE current_entry.account_id = ${viewerId}
      AND current_entry.balance_before <> COALESCE(prior_entry.balance_after, 0)) AS chain_break_count,
  (SELECT COUNT(*) FROM admin_audit_logs
    WHERE admin_id IN (${requesterId}, ${reviewerId})
      AND action LIKE 'app.wallet.%') AS wallet_audit_count,
  (SELECT COUNT(*) FROM admin_audit_logs
    WHERE admin_id IN (${requesterId}, ${reviewerId})
      AND action = 'app.wallet.adjustment.request') AS request_audit_count,
  (SELECT COUNT(*) FROM admin_audit_logs
    WHERE admin_id IN (${requesterId}, ${reviewerId})
      AND action = 'app.wallet.adjustment.approve') AS approve_audit_count,
  (SELECT COUNT(*) FROM admin_audit_logs
    WHERE admin_id IN (${requesterId}, ${reviewerId})
      AND action = 'app.wallet.adjustment.reject') AS reject_audit_count,
  (SELECT COUNT(*) FROM admin_audit_logs
    WHERE admin_id IN (${requesterId}, ${reviewerId})
      AND action = 'app.wallet.adjustment.execution_conflict') AS conflict_audit_count,
  (SELECT COUNT(*) FROM app_notification_outbox
    WHERE account_id = ${viewerId} AND event_type = 'wallet.entry_posted' AND status = 'delivered') AS delivered_outbox_count,
  (SELECT COUNT(*) FROM app_notification_outbox
    WHERE account_id = ${viewerId} AND event_type = 'wallet.entry_posted' AND status <> 'delivered') AS unsafe_outbox_count,
  (SELECT COUNT(*) FROM app_notifications
    WHERE account_id = ${viewerId} AND event_type = 'wallet.entry_posted') AS wallet_notification_count,
  (SELECT adjustments_enabled FROM app_wallet_policies WHERE id = ${q(WALLET1_POLICY_ID)}) AS adjustments_enabled,
  (SELECT generation_enabled FROM app_notification_policies WHERE id = ${q(WALLET1_NOTIFICATION_POLICY_ID)}) AS notification_generation_enabled;
`.trim()
}

export function validateFinalSnapshot(snapshot) {
  const expected = {
    wallet_count: 1,
    wallet_balance: 15,
    wallet_sequence: 4,
    wallet_entry_count: 4,
    wallet_adjustment_count: 6,
    applied_adjustment_count: 4,
    rejected_adjustment_count: 1,
    pending_adjustment_count: 1,
    adjustment_event_count: 12,
    review_request_count: 5,
    self_review_count: 0,
    signed_entry_total: 15,
    chain_break_count: 0,
    request_audit_count: 6,
    approve_audit_count: 4,
    reject_audit_count: 1,
    conflict_audit_count: 1,
    delivered_outbox_count: 1,
    unsafe_outbox_count: 0,
    wallet_notification_count: 1,
    adjustments_enabled: 1,
    notification_generation_enabled: 1,
  }
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(Number(snapshot?.[field]), value, `Wallet-1 聚合证据不符合预期：${field}`)
  }
  assert.ok(Number(snapshot?.wallet_audit_count) >= 13, 'Wallet-1 审计记录不足')
  return true
}

async function createAdjustment(requestJson, api, headers, body, idempotencyKey) {
  const payload = await postJson(
    requestJson,
    api('/api/admin/app/wallets/adjustments'),
    { ...headers, 'Idempotency-Key': idempotencyKey },
    body,
    200,
  )
  assert.ok(payload.data?.adjustment)
  return payload.data
}

function reviewAdjustment(requestJson, api, headers, adjustment, decision, idempotencyKey, expectedStatus) {
  return postJson(
    requestJson,
    api(`/api/admin/app/wallets/adjustments/${adjustment.adjustmentId}/${decision}`),
    { ...headers, 'Idempotency-Key': idempotencyKey },
    {
      expectedVersion: adjustment.version,
      reviewNote: decision === 'approve' ? '一次性隔离环境独立复核通过' : '一次性隔离环境独立复核拒绝',
    },
    expectedStatus,
  )
}

function postJson(requestJson, url, headers, body, expectedStatus) {
  return requestJson(url, { method: 'POST', headers, body, expectedStatus })
}

function adjustmentInput(fixture, label, values) {
  return {
    accountId: fixture.accountPublicId,
    actionType: values.actionType,
    ...(values.amount === undefined ? {} : { amount: values.amount }),
    ...(values.reasonCode === undefined ? {} : { reasonCode: values.reasonCode }),
    userVisibleNote: values.userVisibleNote,
    internalNote: '仅用于 Wallet-1 一次性合成数据冒烟，不关联真实用户或真实账务',
    businessReference: `smoke.wallet1.${fixture.suffix}.${label}`,
    ...(values.originalEntryId === undefined ? {} : { originalEntryId: values.originalEntryId }),
  }
}

function adminErrorCode(payload) {
  return payload?.code ?? payload?.error?.code ?? null
}

function oneRow(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') {
    throw new Error('WALLET1_SMOKE_D1_ROW_INVALID')
  }
  return rows[0]
}

function pick(value, keys) {
  return Object.fromEntries(keys.map(key => [key, value?.[key]]))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
