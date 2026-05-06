# Facebook 像素广告归因 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MeiGallery 前台实现可后台配置、生产可控、dev 默认隔离的 Meta Pixel 广告归因事件。

**Architecture:** API 侧新增 Pixel 站点设置和 Pixel ID 校验；Web 侧新增纯工具、统一 composable 和 client plugin，集中加载 `fbevents.js`、发送 `PageView` 和业务事件。业务页面只调用 composable，不直接访问 `window.fbq`，并在发送前统一脱敏。

**Tech Stack:** Cloudflare D1、Hono、Nuxt 4/Vue 3、Tailwind CSS v4、Nuxt UI、Vitest、Wrangler、Meta Pixel。

---

## 文件结构

- Create: `packages/api/migrations/0015_facebook_pixel_settings.sql`，新增 Facebook Pixel 站点设置默认值。
- Create: `packages/api/src/utils/facebook-pixel-settings.ts`，Pixel ID 和布尔设置校验工具。
- Create: `packages/api/src/utils/facebook-pixel-settings.test.ts`，API 设置校验测试。
- Modify: `packages/api/src/utils/site-settings.ts`，加入 Facebook Pixel setting keys。
- Modify: `packages/api/src/utils/site-settings.test.ts`，覆盖 Pixel keys。
- Modify: `packages/api/src/routes/admin/settings.ts`，保存设置前校验 Pixel ID 并归一化布尔值。
- Modify: `packages/web/nuxt.config.ts`，新增 dev Pixel 运行时隔离配置。
- Create: `packages/web/app/utils/facebookPixel.ts`，Pixel 配置解析、路径判断和文本脱敏工具。
- Create: `packages/web/app/composables/useFacebookPixel.ts`，统一加载和发送 Pixel 事件。
- Create: `packages/web/app/plugins/facebook-pixel.client.ts`，初始化 Pixel 并监听公开路由 PageView。
- Modify: `packages/web/app/composables/useSiteSettings.ts`，暴露 Pixel settings computed。
- Modify: `packages/web/app/pages/admin/settings.vue`，新增 Pixel 后台配置区。
- Modify: `packages/web/app/pages/gallery/[slug].vue`，图库详情触发 `ViewContent`。
- Modify: `packages/web/app/pages/search.vue`，搜索和筛选触发 `Search`、`filter_selected`。
- Modify: `packages/web/app/pages/discover.vue`，发现页筛选触发 `filter_selected`。
- Modify: `packages/web/app/components/ContactPanel.vue`，首次展开或激活联系方式触发 `Lead`。
- Modify: `packages/web/app/components/ContactMethodItem.vue`，向父组件 emit 脱敏后的联系方式类型。
- Modify: `packages/web/app/pages/register.vue`，注册成功后触发 `CompleteRegistration`。
- Modify: `packages/web/app/pages/login.vue`，登录成功后触发 `login_completed`。

---

### Task 1: API 设置、校验与 migration

**Files:**
- Create: `packages/api/migrations/0015_facebook_pixel_settings.sql`
- Create: `packages/api/src/utils/facebook-pixel-settings.ts`
- Create: `packages/api/src/utils/facebook-pixel-settings.test.ts`
- Modify: `packages/api/src/utils/site-settings.ts`
- Modify: `packages/api/src/utils/site-settings.test.ts`
- Modify: `packages/api/src/routes/admin/settings.ts`

- [ ] **Step 1: 编写 Pixel 设置校验测试**

