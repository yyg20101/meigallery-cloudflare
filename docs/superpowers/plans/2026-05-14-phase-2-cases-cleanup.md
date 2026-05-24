# Phase 2 Cases Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Phase 2 性能降本，并把真实案例业务从 `testimonial(s)` 彻底迁移为 `case(s)`，包括 API、前端、导入、D1 表和 R2 前缀。

**Architecture:** 先改业务命名和测试，让应用只读写 `cases` / `case_images`；再增加 D1 切表迁移和 R2 一次性迁移脚本；最后做首页请求收敛、随机排序移除、公开统计降本和 Cloudflare Images Free Transformations 优先路径。破坏性生产执行顺序固定为 `R2 dry-run -> R2 复制 -> D1 迁移 -> R2 删除旧前缀`。

**Tech Stack:** pnpm monorepo、Hono Workers API、Nuxt 3 Workers Web、Cloudflare D1、Cloudflare R2、Cloudflare Images Transformations、Vitest、Wrangler。

---

## 文件结构

- Create: `packages/api/migrations/0017_cases_cleanup.sql`，负责创建 `cases` / `case_images`、复制旧表数据、重建 `external_import_records` 以更新 CHECK 约束、删除旧 `testimonial_*` 表。
- Create: `scripts/migrate-cases-r2.mjs`，使用 Wrangler CLI 执行 R2 对象复制、校验和旧前缀删除，支持 dry-run。
- Move: `packages/api/src/routes/testimonial-cases.ts` -> `packages/api/src/routes/cases.ts`，公开案例 API。
- Move: `packages/api/src/routes/testimonial-cases.test.ts` -> `packages/api/src/routes/cases.test.ts`，公开案例 API 测试。
- Move: `packages/api/src/routes/admin/testimonial-cases.ts` -> `packages/api/src/routes/admin/cases.ts`，后台案例 API。
- Move: `packages/api/src/routes/admin/testimonial-cases.test.ts` -> `packages/api/src/routes/admin/cases.test.ts`，后台案例 API 测试。
- Move: `packages/api/src/utils/testimonial-cases.ts` -> `packages/api/src/utils/cases.ts`，案例校验和 URL 工具。
- Move: `packages/api/src/utils/testimonial-cases.test.ts` -> `packages/api/src/utils/cases.test.ts`。
- Modify: `packages/api/src/index.ts`，挂载 `/api/cases`，删除 `/api/testimonial-cases`。
- Modify: `packages/api/src/routes/admin/index.ts`，挂载 `/api/admin/cases`，删除 `/api/admin/testimonial-cases`。
- Modify: `packages/api/src/utils/import-validation.ts`、`packages/api/src/utils/import-token.ts`、`packages/api/src/services/telegram-file-id-import.ts`、`packages/api/src/routes/imports.test.ts`，导入类型和权限改为 `case` / `case:create`。
- Modify: `packages/api/src/routes/galleries.ts`、`packages/api/src/routes/search.ts`、`packages/api/src/utils/gallery-interactions.ts`，移除 `ORDER BY RANDOM()` 并优化公开统计。
- Modify: `packages/api/src/routes/media.ts`，首期只允许 `w=480` transformation，失败回退原图。
- Move: `packages/web/app/components/TestimonialCard.vue` -> `packages/web/app/components/CaseCard.vue`。
- Move: `packages/web/app/components/TestimonialCarousel.vue` -> `packages/web/app/components/CaseCarousel.vue`。
- Move: `packages/web/app/components/TestimonialGallery.vue` -> `packages/web/app/components/CaseGallery.vue`。
- Modify: `packages/web/app/pages/index.vue`，移除首页真实案例双请求，首页业务 API 请求降到最多 2 个。
- Move: `packages/web/app/pages/admin/testimonials/**` -> `packages/web/app/pages/admin/cases/**`。
- Modify: `packages/web/app/pages/cases/index.vue`、`packages/web/app/pages/cases/[slug].vue`，改用 `/api/cases`。
- Delete: `packages/web/app/pages/testimonials/index.vue`、`packages/web/app/pages/testimonials/[slug].vue`。
- Modify: `docs/TECHNICAL_SPEC.md`、`.env.example`，同步 API、导入权限和 Images Free Transformations 策略。

