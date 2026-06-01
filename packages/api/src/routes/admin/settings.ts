import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { normalizeBooleanSetting, normalizeFacebookPixelId } from '../../utils/facebook-pixel-settings'
import { generateId } from '../../utils/db'
import { normalizeHomeAdScheduleRange } from '../../utils/home-ad-schedule'
import { normalizeHomeAdUrl } from '../../utils/home-ad-settings'
import { writeAuditLog } from '../../utils/permission'
import { normalizeInternalPathSetting, normalizePublicSettingUrl } from '../../utils/public-setting-url'
import { ADMIN_SETTING_KEYS } from '../../utils/site-settings'

export const adminSettingsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ALLOWED_KEYS: ReadonlyArray<string> = ADMIN_SETTING_KEYS
const PUBLIC_URL_FIELDS: Record<string, string> = {
  site_icon: '站点图标 URL',
  og_image: 'OG 封面图 URL',
}
const SITE_ICON_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

function publicMediaPathToR2Key(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/api/media/public/site/')) return null
  return value.replace('/api/media/public/', '')
}

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
  if ('home_ad_enabled' in body) {
    body.home_ad_enabled = normalizeBooleanSetting(body.home_ad_enabled)
  }
  if ('home_ad_url' in body) {
    try {
      body.home_ad_url = normalizeHomeAdUrl(body.home_ad_url)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '首页广告链接无效' }, 400)
    }
  }
  const hasHomeAdScheduleChange = 'home_ad_starts_at' in body || 'home_ad_ends_at' in body
  if ('rules_page_url' in body) {
    try {
      body.rules_page_url = normalizeInternalPathSetting(body.rules_page_url, '规则页链接')
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '规则页链接无效' }, 400)
    }
  }
  for (const [key, label] of Object.entries(PUBLIC_URL_FIELDS)) {
    if (!(key in body)) continue
    try {
      body[key] = normalizePublicSettingUrl(body[key], label)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : `${label}无效` }, 400)
    }
  }

  const keys = Object.keys(body).filter(k => ALLOWED_KEYS.includes(k))
  if (keys.length === 0) {
    return c.json({ statusCode: 400, message: '没有有效的设置项' }, 400)
  }

  // 读取旧值
  const lookupKeys = new Set(keys)
  if (hasHomeAdScheduleChange) {
    lookupKeys.add('home_ad_starts_at')
    lookupKeys.add('home_ad_ends_at')
  }

  const placeholders = Array.from(lookupKeys).map(() => '?').join(',')
  const oldValues = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...lookupKeys)
    .all<{ key: string; value: string }>()
  const currentMap: Record<string, unknown> = {}
  for (const row of oldValues.results) {
    currentMap[row.key] = JSON.parse(row.value)
  }

  if (hasHomeAdScheduleChange) {
    try {
      const range = normalizeHomeAdScheduleRange(
        'home_ad_starts_at' in body ? body.home_ad_starts_at : currentMap.home_ad_starts_at,
        'home_ad_ends_at' in body ? body.home_ad_ends_at : currentMap.home_ad_ends_at,
      )
      if ('home_ad_starts_at' in body) body.home_ad_starts_at = range.startsAt
      if ('home_ad_ends_at' in body) body.home_ad_ends_at = range.endsAt
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '首页广告排期无效' }, 400)
    }
  }

  const oldMap: Record<string, unknown> = {}
  for (const key of keys) {
    oldMap[key] = currentMap[key]
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

adminSettingsRoutes.post('/site-icon', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file) return c.json({ statusCode: 400, message: '请上传文件（字段名: file）' }, 400)
  const ext = SITE_ICON_TYPES[file.type]
  if (!ext) return c.json({ statusCode: 400, message: '仅支持 PNG、JPEG、WebP、ICO 格式' }, 400)
  if (file.size > 1024 * 1024) return c.json({ statusCode: 400, message: '站点图标不能超过 1MB' }, 400)

  const before = await db.prepare("SELECT value FROM site_settings WHERE key = 'site_icon'").first<{ value: string }>()
  const beforeValue = before ? JSON.parse(before.value) : ''
  const oldKey = publicMediaPathToR2Key(beforeValue)
  const key = `site/site-icon-${generateId('asset')}.${ext}`
  const iconUrl = `/api/media/public/${key}`

  await c.env.R2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })
  if (oldKey && oldKey !== key) await c.env.R2.delete(oldKey)

  await db
    .prepare("UPDATE site_settings SET value = ?, updated_at = datetime('now') WHERE key = ?")
    .bind(JSON.stringify(iconUrl), 'site_icon')
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'settings_site_icon_upload',
    targetType: 'settings',
    targetId: 'site_icon',
    beforeValue: { site_icon: beforeValue },
    afterValue: { site_icon: iconUrl },
  })

  return c.json({ message: '站点图标已上传', iconUrl })
})
