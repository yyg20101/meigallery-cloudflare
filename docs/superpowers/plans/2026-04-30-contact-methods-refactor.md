# 联系方式管理系统重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将硬编码/键值对联系方式改为独立 `contact_methods` 表，支持 11 种主流平台的动态增删、排序、启用/禁用、二维码悬浮/点击跳转。

**Architecture:** 新建 `contact_methods` D1 表，共享层定义平台配置常量和类型。API 层提供公开查询 + 管理员 CRUD + R2 二维码上传。前端 ContactPanel 组件替换旧 ContactCard，管理后台新增联系方式管理页面。

**Tech Stack:** Hono (API Worker), Nuxt 3 (Web Worker), D1, R2, Tailwind CSS, TypeScript

---

## File Structure

### 新建文件
- `packages/api/migrations/0004_contact_methods.sql` — D1 迁移：创建 contact_methods 表
- `packages/shared/src/constants/contact-platforms.ts` — 11 种平台配置常量
- `packages/shared/src/types/contact.ts` — ContactMethod 类型定义
- `packages/api/src/routes/contact-methods.ts` — 公开查询 API（GET 列表 + GET 二维码图片）
- `packages/api/src/routes/admin/contact-methods.ts` — 管理员 CRUD + 二维码上传 API
- `packages/web/app/composables/useContactMethods.ts` — 前端联系方式 composable
- `packages/web/app/components/ContactPanel.vue` — 新联系方式面板组件（替代 ContactCard）
- `packages/web/app/components/ContactMethodItem.vue` — 单个联系方式条目（图标 + 悬浮二维码 + 点击跳转）
- `packages/web/app/components/PlatformIcon.vue` — 平台 SVG 图标组件
- `packages/web/app/pages/admin/contact-methods.vue` — 管理后台联系方式管理页

### 修改文件
- `packages/shared/src/types/index.ts` — 导出新类型
- `packages/shared/src/constants/index.ts` — 导出新常量
- `packages/api/src/index.ts` — 挂载新路由，移除旧 /api/settings/public 的 contact 字段
- `packages/api/src/routes/admin/index.ts` — 挂载 admin contact-methods 路由
- `packages/api/src/routes/admin/settings.ts` — 移除 ALLOWED_KEYS 中的 contact_* 键
- `packages/web/app/pages/user.vue` — 用 ContactPanel 替换 ContactCard
- `packages/web/app/pages/gallery/[slug].vue` — 用 ContactPanel 替换 ContactCard
- `packages/web/app/pages/admin/settings.vue` — 移除联系方式字段，添加链接到联系方式管理页
- `packages/web/app/composables/useSiteSettings.ts` — 移除 contact 相关 computed

### 删除文件
- `packages/web/app/components/ContactCard.vue` — 被 ContactPanel 替代

---

## Task 1: D1 迁移 + 共享类型和常量

**Files:**
- Create: `packages/api/migrations/0004_contact_methods.sql`
- Create: `packages/shared/src/constants/contact-platforms.ts`
- Create: `packages/shared/src/types/contact.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/constants/index.ts`

- [ ] **Step 1: 创建 D1 迁移文件**

```sql
-- 联系方式管理表
-- 替代 site_settings 中的 contact_* 键值对
CREATE TABLE IF NOT EXISTS contact_methods (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,       -- wechat/qq/telegram/whatsapp/line/email/facebook/twitter/instagram/discord/xiaohongshu/custom
  label TEXT NOT NULL,          -- 显示名称，如"客服微信"
  value TEXT NOT NULL,          -- 联系值：用户名、号码、邮箱等
  link_url TEXT,                -- 可点击跳转的 URL（可自动生成或手动填写）
  qr_code_key TEXT,             -- R2 对象 key（二维码图片）
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_enabled ON contact_methods(enabled, sort_order);

-- 清理旧的联系方式键值对
DELETE FROM site_settings WHERE key IN ('contact_wechat', 'contact_telegram', 'contact_email', 'contact_custom_note');
```

