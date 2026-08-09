import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import {
  AdminAppOperationsError,
  addAdminAppOperationalIncidentNote,
  changeAdminAppOperationalIncidentStatus,
  changeAdminAppOperationalSafetyControl,
  claimAdminAppOperationalIncident,
  getAdminAppOperationalIncident,
  getAdminAppOperationsOverview,
  linkAdminAppOperationalIncidentRunbook,
  listAdminAppOperationalIncidents,
  listAdminAppOperationalRunbooks,
  previewAdminAppOperationalSafetyControl,
  refreshAdminAppOperationsOverview,
  runAdminAppOperationalDetection,
  type AdminAppIncidentClaimInput,
  type AdminAppIncidentNoteInput,
  type AdminAppIncidentRunbookInput,
  type AdminAppIncidentStatusInput,
  type AdminAppSafetyControlChangeInput,
  type AdminOperationsActor,
} from '../../services/admin-app-operations'
import { errorJson } from '../../utils/api-error'

export const adminAppOperationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppOperationRoutes.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store, max-age=0')
})

adminAppOperationRoutes.get('/overview', async (c) => {
  try {
    return c.json({ data: await getAdminAppOperationsOverview(c.env.DB) })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/overview/refresh', requireOwner, async (c) => {
  try {
    const result = await refreshAdminAppOperationsOverview(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ data: result.overview, replayed: result.replayed }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/detections', requireOwner, async (c) => {
  try {
    const result = await runAdminAppOperationalDetection(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
    )
    return c.json({ data: result.run, replayed: result.replayed }, result.replayed ? 200 : 201)
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.get('/runbooks', async (c) => {
  try {
    return c.json({ data: await listAdminAppOperationalRunbooks(c.env.DB) })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.get('/incidents', async (c) => {
  try {
    const data = await listAdminAppOperationalIncidents(c.env.DB, actor(c), {
      status: c.req.query('status'),
      severity: c.req.query('severity'),
      domain: c.req.query('domain'),
      type: c.req.query('type'),
      owner: c.req.query('owner'),
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    })
    return c.json({ data })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.get('/incidents/:incidentId', async (c) => {
  try {
    return c.json({
      data: await getAdminAppOperationalIncident(
        c.env.DB,
        c.req.param('incidentId'),
        actor(c),
      ),
    })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/incidents/:incidentId/claim', async (c) => {
  try {
    const body = await c.req.json<AdminAppIncidentClaimInput>().catch(() => ({}))
    const result = await claimAdminAppOperationalIncident(
      c.env.DB,
      c.req.param('incidentId'),
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.incident, replayed: result.replayed })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/incidents/:incidentId/notes', async (c) => {
  try {
    const body = await c.req.json<AdminAppIncidentNoteInput>().catch(() => ({}))
    const result = await addAdminAppOperationalIncidentNote(
      c.env.DB,
      c.req.param('incidentId'),
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.incident, replayed: result.replayed })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/incidents/:incidentId/status', async (c) => {
  try {
    const body = await c.req.json<AdminAppIncidentStatusInput>().catch(() => ({}))
    const result = await changeAdminAppOperationalIncidentStatus(
      c.env.DB,
      c.req.param('incidentId'),
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.incident, replayed: result.replayed })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/incidents/:incidentId/runbook', async (c) => {
  try {
    const body = await c.req.json<AdminAppIncidentRunbookInput>().catch(() => ({}))
    const result = await linkAdminAppOperationalIncidentRunbook(
      c.env.DB,
      c.req.param('incidentId'),
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.incident, replayed: result.replayed })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.get('/safety-controls/:controlKey/preview', async (c) => {
  try {
    return c.json({
      data: await previewAdminAppOperationalSafetyControl(
        c.env.DB,
        c.req.param('controlKey'),
        c.req.query('incidentId'),
      ),
    })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

adminAppOperationRoutes.post('/safety-controls/change', requireOwner, async (c) => {
  try {
    const body = await c.req.json<AdminAppSafetyControlChangeInput>().catch(() => ({}))
    const result = await changeAdminAppOperationalSafetyControl(
      c.env.DB,
      actor(c),
      c.req.header('Idempotency-Key') ?? null,
      body,
    )
    return c.json({ data: result.control, replayed: result.replayed })
  }
  catch (error) {
    return handleOperationsError(c, error)
  }
})

function actor(c: Parameters<typeof errorJson>[0]): AdminOperationsActor {
  return {
    adminId: c.get('userId')!,
    role: c.get('userRole')!,
    requestId: c.get('appRequestId') || c.req.header('X-Request-Id') || crypto.randomUUID(),
    traceId: c.req.header('CF-Ray') || null,
  }
}

function handleOperationsError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AdminAppOperationsError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
