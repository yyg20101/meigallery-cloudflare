# MeiGallery MVP 完整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 MeiGallery 图库平台 MVP 全部功能，达到可部署上线状态

**Architecture:** pnpm monorepo（web/api/shared），前端 Nuxt 3 + Tailwind + Nuxt UI v3，后端 Hono on Cloudflare Workers，D1 数据库，R2 对象存储，Stream 视频

**Tech Stack:** Nuxt 3, Hono, Cloudflare Workers/D1/R2/Stream, Tailwind CSS, Nuxt UI v3, Vitest, pnpm

---

## 当前状态

### 已完成
- 文档：PRD、技术规格、UI 设计、部署方案
- monorepo 结构：web + api + shared 三个包
- D1 Schema：12 张表 + sessions 表（2 个迁移文件）
- API 核心路由：auth（注册/登录/登出）、galleries（公开列表/详情）、tags（公开列表）、search（组合搜索）、media（封面/缩略图/受保护访问）、me（当前用户）
- API 管理路由：admin/galleries（CRUD + 发布/下架）、admin/tags（CRUD + 删除）、admin/users（列表/详情/会员发放/角色/状态管理）
- 认证全链路：PBKDF2 密码哈希、D1 会话、Cookie、Turnstile、auth 中间件链
- 工具函数：generateId、getUserEffectiveRank、checkMediaAccess、writeAuditLog
- 构建验证：shared + api 类型检查通过，API Worker 构建成功

### 未完成（按依赖顺序排列的 8 个阶段）

| 阶段 | 内容 | 依赖 |
|------|------|------|
| P1 | API 补全（settings/audit-logs/dashboard） | 无 |
| P2 | 测试基础设施 + 核心单元测试 | 无 |
| P3 | 前端基础设施（API 客户端、Nuxt UI v3、共享组件） | 无 |
| P4 | 前端公开页面（首页/列表/详情/搜索/登录/用户中心） | P3 |
| P5 | 前端管理后台（Dashboard/图库/标签/用户/设置/审计日志） | P3, P1 |
| P6 | 批量导入（API + 前端） | P1, P3 |
| P7 | WordPress 旧站迁移（API + 前端） | P6 |
| P8 | 生产加固（SEO/缓存/错误边界/部署验证） | P4, P5 |

> P1/P2/P3 互相独立可并行；P4/P5 依赖 P3 但彼此可并行；P6 依赖 P1+P3；P7 依赖 P6；P8 最后。

---

## Phase 1: API 补全

### Task 1.1: 管理员 Dashboard 统计接口

**Files:**
- Modify: `packages/api/src/routes/admin/index.ts`

- [ ] **Step 1: 在 admin/index.ts 添加 dashboard 路由**

在已有的 admin 路由入口中添加 GET `/` dashboard 统计接口：

```typescript
// 在 admin/index.ts 中，requireAdmin 中间件之后添加
adminRoutes.get('/dashboard', async (c) => {
  const db = c.env.DB

  const [galleries, published, users, vipUsers, importJobs] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM galleries').first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM galleries WHERE status = 'published'").first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(DISTINCT um.user_id) as count
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE ml.rank > 0 AND datetime('now') BETWEEN um.starts_at AND um.expires_at
    `).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM import_jobs WHERE status = 'processing'").first<{ count: number }>(),
  ])

  return c.json({
    totalGalleries: galleries?.count ?? 0,
    publishedGalleries: published?.count ?? 0,
    totalUsers: users?.count ?? 0,
    activeVipUsers: vipUsers?.count ?? 0,
    processingImports: importJobs?.count ?? 0,
  })
})
```

- [ ] **Step 2: 验证构建通过**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/admin/index.ts
git commit -m "feat(api): 添加管理员 dashboard 统计接口"
```

### Task 1.2: 站点设置 API

**Files:**
- Rewrite: `packages/api/src/routes/admin/settings.ts`

- [ ] **Step 1: 实现 GET/PATCH 站点设置**

