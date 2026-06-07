import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  InviteCodeError,
  createInviteCode,
  disableInviteCode,
  listInviteCodes,
  safeInviteCodeAuditValue,
  updateInviteCode,
  type CreateInviteCodeInput,
  type UpdateInviteCodeInput,
} from '../../services/invite-codes'
import { errorJson } from '../../utils/api-error'
import { writeAuditLog } from '../../utils/permission'

export const adminInviteCodeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function handleInviteCodeError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof InviteCodeError) {
    return errorJson(c, error.status, error.message)
  }
  throw error
}

adminInviteCodeRoutes.get('/', async (c) => {
  return c.json({ data: await listInviteCodes(c.env.DB) })
})

adminInviteCodeRoutes.post('/', async (c) => {
  try {
    const adminId = c.get('userId')!
    const body = await c.req.json<Omit<CreateInviteCodeInput, 'createdBy'>>()
    const result = await createInviteCode(c.env.DB, { ...body, createdBy: adminId })
    await writeAuditLog(c.env.DB, {
      adminId,
      action: 'invite_code.create',
      targetType: 'invite_code',
      targetId: result.id,
      afterValue: safeInviteCodeAuditValue(result),
    })
    return c.json(result, 201)
  } catch (error) {
    return handleInviteCodeError(c, error)
  }
})

adminInviteCodeRoutes.patch('/:id', async (c) => {
  try {
    const adminId = c.get('userId')!
    const id = c.req.param('id')
    const body = await c.req.json<UpdateInviteCodeInput & { disable?: boolean }>()
    const result = body.disable
      ? await disableInviteCode(c.env.DB, id)
      : await updateInviteCode(c.env.DB, id, body)
    await writeAuditLog(c.env.DB, {
      adminId,
      action: result.after.status === 'disabled' && result.before.status !== 'disabled' ? 'invite_code.disable' : 'invite_code.update',
      targetType: 'invite_code',
      targetId: id,
      beforeValue: safeInviteCodeAuditValue(result.before),
      afterValue: safeInviteCodeAuditValue(result.after),
    })
    return c.json({ message: '邀请码已更新', data: result.after })
  } catch (error) {
    return handleInviteCodeError(c, error)
  }
})
