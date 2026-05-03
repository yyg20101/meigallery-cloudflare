# 图库互动数据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为图库新增详情 PV、登录点赞/取消点赞、热度排序、前后台互动展示，并用热门推荐替代首页精选专题。

**Architecture:** 复用现有 `galleries.view_count`，新增 `like_count` 与 `gallery_likes` 表。API 层扩展公开图库列表/详情和后台列表，并新增点赞/取消点赞接口；前端新增热度展示、点赞按钮和登录引导弹层，首页通过 `sort=hot` 获取热门推荐。

**Tech Stack:** Cloudflare D1、Hono、Nuxt 3、Vue 3 Composition API、Tailwind CSS v4、Vitest、Wrangler。

---

## 文件结构

- Create: `packages/api/migrations/0013_gallery_interactions.sql`，新增点赞计数和点赞关系表。
- Create: `packages/api/src/utils/gallery-interactions.ts`，集中处理互动计数、热度排序白名单和点赞状态查询。
- Create: `packages/api/src/utils/gallery-interactions.test.ts`，测试热度分数、排序白名单、计数边界。
- Modify: `packages/api/src/routes/galleries.ts`，返回互动字段、详情 PV、点赞/取消点赞接口、`sort=hot` 公式。
- Modify: `packages/api/src/routes/admin/galleries.ts`，后台列表返回互动字段并支持互动排序。
- Create: `packages/web/app/components/GalleryHeatMeta.vue`，前台复用访问量/点赞数展示。
- Create: `packages/web/app/components/GalleryLikeButton.vue`，详情页点赞按钮和状态展示。
- Create: `packages/web/app/components/LoginPromptModal.vue`，未登录点赞引导弹层。
- Modify: `packages/web/app/components/GalleryCard.vue`，卡片展示互动数据。
- Modify: `packages/web/app/components/HomeFeatured.vue`，热门推荐热榜视觉和互动数据展示。
- Modify: `packages/web/app/pages/index.vue`，精选专题替换为热门推荐，数据源使用 `sort=hot`。
- Modify: `packages/web/app/pages/gallery/[slug].vue`，详情互动展示、点赞状态和登录弹层。
- Modify: `packages/web/app/pages/admin/galleries/index.vue`，后台互动列和排序选择。

---

### Task 1: 数据模型与互动工具

**Files:**
- Create: `packages/api/migrations/0013_gallery_interactions.sql`
- Create: `packages/api/src/utils/gallery-interactions.ts`
- Create: `packages/api/src/utils/gallery-interactions.test.ts`

- [ ] **Step 1: 编写 migration**

Create `packages/api/migrations/0013_gallery_interactions.sql`:

```sql
-- 图库互动数据：点赞计数与用户点赞关系
ALTER TABLE galleries ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS gallery_likes (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (gallery_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_galleries_like_count ON galleries(like_count);
CREATE INDEX IF NOT EXISTS idx_gallery_likes_gallery_id ON gallery_likes(gallery_id);
CREATE INDEX IF NOT EXISTS idx_gallery_likes_user_id ON gallery_likes(user_id);
```

- [ ] **Step 2: 编写互动工具函数测试**

Create `packages/api/src/utils/gallery-interactions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clampCount, getAdminGalleryOrderClause, getPublicGalleryOrderClause, getHotScore } from './gallery-interactions'

describe('图库互动工具', () => {
  it('热度分数按浏览量 + 点赞数 * 5 计算', () => {
    expect(getHotScore(10, 2)).toBe(20)
    expect(getHotScore(null, 3)).toBe(15)
    expect(getHotScore(7, null)).toBe(7)
  })

  it('计数不会小于 0', () => {
    expect(clampCount(-1)).toBe(0)
    expect(clampCount(12)).toBe(12)
  })

  it('公开图库排序使用白名单', () => {
    expect(getPublicGalleryOrderClause('hot')).toContain('hot_score')
    expect(getPublicGalleryOrderClause('oldest')).toBe(' ORDER BY g.published_at ASC')
    expect(getPublicGalleryOrderClause('bad-input')).toBe(' ORDER BY g.published_at DESC')
  })

  it('后台图库排序使用白名单', () => {
    expect(getAdminGalleryOrderClause('view_desc')).toBe(' ORDER BY g.view_count DESC, g.created_at DESC')
    expect(getAdminGalleryOrderClause('like_desc')).toBe(' ORDER BY g.like_count DESC, g.created_at DESC')
    expect(getAdminGalleryOrderClause('bad-input')).toBe(' ORDER BY g.created_at DESC')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/utils/gallery-interactions.test.ts`