```typescript
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/permission'

export const adminSettingsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 允许修改的 key 白名单
const ALLOWED_KEYS = [
  'site_name', 'seo_title', 'membership_description',
  'contact_wechat', 'contact_telegram', 'contact_email', 'contact_custom_note',
]

/**
 * GET / - 获取全部站点设置（Owner 才能查看）
 */
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

/**
 * PATCH / - 批量更新设置（Owner 才能修改）
 * Body: { [key]: value, ... }
 */
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

  // 逐个更新（D1 不支持批量 upsert）
  for (const key of keys) {
    await db
      .prepare('UPDATE site_settings SET value = ?, updated_at = datetime(\'now\') WHERE key = ?')
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
```

- [ ] **Step 2: 验证构建**
- [ ] **Step 3: Commit**

### Task 1.3: 审计日志查询 API

**Files:**
- Rewrite: `packages/api/src/routes/admin/audit-logs.ts`

- [ ] **Step 1: 实现审计日志列表（Admin 看自己，Owner 看全部）**

```typescript
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminAuditLogRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET / - 审计日志列表
 * Admin 只能查看自己的操作，Owner 查看全部
 * 查询参数：page, pageSize, action?, targetType?
 */
adminAuditLogRoutes.get('/', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const userRole = c.get('userRole')!
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )
  const offset = (page - 1) * pageSize
  const filterAction = c.req.query('action')
  const filterTargetType = c.req.query('targetType')

  const conditions: string[] = []
  const params: unknown[] = []

  // Admin 只能看自己的日志
  if (userRole !== 'owner') {
    conditions.push('al.admin_id = ?')
    params.push(userId)
  }

  if (filterAction) {
    conditions.push('al.action = ?')
    params.push(filterAction)
  }

  if (filterTargetType) {
    conditions.push('al.target_type = ?')
    params.push(filterTargetType)
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM admin_audit_logs al ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  const logs = await db
    .prepare(`
      SELECT al.id, al.admin_id, u.email as admin_email, u.nickname as admin_nickname,
             al.action, al.target_type, al.target_id, al.before_value, al.after_value, al.created_at
      FROM admin_audit_logs al
      JOIN users u ON al.admin_id = u.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params, pageSize, offset)
    .all()

  return c.json({ data: logs.results, total, page, pageSize })
})
```

- [ ] **Step 2: 验证构建**
- [ ] **Step 3: Commit**

### Task 1.4: 公开站点设置接口（前端用）

**Files:**
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: 添加 GET /api/settings/public 接口**

在 index.ts 中添加一个公开的站点信息接口（不需要登录）：

```typescript
// 在 index.ts 路由挂载区域添加
app.get('/api/settings/public', async (c) => {
  const db = c.env.DB
  const keys = ['site_name', 'seo_title', 'membership_description',
                'contact_wechat', 'contact_telegram', 'contact_email', 'contact_custom_note']
  const placeholders = keys.map(() => '?').join(',')
  const result = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()

  const settings: Record<string, string> = {}
  for (const row of result.results) {
    settings[row.key] = JSON.parse(row.value)
  }
  return c.json(settings)
})
```

- [ ] **Step 2: 验证构建 + Commit**

---

## Phase 2: 测试基础设施

### Task 2.1: Vitest 配置

**Files:**
- Create: `packages/api/vitest.config.ts`
- Modify: `packages/api/package.json`

- [ ] **Step 1: 安装 vitest**

```bash
pnpm --filter @meigallery/api add -D vitest
```

- [ ] **Step 2: 创建 vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/utils/**', 'src/middleware/**'],
    },
  },
  resolve: {
    alias: {
      '@meigallery/shared/constants': '../shared/src/constants/index.ts',
      '@meigallery/shared': '../shared/src/types/index.ts',
    },
  },
})
```

- [ ] **Step 3: 在 package.json 添加 test script**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Commit**

### Task 2.2: 密码工具测试

**Files:**
- Create: `packages/api/src/utils/password.test.ts`

- [ ] **Step 1: 编写测试**

