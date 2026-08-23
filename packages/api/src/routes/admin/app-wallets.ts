import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  createAdminAppWalletAdjustment,
  getAdminAppWalletAdjustment,
  getAdminAppWalletState,
  listAdminAppWalletAdjustments,
  previewAdminAppWalletAdjustment,
  reviewAdminAppWalletAdjustment,
  searchAdminAppWalletAccounts,
  type AdminWalletAdjustmentInput,
  type AdminWalletReviewInput,
} from '../../services/admin-app-wallet'
import {
  AppWalletError,
  getAppWalletRuntimeConfig,
  requireAppWalletAdminEnabled,
} from '../../services/app-wallet'
import { errorJson } from '../../utils/api-error'
import {
  createAdminAppWalletBatchPreview,
  getAdminAppWalletBatch,
  listAdminAppWalletBatches,
  submitAdminAppWalletBatch,
  type AdminWalletBatchCreateInput,
  type AdminWalletBatchSubmitInput,
} from '../../services/admin-app-wallet-batches'
import {
  claimAdminAppWalletReconciliationCase,
  createAdminAppWalletReconciliationForwardFix,
  listAdminAppWalletReconciliationCases,
  listAdminAppWalletReconciliationRuns,
  previewAdminAppWalletReconciliationRecovery,
  recoverAdminAppWalletReconciliation,
  scanAdminAppWalletReconciliation,
  verifyAdminAppWalletReconciliationCase,
  type AdminWalletReconciliationClaimInput,
  type AdminWalletReconciliationForwardFixInput,
  type AdminWalletReconciliationRecoveryInput,
  type AdminWalletReconciliationScanInput,
  type AdminWalletReconciliationVerifyInput,
} from '../../services/admin-app-wallet-reconciliation'
import {
  publishAppRealtimePublicAccountRefresh,
  scheduleAppRealtimeTask,
} from '../../services/app-realtime'
import {
  createAdminAppWalletLegacyDryRun,
  executeAdminAppWalletLegacyJob,
  getAdminAppWalletLegacyWorkspace,
  listAdminAppWalletLegacyJobs,
  reviewAdminAppWalletLegacyItem,
  submitAdminAppWalletLegacyJob,
  type AdminWalletLegacyDryRunInput,
  type AdminWalletLegacyExecuteInput,
  type AdminWalletLegacyReviewInput,
  type AdminWalletLegacySubmitInput,
} from '../../services/admin-app-wallet-migrations'

