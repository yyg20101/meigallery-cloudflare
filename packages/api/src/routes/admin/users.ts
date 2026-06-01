import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import {
  AdminUserError,
  changeAdminUserRole,
  changeAdminUserStatus,
  getAdminUserActivity,
  getAdminUserDetail,
  grantAdminUserMembership,
  listAdminUsers,
  resetAdminUserPassword,
  updateAdminUserProfile,
} from '../../services/admin-users'
import { errorJson } from '../../utils/api-error'

export const adminUserRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function handleAdminUserError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AdminUserError) {
    return errorJson(c, error.status as Parameters<typeof errorJson>[1], error.message)
  }
  throw error
}

function parseUserId(value: string) {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new AdminUserError(400, '无效的用户 ID')
  }
  return id
}

/**
 * GET / - 用户列表（分页+搜索）
 */
adminUserRoutes.get('/', async (c) => {
  const result = await listAdminUsers(c.env.DB, {
    page: c.req.query('page'),
    pageSize: c.req.query('pageSize'),
    keyword: c.req.query('q'),
    role: c.req.query('role'),
    status: c.req.query('status'),
  })

  return c.json(result)
})

/**
 * GET /:id - 用户详情（含会员历史）
 */
adminUserRoutes.get('/:id', async (c) => {
  try {
    const result = await getAdminUserDetail(c.env.DB, parseUserId(c.req.param('id')))
    return c.json(result)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})

/**
 * PATCH /:id - 编辑用户基本信息
 */
adminUserRoutes.patch('/:id', async (c) => {
  try {
    const result = await updateAdminUserProfile(
      c.env.DB,
      c.get('userId')!,
      parseUserId(c.req.param('id')),
      await c.req.json<{ username?: string; email?: string }>(),
    )
    return c.json(result)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})

/**
 * POST /:id/reset-password - 管理员重置用户密码
 */
adminUserRoutes.post('/:id/reset-password', async (c) => {
  try {
    const result = await resetAdminUserPassword(
      c.env.DB,
      c.get('userId')!,
      parseUserId(c.req.param('id')),
      (await c.req.json<{ newPassword?: string }>()).newPassword,
    )
    return c.json(result)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})

/**
 * GET /:id/activity - 用户活动日志
 */
adminUserRoutes.get('/:id/activity', async (c) => {
  try {
    const result = await getAdminUserActivity(c.env.DB, parseUserId(c.req.param('id')))
    return c.json(result)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})

/**
 * POST /:id/memberships - 发放会员等级
 */
adminUserRoutes.post('/:id/memberships', async (c) => {
  try {
    const result = await grantAdminUserMembership(
      c.env.DB,
      c.get('userId')!,
      parseUserId(c.req.param('id')),
      await c.req.json<{ levelId?: string; startsAt?: string; expiresAt?: string; note?: string }>(),
    )
    return c.json(result, 201)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})

/**
 * PATCH /:id/role - 修改用户角色（仅 Owner）
 */
adminUserRoutes.patch('/:id/role', requireOwner, async (c) => {
  try {
    const result = await changeAdminUserRole(
      c.env.DB,
      c.get('userId')!,
      parseUserId(c.req.param('id')),
      (await c.req.json<{ role?: string }>()).role,
    )
    return c.json(result)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})

/**
 * PATCH /:id/status - 修改用户状态（封禁/解封）
 */
adminUserRoutes.patch('/:id/status', async (c) => {
  try {
    const result = await changeAdminUserStatus(
      c.env.DB,
      c.get('userId')!,
      parseUserId(c.req.param('id')),
      (await c.req.json<{ status?: string }>()).status,
    )
    return c.json(result)
  } catch (error) {
    return handleAdminUserError(c, error)
  }
})