---

### Task 1: API Cases 命名迁移

**Files:**
- Move: `packages/api/src/utils/testimonial-cases.ts` -> `packages/api/src/utils/cases.ts`
- Move: `packages/api/src/routes/testimonial-cases.ts` -> `packages/api/src/routes/cases.ts`
- Move: `packages/api/src/routes/admin/testimonial-cases.ts` -> `packages/api/src/routes/admin/cases.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Test: moved `*.test.ts` files

- [ ] **Step 1: 先写失败测试，锁定旧 API 被删除、新 API 可用**

在 `packages/api/src/routes/cases.test.ts` 中把公开路由测试改为只访问 `/api/cases`，新增断言旧路径 404：

```ts
it('不再暴露旧 testimonial-cases API', async () => {
  const response = await app.fetch(new Request('http://localhost/api/testimonial-cases'), env)
  expect(response.status).toBe(404)
})

it('通过 /api/cases 返回公开案例列表', async () => {
  const response = await app.fetch(new Request('http://localhost/api/cases?pageSize=12'), env)
  expect(response.status).toBe(200)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/routes/cases.test.ts`

Expected: FAIL，原因是 `cases.test.ts` 或 `/api/cases` 尚未存在。

- [ ] **Step 3: 移动文件并替换路由命名**

执行非交互移动后，替换公开路由核心内容为以下命名模式：

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { cacheControl } from '../middleware/cache'
import { getPublicImageUrl, getPublicOrderClause } from '../utils/cases'

export const caseRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

caseRoutes.get('/', cacheControl(120), async (c) => {
  const db = c.env.DB
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query('pageSize') || '12', 10)))
  const featuredOnly = c.req.query('featured') === 'true'
  const offset = (page - 1) * pageSize
  const params: unknown[] = ['published']
  let whereClause = ' WHERE c.status = ?'

  if (featuredOnly) whereClause += ' AND c.featured = 1'

  const totalRow = await db.prepare(`SELECT COUNT(*) as total FROM cases c${whereClause}`).bind(...params).first<{ total: number }>()
  const rows = await db.prepare(`
    SELECT c.id, c.title, c.slug, c.summary, c.published_at,
           COUNT(ci.id) as image_count,
           first_image.id as cover_image_id
    FROM cases c
    LEFT JOIN case_images ci ON ci.case_id = c.id
    LEFT JOIN case_images first_image ON first_image.id = (
      SELECT id FROM case_images
      WHERE case_id = c.id
      ORDER BY sort_order ASC, created_at ASC
      LIMIT 1
    )
    ${whereClause}
    GROUP BY c.id
    ${getPublicOrderClause(c.req.query('sort') || 'sort')}
    LIMIT ? OFFSET ?
  `).bind(...params, pageSize, offset).all<{ id: string; title: string; slug: string; summary: string | null; published_at: string | null; image_count: number; cover_image_id: string | null }>()

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
```

- [ ] **Step 4: 更新 Hono 挂载点**

在 `packages/api/src/index.ts`：

```ts
import { caseRoutes } from './routes/cases'

app.route('/api/cases', caseRoutes)
```

删除：

```ts
import { testimonialCaseRoutes } from './routes/testimonial-cases'
app.route('/api/testimonial-cases', testimonialCaseRoutes)
```

在 `packages/api/src/routes/admin/index.ts`：

```ts
import { adminCaseRoutes } from './cases'

adminRoutes.route('/cases', adminCaseRoutes)
```

删除旧 `adminTestimonialCaseRoutes` 挂载。

- [ ] **Step 5: 更新 utils URL**

在 `packages/api/src/utils/cases.ts`：

```ts
export function getPublicImageUrl(imageId: string): string {
  return `/api/cases/images/${imageId}`
}
```

并把 SQL 排序别名从 `tc` 改为 `c`：

```ts
export function getPublicOrderClause(sort: string): string {
  switch (sort) {
    case 'newest':
      return ' ORDER BY c.published_at DESC, c.sort_order ASC'
    case 'sort':
    default:
      return ' ORDER BY c.sort_order ASC, c.published_at DESC'
  }
}
```

- [ ] **Step 6: 运行 API cases 测试**

Run: `pnpm --filter @meigallery/api test -- src/routes/cases.test.ts src/routes/admin/cases.test.ts src/utils/cases.test.ts`

Expected: PASS。

---

### Task 2: D1 Cases 切表迁移

**Files:**
- Create: `packages/api/migrations/0017_cases_cleanup.sql`

- [ ] **Step 1: 写迁移 SQL**

创建 `packages/api/migrations/0017_cases_cleanup.sql`：

```sql
-- Cases 命名清理：testimonial_* -> cases / case_images
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS cases (
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

CREATE TABLE IF NOT EXISTS case_images (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt_text TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO cases
SELECT id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description,
       created_by, updated_by, published_at, created_at, updated_at
FROM testimonial_cases;

INSERT OR IGNORE INTO case_images
SELECT id, case_id, replace(r2_key, 'testimonials/', 'cases/'), alt_text, mime_type, file_size,
       width, height, sort_order, created_at
FROM testimonial_case_images;

CREATE INDEX IF NOT EXISTS idx_cases_public ON cases(status, featured, sort_order, published_at);
CREATE INDEX IF NOT EXISTS idx_case_images_case ON case_images(case_id, sort_order);

CREATE TABLE external_import_records_new (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES import_api_tokens(id),
  source_bot_key TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  media_group_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_media_fetch',
  metadata_json TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT,
  error_json TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (source IN ('telegram')),
  CHECK (target_type IN ('gallery', 'case')),
  CHECK (status IN ('pending_media_fetch', 'fetching_media', 'draft_created', 'partial_failed', 'failed')),
  UNIQUE (token_id, source, external_message_id)
);

INSERT INTO external_import_records_new
SELECT id, source, external_message_id, token_id, source_bot_key, source_chat_id, source_message_id,
       media_group_id,
       CASE target_type WHEN 'testimonial_case' THEN 'case' ELSE target_type END,
       target_id, status,
       replace(metadata_json, '"type":"testimonial_case"', '"type":"case"'),
       file_count, fetched_count, failed_count, retry_count, last_retry_at, error_json,
       request_ip, user_agent, created_at, completed_at
FROM external_import_records;

DROP TABLE external_import_records;
ALTER TABLE external_import_records_new RENAME TO external_import_records;

CREATE INDEX IF NOT EXISTS idx_external_import_records_token ON external_import_records(token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_status ON external_import_records(status, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_target ON external_import_records(target_type, target_id);

UPDATE admin_audit_logs
SET action = replace(replace(action, 'testimonial_case', 'case'), 'testimonial', 'case'),
    target_type = replace(replace(target_type, 'testimonial_case', 'case'), 'testimonial', 'case')
WHERE action LIKE '%testimonial%' OR target_type LIKE '%testimonial%';

DROP TABLE testimonial_case_images;
DROP TABLE testimonial_cases;

PRAGMA foreign_keys = ON;
```

- [ ] **Step 2: 本地迁移验证**

Run: `pnpm --filter @meigallery/api db:migrate:local`

Expected: PASS，`0017_cases_cleanup.sql` 成功应用。

- [ ] **Step 3: 用 D1 查询验证表存在和旧表删除**

Run: `pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cases','case_images','testimonial_cases','testimonial_case_images');"`

Expected: 只返回 `cases` 和 `case_images`。

---

### Task 3: R2 Cases 对象迁移脚本

**Files:**
- Create: `scripts/migrate-cases-r2.mjs`
- Modify: `docs/DEPLOYMENT.md`

- [ ] **Step 1: 创建脚本**

创建 `scripts/migrate-cases-r2.mjs`：

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const remote = args.has('--remote')
const deleteOld = args.has('--delete-old')
const bucket = process.env.R2_BUCKET || 'meigallery-media'
const database = process.env.D1_DATABASE || 'meigallery-db'

function run(commandArgs) {
  return execFileSync('pnpm', ['--filter', '@meigallery/api', 'exec', 'wrangler', ...commandArgs], { encoding: 'utf8' })
}

function d1(command) {
  const flags = remote ? ['--remote'] : ['--local']
  const output = run(['d1', 'execute', database, ...flags, '--json', '--command', command])
  return JSON.parse(output)[0]?.results ?? []
}

const rows = d1("SELECT id, r2_key FROM testimonial_case_images WHERE r2_key LIKE 'testimonials/%' ORDER BY case_id, sort_order")
const mappings = rows.map(row => ({ id: row.id, oldKey: row.r2_key, newKey: row.r2_key.replace(/^testimonials\//, 'cases/') }))

console.log(JSON.stringify({ dryRun, remote, bucket, count: mappings.length }, null, 2))

if (dryRun) {
  for (const mapping of mappings) console.log(`${mapping.oldKey} -> ${mapping.newKey}`)
  process.exit(0)
}

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-cases-r2-'))
try {
  for (const mapping of mappings) {
    const tempFile = join(tempDir, mapping.id)
    run(['r2', 'object', 'get', `${bucket}/${mapping.oldKey}`, '--file', tempFile])
    run(['r2', 'object', 'put', `${bucket}/${mapping.newKey}`, '--file', tempFile])
    console.log(`copied ${mapping.oldKey} -> ${mapping.newKey}`)
  }

  if (deleteOld) {
    for (const mapping of mappings) {
      run(['r2', 'object', 'delete', `${bucket}/${mapping.oldKey}`])
      console.log(`deleted ${mapping.oldKey}`)
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
```

- [ ] **Step 2: dry-run 验证**

Run: `node scripts/migrate-cases-r2.mjs --dry-run --remote`

Expected: 输出 `testimonials/... -> cases/...` 映射，不修改 R2。

- [ ] **Step 3: 复制对象，不删除旧对象**

Run: `node scripts/migrate-cases-r2.mjs --remote`

Expected: 每个对象输出 `copied testimonials/... -> cases/...`。

- [ ] **Step 4: D1 migration 后删除旧对象**

Run: `node scripts/migrate-cases-r2.mjs --remote --delete-old`

Expected: 每个旧对象输出 `deleted testimonials/...`。只在 D1 迁移和 smoke 通过后执行。

---

### Task 4: Telegram 导入改为 case

**Files:**
- Modify: `packages/api/src/utils/import-validation.ts`
- Modify: `packages/api/src/utils/import-token.ts`
- Modify: `packages/api/src/services/telegram-file-id-import.ts`
- Test: `packages/api/src/utils/import-validation.test.ts`
- Test: `packages/api/src/services/telegram-file-id-import.test.ts`
- Test: `packages/api/src/routes/imports.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/api/src/utils/import-validation.test.ts` 增加：

```ts
it('接受 case 导入类型并映射 case:create 权限', () => {
  const payload = validPayload({ metadata: { type: 'case' }, files: twoImageFiles() })
  expect(validateTelegramImportPayload(payload).metadata.type).toBe('case')
  expect(importPermissionForType('case')).toBe('case:create')
})

it('拒绝旧 testimonial_case 导入类型', () => {
  const payload = validPayload({ metadata: { type: 'testimonial_case' }, files: twoImageFiles() })
  expect(() => validateTelegramImportPayload(payload)).toThrow('metadata.type 必须是 gallery 或 case')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts`

Expected: FAIL，旧类型仍为 `testimonial_case`。

- [ ] **Step 3: 修改类型和权限**

在 `packages/api/src/utils/import-validation.ts`：

```ts
export type TelegramImportType = 'gallery' | 'case'

if (!['gallery', 'case'].includes(metadata.type)) fail('metadata.type 必须是 gallery 或 case')
if (metadata.type === 'case' && (body.files.length < 2 || body.files.length > 9)) fail('案例导入需要 2-9 张图片')

export function importPermissionForType(type: TelegramImportType): ImportPermission {
  return type === 'gallery' ? 'gallery:create' : 'case:create'
}
```

在 `packages/api/src/utils/import-token.ts`：

```ts
export type ImportPermission = 'gallery:create' | 'case:create'
```

- [ ] **Step 4: 修改导入服务写入 cases 表和 cases/ R2 前缀**

在 `packages/api/src/services/telegram-file-id-import.ts` 中把分支改为：

```ts
const r2Key = record.target_type === 'gallery'
  ? `originals/${targetId}/${targetFileId}.${extension}`
  : `cases/${targetId}/${targetFileId}.${extension}`

if (record.target_type === 'gallery') await createImportedGallery(db, targetId, metadata, fetchedFiles)
else await createImportedCase(db, targetId, metadata, fetchedFiles)
```

`createImportedCase` 写入：

```ts
const existing = await db.prepare('SELECT id FROM cases WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
if (existing) throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '案例 slug 已存在', 409)

await db.prepare(`
  INSERT INTO cases (id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description, created_by, updated_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, 1, ?, ?)
`).bind(targetId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, metadata.featured ? 1 : 0, metadata.sortOrder ?? 0, metadata.seoTitle ?? null, metadata.seoDescription ?? null, now, now).run()
```

- [ ] **Step 5: 运行导入测试**

Run: `pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts src/services/telegram-file-id-import.test.ts src/routes/imports.test.ts`

Expected: PASS。

---

### Task 5: Web Cases 命名迁移并删除 testimonials 路由

**Files:**
- Move: `packages/web/app/components/TestimonialCard.vue` -> `packages/web/app/components/CaseCard.vue`
- Move: `packages/web/app/components/TestimonialCarousel.vue` -> `packages/web/app/components/CaseCarousel.vue`
- Move: `packages/web/app/components/TestimonialGallery.vue` -> `packages/web/app/components/CaseGallery.vue`
- Modify: `packages/web/app/pages/cases/index.vue`
- Modify: `packages/web/app/pages/cases/[slug].vue`
- Move: `packages/web/app/pages/admin/testimonials/index.vue` -> `packages/web/app/pages/admin/cases/index.vue`
- Move: `packages/web/app/pages/admin/testimonials/new.vue` -> `packages/web/app/pages/admin/cases/new.vue`
- Move: `packages/web/app/pages/admin/testimonials/[id].vue` -> `packages/web/app/pages/admin/cases/[id].vue`
- Delete: `packages/web/app/pages/testimonials/index.vue`
- Delete: `packages/web/app/pages/testimonials/[slug].vue`

- [ ] **Step 1: 修改公开 cases 页面 API**

在 `packages/web/app/pages/cases/index.vue`：

```ts
const { data } = await useAsyncData('cases-list', () =>
  api<{ data: CaseSummary[]; total: number }>('/api/cases', { query: { pageSize: '12' } }),
)
```

模板改用：

```vue
<CaseCard v-for="item in cases" :key="item.id" :item="item" />
```

在 `packages/web/app/pages/cases/[slug].vue`：

```ts
const { data: item, error } = await useAsyncData(`case-${route.params.slug}`, () =>
  api<CaseDetail>(`/api/cases/${route.params.slug}`),
)
```

模板改用：

```vue
<CaseGallery :images="galleryImages" />
```

- [ ] **Step 2: 修改后台页面 API 和跳转**

后台页面统一改为：

```ts
api('/api/admin/cases')
await navigateTo(`/admin/cases/${result.id}`)
```

编辑页 PATCH 和图片接口统一改为：

```ts
await api(`/api/admin/cases/${route.params.id}`, { method: 'PATCH', body: form })
await api(`/api/admin/cases/${route.params.id}/images`, { method: 'POST', body })
await api(`/api/admin/cases/${route.params.id}/images/order`, { method: 'PATCH', body: { imageIds: images.map(image => image.id) } })
await api(`/api/admin/cases/${route.params.id}/images/${imageId}`, { method: 'DELETE' })
```

- [ ] **Step 3: 删除旧 testimonials 路由文件**

删除：

```text
packages/web/app/pages/testimonials/index.vue
packages/web/app/pages/testimonials/[slug].vue
```

- [ ] **Step 4: 运行 Web 构建**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS；允许既有 sourcemap warning。

---

### Task 6: 首页请求收敛与随机排序移除

**Files:**
- Modify: `packages/web/app/pages/index.vue`
- Modify: `packages/web/app/pages/discover.vue`
- Modify: `packages/api/src/utils/gallery-interactions.ts`
- Modify: `packages/api/src/routes/search.ts`
- Test: `packages/api/src/utils/gallery-interactions.test.ts`
- Test: `packages/api/src/routes/search.test.ts` if present

- [ ] **Step 1: 写排序测试**

在 `packages/api/src/utils/gallery-interactions.test.ts`：

```ts
it('random 排序降级为最新排序，避免 ORDER BY RANDOM()', () => {
  expect(getPublicGalleryOrderClause('random')).toBe(' ORDER BY g.published_at DESC')
  expect(getPublicGalleryOrderClause('random')).not.toContain('RANDOM()')
})
```

- [ ] **Step 2: 修改排序工具**

在 `packages/api/src/utils/gallery-interactions.ts`：

```ts
case 'random':
  return ' ORDER BY g.published_at DESC'
```

在 `packages/api/src/routes/search.ts`：

```ts
case 'random':
  orderClause = 'ORDER BY g.published_at DESC'
  break
```

- [ ] **Step 3: 删除 discover 随机入口**

在 `packages/web/app/pages/discover.vue`：

```ts
const sortBy = ref<'latest' | 'hot'>('latest')
sortBy.value = (['latest', 'hot'].includes(String(q.sort)) ? String(q.sort) : 'latest') as typeof sortBy.value
function setSort(val: 'latest' | 'hot') {
  sortBy.value = val
  updateQuery()
}
const sortOptions = [
  { value: 'latest' as const, label: '最新' },
  { value: 'hot' as const, label: '最热' },
]
```

- [ ] **Step 4: 首页移除真实案例请求**

在 `packages/web/app/pages/index.vue` 删除 `TestimonialSummary`、`home-testimonials`、`home-testimonials-fallback` 和 `<TestimonialCarousel />` 区块。保留图库请求最多两个：

```ts
const { data: galleriesData } = await useAsyncData('home-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: String(PAGE_SIZE) } }),
)

const { data: hotGalleriesData } = await useAsyncData('home-hot-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: '9', sort: 'hot' } }),
)
```

- [ ] **Step 5: 验证**

Run: `pnpm --filter @meigallery/api test -- src/utils/gallery-interactions.test.ts`

Expected: PASS。

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS；允许既有 sourcemap warning。

---

### Task 7: 公开统计查询降本

**Files:**
- Modify: `packages/api/src/routes/galleries.ts`
- Modify: `packages/api/src/routes/search.ts`
- Modify: `packages/web/app/pages/discover.vue`

- [ ] **Step 1: 修改 API 返回 hasMore**

在 `/api/galleries` 查询中取 `pageSize + 1` 条，复杂筛选时跳过精确总数：

```ts
const fetchLimit = pageSize + 1
dataQuery += whereClause + orderClause + ' LIMIT ? OFFSET ?'
const galleries = await db.prepare(dataQuery).bind(...params, fetchLimit, offset).all<GalleryRow>()
const hasMore = galleries.results.length > pageSize
const pageRows = galleries.results.slice(0, pageSize)
```

普通无标签无搜索时保留简单总数：

```ts
const shouldCount = tagSlugs.length === 0 && !search
const total = shouldCount
  ? (await db.prepare("SELECT COUNT(*) as total FROM galleries WHERE status = 'published'").first<{ total: number }>())?.total ?? 0
  : offset + pageRows.length + (hasMore ? 1 : 0)
```

返回：

```ts
return c.json({ data, total, page, pageSize, hasMore })
```

- [ ] **Step 2: 前端 discover 使用 hasMore**

在 `packages/web/app/pages/discover.vue` 类型改为：

```ts
type GalleryListResponse = { data: GallerySummary[]; total: number; hasMore?: boolean }
```

状态改为：

```ts
const hasMoreFromApi = ref(false)
const hasMore = computed(() => hasMoreFromApi.value || galleries.value.length < total.value)
```

首次和加载更多都设置：

```ts
hasMoreFromApi.value = Boolean(val.hasMore)
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS。

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

---

### Task 8: Cloudflare Images Free Transformations 优先路径

**Files:**
- Modify: `packages/api/src/routes/media.ts`
- Test: `packages/api/src/routes/media.test.ts`
- Modify: `.env.example`
- Modify: `docs/DEPLOYMENT.md`

- [ ] **Step 1: 写 fallback 测试**

在 `packages/api/src/routes/media.test.ts` 增加：

```ts
it('Images transformation 失败时回退原图', async () => {
  const env = createEnv({ IMAGE_RESIZING_ENABLED: 'true' })
  globalThis.fetch = vi.fn(async () => new Response('quota exceeded', { status: 9422 })) as typeof fetch
  const response = await app.fetch(new Request('http://localhost/api/media/asset_1/thumbnail?w=800'), env)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toContain('max-age=604800')
})
```

- [ ] **Step 2: 限制首期宽度为 480**

在 `packages/api/src/routes/media.ts`：

```ts
const requestedWidth = Number.parseInt(c.req.query('w') || '480', 10)
const width = requestedWidth === 480 ? 480 : 480
```

Transformation 参数：

```ts
cf: {
  image: {
    width,
    fit: 'scale-down' as const,
    quality: 80,
    format: 'webp' as const,
  },
},
```

失败 fallback 保持：

```ts
if (!resized.ok) {
  const object = await c.env.R2.get(asset.r2_key)
  if (!object) return c.json({ statusCode: 404, message: '文件不存在' }, 404)
  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
  headers.set('Cache-Control', 'public, max-age=604800')
  headers.set('ETag', object.httpEtag)
  return new Response(object.body, { headers })
}
```

- [ ] **Step 3: 文档写明 Cloudflare Dashboard 操作**

在 `docs/DEPLOYMENT.md` 增加：

```md
### Cloudflare Images Free Transformations

在 Cloudflare Dashboard 进入 Images > Transformations，选择生产 zone 并启用 transformations。
生产环境变量设置 `IMAGE_RESIZING_ENABLED=true`。
首期只使用 `w=480` 单规格，超过 Free 每月 5,000 unique transformations 后自动回退原图。
```

- [ ] **Step 4: 验证**

Run: `pnpm --filter @meigallery/api test -- src/routes/media.test.ts`

Expected: PASS。

---

### Task 9: 全量引用清理、文档和验证

**Files:**
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `.env.example`
- Search scope: repository-wide `testimonial|Testimonial|testimonials|testimonial_case|testimonial:create`

- [ ] **Step 1: 清理业务命名残留**

Run: `rg "testimonial|Testimonial|testimonials|testimonial_case|testimonial:create" packages docs .env.example`

Expected: 不应出现业务代码残留。历史 `docs/superpowers/specs/2026-05-06-*` 可保留为历史方案文档，但当前 `docs/TECHNICAL_SPEC.md`、`packages/**`、`.env.example` 必须无残留。

- [ ] **Step 2: 全量 API 验证**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS。

Run: `pnpm --filter @meigallery/api test`

Expected: PASS。

- [ ] **Step 3: Web 验证**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS；允许既有 Nuxt/Tailwind sourcemap warning。

- [ ] **Step 4: Git 检查**

Run: `git diff --check`

Expected: PASS，无尾随空格或冲突标记。

- [ ] **Step 5: 提交前人工确认**

当前会话遵守“只有用户明确要求才提交”。完成验证后，向用户汇报变更和验证结果，等待用户明确要求 commit/push 后再提交。

---

## 生产执行顺序

1. 启用 Cloudflare Dashboard `Images > Transformations`。
2. 执行 `node scripts/migrate-cases-r2.mjs --dry-run --remote`。
3. 执行 `node scripts/migrate-cases-r2.mjs --remote` 复制 R2 对象。
4. 执行 `pnpm --filter @meigallery/api db:migrate:remote` 切 D1 表。
5. 部署 API 和 Web。
6. Smoke：`/api/health`、`/`、`/cases`、`/api/cases` 返回正常；`/testimonials` 返回 404。
7. Smoke 通过后执行 `node scripts/migrate-cases-r2.mjs --remote --delete-old` 删除旧 R2 前缀。

## 自审结果

- 设计中的 API、前端、导入、D1、R2、性能、Images Free Transformations 均有对应任务。
- 计划中没有 `TBD`、`TODO` 或“以后实现”占位。
- `case`、`cases`、`case_images`、`case:create`、`/api/cases` 命名在各任务中保持一致。
- 生产破坏性操作已放到 smoke 通过后执行旧 R2 删除。
