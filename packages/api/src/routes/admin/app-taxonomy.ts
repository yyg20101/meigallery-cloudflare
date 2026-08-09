import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  createAdminTaxonomyCatalog,
  createAdminTaxonomyTerm,
  changeAdminTaxonomyTermLifecycle,
  getAdminTaxonomyCatalog,
  getAdminTaxonomyTerm,
  listAdminTaxonomyCatalogs,
  listAdminTaxonomyLegacyMappings,
  listAdminTaxonomyTerms,
  mergeAdminTaxonomyTerm,
  publishAdminTaxonomyCatalog,
  reviewAdminTaxonomyTerm,
  submitAdminTaxonomyTerm,
  updateAdminTaxonomyTerm,
  upsertAdminTaxonomyLegacyMapping,
  type CreateTaxonomyCatalogInput,
  type CreateTaxonomyTermInput,
  type ChangeTaxonomyTermLifecycleInput,
  type MergeTaxonomyTermInput,
  type PublishTaxonomyCatalogInput,
  type ReviewTaxonomyTermInput,
  type UpdateTaxonomyTermInput,
  type UpsertTaxonomyLegacyMappingInput,
} from '../../services/admin-app-taxonomy'
import {
  AppTaxonomyError,
  getAppTaxonomyRuntimeConfig,
  requireAppTaxonomyAdminEnabled,
} from '../../services/app-taxonomy'
import { errorJson } from '../../utils/api-error'

export const adminAppTaxonomyRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppTaxonomyRoutes.use('*', async (c, next) => {
  try {
    requireAppTaxonomyAdminEnabled(getAppTaxonomyRuntimeConfig(c.env))
    await next()
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.get('/terms', async (c) => {
  try {
    return c.json(await listAdminTaxonomyTerms(c.env.DB, {
      type: c.req.query('type'),
      status: c.req.query('status'),
      q: c.req.query('q'),
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
    }))
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/terms', async (c) => {
  try {
    const data = await createAdminTaxonomyTerm(
      c.env.DB,
      await c.req.json<CreateTaxonomyTermInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '分类词条草稿已创建', data }, 201)
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.get('/terms/:termId', async (c) => {
  try {
    return c.json({ data: await getAdminTaxonomyTerm(c.env.DB, c.req.param('termId')) })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.patch('/terms/:termId', async (c) => {
  try {
    const data = await updateAdminTaxonomyTerm(
      c.env.DB,
      c.req.param('termId'),
      await c.req.json<UpdateTaxonomyTermInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '分类词条已更新并回到草稿态；已发布目录不受影响', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/terms/:termId/submit', async (c) => {
  try {
    const body = await c.req.json<{ expectedVersion?: unknown; reason?: unknown }>()
    const data = await submitAdminTaxonomyTerm(
      c.env.DB,
      c.req.param('termId'),
      body.expectedVersion,
      body.reason,
      c.get('userId')!,
    )
    return c.json({ message: '分类词条已提交复核', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/terms/:termId/decision', async (c) => {
  try {
    const data = await reviewAdminTaxonomyTerm(
      c.env.DB,
      c.req.param('termId'),
      await c.req.json<ReviewTaxonomyTermInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '分类词条复核决定已记录', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/terms/:termId/merge', async (c) => {
  try {
    const data = await mergeAdminTaxonomyTerm(
      c.env.DB,
      c.req.param('termId'),
      await c.req.json<MergeTaxonomyTermInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '分类词条已合并；下一目录版本将保留稳定重定向', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/terms/:termId/lifecycle', async (c) => {
  try {
    const data = await changeAdminTaxonomyTermLifecycle(
      c.env.DB,
      c.req.param('termId'),
      await c.req.json<ChangeTaxonomyTermLifecycleInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '分类词条生命周期已更新；已发布目录快照不受影响', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.get('/catalogs', async (c) => {
  try {
    return c.json({ data: await listAdminTaxonomyCatalogs(c.env.DB) })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/catalogs', async (c) => {
  try {
    const data = await createAdminTaxonomyCatalog(
      c.env.DB,
      await c.req.json<CreateTaxonomyCatalogInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '不可变分类目录快照已生成', data }, 201)
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.get('/catalogs/:catalogId', async (c) => {
  try {
    return c.json({ data: await getAdminTaxonomyCatalog(c.env.DB, c.req.param('catalogId')) })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.post('/catalogs/:catalogId/publish', async (c) => {
  try {
    const data = await publishAdminTaxonomyCatalog(
      c.env.DB,
      c.req.param('catalogId'),
      await c.req.json<PublishTaxonomyCatalogInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '分类目录已发布并进入不可变状态', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.get('/legacy-mappings', async (c) => {
  try {
    return c.json(await listAdminTaxonomyLegacyMappings(c.env.DB, {
      mappingType: c.req.query('mappingType'),
      sourceNamespace: c.req.query('sourceNamespace'),
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
    }))
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

adminAppTaxonomyRoutes.put('/legacy-mappings', async (c) => {
  try {
    const data = await upsertAdminTaxonomyLegacyMapping(
      c.env.DB,
      await c.req.json<UpsertTaxonomyLegacyMappingInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '旧标签兼容映射已保存；只有 exact/alias 类型会指向稳定词条', data })
  }
  catch (error) {
    return handleTaxonomyError(c, error)
  }
})

function handleTaxonomyError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AppTaxonomyError) {
    return errorJson(c, error.status, error.message, { code: error.code, detail: error.detail })
  }
  throw error
}
