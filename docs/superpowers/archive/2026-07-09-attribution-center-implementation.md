# 归因中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分阶段实现归因中心：用站内转化账本统一有效联系、注册和试用口径，并把投放追踪链接、Meta Pixel / CAPI 同步健康、重复事件诊断和发布检查纳入后台。

**Architecture:** 站内转化账本作为唯一事实源；前台业务组件只调用 `useConversionTracking()`；API Worker 写入 D1 账本和 delivery 记录；Meta Pixel / CAPI 是 delivery adapter；后台 `/admin/attribution` 读取聚合表和状态表展示归因口径。CAPI 使用 Cloudflare Queues，在转化账本稳定后独立启用。

**Tech Stack:** Nuxt 4、Vue 3、Tailwind CSS v4、Nuxt UI v4、Hono、Cloudflare Workers、Cloudflare D1、Cloudflare Queues、R2、Vitest、Playwright、pnpm monorepo。

## Global Constraints

- 所有用户可见文案、文档和 commit message 使用中文；代码标识符、API、URL、Meta、Pixel、CAPI、Queue 保留英文。
- 不使用 Cloudflare Pages；Web 和 API 都部署为独立 Cloudflare Workers。
- 后台路由必须要求 admin+；Owner-only 操作必须由 API 二次校验。
- 所有后台设置修改、Test Event 触发、启停 Pixel / CAPI、导出和查看敏感明细必须写审计日志。
- 不上传邮箱、手机号、联系方式值、会员备注、私有媒体 URL、R2 key、Stream token、session token、后台路径和后台操作详情到 Pixel / CAPI。
- 站内转化账本是后台事实源；Meta Pixel / CAPI 只作为同步渠道，不反向覆盖后台大盘。
- 投放追踪链接必须命名为“投放追踪链接”或“广告测试链接”，不得再称为“Meta 像素测试地址”。
- 单日查看必须支持 `from=YYYY-MM-DD&to=YYYY-MM-DD`，并与现有 `range=day` 前端控件兼容。
- 非关键提交不推送；一个完整功能阶段完成后再统一推送。

---

## 1. File Structure

### Shared

- Modify: `packages/shared/src/types/index.ts`，新增转化动作、Meta delivery、归因查询响应类型。
- Modify: `packages/shared/src/constants/index.ts`，新增转化事件白名单、Meta 事件映射和归因限制常量。

### API

- Create: `packages/api/migrations/0032_attribution_conversions.sql`，新增转化账本和聚合表。
- Create: `packages/api/migrations/0033_meta_delivery_settings.sql`，新增 Meta / CAPI 设置默认值和 tracking source `utm_content` 字段。
- Create: `packages/api/src/utils/conversions.ts`，生成 `conversion_action_id`、`dedupe_key`、`external_event_id`，校验 payload。
- Create: `packages/api/src/utils/conversions.test.ts`，覆盖 ID、映射、敏感字段和重复口径。
- Create: `packages/api/src/services/conversions.ts`，写入转化账本、兼容 analytics、创建 delivery。
- Create: `packages/api/src/services/conversions.test.ts`，覆盖账本写入和幂等。
- Create: `packages/api/src/routes/conversions.ts`，公开 `POST /api/conversions/events`。
- Create: `packages/api/src/routes/conversions.test.ts`，覆盖公开接口、合规和降级。
- Create: `packages/api/src/services/meta-capi.ts`，Meta CAPI payload 和投递 adapter。
- Create: `packages/api/src/services/meta-capi.test.ts`，覆盖 payload 白名单、Meta 4xx/5xx 和 retry 分类。
- Create: `packages/api/src/routes/admin/attribution.ts`，后台归因中心 API。
- Create: `packages/api/src/routes/admin/attribution.test.ts`，覆盖后台归因 API、权限和单日查询。
- Modify: `packages/api/src/index.ts`，挂载 `/api/conversions`，增加 CAPI Queue binding 和 queue consumer。
- Modify: `packages/api/src/routes/admin/index.ts`，挂载 `/api/admin/attribution`。
- Modify: `packages/api/src/services/tracking-sources.ts`，支持 `utm_content` 和投放链接展示口径。
- Modify: `packages/api/src/routes/admin/tracking-sources.ts`，支持投放链接创建字段和审计日志。
- Modify: `packages/api/wrangler.toml`，新增 dev / production Queue binding 和 CAPI 公开开关变量。

### Web

- Create: `packages/web/app/composables/useConversionTracking.ts`，统一前台转化入口。
- Create: `packages/web/app/composables/useConversionTracking.test.ts`，覆盖联系、注册、试用、consent 和 Pixel eventID。
- Modify: `packages/web/app/composables/useAnalytics.ts`，允许传入外部 `eventId` 和转化上下文。
- Modify: `packages/web/app/composables/useFacebookPixel.ts`，移除业务口径，只保留 adapter，并支持 `eventID`。
- Modify: `packages/web/app/plugins/facebook-pixel.client.ts`，继续只负责初始化和 PageView。
- Modify: `packages/web/app/components/ContactPanel.vue`，改为调用 `trackConversion('contact')`。
- Modify: `packages/web/app/pages/register.vue`，注册成功只调用 `trackConversion('complete_registration')`。
- Create: `packages/web/app/components/admin/attribution/AttributionPageShell.vue`，归因中心页面壳。
- Create: `packages/web/app/components/admin/attribution/AttributionHealthStrip.vue`，归因健康条。
- Create: `packages/web/app/pages/admin/attribution/index.vue`，归因总览。
- Create: `packages/web/app/pages/admin/attribution/conversions.vue`，转化趋势。
- Create: `packages/web/app/pages/admin/attribution/links.vue`，投放追踪链接。
- Create: `packages/web/app/pages/admin/attribution/meta.vue`，Meta 同步健康。
- Create: `packages/web/app/pages/admin/attribution/duplicates.vue`，重复事件诊断。
- Create: `packages/web/app/pages/admin/attribution/readiness.vue`，发布检查。
- Create: `packages/web/app/composables/useAdminAttribution.ts`，归因后台 API composable。
- Modify: `packages/web/app/layouts/admin.vue`，新增“归因中心”导航。
- Modify: `packages/web/app/pages/admin/analytics/sources.vue`，移除“Meta 像素测试地址”侧栏，改为跳转归因中心。
- Modify: `packages/web/tests/e2e/mock-api.mjs`，新增归因 mock API。
- Modify: `packages/web/tests/e2e/smoke.spec.ts`，新增归因中心 smoke。

### Docs

- Modify: `docs/TECHNICAL_SPEC.md`，记录转化账本、CAPI Queue、归因中心接口。
- Modify: `docs/UI_DATA_ANALYTICS_DASHBOARD.md`，说明数据分析和归因中心边界。
- Modify: `docs/DEPLOYMENT.md`，记录 Queue、Secret、发布检查和回滚开关。
- Modify: `docs/PROJECT_STATUS.md`，阶段完成后更新实现状态。

---

## 2. Implementation Steps