Create `packages/api/src/utils/facebook-pixel-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { normalizeBooleanSetting, normalizeFacebookPixelId } from './facebook-pixel-settings'

describe('Facebook Pixel 设置校验', () => {
  it('允许空 Pixel ID 表示关闭加载', () => {
    expect(normalizeFacebookPixelId('')).toBe('')
    expect(normalizeFacebookPixelId('   ')).toBe('')
  })

  it('只允许 5-30 位数字 Pixel ID', () => {
    expect(normalizeFacebookPixelId('12345')).toBe('12345')
    expect(normalizeFacebookPixelId(' 123456789012345 ')).toBe('123456789012345')
    expect(() => normalizeFacebookPixelId('1234')).toThrow('Facebook Pixel ID 只能填写 5-30 位数字')
    expect(() => normalizeFacebookPixelId('abc12345')).toThrow('Facebook Pixel ID 只能填写 5-30 位数字')
    expect(() => normalizeFacebookPixelId('1234567890123456789012345678901')).toThrow('Facebook Pixel ID 只能填写 5-30 位数字')
  })

  it('归一化布尔设置', () => {
    expect(normalizeBooleanSetting(true)).toBe(true)
    expect(normalizeBooleanSetting(false)).toBe(false)
    expect(normalizeBooleanSetting('true')).toBe(true)
    expect(normalizeBooleanSetting('false')).toBe(false)
    expect(normalizeBooleanSetting('bad')).toBe(false)
  })
})
```

- [ ] **Step 2: 更新 site settings key 测试**

Modify `packages/api/src/utils/site-settings.test.ts` and keep existing tests, then add:

```ts
  it('allows Facebook Pixel settings in admin and public settings', () => {
    const pixelKeys = [
      'facebook_pixel_enabled',
      'facebook_pixel_id',
      'facebook_pixel_debug_enabled',
    ]

    for (const key of pixelKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/utils/facebook-pixel-settings.test.ts src/utils/site-settings.test.ts`

Expected: FAIL，`facebook-pixel-settings.ts` 不存在，Pixel keys 尚未加入。

- [ ] **Step 4: 新增 migration**

Create `packages/api/migrations/0015_facebook_pixel_settings.sql`:

```sql
-- Facebook Pixel 广告归因配置
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('facebook_pixel_enabled', 'false', datetime('now')),
  ('facebook_pixel_id', '""', datetime('now')),
  ('facebook_pixel_debug_enabled', 'false', datetime('now'));
```

- [ ] **Step 5: 新增 Pixel 设置工具**

Create `packages/api/src/utils/facebook-pixel-settings.ts`:

```ts
export function normalizeFacebookPixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  if (!pixelId) return ''
  if (!/^\d{5,30}$/.test(pixelId)) {
    throw new Error('Facebook Pixel ID 只能填写 5-30 位数字')
  }
  return pixelId
}

export function normalizeBooleanSetting(value: unknown) {
  return value === true || value === 'true'
}
```

- [ ] **Step 6: 更新站点设置 key**

Modify `packages/api/src/utils/site-settings.ts` by adding these keys to both arrays after `video_enabled`:

```ts
  'facebook_pixel_enabled', 'facebook_pixel_id', 'facebook_pixel_debug_enabled',
```

- [ ] **Step 7: 更新后台 settings 保存校验**

Modify `packages/api/src/routes/admin/settings.ts` imports:

```ts
import { normalizeBooleanSetting, normalizeFacebookPixelId } from '../../utils/facebook-pixel-settings'
```

Replace body and keys normalization in `patch('/')` with:

```ts
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
```

Keep the existing audit log logic, but change the maps to `Record<string, unknown>`:

```ts
  const oldMap: Record<string, unknown> = {}
  const newMap: Record<string, unknown> = {}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @meigallery/api test -- src/utils/facebook-pixel-settings.test.ts src/utils/site-settings.test.ts`

Expected: PASS，新增 Pixel 设置校验和 setting keys 测试通过。

- [ ] **Step 9: 提交 Task 1**

Run:

```bash
git add packages/api/migrations/0015_facebook_pixel_settings.sql packages/api/src/utils/facebook-pixel-settings.ts packages/api/src/utils/facebook-pixel-settings.test.ts packages/api/src/utils/site-settings.ts packages/api/src/utils/site-settings.test.ts packages/api/src/routes/admin/settings.ts
git commit -m "feat: 新增 Facebook 像素设置"
```

---

### Task 2: Web Pixel 工具、composable 与 plugin

