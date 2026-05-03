# 前台整体视觉升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 MeiGallery 前台升级为“杂志封面型 + 地区图鉴入口”的全站视觉系统，主线突出女性写真展示，副线强化地区浏览，标签作为辅助筛选。

**Architecture:** 保持现有 Nuxt 3 + Hono + D1 架构不变。后端只扩展 `site_settings` 配置白名单和迁移种子，前端通过 `useSiteSettings` 获取首页配置，通过现有 `/api/tags` 和 `/api/galleries` 组织地区入口、首页首屏、发现筛选、搜索和详情展示。

**Tech Stack:** Nuxt 3/Vue 3 Composition API、Tailwind CSS v4、Hono、Cloudflare D1 migrations、Vitest、Wrangler Workers 部署。

---

## File Structure

- Modify: `packages/api/src/utils/site-settings.ts` — 扩展后台和公开设置 key。
- Modify: `packages/api/src/utils/site-settings.test.ts` — 覆盖首页配置 key 白名单。
- Create: `packages/api/migrations/0012_homepage_editorial_settings.sql` — 写入首页默认文案、CTA、主推地区和展示数量。
- Modify: `packages/web/app/composables/useSiteSettings.ts` — 暴露首页配置 computed。
- Create: `packages/web/app/utils/galleryPresentation.ts` — 统一地区标签识别、主推地区解析、图库封面兜底、标签分组逻辑。
- Create: `packages/web/app/components/EditorialSectionHeading.vue` — 统一前台区块标题和行动链接。
- Create: `packages/web/app/components/HomeEditorialHero.vue` — 首页杂志封面首屏。
- Create: `packages/web/app/components/RegionGuide.vue` — 地区图鉴入口，首页和发现页复用。
- Modify: `packages/web/app/components/GalleryCard.vue` — 增强地区、会员、标签的信息层级。
- Modify: `packages/web/app/components/GalleryGrid.vue` — 支持 `variant` 和更高质量网格间距。
- Modify: `packages/web/app/components/TagFilterTabs.vue` — 地区优先筛选视觉。
- Modify: `packages/web/app/components/FilterBar.vue` — 搜索页筛选视觉统一。
- Modify: `packages/web/app/pages/index.vue` — 首页改为杂志首屏、地区入口、精选和最新画报流。
- Modify: `packages/web/app/pages/discover.vue` — 地区优先浏览和筛选区升级。
- Modify: `packages/web/app/pages/search.vue` — 沉浸式搜索页升级。
- Modify: `packages/web/app/pages/gallery/[slug].vue` — 大封面详情页叙事升级。
- Modify: `packages/web/app/pages/user.vue` — 用户中心统一珍珠杂志感。
- Modify: `packages/web/app/pages/about.vue` — 关于页统一为杂志式内容页。
- Modify: `packages/web/app/pages/login.vue` and `packages/web/app/pages/register.vue` — 认证页视觉统一。
- Modify: `packages/web/app/pages/admin/settings.vue` — Owner 可配置首页文案和主推地区。

---

## Task 1: Homepage Editorial Settings

**Files:**
- Modify: `packages/api/src/utils/site-settings.ts`
- Modify: `packages/api/src/utils/site-settings.test.ts`
- Create: `packages/api/migrations/0012_homepage_editorial_settings.sql`
- Modify: `packages/web/app/composables/useSiteSettings.ts`
- Modify: `packages/web/app/pages/admin/settings.vue`

- [ ] **Step 1: Write the settings whitelist test**

Replace `packages/api/src/utils/site-settings.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { ADMIN_SETTING_KEYS, PUBLIC_SETTING_KEYS } from './site-settings'

describe('site settings keys', () => {
  it('allows about page settings in admin and public settings', () => {
    const aboutKeys = ['about_title', 'about_summary', 'about_content']

    for (const key of aboutKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })

  it('allows homepage editorial settings in admin and public settings', () => {
    const homepageKeys = [
      'home_hero_title',
      'home_hero_subtitle',
      'home_hero_cta_label',
      'home_hero_cta_url',
      'home_featured_region_slugs',
      'home_hot_tag_limit',
    ]

    for (const key of homepageKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })
})
```

- [ ] **Step 2: Run the whitelist test to verify it fails**

Run: `pnpm --filter @meigallery/api exec vitest run src/utils/site-settings.test.ts`

Expected: FAIL because `home_hero_title` and the other new homepage keys are not in `ADMIN_SETTING_KEYS` or `PUBLIC_SETTING_KEYS`.

- [ ] **Step 3: Add the settings keys**

Update `packages/api/src/utils/site-settings.ts` to:

```ts
export const ADMIN_SETTING_KEYS = [
  'site_name', 'seo_title', 'site_description', 'site_icon',
  'og_title', 'og_description', 'og_image',
  'footer_text', 'membership_description', 'email_verification_enabled',
  'video_enabled', 'about_title', 'about_summary', 'about_content',
  'home_hero_title', 'home_hero_subtitle', 'home_hero_cta_label',
  'home_hero_cta_url', 'home_featured_region_slugs', 'home_hot_tag_limit',
] as const

export const PUBLIC_SETTING_KEYS = [
  'site_name', 'seo_title', 'site_description', 'site_icon',
  'og_title', 'og_description', 'og_image',
  'footer_text', 'membership_description', 'email_verification_enabled',
  'video_enabled', 'about_title', 'about_summary', 'about_content',
  'home_hero_title', 'home_hero_subtitle', 'home_hero_cta_label',
  'home_hero_cta_url', 'home_featured_region_slugs', 'home_hot_tag_limit',
] as const
```

- [ ] **Step 4: Create the D1 migration**

Create `packages/api/migrations/0012_homepage_editorial_settings.sql`:

```sql
-- 首页杂志化视觉配置
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('home_hero_title', '"精选写真，按地区发现"', datetime('now')),
  ('home_hero_subtitle', '"以授权写真、时尚、生活与艺术类内容为核心，按加拿大、国内精选和热门城市快速浏览。"', datetime('now')),
  ('home_hero_cta_label', '"浏览精选图库"', datetime('now')),
  ('home_hero_cta_url', '"/discover"', datetime('now')),
  ('home_featured_region_slugs', '"canada,domestic,toronto,vancouver"', datetime('now')),
  ('home_hot_tag_limit', '"15"', datetime('now'));
```