### Task 1: Shared Contracts And D1 Schema

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/constants/index.ts`
- Create: `packages/api/migrations/0032_attribution_conversions.sql`
- Create: `packages/api/migrations/0033_meta_delivery_settings.sql`
- Create: `packages/api/src/utils/conversions.ts`
- Create: `packages/api/src/utils/conversions.test.ts`

**Interfaces:**
- Produces: `ConversionActionType`, `ConversionMetaEventName`, `ConversionDeliveryChannel`, `ConversionDeliveryStatus`
- Produces: `buildConversionDedupeKey(input)`, `buildExternalEventId(input)`, `sanitizeConversionMetadata(input)`
- Consumes: existing `AnalyticsSourceChannel`, `AnalyticsConsentState`, `generateId()`

- [ ] **Step 1: Write shared contract tests**

Create `packages/api/src/utils/conversions.test.ts` with tests that assert:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildConversionDedupeKey,
  buildExternalEventId,
  sanitizeConversionMetadata,
  metaEventForConversion,
} from './conversions'

describe('conversion utils', () => {
  it('为同一业务动作生成稳定 dedupe key 和 external event id', () => {
    const input = {
      actionType: 'contact' as const,
      sessionId: 'session_abc',
      visitorId: 'visitor_abc',
      occurredDate: '2026-07-09',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
    }
    expect(buildConversionDedupeKey(input)).toBe('contact:session_abc:telegram:floating_contact_panel')
    expect(buildExternalEventId({ ...input, metaEventName: 'Contact' })).toBe('meta:Contact:contact:session_abc:telegram:floating_contact_panel')
  })

  it('注册成功映射 CompleteRegistration 且不映射 StartTrial', () => {
    expect(metaEventForConversion('complete_registration')).toBe('CompleteRegistration')
    expect(metaEventForConversion('start_trial')).toBe('StartTrial')
  })

  it('清洗 payload 时移除敏感字段', () => {
    const sanitized = sanitizeConversionMetadata({
      email: 'user@example.test',
      phone: '123',
      contactValue: '@secret',
      method_type: 'telegram',
      location: 'floating_contact_panel',
      token: 'secret',
      private_url: '/api/media/originals/x.jpg',
    })
    expect(sanitized).toEqual({
      method_type: 'telegram',
      location: 'floating_contact_panel',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @meigallery/api test -- conversions.test.ts`

Expected: FAIL because `packages/api/src/utils/conversions.ts` does not exist.

- [ ] **Step 3: Add shared types and constants**

In `packages/shared/src/types/index.ts`, add:

```ts
export type ConversionActionType =
  | 'contact'
  | 'lead'
  | 'complete_registration'
  | 'start_trial'
  | 'membership_grant'

export type ConversionMetaEventName =
  | 'Contact'
  | 'Lead'
  | 'CompleteRegistration'
  | 'StartTrial'

export type ConversionDeliveryChannel = 'meta_pixel' | 'meta_capi'
export type ConversionDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'duplicate_suppressed'
export type ConversionSkipReason =
  | 'disabled'
  | 'missing_secret'
  | 'missing_pixel_id'
  | 'consent_denied'
  | 'invalid_payload'
```

In `packages/shared/src/constants/index.ts`, add:

```ts
export const CONVERSION_ACTIONS = ['contact', 'lead', 'complete_registration', 'start_trial', 'membership_grant'] as const

export const META_EVENT_BY_CONVERSION = {
  contact: 'Contact',
  lead: 'Lead',
  complete_registration: 'CompleteRegistration',
  start_trial: 'StartTrial',
  membership_grant: null,
} as const

export const ATTRIBUTION_LIMITS = {
  METADATA_MAX_KEYS: 24,
  METADATA_VALUE_MAX_LENGTH: 120,
  DELIVERY_ERROR_MAX_LENGTH: 500,
  CONVERSION_DETAIL_SAMPLE_LIMIT: 200,
} as const
```

- [ ] **Step 4: Add conversion utility implementation**

Create `packages/api/src/utils/conversions.ts`:

```ts
import type { ConversionActionType, ConversionMetaEventName } from '@meigallery/shared'
import { ATTRIBUTION_LIMITS, META_EVENT_BY_CONVERSION } from '@meigallery/shared/constants'

type ConversionDedupeInput = {
  actionType: ConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  methodType?: string
  actionTarget?: string
}

const SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'nickname',
  'username',
  'contact_value',
  'contactValue',
  'token',
  'session_token',
  'private_url',
  'r2_key',
])

export function metaEventForConversion(actionType: ConversionActionType): ConversionMetaEventName | null {
  return META_EVENT_BY_CONVERSION[actionType]
}

export function buildConversionDedupeKey(input: ConversionDedupeInput) {
  if (input.actionType === 'contact' || input.actionType === 'lead') {
    return `${input.actionType}:${input.sessionId}:${normalizeKeyPart(input.methodType)}:${normalizeKeyPart(input.actionTarget)}`
  }
  if (input.actionType === 'complete_registration' || input.actionType === 'start_trial') {
    return `${input.actionType}:${input.sessionId}:${input.occurredDate}`
  }
  return `${input.actionType}:${input.visitorId}:${input.occurredDate}`
}

export function buildExternalEventId(input: ConversionDedupeInput & { metaEventName: ConversionMetaEventName }) {
  return `meta:${input.metaEventName}:${buildConversionDedupeKey(input)}`
}

export function sanitizeConversionMetadata(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input).slice(0, ATTRIBUTION_LIMITS.METADATA_MAX_KEYS)) {
    if (SENSITIVE_KEYS.has(key)) continue
    if (key.includes('token') || key.includes('secret') || key.includes('password')) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && (value.includes('/api/media/') || value.includes('originals/'))) continue
    if (typeof value === 'string') output[key] = value.replace(/\s+/g, ' ').trim().slice(0, ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH)
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
    else if (typeof value === 'boolean') output[key] = value
  }
  return output
}

function normalizeKeyPart(value: unknown) {
  const text = String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return text || 'unknown'
}
```

- [ ] **Step 5: Add D1 migrations**

Create `packages/api/migrations/0032_attribution_conversions.sql`:

```sql
CREATE TABLE IF NOT EXISTS analytics_conversion_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  tracking_source_slug TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  method_type TEXT NOT NULL DEFAULT '',
  action_target TEXT NOT NULL DEFAULT '',
  route_name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  duplicate_of TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (action_type IN ('contact', 'lead', 'complete_registration', 'start_trial', 'membership_grant'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_conversion_actions_date_source
  ON analytics_conversion_actions(date, source_channel, source_name);
CREATE INDEX IF NOT EXISTS idx_analytics_conversion_actions_session
  ON analytics_conversion_actions(session_id, occurred_at);

CREATE TABLE IF NOT EXISTS analytics_conversion_deliveries (
  id TEXT PRIMARY KEY,
  conversion_action_id TEXT NOT NULL REFERENCES analytics_conversion_actions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('meta_pixel', 'meta_capi')),
  CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'duplicate_suppressed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_conversion_deliveries_external
  ON analytics_conversion_deliveries(channel, external_event_id);
CREATE INDEX IF NOT EXISTS idx_analytics_conversion_deliveries_status
  ON analytics_conversion_deliveries(status, updated_at);

CREATE TABLE IF NOT EXISTS analytics_conversion_daily (
  date TEXT NOT NULL,
  action_type TEXT NOT NULL,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  action_count INTEGER NOT NULL DEFAULT 0,
  unique_session_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, action_type, source_channel, source_name, utm_campaign, utm_content)
);

CREATE TABLE IF NOT EXISTS analytics_conversion_delivery_daily (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT NOT NULL DEFAULT '',
  delivery_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, channel, event_name, status, skip_reason)
);
```

Create `packages/api/migrations/0033_meta_delivery_settings.sql`:

```sql
ALTER TABLE analytics_tracking_sources ADD COLUMN utm_content TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('meta_capi_enabled', 'false', datetime('now')),
  ('meta_capi_test_event_enabled', 'false', datetime('now')),
  ('meta_tracking_mode', '"limited"', datetime('now'));
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- conversions.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/index.ts packages/shared/src/constants/index.ts packages/api/migrations/0032_attribution_conversions.sql packages/api/migrations/0033_meta_delivery_settings.sql packages/api/src/utils/conversions.ts packages/api/src/utils/conversions.test.ts
git commit -m "feat: 增加归因转化合约和账本结构"
```