- [ ] **Step 2: 创建共享平台配置常量**

`packages/shared/src/constants/contact-platforms.ts`:

```ts
/**
 * 联系方式平台配置
 * 定义所有支持的联系平台及其行为特征
 */
export interface ContactPlatformConfig {
  /** 中文显示名 */
  name: string
  /** 品牌色 */
  color: string
  /** 是否支持二维码（悬浮/点击显示） */
  supportsQr: boolean
  /** 是否支持链接跳转 */
  supportsLink: boolean
  /**
   * URL 模板，{value} 为占位符
   * 用于从 value 自动生成 link_url（管理员也可手动覆盖）
   */
  linkTemplate: string | null
  /** 输入框占位提示 */
  placeholder: string
}

export const CONTACT_PLATFORMS: Record<string, ContactPlatformConfig> = {
  wechat: {
    name: '微信',
    color: '#07C160',
    supportsQr: true,
    supportsLink: false,
    linkTemplate: null,
    placeholder: '微信号',
  },
  qq: {
    name: 'QQ',
    color: '#12B7F5',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://wpa.qq.com/msgrd?v=3&uin={value}&site=qq',
    placeholder: 'QQ 号',
  },
  telegram: {
    name: 'Telegram',
    color: '#26A5E4',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://t.me/{value}',
    placeholder: '用户名（不含 @）',
  },
  whatsapp: {
    name: 'WhatsApp',
    color: '#25D366',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://wa.me/{value}',
    placeholder: '手机号（含国际区号，如 8613800138000）',
  },
  line: {
    name: 'Line',
    color: '#06C755',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://line.me/ti/p/~{value}',
    placeholder: 'Line ID',
  },
  email: {
    name: '邮箱',
    color: '#EA4335',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'mailto:{value}',
    placeholder: '邮箱地址',
  },
  facebook: {
    name: 'Facebook',
    color: '#1877F2',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://m.me/{value}',
    placeholder: '用户名或主页 ID',
  },
  twitter: {
    name: 'Twitter / X',
    color: '#000000',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://x.com/{value}',
    placeholder: '用户名（不含 @）',
  },
  instagram: {
    name: 'Instagram',
    color: '#E4405F',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://instagram.com/{value}',
    placeholder: '用户名',
  },
  discord: {
    name: 'Discord',
    color: '#5865F2',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://discord.gg/{value}',
    placeholder: '邀请码（如 abc123）',
  },
  xiaohongshu: {
    name: '小红书',
    color: '#FE2C55',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://www.xiaohongshu.com/user/profile/{value}',
    placeholder: '小红书号或主页 ID',
  },
  custom: {
    name: '自定义',
    color: '#6B7280',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: null,
    placeholder: '自定义联系值',
  },
} as const

/** 所有支持的平台标识列表 */
export const CONTACT_PLATFORM_KEYS = Object.keys(CONTACT_PLATFORMS)

/**
 * 根据平台和值生成默认跳转链接
 * 如果平台有 linkTemplate 且未手动设置 link_url，则自动生成
 */
export function generateContactLink(platform: string, value: string): string | null {
  const config = CONTACT_PLATFORMS[platform]
  if (!config?.linkTemplate) return null
  return config.linkTemplate.replace('{value}', encodeURIComponent(value))
}
```

- [ ] **Step 3: 创建共享类型**

`packages/shared/src/types/contact.ts`:

```ts
/**
 * 联系方式记录（公开 API 响应）
 */
export interface ContactMethod {
  id: string
  platform: string
  label: string
  value: string
  linkUrl: string | null
  qrCodeUrl: string | null
  sortOrder: number
}

/**
 * 联系方式记录（管理端 API 响应，含额外字段）
 */
export interface ContactMethodAdmin extends ContactMethod {
  enabled: boolean
  qrCodeKey: string | null
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 4: 更新 shared 导出**

`packages/shared/src/types/index.ts` 末尾追加：
```ts
export type { ContactMethod, ContactMethodAdmin } from './contact'
```

`packages/shared/src/constants/index.ts` 末尾追加：
```ts
export { CONTACT_PLATFORMS, CONTACT_PLATFORM_KEYS, generateContactLink } from './contact-platforms'
export type { ContactPlatformConfig } from './contact-platforms'
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 新增 contact_methods 表迁移和共享平台配置常量"
```

---

## Task 2: 公开联系方式 API

**Files:**
- Create: `packages/api/src/routes/contact-methods.ts`
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: 创建公开 API 路由**

`packages/api/src/routes/contact-methods.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const contactMethodRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/contact-methods
 * 公开接口：返回所有已启用的联系方式，按 sort_order 排序
 */