- [ ] **Step 5: Extend the web settings composable**

Update `packages/web/app/composables/useSiteSettings.ts` by adding fields to `SiteSettings`:

```ts
home_hero_title?: string
home_hero_subtitle?: string
home_hero_cta_label?: string
home_hero_cta_url?: string
home_featured_region_slugs?: string
home_hot_tag_limit?: string | number
```

Then add computed values after `aboutContent`:

```ts
const homeHeroTitle = computed(() => settings.value.home_hero_title || '精选写真，按地区发现')
const homeHeroSubtitle = computed(() => settings.value.home_hero_subtitle || '以授权写真、时尚、生活与艺术类内容为核心，按地区和标签探索精选图库。')
const homeHeroCtaLabel = computed(() => settings.value.home_hero_cta_label || '浏览精选图库')
const homeHeroCtaUrl = computed(() => settings.value.home_hero_cta_url || '/discover')
const homeFeaturedRegionSlugs = computed(() => String(settings.value.home_featured_region_slugs || '').split(',').map(s => s.trim()).filter(Boolean))
const homeHotTagLimit = computed(() => {
  const value = Number(settings.value.home_hot_tag_limit || 15)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30) : 15
})
```

Return the six computed values in the returned object.

- [ ] **Step 6: Add admin settings fields**

In `packages/web/app/pages/admin/settings.vue`, extend `form`:

```ts
home_hero_title: '',
home_hero_subtitle: '',
home_hero_cta_label: '',
home_hero_cta_url: '',
home_featured_region_slugs: '',
home_hot_tag_limit: '',
```

Add a fieldset before “关于我们页面”:

```vue
<fieldset class="space-y-4">
  <legend class="w-full border-b border-gray-200 pb-2 text-sm font-semibold text-gray-900">首页视觉配置</legend>
  <div>
    <label class="mb-1 block text-sm font-medium text-gray-700">首页主标题</label>
    <input v-model="form.home_hero_title" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="精选写真，按地区发现" />
  </div>
  <div>
    <label class="mb-1 block text-sm font-medium text-gray-700">首页副标题</label>
    <textarea v-model="form.home_hero_subtitle" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="用于首页首屏说明" />
  </div>
  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <label class="mb-1 block text-sm font-medium text-gray-700">CTA 文案</label>
      <input v-model="form.home_hero_cta_label" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="浏览精选图库" />
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium text-gray-700">CTA 链接</label>
      <input v-model="form.home_hero_cta_url" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="/discover" />
    </div>
  </div>
  <div>
    <label class="mb-1 block text-sm font-medium text-gray-700">主推地区 slugs</label>
    <input v-model="form.home_featured_region_slugs" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="canada,domestic,toronto,vancouver" />
    <p class="mt-1 text-xs text-gray-400">英文逗号分隔；前台会优先展示这些地区标签。</p>
  </div>
  <div>
    <label class="mb-1 block text-sm font-medium text-gray-700">首页热门标签数量</label>
    <input v-model="form.home_hot_tag_limit" type="number" min="1" max="30" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="15" />
  </div>
</fieldset>
```

- [ ] **Step 7: Run settings verification**

Run: `pnpm --filter @meigallery/api exec vitest run src/utils/site-settings.test.ts`

Expected: PASS with 2 tests passing.

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/api/src/utils/site-settings.ts packages/api/src/utils/site-settings.test.ts packages/api/migrations/0012_homepage_editorial_settings.sql packages/web/app/composables/useSiteSettings.ts packages/web/app/pages/admin/settings.vue
git commit -m "feat: 新增首页杂志化配置项"
git push origin dev
```

---

## Task 2: Presentation Utilities and Reusable Components

**Files:**
- Create: `packages/web/app/utils/galleryPresentation.ts`
- Create: `packages/web/app/components/EditorialSectionHeading.vue`
- Create: `packages/web/app/components/RegionGuide.vue`
- Create: `packages/web/app/components/HomeEditorialHero.vue`
- Modify: `packages/web/app/components/GalleryGrid.vue`
- Modify: `packages/web/app/components/GalleryCard.vue`

- [ ] **Step 1: Create presentation utilities**

Create `packages/web/app/utils/galleryPresentation.ts`:

```ts
export interface PresentationTag {
  id?: string
  type: string
  name: string
  slug: string
}

export interface RegionGuideItem {
  name: string
  slug: string
  label: string
  description: string
}

const REGION_TYPES = new Set(['region', 'region_scope', 'region_group', 'city', 'city_country'])

export function isRegionTag(tag: Pick<PresentationTag, 'type'>) {
  return REGION_TYPES.has(tag.type)
}

export function getPrimaryRegion(tags: PresentationTag[]) {
  return tags.find(isRegionTag) || null
}

export function getSupportTags(tags: PresentationTag[], limit = 3) {
  return tags.filter(tag => !isRegionTag(tag)).slice(0, limit)
}

export function collectRegionGuideItems(
  groupedTags: Record<string, Array<{ id?: string; name: string; slug: string }>>,
  preferredSlugs: string[],
  limit = 6,
): RegionGuideItem[] {
  const regionTags = Object.entries(groupedTags)
    .filter(([type]) => REGION_TYPES.has(type))
    .flatMap(([type, items]) => items.map(item => ({ ...item, type })))

  const preferred = preferredSlugs
    .map(slug => regionTags.find(tag => tag.slug === slug))
    .filter((tag): tag is PresentationTag => Boolean(tag))

  const fallback = regionTags.filter(tag => !preferred.some(item => item.slug === tag.slug))
  return [...preferred, ...fallback].slice(0, limit).map(tag => ({
    name: tag.name,
    slug: tag.slug,
    label: tag.type === 'city_country' || tag.type === 'city' ? '城市' : '地区',
    description: `${tag.name}精选图库`,
  }))
}
```

- [ ] **Step 2: Create `EditorialSectionHeading`**

Create `packages/web/app/components/EditorialSectionHeading.vue`:

```vue
<script setup lang="ts">
defineProps<{
  eyebrow?: string
  title: string
  description?: string
  actionLabel?: string
  actionTo?: string
}>()
</script>

