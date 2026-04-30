import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/permission'

export const adminSettingsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ALLOWED_KEYS = ['site_name', 'seo_title', 'membership_description', 'email_verification_enabled']

adminSettingsRoutes.get('/', requireOwner, async (c) => {
  const db = c.env.DB
  const result = await db
    .prepare('SELECT key, value, updated_at FROM site_settings ORDER BY key')
    .all<{ key: string; value: string; updated_at: string }>()

  const settings: Record<string, { value: string; updatedAt: string }> = {}
  for (const row of result.results) {
    settings[row.key] = { value: JSON.parse(row.value), updatedAt: row.updated_at }
  }
  return c.json({ data: settings })
})

adminSettingsRoutes.patch('/', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const body = await c.req.json<Record<string, string>>()

  const keys = Object.keys(body).filter(k => ALLOWED_KEYS.includes(k))
  if (keys.length === 0) {
    return c.json({ statusCode: 400, message: '没有有效的设置项' }, 400)
  }

  // 读取旧值
  const placeholders = keys.map(() => '?').join(',')
  const oldValues = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()
  const oldMap: Record<string, string> = {}
  for (const row of oldValues.results) {
    oldMap[row.key] = JSON.parse(row.value)
  }

  for (const key of keys) {
    await db
      .prepare("UPDATE site_settings SET value = ?, updated_at = datetime('now') WHERE key = ?")
      .bind(JSON.stringify(body[key]), key)
      .run()
  }

  const newMap: Record<string, string> = {}
  for (const key of keys) {
    newMap[key] = body[key]!
  }

  await writeAuditLog(db, {
    adminId,
    action: 'settings_change',
    targetType: 'settings',
    beforeValue: oldMap,
    afterValue: newMap,
  })

  return c.json({ message: '设置已更新', updated: keys })
})