contactMethodRoutes.get('/', async (c) => {
  const db = c.env.DB
  const result = await db
    .prepare(`
      SELECT id, platform, label, value, link_url, qr_code_key, sort_order
      FROM contact_methods
      WHERE enabled = 1
      ORDER BY sort_order ASC, created_at ASC
    `)
    .all<{
      id: string
      platform: string
      label: string
      value: string
      link_url: string | null
      qr_code_key: string | null
      sort_order: number
    }>()

  const apiBase = new URL(c.req.url).origin
  const data = result.results.map((row) => ({
    id: row.id,
    platform: row.platform,
    label: row.label,
    value: row.value,
    linkUrl: row.link_url,
    qrCodeUrl: row.qr_code_key ? `${apiBase}/api/contact-methods/${row.id}/qrcode` : null,
    sortOrder: row.sort_order,
  }))

  return c.json({ data })
})

/**
 * GET /api/contact-methods/:id/qrcode
 * 公开接口：返回指定联系方式的二维码图片
 */
contactMethodRoutes.get('/:id/qrcode', async (c) => {
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const row = await db
    .prepare('SELECT qr_code_key FROM contact_methods WHERE id = ? AND enabled = 1')
    .bind(id)
    .first<{ qr_code_key: string | null }>()

  if (!row?.qr_code_key) {
    return c.json({ statusCode: 404, message: '二维码不存在' }, 404)
  }

  const object = await r2.get(row.qr_code_key)
  if (!object) {
    return c.json({ statusCode: 404, message: '二维码文件未找到' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png')
  headers.set('Cache-Control', 'public, max-age=86400') // 缓存 1 天
  return new Response(object.body, { headers })
})
```

- [ ] **Step 2: 挂载到主路由**

在 `packages/api/src/index.ts` 中：
- 顶部添加 `import { contactMethodRoutes } from './routes/contact-methods'`
- 在 `app.route('/api/me', meRoutes)` 之后添加 `app.route('/api/contact-methods', contactMethodRoutes)`
- 从 `/api/settings/public` 端点移除 `contact_wechat`、`contact_telegram`、`contact_email`、`contact_custom_note` 键

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "feat: 新增公开联系方式 API（列表 + 二维码图片）"
```

---

## Task 3: 管理端联系方式 API

**Files:**
- Create: `packages/api/src/routes/admin/contact-methods.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Modify: `packages/api/src/routes/admin/settings.ts`

- [ ] **Step 1: 创建管理端 CRUD 路由**

`packages/api/src/routes/admin/contact-methods.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/permission'
import { CONTACT_PLATFORMS, generateContactLink } from '@meigallery/shared'

export const adminContactMethodRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 所有联系方式管理操作需要 Owner 权限
adminContactMethodRoutes.use('*', requireOwner)

/** 生成 UUID */
function genId(): string {
  return crypto.randomUUID()
}

/**
 * GET /api/admin/contact-methods
 * 返回所有联系方式（含禁用的）
 */
adminContactMethodRoutes.get('/', async (c) => {
  const db = c.env.DB
  const result = await db
    .prepare(`
      SELECT id, platform, label, value, link_url, qr_code_key, sort_order, enabled, created_at, updated_at
      FROM contact_methods
      ORDER BY sort_order ASC, created_at ASC
    `)
    .all<{
      id: string; platform: string; label: string; value: string
      link_url: string | null; qr_code_key: string | null
      sort_order: number; enabled: number
      created_at: string; updated_at: string
    }>()

  const apiBase = new URL(c.req.url).origin
  const data = result.results.map((row) => ({
    id: row.id,
    platform: row.platform,
    label: row.label,
    value: row.value,
    linkUrl: row.link_url,
    qrCodeUrl: row.qr_code_key ? `${apiBase}/api/contact-methods/${row.id}/qrcode` : null,
    qrCodeKey: row.qr_code_key,
    sortOrder: row.sort_order,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  return c.json({ data })
})

/**
 * POST /api/admin/contact-methods
 * 创建联系方式
 */
adminContactMethodRoutes.post('/', async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const body = await c.req.json<{
    platform: string
    label: string
    value: string
    linkUrl?: string
    enabled?: boolean
  }>()

  // 校验平台
  if (!body.platform || !body.label || !body.value) {
    return c.json({ statusCode: 400, message: '平台、名称和联系值为必填' }, 400)
  }
  if (!(body.platform in CONTACT_PLATFORMS)) {
    return c.json({ statusCode: 400, message: `不支持的平台: ${body.platform}` }, 400)
  }

  // 自动生成跳转链接（如果未手动填写且平台支持）
  const linkUrl = body.linkUrl || generateContactLink(body.platform, body.value)

  // 获取当前最大 sort_order
  const maxOrder = await db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM contact_methods')
    .first<{ max_order: number }>()

  const id = genId()
  await db
    .prepare(`
      INSERT INTO contact_methods (id, platform, label, value, link_url, sort_order, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(id, body.platform, body.label, body.value, linkUrl, (maxOrder?.max_order ?? -1) + 1, body.enabled !== false ? 1 : 0)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'create',
    targetType: 'contact_method',
    targetId: id,
    afterValue: { platform: body.platform, label: body.label, value: body.value },
  })

  return c.json({ id, message: '联系方式已创建' }, 201)
})

/**
 * PUT /api/admin/contact-methods/:id
 * 更新联系方式
 */
adminContactMethodRoutes.put('/:id', async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const body = await c.req.json<{
    platform?: string
    label?: string
    value?: string
    linkUrl?: string | null
    enabled?: boolean
    sortOrder?: number
  }>()

  const existing = await db
    .prepare('SELECT * FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; platform: string; label: string; value: string; link_url: string | null; enabled: number; sort_order: number }>()

  if (!existing) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  if (body.platform && !(body.platform in CONTACT_PLATFORMS)) {
    return c.json({ statusCode: 400, message: `不支持的平台: ${body.platform}` }, 400)
  }

  const platform = body.platform ?? existing.platform
  const value = body.value ?? existing.value
  // 如果 linkUrl 为 undefined（未传），自动重新生成；如果为 null，清空；如果有值，使用传入值
  let linkUrl: string | null
  if (body.linkUrl === undefined) {
    linkUrl = body.value !== undefined || body.platform !== undefined
      ? (generateContactLink(platform, value) ?? existing.link_url)
      : existing.link_url
  } else {
    linkUrl = body.linkUrl
  }

  await db
    .prepare(`
      UPDATE contact_methods
      SET platform = ?, label = ?, value = ?, link_url = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    .bind(
      platform,
      body.label ?? existing.label,
      value,
      linkUrl,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      body.sortOrder ?? existing.sort_order,
      id,
    )
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'update',
    targetType: 'contact_method',
    targetId: id,
    beforeValue: { platform: existing.platform, label: existing.label, value: existing.value },
    afterValue: { platform, label: body.label ?? existing.label, value },
  })

  return c.json({ message: '联系方式已更新' })
})

/**
 * DELETE /api/admin/contact-methods/:id
 * 删除联系方式（同时清理 R2 二维码）
 */
adminContactMethodRoutes.delete('/:id', async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const existing = await db
    .prepare('SELECT id, platform, label, qr_code_key FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; platform: string; label: string; qr_code_key: string | null }>()

  if (!existing) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  // 清理 R2 二维码
  if (existing.qr_code_key) {
    await r2.delete(existing.qr_code_key)
  }

  await db.prepare('DELETE FROM contact_methods WHERE id = ?').bind(id).run()

  await writeAuditLog(db, {
    adminId,
    action: 'delete',
    targetType: 'contact_method',
    targetId: id,
    beforeValue: { platform: existing.platform, label: existing.label },
  })

  return c.json({ message: '联系方式已删除' })
})

/**
 * PATCH /api/admin/contact-methods/reorder
 * 批量更新排序
 */
adminContactMethodRoutes.patch('/reorder', async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const body = await c.req.json<{ ids: string[] }>()

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ statusCode: 400, message: 'ids 数组不能为空' }, 400)
  }

  const stmt = db.prepare("UPDATE contact_methods SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
  const batch = body.ids.map((id, index) => stmt.bind(index, id))
  await db.batch(batch)

  await writeAuditLog(db, {
    adminId,
    action: 'update',
    targetType: 'contact_method',
    afterValue: { action: 'reorder', ids: body.ids },
  })

  return c.json({ message: '排序已更新' })
})

/**
 * POST /api/admin/contact-methods/:id/qrcode
 * 上传二维码图片（multipart/form-data）
 */
adminContactMethodRoutes.post('/:id/qrcode', async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const existing = await db
    .prepare('SELECT id, qr_code_key FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; qr_code_key: string | null }>()

  if (!existing) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) {
    return c.json({ statusCode: 400, message: '请上传文件（字段名: file）' }, 400)
  }

  // 校验文件类型
  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    return c.json({ statusCode: 400, message: '仅支持 PNG、JPEG、WebP 格式' }, 400)
  }

  // 校验文件大小（最大 2MB）
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ statusCode: 400, message: '文件大小不能超过 2MB' }, 400)
  }

  // 删除旧二维码
  if (existing.qr_code_key) {
    await r2.delete(existing.qr_code_key)
  }

  // 上传到 R2
  const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1]
  const r2Key = `qrcodes/${id}.${ext}`
  await r2.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })

  // 更新数据库
  await db
    .prepare("UPDATE contact_methods SET qr_code_key = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(r2Key, id)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'update',
    targetType: 'contact_method',
    targetId: id,
    afterValue: { action: 'upload_qrcode', r2Key },
  })

  return c.json({ message: '二维码已上传', qrCodeKey: r2Key })
})