Expected: FAIL，提示 `gallery-interactions` 模块不存在。

- [ ] **Step 4: 实现互动工具函数**

Create `packages/api/src/utils/gallery-interactions.ts`:

```ts
export function clampCount(value: number | null | undefined): number {
  return Math.max(0, value ?? 0)
}

export function getHotScore(viewCount: number | null | undefined, likeCount: number | null | undefined): number {
  return clampCount(viewCount) + clampCount(likeCount) * 5
}

export function getPublicGalleryOrderClause(sort: string): string {
  switch (sort) {
    case 'oldest':
      return ' ORDER BY g.published_at ASC'
    case 'random':
      return ' ORDER BY RANDOM()'
    case 'hot':
      return ' ORDER BY hot_score DESC, g.published_at DESC'
    default:
      return ' ORDER BY g.published_at DESC'
  }
}

export function getAdminGalleryOrderClause(sort: string): string {
  switch (sort) {
    case 'view_desc':
      return ' ORDER BY g.view_count DESC, g.created_at DESC'
    case 'like_desc':
      return ' ORDER BY g.like_count DESC, g.created_at DESC'
    case 'created_asc':
      return ' ORDER BY g.created_at ASC'
    default:
      return ' ORDER BY g.created_at DESC'
  }
}

export async function isGalleryLikedByUser(db: D1Database, galleryId: string, userId: number | null): Promise<boolean> {
  if (!userId) return false
  const row = await db
    .prepare('SELECT 1 FROM gallery_likes WHERE gallery_id = ? AND user_id = ?')
    .bind(galleryId, userId)
    .first<{ 1: number }>()
  return Boolean(row)
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @meigallery/api test -- src/utils/gallery-interactions.test.ts`

Expected: PASS，4 个测试通过。

- [ ] **Step 6: 提交**

```bash
git add packages/api/migrations/0013_gallery_interactions.sql packages/api/src/utils/gallery-interactions.ts packages/api/src/utils/gallery-interactions.test.ts
git commit -m "feat: 新增图库互动数据模型"
```

---

### Task 2: 公开 API 返回互动字段与热度排序

**Files:**
- Modify: `packages/api/src/routes/galleries.ts`

- [ ] **Step 1: 扩展列表查询字段**

In `packages/api/src/routes/galleries.ts`, import helpers:

```ts
import { getPublicGalleryOrderClause, isGalleryLikedByUser } from '../utils/gallery-interactions'
```

Change list `SELECT` to include counts and hot score:

```sql
SELECT DISTINCT g.id, g.title, g.slug, g.summary, g.cover_key,
       g.required_level_rank, g.published_at,
       g.view_count, g.like_count,
       (COALESCE(g.view_count, 0) + COALESCE(g.like_count, 0) * 5) as hot_score
FROM galleries g
```

Replace the public sort switch with:

```ts
const orderClause = getPublicGalleryOrderClause(sort)
```

Add list response fields:

```ts
viewCount: g.view_count,
likeCount: g.like_count,
```

- [ ] **Step 2: 扩展详情查询字段和 likedByMe**

Change detail `SELECT` to include counts:

```sql
SELECT id, title, slug, summary, body_md, cover_key, status,
       required_level_rank, published_at, created_at, updated_at,
       view_count, like_count
FROM galleries
WHERE slug = ? AND status = 'published'
```