### Task 2: Public Conversion API And Ledger Service

**Files:**
- Create: `packages/api/src/services/conversions.ts`
- Create: `packages/api/src/services/conversions.test.ts`
- Create: `packages/api/src/routes/conversions.ts`
- Create: `packages/api/src/routes/conversions.test.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/services/analytics-ingest.ts`
- Modify: `packages/api/src/services/analytics-ingest.test.ts`

**Interfaces:**
- Consumes: Task 1 `buildConversionDedupeKey`, `buildExternalEventId`, `sanitizeConversionMetadata`
- Produces: `recordConversionAction(env, input): Promise<RecordConversionResult>`
- Produces: `POST /api/conversions/events`

- [ ] **Step 1: Write service tests**

Create `packages/api/src/services/conversions.test.ts` with cases:

```ts
import { describe, expect, it } from 'vitest'
import { recordConversionAction } from './conversions'

describe('conversion ledger service', () => {
  it('首次有效联系写入 contact 和 lead，并创建 Meta delivery', async () => {
    const db = createConversionDb()
    const result = await recordConversionAction(envFor(db), {
      actionType: 'contact',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:00:00.000Z',
      routeName: 'home',
      path: '/',
      sourceChannel: 'ad',
      sourceName: 'ad-july',
      utmCampaign: 'july',
      utmContent: 'chat-a',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { method_type: 'telegram', location: 'floating_contact_panel' },
    })
    expect(result.created).toBe(true)
    expect(result.derivedActions.map(item => item.actionType)).toContain('lead')
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_actions'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(true)
  })

  it('重复有效联系不重复派生 Lead', async () => {
    const db = createConversionDb({ existingDedupeKeys: ['contact:session_1:telegram:floating_contact_panel'] })
    const result = await recordConversionAction(envFor(db), {
      actionType: 'contact',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:05:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    expect(result.created).toBe(false)
    expect(result.derivedActions).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @meigallery/api test -- conversions.test.ts`

Expected: FAIL because `recordConversionAction` does not exist.

- [ ] **Step 3: Implement service result types and inserts**

Create `packages/api/src/services/conversions.ts` with:

```ts
import type { AnalyticsConsentState, AnalyticsSourceChannel, ConversionActionType } from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import {
  buildConversionDedupeKey,
  buildExternalEventId,
  metaEventForConversion,
  sanitizeConversionMetadata,
} from '../utils/conversions'

export interface RecordConversionInput {
  actionType: ConversionActionType
  visitorId: string
  sessionId: string
  userId?: number | null
  occurredAt: string
  routeName?: string
  path?: string
  sourceChannel?: AnalyticsSourceChannel | string
  sourceName?: string
  trackingSourceSlug?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  consentState?: AnalyticsConsentState | string
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

export interface RecordConversionResult {
  id: string
  actionType: ConversionActionType
  created: boolean
  duplicateOf: string
  derivedActions: Array<{ id: string; actionType: ConversionActionType }>
}

export async function recordConversionAction(env: Pick<Bindings, 'DB' | 'APP_ENV'>, input: RecordConversionInput): Promise<RecordConversionResult> {
  const occurredAt = normalizeIso(input.occurredAt)
  const date = occurredAt.slice(0, 10)
  const dedupeKey = buildConversionDedupeKey({
    actionType: input.actionType,
    sessionId: input.sessionId,
    visitorId: input.visitorId,
    occurredDate: date,
    methodType: input.methodType,
    actionTarget: input.actionTarget,
  })
  const existing = await env.DB.prepare('SELECT id FROM analytics_conversion_actions WHERE dedupe_key = ? LIMIT 1').bind(dedupeKey).first<{ id: string }>()
  if (existing) {
    return { id: existing.id, actionType: input.actionType, created: false, duplicateOf: existing.id, derivedActions: [] }
  }

  const id = generateId('conv')
  await insertConversion(env.DB, id, input, occurredAt, date, dedupeKey, '')
  await upsertConversionDaily(env.DB, input, date)
  await createMetaDeliveries(env.DB, id, input, date)

  const derivedActions: Array<{ id: string; actionType: ConversionActionType }> = []
  if (input.actionType === 'contact') {
    const lead = await recordDerivedLead(env, input, occurredAt, date)
    if (lead) derivedActions.push(lead)
  }
  return { id, actionType: input.actionType, created: true, duplicateOf: '', derivedActions }
}
```

Add helper functions in the same file:

```ts
function normalizeIso(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

async function insertConversion(db: D1Database, id: string, input: RecordConversionInput, occurredAt: string, date: string, dedupeKey: string, duplicateOf: string) {
  await db.prepare(`
    INSERT INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
      source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
      utm_campaign, utm_content, method_type, action_target, route_name, path,
      metadata, duplicate_of
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.actionType,
    dedupeKey,
    occurredAt,
    date,
    input.visitorId || '',
    input.sessionId || '',
    input.userId ?? null,
    normalizeText(input.sourceChannel || 'unknown', 40),
    normalizeText(input.sourceName || input.utmSource || input.trackingSourceSlug || '', 120),
    normalizeText(input.trackingSourceSlug || '', 120),
    normalizeText(input.utmSource || '', 120),
    normalizeText(input.utmMedium || '', 120),
    normalizeText(input.utmCampaign || '', 120),
    normalizeText(input.utmContent || '', 120),
    normalizeText(input.methodType || '', 80),
    normalizeText(input.actionTarget || '', 120),
    normalizeText(input.routeName || '', 120),
    normalizeText(input.path || '', 240),
    JSON.stringify(sanitizeConversionMetadata(input.metadata || {})),
    duplicateOf,
  ).run()
}
```

Implement `upsertConversionDaily`, `createMetaDeliveries`, and `recordDerivedLead` in the same file using these rules:

- `upsertConversionDaily` increments `action_count` and `unique_session_count` by 1 using `ON CONFLICT`.
- `createMetaDeliveries` creates `meta_pixel` and `meta_capi` rows only when `metaEventForConversion(input.actionType)` returns a Meta event.
- If `input.consentState === 'denied'`, write no Meta delivery rows.
- `recordDerivedLead` checks whether the same session already has `action_type = 'lead'`; if not, inserts a `lead` action with `methodType` and `actionTarget` copied from contact.

- [ ] **Step 4: Write route tests**

Create `packages/api/src/routes/conversions.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { conversionRoutes } from './conversions'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', null)
    c.set('userRole', null)
    await next()
  })
  app.route('/api/conversions', conversionRoutes)
  return app
}

describe('conversion routes', () => {
  it('记录有效联系并返回 conversion id', async () => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'contact',
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
        methodType: 'telegram',
        actionTarget: 'floating_contact_panel',
        metadata: { method_type: 'telegram', contactValue: '@secret' },
      }),
    }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.data.actionType).toBe('contact')
    expect(JSON.stringify(db.calls)).not.toContain('@secret')
  })
})
```

- [ ] **Step 5: Add route and rate limits**

Create `packages/api/src/routes/conversions.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { recordConversionAction } from '../services/conversions'
import { errorJson } from '../utils/api-error'

export const conversionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

