import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildFinalEvidenceQuery,
  createWallet1SyntheticFixture,
  runWallet1FunctionalSmoke,
  validateFinalSnapshot,
} from './verify-wallet1-disposable-flow.mjs'

const COMMIT = 'd'.repeat(40)
const SUFFIX = 'abcdef123456'
const BASE_URL = 'https://mei-w1-api-20260808-abcdef123456.example.workers.dev'

describe('Wallet-1 一次性合成 fixture', () => {
  it('SQL 使用真实 migration 的 account_id，并且不包含任何明文凭证', () => {
    const tokens = {
      mga: `mga_${'a'.repeat(64)}`,
      mgr: `mgr_${'b'.repeat(64)}`,
      admin_requester: `admin_requester_${'c'.repeat(64)}`,
      admin_reviewer: `admin_reviewer_${'d'.repeat(64)}`,
    }
    const fixture = createWallet1SyntheticFixture({
      now: new Date('2026-08-08T06:30:00.000Z'),
      suffix: SUFFIX,
      tokenFactory: prefix => tokens[prefix],
    })
    assert.match(fixture.sql, /INSERT INTO app_account_security \(\s*account_id,/u)
    assert.doesNotMatch(fixture.sql, /app_account_security \(\s*user_id/u)
    assert.match(fixture.sql, /adjustments_enabled = 1/u)
    for (const token of Object.values(tokens)) assert.equal(fixture.sql.includes(token), false)
    assert.match(fixture.sql, /[a-f0-9]{64}/u)
  })

  it('最终证据同时约束余额链、状态、审计、通知和保守策略', () => {
    const fixture = createWallet1SyntheticFixture({ suffix: SUFFIX })
    const query = buildFinalEvidenceQuery(fixture.viewerId, fixture.requesterId, fixture.reviewerId)
    assert.match(query, /chain_break_count/u)
    assert.match(query, /self_review_count/u)
    assert.match(query, /wallet_notification_count/u)
    assert.equal(validateFinalSnapshot(validSnapshot()), true)
    assert.throws(
      () => validateFinalSnapshot({ ...validSnapshot(), chain_break_count: 1 }),
      /chain_break_count/u,
    )
  })
})

describe('Wallet-1 HTTP/D1 功能冒烟', () => {
  it('覆盖零余额、双人复核、幂等、负余额、拒绝、并发冲突、冲正、不可变账本和通知', async () => {
    const fixture = createWallet1SyntheticFixture({ suffix: SUFFIX })
    const queue = responseQueue(fixture)
    const calls = []
    const d1Calls = []
    const result = await runWallet1FunctionalSmoke({
      baseUrl: BASE_URL,
      expectedCommit: COMMIT,
      fixture,
      requestJson: async (url, options = {}) => {
        const expected = queue.shift()
        assert.ok(expected, `出现未计划请求：${url}`)
        assert.equal(new URL(url).pathname + new URL(url).search, expected.path)
        assert.equal(options.method || 'GET', expected.method || 'GET')
        assert.equal(options.expectedStatus, expected.status)
        calls.push(expected.path)
        return expected.payload
      },
      executeD1: async operation => {
        d1Calls.push(operation.name)
        if (operation.name === 'wallet1-outbox-before-notification-enable') return [{ count: 0 }]
        if (operation.name === 'wallet1-final-aggregate-evidence') return [validSnapshot()]
        return []
      },
    })
    assert.equal(queue.length, 0)
    assert.equal(result.status, 'passed')
    assert.equal(result.aggregate.walletBalance, 15)
    assert.equal(result.checks.completeReversal, true)
    assert.equal(calls.includes('/api/v2/notifications?category=membership_coin&limit=20'), true)
    assert.deepEqual(d1Calls, [
      'wallet1-outbox-before-notification-enable',
      'wallet1-enable-disposable-notification-policy',
      'wallet1-entry-update-immutability',
      'wallet1-entry-delete-immutability',
      'wallet1-final-aggregate-evidence',
    ])
  })
})

function responseQueue(fixture) {
  const accountId = fixture.accountPublicId
  const initial = adjustment('wad_initial', 1, 0, 100)
  const rejected = adjustment('wad_rejected', 1, 100, 107)
  const staleA = adjustment('wad_stale_a', 1, 100, 110)
  const staleB = adjustment('wad_stale_b', 1, 100, 120)
  const reversal = adjustment('wad_reversal', 1, 110, 10)
  const compensation = adjustment('wad_compensation', 1, 10, 15)
  const initialEntryId = 'wle_initial_entry'
  const reversalEntryId = 'wle_reversal_entry'
  const compensationEntryId = 'wle_compensation_entry'
  const adminSuccess = (adjustmentValue, replayed = false) => ({ data: { adjustment: adjustmentValue, replayed } })
  return [
    item('/api/health', 200, { status: 'ok', environment: 'dev', commit: COMMIT, db: 'ok' }),
    item('/api/v2/app/bootstrap', 200, {
      meta: { contractVersion: '1.10.0' },
      data: {
        capabilities: { auth: true, wallet: true, notifications: true, payments: false, systemPush: false },
        wallet: {
          policyVersion: 'wlp_app_1_0_wallet_1_dev_1',
          payments: false, recharge: false, spending: false, transfer: false, withdrawal: false,
        },
      },
    }),
    item('/api/v2/me/wallet', 200, { data: wallet(0, 0) }),
    item(`/api/admin/app/wallets/accounts?query=${accountId}`, 200, { data: [{ accountId, balance: 0 }] }),
    item(`/api/admin/app/wallets/accounts/${accountId}`, 200, { data: { wallet: wallet(0, 0), entries: [] } }),
    post('/api/admin/app/wallets/adjustments/preview', 200, { data: preview(0, 100, true) }),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(initial)),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(initial, true)),
    post('/api/admin/app/wallets/adjustments/wad_initial/approve', 403, { code: 'SELF_REVIEW_FORBIDDEN' }),
    post('/api/admin/app/wallets/adjustments/wad_initial/approve', 200, adminSuccess({ ...initial, status: 'applied', currentBalance: 100, entryId: initialEntryId })),
    post('/api/admin/app/wallets/adjustments/wad_initial/approve', 200, adminSuccess({ ...initial, status: 'applied', currentBalance: 100, entryId: initialEntryId }, true)),
    item('/api/v2/me/wallet', 200, { data: wallet(100, 1) }),
    item('/api/v2/me/wallet/entries?limit=20', 200, { data: [{ entryId: initialEntryId, balanceAfter: 100 }] }),
    item(`/api/v2/me/wallet/entries/${initialEntryId}`, 200, { data: { balanceBefore: 0, balanceAfter: 100 } }),
    post('/api/admin/app/wallets/adjustments/preview', 200, { data: { ...preview(100, -1, false), riskCodes: ['POLICY_UNRESOLVED_ALL_REVIEW', 'NEGATIVE_BALANCE'] } }),
    post('/api/admin/app/wallets/adjustments', 422, { code: 'NEGATIVE_BALANCE_FORBIDDEN' }),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(rejected)),
    post('/api/admin/app/wallets/adjustments/wad_rejected/reject', 200, adminSuccess({ ...rejected, status: 'rejected', entryId: null })),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(staleA)),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(staleB)),
    post('/api/admin/app/wallets/adjustments/wad_stale_a/approve', 200, adminSuccess({ ...staleA, status: 'applied', currentBalance: 110, entryId: 'wle_stale_a' })),
    post('/api/admin/app/wallets/adjustments/wad_stale_b/approve', 409, { code: 'WALLET_BALANCE_CHANGED' }),
    post('/api/admin/app/wallets/adjustments/preview', 200, { data: { ...preview(110, 10, true), direction: 'debit', amount: 100 } }),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(reversal)),
    post('/api/admin/app/wallets/adjustments/wad_reversal/approve', 200, adminSuccess({ ...reversal, status: 'applied', currentBalance: 10, entryId: reversalEntryId })),
    post('/api/admin/app/wallets/adjustments/preview', 200, { data: { ...preview(10, -90, false), riskCodes: ['POLICY_UNRESOLVED_ALL_REVIEW', 'ORIGINAL_ENTRY_NOT_REVERSIBLE'] } }),
    post('/api/admin/app/wallets/adjustments', 422, { code: 'NEGATIVE_BALANCE_FORBIDDEN' }),
    post('/api/admin/app/wallets/adjustments', 200, adminSuccess(compensation)),
    post('/api/admin/app/wallets/adjustments/wad_compensation/approve', 200, adminSuccess({ ...compensation, status: 'applied', currentBalance: 15, entryId: compensationEntryId })),
    item('/api/v2/notifications?category=membership_coin&limit=20', 200, {
      data: [{
        notificationId: 'ntf_wallet1',
        eventType: 'wallet.entry_posted',
        title: '金币已增加',
        summary: '金币已增加 5 · 平台服务补偿',
        target: { type: 'wallet_entry', id: compensationEntryId, action: 'open_wallet_entry', available: true },
      }],
    }),
    item('/api/v2/notifications/ntf_wallet1', 200, {
      data: { body: '金币已增加 5。金币当前不可购买、消费、转赠、兑换或提现。' },
    }),
  ]
}

function adjustment(id, version, balanceBefore, balanceAfter) {
  return {
    adjustmentId: id,
    status: 'pending_review',
    version,
    previewLedgerVersion: balanceBefore === 0 ? 0 : 1,
    balanceBefore,
    balanceAfter,
    currentBalance: balanceBefore,
    entryId: null,
  }
}

function preview(before, after, canSubmit) {
  return {
    canSubmit,
    balanceBefore: before,
    balanceAfter: after,
    requiresIndependentReview: true,
    riskCodes: ['POLICY_UNRESOLVED_ALL_REVIEW'],
  }
}

function wallet(balance, ledgerVersion) {
  return {
    currencyCode: 'mei_coin',
    balance,
    ledgerVersion,
    status: 'active',
    disclaimer: '金币不可购买、消费、转赠、兑换或提现。',
  }
}

function item(path, status, payload) {
  return { path, status, payload }
}

function post(path, status, payload) {
  return { path, status, payload, method: 'POST' }
}

function validSnapshot() {
  return {
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
    wallet_audit_count: 13,
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
}