Before returning JSON:

```ts
const likedByMe = await isGalleryLikedByUser(db, gallery.id, c.get('userId'))
```

Add detail response fields:

```ts
viewCount: gallery.view_count,
likeCount: gallery.like_count,
likedByMe,
```

- [ ] **Step 3: 运行类型检查**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS，无输出。

- [ ] **Step 4: 提交**

```bash
git add packages/api/src/routes/galleries.ts
git commit -m "feat: 返回图库互动统计字段"
```

---

### Task 3: 点赞与取消点赞 API

**Files:**
- Modify: `packages/api/src/routes/galleries.ts`
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: 为互动接口增加速率限制**

In `packages/api/src/index.ts`, before `app.use('*', authMiddleware)` add:

```ts
app.use('/api/galleries/*/like', rateLimiter({ limit: 60, windowMs: 60_000 }))
```

- [ ] **Step 2: 新增点赞接口**

In `packages/api/src/routes/galleries.ts`, add before `GET /:slug`:

```ts
galleryRoutes.post('/:id/like', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ statusCode: 401, message: '请先登录后再点赞' }, 401)

  const db = c.env.DB
  const galleryId = c.req.param('id')
  const gallery = await db.prepare("SELECT id, like_count FROM galleries WHERE id = ? AND status = 'published'").bind(galleryId).first<{ id: string; like_count: number }>()
  if (!gallery) return c.json({ statusCode: 404, message: '图库不存在' }, 404)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const inserted = await db
    .prepare('INSERT OR IGNORE INTO gallery_likes (id, gallery_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, galleryId, userId, now)
    .run()

  if ((inserted.meta?.changes ?? 0) > 0) {
    await db.prepare('UPDATE galleries SET like_count = like_count + 1 WHERE id = ?').bind(galleryId).run()
  }

  const row = await db.prepare('SELECT like_count FROM galleries WHERE id = ?').bind(galleryId).first<{ like_count: number }>()
  return c.json({ likeCount: row?.like_count ?? gallery.like_count, likedByMe: true })
})
```

- [ ] **Step 3: 新增取消点赞接口**

In `packages/api/src/routes/galleries.ts`, add after POST like:

```ts
galleryRoutes.delete('/:id/like', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ statusCode: 401, message: '请先登录后再操作' }, 401)

  const db = c.env.DB
  const galleryId = c.req.param('id')
  const gallery = await db.prepare("SELECT id, like_count FROM galleries WHERE id = ? AND status = 'published'").bind(galleryId).first<{ id: string; like_count: number }>()
  if (!gallery) return c.json({ statusCode: 404, message: '图库不存在' }, 404)

  const deleted = await db
    .prepare('DELETE FROM gallery_likes WHERE gallery_id = ? AND user_id = ?')
    .bind(galleryId, userId)
    .run()

  if ((deleted.meta?.changes ?? 0) > 0) {
    await db.prepare('UPDATE galleries SET like_count = MAX(like_count - 1, 0) WHERE id = ?').bind(galleryId).run()
  }

  const row = await db.prepare('SELECT like_count FROM galleries WHERE id = ?').bind(galleryId).first<{ like_count: number }>()
  return c.json({ likeCount: row?.like_count ?? gallery.like_count, likedByMe: false })
})
```

- [ ] **Step 4: 运行验证**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS，无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/api/src/index.ts packages/api/src/routes/galleries.ts
git commit -m "feat: 新增图库点赞接口"
```

---

### Task 4: 前台互动组件

**Files:**
- Create: `packages/web/app/components/GalleryHeatMeta.vue`
- Create: `packages/web/app/components/GalleryLikeButton.vue`
- Create: `packages/web/app/components/LoginPromptModal.vue`

- [ ] **Step 1: 创建热度元信息组件**

Create `GalleryHeatMeta.vue`:

```vue
<script setup lang="ts">
defineProps<{
  viewCount?: number | null
  likeCount?: number | null
  tone?: 'light' | 'dark'
}>()