conversionRoutes.post('/events', async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  const actionType = String(body.actionType || '')
  if (!['contact', 'complete_registration', 'start_trial'].includes(actionType)) {
    return errorJson(c, 400, '转化动作无效', { code: 'CONVERSION_ACTION_INVALID' })
  }
  const result = await recordConversionAction(c.env, {
    actionType: actionType as 'contact' | 'complete_registration' | 'start_trial',
    visitorId: String(body.visitorId || ''),
    sessionId: String(body.sessionId || ''),
    userId: c.get('userId'),
    occurredAt: String(body.occurredAt || new Date().toISOString()),
    routeName: String(body.routeName || ''),
    path: String(body.path || ''),
    sourceChannel: String(body.sourceChannel || 'unknown'),
    sourceName: String(body.sourceName || ''),
    trackingSourceSlug: String(body.trackingSourceSlug || ''),
    utmSource: String(body.utmSource || ''),
    utmMedium: String(body.utmMedium || ''),
    utmCampaign: String(body.utmCampaign || ''),
    utmContent: String(body.utmContent || ''),
    consentState: String(body.consentState || 'limited'),
    methodType: String(body.methodType || ''),
    actionTarget: String(body.actionTarget || ''),
    metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {},
  })
  return c.json({ data: result }, result.created ? 201 : 200)
})
```

Modify `packages/api/src/index.ts`:

```ts
import { conversionRoutes } from './routes/conversions'
```

Add rate limits beside analytics limits:

```ts
app.use('/api/conversions/*', rateLimiter({
  name: 'conversions-ip',
  keyBy: 'ip',
  limit: analyticsIpRateLimit.requests,
  windowMs: rateLimitWindowMs(analyticsIpRateLimit.window),
}))
```

Mount route:

```ts
app.route('/api/conversions', conversionRoutes)
```

- [ ] **Step 6: Add analytics compatibility path**

Modify `packages/api/src/services/analytics-ingest.ts` so accepted `contact_method_click` and `register_success` call `recordConversionAction()` after the analytics event is accepted. Use the analytics event payload fields for visitor/session/source, and pass `consentState` through.

Add test cases in `packages/api/src/services/analytics-ingest.test.ts`:

```ts
it('contact_method_click 同步写入转化账本', async () => {
  const db = createDb()
  await ingestAnalyticsBatch(envFor(db), {
    body: baseBatch({
      eventId: 'event_contact_1',
      eventName: 'contact_method_click',
      entityType: 'contact',
      props: { method_type: 'telegram', action_type: 'open_link', location: 'floating_contact_panel' },
    }),
    bodySizeBytes: 512,
    userId: null,
    currentHost: '616618.xyz',
  })
  expect(db.calls.some(call => call.sql.includes('analytics_conversion_actions'))).toBe(true)
})
```

- [ ] **Step 7: Run API tests and typecheck**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- conversions.test.ts analytics-ingest.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/routes/conversions.ts packages/api/src/routes/conversions.test.ts packages/api/src/index.ts packages/api/src/services/analytics-ingest.ts packages/api/src/services/analytics-ingest.test.ts
git commit -m "feat: 增加站内转化事件入口"
```

### Task 3: Frontend Conversion Tracking And Pixel Adapter

**Files:**
- Create: `packages/web/app/composables/useConversionTracking.ts`
- Create: `packages/web/app/composables/useConversionTracking.test.ts`
- Modify: `packages/web/app/composables/useAnalytics.ts`
- Modify: `packages/web/app/composables/useAnalytics.test.ts`
- Modify: `packages/web/app/composables/useFacebookPixel.ts`
- Modify: `packages/web/app/utils/facebookPixel.test.ts`
- Modify: `packages/web/app/components/ContactPanel.vue`
- Modify: `packages/web/app/components/ContactPanel.test.ts`
- Modify: `packages/web/app/pages/register.vue`

**Interfaces:**
- Consumes: Task 2 `POST /api/conversions/events`
- Produces: `useConversionTracking().trackConversion(actionType, options)`
- Produces: Pixel calls of shape `fbq('track', eventName, payload, { eventID })`

- [ ] **Step 1: Write composable tests**

Create `packages/web/app/composables/useConversionTracking.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { useConversionTracking } from './useConversionTracking'

describe('useConversionTracking', () => {
  it('点击联系方式时同时写 conversion API、analytics 兼容事件和 Pixel eventID', async () => {
    const api = vi.fn().mockResolvedValue({ data: { id: 'conv_1', created: true } })
    const track = vi.fn()
    const trackStandardEvent = vi.fn()
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useAnalytics', () => ({
      getContext: () => ({
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        consentState: 'granted',
        sourceContext: { utmSource: 'ad-july', utmMedium: 'paid_social', utmCampaign: 'july', trackingSourceSlug: 'ad-july', sourceName: 'ad-july' },
      }),
      track,
    }))
    vi.stubGlobal('useFacebookPixel', () => ({ trackStandardEvent }))

    const conversion = useConversionTracking()
    await conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { location: 'floating_contact_panel', contactValue: '@secret' },
    })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({ method: 'POST' }))
    expect(track).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({ flush: true }))
    expect(trackStandardEvent).toHaveBeenCalledWith('Contact', expect.any(Object), expect.objectContaining({ eventID: expect.stringContaining('meta:Contact:') }))
    expect(JSON.stringify(api.mock.calls)).not.toContain('@secret')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @meigallery/web test:unit -- useConversionTracking.test.ts`

Expected: FAIL because `useConversionTracking.ts` does not exist.

- [ ] **Step 3: Implement `useConversionTracking()`**

Create `packages/web/app/composables/useConversionTracking.ts`:

```ts
import type { ConversionActionType } from '@meigallery/shared'

type TrackConversionOptions = {
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

const META_EVENT: Partial<Record<ConversionActionType, 'Contact' | 'Lead' | 'CompleteRegistration' | 'StartTrial'>> = {
  contact: 'Contact',
  lead: 'Lead',
  complete_registration: 'CompleteRegistration',
  start_trial: 'StartTrial',
}

export function useConversionTracking() {
  const { api } = useApi()
  const route = useRoute()
  const analytics = useAnalytics()
  const pixel = useFacebookPixel()

  async function trackConversion(actionType: Extract<ConversionActionType, 'contact' | 'complete_registration' | 'start_trial'>, options: TrackConversionOptions = {}) {
    const context = analytics.getContext()
    const date = new Date().toISOString().slice(0, 10)
    const eventName = META_EVENT[actionType]
    const externalEventId = eventName
      ? `meta:${eventName}:${actionType}:${context.sessionId}:${options.methodType || 'unknown'}:${options.actionTarget || date}`
      : ''
    const body = {
      actionType,
      visitorId: context.visitorId,
      sessionId: context.sessionId,
      occurredAt: new Date().toISOString(),
      routeName: route.name ? String(route.name) : route.path,
      path: route.fullPath,
      sourceChannel: context.sourceContext.sourceName ? 'ad' : 'unknown',
      sourceName: context.sourceContext.sourceName,
      trackingSourceSlug: context.sourceContext.trackingSourceSlug,
      utmSource: context.sourceContext.utmSource,
      utmMedium: context.sourceContext.utmMedium,
      utmCampaign: context.sourceContext.utmCampaign,
      utmContent: queryValue(route.query.utm_content),
      consentState: context.consentState,
      methodType: options.methodType || '',
      actionTarget: options.actionTarget || '',
      metadata: sanitizeConversionMetadata(options.metadata || {}),
    }
    await api('/api/conversions/events', { method: 'POST', body })
    trackAnalyticsCompatibility(actionType, analytics, options)
    if (eventName && context.consentState === 'granted') {
      pixel.trackStandardEvent(eventName, body.metadata, { eventID: externalEventId })
    }
  }

  return { trackConversion }
}

function trackAnalyticsCompatibility(actionType: ConversionActionType, analytics: ReturnType<typeof useAnalytics>, options: TrackConversionOptions) {
  if (actionType === 'contact') {
    analytics.track('contact_method_click', {
      entityType: 'contact',
      flush: true,
      props: {
        method_type: options.methodType || 'unknown',
        action_type: 'open_link',
        location: options.actionTarget || 'floating_contact_panel',
      },
    })
  }
  if (actionType === 'complete_registration') {
    analytics.track('register_success', { entityType: 'auth', flush: true })
  }
}

function sanitizeConversionMetadata(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (['email', 'phone', 'contactValue', 'contact_value', 'token'].includes(key)) continue
    if (typeof value === 'string') output[key] = value.slice(0, 120)
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
    else if (typeof value === 'boolean') output[key] = value
  }
  return output
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  return String(raw ?? '').trim().slice(0, 120)
}
```

