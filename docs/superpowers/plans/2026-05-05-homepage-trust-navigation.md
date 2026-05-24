# 首页真实案例与导航体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现首页真实案例、标签导航、公开案例页、规则悬浮入口、后台真实案例管理和 Workers dev 隔离测试流程。

**Architecture:** 后端新增 `testimonial_cases` 与 `testimonial_case_images`，通过 Hono 暴露公开和后台 API，图片存入 R2 并由 API 代理公开读取。前端新增首页标签导航、真实案例轮播、案例列表/详情和规则弹窗，同时移除关于入口与首页无限滚动。

**Tech Stack:** Cloudflare D1、R2、Hono、Nuxt 4/Vue 3、Tailwind CSS v4、Nuxt UI、Vitest、Wrangler。

---

## 文件结构

- Create: `packages/api/migrations/0014_testimonial_cases.sql`，新增真实案例表、图片表、规则设置默认值并移除 about 设置。
- Create: `packages/api/src/utils/testimonial-cases.ts`，真实案例 slug、发布校验、图片 URL 和排序工具。
- Create: `packages/api/src/utils/testimonial-cases.test.ts`，测试工具函数。
- Modify: `packages/api/src/utils/site-settings.ts`，移除 about keys，加入规则入口 keys。
- Modify: `packages/api/src/utils/site-settings.test.ts`，更新站点设置 key 测试。
- Create: `packages/api/src/routes/testimonial-cases.ts`，公开真实案例列表、详情和图片代理。
- Create: `packages/api/src/routes/admin/testimonial-cases.ts`，后台真实案例 CRUD 和图片上传管理。
- Modify: `packages/api/src/routes/admin/index.ts`，挂载后台真实案例路由。
- Modify: `packages/api/src/index.ts`，挂载公开真实案例路由，并为 dev 环境加 noindex header。
- Modify: `packages/api/wrangler.toml`，增加 dev Worker 配置。
- Create: `packages/web/app/utils/safeMarkdown.ts`，安全 Markdown 渲染工具。
- Modify: `packages/web/app/composables/useSiteSettings.ts`，增加规则配置并移除 about 配置。
- Modify: `packages/web/app/app.vue`，dev 环境增加 noindex meta。
- Modify: `packages/web/app/layouts/default.vue`，移除“关于”导航并增加 dev 角标。
- Modify: `packages/web/app/layouts/admin.vue`，增加真实案例后台导航。
- Modify: `packages/web/app/components/HomeEditorialHero.vue`，移除两个 CTA 按钮。
- Create: `packages/web/app/components/HomeTagNavigator.vue`，首页标签导航。
- Create: `packages/web/app/components/TestimonialCarousel.vue`，首页真实案例轮播。
- Create: `packages/web/app/components/TestimonialCard.vue`，真实案例卡片。
- Create: `packages/web/app/components/TestimonialGallery.vue`，真实案例详情图片组。
- Modify: `packages/web/app/components/ContactPanel.vue`，消息 icon 联系入口和规则弹窗。
- Modify: `packages/web/app/pages/index.vue`，替换地区发现、移除无限加载、接入案例轮播和标签导航。
- Create: `packages/web/app/pages/testimonials/index.vue`，公开真实案例列表页。
- Create: `packages/web/app/pages/testimonials/[slug].vue`，公开真实案例详情页。
- Create: `packages/web/app/pages/rules.vue`，公开规则页。
- Modify/Delete: `packages/web/app/pages/about.vue`，从产品入口移除；执行阶段建议删除该页面。
- Modify: `packages/web/app/pages/admin/settings.vue`，移除关于配置，新增规则配置。
- Create: `packages/web/app/pages/admin/testimonials/index.vue`，后台真实案例列表。
- Create: `packages/web/app/pages/admin/testimonials/new.vue`，后台新建真实案例。
- Create: `packages/web/app/pages/admin/testimonials/[id].vue`，后台编辑真实案例和图片管理。
- Modify: `packages/web/wrangler.toml`，增加 dev Worker 配置与 API service binding。

---

### Task 1: 数据模型、设置 key 与真实案例工具

**Files:**
- Create: `packages/api/migrations/0014_testimonial_cases.sql`
- Create: `packages/api/src/utils/testimonial-cases.ts`
- Create: `packages/api/src/utils/testimonial-cases.test.ts`
- Modify: `packages/api/src/utils/site-settings.ts`
- Modify: `packages/api/src/utils/site-settings.test.ts`

- [ ] **Step 1: 编写 migration**

Create `packages/api/migrations/0014_testimonial_cases.sql`:

```sql
-- 真实案例、规则入口与关于页配置移除
CREATE TABLE IF NOT EXISTS testimonial_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  featured INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('draft', 'published'))
);

CREATE TABLE IF NOT EXISTS testimonial_case_images (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES testimonial_cases(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt_text TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_testimonial_cases_public
  ON testimonial_cases(status, featured, sort_order, published_at);
CREATE INDEX IF NOT EXISTS idx_testimonial_images_case
  ON testimonial_case_images(case_id, sort_order);

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('rules_entry_enabled', 'true', datetime('now')),
  ('rules_entry_title', '"入站规则"', datetime('now')),
  ('rules_entry_summary', '"查看内容规则、会员说明和联系前须知。"', datetime('now')),
  ('rules_entry_icon', '"letter"', datetime('now')),
  ('rules_modal_content', '"## 入站规则\n\n- 本站仅展示合法授权的写真、时尚、生活与艺术类内容\n- 受保护内容需登录并满足会员等级\n- 如需咨询会员或内容授权，请通过联系站长入口沟通"', datetime('now')),
  ('rules_page_title', '"入站规则"', datetime('now')),
  ('rules_page_summary', '"了解 MeiGallery 的内容边界、会员访问和联系方式说明。"', datetime('now')),
  ('rules_page_content', '"## 内容边界\n\nMeiGallery 仅展示经过授权的写真、时尚、生活与艺术类素材，不发布露骨、侵权或侵犯隐私的内容。\n\n## 会员访问\n\n部分高清图片和完整内容需要会员权限。会员等级由站长手动授予，到期后自动失去对应访问权限。\n\n## 联系站长\n\n如需开通会员、咨询授权或反馈问题，请使用页面右下角联系方式。"', datetime('now')),
  ('rules_page_url', '"/rules"', datetime('now'));

DELETE FROM site_settings WHERE key IN ('about_title', 'about_summary', 'about_content');
```

- [ ] **Step 2: 更新 site settings key 测试**

Modify `packages/api/src/utils/site-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ADMIN_SETTING_KEYS, PUBLIC_SETTING_KEYS } from './site-settings'

describe('site settings keys', () => {
  it('does not expose removed about page settings', () => {
    const aboutKeys = ['about_title', 'about_summary', 'about_content']

    for (const key of aboutKeys) {
      expect(ADMIN_SETTING_KEYS).not.toContain(key)
      expect(PUBLIC_SETTING_KEYS).not.toContain(key)
    }
  })

  it('allows homepage editorial settings in admin and public settings', () => {
    const homepageKeys = [
      'home_hero_title',
      'home_hero_subtitle',
      'home_featured_region_slugs',
      'home_hot_tag_limit',
    ]

    for (const key of homepageKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })

  it('allows rules entry settings in admin and public settings', () => {
    const rulesKeys = [
      'rules_entry_enabled',
      'rules_entry_title',
      'rules_entry_summary',
      'rules_entry_icon',
      'rules_modal_content',
      'rules_page_title',
      'rules_page_summary',
      'rules_page_content',
      'rules_page_url',
    ]

    for (const key of rulesKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/utils/site-settings.test.ts`

Expected: FAIL，about key 仍存在且 rules key 不存在。

- [ ] **Step 4: 更新站点设置 key**

Modify `packages/api/src/utils/site-settings.ts`:

```ts
export const ADMIN_SETTING_KEYS = [
  'site_name', 'seo_title', 'site_description', 'site_icon',
  'og_title', 'og_description', 'og_image',
  'footer_text', 'membership_description', 'email_verification_enabled',
  'video_enabled',
  'home_hero_title', 'home_hero_subtitle',
  'home_featured_region_slugs', 'home_hot_tag_limit',
  'rules_entry_enabled', 'rules_entry_title', 'rules_entry_summary',
  'rules_entry_icon', 'rules_modal_content', 'rules_page_title',
  'rules_page_summary', 'rules_page_content', 'rules_page_url',
] as const

export const PUBLIC_SETTING_KEYS = [
  'site_name', 'seo_title', 'site_description', 'site_icon',
  'og_title', 'og_description', 'og_image',
  'footer_text', 'membership_description', 'email_verification_enabled',
  'video_enabled',
  'home_hero_title', 'home_hero_subtitle',
  'home_featured_region_slugs', 'home_hot_tag_limit',
  'rules_entry_enabled', 'rules_entry_title', 'rules_entry_summary',
  'rules_entry_icon', 'rules_modal_content', 'rules_page_title',
  'rules_page_summary', 'rules_page_content', 'rules_page_url',
] as const
```

- [ ] **Step 5: 编写真案例工具测试**

Create `packages/api/src/utils/testimonial-cases.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  assertPublishableImageCount,
  getPublicImageUrl,
  getPublicOrderClause,
  isAllowedImageType,
  isValidSlug,
  normalizeSortOrder,
} from './testimonial-cases'

describe('真实案例工具', () => {
  it('slug 只允许小写字母、数字和短横线', () => {
    expect(isValidSlug('member-feedback-001')).toBe(true)
    expect(isValidSlug('MemberFeedback')).toBe(false)
    expect(isValidSlug('bad_slug')).toBe(false)
  })

  it('发布要求 2 到 9 张图片', () => {
    expect(() => assertPublishableImageCount(1)).toThrow('真实案例发布需要 2-9 张图片')
    expect(() => assertPublishableImageCount(2)).not.toThrow()
    expect(() => assertPublishableImageCount(9)).not.toThrow()
    expect(() => assertPublishableImageCount(10)).toThrow('真实案例发布需要 2-9 张图片')
  })

  it('图片类型使用白名单', () => {
    expect(isAllowedImageType('image/jpeg')).toBe(true)
    expect(isAllowedImageType('image/png')).toBe(true)
    expect(isAllowedImageType('image/webp')).toBe(true)
    expect(isAllowedImageType('image/gif')).toBe(false)
  })

  it('排序值归一化为非负整数', () => {
    expect(normalizeSortOrder(-1)).toBe(0)
    expect(normalizeSortOrder(3.8)).toBe(3)
    expect(normalizeSortOrder(Number.NaN)).toBe(0)
  })

  it('公开排序使用白名单', () => {
    expect(getPublicOrderClause('sort')).toBe(' ORDER BY tc.sort_order ASC, tc.published_at DESC')
    expect(getPublicOrderClause('newest')).toBe(' ORDER BY tc.published_at DESC, tc.sort_order ASC')
    expect(getPublicOrderClause('bad')).toBe(' ORDER BY tc.sort_order ASC, tc.published_at DESC')
  })

  it('公开图片 URL 不包含 R2 key', () => {
    expect(getPublicImageUrl('tci_123')).toBe('/api/testimonial-cases/images/tci_123')
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/utils/testimonial-cases.test.ts`

Expected: FAIL，提示 `testimonial-cases` 模块不存在。

- [ ] **Step 7: 实现真实案例工具**

Create `packages/api/src/utils/testimonial-cases.ts`:

```ts
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export function isValidSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

export function assertPublishableImageCount(count: number): void {
  if (count < 2 || count > 9) {
    throw new Error('真实案例发布需要 2-9 张图片')
  }
}

export function isAllowedImageType(type: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)
}

export function normalizeSortOrder(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0
}

export function getPublicOrderClause(sort: string): string {
  switch (sort) {
    case 'newest':
      return ' ORDER BY tc.published_at DESC, tc.sort_order ASC'
    case 'sort':
    default:
      return ' ORDER BY tc.sort_order ASC, tc.published_at DESC'
  }
}

export function getPublicImageUrl(imageId: string): string {
  return `/api/testimonial-cases/images/${imageId}`
}

export function getR2Extension(fileName: string, mimeType: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp') return ext
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @meigallery/api test -- src/utils/site-settings.test.ts src/utils/testimonial-cases.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add packages/api/migrations/0014_testimonial_cases.sql packages/api/src/utils/site-settings.ts packages/api/src/utils/site-settings.test.ts packages/api/src/utils/testimonial-cases.ts packages/api/src/utils/testimonial-cases.test.ts
git commit -m "feat: 新增真实案例数据模型"
```

---

### Task 2: 公开真实案例 API 与图片代理

**Files:**
- Create: `packages/api/src/routes/testimonial-cases.ts`
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: 创建公开路由文件**