<template>
  <div class="mb-4 flex items-end justify-between gap-4">
    <div>
      <p v-if="eyebrow" class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">{{ eyebrow }}</p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight text-gray-950 lg:text-2xl">{{ title }}</h2>
      <p v-if="description" class="mt-1 max-w-2xl text-sm leading-6 text-gray-500">{{ description }}</p>
    </div>
    <NuxtLink v-if="actionLabel && actionTo" :to="actionTo" class="hidden rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm text-gray-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950 sm:inline-flex">
      {{ actionLabel }}
    </NuxtLink>
  </div>
</template>
```

- [ ] **Step 3: Create `RegionGuide`**

Create `packages/web/app/components/RegionGuide.vue`:

```vue
<script setup lang="ts">
import type { RegionGuideItem } from '~/utils/galleryPresentation'

defineProps<{
  regions: RegionGuideItem[]
  compact?: boolean
}>()
</script>

<template>
  <div class="grid gap-3" :class="compact ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.15fr_repeat(4,minmax(0,1fr))]'">
    <div v-if="!compact" class="relative overflow-hidden rounded-[1.5rem] bg-gray-950 p-5 text-[#d6c39a] shadow-xl shadow-gray-900/10">
      <div class="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[#d6c39a]/20 blur-3xl" />
      <p class="relative text-[10px] font-semibold uppercase tracking-[0.22em] text-white/55">Region Guide</p>
      <h3 class="relative mt-2 text-lg font-semibold text-white">按地区发现</h3>
      <p class="relative mt-2 text-xs leading-5 text-white/60">从国家、地区组和城市进入精选图库。</p>
    </div>

    <NuxtLink
      v-for="region in regions"
      :key="region.slug"
      :to="`/discover?tag=${region.slug}`"
      class="group relative overflow-hidden rounded-[1.5rem] border border-[#f0e4d8] bg-white/85 p-4 shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-1 hover:border-[#d6c39a] hover:shadow-xl hover:shadow-orange-950/10"
    >
      <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#bfa46a]">{{ region.label }}</span>
      <strong class="mt-2 block text-lg tracking-tight text-gray-950">{{ region.name }}</strong>
      <span class="mt-2 block text-xs leading-5 text-gray-500">{{ region.description }}</span>
      <span class="mt-4 inline-flex text-xs font-medium text-gray-900 underline decoration-[#d6c39a] underline-offset-4">进入地区</span>
    </NuxtLink>
  </div>
</template>
```

- [ ] **Step 4: Create `HomeEditorialHero`**

Create `packages/web/app/components/HomeEditorialHero.vue`:

```vue
<script setup lang="ts">
import { getPrimaryRegion, getSupportTags, type PresentationTag } from '~/utils/galleryPresentation'

interface HeroGallery {
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  tags: PresentationTag[]
}

const props = defineProps<{
  title: string
  subtitle: string
  ctaLabel: string
  ctaUrl: string
  gallery: HeroGallery | null
}>()

const region = computed(() => props.gallery ? getPrimaryRegion(props.gallery.tags) : null)
const supportTags = computed(() => props.gallery ? getSupportTags(props.gallery.tags, 3) : [])
</script>

<template>
  <section class="relative overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-6 shadow-2xl shadow-orange-950/8 ring-1 ring-[#f8e7dc]/80 lg:grid lg:grid-cols-[1.02fr_0.98fr] lg:gap-8 lg:px-8 lg:py-9">
    <div class="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[#f8e7dc]/80 blur-3xl" />
    <div class="absolute -right-20 top-1/3 h-64 w-64 rounded-full bg-[#fff7ed] blur-3xl" />

    <div class="relative z-10 flex flex-col justify-end">
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Selected Portrait Archive</p>
      <h1 class="mt-4 max-w-2xl text-4xl font-semibold leading-[0.95] tracking-[-0.065em] text-gray-950 lg:text-6xl">{{ title }}</h1>
      <p class="mt-5 max-w-xl text-sm leading-7 text-gray-600 lg:text-base">{{ subtitle }}</p>
      <div class="mt-6 flex flex-wrap gap-2">
        <NuxtLink :to="ctaUrl" class="rounded-full bg-gray-950 px-5 py-3 text-sm font-medium text-[#d6c39a] shadow-lg shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-black">
          {{ ctaLabel }}
        </NuxtLink>
        <NuxtLink v-if="region" :to="`/discover?tag=${region.slug}`" class="rounded-full border border-[#eadfd2] bg-white/80 px-5 py-3 text-sm font-medium text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950">
          {{ region.name }}精选
        </NuxtLink>
      </div>
    </div>

    <NuxtLink v-if="gallery" :to="`/gallery/${gallery.slug}`" class="group relative z-10 mt-7 block lg:mt-0">
      <div class="relative ml-auto aspect-[4/5] max-h-[34rem] overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#eadfd2] to-[#fff7ed] shadow-[0_32px_90px_rgba(77,48,34,0.22)] ring-1 ring-white/80">
        <img v-if="gallery.coverUrl" :src="gallery.coverUrl" :alt="gallery.title" class="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]" />
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-950/72 via-gray-950/12 to-transparent p-5 text-white">
          <p v-if="region" class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6c39a]">{{ region.name }}</p>
          <h2 class="mt-2 line-clamp-2 text-xl font-semibold tracking-tight">{{ gallery.title }}</h2>
          <div class="mt-3 flex flex-wrap gap-1.5">
            <span v-for="tag in supportTags" :key="tag.slug" class="rounded-full bg-white/16 px-2.5 py-1 text-[10px] text-white/85 ring-1 ring-white/18 backdrop-blur">{{ tag.name }}</span>
          </div>
        </div>
      </div>
    </NuxtLink>
  </section>
</template>
```

- [ ] **Step 5: Update `GalleryGrid` variants**

Update `packages/web/app/components/GalleryGrid.vue`:

```vue
<script setup lang="ts">
interface Gallery {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  publishedAt: string | null
  tags: Array<{ id: string; type: string; name: string; slug: string }>
}