- [ ] **Step 4: Modify Pixel adapter**

Modify `packages/web/app/composables/useFacebookPixel.ts`:

- Remove `leadTracked` and `startTrialTracked`.
- Remove `trackLeadOnce`, `trackContactClick`, `trackCompleteRegistration`, `trackStartTrialOnce`.
- Add:

```ts
type PixelEventOptions = { eventID?: string }
type PixelStandardEventName = 'Contact' | 'Lead' | 'CompleteRegistration' | 'StartTrial' | 'ViewContent' | 'Search' | 'PageView'

function trackStandardEvent(eventName: PixelStandardEventName, payload: PixelEventParams = {}, options: PixelEventOptions = {}) {
  const args: unknown[] = ['track', eventName, payload]
  if (options.eventID) args.push({ eventID: options.eventID })
  const sent = callFbqForCurrentRoute(...args)
  if (sent) logEvent(eventName, { ...payload, event_id: options.eventID })
  return sent
}
```

Update existing `trackViewContent` and `trackSearch` to call `trackStandardEvent('ViewContent', payload)` and `trackStandardEvent('Search', payload)`.

Return `trackStandardEvent` from `useFacebookPixel()`.

- [ ] **Step 5: Allow external analytics event id**

Modify `packages/web/app/composables/useAnalytics.ts`:

```ts
interface TrackOptions {
  eventId?: string
  route?: AnalyticsRouteLike
  props?: Record<string, AnalyticsPropValue | undefined>
  value?: number
  entityType?: AnalyticsEntityType
  entityId?: string
  sourceChannel?: AnalyticsSourceChannel | string
  flush?: boolean
}
```

Change event creation:

```ts
eventId: options.eventId || createAnalyticsId(eventName),
```

Add a test in `packages/web/app/composables/useAnalytics.test.ts` asserting `analytics.track('contact_method_click', { eventId: 'conv_event_1' })` flushes `eventId: 'conv_event_1'`.

- [ ] **Step 6: Migrate business components**

Modify `packages/web/app/components/ContactPanel.vue`:

```ts
const { trackConversion } = useConversionTracking()
```

Replace `trackContactMethod()` body:

```ts
function trackContactMethod(methodType: string, actionType = 'unknown') {
  void trackConversion('contact', {
    methodType,
    actionTarget: 'floating_contact_panel',
    metadata: {
      method_type: methodType,
      action_type: actionType,
      location: 'floating_contact_panel',
    },
  })
}
```

Modify `packages/web/app/pages/register.vue` so successful registration calls:

```ts
const { trackConversion } = useConversionTracking()
await trackConversion('complete_registration', { metadata: { method: 'email' } })
```

Remove any registration success call to `trackStartTrialOnce()`.

- [ ] **Step 7: Update component tests**

Modify `packages/web/app/components/ContactPanel.test.ts`:

- Replace `useFacebookPixel` stub with `useConversionTracking`.
- Assert `trackConversion` receives `contact`.
- Keep assertion that `@meigallery` contact value is absent.

Expected assertion:

```ts
expect(trackConversion).toHaveBeenCalledWith('contact', {
  methodType: 'telegram',
  actionTarget: 'floating_contact_panel',
  metadata: {
    method_type: 'telegram',
    action_type: 'open_link',
    location: 'floating_contact_panel',
  },
})
```

- [ ] **Step 8: Run Web tests and typecheck**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- useConversionTracking.test.ts useAnalytics.test.ts ContactPanel.test.ts facebookPixel.test.ts
corepack pnpm --filter @meigallery/web typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/app/composables/useConversionTracking.ts packages/web/app/composables/useConversionTracking.test.ts packages/web/app/composables/useAnalytics.ts packages/web/app/composables/useAnalytics.test.ts packages/web/app/composables/useFacebookPixel.ts packages/web/app/utils/facebookPixel.test.ts packages/web/app/components/ContactPanel.vue packages/web/app/components/ContactPanel.test.ts packages/web/app/pages/register.vue
git commit -m "feat: 统一前台转化事件入口"
```

### Task 4: Attribution Admin API And Tracking Links

**Files:**
- Create: `packages/api/src/routes/admin/attribution.ts`
- Create: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Modify: `packages/api/src/services/tracking-sources.ts`
- Modify: `packages/api/src/routes/admin/tracking-sources.ts`
- Modify: `packages/api/src/routes/admin/tracking-sources.test.ts`

**Interfaces:**
- Consumes: Task 1 tables and Task 2 ledger data.
- Produces: `GET /api/admin/attribution/overview`
- Produces: `GET /api/admin/attribution/conversions`
- Produces: `GET /api/admin/attribution/links`
- Produces: `GET /api/admin/attribution/meta`
- Produces: `GET /api/admin/attribution/duplicates`
- Produces: `GET /api/admin/attribution/readiness`

- [ ] **Step 1: Write API tests**

Create `packages/api/src/routes/admin/attribution.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'

function createApp(role: string | null = 'admin') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin', adminRoutes)
  return app
}