/**
 * DELETE /api/admin/contact-methods/:id/qrcode
 * 删除二维码图片
 */
adminContactMethodRoutes.delete('/:id/qrcode', async (c) => {
  const adminId = c.get('userId')!
  const { id } = c.req.param()
  const db = c.env.DB
  const r2 = c.env.R2

  const existing = await db
    .prepare('SELECT id, qr_code_key FROM contact_methods WHERE id = ?')
    .bind(id)
    .first<{ id: string; qr_code_key: string | null }>()

  if (!existing) {
    return c.json({ statusCode: 404, message: '联系方式不存在' }, 404)
  }

  if (existing.qr_code_key) {
    await r2.delete(existing.qr_code_key)
  }

  await db
    .prepare("UPDATE contact_methods SET qr_code_key = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'update',
    targetType: 'contact_method',
    targetId: id,
    afterValue: { action: 'delete_qrcode' },
  })

  return c.json({ message: '二维码已删除' })
})
```

- [ ] **Step 2: 挂载到 admin 路由**

在 `packages/api/src/routes/admin/index.ts` 中：
- 添加 `import { adminContactMethodRoutes } from './contact-methods'`
- 添加 `adminRoutes.route('/contact-methods', adminContactMethodRoutes)`

- [ ] **Step 3: 从 admin/settings.ts 移除 contact 键**

将 `ALLOWED_KEYS` 改为：
```ts
const ALLOWED_KEYS = ['site_name', 'seo_title', 'membership_description']
```

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: 新增管理端联系方式 CRUD API（含二维码上传和排序）"
```