function formatCount(value?: number | null) {
  const count = Math.max(0, value ?? 0)
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}
</script>

<template>
  <div class="flex items-center gap-2 text-[11px] tabular-nums" :class="tone === 'dark' ? 'text-white/78' : 'text-gray-500'">
    <span class="inline-flex items-center gap-1"><span aria-hidden="true">浏览</span>{{ formatCount(viewCount) }}</span>
    <span class="h-1 w-1 rounded-full" :class="tone === 'dark' ? 'bg-white/35' : 'bg-[#d6c39a]'" />
    <span class="inline-flex items-center gap-1"><span aria-hidden="true">点赞</span>{{ formatCount(likeCount) }}</span>
  </div>
</template>
```

- [ ] **Step 2: 创建点赞按钮组件**

Create `GalleryLikeButton.vue`:

```vue
<script setup lang="ts">
defineProps<{
  liked: boolean
  loading?: boolean
  likeCount: number
}>()

const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <button
    type="button"
    :disabled="loading"
    class="inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium tabular-nums shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-60"
    :class="liked ? 'bg-gray-950 text-[#d6c39a] ring-1 ring-[#d6c39a]/40' : 'bg-white text-gray-950 ring-1 ring-[#eadfd2] hover:-translate-y-0.5 hover:ring-[#d6c39a]'"
    :aria-pressed="liked"
    @click="emit('click')"
  >
    <span>{{ liked ? '已点赞' : '点赞' }}</span>
    <span>{{ likeCount }}</span>
  </button>
</template>
```

- [ ] **Step 3: 创建登录引导弹层**

Create `LoginPromptModal.vue`:

```vue
<script setup lang="ts">
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="login-prompt-title">
      <div class="w-full max-w-sm rounded-[1.75rem] border border-white/80 bg-[#fffbf7] p-6 shadow-2xl shadow-gray-950/20">
        <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Member Action</p>
        <h2 id="login-prompt-title" class="mt-3 text-2xl font-semibold tracking-[-0.04em] text-gray-950">登录后即可点赞</h2>
        <p class="mt-3 text-sm leading-6 text-gray-600">点赞会记录到你的账号，用于帮助站点推荐更受欢迎的图库。</p>
        <div class="mt-6 flex gap-2">
          <NuxtLink to="/login" class="flex-1 rounded-full bg-gray-950 px-4 py-2.5 text-center text-sm font-medium text-[#d6c39a]">登录 / 注册</NuxtLink>
          <button type="button" class="flex-1 rounded-full border border-[#eadfd2] bg-white px-4 py-2.5 text-sm font-medium text-gray-700" @click="emit('close')">稍后再说</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 4: 运行 Web 构建**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS，允许已有 sourcemap warning。

- [ ] **Step 5: 提交**

```bash
git add packages/web/app/components/GalleryHeatMeta.vue packages/web/app/components/GalleryLikeButton.vue packages/web/app/components/LoginPromptModal.vue
git commit -m "feat: 新增图库互动前台组件"
```

---

### Task 5: 前台页面接入互动数据

**Files:**
- Modify: `packages/web/app/components/GalleryCard.vue`
- Modify: `packages/web/app/components/HomeFeatured.vue`
- Modify: `packages/web/app/pages/index.vue`
- Modify: `packages/web/app/pages/gallery/[slug].vue`

- [ ] **Step 1: 扩展前端类型**

Add optional fields to all relevant `Gallery` / `GallerySummary` / `GalleryDetail` interfaces:

```ts
viewCount?: number
likeCount?: number
likedByMe?: boolean
```

- [ ] **Step 2: 卡片展示互动数据**

In `GalleryCard.vue`, after tags block add:

```vue
<GalleryHeatMeta class="mt-3" :view-count="gallery.viewCount" :like-count="gallery.likeCount" />
```

- [ ] **Step 3: 首页数据改为热门推荐**

In `index.vue`, replace featured computed with async hot data:

```ts
const { data: hotGalleriesData } = await useAsyncData('home-hot-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: '3', sort: 'hot' } }),
)
const featured = computed(() => hotGalleriesData.value?.data ?? allGalleries.value.slice(6, 9))
```

Change heading:

```vue
<EditorialSectionHeading eyebrow="Hot Ranking" title="热门推荐" description="按访问与点赞热度生成的人气内容。" action-label="查看全部" action-to="/discover?sort=hot" />
```

- [ ] **Step 4: 热门推荐卡展示热榜感**

In `HomeFeatured.vue`, add rank badge and meta for each card:

```vue
<div class="absolute left-4 top-4 rounded-full bg-gray-950/82 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#d6c39a] ring-1 ring-[#d6c39a]/35 backdrop-blur">No.01 Hot</div>
<GalleryHeatMeta class="mt-2" tone="dark" :view-count="galleries[0].viewCount" :like-count="galleries[0].likeCount" />
```

- [ ] **Step 5: 详情页点赞交互**

In `[slug].vue`, add state:

```ts
const showLoginPrompt = ref(false)
const liking = ref(false)
const likedByMe = ref(Boolean(gallery.value?.likedByMe))
const likeCount = ref(gallery.value?.likeCount ?? 0)

async function toggleLike() {
  if (!gallery.value) return
  if (!isLoggedIn.value) {
    showLoginPrompt.value = true
    return
  }
  liking.value = true
  try {
    const result = await api<{ likeCount: number; likedByMe: boolean }>(`/api/galleries/${gallery.value.id}/like`, {
      method: likedByMe.value ? 'DELETE' : 'POST',
    })
    likeCount.value = result.likeCount
    likedByMe.value = result.likedByMe
  } finally {
    liking.value = false
  }
}
```

Add to detail hero meta area:

```vue
<div class="mt-5 flex flex-wrap items-center gap-3">
  <GalleryHeatMeta :view-count="gallery.viewCount" :like-count="likeCount" />
  <GalleryLikeButton :liked="likedByMe" :loading="liking" :like-count="likeCount" @click="toggleLike" />
</div>
<LoginPromptModal :open="showLoginPrompt" @close="showLoginPrompt = false" />
```

- [ ] **Step 6: 运行 Web 构建**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS，允许已有 sourcemap warning。

- [ ] **Step 7: 提交**

```bash
git add packages/web/app/components/GalleryCard.vue packages/web/app/components/HomeFeatured.vue packages/web/app/pages/index.vue packages/web/app/pages/gallery/[slug].vue
git commit -m "feat: 接入前台图库互动展示"
```

---

### Task 6: 后台列表接入互动排序

**Files:**
- Modify: `packages/api/src/routes/admin/galleries.ts`
- Modify: `packages/web/app/pages/admin/galleries/index.vue`

- [ ] **Step 1: API 增加排序白名单**

In `admin/galleries.ts`, import:

```ts
import { getAdminGalleryOrderClause } from '../../utils/gallery-interactions'
```

Read sort query:

```ts
const sort = c.req.query('sort') || 'created_desc'
const orderClause = getAdminGalleryOrderClause(sort)
```

Change select fields:

```sql
SELECT DISTINCT g.id, g.title, g.slug, g.status, g.required_level_rank, g.cover_key,
       g.published_at, g.created_at, g.updated_at, g.view_count, g.like_count
FROM galleries g ...
```

Replace `ORDER BY g.created_at DESC` with `${orderClause}`.

- [ ] **Step 2: 后台页面增加排序选项和列**

In `admin/galleries/index.vue`, extend interface:

```ts
view_count: number
like_count: number
```

Add state:

```ts
const sort = ref((route.query.sort as string) || 'created_desc')
const sortOptions = [
  { label: '最新创建', value: 'created_desc' },
  { label: '访问最多', value: 'view_desc' },
  { label: '点赞最多', value: 'like_desc' },
]
```

Add query param:

```ts
sort: sort.value,
```

Add `sort` to watch list and selection reset watch.

Add table columns near title/status:

```vue
<th class="px-4 py-3 text-left text-xs font-medium text-gray-500">访问</th>
<th class="px-4 py-3 text-left text-xs font-medium text-gray-500">点赞</th>
```

Add row cells:

```vue
<td class="px-4 py-3 text-sm tabular-nums text-gray-600">{{ gallery.view_count ?? 0 }}</td>
<td class="px-4 py-3 text-sm tabular-nums text-gray-600">{{ gallery.like_count ?? 0 }}</td>
```

- [ ] **Step 3: 运行验证**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS，无输出。

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS，允许已有 sourcemap warning。

- [ ] **Step 4: 提交**

```bash
git add packages/api/src/routes/admin/galleries.ts packages/web/app/pages/admin/galleries/index.vue
git commit -m "feat: 后台支持互动数据排序"
```

---

### Task 7: 全量验证、迁移和发布

**Files:**
- No code changes unless verification reveals defects.

- [ ] **Step 1: 全量测试和构建**

Run:

```bash
pnpm --filter @meigallery/api test
pnpm --filter @meigallery/api exec tsc --noEmit
pnpm --filter @meigallery/web exec nuxt build
```

Expected: 全部通过；Web 构建允许已有 sourcemap warning。

- [ ] **Step 2: 本地 migration 验证**

Run:

```bash
pnpm --filter @meigallery/api db:migrate:local
```

Expected: `0013_gallery_interactions.sql` 应用成功。

- [ ] **Step 3: 提交验证修复**

If verification required code fixes, commit them:

```bash
git add -A
git commit -m "fix: 修复图库互动功能验证问题"
```

If no fixes were needed, do not create an empty commit.

- [ ] **Step 4: 推送 dev**

Run:

```bash
git push
```

Expected: `dev -> origin/dev` 成功。

- [ ] **Step 5: 发布前远端验证**

Create PR from `dev` to `main`, wait for checks:

```bash
gh pr create --base main --head dev --title "feat: 新增图库互动数据" --body "$(cat <<'EOF'
## Summary
- 新增图库详情 PV、登录点赞/取消点赞和热度排序。
- 首页热门推荐替代精选专题，前后台展示访问量与点赞数。
- 后台图库列表支持按访问量和点赞数排序。

## Test Plan
- pnpm --filter @meigallery/api test
- pnpm --filter @meigallery/api exec tsc --noEmit
- pnpm --filter @meigallery/web exec nuxt build
- pnpm --filter @meigallery/api db:migrate:local
EOF
)"
```

- [ ] **Step 6: 生产发布**

After PR checks pass and merge to `main`, GitHub Actions should run production deploy. If manual deploy is needed:

```bash
pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote
pnpm --filter @meigallery/api exec wrangler deploy
pnpm --filter @meigallery/web exec wrangler deploy
```

- [ ] **Step 7: 生产冒烟**

Run:

```bash
curl -s -o /dev/null -w "%{http_code} %{url_effective}\n" "https://616618.xyz/"
curl -s -o /dev/null -w "%{http_code} %{url_effective}\n" "https://616618.xyz/discover"
curl -s -o /dev/null -w "%{http_code} %{url_effective}\n" "https://api.616618.xyz/api/health"
```

Expected: all return `200`.

---

## 自检清单

- PRD 已覆盖：登录点赞、取消点赞、PV、后台排序、首页热门推荐替代精选专题、未登录弹层、管理员访问计入 PV。
- 权限边界已覆盖：点赞要求 session，前端不传用户 ID，媒体授权不变。
- 隐私边界已覆盖：只保存聚合 PV，不保存 IP/UA/设备指纹。
- 视觉方向已覆盖：珍珠杂志感 + 黑金热榜，不新增低质红榜风格。
- 验证路径已覆盖：API 测试、API 类型检查、Web 构建、D1 migration、生产冒烟。