export const adminAppWalletRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppWalletRoutes.get('/migrations', async (c) => {
  try {
    return c.json({ data: await listAdminAppWalletLegacyJobs(
      c.env.DB,
      walletActor(c),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/migrations/dry-run', async (c) => {
  try {
    const result = await createAdminAppWalletLegacyDryRun(
      c.env.DB,
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletLegacyDryRunInput>(),
      enabledConfig(c.env),
    )
    return c.json({
      message: result.replayed ? '已返回原旧余额 Dry-run' : '旧余额 Dry-run 已生成',
      data: result.workspace,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/migrations/:jobId', async (c) => {
  try {
    return c.json({ data: await getAdminAppWalletLegacyWorkspace(
      c.env.DB,
      c.req.param('jobId'),
      walletActor(c),
      enabledConfig(c.env),
      new Date(),
      true,
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/migrations/:jobId/submit', async (c) => {
  try {
    const result = await submitAdminAppWalletLegacyJob(
      c.env.DB,
      c.req.param('jobId'),
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletLegacySubmitInput>(),
      enabledConfig(c.env),
    )
    return c.json({
      message: result.replayed ? '已返回原迁移提交结果' : '旧余额条目已提交独立复核',
      data: result.workspace,
    })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/migrations/:jobId/items/:itemId/review', async (c) => {
  try {
    const result = await reviewAdminAppWalletLegacyItem(
      c.env.DB,
      c.req.param('jobId'),
      c.req.param('itemId'),
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletLegacyReviewInput>(),
      enabledConfig(c.env),
    )
    return c.json({
      message: result.replayed ? '已返回原复核结果' : '旧余额迁移条目复核完成',
      data: result.workspace,
    })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/migrations/:jobId/execute', async (c) => {
  try {
    const result = await executeAdminAppWalletLegacyJob(
      c.env.DB,
      c.req.param('jobId'),
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletLegacyExecuteInput>(),
      enabledConfig(c.env),
    )
    if (!result.replayed && result.refreshedAccountIds.length) {
      scheduleAppRealtimeTask(c.executionCtx, Promise.all(result.refreshedAccountIds.map(accountPublicId => (
        publishAppRealtimePublicAccountRefresh(c.env, {
          accountPublicId,
          dedupeKey: `wallet-legacy-migration:${result.workspace.job.jobId}:${accountPublicId}`,
          scopes: ['wallet'],
          occurredAt: result.workspace.job.executedAt
            ? new Date(result.workspace.job.executedAt)
            : undefined,
        })
      ))), 'wallet.legacy_migration.execute')
    }
    return c.json({
      message: result.replayed ? '已返回原旧余额迁移结果' : '旧余额迁移执行完成',
      data: result.workspace,
    })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/batches', async (c) => {
  try {
    return c.json({ data: await listAdminAppWalletBatches(c.env.DB, enabledConfig(c.env)) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/batches/preview', async (c) => {
  try {
    const result = await createAdminAppWalletBatchPreview(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletBatchCreateInput>(),
      enabledConfig(c.env),
    )
    return c.json({ message: result.replayed ? '已返回原批量校验结果' : '批量调币校验已完成', data: result.batch }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/batches/:batchId', async (c) => {
  try {
    return c.json({ data: await getAdminAppWalletBatch(c.env.DB, c.req.param('batchId'), enabledConfig(c.env)) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/batches/:batchId/submit', async (c) => {
  try {
    const result = await submitAdminAppWalletBatch(
      c.env.DB,
      c.req.param('batchId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletBatchSubmitInput>(),
      enabledConfig(c.env),
    )
    return c.json({ message: result.replayed ? '已返回原批量提交结果' : '有效行已逐项提交独立复核', data: result.batch })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/reconciliation/runs', async (c) => {
  try {
    return c.json({ data: await listAdminAppWalletReconciliationRuns(c.env.DB, enabledConfig(c.env)) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/reconciliation/cases', async (c) => {
  try {
    return c.json({ data: await listAdminAppWalletReconciliationCases(
      c.env.DB,
      c.req.query('status'),
      walletActor(c),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/reconciliation/scans', async (c) => {
  try {
    const result = await scanAdminAppWalletReconciliation(
      c.env.DB,
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletReconciliationScanInput>(),
      enabledConfig(c.env),
    )
    return c.json({ message: result.replayed ? '已返回原对账扫描结果' : '钱包账本扫描已完成', data: result }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/reconciliation/cases/:caseId/claim', async (c) => {
  try {
    return c.json({ data: await claimAdminAppWalletReconciliationCase(
      c.env.DB,
      c.req.param('caseId'),
      walletActor(c),
      await c.req.json<AdminWalletReconciliationClaimInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/reconciliation/cases/:caseId/forward-fix', async (c) => {
  try {
    return c.json({ data: await createAdminAppWalletReconciliationForwardFix(
      c.env.DB,
      c.req.param('caseId'),
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletReconciliationForwardFixInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/reconciliation/cases/:caseId/verify', async (c) => {
  try {
    return c.json({ data: await verifyAdminAppWalletReconciliationCase(
      c.env.DB,
      c.req.param('caseId'),
      walletActor(c),
      await c.req.json<AdminWalletReconciliationVerifyInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/reconciliation/cases/:caseId/recovery-preview', async (c) => {
  try {
    return c.json({ data: await previewAdminAppWalletReconciliationRecovery(
      c.env.DB,
      c.req.param('caseId'),
      walletActor(c),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/reconciliation/cases/:caseId/recover', async (c) => {
  try {
    const result = await recoverAdminAppWalletReconciliation(
      c.env.DB,
      c.req.param('caseId'),
      walletActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletReconciliationRecoveryInput>(),
      enabledConfig(c.env),
    )
    if (!result.replayed) {
      scheduleAppRealtimeTask(c.executionCtx, publishAppRealtimePublicAccountRefresh(c.env, {
        accountPublicId: result.recovery.accountId,
        dedupeKey: `wallet-recovery:${result.recovery.commandId}:applied`,
        scopes: ['wallet'],
        occurredAt: new Date(result.recovery.appliedAt),
      }), 'wallet.recovery.applied')
    }
    return c.json({
      message: result.replayed ? '已返回原钱包恢复结果' : '钱包快照已重建并恢复可用',
      data: result,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/accounts', async (c) => {
  try {
    return c.json({ data: await searchAdminAppWalletAccounts(
      c.env.DB,
      c.req.query('query'),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/accounts/:accountId', async (c) => {
  try {
    return c.json({ data: await getAdminAppWalletState(
      c.env.DB,
      c.req.param('accountId'),
      c.get('userId')!,
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/adjustments/preview', async (c) => {
  try {
    return c.json({ data: await previewAdminAppWalletAdjustment(
      c.env.DB,
      await c.req.json<AdminWalletAdjustmentInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.post('/adjustments', async (c) => {
  try {
    return c.json({ data: await createAdminAppWalletAdjustment(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminWalletAdjustmentInput>(),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/adjustments', async (c) => {
  try {
    return c.json({ data: await listAdminAppWalletAdjustments(
      c.env.DB,
      c.req.query('status'),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

adminAppWalletRoutes.get('/adjustments/:adjustmentId', async (c) => {
  try {
    return c.json({ data: await getAdminAppWalletAdjustment(
      c.env.DB,
      c.req.param('adjustmentId'),
      enabledConfig(c.env),
    ) })
  }
  catch (error) {
    return handleWalletError(c, error)
  }
})

for (const decision of ['approve', 'reject'] as const) {
  adminAppWalletRoutes.post(`/adjustments/:adjustmentId/${decision}`, async (c) => {
    try {
      const data = await reviewAdminAppWalletAdjustment(
        c.env.DB,
        c.req.param('adjustmentId'),
        c.get('userId')!,
        decision,
        c.req.header('Idempotency-Key') ?? null,
        await c.req.json<AdminWalletReviewInput>(),
        enabledConfig(c.env),
      )
      if (!data.replayed && data.adjustment.status === 'applied') {
        scheduleAppRealtimeTask(c.executionCtx, publishAppRealtimePublicAccountRefresh(c.env, {
          accountPublicId: data.adjustment.account.accountId,
          dedupeKey: `wallet-adjustment:${data.adjustment.adjustmentId}:applied:${data.adjustment.version}`,
          scopes: ['wallet'],
          occurredAt: data.adjustment.appliedAt ? new Date(data.adjustment.appliedAt) : undefined,
        }), 'wallet.adjustment.applied')
      }
      return c.json({ data })
    }
    catch (error) {
      return handleWalletError(c, error)
    }
  })
}

function enabledConfig(env: Bindings) {
  const config = getAppWalletRuntimeConfig(env)
  requireAppWalletAdminEnabled(config)
  return config
}

function handleWalletError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppWalletError) {
    return errorJson(c, error.status, error.message, {
      code: error.code,
      detail: { retryable: error.retryable },
    })
  }
  throw error
}

function walletActor(c: {
  get(name: 'userId'): number | null
  get(name: 'userRole'): string | null
}) {
  return { id: c.get('userId')!, role: c.get('userRole') }
}