---

## Task 4: 前端 PlatformIcon 组件

**Files:**
- Create: `packages/web/app/components/PlatformIcon.vue`

- [ ] **Step 1: 创建平台图标组件**

`packages/web/app/components/PlatformIcon.vue`:

组件接收 `platform` 字符串 prop，渲染对应的内联 SVG 图标。支持 12 种平台 + 默认 link 图标。每个图标使用品牌官方 SVG path，尺寸统一 `w-5 h-5`，颜色通过 `color` prop 控制（默认使用平台品牌色）。

包含的平台 SVG：wechat（微信绿色气泡）、qq（企鹅）、telegram（纸飞机）、whatsapp（电话气泡）、line（LINE 图标）、email（信封）、facebook（f 标志）、twitter（X 标志）、instagram（相机）、discord（控制器）、xiaohongshu（红色书本）、custom（链接图标）。

- [ ] **Step 2: 提交**

```bash
git add -A && git commit -m "feat: 新增 PlatformIcon 组件（12 种平台 SVG 图标）"
```

---

## Task 5: 前端 ContactMethodItem + ContactPanel 组件

**Files:**
- Create: `packages/web/app/components/ContactMethodItem.vue`
- Create: `packages/web/app/components/ContactPanel.vue`
- Create: `packages/web/app/composables/useContactMethods.ts`
- Delete: `packages/web/app/components/ContactCard.vue`

