import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { normalizeBooleanSetting, normalizeFacebookPixelId } from '../../utils/facebook-pixel-settings'
import { writeAuditLog } from '../../utils/permission'
import { ADMIN_SETTING_KEYS } from '../../utils/site-settings'

export const adminSettingsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ALLOWED_KEYS: ReadonlyArray<string> = ADMIN_SETTING_KEYS

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
  const rawBody = await c.req.json<Record<string, unknown>>()
  const body: Record<string, unknown> = { ...rawBody }

  if ('facebook_pixel_id' in body) {
    try {
      body.facebook_pixel_id = normalizeFacebookPixelId(body.facebook_pixel_id)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : 'Facebook Pixel ID 无效' }, 400)
    }
  }
  if ('facebook_pixel_enabled' in body) {
    body.facebook_pixel_enabled = normalizeBooleanSetting(body.facebook_pixel_enabled)
  }
  if ('facebook_pixel_debug_enabled' in body) {
    body.facebook_pixel_debug_enabled = normalizeBooleanSetting(body.facebook_pixel_debug_enabled)
  }

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
  const oldMap: Record<string, unknown> = {}
  for (const row of oldValues.results) {
    oldMap[row.key] = JSON.parse(row.value)
  }

  for (const key of keys) {
    await db
      .prepare("UPDATE site_settings SET value = ?, updated_at = datetime('now') WHERE key = ?")
      .bind(JSON.stringify(body[key]), key)
      .run()
  }

  const newMap: Record<string, unknown> = {}
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