**Files:**
- Modify: `packages/web/nuxt.config.ts`
- Create: `packages/web/app/utils/facebookPixel.ts`
- Create: `packages/web/app/composables/useFacebookPixel.ts`
- Create: `packages/web/app/plugins/facebook-pixel.client.ts`
- Modify: `packages/web/app/composables/useSiteSettings.ts`

- [ ] **Step 1: 更新运行时配置**

Modify `packages/web/nuxt.config.ts` public runtime config:

```ts
      facebookPixelAllowDev: 'false',
      facebookPixelDevId: '',
```

- [ ] **Step 2: 更新站点设置 composable 类型和 computed**

Modify `packages/web/app/composables/useSiteSettings.ts` `SiteSettings` interface:

```ts
    facebook_pixel_enabled?: string | boolean
    facebook_pixel_id?: string
    facebook_pixel_debug_enabled?: string | boolean
```

Add computed values after `videoEnabled`:

```ts
  const facebookPixelEnabled = computed(() => {
    const v = settings.value.facebook_pixel_enabled
    return v === true || v === 'true'
  })
  const facebookPixelId = computed(() => String(settings.value.facebook_pixel_id || '').trim())
  const facebookPixelDebugEnabled = computed(() => {
    const v = settings.value.facebook_pixel_debug_enabled
    return v === true || v === 'true'
  })
```

Return them:

```ts
    facebookPixelEnabled,
    facebookPixelId,
    facebookPixelDebugEnabled,
```

- [ ] **Step 3: 新增 Pixel 纯工具**

Create `packages/web/app/utils/facebookPixel.ts`:

```ts
interface PixelRuntimeConfig {
  public: {
    appEnv?: string
    facebookPixelAllowDev?: string
    facebookPixelDevId?: string
  }
}

interface PixelSiteSettings {
  enabled: boolean
  pixelId: string
  debugEnabled: boolean
}

export function normalizePixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  return /^\d{5,30}$/.test(pixelId) ? pixelId : ''
}

export function isAdminPath(path: string) {
  return path === '/admin' || path.startsWith('/admin/')
}

export function sanitizeAnalyticsText(value: unknown, maxLength = 80) {
  return String(value ?? '')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted_email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted_phone]')
    .replace(/https?:\/\/\S+/g, '[redacted_url]')
    .replace(/(?:token|session|cookie)=[^\s&]+/gi, '[redacted_token]')
    .trim()
    .slice(0, maxLength)
}

export function resolveFacebookPixelConfig(settings: PixelSiteSettings, runtimeConfig: PixelRuntimeConfig) {
  const appEnv = runtimeConfig.public.appEnv || 'development'
  const debugEnabled = settings.debugEnabled

  if (appEnv === 'production') {
    return {
      enabled: settings.enabled && !!normalizePixelId(settings.pixelId),
      pixelId: normalizePixelId(settings.pixelId),
      debugEnabled,
    }
  }

  const allowDev = runtimeConfig.public.facebookPixelAllowDev === 'true'
  const devPixelId = normalizePixelId(runtimeConfig.public.facebookPixelDevId)
  return {
    enabled: allowDev && !!devPixelId,
    pixelId: devPixelId,
    debugEnabled,
  }
}
```

- [ ] **Step 4: 新增 Pixel composable**

Create `packages/web/app/composables/useFacebookPixel.ts`:

```ts
import { isAdminPath, sanitizeAnalyticsText } from '~/utils/facebookPixel'

type PixelEventParams = Record<string, string | number | boolean | string[] | number[] | null | undefined>

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
    _fbq?: unknown
  }
}

const initialized = ref(false)
const debug = ref(false)
const lastTrackedPagePath = ref('')
const leadTracked = ref(false)

function hasTrackingConsent() {
  return true
}

function logEvent(eventName: string, params?: PixelEventParams) {
  if (debug.value) console.info('[facebook-pixel]', eventName, params || {})
}

function callFbq(...args: unknown[]) {
  if (!import.meta.client || !initialized.value || !window.fbq) return
  window.fbq(...args)
}

export function useFacebookPixel() {
  function initFacebookPixel(pixelId: string, debugEnabled = false) {
    if (!import.meta.client || initialized.value || !pixelId || !hasTrackingConsent()) return
    debug.value = debugEnabled

    const fbq = function (...args: unknown[]) {
      // @ts-expect-error Meta Pixel queue uses dynamic properties from the official snippet.
      fbq.callMethod ? fbq.callMethod(...args) : fbq.queue.push(args)
    } as typeof window.fbq & { queue: unknown[]; loaded: boolean; version: string }

    if (!window.fbq) {
      window.fbq = fbq
      window._fbq = fbq
      fbq.queue = []
      fbq.loaded = true
      fbq.version = '2.0'
      const script = document.createElement('script')
      script.async = true
      script.src = 'https://connect.facebook.net/en_US/fbevents.js'
      document.head.appendChild(script)
    }

    window.fbq('init', pixelId)
    initialized.value = true
    logEvent('init', { pixel_id: pixelId })
  }

  function trackPageView(fullPath: string) {
    if (!import.meta.client || isAdminPath(fullPath.split('?')[0] || fullPath)) return
    if (lastTrackedPagePath.value === fullPath) return
    lastTrackedPagePath.value = fullPath
    callFbq('track', 'PageView')
    logEvent('PageView', { full_path: fullPath })
  }

  function trackViewContent(params: { id: string; title: string; requiredRank: number; tags: string[] }) {
    const payload = {
      content_type: 'gallery',
      content_ids: [params.id],
      content_name: sanitizeAnalyticsText(params.title, 80),
      required_rank: params.requiredRank,
      tags: params.tags.slice(0, 8),
    }
    callFbq('track', 'ViewContent', payload)
    logEvent('ViewContent', payload)
  }

  function trackSearch(params: { searchString: string; resultCount: number }) {
    const payload = {
      search_string: sanitizeAnalyticsText(params.searchString, 80),
      result_count: params.resultCount,
    }
    callFbq('track', 'Search', payload)
    logEvent('Search', payload)
  }

  function trackLeadOnce(params: { location: string; methodType: string }) {
    if (leadTracked.value) return
    leadTracked.value = true
    const payload = { location: params.location, method_type: sanitizeAnalyticsText(params.methodType, 40) }
    callFbq('track', 'Lead', payload)
    logEvent('Lead', payload)
  }

  function trackCompleteRegistration() {
    const payload = { method: 'email' }
    callFbq('track', 'CompleteRegistration', payload)
    logEvent('CompleteRegistration', payload)
  }

  function trackLoginCompleted() {
    const payload = { method: 'email' }
    callFbq('trackCustom', 'login_completed', payload)
    logEvent('login_completed', payload)
  }

  function trackFilterSelected(params: { tagSlug: string; tagType: string; location: string }) {
    const payload = { tag_slug: params.tagSlug, tag_type: params.tagType, location: params.location }
    callFbq('trackCustom', 'filter_selected', payload)
    logEvent('filter_selected', payload)
  }

  return {
    initFacebookPixel,
    trackPageView,
    trackViewContent,
    trackSearch,
    trackLeadOnce,
    trackCompleteRegistration,
    trackLoginCompleted,
    trackFilterSelected,
  }
}
```

- [ ] **Step 5: 新增 client plugin**

Create `packages/web/app/plugins/facebook-pixel.client.ts`:

```ts
import { isAdminPath, resolveFacebookPixelConfig } from '~/utils/facebookPixel'

export default defineNuxtPlugin(async () => {
  const route = useRoute()
  const router = useRouter()
  const runtimeConfig = useRuntimeConfig()
  const {
    fetchSettings,
    facebookPixelEnabled,
    facebookPixelId,
    facebookPixelDebugEnabled,
  } = useSiteSettings()
  const { initFacebookPixel, trackPageView } = useFacebookPixel()

  await fetchSettings()

  const config = resolveFacebookPixelConfig({
    enabled: facebookPixelEnabled.value,
    pixelId: facebookPixelId.value,
    debugEnabled: facebookPixelDebugEnabled.value,
  }, runtimeConfig)

  if (config.enabled && !isAdminPath(route.path)) {
    initFacebookPixel(config.pixelId, config.debugEnabled)
    trackPageView(route.fullPath)
  }

  router.afterEach((to) => {
    if (isAdminPath(to.path)) return
    if (config.enabled) trackPageView(to.fullPath)
  })
})
```