- [ ] **Step 1: 创建 useContactMethods composable**

`packages/web/app/composables/useContactMethods.ts`:

```ts
import type { ContactMethod } from '@meigallery/shared'

/**
 * 公开联系方式 composable
 * 从 /api/contact-methods 获取已启用的联系方式
 * SSR 友好，全局缓存
 */
export function useContactMethods() {
  const { api } = useApi()

  const methods = useState<ContactMethod[]>('contact-methods', () => [])
  const loaded = useState<boolean>('contact-methods-loaded', () => false)

  async function fetchContactMethods() {
    if (loaded.value) return methods.value
    try {
      const res = await api<{ data: ContactMethod[] }>('/api/contact-methods')
      methods.value = res.data
      loaded.value = true
    } catch {
      loaded.value = true
    }
    return methods.value
  }

  const hasContactMethods = computed(() => methods.value.length > 0)

  return {
    contactMethods: methods,
    fetchContactMethods,
    hasContactMethods,
  }
}
```

- [ ] **Step 2: 创建 ContactMethodItem 组件**

`packages/web/app/components/ContactMethodItem.vue`:

接收单个 `ContactMethod` prop。交互逻辑：
- **有 linkUrl 无 qrCodeUrl**：点击整行跳转（`<a>` 标签，`target="_blank"`）
- **有 qrCodeUrl 无 linkUrl**：桌面端悬浮显示二维码弹窗，移动端点击展开
- **两者都有**：桌面端悬浮显示二维码 + 点击跳转按钮；移动端点击展开二维码 + 跳转按钮
- **都没有**：纯文本显示联系值（可复制）

布局：`[平台图标] [标签] [联系值/操作]`
二维码弹窗：绝对定位 tooltip，图片 160x160，圆角白底卡片带箭头

- [ ] **Step 3: 创建 ContactPanel 组件**

`packages/web/app/components/ContactPanel.vue`:

替代旧 ContactCard。调用 `useContactMethods()` 获取数据并渲染 `ContactMethodItem` 列表。
组件内部调用 `fetchContactMethods()`（SSR-safe），无数据时不渲染。
接受可选 `customNote` prop 显示底部说明文字，默认为"如需开通会员或有任何问题，请通过以上方式联系站长。"

- [ ] **Step 4: 删除旧 ContactCard.vue**

```bash
rm packages/web/app/components/ContactCard.vue
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 新增 ContactPanel 组件（支持二维码悬浮/点击跳转）"
```

---

## Task 6: 替换页面中的 ContactCard 引用

**Files:**
- Modify: `packages/web/app/pages/user.vue`
- Modify: `packages/web/app/pages/gallery/[slug].vue`
- Modify: `packages/web/app/composables/useSiteSettings.ts`