withDefaults(defineProps<{
  galleries: Gallery[]
  variant?: 'default' | 'magazine'
}>(), {
  variant: 'default',
})
</script>

<template>
  <div :class="variant === 'magazine' ? 'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4' : 'grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 lg:gap-3'">
    <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
  </div>
</template>
```

- [ ] **Step 6: Update `GalleryCard` metadata hierarchy**

In `packages/web/app/components/GalleryCard.vue`, import helpers:

```ts
import { getPrimaryRegion, getSupportTags } from '~/utils/galleryPresentation'
```

Add computed values after `levelBadge`:

```ts
const primaryRegion = computed(() => getPrimaryRegion(props.gallery.tags))
const supportTags = computed(() => getSupportTags(props.gallery.tags, 2))
```

Replace the title/tag block with:

```vue
<div class="p-3.5">
  <p v-if="primaryRegion" class="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#bfa46a]">{{ primaryRegion.name }}</p>
  <h3 class="line-clamp-1 text-[12px] font-semibold tracking-tight text-gray-950 transition-colors group-hover:text-black">{{ gallery.title }}</h3>
  <div class="mt-2 flex flex-wrap gap-1.5">
    <TagChip v-for="tag in supportTags" :key="tag.slug" :tag="tag" size="sm" />
  </div>
</div>
```

- [ ] **Step 7: Build verify and commit Task 2**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

```bash
git add packages/web/app/utils/galleryPresentation.ts packages/web/app/components/EditorialSectionHeading.vue packages/web/app/components/RegionGuide.vue packages/web/app/components/HomeEditorialHero.vue packages/web/app/components/GalleryGrid.vue packages/web/app/components/GalleryCard.vue
git commit -m "feat: 新增前台杂志化展示组件"
git push origin dev
```

---

## Task 3: Homepage Redesign

**Files:**
- Modify: `packages/web/app/pages/index.vue`
- Modify: `packages/web/app/components/HomeFeatured.vue`
- Modify: `packages/web/app/components/HomeVideoZone.vue`

- [ ] **Step 1: Update homepage script data flow**

In `packages/web/app/pages/index.vue`, replace the `useSiteSettings` line with:

```ts
const {
  videoEnabled,
  homeHeroTitle,
  homeHeroSubtitle,
  homeHeroCtaLabel,
  homeHeroCtaUrl,
  homeFeaturedRegionSlugs,
  homeHotTagLimit,
} = useSiteSettings()
```

Import helpers:

```ts
import { collectRegionGuideItems } from '~/utils/galleryPresentation'
```

Replace `hotTags` computed with:

```ts
const regionGuideItems = computed(() => {
  if (!tagsData.value?.data) return []
  return collectRegionGuideItems(tagsData.value.data, homeFeaturedRegionSlugs.value, 4)
})

const hotTags = computed(() => {
  if (!tagsData.value?.data) return []
  const all: Array<{ id: string; name: string; slug: string; type: string }> = []
  for (const [type, items] of Object.entries(tagsData.value.data)) {
    if (['region', 'region_scope', 'region_group', 'city', 'city_country'].includes(type)) continue
    for (const item of items.slice(0, 4)) {
      all.push({ ...item, type })
    }
  }
  return all.slice(0, homeHotTagLimit.value)
})
```

- [ ] **Step 2: Replace homepage template structure**

Replace the root template body inside `packages/web/app/pages/index.vue` with this section order:

```vue
<div class="mx-auto max-w-7xl px-4 py-5 pb-24 lg:px-6 lg:py-8">
  <HomeEditorialHero
    :title="homeHeroTitle"
    :subtitle="homeHeroSubtitle"
    :cta-label="homeHeroCtaLabel"
    :cta-url="homeHeroCtaUrl"
    :gallery="featured[0] || null"
  />

  <section v-if="regionGuideItems.length > 0" class="mt-6 lg:mt-8">
    <RegionGuide :regions="regionGuideItems" />
  </section>

  <section class="mt-8 lg:mt-10">
    <EditorialSectionHeading eyebrow="Featured" title="精选专题" description="以封面质感和人物气质为主线，进入本周推荐内容。" action-label="查看全部" action-to="/discover" />
    <template v-if="galleriesData">
      <HomeFeatured :galleries="featured" />
    </template>
    <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div v-for="i in 3" :key="i" class="aspect-video animate-pulse rounded-[1.5rem] bg-orange-50" />
    </div>
  </section>

  <section class="mt-8 lg:mt-10">
    <EditorialSectionHeading eyebrow="New Arrival" title="最新图库" description="持续更新授权写真、时尚、生活与艺术类图库。" action-label="查看全部" action-to="/discover" />
    <template v-if="galleriesData">
      <GalleryGrid :galleries="latest" variant="magazine" />
      <div v-if="latest.length === 0" class="rounded-[1.5rem] border border-orange-100 bg-white/80 py-20 text-center text-gray-400">暂无图库内容</div>
      <div v-if="loadingMore" class="py-6 text-center text-sm text-gray-400">加载中...</div>
      <div v-if="hasMore" ref="sentinel" class="h-px" />
      <div v-if="!hasMore && allGalleries.length > PAGE_SIZE" class="py-6 text-center text-sm text-gray-400">已展示全部图库</div>
    </template>
  </section>

  <section v-if="hotTags.length > 0 || !tagsData" class="mt-8 lg:mt-10">
    <EditorialSectionHeading eyebrow="Style Tags" title="风格标签" description="用标签补充筛选人物气质、服饰、场景和内容类型。" />
    <div v-if="tagsData" class="flex flex-wrap gap-2">
      <NuxtLink v-for="tag in hotTags" :key="tag.slug" :to="`/discover?tag=${tag.slug}`">
        <TagChip :tag="tag" />
      </NuxtLink>
    </div>
    <div v-else class="flex flex-wrap gap-2">
      <div v-for="i in 8" :key="i" class="h-6 w-14 animate-pulse rounded-full bg-orange-50" />
    </div>
  </section>

  <section v-if="videoEnabled && videoGalleries.length > 0" class="mt-8 lg:mt-10">
    <EditorialSectionHeading eyebrow="Video" title="视频专区" description="视频功能开启后展示可浏览的视频内容。" action-label="查看视频" action-to="/discover?tag=video" />
    <HomeVideoZone :galleries="videoGalleries" />
  </section>
