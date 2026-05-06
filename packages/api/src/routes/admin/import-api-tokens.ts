import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { generateId } from '../../utils/db'
import { createImportToken, hashImportToken } from '../../utils/import-token'
import { writeAuditLog } from '../../utils/permission'

export const adminImportApiTokenRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminImportApiTokenRoutes.use('*', requireOwner)

type TokenBody = {
  name?: string
  permissions?: string[]
  allowedSourceBotKeys?: string[]
  status?: 'active' | 'disabled'
  expiresAt?: string | null
}

function normalizePermissions(permissions: string[] | undefined) {
  return [...new Set((permissions ?? []).filter(permission => permission === 'gallery:create' || permission === 'testimonial:create'))]
}

function validateSourceBotKeys(keys: string[]) {
  return keys.every(key => /^[a-z0-9_]{3,64}$/.test(key))
}

function sanitizeTokenAuditValue(value: Record<string, unknown>) {
  const { token_hash: _tokenHash, ...safeValue } = value
  return safeValue
}

adminImportApiTokenRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT id, name, permissions, allowed_source_bot_keys, status, expires_at, last_used_at, created_at, updated_at
    FROM import_api_tokens
    ORDER BY created_at DESC
  `).all()
  return c.json({ data: rows.results })
})

adminImportApiTokenRoutes.post('/', async (c) => {
  const ownerId = c.get('userId')!
  const body = await c.req.json<TokenBody>()
  if (!body.name || body.name.trim().length > 60) return c.json({ statusCode: 400, message: 'Token 名称为必填且不能超过 60 字' }, 400)

  const permissions = normalizePermissions(body.permissions)
  if (permissions.length === 0) return c.json({ statusCode: 400, message: '至少选择一个导入权限' }, 400)

  const allowedSourceBotKeys = body.allowedSourceBotKeys ?? []
  if (!validateSourceBotKeys(allowedSourceBotKeys)) return c.json({ statusCode: 400, message: 'sourceBotKey 只能包含小写字母、数字和下划线' }, 400)

  const token = createImportToken()
  const id = generateId('iat')
  await c.env.DB.prepare(`
    INSERT INTO import_api_tokens (id, name, token_hash, permissions, allowed_source_bot_keys, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, body.name.trim(), await hashImportToken(token), JSON.stringify(permissions), JSON.stringify(allowedSourceBotKeys), body.expiresAt ?? null, ownerId).run()

  await writeAuditLog(c.env.DB, {
    adminId: ownerId,
    action: 'import_token.create',
    targetType: 'import_api_token',
    targetId: id,
    afterValue: { name: body.name.trim(), permissions, allowedSourceBotKeys, expiresAt: body.expiresAt ?? null },
  })
  return c.json({ id, token, message: 'Import Token 已创建，请立即保存，刷新后无法再次查看' }, 201)
})

adminImportApiTokenRoutes.patch('/:id', async (c) => {
  const ownerId = c.get('userId')!
  const id = c.req.param('id')
  const body = await c.req.json<TokenBody>()
  const before = await c.env.DB.prepare('SELECT * FROM import_api_tokens WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!before) return c.json({ statusCode: 404, message: 'Import Token 不存在' }, 404)

  const permissions = body.permissions === undefined ? JSON.parse(String(before.permissions)) as string[] : normalizePermissions(body.permissions)
  if (permissions.length === 0) return c.json({ statusCode: 400, message: '至少选择一个导入权限' }, 400)
  const allowedSourceBotKeys = body.allowedSourceBotKeys === undefined ? JSON.parse(String(before.allowed_source_bot_keys)) as string[] : body.allowedSourceBotKeys
  if (!validateSourceBotKeys(allowedSourceBotKeys)) return c.json({ statusCode: 400, message: 'sourceBotKey 只能包含小写字母、数字和下划线' }, 400)

  await c.env.DB.prepare(`
    UPDATE import_api_tokens
    SET name = ?, permissions = ?, allowed_source_bot_keys = ?, status = ?, expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    body.name?.trim() || before.name,
    JSON.stringify(permissions),
    JSON.stringify(allowedSourceBotKeys),
    body.status ?? before.status,
    body.expiresAt === undefined ? before.expires_at : body.expiresAt,
    id,
  ).run()

  await writeAuditLog(c.env.DB, {
    adminId: ownerId,
    action: 'import_token.update',
    targetType: 'import_api_token',
    targetId: id,
    beforeValue: sanitizeTokenAuditValue(before),
    afterValue: { ...body, permissions, allowedSourceBotKeys },
  })
  return c.json({ message: 'Import Token 已更新' })
})

adminImportApiTokenRoutes.delete('/:id', async (c) => {
  const ownerId = c.get('userId')!
  const id = c.req.param('id')
  await c.env.DB.prepare("UPDATE import_api_tokens SET status = 'disabled', updated_at = datetime('now') WHERE id = ?").bind(id).run()
  await writeAuditLog(c.env.DB, { adminId: ownerId, action: 'import_token.disable', targetType: 'import_api_token', targetId: id })
  return c.json({ message: 'Import Token 已禁用' })
})
