import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WALLET1_CONTRACT_VERSION,
  WALLET1_EXPECTED_TABLES,
  WALLET1_EXPECTED_TRIGGERS,
  main,
  parseD1Rows,
  validateBootstrap,
  validateSchemaSnapshot,
  verifyWallet1DevSchema,
} from './verify-dev-wallet1-schema.mjs'

const COMMIT = 'b'.repeat(40)

describe('Wallet-1 dev schema verifier', () => {
  it('必须显式确认 dev 数据库', async () => {
    await assert.rejects(
      verifyWallet1DevSchema(baseOptions({ confirmDev: 'meigallery-db' })),
      /WALLET1_SCHEMA_DEV_CONFIRMATION_REQUIRED/u,
    )

    let output = ''
    const code = await main({ argv: [], stdout: { write: value => { output += value } } })
    assert.equal(code, 1)
    assert.match(output, /WALLET1_SCHEMA_DEV_CONFIRMATION_REQUIRED/u)
  })

  it('同时验证部署 commit、契约、关闭能力、完整 schema 与空业务账本', async () => {
    const result = await verifyWallet1DevSchema(baseOptions())
    assert.deepEqual(result, {
      status: 'passed',
      gitCommit: COMMIT,
      contractVersion: WALLET1_CONTRACT_VERSION,
      tableCount: WALLET1_EXPECTED_TABLES.length,
      triggerCount: WALLET1_EXPECTED_TRIGGERS.length,
    })
  })

  it('拒绝对外开放钱包、支付能力或任意交易能力', () => {
    const bootstrap = validBootstrap()
    assert.throws(
      () => validateBootstrap({
        ...bootstrap,
        data: {
          ...bootstrap.data,
          capabilities: { ...bootstrap.data.capabilities, wallet: true },
        },
      }),
      /WALLET1_SCHEMA_PUBLIC_CAPABILITY_NOT_CLOSED/u,
    )
    assert.throws(
      () => validateBootstrap({
        ...bootstrap,
        data: { ...bootstrap.data, wallet: { ...bootstrap.data.wallet, recharge: true } },
      }),
      /WALLET1_SCHEMA_TRANSACTION_BOUNDARY_NOT_CLOSED/u,
    )
  })

  it('拒绝未完成 migration、缺失对象、业务数据或打开的策略', async () => {
    await assert.rejects(
      verifyWallet1DevSchema(baseOptions({ listPendingMigrations: async () => ['0077_app_wallet_ledger.sql'] })),
      /WALLET1_SCHEMA_PENDING_MIGRATIONS_REMAIN/u,
    )

    for (const patch of [
      { expected_trigger_count: WALLET1_EXPECTED_TRIGGERS.length - 1 },
      { wallet_entry_count: 1 },
      { notification_unsafe_policy_count: 1 },
    ]) {
      assert.throws(
        () => validateSchemaSnapshot({ ...validSnapshot(), ...patch }),
        /WALLET1_SCHEMA_SNAPSHOT_UNSAFE_/u,
      )
    }
  })

  it('兼容 Wrangler D1 JSON 的顶层数组和 result 包装', () => {
    const row = { wallet_policy_safe: 1 }
    assert.deepEqual(parseD1Rows(JSON.stringify([{ results: [row] }])), [row])
    assert.deepEqual(parseD1Rows({ result: { results: [row] } }), [row])
    assert.throws(() => parseD1Rows({ result: [] }), /WALLET1_SCHEMA_D1_RESULT_INVALID/u)
  })
})

function baseOptions(overrides = {}) {
  return {
    confirmDev: 'meigallery-db-dev',
    getGitCommit: async () => COMMIT,
    requestJson: async (url) => url.endsWith('/api/health')
      ? { status: 'ok', environment: 'dev', commit: COMMIT }
      : validBootstrap(),
    listPendingMigrations: async () => [],
    getSchemaSnapshot: async () => validSnapshot(),
    ...overrides,
  }
}

function validBootstrap() {
  return {
    meta: { contractVersion: WALLET1_CONTRACT_VERSION },
    data: {
      capabilities: { wallet: false, payments: false, systemPush: false },
      wallet: {
        policyVersion: 'wlp_app_1_0_wallet_1_dev_1',
        payments: false,
        recharge: false,
        spending: false,
        transfer: false,
        withdrawal: false,
      },
    },
  }
}

function validSnapshot() {
  return {
    expected_table_count: WALLET1_EXPECTED_TABLES.length,
    expected_trigger_count: WALLET1_EXPECTED_TRIGGERS.length,
    wallet_policy_total: 1,
    wallet_policy_safe: 1,
    wallet_count: 0,
    wallet_adjustment_count: 0,
    wallet_entry_count: 0,
    wallet_event_count: 0,
    wallet_review_count: 0,
    notification_unsafe_policy_count: 0,
    wallet_notification_event_safe: 1,
    wallet_notification_template_safe: 1,
    wallet_notification_outbox_count: 0,
  }
}
