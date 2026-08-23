import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  getAdminAppMembershipUserState,
  grantAdminAppMembership,
  previewAdminAppMembershipGrant,
  revokeAdminAppMembershipGrant,
  type AdminAppMembershipGrantInput,
  type AdminAppMembershipRevokeInput,
} from '../../services/admin-app-membership'
import {
  AppMembershipError,
  getAppMembershipCatalog,
  getAppMembershipRuntimeConfig,
  requireAppMembershipAdminEnabled,
} from '../../services/app-membership'
import { errorJson } from '../../utils/api-error'
import {
  approveAdminAppMembershipApplication,
  claimAdminAppMembershipApplication,
  getAdminAppMembershipApplication,
  listAdminAppMembershipApplications,
  transitionAdminAppMembershipApplication,
  type AdminAppMembershipApplicationApproveInput,
  type AdminAppMembershipApplicationMutationInput,
} from '../../services/admin-app-membership-applications'
import {
  createAdminAppMembershipGrantChangeRequest,
  createAdminAppMembershipRevokeChangeRequest,
  getAdminAppMembershipChangeRequest,
  listAdminAppMembershipChangeRequests,
  previewAdminAppMembershipRevokeChange,
  reviewAdminAppMembershipChangeRequest,
  type AdminAppMembershipChangeReviewInput,
} from '../../services/admin-app-membership-reviews'
import {
  compareAdminAppMembershipCatalogs,
  createAdminAppMembershipCatalog,
  getAdminAppMembershipCatalog,
  getAdminAppMembershipCatalogPublishRequest,
  getAdminAppMembershipEntitlementImpact,
  listAdminAppMembershipCatalogPublishRequests,
  listAdminAppMembershipCatalogs,
  replaceAdminAppMembershipCatalogTiers,
  reviewAdminAppMembershipCatalogPublish,
  submitAdminAppMembershipCatalogPublish,
  updateAdminAppMembershipCatalog,
  upsertAdminAppMembershipEntitlement,
  type CreateAdminMembershipCatalogInput,
  type ReplaceAdminMembershipCatalogTiersInput,
  type ReviewAdminMembershipCatalogPublishInput,
  type SubmitAdminMembershipCatalogPublishInput,
  type UpdateAdminMembershipCatalogInput,
  type UpsertAdminMembershipEntitlementInput,
} from '../../services/admin-app-membership-catalogs'
import {
  createAdminAppMembershipLegacyDryRun,
  executeAdminAppMembershipLegacyJob,
  getAdminAppMembershipLegacyWorkspace,
  listAdminAppMembershipLegacyJobs,
  reviewAdminAppMembershipLegacyItem,
  submitAdminAppMembershipLegacyJob,
  type AdminMembershipLegacyDryRunInput,
  type AdminMembershipLegacyExecuteInput,
  type AdminMembershipLegacyReviewInput,
  type AdminMembershipLegacySubmitInput,
} from '../../services/admin-app-membership-migrations'
import {
  cancelAdminAppMembershipBatch,
  createAdminAppMembershipBatchPreview,
  getAdminAppMembershipBatch,
  listAdminAppMembershipBatches,
  submitAdminAppMembershipBatch,
  type AdminMembershipBatchCancelInput,
  type AdminMembershipBatchCreateInput,
  type AdminMembershipBatchSubmitInput,
} from '../../services/admin-app-membership-batches'
import {
  publishAppRealtimeRefresh,
  scheduleAppRealtimeTask,
} from '../../services/app-realtime'