- [ ] **Step 6: 运行 Web 构建验证**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。若出现 `@ts-expect-error` 未使用，改为局部 `type FacebookQueueFunction` 明确定义 `callMethod`。

- [ ] **Step 7: 提交 Task 2**

Run:

```bash
git add packages/web/nuxt.config.ts packages/web/app/utils/facebookPixel.ts packages/web/app/composables/useFacebookPixel.ts packages/web/app/plugins/facebook-pixel.client.ts packages/web/app/composables/useSiteSettings.ts
git commit -m "feat: 接入 Facebook 像素基础追踪"
```

---

### Task 3: 后台 Pixel 配置 UI

**Files:**
- Modify: `packages/web/app/pages/admin/settings.vue`

- [ ] **Step 1: 扩展 form 和加载逻辑**

Modify `form` in `packages/web/app/pages/admin/settings.vue`:

```ts
  facebook_pixel_id: '',
```

Add refs:

```ts
const facebookPixelEnabled = ref(false)
const facebookPixelDebugEnabled = ref(false)
```

Inside the settings loading loop, add:

```ts
    if (key === 'facebook_pixel_enabled') {
      facebookPixelEnabled.value = val.value === true || val.value === 'true'
    }
    if (key === 'facebook_pixel_debug_enabled') {
      facebookPixelDebugEnabled.value = val.value === true || val.value === 'true'
    }
```

Modify `onSave()` body:

```ts
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: {
        ...form,
        facebook_pixel_enabled: facebookPixelEnabled.value,
        facebook_pixel_debug_enabled: facebookPixelDebugEnabled.value,
      },
    })
```

- [ ] **Step 2: 新增 Pixel 配置字段集**

Add this fieldset before `功能开关`:

```vue
      <fieldset class="space-y-4">
        <legend class="w-full border-b border-gray-200 pb-2 text-sm font-semibold text-gray-900">Facebook 广告归因</legend>
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">Meta Pixel ID</label>
          <input v-model="form.facebook_pixel_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如 123456789012345" />
          <p class="mt-1 text-xs text-gray-400">只填写数字 Pixel ID；留空或关闭开关时前台不会加载 Facebook Pixel。</p>
        </div>
        <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-4">
          <input v-model="facebookPixelEnabled" type="checkbox" class="mt-1 h-4 w-4 rounded border-gray-300" />
          <span>
            <span class="block text-sm font-medium text-gray-700">启用生产 Pixel</span>
            <span class="mt-0.5 block text-xs text-gray-500">仅生产环境会读取后台 Pixel ID；dev 默认强制禁用正式 Pixel。</span>
          </span>
        </label>
        <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-4">
          <input v-model="facebookPixelDebugEnabled" type="checkbox" class="mt-1 h-4 w-4 rounded border-gray-300" />
          <span>
            <span class="block text-sm font-medium text-gray-700">输出调试日志</span>
            <span class="mt-0.5 block text-xs text-gray-500">仅在浏览器控制台输出已脱敏事件；dev 加载测试 Pixel 仍需环境变量显式允许。</span>
          </span>
        </label>
      </fieldset>
```

- [ ] **Step 3: 运行 Web 构建验证**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

- [ ] **Step 4: 提交 Task 3**

Run:

```bash
git add packages/web/app/pages/admin/settings.vue
git commit -m "feat: 新增 Facebook 像素后台配置"
```

---

### Task 4: 业务事件埋点

