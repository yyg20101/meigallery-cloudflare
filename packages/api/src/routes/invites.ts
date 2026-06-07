import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { InviteCodeError, verifyInviteCodeStatus } from '../services/invite-codes'
import { errorJson } from '../utils/api-error'

export const inviteRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

inviteRoutes.get('/:code/status', async (c) => {
  try {
    const result = await verifyInviteCodeStatus(c.env.DB, c.req.param('code'))
    return c.json(result)
  } catch (error) {
    if (error instanceof InviteCodeError) {
      return errorJson(c, error.status, error.message, { code: 'INVITE_CODE_INVALID' })
    }
    throw error
  }
})