export const adminAppMembershipRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppMembershipRoutes.get('/batches', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppMembershipBatches(
      c.env.DB,
      config.catalogVersionId,
      new Date(),
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/batches/preview', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await createAdminAppMembershipBatchPreview(
      c.env.DB,
      config.catalogVersionId,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipBatchCreateInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return c.json({
      message: data.replayed ? '已返回原批量预览' : '会员批量预览已创建',
      data: data.batch,
    }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/batches/:batchId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipBatch(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('batchId'),
      c.get('userId')!,
      new Date(),
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/batches/:batchId/submit', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await submitAdminAppMembershipBatch(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('batchId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipBatchSubmitInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return c.json({
      message: data.replayed ? '已返回原批量提交结果' : '会员批量有效行已提交独立复核',
      data: data.batch,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/batches/:batchId/cancel', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await cancelAdminAppMembershipBatch(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('batchId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipBatchCancelInput>(),
      new Date(),
    )
    return c.json({
      message: data.replayed ? '已返回原批量取消结果' : '会员批量预览已取消',
      data: data.batch,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/migrations', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppMembershipLegacyJobs(c.env.DB, config.catalogVersionId) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/migrations/dry-run', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const result = await createAdminAppMembershipLegacyDryRun(
      c.env.DB,
      config.catalogVersionId,
      membershipMigrationActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipLegacyDryRunInput>(),
    )
    return c.json({
      message: result.replayed ? '已返回原 Dry-run 结果' : '旧会员 Dry-run 已生成',
      data: result.workspace,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/migrations/:jobId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipLegacyWorkspace(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('jobId'),
      membershipMigrationActor(c),
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/migrations/:jobId/submit', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const result = await submitAdminAppMembershipLegacyJob(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('jobId'),
      membershipMigrationActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipLegacySubmitInput>(),
    )
    return c.json({ message: result.replayed ? '已返回原提交结果' : '迁移条目已提交独立复核', data: result.workspace })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/migrations/:jobId/items/:itemId/review', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const result = await reviewAdminAppMembershipLegacyItem(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('jobId'),
      c.req.param('itemId'),
      membershipMigrationActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipLegacyReviewInput>(),
    )
    return c.json({ message: result.replayed ? '已返回原复核结果' : '迁移条目复核决定已记录', data: result.workspace })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/migrations/:jobId/execute', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const result = await executeAdminAppMembershipLegacyJob(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('jobId'),
      membershipMigrationActor(c),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminMembershipLegacyExecuteInput>(),
    )
    return c.json({ message: result.replayed ? '已返回原执行结果' : '已完成受控迁移执行', data: result.workspace })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalogs', async (c) => {
  try {
    return c.json({ data: await listAdminAppMembershipCatalogs(
      c.env.DB,
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/catalogs', async (c) => {
  try {
    const result = await createAdminAppMembershipCatalog(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateAdminMembershipCatalogInput>(),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    )
    return c.json({
      message: result.replayed ? '已返回原目录草稿' : '会员目录草稿已从基线复制',
      data: result.catalog,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalogs/:catalogId/compare', async (c) => {
  try {
    return c.json({ data: await compareAdminAppMembershipCatalogs(
      c.env.DB,
      c.req.param('catalogId'),
      c.req.query('baseCatalogVersionId'),
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalogs/:catalogId/entitlements/:entitlementKey/impact', async (c) => {
  try {
    return c.json({ data: await getAdminAppMembershipEntitlementImpact(
      c.env.DB,
      c.req.param('catalogId'),
      c.req.param('entitlementKey'),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.put('/catalogs/:catalogId/entitlements/:entitlementKey', async (c) => {
  try {
    const result = await upsertAdminAppMembershipEntitlement(
      c.env.DB,
      c.req.param('catalogId'),
      c.req.param('entitlementKey'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpsertAdminMembershipEntitlementInput>(),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    )
    return c.json({
      message: result.replayed ? '已返回原 Entitlement 修改结果' : 'Entitlement 草稿已保存',
      data: result.catalog,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.put('/catalogs/:catalogId/tiers', async (c) => {
  try {
    const result = await replaceAdminAppMembershipCatalogTiers(
      c.env.DB,
      c.req.param('catalogId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<ReplaceAdminMembershipCatalogTiersInput>(),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    )
    return c.json({
      message: result.replayed ? '已返回原五级目录修改结果' : '五级目录草稿已保存',
      data: result.catalog,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/catalogs/:catalogId/publish-requests', async (c) => {
  try {
    const result = await submitAdminAppMembershipCatalogPublish(
      c.env.DB,
      c.req.param('catalogId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<SubmitAdminMembershipCatalogPublishInput>(),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    )
    return c.json({
      message: result.replayed ? '已返回原目录发布复核申请' : '目录发布已提交独立复核',
      data: result.request,
    }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalogs/:catalogId', async (c) => {
  try {
    return c.json({ data: await getAdminAppMembershipCatalog(
      c.env.DB,
      c.req.param('catalogId'),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.patch('/catalogs/:catalogId', async (c) => {
  try {
    const result = await updateAdminAppMembershipCatalog(
      c.env.DB,
      c.req.param('catalogId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<UpdateAdminMembershipCatalogInput>(),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    )
    return c.json({
      message: result.replayed ? '已返回原目录设置修改结果' : '目录设置草稿已保存',
      data: result.catalog,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalog-publish-reviews', async (c) => {
  try {
    return c.json({ data: await listAdminAppMembershipCatalogPublishRequests(
      c.env.DB,
      c.get('userId')!,
      c.req.query('status'),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalog-publish-reviews/:requestId', async (c) => {
  try {
    return c.json({ data: await getAdminAppMembershipCatalogPublishRequest(
      c.env.DB,
      c.req.param('requestId'),
      c.get('userId')!,
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/catalog-publish-reviews/:requestId/decision', async (c) => {
  try {
    const result = await reviewAdminAppMembershipCatalogPublish(
      c.env.DB,
      c.req.param('requestId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<ReviewAdminMembershipCatalogPublishInput>(),
      getAppMembershipRuntimeConfig(c.env).catalogVersionId,
    )
    return c.json({
      message: result.replayed ? '已返回原目录发布复核结果' : '目录发布复核决定已记录',
      data: result.request,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/catalog', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAppMembershipCatalog(
      c.env.DB,
      config.catalogVersionId,
      { requireProductionReady: config.requireProductionReady },
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/applications', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppMembershipApplications(
      c.env.DB,
      config.catalogVersionId,
      {
        status: c.req.query('status'),
        tierId: c.req.query('tierId'),
        assignedTo: c.req.query('assignedTo'),
        submittedFrom: c.req.query('submittedFrom'),
        submittedTo: c.req.query('submittedTo'),
        limit: c.req.query('limit'),
      },
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/applications/:applicationId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipApplication(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('applicationId'),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/applications/:applicationId/claim', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const body = await c.req.json<{ expectedVersion?: unknown }>()
    return c.json({ data: await claimAdminAppMembershipApplication(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('applicationId'),
      c.get('userId')!,
      body.expectedVersion,
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

for (const [path, transition] of [
  ['request-information', 'request_information'],
  ['reject', 'reject'],
  ['expire', 'expire'],
  ['cancel', 'cancel'],
] as const) {
  adminAppMembershipRoutes.post(`/applications/:applicationId/${path}`, async (c) => {
    try {
      const config = enabledConfig(c.env)
      const data = await transitionAdminAppMembershipApplication(
        c.env.DB,
        config.catalogVersionId,
        c.req.param('applicationId'),
        c.get('userId')!,
        transition,
        await c.req.json<AdminAppMembershipApplicationMutationInput>(),
        new Date(),
        config.requireProductionReady,
      )
      scheduleAppRealtimeTask(c.executionCtx, publishAppRealtimeRefresh(c.env, {
        accountId: data.account.userId,
        dedupeKey: `membership-application:${data.application.applicationId}:${data.application.status}:${data.application.version}`,
        scopes: ['membership'],
      }), `membership.application.${transition}`)
      return c.json({ data })
    }
    catch (error) {
      return handleAppMembershipError(c, error)
    }
  })
}

adminAppMembershipRoutes.post('/applications/:applicationId/approve', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await approveAdminAppMembershipApplication(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('applicationId'),
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipApplicationApproveInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return c.json({
      message: data.replayed ? '已返回原独立复核申请' : '会员发放已提交独立复核',
      data,
    }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/users/:userId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipUserState(
      c.env.DB,
      config.catalogVersionId,
      parseUserId(c.req.param('userId')),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants/preview', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await previewAdminAppMembershipGrant(
      c.env.DB,
      config.catalogVersionId,
      await c.req.json<AdminAppMembershipGrantInput>(),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/change-requests', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await createAdminAppMembershipGrantChangeRequest(
      c.env.DB,
      config.catalogVersionId,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipGrantInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return c.json({
      message: data.replayed ? '已返回原独立复核申请' : '会员发放已提交独立复核',
      data: data.request,
    }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants/:grantId/revoke-preview', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await previewAdminAppMembershipRevokeChange(
      c.env.DB,
      config.catalogVersionId,
      c.req.param('grantId'),
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants/:grantId/revoke-request', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await createAdminAppMembershipRevokeChangeRequest(
      c.env.DB,
      config.catalogVersionId,
      c.get('userId')!,
      c.req.param('grantId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipRevokeInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return c.json({
      message: data.replayed ? '已返回原撤销复核申请' : '会员撤销已提交独立复核',
      data: data.request,
    }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/reviews', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await listAdminAppMembershipChangeRequests(
      c.env.DB,
      c.get('userId')!,
      config.catalogVersionId,
      {
        status: c.req.query('status'),
        operation: c.req.query('operation'),
        limit: c.req.query('limit'),
      },
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.get('/reviews/:requestId', async (c) => {
  try {
    const config = enabledConfig(c.env)
    return c.json({ data: await getAdminAppMembershipChangeRequest(
      c.env.DB,
      c.req.param('requestId'),
      c.get('userId')!,
      new Date(),
      config.requireProductionReady,
    ) })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/reviews/:requestId/decision', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const body = await c.req.json<AdminAppMembershipChangeReviewInput & { decision?: unknown }>()
    const decision = parseReviewDecision(body.decision)
    const data = await reviewAdminAppMembershipChangeRequest(
      c.env.DB,
      c.req.param('requestId'),
      c.get('userId')!,
      decision,
      c.req.header('Idempotency-Key') ?? null,
      body,
      new Date(),
      config.requireProductionReady,
    )
    if (!data.replayed) {
      scheduleAppRealtimeTask(c.executionCtx, publishAppRealtimeRefresh(c.env, {
        accountId: data.request.account.userId,
        dedupeKey: `membership-review:${data.request.requestId}:${data.request.status}:${data.request.version}`,
        scopes: ['membership'],
      }), 'membership.review.decision')
    }
    return c.json({
      message: data.replayed
        ? '已返回原复核结果'
        : decision === 'approve'
          ? '复核通过，会员变更已生效'
          : '复核已拒绝，未产生会员变更',
      data: data.request,
    })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants', async (c) => {
  try {
    const config = enabledConfig(c.env)
    const data = await grantAdminAppMembership(
      c.env.DB,
      config.catalogVersionId,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipGrantInput>(),
      new Date(),
      config.requireProductionReady,
    )
    if (!data.replayed) {
      scheduleAppRealtimeTask(c.executionCtx, publishAppRealtimeRefresh(c.env, {
        accountId: data.userId,
        dedupeKey: `membership-grant:${data.grantId}:created`,
        scopes: ['membership'],
        occurredAt: new Date(data.createdAt),
      }), 'membership.grant')
    }
    return c.json({ message: data.replayed ? '已返回原会员操作结果' : 'App 会员已发放', data }, data.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

adminAppMembershipRoutes.post('/grants/:grantId/revoke', async (c) => {
  try {
    enabledConfig(c.env)
    const data = await revokeAdminAppMembershipGrant(
      c.env.DB,
      c.get('userId')!,
      c.req.param('grantId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<AdminAppMembershipRevokeInput>(),
    )
    if (!data.replayed) {
      scheduleAppRealtimeTask(c.executionCtx, publishAppRealtimeRefresh(c.env, {
        accountId: data.userId,
        dedupeKey: `membership-grant:${data.grantId}:revoked:${data.revokedAt ?? 'unknown'}`,
        scopes: ['membership'],
        occurredAt: data.revokedAt ? new Date(data.revokedAt) : undefined,
      }), 'membership.revoke')
    }
    return c.json({ message: data.replayed ? '已返回原会员撤销结果' : 'App 会员发放已撤销', data })
  }
  catch (error) {
    return handleAppMembershipError(c, error)
  }
})

function enabledConfig(env: Bindings) {
  const config = getAppMembershipRuntimeConfig(env)
  requireAppMembershipAdminEnabled(config)
  return config
}

function parseUserId(raw: string): number {
  const userId = Number(raw)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppMembershipError(400, 'ACCOUNT_ID_INVALID', 'userId 必须为正整数')
  }
  return userId
}

function parseReviewDecision(value: unknown): 'approve' | 'reject' {
  if (value === 'approve' || value === 'reject') return value
  throw new AppMembershipError(400, 'MEMBERSHIP_REVIEW_DECISION_INVALID', 'decision 必须为 approve 或 reject')
}

function membershipMigrationActor(c: {
  get(name: 'userId'): number | null
  get(name: 'userRole'): string | null
}) {
  return { id: c.get('userId')!, role: c.get('userRole') }
}

function handleAppMembershipError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppMembershipError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