Create `packages/api/src/routes/testimonial-cases.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { cacheControl } from '../middleware/cache'
import { getPublicImageUrl, getPublicOrderClause } from '../utils/testimonial-cases'

export const testimonialCaseRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

testimonialCaseRoutes.get('/', cacheControl(120), async (c) => {
  const db = c.env.DB
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query('pageSize') || '12', 10)))
  const featuredOnly = c.req.query('featured') === 'true'
  const offset = (page - 1) * pageSize
  const params: unknown[] = ['published']
  let whereClause = ' WHERE tc.status = ?'

  if (featuredOnly) {
    whereClause += ' AND tc.featured = 1'
  }

  const totalRow = await db
    .prepare(`SELECT COUNT(*) as total FROM testimonial_cases tc${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()

  const rows = await db
    .prepare(`
      SELECT tc.id, tc.title, tc.slug, tc.summary, tc.published_at,
             COUNT(tci.id) as image_count,
             first_image.id as cover_image_id
      FROM testimonial_cases tc
      LEFT JOIN testimonial_case_images tci ON tci.case_id = tc.id
      LEFT JOIN testimonial_case_images first_image ON first_image.id = (
        SELECT id FROM testimonial_case_images
        WHERE case_id = tc.id
        ORDER BY sort_order ASC, created_at ASC
        LIMIT 1
      )
      ${whereClause}
      GROUP BY tc.id
      ${getPublicOrderClause(c.req.query('sort') || 'sort')}
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all<{
      id: string
      title: string
      slug: string
      summary: string | null
      published_at: string | null
      image_count: number
      cover_image_id: string | null
    }>()

  return c.json({
    data: rows.results.map(row => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      imageCount: row.image_count,
      coverImageUrl: row.cover_image_id ? getPublicImageUrl(row.cover_image_id) : null,
      publishedAt: row.published_at,
    })),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  })
})

testimonialCaseRoutes.get('/images/:imageId', cacheControl(86400), async (c) => {
  const imageId = c.req.param('imageId')
  const row = await c.env.DB
    .prepare(`
      SELECT tci.r2_key, tci.mime_type
      FROM testimonial_case_images tci
      JOIN testimonial_cases tc ON tc.id = tci.case_id
      WHERE tci.id = ? AND tc.status = 'published'
    `)
    .bind(imageId)
    .first<{ r2_key: string; mime_type: string }>()

  if (!row) return c.json({ statusCode: 404, message: '图片不存在' }, 404)

  const object = await c.env.R2.get(row.r2_key)
  if (!object) return c.json({ statusCode: 404, message: '图片文件不存在' }, 404)

  c.header('Content-Type', row.mime_type)
  c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  return c.body(object.body)
})

testimonialCaseRoutes.get('/:slug', cacheControl(120), async (c) => {
  const slug = c.req.param('slug')
  const db = c.env.DB
  const row = await db
    .prepare(`
      SELECT id, title, slug, summary, body_md, seo_title, seo_description, published_at
      FROM testimonial_cases
      WHERE slug = ? AND status = 'published'
    `)
    .bind(slug)
    .first<{
      id: string
      title: string
      slug: string
      summary: string | null
      body_md: string | null
      seo_title: string | null
      seo_description: string | null
      published_at: string | null
    }>()

  if (!row) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)

  const images = await db
    .prepare(`
      SELECT id, alt_text, sort_order
      FROM testimonial_case_images
      WHERE case_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `)
    .bind(row.id)
    .all<{ id: string; alt_text: string | null; sort_order: number }>()

  return c.json({
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    bodyMd: row.body_md,
    seoTitle: row.seo_title || row.title,
    seoDescription: row.seo_description || row.summary || row.title,
    publishedAt: row.published_at,
    images: images.results.map((image, index) => ({
      id: image.id,
      url: getPublicImageUrl(image.id),
      alt: image.alt_text || `${row.title} ${index + 1}`,
      sortOrder: image.sort_order,
    })),
  })
})
```

- [ ] **Step 2: 挂载公开路由和 dev noindex header**

Modify `packages/api/src/index.ts` imports and middleware:

```ts
import { testimonialCaseRoutes } from './routes/testimonial-cases'
```

Add after secure headers middleware:

```ts
app.use('*', async (c, next) => {
  await next()
  if (c.env.APP_ENV !== 'production') {
    c.header('X-Robots-Tag', 'noindex, nofollow')
  }
})
```

Mount before admin routes:

```ts
app.route('/api/testimonial-cases', testimonialCaseRoutes)
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/api/src/routes/testimonial-cases.ts packages/api/src/index.ts
git commit -m "feat: 新增真实案例公开接口"
```

---

### Task 3: 后台真实案例 API

**Files:**
- Create: `packages/api/src/routes/admin/testimonial-cases.ts`
- Modify: `packages/api/src/routes/admin/index.ts`

- [ ] **Step 1: 创建后台路由基础结构**

Create `packages/api/src/routes/admin/testimonial-cases.ts` with imports and route setup:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import {
  assertPublishableImageCount,
  getR2Extension,
  isAllowedImageType,
  isValidSlug,
  normalizeSortOrder,
} from '../../utils/testimonial-cases'

export const adminTestimonialCaseRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminTestimonialCaseRoutes.use('*', requireAdmin)

type CaseBody = {
  title?: string
  slug?: string
  summary?: string
  bodyMd?: string
  status?: 'draft' | 'published'
  featured?: boolean
  sortOrder?: number
  seoTitle?: string
  seoDescription?: string
}

function validateCaseBody(body: CaseBody): string | null {
  if (!body.title || body.title.trim().length > 80) return '标题为必填且不能超过 80 字'
  if (!body.slug || !isValidSlug(body.slug)) return 'slug 只能包含小写字母、数字和短横线'
  if (body.summary && body.summary.length > 160) return '摘要不能超过 160 字'
  if (body.bodyMd && body.bodyMd.length > 5000) return '正文不能超过 5000 字'
  if (body.status && !['draft', 'published'].includes(body.status)) return '状态不合法'
  return null
}
```

- [ ] **Step 2: 实现列表接口**

Append to `packages/api/src/routes/admin/testimonial-cases.ts`:

```ts
adminTestimonialCaseRoutes.get('/', async (c) => {
  const db = c.env.DB
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query('pageSize') || '20', 10)))
  const status = c.req.query('status')
  const offset = (page - 1) * pageSize
  const params: unknown[] = []
  let whereClause = ''

  if (status === 'draft' || status === 'published') {
    whereClause = ' WHERE tc.status = ?'
    params.push(status)
  }

  const total = await db
    .prepare(`SELECT COUNT(*) as total FROM testimonial_cases tc${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()

  const rows = await db
    .prepare(`
      SELECT tc.id, tc.title, tc.slug, tc.status, tc.featured, tc.sort_order,
             tc.published_at, tc.updated_at, COUNT(tci.id) as image_count
      FROM testimonial_cases tc
      LEFT JOIN testimonial_case_images tci ON tci.case_id = tc.id
      ${whereClause}
      GROUP BY tc.id
      ORDER BY tc.sort_order ASC, tc.updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all<{ id: string; title: string; slug: string; status: string; featured: number; sort_order: number; published_at: string | null; updated_at: string; image_count: number }>()

  return c.json({
    data: rows.results.map(row => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      featured: Boolean(row.featured),
      sortOrder: row.sort_order,
      imageCount: row.image_count,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    })),
    total: total?.total ?? 0,
    page,
    pageSize,
  })
})
```

Expected empty response when no published cases exist:

```json
{
  "data": [],
  "total": 0,
  "page": 1,
  "pageSize": 12
}
```

The endpoint must keep HTTP 200 for an empty list so the homepage and `/testimonials` can render empty states.

- [ ] **Step 3: 实现创建与编辑接口**

Append create and patch handlers:

```ts
adminTestimonialCaseRoutes.post('/', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const body = await c.req.json<CaseBody>()
  const error = validateCaseBody(body)
  if (error) return c.json({ statusCode: 400, message: error }, 400)

  const id = generateId('tc')
  const status = body.status || 'draft'
  const publishedAt = status === 'published' ? new Date().toISOString() : null

  if (status === 'published') {
    return c.json({ statusCode: 400, message: '新建案例需先保存草稿并上传 2-9 张图片后再发布' }, 400)
  }

  await db.prepare(`
    INSERT INTO testimonial_cases
      (id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description, created_by, updated_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.title!.trim(),
    body.slug!.trim(),
    body.summary?.trim() || null,
    body.bodyMd?.trim() || null,
    status,
    body.featured === false ? 0 : 1,
    normalizeSortOrder(body.sortOrder),
    body.seoTitle?.trim() || null,
    body.seoDescription?.trim() || null,
    adminId,
    adminId,
    publishedAt,
  ).run()

  await writeAuditLog(db, {
    adminId,
    action: 'create_testimonial_case',
    targetType: 'testimonial_case',
    targetId: id,
    afterValue: { title: body.title, slug: body.slug, status },
  })

  return c.json({ id, message: '真实案例已创建' }, 201)
})

adminTestimonialCaseRoutes.patch('/:id', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const id = c.req.param('id')
  const body = await c.req.json<CaseBody>()
  const error = validateCaseBody(body)
  if (error) return c.json({ statusCode: 400, message: error }, 400)

  const before = await db.prepare('SELECT * FROM testimonial_cases WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!before) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)

  if (body.status === 'published') {
    const imageCount = await db
      .prepare('SELECT COUNT(*) as count FROM testimonial_case_images WHERE case_id = ?')
      .bind(id)
      .first<{ count: number }>()
    try {
      assertPublishableImageCount(imageCount?.count ?? 0)
    } catch (e) {
      return c.json({ statusCode: 400, message: e instanceof Error ? e.message : '图片数量不合法' }, 400)
    }
  }

  const publishedAt = body.status === 'published' && !before.published_at ? new Date().toISOString() : before.published_at
  await db.prepare(`
    UPDATE testimonial_cases
    SET title = ?, slug = ?, summary = ?, body_md = ?, status = ?, featured = ?, sort_order = ?,
        seo_title = ?, seo_description = ?, updated_by = ?, published_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    body.title!.trim(),
    body.slug!.trim(),
    body.summary?.trim() || null,
    body.bodyMd?.trim() || null,
    body.status || 'draft',
    body.featured === false ? 0 : 1,
    normalizeSortOrder(body.sortOrder),
    body.seoTitle?.trim() || null,
    body.seoDescription?.trim() || null,
    adminId,
    publishedAt,
    id,
  ).run()

  await writeAuditLog(db, {
    adminId,
    action: 'update_testimonial_case',
    targetType: 'testimonial_case',
    targetId: id,
    beforeValue: before,
    afterValue: body,
  })

  return c.json({ message: '真实案例已更新' })
})
```

- [ ] **Step 4: 实现图片上传、排序和删除**

Append image handlers:

```ts
adminTestimonialCaseRoutes.post('/:id/images', async (c) => {
  const db = c.env.DB
  const r2 = c.env.R2
  const adminId = c.get('userId')!
  const caseId = c.req.param('id')
  const formData = await c.req.formData()
  const files = formData.getAll('files') as unknown as File[]

  const caseRow = await db.prepare('SELECT id FROM testimonial_cases WHERE id = ?').bind(caseId).first<{ id: string }>()
  if (!caseRow) return c.json({ statusCode: 404, message: '真实案例不存在' }, 404)
  if (files.length === 0) return c.json({ statusCode: 400, message: '请选择至少一张图片' }, 400)

  const current = await db.prepare('SELECT COUNT(*) as count FROM testimonial_case_images WHERE case_id = ?').bind(caseId).first<{ count: number }>()
  if ((current?.count ?? 0) + files.length > 9) {
    return c.json({ statusCode: 400, message: '每个真实案例最多 9 张图片' }, 400)
  }

  const maxOrder = await db.prepare('SELECT MAX(sort_order) as max_order FROM testimonial_case_images WHERE case_id = ?').bind(caseId).first<{ max_order: number | null }>()
  let nextOrder = (maxOrder?.max_order ?? -1) + 1
  const uploaded: Array<{ id: string; url: string; sortOrder: number }> = []

  for (const file of files) {
    if (!isAllowedImageType(file.type)) return c.json({ statusCode: 400, message: `不支持的文件格式: ${file.type}` }, 400)
    if (file.size > 10 * 1024 * 1024) return c.json({ statusCode: 400, message: '单张图片最大 10MB' }, 400)

    const imageId = generateId('tci')
    const ext = getR2Extension(file.name, file.type)
    const r2Key = `testimonials/${caseId}/${imageId}.${ext}`
    await r2.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
    await db.prepare(`
      INSERT INTO testimonial_case_images (id, case_id, r2_key, alt_text, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(imageId, caseId, r2Key, file.name, file.type, file.size, nextOrder).run()
    uploaded.push({ id: imageId, url: `/api/testimonial-cases/images/${imageId}`, sortOrder: nextOrder })
    nextOrder += 1
  }

  await writeAuditLog(db, {
    adminId,
    action: 'upload_testimonial_images',
    targetType: 'testimonial_case',
    targetId: caseId,
    afterValue: { uploadedCount: uploaded.length },
  })

  return c.json({ uploaded }, 201)
})

adminTestimonialCaseRoutes.patch('/:id/images/order', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const caseId = c.req.param('id')
  const body = await c.req.json<{ imageIds: string[] }>()
  if (!Array.isArray(body.imageIds)) return c.json({ statusCode: 400, message: 'imageIds 为必填数组' }, 400)

  for (const [index, imageId] of body.imageIds.entries()) {
    await db.prepare('UPDATE testimonial_case_images SET sort_order = ? WHERE id = ? AND case_id = ?').bind(index, imageId, caseId).run()
  }

  await writeAuditLog(db, {
    adminId,
    action: 'sort_testimonial_images',
    targetType: 'testimonial_case',
    targetId: caseId,
    afterValue: { imageIds: body.imageIds },
  })

  return c.json({ message: '图片排序已保存' })
})

adminTestimonialCaseRoutes.delete('/:id/images/:imageId', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const caseId = c.req.param('id')
  const imageId = c.req.param('imageId')
  const image = await db.prepare('SELECT r2_key FROM testimonial_case_images WHERE id = ? AND case_id = ?').bind(imageId, caseId).first<{ r2_key: string }>()
  if (!image) return c.json({ statusCode: 404, message: '图片不存在' }, 404)

  await c.env.R2.delete(image.r2_key)
  await db.prepare('DELETE FROM testimonial_case_images WHERE id = ? AND case_id = ?').bind(imageId, caseId).run()
  await writeAuditLog(db, {
    adminId,
    action: 'delete_testimonial_image',
    targetType: 'testimonial_case',
    targetId: caseId,
    beforeValue: { imageId, r2Key: image.r2_key },
  })

  return c.json({ message: '图片已删除' })
})
```

- [ ] **Step 5: 挂载后台路由**

Modify `packages/api/src/routes/admin/index.ts`:

```ts
import { adminTestimonialCaseRoutes } from './testimonial-cases'
```

Add route:

```ts
adminRoutes.route('/testimonial-cases', adminTestimonialCaseRoutes)
```

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/api/src/routes/admin/testimonial-cases.ts packages/api/src/routes/admin/index.ts
git commit -m "feat: 新增真实案例后台接口"
```

---

### Task 4: 规则设置、Markdown 工具与全局环境标识

**Files:**
- Create: `packages/web/app/utils/safeMarkdown.ts`
- Modify: `packages/web/app/composables/useSiteSettings.ts`
- Modify: `packages/web/app/app.vue`
- Modify: `packages/web/app/layouts/default.vue`
- Modify: `packages/web/app/components/ContactPanel.vue`
- Create: `packages/web/app/pages/rules.vue`

- [ ] **Step 1: 创建安全 Markdown 工具**

Create `packages/web/app/utils/safeMarkdown.ts`:

```ts
export function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderInlineMarkdown(input: string) {
  return escapeHtml(input)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

export function renderSafeMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listOpen = false

  function closeList() {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    if (line.startsWith('### ')) {
      closeList()
      html.push(`<h3>${renderInlineMarkdown(line.slice(4))}</h3>`)
      continue
    }
    if (line.startsWith('## ')) {
      closeList()
      html.push(`<h2>${renderInlineMarkdown(line.slice(3))}</h2>`)
      continue
    }
    if (line.startsWith('# ')) {
      closeList()
      html.push(`<h2>${renderInlineMarkdown(line.slice(2))}</h2>`)
      continue
    }
    if (line.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${renderInlineMarkdown(line)}</p>`)
  }
  closeList()
  return html.join('\n')
}
```

- [ ] **Step 2: 更新站点设置 composable**

Modify `packages/web/app/composables/useSiteSettings.ts` interface and computed values:

```ts
rules_entry_enabled?: string | boolean
rules_entry_title?: string
rules_entry_summary?: string
rules_entry_icon?: string
rules_modal_content?: string
rules_page_title?: string
rules_page_summary?: string
rules_page_content?: string
rules_page_url?: string
```

Remove `about_title`、`about_summary`、`about_content` from the interface and returned computed values.

Add computed values:

```ts
const rulesEntryEnabled = computed(() => {
  const value = settings.value.rules_entry_enabled
  return value === true || value === 'true'
})
const rulesEntryTitle = computed(() => settings.value.rules_entry_title || '入站规则')
const rulesEntrySummary = computed(() => settings.value.rules_entry_summary || '查看内容规则、会员说明和联系前须知。')
const rulesEntryIcon = computed(() => settings.value.rules_entry_icon || 'letter')
const rulesModalContent = computed(() => settings.value.rules_modal_content || '')
const rulesPageTitle = computed(() => settings.value.rules_page_title || '入站规则')
const rulesPageSummary = computed(() => settings.value.rules_page_summary || '')
const rulesPageContent = computed(() => settings.value.rules_page_content || rulesModalContent.value)
const rulesPageUrl = computed(() => settings.value.rules_page_url || '/rules')
```

Return the new computed values.

- [ ] **Step 3: 增加 dev noindex meta**

Modify `packages/web/app/app.vue`:

```ts
const config = useRuntimeConfig()
const isDevEnvironment = computed(() => config.public.appEnv !== 'production')
```

Extend `useHead()` result:

```ts
meta: isDevEnvironment.value
  ? [{ name: 'robots', content: 'noindex, nofollow' }]
  : [],
```

- [ ] **Step 4: 移除关于导航并增加 dev 角标**

Modify `packages/web/app/layouts/default.vue`:

```ts
const config = useRuntimeConfig()
const isDevEnvironment = computed(() => config.public.appEnv !== 'production')
```

Change nav links to remove about:

```ts
const links = [
  { label: '首页', to: '/' },
  { label: '发现', to: '/discover' },
  { label: '标签', to: '/tags' },
]
```

Add near root template:

```vue
<div v-if="isDevEnvironment" class="fixed right-3 top-16 z-[60] rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 shadow-sm lg:top-20">
  DEV 测试环境
</div>
```

- [ ] **Step 5: 改造 ContactPanel 为双入口**

Modify `packages/web/app/components/ContactPanel.vue` script:

```ts
import { renderSafeMarkdown } from '~/utils/safeMarkdown'

const {
  rulesEntryEnabled,
  rulesEntryTitle,
  rulesEntrySummary,
  rulesModalContent,
  rulesPageUrl,
} = useSiteSettings()

const contactOpen = ref(false)
const rulesOpen = ref(false)
const renderedRules = computed(() => renderSafeMarkdown(rulesModalContent.value))
```

Rename existing contact `open` usage to `contactOpen` and add a rules button above it:

```vue
<button
  v-if="rulesEntryEnabled"
  type="button"
  class="mb-2 flex h-12 w-12 items-center justify-center rounded-full border border-[#f0e4d8] bg-[#fffbf7] text-gray-900 shadow-[0_14px_34px_rgba(17,24,39,0.12)] transition-all hover:-translate-y-0.5 hover:border-[#d6c39a]"
  aria-label="打开入站规则"
  @click="rulesOpen = true"
>
  <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" />
    <path stroke-linecap="round" d="M8 9h8M8 13h8M8 17h5" />
  </svg>
</button>
```

Add rules modal:

```vue
<div v-if="rulesOpen" class="mb-3 w-[min(calc(100vw-2rem),23rem)] rounded-[1.75rem] border border-white/80 bg-[#fffbf7] p-5 shadow-[0_28px_80px_rgba(17,24,39,0.16)] ring-1 ring-[#f8e7dc]/80">
  <div class="flex items-start justify-between gap-4">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">Guide Note</p>
      <h2 class="mt-1.5 text-lg font-semibold tracking-tight text-gray-950">{{ rulesEntryTitle }}</h2>
      <p class="mt-1.5 text-xs leading-5 text-gray-500">{{ rulesEntrySummary }}</p>
    </div>
    <button type="button" class="rounded-full bg-white/70 p-2 text-gray-400" aria-label="关闭入站规则" @click="rulesOpen = false">×</button>
  </div>
  <article class="rules-content mt-4 text-sm leading-6 text-gray-600" v-html="renderedRules" />
  <NuxtLink :to="rulesPageUrl" class="mt-4 inline-flex rounded-full bg-gray-950 px-4 py-2 text-xs font-medium text-white">查看完整规则</NuxtLink>
</div>
```

Change contact trigger to icon style with unread dot:

```vue
<button type="button" class="group relative flex h-14 w-14 items-center justify-center rounded-full bg-gray-950 text-white shadow-[0_18px_48px_rgba(17,24,39,0.28)] transition-all hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-[#d6c39a] focus:ring-offset-2" :aria-expanded="contactOpen" aria-label="打开联系方式" @click="contactOpen = !contactOpen">
  <span class="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
  <svg class="h-6 w-6 motion-safe:animate-[message-nudge_4.5s_ease-in-out_infinite]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
  </svg>
</button>
```

- [ ] **Step 6: 新增规则页**

Create `packages/web/app/pages/rules.vue`:

```vue
<script setup lang="ts">
import { renderSafeMarkdown } from '~/utils/safeMarkdown'

const { rulesPageTitle, rulesPageSummary, rulesPageContent, siteName } = useSiteSettings()
const renderedContent = computed(() => renderSafeMarkdown(rulesPageContent.value))

useHead(() => ({
  title: `${rulesPageTitle.value} - ${siteName.value}`,
  meta: [
    { name: 'description', content: rulesPageSummary.value || rulesPageTitle.value },
  ],
}))
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10 lg:px-8 lg:py-16">
    <section class="relative overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] px-6 py-10 shadow-2xl shadow-orange-950/8 lg:px-12 lg:py-14">
      <p class="text-xs font-medium uppercase tracking-[0.22em] text-[#bfa46a]">Site Guide</p>
      <h1 class="mt-4 text-3xl font-semibold tracking-tight text-gray-950 lg:text-5xl">{{ rulesPageTitle }}</h1>
      <p v-if="rulesPageSummary" class="mt-5 max-w-2xl text-sm leading-7 text-gray-600 lg:text-base">{{ rulesPageSummary }}</p>
    </section>
    <article class="rules-content mt-8 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 px-6 py-8 shadow-sm shadow-orange-950/5 lg:px-10 lg:py-10" v-html="renderedContent" />
  </div>
</template>
```

- [ ] **Step 7: 构建检查**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/web/app/utils/safeMarkdown.ts packages/web/app/composables/useSiteSettings.ts packages/web/app/app.vue packages/web/app/layouts/default.vue packages/web/app/components/ContactPanel.vue packages/web/app/pages/rules.vue
git commit -m "feat: 新增规则入口和测试环境标识"
```

---

### Task 5: 首页 Hero、标签导航、真实案例轮播和有限内容流

**Files:**
- Modify: `packages/web/app/components/HomeEditorialHero.vue`
- Create: `packages/web/app/components/HomeTagNavigator.vue`
- Create: `packages/web/app/components/TestimonialCarousel.vue`
- Modify: `packages/web/app/pages/index.vue`

- [ ] **Step 1: 移除 Hero 双按钮**

Modify `packages/web/app/components/HomeEditorialHero.vue` props:

```ts
const props = defineProps<{
  title: string
  subtitle: string
  galleries: HeroGallery[]
}>()
```

Remove `safeCtaUrl` computed and replace the CTA block with no buttons. Keep title, subtitle, active gallery link, preview thumbnails and carousel controls.

- [ ] **Step 2: 新增首页标签导航组件**

Create `packages/web/app/components/HomeTagNavigator.vue`:

```vue
<script setup lang="ts">
type TagItem = { id: string; name: string; slug: string; type: string }

defineProps<{
  cities: TagItem[]
  regions: TagItem[]
  styles: TagItem[]
}>()

const groups = computed(() => [
  { key: 'cities', title: '热门城市', description: '直接进入城市内容', items: cities },
  { key: 'regions', title: '地区组', description: '按国家和地区浏览', items: regions },
  { key: 'styles', title: '风格偏好', description: '按气质、场景和风格筛选', items: styles },
].filter(group => group.items.length > 0))
</script>

<template>
  <section class="rounded-[2rem] border border-[#f0e4d8] bg-[#fffbf7]/80 p-4 shadow-sm shadow-orange-950/5 lg:p-6">
    <div class="flex items-end justify-between gap-4">
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Tag Navigation</p>
        <h2 class="mt-2 text-2xl font-semibold tracking-tight text-gray-950">按城市与风格快速发现</h2>
      </div>
      <NuxtLink to="/tags" class="hidden text-sm font-medium text-gray-500 underline decoration-[#d6c39a] underline-offset-4 hover:text-gray-950 sm:inline-flex">全部标签</NuxtLink>
    </div>

    <div class="mt-5 grid gap-3 lg:grid-cols-3">
      <div v-for="group in groups" :key="group.key" class="rounded-[1.5rem] border border-white/80 bg-white/88 p-4">
        <h3 class="text-sm font-semibold text-gray-950">{{ group.title }}</h3>
        <p class="mt-1 text-xs text-gray-500">{{ group.description }}</p>
        <div class="mt-4 flex gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible">
          <NuxtLink
            v-for="tag in group.items"
            :key="tag.slug"
            :to="{ path: '/discover', query: { tag: tag.slug } }"
            class="shrink-0 rounded-full border border-[#f0e4d8] bg-[#fffbf7] px-3 py-2 text-sm text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:bg-gray-950 hover:text-white"
          >
            {{ tag.name }}
          </NuxtLink>
        </div>
      </div>
    </div>
  </section>
</template>
```

- [ ] **Step 3: 新增真实案例轮播组件**

Create `packages/web/app/components/TestimonialCarousel.vue`:

```vue
<script setup lang="ts">
interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

defineProps<{ cases: TestimonialSummary[] }>()
</script>

<template>
  <section class="overflow-hidden rounded-[2rem] border border-[#f0e4d8] bg-white p-4 shadow-xl shadow-orange-950/6 lg:p-6">
    <EditorialSectionHeading eyebrow="Testimonials" title="真实案例" description="展示已授权、已脱敏的用户反馈与站点体验案例。" action-label="查看全部案例" action-to="/testimonials" />
    <div v-if="cases.length" class="mt-5 flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory lg:grid lg:grid-cols-3 lg:overflow-visible">
      <NuxtLink
        v-for="item in cases"
        :key="item.id"
        :to="`/testimonials/${item.slug}`"
        class="group min-w-[78vw] snap-start overflow-hidden rounded-[1.5rem] border border-[#f0e4d8] bg-[#fffbf7] shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-orange-950/10 sm:min-w-[22rem] lg:min-w-0"
      >
        <div class="aspect-[4/3] overflow-hidden bg-orange-50">
          <img v-if="item.coverImageUrl" :src="item.coverImageUrl" :alt="item.title" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
        </div>
        <div class="p-4">
          <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">{{ item.imageCount }} 张图片</p>
          <h3 class="mt-2 line-clamp-2 text-lg font-semibold tracking-tight text-gray-950">{{ item.title }}</h3>
          <p v-if="item.summary" class="mt-2 line-clamp-2 text-sm leading-6 text-gray-500">{{ item.summary }}</p>
        </div>
      </NuxtLink>
    </div>
    <div v-else class="mt-5 rounded-[1.5rem] border border-orange-100 bg-[#fffbf7] px-5 py-10 text-center">
      <h3 class="text-lg font-semibold tracking-tight text-gray-950">真实案例整理中</h3>
      <p class="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">我们正在整理已授权、已脱敏的用户反馈。你可以先浏览最新图库，或联系站长了解会员规则。</p>
      <NuxtLink to="/discover" class="mt-5 inline-flex rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-gray-800">浏览最新图库</NuxtLink>
    </div>
  </section>
</template>
```

- [ ] **Step 4: 重构首页数据和模板**

Modify `packages/web/app/pages/index.vue`:

Remove imports and state for `collectRegionGuideItems`、`loadMore()`、`sentinel`、`IntersectionObserver`。

Add testimonial fetch:

```ts
interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

const { data: testimonialsData } = await useAsyncData('home-testimonials', () =>
  api<{ data: TestimonialSummary[] }>('/api/testimonial-cases', { query: { featured: 'true', pageSize: '6' } }),
)
```

Add tag grouping computed:

```ts
function flattenTags(types: string[], limit: number) {
  if (!tagsData.value?.data) return []
  const result: Array<{ id: string; name: string; slug: string; type: string }> = []
  for (const type of types) {
    for (const item of tagsData.value.data[type] || []) {
      result.push({ ...item, type })
      if (result.length >= limit) return result
    }
  }
  return result
}

const cityTags = computed(() => flattenTags(['city', 'city_country'], 8))
const regionTags = computed(() => flattenTags(['region_scope', 'region_group'], 8))
const styleTags = computed(() => flattenTags(['style', 'personality', 'scene'], homeHotTagLimit.value))
const testimonials = computed(() => testimonialsData.value?.data ?? [])
```

Change hero usage:

```vue
<HomeEditorialHero
  :title="homeHeroTitle"
  :subtitle="homeHeroSubtitle"
  :galleries="heroGalleries"
/>
```

Replace region guide section:

```vue
<section class="mt-6 lg:mt-8">
  <HomeTagNavigator :cities="cityTags" :regions="regionTags" :styles="styleTags" />
</section>

<section class="mt-8 lg:mt-10">
  <TestimonialCarousel :cases="testimonials" />
</section>
```

Replace latest infinite bottom:

```vue
<GalleryGrid :galleries="latest.slice(0, 12)" variant="magazine" />
<div class="mt-6 text-center">
  <NuxtLink to="/discover" class="inline-flex rounded-full bg-gray-950 px-5 py-3 text-sm font-medium text-white shadow-sm shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-gray-800">
    查看更多图库
  </NuxtLink>
</div>
```

- [ ] **Step 5: 构建检查**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web/app/components/HomeEditorialHero.vue packages/web/app/components/HomeTagNavigator.vue packages/web/app/components/TestimonialCarousel.vue packages/web/app/pages/index.vue
git commit -m "feat: 重构首页标签导航和真实案例"
```

---

### Task 6: 真实案例公开列表页和详情页

**Files:**
- Create: `packages/web/app/components/TestimonialCard.vue`
- Create: `packages/web/app/components/TestimonialGallery.vue`
- Create: `packages/web/app/pages/testimonials/index.vue`
- Create: `packages/web/app/pages/testimonials/[slug].vue`

- [ ] **Step 1: 创建案例卡片组件**

Create `packages/web/app/components/TestimonialCard.vue`:

```vue
<script setup lang="ts">
defineProps<{
  item: {
    id: string
    title: string
    slug: string
    summary: string | null
    imageCount: number
    coverImageUrl: string | null
    publishedAt: string | null
  }
}>()
</script>

<template>
  <NuxtLink :to="`/testimonials/${item.slug}`" class="group block overflow-hidden rounded-[1.5rem] border border-[#f0e4d8] bg-white shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-orange-950/10">
    <div class="aspect-[4/3] overflow-hidden bg-orange-50">
      <img v-if="item.coverImageUrl" :src="item.coverImageUrl" :alt="item.title" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
    </div>
    <div class="p-4">
      <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">{{ item.imageCount }} 张图片</p>
      <h2 class="mt-2 line-clamp-2 text-lg font-semibold tracking-tight text-gray-950">{{ item.title }}</h2>
      <p v-if="item.summary" class="mt-2 line-clamp-2 text-sm leading-6 text-gray-500">{{ item.summary }}</p>
    </div>
  </NuxtLink>
</template>
```

- [ ] **Step 2: 创建图片组组件**

Create `packages/web/app/components/TestimonialGallery.vue`:

```vue
<script setup lang="ts">
defineProps<{
  images: Array<{ id: string; url: string; alt: string; sortOrder: number }>
}>()

const viewerOpen = ref(false)
const activeIndex = ref(0)

function openViewer(index: number) {
  activeIndex.value = index
  viewerOpen.value = true
}
</script>

<template>
  <div>
    <div class="grid gap-3 sm:grid-cols-2">
      <button v-for="(image, index) in images" :key="image.id" type="button" class="group overflow-hidden rounded-[1.5rem] bg-orange-50 text-left" @click="openViewer(index)">
        <img :src="image.url" :alt="image.alt" class="aspect-[4/3] h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" :loading="index === 0 ? 'eager' : 'lazy'" />
      </button>
    </div>
    <ImageViewer v-if="viewerOpen" :images="images.map(image => ({ url: image.url, alt: image.alt }))" :initial-index="activeIndex" @close="viewerOpen = false" />
  </div>
</template>
```

- [ ] **Step 3: 创建列表页**

Create `packages/web/app/pages/testimonials/index.vue`:

```vue
<script setup lang="ts">
const { api } = useApi()

interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

const { data } = await useAsyncData('testimonial-list', () =>
  api<{ data: TestimonialSummary[]; total: number }>('/api/testimonial-cases', { query: { pageSize: '12' } }),
)

useSeoMeta({
  title: '真实案例 - MeiGallery',
  description: '查看已授权、已脱敏的用户反馈和真实案例。',
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 pb-24 lg:px-6 lg:py-12">
    <section class="rounded-[2rem] border border-white/80 bg-[#fffbf7] px-6 py-10 shadow-2xl shadow-orange-950/8 lg:px-10">
      <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">Testimonials</p>
      <h1 class="mt-3 text-3xl font-semibold tracking-tight text-gray-950 lg:text-5xl">真实案例</h1>
      <p class="mt-4 max-w-2xl text-sm leading-7 text-gray-600">这里展示经过授权和脱敏的用户反馈，用更真实的案例帮助你了解站点内容与服务方式。</p>
    </section>
    <div v-if="data?.data.length" class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <TestimonialCard v-for="item in data.data" :key="item.id" :item="item" />
    </div>
    <div v-else class="mt-8 rounded-[1.5rem] border border-orange-100 bg-white px-5 py-16 text-center">
      <h2 class="text-xl font-semibold tracking-tight text-gray-950">真实案例整理中</h2>
      <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-gray-500">当前暂无公开案例，后续会展示经过授权和脱敏的用户反馈。</p>
      <div class="mt-6 flex flex-wrap justify-center gap-3">
        <NuxtLink to="/" class="rounded-full border border-[#f0e4d8] bg-white px-5 py-2.5 text-sm text-gray-700">返回首页</NuxtLink>
        <NuxtLink to="/discover" class="rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-white">浏览图库</NuxtLink>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 创建详情页**

Create `packages/web/app/pages/testimonials/[slug].vue`:

```vue
<script setup lang="ts">
import { renderSafeMarkdown } from '~/utils/safeMarkdown'

const route = useRoute()
const { api } = useApi()

interface TestimonialDetail {
  id: string
  title: string
  slug: string
  summary: string | null
  bodyMd: string | null
  seoTitle: string
  seoDescription: string
  publishedAt: string | null
  images: Array<{ id: string; url: string; alt: string; sortOrder: number }>
}

const { data, error } = await useAsyncData(`testimonial-${route.params.slug}`, () =>
  api<TestimonialDetail>(`/api/testimonial-cases/${route.params.slug}`),
)

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: '真实案例不存在或暂未公开' })
}

const renderedContent = computed(() => renderSafeMarkdown(data.value?.bodyMd || ''))

useSeoMeta({
  title: () => data.value?.seoTitle || '真实案例',
  description: () => data.value?.seoDescription || data.value?.summary || '真实案例',
})
</script>

<template>
  <div v-if="data" class="mx-auto max-w-7xl px-4 py-8 pb-24 lg:px-6 lg:py-12">
    <NuxtLink to="/testimonials" class="text-sm text-gray-500 underline decoration-[#d6c39a] underline-offset-4 hover:text-gray-950">返回真实案例</NuxtLink>
    <div class="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <TestimonialGallery :images="data.images" />
      <aside class="rounded-[1.75rem] border border-[#f0e4d8] bg-[#fffbf7] p-6 shadow-sm shadow-orange-950/5">
        <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">Case Note</p>
        <h1 class="mt-3 text-3xl font-semibold tracking-tight text-gray-950">{{ data.title }}</h1>
        <p v-if="data.summary" class="mt-4 text-sm leading-7 text-gray-600">{{ data.summary }}</p>
        <article v-if="data.bodyMd" class="rules-content mt-5 text-sm leading-7 text-gray-600" v-html="renderedContent" />
        <div class="mt-6 flex flex-wrap gap-3">
          <NuxtLink to="/testimonials" class="rounded-full border border-[#f0e4d8] bg-white px-4 py-2 text-sm text-gray-700">更多案例</NuxtLink>
          <NuxtLink to="/discover" class="rounded-full bg-gray-950 px-4 py-2 text-sm text-white">查看更多图库</NuxtLink>
        </div>
      </aside>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 构建检查**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web/app/components/TestimonialCard.vue packages/web/app/components/TestimonialGallery.vue packages/web/app/pages/testimonials/index.vue packages/web/app/pages/testimonials/[slug].vue
git commit -m "feat: 新增真实案例公开页面"
```

---

### Task 7: 后台真实案例页面与站点设置页

**Files:**
- Modify: `packages/web/app/layouts/admin.vue`
- Modify: `packages/web/app/pages/admin/settings.vue`
- Create: `packages/web/app/pages/admin/testimonials/index.vue`
- Create: `packages/web/app/pages/admin/testimonials/new.vue`
- Create: `packages/web/app/pages/admin/testimonials/[id].vue`

- [ ] **Step 1: 增加后台导航**

Modify `packages/web/app/layouts/admin.vue` nav items:

```ts
{ to: '/admin/testimonials', label: '真实案例', icon: 'message' },
```

- [ ] **Step 2: 更新站点设置页字段**

Modify `packages/web/app/pages/admin/settings.vue` form:

Remove:

```ts
about_title: '',
about_summary: '',
about_content: '',
home_hero_cta_label: '',
home_hero_cta_url: '',
```

Add:

```ts
rules_entry_title: '',
rules_entry_summary: '',
rules_entry_icon: 'letter',
rules_modal_content: '',
rules_page_title: '',
rules_page_summary: '',
rules_page_content: '',
rules_page_url: '/rules',
```

Remove the “关于我们页面” fieldset and add a “规则与引导” fieldset with matching inputs and textareas. The `rules_modal_content` and `rules_page_content` textareas use `font-mono leading-6` and explain supported Markdown: 标题、列表、加粗、链接。

- [ ] **Step 3: 创建后台列表页**

Create `packages/web/app/pages/admin/testimonials/index.vue`:

```vue
<script setup lang="ts">
definePageMeta({ layout: 'admin' })
const { api } = useApi()
const { data, refresh } = await useAsyncData('admin-testimonials', () =>
  api<{ data: Array<{ id: string; title: string; slug: string; status: string; featured: boolean; sortOrder: number; imageCount: number; updatedAt: string }> }>('/api/admin/testimonial-cases'),
)
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">真实案例</h1>
      <NuxtLink to="/admin/testimonials/new" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">新建案例</NuxtLink>
    </div>
    <div class="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div v-if="!data?.data.length" class="px-6 py-12 text-center">
        <h2 class="text-base font-semibold text-gray-900">还没有真实案例</h2>
        <p class="mt-2 text-sm text-gray-500">发布前需上传 2-9 张已授权、已脱敏图片。</p>
        <NuxtLink to="/admin/testimonials/new" class="mt-5 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">新建案例</NuxtLink>
      </div>
      <table v-else class="min-w-full divide-y divide-gray-200 text-sm">
        <thead class="bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
          <tr><th class="px-4 py-3">标题</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">图片</th><th class="px-4 py-3">排序</th><th class="px-4 py-3">操作</th></tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="item in data?.data || []" :key="item.id">
            <td class="px-4 py-3"><div class="font-medium text-gray-900">{{ item.title }}</div><div class="text-xs text-gray-400">/{{ item.slug }}</div></td>
            <td class="px-4 py-3">{{ item.status === 'published' ? '已发布' : '草稿' }}</td>
            <td class="px-4 py-3">{{ item.imageCount }} 张</td>
            <td class="px-4 py-3">{{ item.sortOrder }}</td>
            <td class="px-4 py-3"><NuxtLink :to="`/admin/testimonials/${item.id}`" class="text-blue-600 hover:underline">编辑</NuxtLink></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 创建新建页**

Create `packages/web/app/pages/admin/testimonials/new.vue` with a form that posts to `/api/admin/testimonial-cases`. Required fields: title, slug, summary, bodyMd, featured, sortOrder, seoTitle, seoDescription. On success navigate to `/admin/testimonials/${id}`.

Use this submit handler:

```ts
async function onSubmit() {
  loading.value = true
  message.value = ''
  try {
    const result = await api<{ id: string }>('/api/admin/testimonial-cases', { method: 'POST', body: form })
    await navigateTo(`/admin/testimonials/${result.id}`)
  } catch (e: any) {
    message.value = e?.data?.message || '创建失败'
  } finally {
    loading.value = false
  }
}
```

- [ ] **Step 5: 创建编辑页**

Create `packages/web/app/pages/admin/testimonials/[id].vue` with:
- Same fields as new page.
- Image upload input `<input type="file" multiple accept="image/jpeg,image/png,image/webp">`.
- Image list showing current images from admin detail response.
- Save button calls `PATCH /api/admin/testimonial-cases/:id`.
- Upload button calls `POST /api/admin/testimonial-cases/:id/images` with `FormData`.
- Publish requires 2-9 images; show warning if image count is outside range.

- [ ] **Step 6: 构建检查**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/web/app/layouts/admin.vue packages/web/app/pages/admin/settings.vue packages/web/app/pages/admin/testimonials/index.vue packages/web/app/pages/admin/testimonials/new.vue packages/web/app/pages/admin/testimonials/[id].vue
git commit -m "feat: 新增真实案例后台管理"
```

---

### Task 8: 删除关于页面与补齐 dev Wrangler 配置

**Files:**
- Delete: `packages/web/app/pages/about.vue`
- Modify: `packages/api/wrangler.toml`
- Modify: `packages/web/wrangler.toml`

- [ ] **Step 1: 删除关于页面**

Delete `packages/web/app/pages/about.vue` because the product scope moves this content to `/rules` and the global rules modal.

- [ ] **Step 2: 配置 API dev Worker**

Append to `packages/api/wrangler.toml`:

```toml
[env.dev]
name = "meigallery-api-dev"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[[env.dev.d1_databases]]
binding = "DB"
database_name = "meigallery-db"
database_id = "714929cb-003b-4cb1-bd9f-545fa1895e8c"
migrations_dir = "migrations"

[[env.dev.r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media"

[[env.dev.send_email]]
name = "EMAIL"

[env.dev.triggers]
crons = []

[env.dev.vars]
APP_ENV = "dev"
CORS_ORIGIN = "*"
EMAIL_FROM = "noreply@616618.xyz"
IMAGE_RESIZING_ENABLED = "false"
```

- [ ] **Step 3: 配置 Web dev Worker**

Append to `packages/web/wrangler.toml`:

```toml
[env.dev]
name = "meigallery-web-dev"
main = ".output/server/index.mjs"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[env.dev.assets]
directory = ".output/public"

[[env.dev.services]]
binding = "API_SERVICE"
service = "meigallery-api-dev"

[env.dev.vars]
NUXT_PUBLIC_APP_ENV = "dev"
NUXT_PUBLIC_TURNSTILE_SITE_KEY = "0x4AAAAAADGbuWKJvOkDMRWU"
```

After Task 9 Step 5 outputs the actual `meigallery-api-dev` workers.dev URL, add that exact URL to `[env.dev.vars]` as `NUXT_PUBLIC_API_BASE_URL` before deploying Web dev. Do not add custom production routes to `[env.dev]`.

- [ ] **Step 4: 构建和类型检查**

Run:

```bash
pnpm --filter @meigallery/api exec tsc --noEmit
pnpm --filter @meigallery/web exec nuxt build
```

Expected: both PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/web/app/pages/about.vue packages/api/wrangler.toml packages/web/wrangler.toml
git commit -m "chore: 配置真实案例开发环境"
```

---

### Task 9: 回归验证与 Workers dev 验收

**Files:**
- No code changes unless verification exposes defects.

- [ ] **Step 1: 运行 API 测试**

Run: `pnpm --filter @meigallery/api test`

Expected: PASS，所有 Vitest 测试通过。

- [ ] **Step 2: 运行 API 类型检查**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS。

- [ ] **Step 3: 运行 Web 构建**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS；允许非阻断 sourcemap warning。

- [ ] **Step 4: 应用远端 D1 migration 到 dev Worker 使用的数据库**

Run: `pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote --env dev`

Expected: migration `0014_testimonial_cases.sql` applied 或显示已应用。

- [ ] **Step 5: 部署 dev API Worker**

Run: `pnpm --filter @meigallery/api exec wrangler deploy --env dev`

Expected: deploy success，输出 `meigallery-api-dev` workers.dev URL。

- [ ] **Step 6: 部署 dev Web Worker**

Run: `pnpm --filter @meigallery/web exec wrangler deploy --env dev`

Expected: deploy success，输出 `meigallery-web-dev` workers.dev URL。

- [ ] **Step 7: 手动验收首页**

Open Web dev URL and verify:
- 显示 `DEV 测试环境` 角标。
- 首页 Hero 没有“浏览精选图库”和“地区精选”两个按钮。
- 首页出现标签导航，城市/地区入口明显。
- 首页出现真实案例区；无数据时显示“真实案例整理中”、说明文案和 `浏览最新图库` 入口，不显示假案例或外部占位图片。
- 最新图库底部是“查看更多图库”，不是无限加载。

- [ ] **Step 8: 手动验收规则和联系入口**

Verify:
- 右下角规则入口在联系入口上方。
- 点击规则入口打开弹窗，内容来自后台设置。
- 点击“查看完整规则”进入 `/rules`。
- 联系入口是消息 icon 样式，有未读红点，不遮挡底部 Tab Bar。

- [ ] **Step 9: 手动验收后台真实案例**

Verify as admin/owner:
- `/admin/testimonials` 可以打开。
- 无真实案例时显示“还没有真实案例”、`新建案例` 主按钮和 2-9 张授权脱敏图片提示。
- 可以创建草稿案例。
- 可以上传 2-9 张图片。
- 少于 2 张图片时发布失败并提示。
- 发布后 `/testimonials` 和 `/testimonials/:slug` 可公开访问。
- 审计日志记录创建、更新、上传、删除操作。

- [ ] **Step 10: 提交验证修复**

If verification required fixes, return to the task that introduced the defect, apply the smallest fix, run that task's verification command again, and commit the exact files changed by that fix with `fix: 修复真实案例验收问题`. If no fixes were needed, do not create an empty commit.

---

## 自检记录

Spec coverage:
- 首页 Hero 双按钮移除：Task 5。
- 标签导航重构：Task 5。
- 真实案例首页轮播、列表页、详情页：Task 2、Task 5、Task 6。
- 真实案例空数据前台/API/后台策略：Task 2、Task 5、Task 6、Task 7、Task 9。
- 后台真实案例维护和 R2 图片上传：Task 3、Task 7。
- 规则入口、弹窗和规则页：Task 1、Task 4、Task 7。
- 关于页和后台关于配置移除：Task 1、Task 7、Task 8。
- 首页无限加载移除：Task 5。
- Dev 子域隔离、noindex 和 DEV 标识：Task 4、Task 8、Task 9。
- 审计日志：Task 3。
- 构建和测试验证：Task 1、Task 2、Task 3、Task 4、Task 5、Task 6、Task 7、Task 8、Task 9。

Residual risks:
- 前端仍缺少自动化 E2E 测试，首期依赖 dev Worker 手动验收。
- dev Worker 连接正式 D1/R2 时，后台写操作会影响正式数据；需要使用测试案例标题和审计日志识别。
- `NUXT_PUBLIC_API_BASE_URL` 的 Workers dev 子域需要部署前替换为账户实际子域。