describe('后台归因中心 API', () => {
  it('要求 admin+ 才能访问归因总览', async () => {
    const res = await createApp(null).request('/api/admin/attribution/overview?range=7d', {}, { DB: createAttributionDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('总览返回转化趋势、Meta 状态和重复诊断', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.range).toMatchObject({ from: '2026-07-09', to: '2026-07-09', days: 1 })
    expect(body.data.totals.contact_count).toBe(3)
    expect(body.data.meta.sent_count).toBe(2)
    expect(body.data.duplicates.duplicate_suppressed_count).toBe(1)
  })

  it('非 owner 不能触发 Test Event', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, { DB: createAttributionDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @meigallery/api test -- attribution.test.ts`

Expected: FAIL because `adminAttributionRoutes` does not exist.

- [ ] **Step 3: Implement admin attribution routes**

Create `packages/api/src/routes/admin/attribution.ts`. Use `parseAnalyticsRange` from `packages/api/src/utils/analytics-time.ts`, `mergeD1Usage` from `packages/api/src/utils/analytics-cost.ts`, and `writeAuditLog` from `packages/api/src/utils/permission.ts`.

Route shape:

```ts
export const adminAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAttributionRoutes.get('/overview', async (c) => { /* query totals, trend, meta, duplicates */ })
adminAttributionRoutes.get('/conversions', async (c) => { /* query analytics_conversion_daily and sampled actions */ })
adminAttributionRoutes.get('/links', async (c) => { /* query analytics_tracking_sources with conversion metrics */ })
adminAttributionRoutes.get('/meta', async (c) => { /* query delivery daily and settings status */ })
adminAttributionRoutes.get('/duplicates', async (c) => { /* query duplicate_suppressed and duplicate actions */ })
adminAttributionRoutes.get('/readiness', async (c) => { /* return release checks */ })
adminAttributionRoutes.post('/meta/test-event', async (c) => { /* owner only, audit log, enqueue or mark skipped */ })
```

The `/overview` response must be:

```ts
{
  range,
  usage,
  data: {
    totals: {
      contact_count,
      lead_count,
      complete_registration_count,
      start_trial_count,
      membership_grant_count
    },
    trend,
    meta: {
      sent_count,
      failed_count,
      skipped_count,
      duplicate_suppressed_count,
      last_sent_at
    },
    duplicates: {
      duplicate_suppressed_count,
      duplicate_rate
    },
    risks
  }
}
```

- [ ] **Step 4: Mount route**

Modify `packages/api/src/routes/admin/index.ts`:

```ts
import { adminAttributionRoutes } from './attribution'
```

Add:

```ts
adminRoutes.route('/attribution', adminAttributionRoutes)
```

- [ ] **Step 5: Extend tracking source with `utm_content`**

Modify `packages/api/src/services/tracking-sources.ts`:

- Add `utmContent?: string` to create/update inputs.
- Add `utmContent: string` to item interfaces.
- Read/write `utm_content` from `analytics_tracking_sources`.
- Add `utm_content` to `buildTrackingPath()`.
- Add validation with `normalizeOptionalUtmValue(input.utmContent, 'utm_content')`.

Expected path:

```ts
url.searchParams.set('utm_content', input.utmContent)
```

only when `utmContent` is non-empty.

- [ ] **Step 6: Update tracking source route tests**

Modify `packages/api/src/routes/admin/tracking-sources.test.ts`:

```ts
it('创建广告投放链接时支持 utm_content 并写审计日志', async () => {
  const db = createDb()
  const res = await createApp('admin').request('/api/admin/tracking-sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceLabel: 'Meta 广告 A',
      channel: 'ad',
      targetPath: '/',
      utmMedium: 'paid_social',
      utmCampaign: 'july',
      utmContent: 'chat-a',
    }),
  }, { DB: db } as unknown as Bindings)
  const body = await res.json()
  expect(res.status).toBe(201)
  expect(body.data.trackingPath).toContain('utm_content=chat-a')
  expect(JSON.stringify(db.calls)).not.toContain('Meta 像素测试地址')
})
```

- [ ] **Step 7: Run API tests and typecheck**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- attribution.test.ts tracking-sources.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts packages/api/src/routes/admin/index.ts packages/api/src/services/tracking-sources.ts packages/api/src/routes/admin/tracking-sources.ts packages/api/src/routes/admin/tracking-sources.test.ts
git commit -m "feat: 增加后台归因中心接口"
```

### Task 5: Attribution Admin UI

**Files:**
- Create: `packages/web/app/composables/useAdminAttribution.ts`
- Create: `packages/web/app/composables/useAdminAttribution.test.ts`
- Create: `packages/web/app/components/admin/attribution/AttributionPageShell.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionHealthStrip.vue`
- Create: `packages/web/app/pages/admin/attribution/index.vue`
- Create: `packages/web/app/pages/admin/attribution/conversions.vue`
- Create: `packages/web/app/pages/admin/attribution/links.vue`
- Create: `packages/web/app/pages/admin/attribution/meta.vue`
- Create: `packages/web/app/pages/admin/attribution/duplicates.vue`
- Create: `packages/web/app/pages/admin/attribution/readiness.vue`
- Modify: `packages/web/app/layouts/admin.vue`
- Modify: `packages/web/app/pages/admin/analytics/sources.vue`
- Modify: `packages/web/tests/e2e/mock-api.mjs`
- Modify: `packages/web/tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Task 4 admin attribution API.
- Produces: `/admin/attribution` UI route family.
- Produces: “投放追踪链接” UI with `utm_content`.

- [ ] **Step 1: Write composable tests**

Create `packages/web/app/composables/useAdminAttribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { attributionRangeQuery, attributionDuplicateRate } from './useAdminAttribution'

describe('useAdminAttribution', () => {
  it('单日查询转换为 from/to', () => {
    expect(attributionRangeQuery('day', '2026-07-09')).toEqual({ from: '2026-07-09', to: '2026-07-09' })
  })

  it('重复率按 duplicate / total 计算', () => {
    expect(attributionDuplicateRate(1, 99)).toBeCloseTo(0.01)
  })
})
```

- [ ] **Step 2: Implement composable**

Create `packages/web/app/composables/useAdminAttribution.ts` by mirroring `useAdminAnalytics.ts` and changing endpoints to `/api/admin/attribution/*`.

Expose:

```ts
export type AttributionRangePreset = '7d' | '30d' | '90d' | 'day'
export const ATTRIBUTION_RANGE_OPTIONS = [
  { label: '7 天', value: '7d' },
  { label: '30 天', value: '30d' },
  { label: '90 天', value: '90d' },
  { label: '单日', value: 'day' },
] as const
export function useAdminAttribution<T>(endpoint: string, initialRange: AttributionRangePreset = '30d') { /* same shape as useAdminAnalytics */ }
export function attributionRangeQuery(range: AttributionRangePreset, date: string) { /* day -> from/to */ }
export function attributionDuplicateRate(duplicate: unknown, total: unknown) { /* duplicate / max(1,total) */ }
```

- [ ] **Step 3: Build page shell and health strip**

Create `packages/web/app/components/admin/attribution/AttributionPageShell.vue` with tabs:

```ts
const tabs = [
  { label: '总览', to: '/admin/attribution' },
  { label: '转化', to: '/admin/attribution/conversions' },
  { label: '投放链接', to: '/admin/attribution/links' },
  { label: 'Meta 同步', to: '/admin/attribution/meta' },
  { label: '重复诊断', to: '/admin/attribution/duplicates' },
  { label: '发布检查', to: '/admin/attribution/readiness' },
]
```

Use compact admin styling: `rounded-lg` max, no hero, stable segmented controls.

Create `AttributionHealthStrip.vue` props:

```ts
defineProps<{
  pixelEnabled?: boolean
  capiEnabled?: boolean
  sentCount?: number
  failedCount?: number
  skippedCount?: number
  duplicateRate?: number
  lastSentAt?: string
}>()
```

- [ ] **Step 4: Implement overview and conversion pages**

Create `/admin/attribution/index.vue`:

- Use `useAdminAttribution('/api/admin/attribution/overview')`.
- Render KPI cards: 有效联系、Lead、完成注册、会员发放、CAPI 失败。
- Render `AnalyticsTrendPanel` with series: 有效联系、注册、CAPI 失败.
- Render top links and risks using `AnalyticsDataTable`.

Create `/admin/attribution/conversions.vue`:

- Use `useAdminAttribution('/api/admin/attribution/conversions')`.
- Render trend and source/campaign table.
- Use columns: 日期、来源、campaign、content、有效联系、Lead、注册、联系率、注册率、Meta 状态。

- [ ] **Step 5: Implement links page**

Create `/admin/attribution/links.vue`:

- Use `GET /api/admin/attribution/links`.
- Use existing `/api/admin/tracking-sources` POST to create a source.
- Form fields: 链接名称、渠道、落地页、`utm_campaign`、`utm_content`、备注。
- Toast success title: `投放追踪链接已创建`.
- Empty state text: `当前还没有投放追踪链接。创建链接后，可按广告版本查看有效联系和注册。`
- Warning text: `这是 UTM / mg_source 投放链接，不是 Pixel 地址。`

- [ ] **Step 6: Implement meta, duplicates, readiness pages**

Create `/admin/attribution/meta.vue`:

- Show Pixel 状态、CAPI 状态、Secret 存在/缺失、最近成功、错误分类.
- Owner-only Test Event button calls `POST /api/admin/attribution/meta/test-event`.

Create `/admin/attribution/duplicates.vue`:

- Show duplicate_suppressed、相同 dedupe_key、相同 external_event_id、短时间重复点击.
- Use `AnalyticsDataTable`.

Create `/admin/attribution/readiness.vue`:

- Render checks from API as green/yellow/red rows.
- Owner-only controls must be links to settings, not direct toggles in this task.

- [ ] **Step 7: Update admin navigation and old source page**

Modify `packages/web/app/layouts/admin.vue`:

```ts
{ to: '/admin/attribution', label: '归因中心', icon: 'chart' },
```

Place it after `数据分析`.

Modify `packages/web/app/pages/admin/analytics/sources.vue`:

- Remove the Meta-specific side panel.
- Add a compact link card:

```vue
<NuxtLink to="/admin/attribution/links" class="inline-flex items-center rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
  管理投放追踪链接
</NuxtLink>
```

- Remove all text `Meta 像素测试地址`.

- [ ] **Step 8: Add UI tests and E2E mock**

Add component tests for `AttributionPageShell`:

- single day input visible.
- tabs include 投放链接 and Meta 同步.

Modify `packages/web/tests/e2e/mock-api.mjs`:

- Add handlers for `/api/admin/attribution/overview`, `/conversions`, `/links`, `/meta`, `/duplicates`, `/readiness`.

Modify `packages/web/tests/e2e/smoke.spec.ts`:

```ts
test('后台归因中心可查看单日归因和投放链接', async ({ page }) => {
  await page.goto('/admin/attribution')
  await expect(page.locator('main h1', { hasText: '归因中心' })).toBeVisible()
  await page.getByRole('button', { name: '单日' }).click()
  await page.getByLabel('选择归因日期').fill('2026-07-09')
  await page.getByRole('link', { name: '投放链接' }).click()
  await expect(page.getByText('投放追踪链接')).toBeVisible()
  await expect(page.getByText('不是 Pixel 地址')).toBeVisible()
})
```

- [ ] **Step 9: Run Web tests and build**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- useAdminAttribution.test.ts AttributionPageShell.test.ts
corepack pnpm --filter @meigallery/web test:e2e
corepack pnpm --filter @meigallery/web typecheck
corepack pnpm --filter @meigallery/web exec nuxt build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/web/app/composables/useAdminAttribution.ts packages/web/app/composables/useAdminAttribution.test.ts packages/web/app/components/admin/attribution packages/web/app/pages/admin/attribution packages/web/app/layouts/admin.vue packages/web/app/pages/admin/analytics/sources.vue packages/web/tests/e2e/mock-api.mjs packages/web/tests/e2e/smoke.spec.ts
git commit -m "feat: 增加后台归因中心"
```

### Task 6: Meta CAPI Queue Delivery

**Files:**
- Modify: `packages/api/wrangler.toml`
- Modify: `packages/api/src/index.ts`
- Create: `packages/api/src/services/meta-capi.ts`
- Create: `packages/api/src/services/meta-capi.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: Task 2 `analytics_conversion_deliveries` rows.
- Produces: Queue message `{ deliveryId: string }`.
- Produces: `sendMetaCapiEvent(env, deliveryId): Promise<MetaCapiSendResult>`.

- [ ] **Step 1: Add Queue binding config**

Modify `packages/api/wrangler.toml`:

```toml
[[queues.producers]]
binding = "META_CAPI_QUEUE"
queue = "meigallery-meta-capi"

[[queues.consumers]]
queue = "meigallery-meta-capi"
max_batch_size = 10
max_batch_timeout = 30

[[env.dev.queues.producers]]
binding = "META_CAPI_QUEUE"
queue = "meigallery-meta-capi-dev"

[[env.dev.queues.consumers]]
queue = "meigallery-meta-capi-dev"
max_batch_size = 5
max_batch_timeout = 30
```

Modify `Bindings` in `packages/api/src/index.ts`:

```ts
META_CAPI_QUEUE?: Queue<{ deliveryId: string }>
META_CAPI_ACCESS_TOKEN?: string
META_CAPI_TEST_EVENT_CODE?: string
```

- [ ] **Step 2: Write CAPI adapter tests**

Create `packages/api/src/services/meta-capi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildMetaCapiPayload, classifyMetaCapiError } from './meta-capi'

describe('meta-capi', () => {
  it('payload 只包含白名单字段', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'Contact',
      eventId: 'event_1',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      fbp: 'fb.1.1',
      fbc: 'fb.1.2',
      customData: { method_type: 'telegram', email: 'user@example.test' },
    })
    expect(JSON.stringify(payload)).toContain('telegram')
    expect(JSON.stringify(payload)).not.toContain('user@example.test')
  })

  it('Meta 4xx 不重试，5xx 重试', () => {
    expect(classifyMetaCapiError(400)).toBe('permanent')
    expect(classifyMetaCapiError(500)).toBe('retryable')
  })
})
```

- [ ] **Step 3: Implement CAPI service**

Create `packages/api/src/services/meta-capi.ts`:

```ts
type MetaCapiPayloadInput = {
  eventName: string
  eventId: string
  eventTime: number
  eventSourceUrl: string
  actionSource: 'website'
  fbp?: string
  fbc?: string
  customData?: Record<string, unknown>
}