</div>
```

- [ ] **Step 3: Refine existing homepage visual components**

In `HomeFeatured.vue`, keep the existing layout but ensure the first card uses `lg:h-[390px]`, rounded `[2rem]`, and text label `Featured Portrait` instead of bare `Featured`.

In `HomeVideoZone.vue`, keep the dark panel and increase top-level padding from `p-4` to `p-5`, then ensure all video cards have `rounded-[1.25rem]`.

- [ ] **Step 4: Verify homepage build**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/web/app/pages/index.vue packages/web/app/components/HomeFeatured.vue packages/web/app/components/HomeVideoZone.vue
git commit -m "feat: 重构首页杂志化布局"
git push origin dev
```

---

## Task 4: Discover and Search Redesign

**Files:**
- Modify: `packages/web/app/components/TagFilterTabs.vue`
- Modify: `packages/web/app/components/FilterBar.vue`
- Modify: `packages/web/app/pages/discover.vue`
- Modify: `packages/web/app/pages/search.vue`

- [ ] **Step 1: Make `TagFilterTabs` region-first**

In `packages/web/app/components/TagFilterTabs.vue`, replace `typeKeys` with:

```ts
const priorityTypes = ['region_scope', 'region_group', 'city_country', 'region', 'city']
const typeKeys = computed(() => {
  const keys = Object.keys(props.tags).filter(k => props.tags[k]?.length > 0)
  return keys.sort((a, b) => {
    const ai = priorityTypes.includes(a) ? priorityTypes.indexOf(a) : 100
    const bi = priorityTypes.includes(b) ? priorityTypes.indexOf(b) : 100
    return ai - bi
  })
})
```

Replace the template wrapper with a card:

```vue
<div class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 p-4 shadow-sm shadow-orange-950/5 backdrop-blur">
  <div class="flex gap-2 overflow-x-auto border-b border-[#f0e4d8] pb-3 text-sm scrollbar-hide">
    <button v-for="key in typeKeys" :key="key" class="whitespace-nowrap rounded-full px-3 py-1.5 transition-all" :class="activeType === key ? 'bg-gray-950 text-white shadow-sm' : 'text-gray-500 hover:bg-orange-50 hover:text-gray-950'" @click="activeType = key">
      {{ typeLabels[key] || key }}
    </button>
  </div>
  <div class="mt-3 flex flex-wrap gap-2">
    <button v-for="tag in activeTags" :key="tag.id" class="rounded-full border px-3 py-1 text-xs transition-all" :class="selectedSlugs.includes(tag.slug) ? 'border-gray-950 bg-gray-950 text-white' : 'border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed]'" @click="emit('toggle', tag.slug)">
      {{ tag.name }}
    </button>
  </div>
  <div v-if="selectedSlugs.length > 0" class="mt-3 flex items-center gap-2 border-t border-[#f0e4d8] pt-3">
    <span class="text-xs text-gray-400">筛选：</span>
    <span v-for="st in selectedTagNames" :key="st.slug" class="flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs text-gray-800 ring-1 ring-[#eadfd2]">
      {{ st.name }}
      <button class="hover:text-gray-950" @click="emit('toggle', st.slug)">✕</button>
    </span>
    <button class="ml-auto text-xs text-gray-400 hover:text-gray-700" @click="emit('clear')">清除全部</button>
  </div>
</div>
```

Style active tabs as `bg-gray-950 text-white`, inactive tabs as `text-gray-500 hover:bg-orange-50 hover:text-gray-950`.

- [ ] **Step 2: Update `FilterBar` visual hierarchy**

In `packages/web/app/components/FilterBar.vue`, wrap content with:

```vue
<div class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 p-4 shadow-sm shadow-orange-950/5">
  <div class="space-y-3">
    <div v-for="(items, type) in tags" :key="type" class="flex flex-wrap items-center gap-2">
      <span class="w-20 shrink-0 text-xs font-medium text-gray-500">{{ tagTypeLabels[type as string] || type }}</span>
      <button v-for="tag in items" :key="tag.slug" :class="['rounded-full border px-3 py-1 text-xs transition-all', selectedTags.includes(tag.slug) ? 'border-gray-950 bg-gray-950 text-white shadow-sm' : 'border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed]']" @click="emit('toggle', tag.slug)">
        {{ tag.name }}
      </button>
    </div>
    <button v-if="selectedTags.length > 0" class="text-xs text-gray-500 hover:text-[#111] hover:underline" @click="emit('clear')">
      清除全部筛选
    </button>
  </div>
</div>
```

Set selected tag button class to `border-gray-950 bg-gray-950 text-white shadow-sm`; set inactive class to `border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed]`.

- [ ] **Step 3: Update discover page hero and sort section**

In `packages/web/app/pages/discover.vue`, import helper:

```ts
import { collectRegionGuideItems } from '~/utils/galleryPresentation'
```

Add computed after `tags`:

```ts
const regionGuideItems = computed(() => collectRegionGuideItems(tags.value, [], 4))
```

Replace the template root with a hero, region guide, sticky filter, results bar, then gallery:

```vue
<div class="mx-auto max-w-7xl px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-8">
  <section class="mb-6 rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-7 shadow-xl shadow-orange-950/6 lg:px-8">
    <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Discover</p>
    <h1 class="mt-3 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">按地区和风格发现图库</h1>
    <p class="mt-3 max-w-2xl text-sm leading-7 text-gray-600">地区是浏览主线，标签用于细化人物气质、场景和内容类型。</p>
  </section>

  <section v-if="regionGuideItems.length" class="mb-6">
    <RegionGuide :regions="regionGuideItems" compact />
  </section>

  <div class="sticky top-14 z-10 -mx-4 border-y border-white/70 bg-[#fffbf7]/88 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:top-20 lg:-mx-8 lg:px-8">
    <TagFilterTabs :tags="tags" :selected-slugs="selectedSlugs" @toggle="toggleTag" @clear="clearTags" />
  </div>

  <div class="my-5 flex items-center justify-between gap-3">
    <span class="text-sm text-gray-600">共 {{ total }} 个图库</span>
    <div class="flex items-center gap-1 rounded-full border border-[#f0e4d8] bg-white p-1 shadow-sm">
      <button v-for="opt in sortOptions" :key="opt.value" class="rounded-full px-3 py-1.5 text-sm transition-all" :class="sortBy === opt.value ? 'bg-gray-950 text-white shadow-sm' : 'text-gray-600 hover:bg-orange-50 hover:text-gray-950'" @click="setSort(opt.value)">
        {{ opt.label }}
      </button>
    </div>
  </div>

  <div v-if="isInitialLoading" class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4">
    <div v-for="i in 12" :key="i">
      <div class="aspect-[3/4] animate-pulse rounded-[1.25rem] bg-orange-50" />
      <div class="mt-2 h-4 w-3/4 animate-pulse rounded bg-orange-50" />
      <div class="mt-1 flex gap-1">
        <div class="h-4 w-10 animate-pulse rounded-full bg-orange-50" />
        <div class="h-4 w-10 animate-pulse rounded-full bg-orange-50" />
      </div>
    </div>
  </div>

  <div v-else-if="galleries.length === 0" class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 py-20 text-center shadow-sm shadow-orange-950/5">
    <p class="mb-4 text-gray-500">没有找到符合条件的图库</p>
    <button v-if="selectedSlugs.length" class="rounded-full bg-gray-950 px-4 py-2 text-sm text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black" @click="clearTags">
      清除筛选
    </button>
  </div>

  <template v-else>
    <GalleryGrid :galleries="galleries" variant="magazine" />
    <div v-if="isLoading" class="py-8 text-center text-gray-400">加载中...</div>
    <div v-if="hasMore" ref="sentinel" class="h-px" />
    <div v-if="!hasMore && galleries.length > 0" class="py-8 text-center text-sm text-gray-400">已加载全部 {{ total }} 个图库</div>
  </template>
</div>
```

- [ ] **Step 4: Update search page layout**

In `packages/web/app/pages/search.vue`, replace the root template with:

```vue
<div class="mx-auto max-w-7xl px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-8">
  <section class="mb-6 rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-7 shadow-xl shadow-orange-950/6 lg:px-8">
    <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Search</p>
    <h1 class="mt-3 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">搜索写真、地区和标签</h1>
    <div class="relative mt-6 max-w-3xl">
      <input :value="keyword" type="text" class="w-full rounded-full border border-[#eadfd2] bg-white px-5 py-4 pr-14 text-base text-gray-900 shadow-sm outline-none transition-all placeholder:text-gray-400 focus:border-[#d6c39a] focus:ring-4 focus:ring-[#f8e7dc]/70" placeholder="输入地区、风格、标题关键词..." @input="keyword = ($event.target as HTMLInputElement).value" @keydown.enter="onSearch(keyword)" />
      <button class="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-gray-950 text-[#d6c39a] transition-all hover:-translate-y-[52%] hover:bg-black" @click="onSearch(keyword)">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
      </button>
    </div>
  </section>

  <div v-if="tagsData?.data" class="mb-6">
    <FilterBar :tags="tagsData.data" :selected-tags="selectedTags" @toggle="toggleTag" @clear="clearTags" />
  </div>

  <div v-if="selectedTags.length > 0 || keyword" class="mb-4 flex flex-wrap items-center gap-2">
    <span class="text-sm text-gray-500">当前筛选：</span>
    <span v-if="keyword" class="rounded-full border border-[#eadfd2] bg-white px-3 py-1 text-xs text-gray-800">关键词：{{ keyword }}</span>
    <span v-for="slug in selectedTags" :key="slug" class="rounded-full border border-[#eadfd2] bg-white px-3 py-1 text-xs text-gray-800">
      {{ slug }}
      <button class="ml-1 text-gray-400 hover:text-gray-700" @click="toggleTag(slug)">&times;</button>
    </span>
  </div>

  <div v-if="relatedTags.length > 0" class="mb-5 flex flex-wrap items-center gap-2">
    <span class="mr-1 text-sm text-gray-500">相关标签：</span>
    <button v-for="tag in relatedTags" :key="tag.id" class="rounded-full border border-transparent bg-[#f8e7dc]/55 px-3 py-1 text-xs text-gray-700 transition-all hover:border-[#e8d5c5] hover:bg-[#fff7ed] hover:text-gray-950" @click="goToTag(tag.slug)">
      {{ tag.name }}
    </button>
  </div>

  <div class="mb-5 flex items-center justify-between gap-3">
    <p class="text-sm text-gray-500">共 {{ total }} 个结果</p>
    <select v-model="sort" class="rounded-full border border-[#eadfd2] bg-white px-3 py-2 text-sm outline-none focus:border-[#d6c39a] focus:ring-4 focus:ring-[#f8e7dc]/70" @change="page = 1; updateUrl()">
      <option value="relevance">综合</option>
      <option value="newest">最新</option>
      <option value="popular">最热</option>
    </select>
  </div>

  <div v-if="galleries.length > 0" class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4">
    <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
  </div>

  <div v-if="galleries.length === 0" class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 py-20 text-center shadow-sm shadow-orange-950/5">
    <svg class="mx-auto mb-4 h-16 w-16 text-[#e8d5c5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
    <p class="mb-2 text-lg text-gray-600">没有找到相关内容</p>
    <p class="mb-6 text-sm text-gray-400">试试其他关键词或浏览热门标签</p>
    <div class="flex flex-wrap justify-center gap-2">
      <button v-for="tag in popularTags" :key="tag.id" class="rounded-full border border-transparent bg-[#f8e7dc]/55 px-3 py-1 text-xs text-gray-700 transition-all hover:border-[#e8d5c5] hover:bg-[#fff7ed] hover:text-gray-950" @click="goToTag(tag.slug)">
        {{ tag.name }}
      </button>
    </div>
  </div>

  <div v-if="totalPages > 1" class="mt-8 flex justify-center gap-2">
    <button :disabled="page <= 1" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm disabled:opacity-50" @click="page--; updateUrl()">上一页</button>
    <span class="px-3 py-2 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
    <button :disabled="page >= totalPages" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm disabled:opacity-50" @click="page++; updateUrl()">下一页</button>
  </div>
</div>
```