```typescript
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  it('哈希后可验证通过', async () => {
    const hash = await hashPassword('Test1234!')
    const valid = await verifyPassword('Test1234!', hash)
    expect(valid).toBe(true)
  })

  it('错误密码验证失败', async () => {
    const hash = await hashPassword('Test1234!')
    const valid = await verifyPassword('Wrong1234!', hash)
    expect(valid).toBe(false)
  })

  it('哈希格式正确', async () => {
    const hash = await hashPassword('Test1234!')
    expect(hash).toMatch(/^\$pbkdf2\$\d+\$.+\$.+$/)
  })

  it('相同密码生成不同哈希（salt 不同）', async () => {
    const h1 = await hashPassword('Test1234!')
    const h2 = await hashPassword('Test1234!')
    expect(h1).not.toBe(h2)
  })

  it('非法哈希格式返回 false', async () => {
    expect(await verifyPassword('test', 'invalid_hash')).toBe(false)
    expect(await verifyPassword('test', '$argon2$xxx$yyy$zzz')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认通过**

Run: `pnpm --filter @meigallery/api test`

- [ ] **Step 3: Commit**

### Task 2.3: 权限工具测试

**Files:**
- Create: `packages/api/src/utils/permission.test.ts`

- [ ] **Step 1: 编写 mock D1 + 权限测试**

测试 `getUserEffectiveRank` 和 `checkMediaAccess` 的逻辑。需要 mock D1 的 prepare/bind/first 链。

```typescript
import { describe, it, expect, vi } from 'vitest'
import { getUserEffectiveRank, checkMediaAccess } from './permission'

function createMockDb(firstResult: unknown) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(firstResult),
        run: vi.fn().mockResolvedValue({}),
      }),
    }),
  } as unknown as D1Database
}

describe('getUserEffectiveRank', () => {
  it('有有效会员返回最高 rank', async () => {
    const db = createMockDb({ max_rank: 20 })
    const rank = await getUserEffectiveRank(db, 'usr_123')
    expect(rank).toBe(20)
  })

  it('无有效会员返回 0', async () => {
    const db = createMockDb({ max_rank: null })
    const rank = await getUserEffectiveRank(db, 'usr_123')
    expect(rank).toBe(0)
  })

  it('查询返回 null 返回 0', async () => {
    const db = createMockDb(null)
    const rank = await getUserEffectiveRank(db, 'usr_123')
    expect(rank).toBe(0)
  })
})