export function buildMetaCapiPayload(input: MetaCapiPayloadInput) {
  return {
    data: [{
      event_name: input.eventName,
      event_time: input.eventTime,
      event_id: input.eventId,
      event_source_url: input.eventSourceUrl,
      action_source: input.actionSource,
      user_data: {
        fbp: input.fbp || undefined,
        fbc: input.fbc || undefined,
      },
      custom_data: sanitizeCustomData(input.customData || {}),
    }],
  }
}

export function classifyMetaCapiError(status: number) {
  if (status >= 500 || status === 429) return 'retryable'
  return 'permanent'
}

function sanitizeCustomData(input: Record<string, unknown>) {
  const allowed = ['method_type', 'action_type', 'location', 'content_name', 'content_category']
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.includes(key) && typeof value !== 'object'))
}
```

Add `sendMetaCapiEvent(env, deliveryId)`:

- Read delivery and conversion action by `deliveryId`.
- If `META_CAPI_ACCESS_TOKEN` missing, mark delivery `skipped/missing_secret`.
- If delivery already `sent`, mark duplicate as `duplicate_suppressed`.
- Send `fetch()` to Meta CAPI endpoint configured from Pixel ID setting.
- On 2xx mark `sent`.
- On 4xx mark `failed` with truncated error.
- On 5xx throw an Error so Queue retries.

- [ ] **Step 4: Enqueue delivery from conversion service**

Modify `packages/api/src/services/conversions.ts`:

- After creating a `meta_capi` delivery with status `pending`, call `env.META_CAPI_QUEUE?.send({ deliveryId })` only when `meta_capi_enabled` setting is true.
- If disabled, write delivery status `skipped` and `skip_reason = 'disabled'`.
- If missing Queue binding, write `skipped` and `skip_reason = 'missing_queue'`.

- [ ] **Step 5: Add queue consumer**

Modify `packages/api/src/index.ts` export default:

```ts
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env))
  },
  async queue(batch: MessageBatch<{ deliveryId: string }>, env: Bindings) {
    const { sendMetaCapiEvent } = await import('./services/meta-capi')
    for (const message of batch.messages) {
      try {
        await sendMetaCapiEvent(env, message.body.deliveryId)
        message.ack()
      } catch (error) {
        console.error('[meta-capi] delivery failed', { deliveryId: message.body.deliveryId, message: error instanceof Error ? error.message : 'unknown' })
        message.retry()
      }
    }
  },
}
```

Keep existing scheduled behavior intact.

- [ ] **Step 6: Update admin Meta API**

Modify `packages/api/src/routes/admin/attribution.ts`:

- `/meta` includes `secretPresent: Boolean(c.env.META_CAPI_ACCESS_TOKEN)`.
- `/meta/test-event` owner-only creates a test conversion delivery with `test_event_code` when `META_CAPI_TEST_EVENT_CODE` exists.
- Write audit action `attribution.meta_test_event`.

- [ ] **Step 7: Run API tests and dry-run build**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- meta-capi.test.ts attribution.test.ts conversions.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/api build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/wrangler.toml packages/api/src/index.ts packages/api/src/services/meta-capi.ts packages/api/src/services/meta-capi.test.ts packages/api/src/services/conversions.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts docs/DEPLOYMENT.md
git commit -m "feat: 增加 Meta CAPI 队列投递"
```