- [ ] **Step 5: Verify and commit Task 4**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

```bash
git add packages/web/app/components/TagFilterTabs.vue packages/web/app/components/FilterBar.vue packages/web/app/pages/discover.vue packages/web/app/pages/search.vue
git commit -m "feat: 升级发现和搜索浏览体验"
git push origin dev
```

---

## Task 5: Gallery Detail Redesign

**Files:**
- Modify: `packages/web/app/pages/gallery/[slug].vue`
- Modify: `packages/web/app/components/MediaLock.vue`
- Modify: `packages/web/app/components/RelatedGalleries.vue`

- [ ] **Step 1: Add detail display helpers**

In `packages/web/app/pages/gallery/[slug].vue`, import helpers:

```ts
import { getPrimaryRegion, getSupportTags } from '~/utils/galleryPresentation'
```

Add computed values after `formattedDate`:

```ts
const primaryRegion = computed(() => gallery.value ? getPrimaryRegion(gallery.value.tags) : null)
const supportTags = computed(() => gallery.value ? getSupportTags(gallery.value.tags, 8) : [])
```

- [ ] **Step 2: Replace cover and title section**

Replace the breadcrumb through summary blocks with:

```vue
<BreadcrumbNav :items="breadcrumbs" class="mb-4" />

<section class="mb-8 overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] shadow-2xl shadow-orange-950/8 lg:grid lg:grid-cols-[1.2fr_0.8fr]">
  <div class="relative aspect-[4/5] overflow-hidden bg-gradient-to-br from-orange-50 to-stone-100 lg:aspect-auto lg:min-h-[34rem]">
    <img v-if="gallery.coverUrl" :src="gallery.coverUrl" :alt="gallery.title" class="h-full w-full object-cover" />
    <div v-else class="h-full w-full bg-gradient-to-br from-[#f8e7dc] to-[#fff7ed]" />
    <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-950/70 to-transparent p-5 text-white lg:hidden">
      <p v-if="primaryRegion" class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6c39a]">{{ primaryRegion.name }}</p>
      <h1 class="mt-2 text-2xl font-semibold tracking-tight">{{ gallery.title }}</h1>
    </div>
  </div>
  <div class="relative flex flex-col justify-end p-6 lg:p-8">
    <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Gallery Detail</p>
    <h1 class="mt-4 hidden text-4xl font-semibold tracking-[-0.055em] text-gray-950 lg:block">{{ gallery.title }}</h1>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <NuxtLink v-if="primaryRegion" :to="`/discover?tag=${primaryRegion.slug}`" class="rounded-full bg-gray-950 px-3 py-1 text-xs font-medium text-[#d6c39a]">{{ primaryRegion.name }}</NuxtLink>
      <TagChip v-for="tag in supportTags" :key="tag.id" :tag="tag" linkable />
      <MembershipBadge v-if="gallery.requiredLevelRank > 0" :rank="gallery.requiredLevelRank" />
    </div>
    <p class="mt-4 text-xs text-gray-400">{{ formattedDate }}<span v-if="images.length"> · {{ images.length }}张图片</span><span v-if="videos.length"> · {{ videos.length }}个视频</span></p>
    <p v-if="gallery.summary" class="mt-5 text-sm leading-7 text-gray-600">{{ gallery.summary }}</p>
  </div>
</section>
```

- [ ] **Step 3: Upgrade image grid and sidebar card**

Set public image cells to `rounded-[1.25rem] shadow-sm shadow-orange-950/5 ring-1 ring-white/80` and grid gap to `gap-3`.

Replace the membership guide aside card with:

```vue
<div class="overflow-hidden rounded-[1.5rem] border border-[#eadfd2] bg-[#fffbf7] p-5 shadow-sm shadow-orange-950/5">
  <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">Membership</p>
  <h3 class="mt-2 text-base font-semibold text-gray-950">解锁完整内容</h3>
  <p class="mt-2 text-xs leading-5 text-gray-600">成为会员即可查看高清图片、完整图库和受保护内容。</p>
  <NuxtLink :to="isLoggedIn ? '/user' : '/login'" class="mt-4 block rounded-full bg-gray-950 px-4 py-2.5 text-center text-sm font-medium text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black">
    {{ isLoggedIn ? '查看会员权益' : '登录 / 注册' }}
  </NuxtLink>
</div>
```

- [ ] **Step 4: Verify and commit Task 5**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

```bash
git add packages/web/app/pages/gallery/[slug].vue packages/web/app/components/MediaLock.vue packages/web/app/components/RelatedGalleries.vue
git commit -m "feat: 升级图库详情杂志化排版"
git push origin dev
```

---

## Task 6: User, About, and Auth Page Unification

**Files:**
- Modify: `packages/web/app/pages/user.vue`
- Modify: `packages/web/app/pages/about.vue`
- Modify: `packages/web/app/pages/login.vue`
- Modify: `packages/web/app/pages/register.vue`
- Modify: `packages/web/app/pages/forgot-password.vue`

- [ ] **Step 1: Upgrade user center shell**

In `packages/web/app/pages/user.vue`, change root wrapper to:

```vue
<div class="mx-auto max-w-3xl px-4 py-6 pb-24 sm:pb-8">
```

Change user info card class to:

```vue
<div class="mb-4 overflow-hidden rounded-[1.5rem] border border-white/80 bg-white/86 p-6 shadow-sm shadow-orange-950/5">
```

Change benefits card class to:

```vue
<div class="mb-4 rounded-[1.5rem] border border-[#f0e4d8] bg-[#fffbf7] p-6 shadow-sm shadow-orange-950/5">
```

Change function entry card class to:

```vue
<div class="mb-4 overflow-hidden rounded-[1.5rem] border border-gray-100 bg-white/90 shadow-sm shadow-orange-950/5">
```

- [ ] **Step 2: Upgrade about page shell**

In `packages/web/app/pages/about.vue`, change the hero card class to:

```vue
<div class="relative overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] px-6 py-10 shadow-2xl shadow-orange-950/8 lg:px-12 lg:py-14">
```

Change the article class to:

```vue
<article class="about-content mt-8 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 px-6 py-8 shadow-sm shadow-orange-950/5 lg:px-10 lg:py-10" v-html="renderedContent" />
```

- [ ] **Step 3: Upgrade auth pages consistently**

For `packages/web/app/pages/login.vue`, `packages/web/app/pages/register.vue`, and `packages/web/app/pages/forgot-password.vue`, preserve each file's existing `<form>`, input fields, Turnstile component, submit handler, and cross-page links. Use these page titles and descriptions inside the new shell:

| File | Title | Description |
|------|-------|-------------|
| `packages/web/app/pages/login.vue` | 登录 MeiGallery | 登录后查看会员状态和受保护内容。 |
| `packages/web/app/pages/register.vue` | 注册账号 | 创建账号后可查看免费内容和会员状态。 |
| `packages/web/app/pages/forgot-password.vue` | 找回密码 | 输入注册邮箱后继续完成密码重置流程。 |

Change the first template wrapper in each file from `class="-mt-14 min-h-screen flex items-center justify-center bg-gray-50 px-4"` to:

```vue
class="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md items-center px-4 py-10"
```

Change the first inner card in each file from `class="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8"` to:

```vue
class="w-full overflow-hidden rounded-[2rem] border border-white/80 bg-white/90 p-6 shadow-2xl shadow-orange-950/8 ring-1 ring-[#f8e7dc]/70"
```

Replace the top `h1` and subtitle in each file using this exact mapping:

```vue
<!-- login.vue -->
<p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">MeiGallery</p>
<h1 class="mt-3 text-2xl font-semibold tracking-tight text-gray-950">登录 MeiGallery</h1>
<p class="mb-8 mt-2 text-sm text-gray-500">登录后查看会员状态和受保护内容。</p>

<!-- register.vue -->
<p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">MeiGallery</p>
<h1 class="mt-3 text-2xl font-semibold tracking-tight text-gray-950">注册账号</h1>
<p class="mb-8 mt-2 text-sm text-gray-500">创建账号后可查看免费内容和会员状态。</p>

<!-- forgot-password.vue -->
<p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">MeiGallery</p>
<h1 class="mt-3 text-2xl font-semibold tracking-tight text-gray-950">找回密码</h1>
<p class="mb-8 mt-2 text-sm text-gray-500">输入注册邮箱后继续完成密码重置流程。</p>
```

Set primary submit buttons to `rounded-full bg-gray-950 text-[#d6c39a] hover:bg-black` while preserving disabled states.

- [ ] **Step 4: Verify and commit Task 6**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

```bash
git add packages/web/app/pages/user.vue packages/web/app/pages/about.vue packages/web/app/pages/login.vue packages/web/app/pages/register.vue packages/web/app/pages/forgot-password.vue
git commit -m "style: 统一前台用户和认证页面视觉"
git push origin dev
```

---

## Task 7: Final Verification and Deployment

**Files:**
- Verify all changed files from Tasks 1-6.

- [ ] **Step 1: Run required verification commands**

Run: `pnpm --filter @meigallery/api exec vitest run src/utils/site-settings.test.ts`

Expected: PASS with 2 tests passing.

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: Build complete.

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected if existing dependency issue remains: FAIL only with `tinybench` `addEventListener` and `removeEventListener` declaration errors from `node_modules/.pnpm/tinybench@2.9.0/...`. If any project source file appears in the errors, stop and fix before deploy.

- [ ] **Step 2: Production smoke checks before deploy**

Run local preview if available:

```bash
pnpm --filter @meigallery/web exec nuxt build
```

Expected: Build complete.

Manually inspect these routes in local dev or deployed preview after deployment:

```text
/
/discover
/search
/about
/user
/login
/gallery/加拿大-渥太华新晋-02-年
```

Pass criteria:
- No horizontal overflow at 375px, 768px, and 1440px.
- Mobile bottom Tab does not cover primary buttons or infinite-load sentinel content.
- Floating contact button stays above mobile bottom Tab.
- Gallery detail page does not expose protected media URLs beyond existing authorized thumbnails and access flow.

- [ ] **Step 3: Apply D1 migration to production**

Run the D1 remote migration from the API package:

```bash
pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote
```

Expected: migration `0012_homepage_editorial_settings.sql` applies once and leaves existing settings untouched because it uses `INSERT OR IGNORE`.

- [ ] **Step 4: Deploy API if Task 1 changed settings API**

Run: `pnpm --filter @meigallery/api exec wrangler deploy`

Expected: Wrangler uploads and returns a new API Worker version.

- [ ] **Step 5: Deploy Web**

Run: `pnpm --filter @meigallery/web exec wrangler deploy`

Expected: Wrangler uploads static assets and returns a new Web Worker version for `616618.xyz` and `www.616618.xyz`.

- [ ] **Step 6: Production smoke checks after deploy**

Fetch production pages:

```bash
curl -I https://616618.xyz
curl -I https://616618.xyz/discover
curl -I https://616618.xyz/search
curl -I https://616618.xyz/about
```

Expected: each returns HTTP 200 or 3xx handled by Cloudflare routing.

Open in browser:

```text
https://616618.xyz
https://616618.xyz/discover
https://616618.xyz/search
https://616618.xyz/about
```

Pass criteria:
- Homepage shows magazine hero and region guide.
- Discover page filter is usable and URL sync still works with `?tag=`.
- Search page returns results and pagination still works.
- About page renders Markdown safely.

- [ ] **Step 7: Final commit if verification fixes were made**

If verification required any fixes after Task 6, commit them:

```bash
git add packages/api packages/web
git commit -m "fix: 修复前台整体视觉升级验证问题"
git push origin dev
```

If no files changed, do not create an empty commit.

---

## Self-Review Checklist

- PRD coverage: Task 1 covers backend configuration; Tasks 2-6 cover homepage, regions, tags, discover, search, detail, user, about, and auth pages; Task 7 covers verification and deploy.
- Security coverage: Task 1 uses settings whitelist and no raw HTML; Task 5 preserves existing media authorization flow; Task 7 checks protected media URL exposure.
- Scope control: No online payment, no Stream integration, no user upload, no new infrastructure.
- Responsive coverage: Task 7 includes 375px, 768px, and 1440px checks.
