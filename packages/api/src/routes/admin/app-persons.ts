import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  PersonSupplyError,
  createPersonCandidate,
  getAdminPersonDetail,
  grantPersonAuthorization,
  listAdminPersons,
  pausePersonPublication,
  reviewPersonPublication,
  reviewPersonVerification,
  revokePersonAuthorization,
  revokePersonVerification,
  submitPersonPublication,
  submitPersonVerification,
  updatePersonCandidate,
  type GrantAuthorizationInput,
  type PausePublicationInput,
  type PersonProfileInput,
  type ReviewPublicationInput,
  type ReviewVerificationInput,
  type RevokeWorkflowRecordInput,
  type SubmitPublicationInput,
  type SubmitVerificationInput,
  type UpdatePersonProfileInput,
} from '../../services/app-person-supply'
import { errorJson } from '../../utils/api-error'

export const adminAppPersonRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAppPersonRoutes.get('/', async (c) => {
  try {
    return c.json(await listAdminPersons(c.env.DB, {
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      q: c.req.query('q'),
      publicationStatus: c.req.query('publicationStatus'),
    }))
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/', async (c) => {
  try {
    const data = await createPersonCandidate(
      c.env.DB,
      await c.req.json<PersonProfileInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '人物候选已创建', data }, 201)
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.get('/:personId', async (c) => {
  try {
    return c.json({ data: await getAdminPersonDetail(c.env.DB, c.req.param('personId')) })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.patch('/:personId', async (c) => {
  try {
    const data = await updatePersonCandidate(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<UpdatePersonProfileInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '人物草稿已更新；现有公开版本未被静默覆盖', data })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/authorization', async (c) => {
  try {
    const data = await grantPersonAuthorization(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<GrantAuthorizationInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '当前内容版本的用途授权已登记', data }, 201)
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/authorization/revoke', async (c) => {
  try {
    const data = await revokePersonAuthorization(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<RevokeWorkflowRecordInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '用途授权已撤销；关联公开投影已立即暂停', data })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/verification/submit', async (c) => {
  try {
    const data = await submitPersonVerification(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<SubmitVerificationInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '认证复核已提交', data }, 201)
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/verification/decision', async (c) => {
  try {
    const data = await reviewPersonVerification(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<ReviewVerificationInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '认证复核决定已记录', data })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/verification/revoke', async (c) => {
  try {
    const data = await revokePersonVerification(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<RevokeWorkflowRecordInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '认证已撤销；关联公开投影已立即暂停', data })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/publication/submit', async (c) => {
  try {
    const data = await submitPersonPublication(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<SubmitPublicationInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '发布复核已提交', data }, 201)
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/publication/decision', async (c) => {
  try {
    const data = await reviewPersonPublication(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<ReviewPublicationInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '发布复核决定已记录', data })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

adminAppPersonRoutes.post('/:personId/publication/pause', async (c) => {
  try {
    const data = await pausePersonPublication(
      c.env.DB,
      c.req.param('personId'),
      await c.req.json<PausePublicationInput>(),
      c.get('userId')!,
    )
    return c.json({ message: '公开投影已暂停', data })
  } catch (error) {
    return handlePersonSupplyError(c, error)
  }
})

function handlePersonSupplyError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof PersonSupplyError) {
    return errorJson(c, error.status, error.message, { code: error.code, detail: error.detail })
  }
  throw error
}
