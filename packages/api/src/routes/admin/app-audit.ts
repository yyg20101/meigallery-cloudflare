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

export const adminAppAuditRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

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
  if (error instanceof AdminAppAuditError) {
    return errorJson(c, error.status, error.message, { code: error.code })
  }
  throw error
}
