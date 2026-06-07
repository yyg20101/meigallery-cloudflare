import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  TrackingSourceError,
  createTrackingSource,
  listTrackingSources,
  safeTrackingSourceAuditValue,
  updateTrackingSource,
  type CreateTrackingSourceInput,
  type UpdateTrackingSourceInput,
} from '../../services/tracking-sources'
import { errorJson } from '../../utils/api-error'
import { writeAuditLog } from '../../utils/permission'

export const adminTrackingSourceRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function handleTrackingSourceError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof TrackingSourceError) {
    return errorJson(c, error.status, error.message)
  }
  throw error
}

adminTrackingSourceRoutes.get('/', async (c) => {
  return c.json({ data: await listTrackingSources(c.env.DB) })
})

adminTrackingSourceRoutes.post('/', async (c) => {
  try {
    const adminId = c.get('userId')!
    const body = await c.req.json<Omit<CreateTrackingSourceInput, 'createdBy'>>()
    const result = await createTrackingSource(c.env.DB, { ...body, createdBy: adminId })
    await writeAuditLog(c.env.DB, {
      adminId,
      action: 'tracking_source.create',
      targetType: 'tracking_source',
      targetId: result.id,
      afterValue: safeTrackingSourceAuditValue(result),
    })
    return c.json({ data: result }, 201)
  } catch (error) {
    return handleTrackingSourceError(c, error)
  }
})

adminTrackingSourceRoutes.patch('/:id', async (c) => {
  try {
    const adminId = c.get('userId')!
    const id = c.req.param('id')
    const body = await c.req.json<UpdateTrackingSourceInput & { disable?: boolean }>()
    const result = await updateTrackingSource(c.env.DB, id, body.disable ? { status: 'disabled' } : body)
    await writeAuditLog(c.env.DB, {
      adminId,
      action: result.after.status === 'disabled' && result.before.status !== 'disabled'
        ? 'tracking_source.disable'
        : 'tracking_source.update',
      targetType: 'tracking_source',
      targetId: id,
      beforeValue: safeTrackingSourceAuditValue(result.before),
      afterValue: safeTrackingSourceAuditValue(result.after),
    })
    return c.json({ message: '推广来源已更新', data: result.after })
  } catch (error) {
    return handleTrackingSourceError(c, error)
  }
})
