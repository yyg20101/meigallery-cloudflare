import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { errorJson } from '../../utils/api-error'
import {
  AdminAppAuditError,
  getAdminAppAuditEvent,
  getAdminAppAuditIntegrityCheck,
  getAdminAppAuditIntegrityOverview,
  listAdminAppAuditEvents,
  listAdminAppAuditIntegrityChecks,
  runAdminAppAuditIntegrityCheck,
  type AdminAppAuditIntegrityInput,
  type AdminAppAuditListInput,
} from '../../services/admin-app-audit'
import {
  AdminAppAuditExportError,
  createAdminAppAuditExportRequest,
  downloadAdminAppAuditExport,
  getAdminAppAuditExportRequest,
  issueAdminAppAuditExportDownloadTicket,
  issueAdminAppAuditExportStepUp,
  listAdminAppAuditExportRequests,
  reviewAdminAppAuditExportRequest,
  type AdminAppAuditExportCreateInput,
  type AdminAppAuditExportReviewInput,
  type AdminAppAuditExportStepUpInput,
} from '../../services/admin-app-audit-exports'

export const adminAppAuditRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppAuditRoutes.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store, max-age=0')
})

adminAppAuditRoutes.get('/exports', async (c) => {
  try {
    const data = await listAdminAppAuditExportRequests(c.env.DB, c.get('userId')!, {
      status: c.req.query('status'),
      limit: c.req.query('limit'),
    })
    return c.json({ data })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.post('/exports/step-up', async (c) => {
  try {
    const body = await c.req.json<AdminAppAuditExportStepUpInput>().catch(() => ({}))
    const data = await issueAdminAppAuditExportStepUp(
      c.env.DB,
      c.get('userId')!,
      body,
      requestContext(c),
    )
    return c.json({ data }, 201)
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.post('/exports/download', async (c) => {
  try {
    return await downloadAdminAppAuditExport(
      c.env,
      c.get('userId')!,
      c.req.header('X-Audit-Download-Ticket') ?? null,
      requestContext(c),
    )
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.post('/exports', async (c) => {
  try {
    const body = await c.req.json<AdminAppAuditExportCreateInput>().catch(() => ({}))
    const result = await createAdminAppAuditExportRequest(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      c.req.header('X-Audit-Step-Up') ?? null,
      body,
      requestContext(c),
    )
    return c.json({ data: result.request, replayed: result.replayed }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.get('/exports/:requestId', async (c) => {
  try {
    return c.json({
      data: await getAdminAppAuditExportRequest(
        c.env.DB,
        c.get('userId')!,
        c.req.param('requestId'),
      ),
    })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.post('/exports/:requestId/review', async (c) => {
  try {
    const body = await c.req.json<AdminAppAuditExportReviewInput>().catch(() => ({}))
    const result = await reviewAdminAppAuditExportRequest(
      c.env,
      c.get('userId')!,
      c.req.param('requestId'),
      c.req.header('Idempotency-Key') ?? null,
      c.req.header('X-Audit-Step-Up') ?? null,
      body,
      requestContext(c),
    )
    return c.json({ data: result.request, replayed: result.replayed })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.post('/exports/:requestId/download-tickets', async (c) => {
  try {
    const result = await issueAdminAppAuditExportDownloadTicket(
      c.env,
      c.get('userId')!,
      c.req.param('requestId'),
      c.req.header('Idempotency-Key') ?? null,
      c.req.header('X-Audit-Step-Up') ?? null,
      requestContext(c),
    )
    return c.json({ data: result.ticket, replayed: result.replayed }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.get('/events', async (c) => {
  try {
    const input: AdminAppAuditListInput = {
      purpose: c.req.query('purpose'),
      from: c.req.query('from'),
      to: c.req.query('to'),
      action: c.req.query('action'),
      domain: c.req.query('domain'),
      riskLevel: c.req.query('riskLevel'),
      result: c.req.query('result'),
      targetType: c.req.query('targetType'),
      targetId: c.req.query('targetId'),
      actorId: c.req.query('actorId'),
      requestId: c.req.query('requestId'),
      traceId: c.req.query('traceId'),
      businessReference: c.req.query('businessReference'),
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    }
    const data = await listAdminAppAuditEvents(
      c.env.DB,
      c.get('userId')!,
      input,
      requestContext(c),
    )
    return c.json({ data })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.get('/events/:eventId', async (c) => {
  try {
    const data = await getAdminAppAuditEvent(
      c.env.DB,
      c.get('userId')!,
      c.req.param('eventId'),
      c.req.query('purpose'),
      requestContext(c),
    )
    return c.json({ data })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.get('/integrity/overview', async (c) => {
  try {
    return c.json({ data: await getAdminAppAuditIntegrityOverview(c.env.DB, c.get('userId')!) })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.get('/integrity/checks', async (c) => {
  try {
    return c.json({ data: await listAdminAppAuditIntegrityChecks(c.env.DB, c.get('userId')!) })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.get('/integrity/checks/:checkId', async (c) => {
  try {
    return c.json({
      data: await getAdminAppAuditIntegrityCheck(
        c.env.DB,
        c.get('userId')!,
        c.req.param('checkId'),
      ),
    })
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

adminAppAuditRoutes.post('/integrity/checks', async (c) => {
  try {
    const body = await c.req.json<AdminAppAuditIntegrityInput>().catch(() => ({}))
    const result = await runAdminAppAuditIntegrityCheck(
      c.env.DB,
      c.get('userId')!,
      c.req.header('Idempotency-Key') ?? null,
      body,
      requestContext(c),
    )
    return c.json({ data: result.check, replayed: result.replayed }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleAuditError(c, error)
  }
})

function requestContext(c: Parameters<typeof errorJson>[0]) {
  return {
    requestId: c.req.header('X-Request-Id') || crypto.randomUUID(),
    traceId: c.req.header('CF-Ray') || null,
  }
}

function handleAuditError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AdminAppAuditExportError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  if (error instanceof AdminAppAuditError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