### Task 7: Readiness Gates, Documentation, And Production Safety

**Files:**
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/UI_DATA_ANALYTICS_DASHBOARD.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `packages/web/tests/e2e/smoke.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: release checklist in docs and readiness UI.
- Produces: CI gate that runs attribution tests through existing jobs.

- [ ] **Step 1: Update technical specification**

Modify `docs/TECHNICAL_SPEC.md`:

- Add a section under data analytics describing `analytics_conversion_actions`, `analytics_conversion_deliveries`, `analytics_conversion_daily`, and `analytics_conversion_delivery_daily`.
- State that `/api/conversions/events` is public but rate-limited and does not accept sensitive fields.
- State that `/api/admin/attribution/*` requires admin+ and Test Event requires owner.
- State that CAPI uses Cloudflare Queues and Worker Secret `META_CAPI_ACCESS_TOKEN`.

- [ ] **Step 2: Update UI dashboard spec**

Modify `docs/UI_DATA_ANALYTICS_DASHBOARD.md`:

- Add a boundary note: `/admin/analytics` remains one-party behavior analytics.
- Add a cross-link: advertising attribution and Meta delivery status live under `/admin/attribution`.
- Remove “Meta 像素测试地址” wording if present.

- [ ] **Step 3: Update deployment docs**

Modify `docs/DEPLOYMENT.md`:

- Add dev and production Queue creation commands:

```bash
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi-dev
```

- Add secret commands:

```bash
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_ACCESS_TOKEN
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_TEST_EVENT_CODE
```

- Add rollback:

```bash
# 后台关闭 meta_capi_enabled
# 后台关闭 facebook_pixel_enabled
# 如需停止队列消费，回滚 API Worker 到上一版本
```

- [ ] **Step 4: Add CI attribution smoke labels**

Modify `.github/workflows/ci.yml` only if attribution tests need explicit names. Keep existing command structure:

```yaml
- name: Web 组件测试
  run: pnpm --filter @meigallery/web test:unit

- name: API 单元测试
  run: pnpm --filter @meigallery/api test
```

Do not add production deployment workflow.

- [ ] **Step 5: Run full local verification**

Run:

```bash
corepack pnpm lint
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web typecheck
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/api test:coverage
corepack pnpm --filter @meigallery/web test:e2e
corepack pnpm --filter @meigallery/web build
corepack pnpm --filter @meigallery/api build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/TECHNICAL_SPEC.md docs/UI_DATA_ANALYTICS_DASHBOARD.md docs/DEPLOYMENT.md docs/PROJECT_STATUS.md packages/web/tests/e2e/smoke.spec.ts .github/workflows/ci.yml
git commit -m "docs: 完善归因中心发布闸门"
```

---

## 3. Execution Order

1. Task 1 must complete before Task 2 because API services depend on conversion contracts and D1 tables.
2. Task 2 must complete before Task 3 because the frontend calls `/api/conversions/events`.
3. Task 4 can start after Task 1, but final tests require Task 2 ledger queries.
4. Task 5 can start after Task 4 because UI consumes admin attribution endpoints.
5. Task 6 starts after Task 2 because CAPI consumes delivery rows.
6. Task 7 runs last because it documents the completed behavior and validates the release gates.

---

## 4. Testing Matrix

| Area | Command | Blocking Condition |
|------|---------|--------------------|
| Shared and API contracts | `corepack pnpm --filter @meigallery/api test -- conversions.test.ts` | ID 不稳定、敏感字段进入 payload、映射缺失 |
| Ledger service | `corepack pnpm --filter @meigallery/api test -- conversions.test.ts analytics-ingest.test.ts` | 重复联系派生重复 Lead、账本未写入 |
| Frontend conversion | `corepack pnpm --filter @meigallery/web test:unit -- useConversionTracking.test.ts ContactPanel.test.ts` | 业务组件直接调用 Pixel、联系方式值泄露 |
| Admin attribution API | `corepack pnpm --filter @meigallery/api test -- attribution.test.ts` | 非 admin 可访问、owner-only 缺失、单日查询错误 |
| Admin UI | `corepack pnpm --filter @meigallery/web test:unit -- useAdminAttribution.test.ts AttributionPageShell.test.ts` | 单日不可查、tabs 缺失、错误态不可见 |
| E2E | `corepack pnpm --filter @meigallery/web test:e2e` | 点击联系、注册、归因中心 smoke 失败 |
| Build | `corepack pnpm --filter @meigallery/web build && corepack pnpm --filter @meigallery/api build` | Worker build 失败 |

---

## 5. Manual Verification

- 在 dev Worker 打开一个带 `mg_source`、`utm_campaign`、`utm_content` 的投放追踪链接。
- 点击右下角联系方式，确认后台 `/admin/attribution` 单日有效联系 +1。
- 注册新账号，确认后台完成注册 +1，且没有 StartTrial。
- 使用 Meta Pixel Helper 验证浏览器事件包含 `eventID`。
- 使用 Meta Test Events 验证 CAPI 事件包含相同 `event_id`。
- 在 Worker Logs 搜索邮箱、联系方式值、`token=`、`originals/`、`imports/`，结果必须为 0。
- 在后台关闭 `meta_capi_enabled` 后再次点击联系，站内转化仍写入，CAPI delivery 显示 skipped/disabled。

---

## 6. Commit And Push Policy

- 每个 Task 完成后本地提交一次。
- Task 1 到 Task 7 可在本地连续完成，不推送非关键中间状态。
- 完整功能阶段完成并通过 full local verification 后，再按用户确认统一推送 `dev`。
- 合入 `main` 和生产部署另走发布流程，不在本计划自动执行。

---

## 7. Self-Review

- Spec coverage: 计划覆盖归因中心 UI、转化账本、投放链接、Meta 同步健康、重复诊断、发布检查、测试矩阵和回滚开关。
- Scope split: 计划按 7 个可独立提交任务拆分；Task 6 将 CAPI Queue 后置，避免阻塞站内账本上线。
- Completeness scan: 本计划不包含未落地的泛化指令或要求读者自行补齐的步骤。
- Type consistency: `ConversionActionType`、`ConversionDeliveryStatus`、`useConversionTracking()`、`recordConversionAction()`、`adminAttributionRoutes` 在任务内声明后再被后续任务引用。
- Risk control: 每个任务包含失败测试、通过测试、类型检查或构建命令，以及中文 commit message。