- [ ] **Step 1: 更新 user.vue**

- 移除 `useSiteSettings()` 中的 `contactWechat` 等导入
- 移除 `await fetchSettings()` 中联系方式部分（fetchSettings 保留用于 siteName 等）
- 将 `<ContactCard ... />` 替换为 `<ContactPanel class="mb-3" />`

- [ ] **Step 2: 更新 gallery/[slug].vue**

- 同样移除 `useSiteSettings()` 的 contact 导入
- 将 `<ContactCard ... />` 替换为 `<ContactPanel />`

- [ ] **Step 3: 清理 useSiteSettings.ts**

- 移除 `contact_wechat`、`contact_telegram`、`contact_email`、`contact_custom_note` 相关的接口字段和 computed
- 仅保留 `site_name`、`seo_title`、`membership_description`

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "refactor: 页面和 composable 迁移到 ContactPanel"
```

---

## Task 7: 管理后台联系方式管理页面

**Files:**
- Create: `packages/web/app/pages/admin/contact-methods.vue`
- Modify: `packages/web/app/pages/admin/settings.vue`
- Modify: `packages/web/app/pages/admin/index.vue`（如有导航菜单）

- [ ] **Step 1: 创建管理页面**

`packages/web/app/pages/admin/contact-methods.vue`:

功能：
1. **列表**：显示所有联系方式，每行包含平台图标、标签、联系值、启用/禁用开关、二维码缩略图
2. **新增**：弹窗表单 — 选择平台（下拉，12种）、输入标签、输入联系值（placeholder 随平台变化）、可选手动填写跳转链接（默认自动生成）、启用/禁用开关
3. **编辑**：同新增表单，点击行编辑
4. **删除**：确认后删除
5. **排序**：拖拽排序或上下移动按钮，保存后调用 PATCH /reorder
6. **二维码管理**：每行有"上传二维码"按钮，点击弹出文件选择，上传后显示缩略图；已有二维码可删除

使用 Owner 权限校验（`isOwner`），非 Owner 显示提示。

- [ ] **Step 2: 修改 admin/settings.vue**

- 移除"联系方式"区块（微信号、Telegram、邮箱、自定义说明四个字段）
- 在原位置添加链接到联系方式管理页：
```html
<div class="bg-blue-50 rounded-lg p-4 text-sm">
  联系方式已迁移到独立管理页面。
  <NuxtLink to="/admin/contact-methods" class="text-blue-600 hover:underline font-medium">前往管理联系方式 →</NuxtLink>
</div>
```

- [ ] **Step 3: 更新 admin 首页或侧边导航**

在管理后台导航中添加"联系方式"入口链接。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: 后台联系方式管理页（CRUD + 二维码上传 + 排序）"
```

---

## Task 8: 清理旧代码 + 更新公开设置 API

**Files:**
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: 更新 /api/settings/public 端点**

从 keys 数组移除 `contact_wechat`、`contact_telegram`、`contact_email`、`contact_custom_note`：

```ts
const keys = ['site_name', 'seo_title', 'membership_description']
```

- [ ] **Step 2: 提交**

```bash
git add -A && git commit -m "refactor: 清理旧联系方式代码，更新公开设置 API"
```

---

## Task 9: 执行 D1 迁移 + 验证构建 + 推送

- [ ] **Step 1: 本地 D1 迁移**

```bash
cd packages/api && pnpm exec wrangler d1 migrations apply meigallery-db-dev --env dev --remote
```

- [ ] **Step 2: API 类型检查**

```bash
pnpm --filter @meigallery/api exec tsc --noEmit
```

- [ ] **Step 3: Web 构建**

```bash
pnpm --filter @meigallery/web exec nuxt build
```

- [ ] **Step 4: 推送**

```bash
git push
```

- [ ] **Step 5: 部署开发环境**

```bash
cd packages/api && pnpm exec wrangler deploy --env dev
cd ../web && pnpm exec wrangler deploy --env dev
```