**Files:**
- Modify: `packages/web/app/pages/gallery/[slug].vue`
- Modify: `packages/web/app/pages/search.vue`
- Modify: `packages/web/app/pages/discover.vue`
- Modify: `packages/web/app/components/ContactPanel.vue`
- Modify: `packages/web/app/components/ContactMethodItem.vue`
- Modify: `packages/web/app/pages/register.vue`
- Modify: `packages/web/app/pages/login.vue`

- [ ] **Step 1: 图库详情发送 ViewContent**

Modify `packages/web/app/pages/gallery/[slug].vue` script:

```ts
const { trackViewContent } = useFacebookPixel()

onMounted(() => {
  if (!gallery.value || gallery.value.status !== 'published') return
  trackViewContent({
    id: gallery.value.id,
    title: gallery.value.title,
    requiredRank: gallery.value.requiredLevelRank,
    tags: gallery.value.tags.map(tag => tag.slug),
  })
})
```

- [ ] **Step 2: 搜索页发送 Search 和 filter_selected**

Modify `packages/web/app/pages/search.vue` script:

```ts
const { trackSearch, trackFilterSelected } = useFacebookPixel()
const lastTrackedSearchKey = ref('')

function findTagType(slug: string) {
  const groups = tagsData.value?.data || {}
  for (const [type, items] of Object.entries(groups)) {
    if (items.some(tag => tag.slug === slug)) return type
  }
  return 'unknown'
}

function getSearchTrackingKey() {
  return [keyword.value.trim(), selectedTags.value.slice().sort().join(','), sort.value].join('|')
}

watch(searchResult, (result) => {
  if (!result || (!keyword.value.trim() && selectedTags.value.length === 0)) return
  const key = getSearchTrackingKey()
  if (lastTrackedSearchKey.value === key) return
  lastTrackedSearchKey.value = key
  trackSearch({
    searchString: `q=${keyword.value.trim()} tags=${selectedTags.value.join(',')}`,
    resultCount: result.total,
  })
}, { immediate: true })
```

In `toggleTag(slug)`, after `updateUrl()` add:

```ts
  trackFilterSelected({ tagSlug: slug, tagType: findTagType(slug), location: 'search_filter' })
```

In `goToTag(slug)`, before `navigateTo(...)` add:

```ts
  trackFilterSelected({ tagSlug: slug, tagType: findTagType(slug), location: 'search_related_tag' })
```

- [ ] **Step 3: 发现页发送 filter_selected**

Modify `packages/web/app/pages/discover.vue` script:

```ts
const { trackFilterSelected } = useFacebookPixel()

function findTagType(slug: string) {
  const groups = tagsData.value?.data || {}
  for (const [type, items] of Object.entries(groups)) {
    if (items.some(tag => tag.slug === slug)) return type
  }
  return 'unknown'
}
```

In `toggleTag(slug)`, after `updateQuery()` add:

```ts
  trackFilterSelected({ tagSlug: slug, tagType: findTagType(slug), location: 'discover_filter' })
```

- [ ] **Step 4: 联系方式组件向父组件 emit 激活事件**

Modify `packages/web/app/components/ContactMethodItem.vue` script:

```ts
const emit = defineEmits<{ activate: [methodType: string] }>()
```

Modify `activate()`:

```ts
function activate() {
  emit('activate', props.method.platform)
  if (hasQr.value) {
    toggleQr()
    return
  }
  if (!hasLink.value) copyValue()
}
```

- [ ] **Step 5: 联系面板发送 Lead**

Modify `packages/web/app/components/ContactPanel.vue` script:

```ts
const { trackLeadOnce } = useFacebookPixel()

function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    trackLeadOnce({ location: 'floating_contact_panel', methodType: 'panel_open' })
  }
}

function trackContactMethod(methodType: string) {
  trackLeadOnce({ location: 'floating_contact_panel', methodType })
}
```

Modify `ContactMethodItem` usage:

```vue
          <ContactMethodItem
            v-for="method in contactMethods"
            :key="method.id"
            :method="method"
            @activate="trackContactMethod"
          />
```

- [ ] **Step 6: 注册成功发送 CompleteRegistration**

Modify `packages/web/app/pages/register.vue` script:

```ts
const { trackCompleteRegistration } = useFacebookPixel()
```

After each successful `await register(...)`, before navigation, add:

```ts
    trackCompleteRegistration()
```

- [ ] **Step 7: 登录成功发送 login_completed**

Modify `packages/web/app/pages/login.vue` script:

```ts
const { trackLoginCompleted } = useFacebookPixel()
```

After successful `await login(...)`, before navigation, add:

```ts
    trackLoginCompleted()
```

- [ ] **Step 8: 运行 Web 构建验证**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS。

- [ ] **Step 9: 提交 Task 4**

Run:

```bash
git add packages/web/app/pages/gallery/[slug].vue packages/web/app/pages/search.vue packages/web/app/pages/discover.vue packages/web/app/components/ContactPanel.vue packages/web/app/components/ContactMethodItem.vue packages/web/app/pages/register.vue packages/web/app/pages/login.vue
git commit -m "feat: 补充 Facebook 像素业务事件"
```

---

### Task 5: 全量验证与手动验收

**Files:**
- No source edits expected.

- [ ] **Step 1: 运行 API 测试**

Run: `pnpm --filter @meigallery/api test`

Expected: PASS，所有 Vitest 测试通过。

- [ ] **Step 2: 运行 API 类型检查**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: exit 0，无 TypeScript 错误。

- [ ] **Step 3: 运行 Web 构建**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: exit 0；允许 Nitro sourcemap warning，不允许编译失败。

- [ ] **Step 4: 验证 Pixel 关闭状态**

Run local or dev environment with `facebook_pixel_enabled=false` or empty `facebook_pixel_id`.

Expected in browser Network:
- No request to `https://connect.facebook.net/en_US/fbevents.js`.
- No request to `https://www.facebook.com/tr`.

- [ ] **Step 5: 验证 dev 默认隔离**

Run dev Worker with production D1 settings and without `NUXT_PUBLIC_FACEBOOK_PIXEL_ALLOW_DEV=true`.

Expected:
- Page keeps `DEV 测试环境` mark if dev marker task has landed.
- No `fbevents.js` request.
- No `facebook.com/tr` request.

- [ ] **Step 6: 验证 dev 测试 Pixel**

Run dev Worker with:

```bash
NUXT_PUBLIC_FACEBOOK_PIXEL_ALLOW_DEV=true
NUXT_PUBLIC_FACEBOOK_PIXEL_DEV_ID=123456789012345
```

Expected:
- `fbevents.js` loads on public pages.
- `/admin/**` does not load Pixel.
- Meta Pixel Helper shows one `PageView` per public route.

- [ ] **Step 7: 验证业务事件**

Use Meta Events Manager Test Events or browser Network.

Expected:
- Gallery detail emits `ViewContent` without media URLs.
- Search emits `Search` with redacted `search_string` and numeric `result_count`.
- Contact panel first open emits one `Lead` without contact value, link URL, or QR URL.
- Register success emits `CompleteRegistration` after API success only.
- Login success emits `login_completed` after API success only.
- Discover/search tag click emits `filter_selected` with `tag_slug`, `tag_type`, `location`.

- [ ] **Step 8: 提交验证记录**

If verification requires a docs note, append the exact commands and outcomes to the PR description or task comment. Do not change source files only to record local browser observations.

- [ ] **Step 9: 推送分支**

Run: `git push`

Expected: branch pushes to remote without force push.

---

## 自查清单

- PRD 的 7 个事件均有对应实现任务。
- 后台 `/admin/**` 排除在 plugin 和手动验收中均有覆盖。
- dev 默认隔离不依赖 D1 设置，必须通过 runtime env 显式开启 dev/test Pixel。
- Pixel ID 是公开配置，不作为 Worker secret。
- 所有事件都通过 `useFacebookPixel()` 发送，业务页面不直接调用 `window.fbq`。
- `Lead`、`Search` 和 `ViewContent` 均包含隐私过滤规则。
- 本计划不实现 Conversions API、Marketing API、Cookie 同意弹窗或用户级归因。