describe('checkMediaAccess', () => {
  it('requiredRank=0 直接通过', async () => {
    const db = createMockDb(null) // 不查询
    expect(await checkMediaAccess(db, 'usr_123', 0)).toBe(true)
  })

  it('用户 rank >= required 通过', async () => {
    const db = createMockDb({ max_rank: 20 })
    expect(await checkMediaAccess(db, 'usr_123', 10)).toBe(true)
  })

  it('用户 rank < required 拒绝', async () => {
    const db = createMockDb({ max_rank: 10 })
    expect(await checkMediaAccess(db, 'usr_123', 20)).toBe(false)
  })

  it('无会员访问受保护内容拒绝', async () => {
    const db = createMockDb({ max_rank: null })
    expect(await checkMediaAccess(db, 'usr_123', 10)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试**
- [ ] **Step 3: Commit**

---

## Phase 3: 前端基础设施

### Task 3.1: Nuxt UI v3 集成

**Files:**
- Modify: `packages/web/package.json`
- Modify: `packages/web/nuxt.config.ts`
- Modify: `packages/web/app/assets/css/tailwind.css`

- [ ] **Step 1: 安装 Nuxt UI v3**

```bash
pnpm --filter @meigallery/web add @nuxt/ui
```

- [ ] **Step 2: 修改 nuxt.config.ts 添加模块**

在 `modules` 数组中添加 `'@nuxt/ui'`。后台页面使用 Nuxt UI 组件，前台保持 Tailwind 自定义。

- [ ] **Step 3: 验证 dev 启动正常**

Run: `pnpm --filter @meigallery/web dev`（验证 3000 端口可访问）

- [ ] **Step 4: Commit**

### Task 3.2: API 客户端 composable

**Files:**
- Create: `packages/web/app/composables/useApi.ts`

- [ ] **Step 1: 创建统一 API 客户端**

```typescript
/**
 * 统一 API 客户端
 * 封装 $fetch 调用 API Worker，自动携带 cookie
 */
export function useApi() {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl as string

  async function api<T>(path: string, options?: RequestInit & { query?: Record<string, string> }): Promise<T> {
    const url = new URL(path, baseURL)
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v)
      }
    }

    const response = await $fetch<T>(url.toString(), {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })
    return response
  }

  return { api, baseURL }
}
```

- [ ] **Step 2: Commit**

### Task 3.3: 前台共享组件

**Files:**
- Create: `packages/web/app/components/GalleryCard.vue`
- Create: `packages/web/app/components/TagChip.vue`
- Create: `packages/web/app/components/FilterBar.vue`
- Create: `packages/web/app/components/SearchInput.vue`
- Create: `packages/web/app/components/MediaLock.vue`
- Create: `packages/web/app/components/MembershipBadge.vue`

- [ ] **Step 1: GalleryCard 组件**

图库卡片：展示封面、标题、标签列表、会员标识。Props: gallery（含 id/title/slug/coverUrl/tags/requiredLevelRank/publishedAt）。

```vue
<script setup lang="ts">
interface GalleryCardProps {
  gallery: {
    id: string
    title: string
    slug: string
    coverUrl: string | null
    tags: Array<{ name: string; slug: string; type: string }>
    requiredLevelRank: number
    publishedAt: string | null
  }
}
defineProps<GalleryCardProps>()
</script>

<template>
  <NuxtLink :to="`/gallery/${gallery.slug}`" class="group block overflow-hidden rounded-lg bg-white shadow-sm hover:shadow-md transition-shadow">
    <div class="aspect-[3/4] overflow-hidden bg-gray-100">
      <img
        v-if="gallery.coverUrl"
        :src="gallery.coverUrl"
        :alt="gallery.title"
        class="h-full w-full object-cover transition-transform group-hover:scale-105"
        loading="lazy"
      />
      <div v-else class="flex h-full items-center justify-center text-gray-400">
        <span>暂无封面</span>
      </div>
    </div>
    <div class="p-3">
      <h3 class="text-sm font-medium text-gray-900 line-clamp-1">{{ gallery.title }}</h3>
      <div class="mt-1.5 flex flex-wrap gap-1">
        <TagChip v-for="tag in gallery.tags.slice(0, 3)" :key="tag.slug" :tag="tag" size="sm" />
      </div>
      <MembershipBadge v-if="gallery.requiredLevelRank > 0" :rank="gallery.requiredLevelRank" class="mt-1.5" />
    </div>
  </NuxtLink>
</template>
```

- [ ] **Step 2: TagChip 组件**

```vue
<script setup lang="ts">
interface TagChipProps {
  tag: { name: string; slug: string; type?: string }
  size?: 'sm' | 'md'
  removable?: boolean
}
const props = withDefaults(defineProps<TagChipProps>(), { size: 'md', removable: false })
const emit = defineEmits<{ remove: [] }>()
</script>

<template>
  <span
    :class="[
      'inline-flex items-center rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors',
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
    ]"
  >
    {{ tag.name }}
    <button v-if="removable" class="ml-1 text-gray-400 hover:text-gray-600" @click.prevent="emit('remove')">
      &times;
    </button>
  </span>
</template>
```

- [ ] **Step 3: MembershipBadge 组件**

```vue
<script setup lang="ts">
const props = defineProps<{ rank: number }>()

const label = computed(() => {
  if (props.rank >= 20) return 'SVIP'
  if (props.rank >= 10) return 'VIP'
  return ''
})
const colorClass = computed(() => {
  if (props.rank >= 20) return 'bg-amber-100 text-amber-800'
  if (props.rank >= 10) return 'bg-blue-100 text-blue-800'
  return ''
})
</script>

<template>
  <span v-if="label" :class="['inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', colorClass]">
    {{ label }}
  </span>
</template>
```

- [ ] **Step 4: MediaLock 组件**

未授权时展示的锁定提示组件。

```vue
<script setup lang="ts">
defineProps<{ requiredRank: number; message?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center rounded-lg bg-gray-50 p-8 text-center">
    <div class="mb-3 text-4xl">🔒</div>
    <p class="text-sm text-gray-600">{{ message || '需要更高会员等级才能查看' }}</p>
    <MembershipBadge :rank="requiredRank" class="mt-2" />
    <NuxtLink to="/user" class="mt-3 text-sm text-blue-600 hover:underline">查看会员权益</NuxtLink>
  </div>
</template>
```

- [ ] **Step 5: SearchInput 组件**

```vue
<script setup lang="ts">
const modelValue = defineModel<string>({ default: '' })
const emit = defineEmits<{ search: [value: string] }>()

function onSubmit() {
  emit('search', modelValue.value.trim())
}
</script>

<template>
  <form class="relative" @submit.prevent="onSubmit">
    <input
      v-model="modelValue"
      type="search"
      placeholder="搜索图库..."
      class="w-full rounded-full border border-gray-300 bg-white py-2 pl-4 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
    <button type="submit" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    </button>
  </form>
</template>
```

- [ ] **Step 6: FilterBar 组件**

```vue
<script setup lang="ts">
interface FilterBarProps {
  tags: Record<string, Array<{ id: string; name: string; slug: string }>>
  selectedTags: string[]
}
defineProps<FilterBarProps>()
const emit = defineEmits<{ toggle: [slug: string]; clear: [] }>()

const tagTypeLabels: Record<string, string> = {
  region_scope: '地区范围',
  region_group: '地区组',
  city_country: '城市/国家',
  identity: '身份',
  personality: '性格',
  style: '风格',
  occupation: '职业',
  hair: '发型',
  clothing: '服饰',
  scene: '场景',
  content_type: '内容类型',
}
</script>

<template>
  <div class="space-y-3">
    <div v-for="(items, type) in tags" :key="type" class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-gray-500 w-16 shrink-0">{{ tagTypeLabels[type] || type }}</span>
      <button
        v-for="tag in items"
        :key="tag.slug"
        :class="[
          'rounded-full px-3 py-1 text-xs transition-colors',
          selectedTags.includes(tag.slug)
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        ]"
        @click="emit('toggle', tag.slug)"
      >
        {{ tag.name }}
      </button>
    </div>
    <button
      v-if="selectedTags.length > 0"
      class="text-xs text-blue-600 hover:underline"
      @click="emit('clear')"
    >
      清除全部筛选
    </button>
  </div>
</template>
```

- [ ] **Step 7: 验证 dev 启动正常**
- [ ] **Step 8: Commit**

### Task 3.4: 改进 useAuth composable

**Files:**
- Modify: `packages/web/app/composables/useAuth.ts`

- [ ] **Step 1: 使用 useApi 并添加 register 方法**

重写 useAuth 使用 useApi composable，添加 register、完善类型。

```typescript
export function useAuth() {
  const { api } = useApi()
  const user = useState<UserInfo | null>('auth-user', () => null)

  interface UserInfo {
    id: string
    email: string
    nickname: string | null
    role: string
    status: string
    membershipRank: number
    membershipExpiry: string | null
  }

  const isLoggedIn = computed(() => !!user.value)
  const isAdmin = computed(() => user.value?.role === 'admin' || user.value?.role === 'owner')
  const isOwner = computed(() => user.value?.role === 'owner')
  const membershipRank = computed(() => user.value?.membershipRank ?? 0)

  async function fetchUser() {
    try {
      user.value = await api<UserInfo>('/api/me')
    } catch {
      user.value = null
    }
  }

  async function login(email: string, password: string, turnstileToken?: string) {
    const result = await api<UserInfo>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, turnstileToken }),
    })
    user.value = result
    return result
  }

  async function register(email: string, password: string, nickname?: string, turnstileToken?: string) {
    const result = await api<UserInfo>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, nickname, turnstileToken }),
    })
    user.value = result
    return result
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    user.value = null
    navigateTo('/')
  }

  return { user, isLoggedIn, isAdmin, isOwner, membershipRank, fetchUser, login, register, logout }
}
```

- [ ] **Step 2: Commit**

---

## Phase 4: 前端公开页面

### Task 4.1: 默认布局改进 + 页面路由

**Files:**
- Rewrite: `packages/web/app/layouts/default.vue`
- Create: `packages/web/app/pages/login.vue`
- Create: `packages/web/app/pages/register.vue`
- Create: `packages/web/app/pages/gallery/[slug].vue`
- Create: `packages/web/app/pages/search.vue`
- Create: `packages/web/app/pages/tags.vue`
- Create: `packages/web/app/pages/user.vue`

- [ ] **Step 1: 改进默认布局**

顶部导航增加搜索、标签入口、登录/用户中心按钮。移动端添加底部导航。

- [ ] **Step 2: 首页（瀑布流图库网格）**

重写 `pages/index.vue`：调用 `GET /api/galleries?pageSize=24` 和 `GET /api/tags`，展示图库卡片网格 + 热门标签 + 加载更多。

- [ ] **Step 3: 图库详情页**

`pages/gallery/[slug].vue`：调用 `GET /api/galleries/:slug`，展示标题、摘要、正文、标签、图片列表（用缩略图）、视频区域（需登录）、受保护内容锁定提示、相关推荐。

- [ ] **Step 4: 搜索页**

`pages/search.vue`：关键词输入 + 标签筛选 + 结果列表分页。URL 参数：`?q=xxx&tag=a,b&page=1`。

- [ ] **Step 5: 标签浏览页**

`pages/tags.vue`：展示所有标签分组，点击标签跳转搜索页。

- [ ] **Step 6: 登录/注册页**

`pages/login.vue` 和 `pages/register.vue`：表单 + Turnstile widget + 错误提示。

- [ ] **Step 7: 用户中心**

`pages/user.vue`：展示当前用户信息、会员等级、到期时间、站长联系方式。

- [ ] **Step 8: 验证所有页面可访问**
- [ ] **Step 9: Commit**

### Task 4.2: 移动端响应式适配

- [ ] **Step 1: 确保所有页面在 360-767px 宽度下布局正确**
- [ ] **Step 2: 图库卡片网格在移动端为两列**
- [ ] **Step 3: 详情页图片在移动端全宽展示**
- [ ] **Step 4: Commit**

---

## Phase 5: 前端管理后台

### Task 5.1: 管理后台 Dashboard

**Files:**
- Rewrite: `packages/web/app/pages/admin/index.vue`

- [ ] **Step 1: 调用 dashboard API 展示实时统计**

使用 Nuxt UI v3 的 `UCard`/`UStat` 展示图库总数、已发布、注册用户、VIP 会员、进行中导入。

- [ ] **Step 2: Commit**

### Task 5.2: 管理后台 - 图库管理

**Files:**
- Create: `packages/web/app/pages/admin/galleries/index.vue`
- Create: `packages/web/app/pages/admin/galleries/[id].vue`
- Create: `packages/web/app/pages/admin/galleries/new.vue`

- [ ] **Step 1: 图库列表页**

使用 Nuxt UI `UTable` 展示图库列表（封面、标题、状态、等级、标签、发布时间）。支持分页、状态筛选。操作按钮：编辑、发布/下架。

- [ ] **Step 2: 图库创建/编辑页**

表单：标题、slug（自动生成）、摘要、正文（Markdown 编辑器或 textarea）、所需等级、标签多选、状态。

- [ ] **Step 3: Commit**

### Task 5.3: 管理后台 - 标签管理

**Files:**
- Create: `packages/web/app/pages/admin/tags.vue`

- [ ] **Step 1: 标签列表 + 创建/编辑表单**

表格展示标签（类型、名称、slug、关联图库数）。模态框创建/编辑。删除确认。

- [ ] **Step 2: Commit**

### Task 5.4: 管理后台 - 用户管理

**Files:**
- Create: `packages/web/app/pages/admin/users/index.vue`
- Create: `packages/web/app/pages/admin/users/[id].vue`

- [ ] **Step 1: 用户列表**

搜索 + 分页 + 角色/状态筛选。

- [ ] **Step 2: 用户详情 + 会员发放**

用户信息、会员历史、发放会员表单（选择等级、设置有效期、备注）。

- [ ] **Step 3: Commit**

### Task 5.5: 管理后台 - 审计日志和设置

**Files:**
- Create: `packages/web/app/pages/admin/audit-logs.vue`
- Create: `packages/web/app/pages/admin/settings.vue`

- [ ] **Step 1: 审计日志列表**

表格展示操作日志，支持按 action 和 targetType 筛选。

- [ ] **Step 2: 站点设置表单**

Owner 可编辑站名、SEO 标题、会员说明、联系方式（微信、Telegram、邮箱、自定义说明）。

- [ ] **Step 3: Commit**

---

## Phase 6: 批量导入

### Task 6.1: 导入任务 API

**Files:**
- Rewrite: `packages/api/src/routes/admin/import-jobs.ts`

- [ ] **Step 1: POST / - 创建导入任务（上传 zip 到 R2）**

接收 multipart/form-data，校验文件大小（<=2GB），存入 R2 `imports/{jobId}/source.zip`，创建 import_jobs 记录，状态 queued。检查当前 processing 任务数 <=3，超限返回 429。

- [ ] **Step 2: GET / - 导入任务列表**

分页展示所有任务（状态、总数、成功数、失败数、创建者、时间）。

- [ ] **Step 3: GET /:id - 任务详情**

展示任务详细信息和处理进度。

- [ ] **Step 4: POST /:id/process - 触发异步处理**

解压 zip、解析 manifest.csv、逐个校验和处理图库目录。调用 R2 上传图片、Stream 上传视频。创建 gallery 和 media_assets 记录。生成错误报告。

这是最复杂的端点。核心逻辑：
1. 读取 R2 中的 zip 文件
2. 解析 manifest.csv
3. 逐个图库目录：校验 → 上传媒体 → 创建记录 → 关联标签
4. 失败记录错误，继续处理下一个
5. 更新 import_jobs 统计
6. 生成错误报告 CSV 存入 R2

- [ ] **Step 5: GET /:id/errors - 下载错误报告**

从 R2 读取错误报告 CSV 返回。

- [ ] **Step 6: 验证构建 + Commit**

### Task 6.2: CSV 解析和 zip 解析工具

**Files:**
- Create: `packages/api/src/utils/csv.ts`
- Create: `packages/api/src/utils/zip.ts`

- [ ] **Step 1: CSV 解析器**

简单的 CSV 解析器（不引入外部库），处理引号内逗号。

- [ ] **Step 2: Zip 解析**

使用 Workers 环境可用的 `DecompressionStream` 或轻量 zip 库解析 zip。

- [ ] **Step 3: 测试 CSV 解析**
- [ ] **Step 4: Commit**

### Task 6.3: 前端导入 UI

**Files:**
- Create: `packages/web/app/pages/admin/import/index.vue`
- Create: `packages/web/app/pages/admin/import/[id].vue`

- [ ] **Step 1: 导入任务列表 + 上传入口**

文件选择器（限 .zip）、上传进度条、任务列表表格。

- [ ] **Step 2: 任务详情 + 错误报告下载**
- [ ] **Step 3: Commit**

---

## Phase 7: WordPress 旧站迁移

### Task 7.1: 旧站迁移 API

**Files:**
- Create: `packages/api/src/routes/admin/legacy.ts`
- Modify: `packages/api/src/routes/admin/index.ts`

- [ ] **Step 1: POST /legacy-import-sources - 创建旧站来源**

记录旧站 base URL、导入模式、分类映射 JSON、标签映射 JSON。

- [ ] **Step 2: POST /legacy-import-jobs - 启动迁移任务**

分页拉取 WordPress REST API `/wp-json/wp/v2/posts`，解析正文 HTML，提取图片和视频，下载媒体到 R2/Stream，创建图库草稿，标记风险项进入待审核。

- [ ] **Step 3: GET /legacy-import-items - 迁移条目列表**

分页展示所有迁移条目（旧标题、旧分类、新标签、状态、审核状态）。

- [ ] **Step 4: PATCH /legacy-import-items/:id/review - 审核迁移条目**

通过/退回/修改标签/修改标题。

- [ ] **Step 5: 验证构建 + Commit**

### Task 7.2: HTML 解析工具

**Files:**
- Create: `packages/api/src/utils/html-parser.ts`

- [ ] **Step 1: WordPress HTML 图片/视频提取**

解析 `<figure class="wp-block-image">`、`<img>`、`<video>` 标签，提取 URL、alt text。将 HTML 转为 Markdown 正文。

- [ ] **Step 2: 敏感词检测**

基础敏感词列表匹配（可配置），触发审核标记。

- [ ] **Step 3: 测试**
- [ ] **Step 4: Commit**

### Task 7.3: 前端旧站迁移 UI

**Files:**
- Create: `packages/web/app/pages/admin/legacy/index.vue`
- Create: `packages/web/app/pages/admin/legacy/[id].vue`

- [ ] **Step 1: 来源配置 + 迁移任务列表**
- [ ] **Step 2: 迁移预览和批量审核**
- [ ] **Step 3: Commit**

---

## Phase 8: 生产加固

### Task 8.1: SEO 和 Meta 标签

**Files:**
- Modify: `packages/web/app/pages/index.vue`
- Modify: `packages/web/app/pages/gallery/[slug].vue`
- Modify: `packages/web/nuxt.config.ts`

- [ ] **Step 1: 全局 head 配置**

在 nuxt.config.ts 中设置默认 title、description（从公开 settings API 获取）。

- [ ] **Step 2: 图库详情页 useHead**

动态设置 title、description、og:image（封面图 URL）。

- [ ] **Step 3: Commit**

### Task 8.2: 错误边界和降级

**Files:**
- Modify: `packages/web/app/error.vue`

- [ ] **Step 1: 完善全局错误页**

区分 404、403、500，展示友好提示和返回首页链接。

- [ ] **Step 2: 图片加载失败占位**

在 GalleryCard 和详情页图片添加 @error 处理。

- [ ] **Step 3: Commit**

### Task 8.3: 缓存策略

**Files:**
- Modify: `packages/api/src/routes/galleries.ts`
- Modify: `packages/api/src/routes/tags.ts`

- [ ] **Step 1: 为公开 API 添加 Cache-Control header**

- 图库列表/搜索：`Cache-Control: public, max-age=60`
- 标签列表：`Cache-Control: public, max-age=300`
- 图库详情：`Cache-Control: public, max-age=60`

- [ ] **Step 2: Commit**

### Task 8.4: Nuxt routeRules 配置

**Files:**
- Modify: `packages/web/nuxt.config.ts`

- [ ] **Step 1: 后台 CSR + 前台 SSR**

```typescript
routeRules: {
  '/admin/**': { ssr: false },
}
```

- [ ] **Step 2: Commit**

### Task 8.5: 部署验证

- [ ] **Step 1: API Worker 构建**

```bash
pnpm --filter @meigallery/api run build
```

- [ ] **Step 2: Web Worker 构建**

```bash
pnpm --filter @meigallery/web run build
```

- [ ] **Step 3: 类型检查**

```bash
pnpm run typecheck
```

- [ ] **Step 4: 所有测试通过**

```bash
pnpm --filter @meigallery/api test
```

- [ ] **Step 5: Commit + 打 tag**

```bash
git tag v0.1.0-mvp
```

---

## 依赖图总览

```
P1 (API 补全)────────────────────┐
                                 ├── P5 (管理后台) ── P6 (批量导入) ── P7 (旧站迁移) ──┐
P3 (前端基础设施) ───────────────┤                                                     ├── P8 (生产加固)
                                 └── P4 (前端公开页面) ────────────────────────────────┘
P2 (测试基础设施) ── 独立执行，全程可并行
```

## 预估工作量

| 阶段 | 预估时间 |
|------|----------|
| P1 API 补全 | 20 分钟 |
| P2 测试基础设施 | 30 分钟 |
| P3 前端基础设施 | 40 分钟 |
| P4 前端公开页面 | 90 分钟 |
| P5 前端管理后台 | 90 分钟 |
| P6 批量导入 | 90 分钟 |
| P7 旧站迁移 | 90 分钟 |
| P8 生产加固 | 30 分钟 |
| **总计** | **~8 小时** |
