# Meta Pixel 与 CAPI 生产就绪加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Meta Pixel/CAPI 从代码可用状态提升为具备真实授权、双通道去重、CAPI 匹配数据、Queue/DLQ 可靠性、准确后台口径和强制生产放行证据的正式投放状态。

**Architecture:** 站内转化账本继续作为唯一事实源。API Worker 统一生成 Pixel 指令与 CAPI delivery，浏览器只执行服务端指令并回传 `attempted`，CAPI 通过 Cloudflare Queue 携带短期匹配数据并在 DLQ 中完成最终失败回写；发布脚本把真实 Meta Test Events 与 Cloudflare 资源检查绑定到最终 commit。

**Tech Stack:** Nuxt 4、Vue 3、Hono、TypeScript、Cloudflare Workers、D1、Queues、Worker Secrets、Vitest、Playwright、Node.js test runner、Wrangler。

## Global Constraints

- 所有交互、文档、注释、UI 文案和 commit message 使用中文；代码标识符、API 路径和通用缩写保留英文。
- 只使用 Cloudflare Workers、D1、R2、Queues 和 Worker Secrets，不引入非 Cloudflare 常驻基础设施。
- 站内 `analytics_conversion_actions` 是唯一事实源，Pixel/CAPI 不能反向覆盖转化事实。
- 正式 Meta 事件限定为 `Contact`、`Lead`、`CompleteRegistration`；公开 API 不再接受 `start_trial`。
- 只有 `marketing_consent_state=granted` 且 `meta_tracking_mode` 为 `test` 或 `production` 时才允许 Meta delivery。
- 不发送邮箱、手机号、联系方式值、会员备注、私有媒体路径、token 或后台操作信息。
- D1 不长期保存客户端 IP、User-Agent、`fbp` 或 `fbc`；这些值只允许存在于当前 Queue message。
- Pixel 只记录 `attempted`，不得记录为 Meta 已接收的 `sent`。
- CAPI 请求超时固定为 8 秒；主 Queue `max_retries=5`、`retry_delay=60`，重试耗尽进入对应环境 DLQ。
- Meta Graph API 继续固定为当前代码的 `v25.0` 并以 URL contract test 锁定；版本升级作为独立兼容性变更，不混入本次可靠性重构。
- Meta 关键 API 模块覆盖率阈值为 statements 85%、branches 80%、functions 85%、lines 85%。
- 每个任务按测试先行、最小实现、验证、复审、中文 commit 的顺序完成；非关键阶段提交保留本地，功能闭环后统一推送。
- 不在本计划执行生产部署；生产资源创建、secret 配置和部署只在用户明确要求上线时执行。

---

## File Structure

- `packages/shared/src/utils/conversion-events.ts`：Web/API 共用的转化去重键、Meta 事件 ID 和运行模式归一化。
- `packages/shared/src/types/index.ts`：Meta tracking、Pixel instruction、Queue message 和 delivery 状态类型。
- `packages/api/migrations/0034_meta_production_readiness.sql`：delivery `attempted` 状态、保守 tracking mode、发布验证摘要表。
- `packages/web/app/utils/marketingConsent.ts`：授权 cookie 的纯函数与归一化。
- `packages/web/app/composables/useMarketingConsent.ts`：用户授权状态与 cookie 生命周期。
- `packages/web/app/components/MarketingConsentBanner.vue`：首次访问的最小营销授权界面。
- `packages/api/src/utils/pixel-receipt.ts`：Pixel 回执 HMAC 的签发与验证。
- `packages/api/src/utils/meta-browser-identifiers.ts`：`fbp/fbc/fbclid` 和 CAPI 临时匹配数据校验。
- `packages/web/app/utils/metaBrowserIdentifiers.ts`：浏览器 cookie 与落地参数读取。
- `packages/api/src/services/conversions.ts`：统一创建转化、Pixel 指令与 CAPI Queue message。
- `packages/api/src/services/meta-capi.ts`：白名单 payload、8 秒超时和 Meta 响应分类。
- `packages/api/src/services/meta-capi-queue.ts`：主 Queue 重试与 DLQ 最终失败处理。
- `packages/api/src/routes/conversions.ts`：公开转化与 Pixel attempted 回执 API。
- `packages/api/src/routes/admin/attribution.ts`：Meta 状态、严格 Test Event 与 readiness。
- `scripts/meta-live-verification-lib.mjs`：Meta live evidence schema 与生产 gate 校验。
- `scripts/record-meta-live-verification.mjs`：交互式记录 Owner 在 Events Manager 完成的 Browser/Server 去重确认。
- `scripts/release-verification-store.mjs`：将已通过检查的脱敏摘要安全写入对应环境 D1。
- `scripts/verify-meta-resources.mjs`：Wrangler 远端资源、secret、consumer 和 migration 检查。
- `scripts/verify-dev-rehearsal.mjs`、`scripts/verify-release.mjs`：真实 dev Meta 验证与 release 编排。

### Task 1: 建立共享事件契约与 D1 兼容迁移

**Files:**
- Create: `packages/shared/src/utils/conversion-events.ts`
- Create: `packages/api/migrations/0034_meta_production_readiness.sql`
- Create: `scripts/verify-meta-migration.mjs`
- Create: `scripts/verify-meta-migration.test.mjs`
- Modify: `packages/shared/src/utils/index.ts`
- Modify: `packages/shared/src/types/index.ts:69-97`
- Modify: `packages/api/src/utils/conversions.ts:1-96`
- Modify: `packages/api/src/utils/conversions.test.ts`
- Modify: `packages/api/src/utils/site-settings.ts:1-32`
- Modify: `packages/api/src/utils/site-settings.test.ts`
- Modify: `packages/api/src/utils/analytics-migrations.test.ts`
- Modify: `package.json`
- Test: `packages/api/src/utils/conversions.test.ts`

**Interfaces:**
- Consumes: 现有 `ConversionActionType`、`ConversionMetaEventName`、`AnalyticsConsentState`。
- Produces: `MetaTrackingMode`、`PublicConversionActionType`、`MetaPixelInstruction`、`MetaCapiQueueMessage`、`buildConversionDedupeKey()`、`buildExternalEventId()`、`normalizeMetaTrackingMode()`。

- [ ] **Step 1: 写共享契约失败测试**

在 `packages/api/src/utils/conversions.test.ts` 改为从 `@meigallery/shared/utils` 导入共享函数，并新增：

```ts
it('共享契约生成稳定事件 ID 并保守归一化 Meta 模式', () => {
  const input = {
    actionType: 'contact' as const,
    sessionId: 'session_abc',
    visitorId: 'visitor_abc',
    occurredDate: '2026-07-10',
    methodType: 'telegram',
    actionTarget: 'floating_contact_panel',
  }
  expect(buildConversionDedupeKey(input)).toBe('contact:session_abc:telegram:floating_contact_panel')
  expect(buildExternalEventId({ ...input, metaEventName: 'Contact' })).toBe(
    'meta:Contact:contact:session_abc:telegram:floating_contact_panel',
  )
  expect(normalizeMetaTrackingMode('production')).toBe('production')
  expect(normalizeMetaTrackingMode('hybrid')).toBe('disabled')
  expect(normalizeMetaTrackingMode('limited')).toBe('disabled')
})
```

`analytics-migrations.test.ts` 断言 0034 使用 `defer_foreign_keys`、完整复制 14 个旧字段、保留 `sent`、加入 `attempted/has_fbp/has_fbc`、重建两个索引且不删除 conversion action 事实表。`verify-meta-migration.test.mjs` 先导入尚不存在的 runner，并用 mock command 断言任何 seed、0034 apply 或结果核验失败都会使演练失败。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/conversions.test.ts src/utils/analytics-migrations.test.ts
node --test scripts/verify-meta-migration.test.mjs
```

Expected: FAIL，提示共享函数、0034 和 migration runner 尚不存在。

- [ ] **Step 3: 新增共享类型与纯函数**

在 `packages/shared/src/types/index.ts` 定义：

```ts
export type MetaTrackingMode = 'disabled' | 'test' | 'production'
export type PublicConversionActionType = Extract<ConversionActionType, 'contact' | 'complete_registration'>
export type ConversionDeliveryStatus = 'pending' | 'attempted' | 'sent' | 'failed' | 'skipped' | 'duplicate_suppressed'

export interface MetaPixelInstruction {
  deliveryId: string
  eventName: Extract<ConversionMetaEventName, 'Contact' | 'Lead' | 'CompleteRegistration'>
  eventId: string
  payload: Record<string, string | number | boolean>
  receiptToken: string
}

export interface MetaCapiUserData {
  fbp?: string
  fbc?: string
  clientIpAddress?: string
  clientUserAgent?: string
}

export interface MetaCapiQueueMessage {
  schemaVersion: 1
  deliveryId: string
  userData: MetaCapiUserData
}
```

创建 `packages/shared/src/utils/conversion-events.ts`：

```ts
import type { ConversionActionType, ConversionMetaEventName, MetaTrackingMode } from '../types'

export interface ConversionDedupeInput {
  actionType: ConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  methodType?: string
  actionTarget?: string
}

export function buildConversionDedupeKey(input: ConversionDedupeInput) {
  if (input.actionType === 'contact') {
    return `contact:${input.sessionId}:${normalizePart(input.methodType)}:${normalizePart(input.actionTarget)}`
  }
  if (input.actionType === 'lead') return `lead:${input.sessionId}`
  if (input.actionType === 'complete_registration' || input.actionType === 'start_trial') {
    return `${input.actionType}:${input.sessionId}:${input.occurredDate}`
  }
  return `${input.actionType}:${input.visitorId}:${input.occurredDate}`
}

export function buildExternalEventId(input: ConversionDedupeInput & { metaEventName: ConversionMetaEventName }) {
  return `meta:${input.metaEventName}:${buildConversionDedupeKey(input)}`
}

export function normalizeMetaTrackingMode(value: unknown): MetaTrackingMode {
  return value === 'test' || value === 'production' ? value : 'disabled'
}

function normalizePart(value: unknown) {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown'
}
```

从 `packages/shared/src/utils/index.ts` 导出该模块；API `utils/conversions.ts` 保留 metadata 清洗与 `metaEventForConversion()`，删除重复 ID 函数并改为导入共享实现。

- [ ] **Step 4: 新增顺序 migration**

创建 `0034_meta_production_readiness.sql`。完整 SQL 固定如下，先以临时表重建 `analytics_conversion_deliveries`，扩展状态约束并增加不含原值的匹配覆盖布尔标记，再保守归一化 tracking mode 并创建发布验证摘要表：

```sql
PRAGMA defer_foreign_keys = true;

CREATE TABLE analytics_conversion_deliveries_v2 (
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
  has_fbp INTEGER NOT NULL DEFAULT 0,
  has_fbc INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('meta_pixel', 'meta_capi')),
  CHECK (status IN ('pending', 'attempted', 'sent', 'failed', 'skipped', 'duplicate_suppressed')),
  CHECK (has_fbp IN (0, 1)),
  CHECK (has_fbc IN (0, 1))
);

INSERT INTO analytics_conversion_deliveries_v2 (
  id,
  conversion_action_id,
  channel,
  external_event_id,
  event_name,
  status,
  skip_reason,
  error_code,
  error_message,
  attempt_count,
  has_fbp,
  has_fbc,
  last_attempt_at,
  sent_at,
  created_at,
  updated_at
)
SELECT
  id,
  conversion_action_id,
  channel,
  external_event_id,
  event_name,
  status,
  skip_reason,
  error_code,
  error_message,
  attempt_count,
  0,
  0,
  last_attempt_at,
  sent_at,
  created_at,
  updated_at
FROM analytics_conversion_deliveries;

DROP TABLE analytics_conversion_deliveries;
ALTER TABLE analytics_conversion_deliveries_v2 RENAME TO analytics_conversion_deliveries;

CREATE UNIQUE INDEX idx_analytics_conversion_deliveries_external
  ON analytics_conversion_deliveries(channel, external_event_id);
CREATE INDEX idx_analytics_conversion_deliveries_status
  ON analytics_conversion_deliveries(status, updated_at);

INSERT INTO site_settings (key, value, updated_at)
VALUES ('meta_tracking_mode', '"disabled"', datetime('now'))
ON CONFLICT(key) DO UPDATE SET
  value = CASE
    WHEN site_settings.value IN ('"test"', '"production"') THEN site_settings.value
    ELSE '"disabled"'
  END,
  updated_at = datetime('now');

CREATE TABLE IF NOT EXISTS analytics_release_verifications (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  environment TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (status IN ('passed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_release_verifications_lookup
  ON analytics_release_verifications(environment, verification_type, verified_at DESC);

PRAGMA defer_foreign_keys = false;
```

不要修改 `0032` 或 `0033`。

- [ ] **Step 5: 实现既有数据迁移演练**

`verify-meta-migration.mjs` 使用 Node `fs/promises` 在 `.wrangler-release-verify/meta-migration/` 生成临时 pre-0034 SQL，按文件名顺序拼接 `0001` 到 `0033`，然后通过 `runCommand()` 依次：

1. 在独立 `--local --persist-to` D1 执行 pre-0034 SQL。
2. 插入一条 conversion action、`meta_pixel/sent` 和 `meta_capi/pending` delivery，并把 mode 设为 `"limited"`。
3. 执行原始 `0034_meta_production_readiness.sql`。
4. 使用 `wrangler d1 execute --json` 查询 delivery、`PRAGMA index_list` 和 setting。
5. 断言两条历史 delivery 的所有旧字段不变、布尔标记均为 0、mode 为 `disabled`、两个索引存在，并实际插入一条 `attempted` delivery。

任何命令失败、JSON 结构异常或断言失败都退出 1；`finally` 删除临时 SQL，但保留 D1 状态目录供失败诊断。`package.json` 增加 `"verify:meta-migration": "node scripts/verify-meta-migration.mjs"`。

- [ ] **Step 6: 将 tracking mode 加入设置白名单**

在 `ADMIN_SETTING_KEYS` 与 `PUBLIC_SETTING_KEYS` 加入 `meta_tracking_mode`；`meta_capi_enabled` 继续保持 admin-only。新增测试断言公开设置包含 mode，但不包含 CAPI 开关或 secret。

- [ ] **Step 7: 运行契约、设置、迁移和类型测试**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/conversions.test.ts src/utils/site-settings.test.ts src/utils/analytics-migrations.test.ts
node --test scripts/verify-meta-migration.test.mjs
corepack pnpm verify:meta-migration
corepack pnpm --filter @meigallery/shared typecheck
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交 Task 1**

```bash
git add packages/shared/src packages/api/src/utils packages/api/migrations/0034_meta_production_readiness.sql scripts/verify-meta-migration.mjs scripts/verify-meta-migration.test.mjs package.json
git commit -m "feat: 建立 Meta 生产事件契约"
```

### Task 2: 实现用户营销授权与 Pixel 加载门禁

**Files:**
- Create: `packages/web/app/utils/marketingConsent.ts`
- Create: `packages/web/app/utils/marketingConsent.test.ts`
- Create: `packages/web/app/composables/useMarketingConsent.ts`
- Create: `packages/web/app/components/MarketingConsentBanner.vue`
- Create: `packages/web/app/components/MarketingConsentBanner.test.ts`
- Modify: `packages/web/app/layouts/default.vue`
- Modify: `packages/web/app/plugins/facebook-pixel.client.ts`
- Create: `packages/web/app/plugins/facebook-pixel.client.test.ts`
- Modify: `packages/web/app/composables/useFacebookPixel.ts:20-100`
- Modify: `packages/web/app/composables/useSiteSettings.ts:14-205`
- Modify: `packages/api/src/routes/admin/settings.ts:70-105`
- Modify: `packages/api/src/routes/admin/settings.test.ts`
- Modify: `packages/api/src/routes/public-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MetaTrackingMode` 与 `normalizeMetaTrackingMode()`。
- Produces: `useMarketingConsent()`，返回 `{ state, grant, deny, reset, canTrackMarketing }`；cookie 名固定为 `mei_marketing_consent`。

- [ ] **Step 1: 写授权纯函数和组件失败测试**

`marketingConsent.test.ts`：

```ts
it('只有 granted 且 Meta 模式可运行时允许营销追踪', () => {
  expect(canTrackMarketing('granted', 'production')).toBe(true)
  expect(canTrackMarketing('granted', 'test')).toBe(true)
  expect(canTrackMarketing('limited', 'production')).toBe(false)
  expect(canTrackMarketing('denied', 'production')).toBe(false)
  expect(canTrackMarketing('granted', 'disabled')).toBe(false)
})
```

`MarketingConsentBanner.test.ts` 验证默认显示“同意营销追踪”和“仅必要功能”，点击后分别调用 `grant()`、`deny()`，已有选择时不显示。`facebook-pixel.client.test.ts` 断言初始 limited 不初始化、当前页点击同意后立即初始化并发送一次 PageView、denied 后续导航不再发送事件。`facebookPixel.test.ts` 还要覆盖 adapter 已初始化后授权改为 denied 时，PageView、标准事件和自定义事件均不再调用 `fbq`。

- [ ] **Step 2: 运行 Web 测试并确认失败**

Run: `corepack pnpm --filter @meigallery/web test:unit -- app/utils/marketingConsent.test.ts app/components/MarketingConsentBanner.test.ts app/plugins/facebook-pixel.client.test.ts`

Expected: FAIL，提示目标模块不存在。

- [ ] **Step 3: 实现授权状态和 consent banner**

`marketingConsent.ts`：

```ts
import type { AnalyticsConsentState, MetaTrackingMode } from '@meigallery/shared'

export function normalizeMarketingConsent(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied' ? value : 'limited'
}

export function canTrackMarketing(consent: AnalyticsConsentState, mode: MetaTrackingMode) {
  return consent === 'granted' && (mode === 'test' || mode === 'production')
}
```

`useMarketingConsent.ts` 直接把 cookie、运行模式和授权判断收束在一个 composable 中：

```ts
import type { AnalyticsConsentState } from '@meigallery/shared'
import { canTrackMarketing as isMarketingTrackingAllowed, normalizeMarketingConsent } from '~/utils/marketingConsent'

export function useMarketingConsent() {
  const config = useRuntimeConfig()
  const { metaTrackingMode } = useSiteSettings()
  const cookie = useCookie<AnalyticsConsentState>('mei_marketing_consent', {
    default: () => 'limited',
    sameSite: 'lax',
    secure: config.public.appEnv === 'production',
    maxAge: 15_552_000,
  })
  const state = computed(() => normalizeMarketingConsent(cookie.value))
  const canTrackMarketing = computed(() => isMarketingTrackingAllowed(state.value, metaTrackingMode.value))
  const grant = () => { cookie.value = 'granted' }
  const deny = () => { cookie.value = 'denied' }
  const reset = () => { cookie.value = 'limited' }
  return { state, grant, deny, reset, canTrackMarketing }
}
```

Banner 只在 `state === 'limited'` 时显示，是固定底部全宽提示带，使用“同意营销追踪”和“仅必要功能”两个明确按钮并分别调用 `grant()`、`deny()`；不使用嵌套卡片。

- [ ] **Step 4: 接入默认布局与 Pixel plugin**

在 `default.vue` 放置 `<MarketingConsentBanner />`。Pixel plugin 不缓存启动时的 config，抽取 `trackAllowedPage(fullPath)`，每次都重新读取 settings 与授权；用 `watch([...], trackAllowedPage, { immediate: true })` 处理当前页授权变化，用 `router.afterEach()` 处理后续导航：

```ts
const { facebookPixelEnabled, facebookPixelId, facebookPixelDebugEnabled } = useSiteSettings()
const { canTrackMarketing } = useMarketingConsent()

function trackAllowedPage(fullPath: string) {
  const config = resolveFacebookPixelConfig({
    enabled: facebookPixelEnabled.value,
    pixelId: facebookPixelId.value,
    debugEnabled: facebookPixelDebugEnabled.value,
  }, runtimeConfig)
  const pathname = new URL(fullPath, 'https://site.local').pathname
  if (!config.enabled || !canTrackMarketing.value || isAdminPath(pathname) || hasSensitiveAnalyticsUrl(fullPath)) return
  initFacebookPixel(config.pixelId, config.debugEnabled, fullPath)
  trackPageView(fullPath)
}

watch(
  [facebookPixelEnabled, facebookPixelId, facebookPixelDebugEnabled, canTrackMarketing],
  () => trackAllowedPage(route.fullPath),
  { immediate: true },
)
router.afterEach(to => trackAllowedPage(to.fullPath))
```

移除 `useFacebookPixel.ts` 中恒为 `true` 的 `hasTrackingConsent()`。`useFacebookPixel()` 自身读取 `useMarketingConsent().canTrackMarketing`，`initFacebookPixel()` 和底层 `callFbq()` 每次执行都必须再次校验；plugin 是第一层门禁，adapter 是不可绕过的第二层门禁。`trackAllowedPage()` 使用传入 URL 的 pathname 判断 admin 路由，不能使用可能滞后的 `route.path`。

- [ ] **Step 5: 接入 tracking mode 设置读写**

在 `useSiteSettings()` 增加 `meta_tracking_mode` 字段和 `metaTrackingMode` computed。后台 settings route 使用 `normalizeMetaTrackingMode()` 校验；公开 API 返回规范值。历史值一律显示为 `disabled`。

- [ ] **Step 6: 验证授权门禁**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- app/utils/marketingConsent.test.ts app/components/MarketingConsentBanner.test.ts app/plugins/facebook-pixel.client.test.ts app/utils/facebookPixel.test.ts
corepack pnpm --filter @meigallery/api test -- src/routes/public-settings.test.ts src/routes/admin/settings.test.ts
corepack pnpm --filter @meigallery/web typecheck
```

Expected: 全部 PASS；测试断言 `limited/denied` 时不会调用 `initFacebookPixel()`，同意后无需刷新即可初始化。

- [ ] **Step 7: 提交 Task 2**

```bash
git add packages/web/app packages/api/src/routes/admin/settings.ts packages/api/src/routes/admin/settings.test.ts packages/api/src/routes/public-settings.test.ts
git commit -m "feat: 增加 Meta 营销授权门禁"
```

### Task 3: 由 API 统一返回 Contact、Lead 与注册 Pixel 指令

**Files:**
- Create: `packages/api/src/utils/pixel-receipt.ts`
- Create: `packages/api/src/utils/pixel-receipt.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/api/src/routes/conversions.test.ts`
- Modify: `packages/api/src/index.ts:35-53`
- Modify: `packages/web/app/composables/useConversionTracking.ts`
- Modify: `packages/web/app/composables/useConversionTracking.test.ts`
- Modify: `packages/web/app/composables/useFacebookPixel.ts`
- Modify: `packages/web/app/utils/facebookPixel.test.ts`
- Modify: `scripts/verify-local-runtime.mjs`
- Modify: `scripts/verify-dev-rehearsal.mjs`

**Interfaces:**
- Consumes: Task 1 的共享 ID 函数和 `MetaPixelInstruction`，Task 2 的 `useMarketingConsent()`。
- Produces: `createPixelReceiptToken(secret, claims)`、`verifyPixelReceiptToken(secret, token)`、`RecordConversionResult.pixelEvents`；公开 conversion actions 仅 `contact | complete_registration`。

- [ ] **Step 1: 写 HMAC 和服务端 Pixel 指令失败测试**

创建 `pixel-receipt.test.ts`：

```ts
it('Pixel 回执令牌绑定 delivery、event 和五分钟有效期', async () => {
  const token = await createPixelReceiptToken('secret', {
    deliveryId: 'cdlv_1', eventId: 'meta:Contact:contact:session_1:telegram:panel', expiresAt: 1_783_600_300,
  })
  await expect(verifyPixelReceiptToken('secret', token, 1_783_600_000)).resolves.toMatchObject({ deliveryId: 'cdlv_1' })
  await expect(verifyPixelReceiptToken('secret', token, 1_783_600_301)).rejects.toThrow('Pixel 回执已过期')
  await expect(verifyPixelReceiptToken('other', token, 1_783_600_000)).rejects.toThrow('Pixel 回执签名无效')
})
```

在 `conversions.test.ts` 新增：

```ts
it('首次授权联系返回 Contact 和 Lead 两条同源 Pixel 指令', async () => {
  const result = await recordConversionAction(envFor(createConversionDb()), grantedContactInput())
  expect(result.pixelEvents.map(item => item.eventName)).toEqual(['Contact', 'Lead'])
  expect(result.pixelEvents[0]?.eventId).toBe('meta:Contact:contact:session_1:telegram:floating_contact_panel')
  expect(result.pixelEvents[1]?.eventId).toBe('meta:Lead:lead:session_1')
})

it.each(['limited', 'denied'] as const)('%s 不创建 Meta delivery 或 Pixel 指令', async consentState => {
  const db = createConversionDb()
  const result = await recordConversionAction(envFor(db), { ...grantedContactInput(), consentState })
  expect(result.pixelEvents).toEqual([])
  expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
})
```

在 route test 断言 `start_trial` 返回 400 `CONVERSION_ACTION_INVALID`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `corepack pnpm --filter @meigallery/api test -- src/utils/pixel-receipt.test.ts src/services/conversions.test.ts src/routes/conversions.test.ts`

Expected: FAIL，HMAC utility 与 `pixelEvents` 尚不存在，且 `start_trial` 仍被接受。

- [ ] **Step 3: 实现领域隔离 HMAC**

在 `pixel-receipt.ts` 实现固定格式 `<base64url-json>.<base64url-signature>`。签名输入必须为 `meigallery:pixel-receipt:v1:<payload>`，算法 HMAC-SHA-256。Claims 只包含 `deliveryId`、`eventId`、`expiresAt`，验证时先比较 32 字节签名，再解析 claims 和检查有效期；格式错误统一抛出“Pixel 回执无效”。核心接口固定为：

```ts
export interface PixelReceiptClaims {
  deliveryId: string
  eventId: string
  expiresAt: number
}

export async function createPixelReceiptToken(
  secret: string,
  claims: PixelReceiptClaims,
): Promise<string>

export async function verifyPixelReceiptToken(
  secret: string,
  token: string,
  nowSeconds?: number,
): Promise<PixelReceiptClaims>
```

签名比较循环固定执行 32 次；长度错误只改变比较结果，不提前返回。`expiresAt` 必须是整数且晚于 `nowSeconds`，`deliveryId`、`eventId` 必须为非空字符串。

- [ ] **Step 4: 重构 delivery 创建返回值**

将结果类型改为：

```ts
export interface RecordConversionResult {
  id: string
  actionType: ConversionActionType
  created: boolean
  duplicateOf: string
  derivedActions: Array<{ id: string; actionType: ConversionActionType }>
  pixelEvents: MetaPixelInstruction[]
}
```

`recordConversionAction()` 的 env 类型扩为：

```ts
type ConversionEnv = Pick<Bindings, 'DB' | 'APP_ENV' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>
```

`createMetaDeliveries()` 返回 `MetaPixelInstruction[]`；只有 consent 为 `granted`、`meta_tracking_mode` 为 `test | production`、Pixel 开关开启、Pixel ID 通过 `^\d{5,30}$` 校验且 Pixel delivery 新建为 `pending` 时返回指令。CAPI delivery 也必须通过相同 consent/mode 门禁。每条 Pixel 指令都直接调用 Task 3 的 `createPixelReceiptToken()`，有效期固定为当前时间后 300 秒。CAPI delivery 入队消息先使用完整版本化外壳：

```ts
await env.META_CAPI_QUEUE.send({
  schemaVersion: 1,
  deliveryId,
  userData: {},
})
```

当前基线消息使用空 `userData`，因此 Task 3 本身即可通过类型检查；临时标识接入任务只替换该字段的来源。`recordDerivedLead()` 同时返回派生 action 与 Pixel 指令，重复动作返回空数组。`packages/api/src/index.ts` 中 binding 同步改为：

```ts
META_CAPI_QUEUE?: Queue<MetaCapiQueueMessage>
```

- [ ] **Step 5: 移除公开 StartTrial**

将 route allow-list 固定为：

```ts
const PUBLIC_CONVERSION_ACTIONS = new Set(['contact', 'complete_registration'])
```

删除 local/dev release smoke 中的 `start_trial` POST 和统计断言；数据库类型继续兼容历史记录。

`metaEventForConversion('start_trial')` 改为返回 `null`，`useFacebookPixel.ts` 的标准事件联合类型移除 `StartTrial`。这样即使内部旧调用绕过公开 allow-list，也不会创建新的 Meta StartTrial delivery。

- [ ] **Step 6: 前端只使用服务端指令**

`useConversionTracking()` 改为读取 `useMarketingConsent()`，conversion body 的 `consentState` 使用用户营销授权。删除 Web 内部重复的 `META_EVENT` 和 ID 构造函数。API 固定把主动作指令放在 `pixelEvents[0]`，派生 Lead 放在其后；前端用第一条指令的 event ID 关联 analytics 兼容事件，API 最终失败时兼容事件使用空 ID。API 成功后遍历 `response.data.pixelEvents`，按服务端提供的 `eventName`、`payload`、`eventId` 调用 adapter；回执由 Task 4 接入：

```ts
for (const instruction of response.data.pixelEvents) {
  pixel.trackStandardEvent(instruction.eventName, instruction.payload, { eventID: instruction.eventId })
}
```

conversion API 首次失败时返回用户流程，不发送 Pixel；将清洗后的 body 放入模块内存队列，定时最多补发 3 次，补发成功后执行服务端返回的指令，不写 localStorage/sessionStorage。

- [ ] **Step 7: 验证服务与 Web 事件契约**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/pixel-receipt.test.ts src/services/conversions.test.ts src/routes/conversions.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/composables/useConversionTracking.test.ts app/utils/facebookPixel.test.ts app/components/ContactMethodItem.test.ts app/components/ContactPanel.test.ts app/pages/register.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web typecheck
```

Expected: 全部 PASS；首次联系发送 Contact+Lead，注册只发送 CompleteRegistration，所有测试不出现 StartTrial。

- [ ] **Step 8: 提交 Task 3**

```bash
git add packages/api/src packages/web/app/composables scripts/verify-local-runtime.mjs scripts/verify-dev-rehearsal.mjs
git commit -m "refactor: 统一 Meta 浏览器事件指令"
```

### Task 4: 实现 Pixel attempted 回执与幂等重试

**Files:**
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/api/src/routes/conversions.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/web/app/composables/useConversionTracking.ts`
- Modify: `packages/web/app/composables/useConversionTracking.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `MetaPixelInstruction`、`verifyPixelReceiptToken()`。
- Produces: `POST /api/conversions/pixel-receipts` 与幂等 `markPixelAttempted()`。

- [ ] **Step 1: 写 attempted route 失败测试**

Route test 使用 Task 3 的真实 `createPixelReceiptToken()` 签发 fixture，断言合法回执只把 `meta_pixel/pending` 更新为 `attempted`，重复请求返回 200 且不重复增加日聚合；CAPI delivery、event ID 与数据库不一致、伪造 token 均返回 400 `PIXEL_RECEIPT_INVALID`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `corepack pnpm --filter @meigallery/api test -- src/utils/pixel-receipt.test.ts src/routes/conversions.test.ts`

Expected: FAIL，`pixel-receipts` route 与状态转换尚不存在。

- [ ] **Step 3: 实现 attempted route 与状态转换**

新增：

```ts
conversionRoutes.post('/pixel-receipts', async (c) => {
  try {
    const body = await c.req.json<{ deliveryId?: string; attempted?: boolean; receiptToken?: string }>()
    const claims = await verifyPixelReceiptToken(c.env.SESSION_SECRET, String(body.receiptToken || ''))
    if (body.attempted !== true || claims.deliveryId !== body.deliveryId) {
      return errorJson(c, 400, 'Pixel 回执无效', { code: 'PIXEL_RECEIPT_INVALID' })
    }
    const result = await markPixelAttempted(c.env.DB, claims)
    return c.json({ data: result })
  } catch {
    return errorJson(c, 400, 'Pixel 回执无效', { code: 'PIXEL_RECEIPT_INVALID' })
  }
})
```

`markPixelAttempted()` 查询 channel、external event ID、当前状态与 action 日期，只允许 `meta_pixel` 且 claims `eventId` 必须与数据库一致；`pending -> attempted` 时更新 delivery 和日聚合，已 attempted 返回幂等成功。令牌允许重放请求，但只有第一次产生状态变化和聚合增量，因此具备一次性效果。

- [ ] **Step 4: 前端回传 attempted**

Pixel adapter 返回 `true` 后调用 receipt API。失败时使用 `[250, 1000, 3000]` 毫秒重试队列；队列只存在模块内存且最多 100 条。`fbq` 返回 false 时不回传 attempted。

- [ ] **Step 5: 验证 Pixel 状态口径**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/pixel-receipt.test.ts src/routes/conversions.test.ts src/services/conversions.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/composables/useConversionTracking.test.ts app/utils/facebookPixel.test.ts
```

Expected: 全部 PASS；代码和 fixture 不再新增 `meta_pixel/sent`。

- [ ] **Step 6: 提交 Task 4**

```bash
git add packages/api/src/routes packages/api/src/services packages/web/app/composables/useConversionTracking.ts packages/web/app/composables/useConversionTracking.test.ts
git commit -m "feat: 记录 Pixel 尝试回执"
```

### Task 5: 补齐 fbp、fbc、IP 与 User-Agent 临时匹配数据

**Files:**
- Create: `packages/web/app/utils/metaBrowserIdentifiers.ts`
- Create: `packages/web/app/utils/metaBrowserIdentifiers.test.ts`
- Create: `packages/api/src/utils/meta-browser-identifiers.ts`
- Create: `packages/api/src/utils/meta-browser-identifiers.test.ts`
- Modify: `packages/web/app/composables/useConversionTracking.ts`
- Modify: `packages/web/app/composables/useConversionTracking.test.ts`
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/index.ts:35-53`

**Interfaces:**
- Consumes: Task 1 的 `MetaCapiUserData`、`MetaCapiQueueMessage`。
- Produces: `readMetaBrowserIdentifiers(document.cookie, route.query.fbclid, now)`、`buildMetaCapiUserData(request, bodyIdentifiers)`。

- [ ] **Step 1: 写标识格式失败测试**

```ts
it('读取合法 _fbp 并从 fbclid 生成 _fbc', () => {
  expect(readMetaBrowserIdentifiers('_fbp=fb.1.1700000000000.123456789', 'CLICK_abc-123', 1_700_000_000_000)).toEqual({
    fbp: 'fb.1.1700000000000.123456789',
    fbc: 'fb.1.1700000000000.CLICK_abc-123',
  })
})

it('拒绝控制字符、超长值和业务 metadata 伪造字段', () => {
  expect(normalizeMetaBrowserIdentifiers({ fbp: 'bad\nvalue', fbc: 'x'.repeat(300) })).toEqual({})
})
```

- [ ] **Step 2: 运行 Web/API 标识测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- app/utils/metaBrowserIdentifiers.test.ts
corepack pnpm --filter @meigallery/api test -- src/utils/meta-browser-identifiers.test.ts
```

Expected: FAIL，目标模块不存在。

- [ ] **Step 3: 实现浏览器读取与 API 校验**

允许格式：

```ts
const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBCLID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
```

Web 只在授权为 granted 时读取 cookie/query 并放入 conversion body 的 `browserIdentifiers`。API 忽略 metadata 中的同名字段，只接受顶层对象并再次校验。

- [ ] **Step 4: 在 API Worker 构造临时 userData**

`buildMetaCapiUserData()` 合并合法 `fbp/fbc`、`CF-Connecting-IP` 和 `User-Agent`，IP 最长 64 字符、User-Agent 最长 512 字符，包含控制字符时丢弃。route 只通过非持久化 context 传给 service：

```ts
export interface RecordConversionContext {
  metaCapiUserData: MetaCapiUserData
}

await recordConversionAction(c.env, conversionInput, {
  metaCapiUserData: buildMetaCapiUserData(c.req.raw, body.browserIdentifiers),
})
```

`recordConversionAction()` 的第三参数默认 `{ metaCapiUserData: {} }`，保证内部调用和历史测试兼容。该对象只进入：

```ts
const message: MetaCapiQueueMessage = {
  schemaVersion: 1,
  deliveryId,
  userData,
}
await env.META_CAPI_QUEUE.send(message)
```

创建 CAPI delivery 时只把 `has_fbp`、`has_fbc` 以 `0 | 1` 写入对应列，供后台计算匹配覆盖率；不写原值。不要把 `userData` 写入 conversion metadata、D1、审计日志或返回体。

- [ ] **Step 5: 验证 Queue message 与报告脱敏**

扩展 service tests，断言 Queue 收到四个 allow-list 字段，delivery 只保存 `has_fbp/has_fbc` 布尔值，SQL params 的其他位置、API response 和错误日志不包含 IP、User-Agent、fbp/fbc 原值。

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/meta-browser-identifiers.test.ts src/services/conversions.test.ts src/routes/conversions.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/utils/metaBrowserIdentifiers.test.ts app/composables/useConversionTracking.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交 Task 5**

```bash
git add packages/api/src packages/web/app packages/shared/src/types/index.ts
git commit -m "feat: 补齐 CAPI 临时匹配数据"
```

### Task 6: 加固 CAPI 超时、状态转换、重试与 DLQ

**Files:**
- Create: `packages/api/src/services/meta-capi-queue.ts`
- Create: `packages/api/src/services/meta-capi-queue.test.ts`
- Modify: `packages/api/src/services/meta-capi.ts`
- Modify: `packages/api/src/services/meta-capi.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/index.ts:339-359`
- Modify: `packages/api/wrangler.toml:33-40,80-87`
- Modify: `scripts/verify-dev-resources.mjs`
- Modify: `scripts/verify-dev-resources.test.mjs`

**Interfaces:**
- Consumes: Task 5 的 `MetaCapiQueueMessage`。
- Produces: `handleMetaCapiBatch(batch, env)`、`computeMetaRetryDelay(attempts)`、结构化 `MetaCapiSendResult.eventsReceived`。

- [ ] **Step 1: 写超时、响应与 DLQ 失败测试**

在 `meta-capi.test.ts` 新增 Graph URL 固定使用 `/v25.0/<pixel-id>/events`、2xx 但 `events_received=0` 为 permanent failure、网络超时为 retryable failure、token 不出现在结果。`meta-capi-queue.test.ts` 新增：

```ts
it('主 Queue 对 retryable 错误退避重试，DLQ 回写 retry_exhausted', async () => {
  expect(computeMetaRetryDelay(1)).toBe(60)
  expect(computeMetaRetryDelay(2)).toBe(300)
  expect(computeMetaRetryDelay(3)).toBe(900)
  await handleMetaCapiBatch(mainBatchWithRetryableMessage(), env)
  expect(mainMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  await handleMetaCapiBatch(dlqBatch(), env)
  expect(db.delivery.error_code).toBe('retry_exhausted')
  expect(dlqMessage.ack).toHaveBeenCalled()
})
```

同文件再覆盖已 sent delivery：不调用 `fetch`，message ack，返回 `duplicate_suppressed`，D1 delivery 仍为 sent，sent 聚合不减少，duplicate_suppressed 诊断只增加一次。

- [ ] **Step 2: 运行 CAPI 测试并确认失败**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts`

Expected: FAIL，queue service 与 `eventsReceived` 尚不存在。

- [ ] **Step 3: 实现 8 秒组合超时与 Meta 响应解析**

`sendMetaCapiEvent()` 接受可注入 `fetchFn` 和 `timeoutMs=8000`。使用 `AbortController` 保留调用方 signal；2xx JSON 必须满足 `events_received === 1` 才标记 sent。返回：

```ts
export interface MetaCapiSendResult {
  deliveryId: string
  status: ConversionDeliveryStatus
  reason?: string
  eventsReceived?: number
  traceId?: string
}
```

429、5xx、网络错误和超时抛出带 `retryable=true` 的领域错误；确定性 4xx 和 2xx/0 不重试。

- [ ] **Step 4: 实现状态桶转换**

抽取 `transitionDeliveryStatus()`：同一状态重试只更新 `attempt_count/last_attempt_at`，不重复增加日聚合；状态变化时在 D1 batch 中将旧 bucket 减 1、新 bucket 加 1。delivery 创建时先写 pending bucket。Pixel attempted 和 CAPI sent/failed 共用此函数。`sent` 是不可降级终态：Queue 重投时 delivery 继续保持 sent，adapter 返回 `duplicate_suppressed` 诊断结果，并只给 daily 的 duplicate_suppressed 诊断桶加 1，不再次调用 Meta、不从 sent 桶扣减。

- [ ] **Step 5: 实现主 Queue 与 DLQ handler**

`handleMetaCapiBatch()` 通过 `batch.queue.endsWith('-dlq')` 区分：

- 主 Queue：逐条 await，成功/永久失败 ack，可重试错误按 60/300/900/1800 秒上限 retry。
- DLQ：调用 `markRetryExhausted()`，写 `status=failed,error_code=retry_exhausted`，然后 ack。
- 已 sent：不调用 Meta，记录一次 duplicate_suppressed 诊断后 ack，delivery 仍为 sent。

`index.ts` 的 queue handler 只调用该 service。

- [ ] **Step 6: 配置生产和 dev DLQ**

生产 consumer：

```toml
[[queues.consumers]]
queue = "meigallery-meta-capi"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 5
retry_delay = 60
dead_letter_queue = "meigallery-meta-capi-dlq"

[[queues.consumers]]
queue = "meigallery-meta-capi-dlq"
max_batch_size = 10
max_batch_timeout = 5
```

dev 使用 `meigallery-meta-capi-dev-dlq`，batch size 5。更新资源隔离脚本，断言 dev/prod 主 Queue 与 DLQ 名称均不交叉。

- [ ] **Step 7: 验证 CAPI 与 Wrangler**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/services/conversions.test.ts
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
corepack pnpm --filter @meigallery/api exec wrangler deploy --env dev --dry-run --outdir=dist-dev
```

Expected: 全部 PASS；两个 dry-run 都显示主 Queue 和 DLQ consumer。

- [ ] **Step 8: 提交 Task 6**

```bash
git add packages/api/src packages/api/wrangler.toml scripts/verify-dev-resources.mjs scripts/verify-dev-resources.test.mjs
git commit -m "feat: 加固 Meta CAPI 队列可靠性"
```

### Task 7: 强化 Meta 管理 API、严格 Test Event 与 Readiness 数据

**Files:**
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/api/src/index.ts:35-53`
- Modify: `packages/api/src/utils/site-settings.ts`
- Modify: `packages/api/src/routes/admin/settings.ts`

**Interfaces:**
- Consumes: Task 4 的 Pixel attempted、Task 6 的 CAPI 结构化结果与 Task 1 的 release verification 表。
- Produces: `/api/admin/attribution/meta` 分渠道统计、`/meta/test-event` 严格结果、分级 readiness checks。

- [ ] **Step 1: 写 Meta API 与 readiness 失败测试**

更新 fixture，禁止构造 `meta_pixel/sent`。新增断言：

```ts
expect(body.data.totals).toMatchObject({
  pixel_attempted_count: 2,
  capi_sent_count: 1,
  capi_failed_count: 0,
  retry_exhausted_count: 0,
})
expect(body.data.checks).toEqual(expect.arrayContaining([
  expect.objectContaining({ key: 'meta_live_verification', level: 'blocker', ok: true }),
  expect.objectContaining({ key: 'pending_too_long', level: 'warning', ok: true }),
]))
```

Test Event tests覆盖：mode 非 test 返回 409；缺 token/code 返回 503；Meta `events_received=1` 返回 200；skipped/failed 不得返回成功 toast 所需状态。

- [ ] **Step 2: 运行 attribution 测试并确认失败**

Run: `corepack pnpm --filter @meigallery/api test -- src/routes/admin/attribution.test.ts`

Expected: FAIL，当前 API 仍混合 sent，readiness 只有四项。

- [ ] **Step 3: 分离 Pixel 与 CAPI 指标**

`/meta` 使用 channel 条件聚合：Pixel 只统计 attempted/pending/skipped；CAPI delivery 统计 sent/failed/skipped，duplicate_suppressed 从 delivery daily 诊断桶读取；`lastSentAt` 只读取 `channel='meta_capi'`。返回 `secretPresent`、`testEventCodePresent`、`queueBindingPresent`。

匹配覆盖率固定使用近 7 天：`fbpCoverage` 的分母是状态为 pending/sent/failed/duplicate_suppressed 的 CAPI delivery；`fbcCoverage` 的分母进一步限定 action 的 `source_channel='ad'` 且 `lower(utm_source) IN ('facebook', 'fb', 'meta', 'instagram')`。分子只读取 `has_fbp/has_fbc=1`，skipped 和自然来源不进入对应分母。

- [ ] **Step 4: 实现严格 Owner Test Event**

仅 `meta_tracking_mode=test` 可执行。缺 token、code、Pixel ID 时返回 503 并写审计；使用当前管理请求的 IP/User-Agent 构建临时 userData，直接调用 CAPI adapter。只有 `status=sent && eventsReceived=1` 返回 200；永久失败返回 424，可重试错误返回 503。响应和审计只保存布尔存在状态、delivery ID、eventsReceived、traceId 和错误分类。

- [ ] **Step 5: 实现分层 readiness**

返回结构：

```ts
type ReadinessCheck = {
  key: string
  label: string
  level: 'blocker' | 'warning'
  ok: boolean
  detail: string
}
```

阻断项逐项实现并分别测试：conversion migration/table 存在、analytics enabled、账本有近期数据、Pixel ID/mode 一致、mode 为 test/production 时 token/code/queue 存在、当前 `RELEASE_COMMIT` 同时有未过期 `meta_live` 与 `meta_resources` 摘要、24 小时无 retry_exhausted、同 action/event 的 Pixel/CAPI external ID 一致。警告项：pending 超过 10 分钟、永久 4xx、近 7 天样本达到 20 后 fbp 覆盖率低于 80%、Meta 付费样本达到 20 后 fbc 覆盖率低于 70%、Pixel attempted 样本达到 20 后 CAPI sent/Pixel attempted 低于 80%、人工确认超过 30 天；样本不足时显示“样本不足”但不判定质量异常。

Bindings 新增 `RELEASE_COMMIT?: string`。`ready` 只由 blocker 决定。

- [ ] **Step 6: 验证后台 API**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/admin/attribution.test.ts src/services/meta-capi.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: 全部 PASS，JSON 不包含 token、Test Event Code、IP、User-Agent、fbp 或 fbc。

- [ ] **Step 7: 提交 Task 7**

```bash
git add packages/api/src
git commit -m "feat: 强化 Meta 同步与发布检查"
```

### Task 8: 更新管理后台设置、Meta 状态和发布检查 UI

**Files:**
- Modify: `packages/web/app/pages/admin/settings.vue:13-55,142-224,539-567`
- Modify: `packages/web/app/pages/admin/attribution/meta.vue`
- Modify: `packages/web/app/pages/admin/attribution/readiness.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionHealthStrip.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionHealthStrip.test.ts`
- Modify: `packages/web/app/utils/attributionReadiness.ts`
- Modify: `packages/web/app/utils/attributionReadiness.test.ts`
- Modify: `packages/web/tests/e2e/mock-api.mjs`
- Modify: `packages/web/tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Task 7 的分渠道 totals、`ReadinessCheck.level` 和 settings。
- Produces: Owner 可配置 `disabled/test/production` 的控制面；Pixel attempted/CAPI sent 独立可视化。

- [ ] **Step 1: 写 UI 失败测试**

Attribution strip 测试固定断言六项：Pixel 状态、CAPI 状态、Pixel 尝试、CAPI 成功、失败、跳过。Readiness utility 测试显示 `meta_tracking_mode`、resource verification 时间，不显示 secret。Playwright mock 添加 blocker/warning，并断言页面分别显示“阻断项”和“警告项”。

- [ ] **Step 2: 运行 Web 测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- app/components/admin/attribution/AttributionHealthStrip.test.ts app/utils/attributionReadiness.test.ts
corepack pnpm --filter @meigallery/web test:e2e -- --project=desktop-1024 -g "归因"
```

Expected: FAIL，旧 UI 仍显示合并“已同步”。

- [ ] **Step 3: 更新站点设置控制面**

在 Facebook 广告归因 fieldset 增加 select：

```vue
<select v-model="metaTrackingMode" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
  <option value="disabled">关闭</option>
  <option value="test">测试</option>
  <option value="production">生产</option>
</select>
```

`meta_capi_enabled` 只有 readiness blocker 全通过后才允许开启；当前 UI 无 readiness 数据时保持禁用，并提供跳转 `/admin/attribution/readiness`，不在 settings 页面复制完整诊断。

- [ ] **Step 4: 分离 Meta 状态指标**

`AttributionHealthStrip` props 改为 `pixelAttemptedCount`、`capiSentCount`、`failedCount`、`skippedCount`。Meta 页面显示 CAPI token/Test Code/Queue binding 的存在状态，Test Event toast 使用 API 返回：成功显示“Meta 已接收 1 条测试事件”，失败显示后端错误，不能再显示“已进入审计记录”作为成功。

- [ ] **Step 5: 分组 readiness**

`readiness.vue` 分为 blocker 与 warning 两个无嵌套区段。blocker 未通过使用红色，warning 未通过使用琥珀色；顶部状态文案只有全部 blocker 通过时显示“生产阻断项已通过”，不得显示“正式投放就绪”，最终 L4 仍依赖 release evidence。

- [ ] **Step 6: 验证 UI、响应式和构建**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm --filter @meigallery/web test:e2e
corepack pnpm --filter @meigallery/web typecheck
corepack pnpm --filter @meigallery/web build
```

Expected: 全部 PASS；360、768、1024、1440 四个 viewport 无横向溢出或状态文字重叠。

- [ ] **Step 7: 提交 Task 8**

```bash
git add packages/web/app packages/web/tests
git commit -m "feat: 重整 Meta 生产就绪看板"
```

### Task 9: 建立 Meta live evidence、Cloudflare 资源检查和生产强门禁

**Files:**
- Create: `scripts/meta-live-verification-lib.mjs`
- Create: `scripts/meta-live-verification-lib.test.mjs`
- Create: `scripts/record-meta-live-verification.mjs`
- Create: `scripts/record-meta-live-verification.test.mjs`
- Create: `scripts/release-verification-store.mjs`
- Create: `scripts/release-verification-store.test.mjs`
- Create: `scripts/verify-meta-resources.mjs`
- Create: `scripts/verify-meta-resources.test.mjs`
- Modify: `scripts/verify-dev-rehearsal.mjs`
- Modify: `scripts/verify-dev-rehearsal.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/release-verification-lib.mjs`
- Modify: `scripts/release-verification-lib.test.mjs`
- Modify: `scripts/deploy.sh`
- Modify: `packages/api/vitest.config.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 7 的严格 Test Event/readiness、Task 6 的 Queue/DLQ 配置。
- Produces: `reports/meta-live-verification/latest.json`、`verify:meta-resources`、`recordReleaseVerificationSummary()`、release report 的 `metaLiveVerification` 与 `metaResources`。

- [ ] **Step 1: 写 live evidence 与 gate 失败测试**

定义合法证据：

```js
const evidence = {
  schemaVersion: 1,
  status: 'passed',
  commit: 'current-sha',
  verifiedAt: '2026-07-10T00:00:00.000Z',
  expiresAt: '2026-07-11T00:00:00.000Z',
  pixelIdSuffix: '6781',
  events: ['Contact', 'Lead', 'CompleteRegistration'].map(eventName => ({
    eventName,
    browser: true,
    server: true,
    eventIdMatched: true,
    eventIdDigest: 'sha256:4f81c8a9142d',
    deduplicated: true,
  })),
  confirmedBy: 'owner',
}
```

测试拒绝：commit 不同、过期、缺事件、Browser/Server 任一 false、eventIdMatched false、digest 格式错误、deduplicated false、出现 StartTrial、包含原始 event ID、token/test code/fbp/fbc/IP。

- [ ] **Step 2: 运行脚本测试并确认失败**

Run: `corepack pnpm test:scripts`

Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现 evidence schema 与脱敏校验**

`assertMetaLiveEvidenceCanGateProduction(evidence, { expectedCommit, now })` 强制 24 小时有效期和三事件集合完全相等。`writeMetaLiveEvidence()` 写时间戳文件与 latest；调用现有 redaction 后再扫描敏感模式。

`.gitignore` 增加 `reports/meta-live-verification/*.json`，保留目录 README。

- [ ] **Step 4: 实现 Owner 人工证据录入命令**

`record-meta-live-verification.mjs` 必须以交互方式读取确认人、测试 Pixel ID，以及每个正式事件在 Events Manager 中显示的 Browser event ID、Server event ID 和去重结果；脚本自行比较 ID，只在完全一致时写 `eventIdMatched=true`，并将 ID 转为 `sha256:<前 12 位>`，原值不写文件、不打印。最后必须明确确认 Test Events 中没有 `StartTrial`。

在 `package.json` 增加：

```json
{
  "scripts": {
    "verify:meta-live": "node scripts/record-meta-live-verification.mjs"
  }
}
```

操作者在当前 commit 已部署到 dev 后运行 `corepack pnpm verify:meta-live`；任一事件缺 Browser/Server、ID 不同、未去重或存在 StartTrial 时命令退出 1，不生成证据。证据只保存 Pixel ID 后四位、event ID digest、commit、时间和确认人。

- [ ] **Step 5: 实现 Cloudflare 资源检查与摘要记录**

`verify-meta-resources.mjs --env dev|production` 使用 `runCommand()` 执行。环境映射固定为：production 传参数数组 `['--env', '']` 并使用 `meigallery-db`，dev 传 `['--env', 'dev']` 并使用 `meigallery-db-dev`，不得把 production 误映射成不存在的命名环境。

检查命令为：

```text
wrangler queues info <main-queue>
wrangler queues info <dlq>
wrangler queues consumer worker list <main-queue> --json
wrangler queues consumer worker list <dlq> --json
wrangler secret list --env <env> --format json
wrangler d1 migrations list <db> --env <env> --remote
wrangler d1 execute <db> --env <env> --remote --command "SELECT value FROM site_settings WHERE key = 'meta_capi_enabled'"
```

解析 JSON secret/consumer 结果；queue info 与 migration 输出只检查 exit code 和明确的 “Migrations to be applied” 标记。生产要求 token+Test Code 和无待应用 migration，dev 同样要求独立 secret。报告保存 `capiEnabled` 布尔值和资源名称，不保存 setting 原始输出。

首次启用阶段通过 `--initial-meta-rollout` 明确标记；该模式额外要求 `meta_capi_enabled=false` 并把 `initialMetaRollout=true` 写入报告。完成首次 Owner Test Event 和正式开启后，后续常规发布不再要求关闭 CAPI，但仍检查 Queue、DLQ、secret、migration、失败率和 live evidence。

`release-verification-store.mjs` 导出 `recordReleaseVerificationSummary()`，以参数数组调用 Wrangler，把当前 commit 的脱敏摘要 `INSERT OR REPLACE` 到 `analytics_release_verifications`。记录 ID 固定为 `rvf_<environment>_<verificationType>_<commit>`，`verificationType` 只允许 `meta_resources | meta_live`，有效期固定 24 小时。SQL 值只允许来自环境枚举、40 位 commit、固定 verification type、ISO 时间和 `JSON.stringify()` 后经过单引号转义的布尔摘要。

资源检查全部通过后调用该 helper 记录 `meta_resources`。测试必须证明 token、Test Code、Cloudflare resource ID 和命令原始输出均不会进入 SQL 或报告。`--report-only` 只执行只读检查，不写 D1，供排障使用。

- [ ] **Step 6: 严格化 dev rehearsal**

删除 `meta-test-event-code-missing` note 成功路径。dev seed 使用 `meta_tracking_mode=test`。conversion smoke 使用 `consentState=granted`，只发送 contact 与 complete_registration，并轮询 `/api/admin/attribution/meta`，直到 Contact、Lead、CompleteRegistration 的 CAPI sent 都 >=1 或 30 秒超时。

严格 Test Event 只有 API `status=sent,eventsReceived=1,testEventCodePresent=true` 才通过。缺 secret/code、skipped、failed 一律使 step failed，同时仍执行 owner cleanup。

- [ ] **Step 7: 将 coverage、资源和 evidence 加入 release**

先把 Meta 关键模块显式加入 `packages/api/vitest.config.ts` 的 coverage include，并为这些文件设置独立聚合阈值；保留现有全局阈值，不用 Meta 阈值掩盖其他模块：

```ts
const META_COVERAGE_FILES = [
  'src/utils/conversions.ts',
  'src/utils/pixel-receipt.ts',
  'src/utils/meta-browser-identifiers.ts',
  'src/services/conversions.ts',
  'src/services/meta-capi.ts',
  'src/services/meta-capi-queue.ts',
  'src/routes/conversions.ts',
  'src/routes/admin/attribution.ts',
]

const META_COVERAGE_GLOB = 'src/{utils/conversions,utils/pixel-receipt,utils/meta-browser-identifiers,services/conversions,services/meta-capi,services/meta-capi-queue,routes/conversions,routes/admin/attribution}.ts'

// coverage.include
include: [
  'src/utils/password.ts',
  'src/utils/session.ts',
  'src/utils/permission.ts',
  'src/utils/membership.ts',
  'src/utils/import-validation.ts',
  'src/utils/import-token.ts',
  'src/utils/api-error.ts',
  'src/services/email-verification.ts',
  'src/middleware/auth.ts',
  'src/middleware/rate-limit.ts',
  ...META_COVERAGE_FILES,
],

// coverage.thresholds
[META_COVERAGE_GLOB]: {
  statements: 85,
  branches: 80,
  functions: 85,
  lines: 85,
},
```

`test:coverage` 必须在报告中列出上述八个文件；任一文件未被 include 时测试脚本失败。

`QUICK_STEPS` 新增：

```js
{
  name: 'api-coverage',
  command: 'corepack',
  args: ['pnpm', '--filter', '@meigallery/api', 'run', 'test:coverage'],
}
```

release 在 dev-rehearsal 后运行 dev 与 production resource check，读取 live evidence，并把摘要写入 release report。首次上线命令使用 `META_INITIAL_ROLLOUT=1 corepack pnpm verify:release`，脚本只接受精确值 `1` 并将其映射为 resource check 的 `--initial-meta-rollout`；后续常规发布不设置该变量。live evidence 校验通过后，分别向 dev 和 production D1 写入同 commit 的 `meta_live` 脱敏摘要，供两个环境的后台 readiness 读取；任一写入失败都使 release 失败。

`assertReportCanGateProduction()` 强制工作区干净、分支为 `main` 或 `release/*`、当前 commit 的 evidence 与两套 resource check 均 passed；若报告标记首次上线，则同时强制生产检查中的 `capiEnabled=false`。最终生产部署只接受 `main` 上同一 commit 的报告。

- [ ] **Step 8: 让 deploy 传递 RELEASE_COMMIT 并二次校验**

生产和 dev deploy 命令增加：

```bash
GIT_COMMIT="$(git rev-parse HEAD)"
"${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"
```

生产 gate 在任何 D1 migration 前执行；检查失败不得创建资源、写 D1 或部署 Worker。

- [ ] **Step 9: 验证所有发布脚本**

Run:

```bash
corepack pnpm test:scripts
corepack pnpm verify:quick
```

Expected: 全部 PASS；`verify:quick` 报告包含 `api-coverage`。不配置真实 Meta secret 时不要运行 `verify:release`，脚本测试必须证明缺配置时 release 会失败。

- [ ] **Step 10: 提交 Task 9**

```bash
git add scripts packages/api/vitest.config.ts package.json .gitignore reports/meta-live-verification/README.md
git commit -m "test: 增加 Meta 正式投放强门禁"
```

### Task 10: 更新文档、完成本地验证并准备真实 dev 联调

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/GIT_WORKFLOW.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/UI_DATA_ANALYTICS_DASHBOARD.md`
- Modify: `docs/superpowers/specs/2026-07-08-meta-capi-attribution-layer-design.md`
- Modify: `.superpowers/sdd/progress.md`（本地进度文件，不提交）

**Interfaces:**
- Consumes: Tasks 1-9 的最终命令、状态和资源名称。
- Produces: 可执行的 dev/production 配置顺序、回滚顺序和真实联调交接清单。

- [ ] **Step 1: 更新实现状态与部署顺序**

文档必须明确：

```text
正式事件：Contact / Lead / CompleteRegistration
不支持：StartTrial
Pixel 状态：attempted，不代表 Meta 接收
CAPI 状态：sent 才代表 Graph API events_received=1
dev Queue/DLQ：meigallery-meta-capi-dev / meigallery-meta-capi-dev-dlq
prod Queue/DLQ：meigallery-meta-capi / meigallery-meta-capi-dlq
上线顺序：代码关闭态 -> dev live evidence -> 生产资源 -> migration -> 最终 main HEAD 重新部署 dev 并生成同 commit evidence -> main 同 commit release -> 生产部署 -> test 模式 Owner Test Event -> production 模式 -> 开关 -> 观察
```

生产 migration 后 `meta_tracking_mode` 保持 `disabled`，`meta_capi_enabled=false`。API/Web 部署完成后，Owner 先将 mode 设为 `test` 并执行严格 Test Event；确认 `events_received=1` 后切为 `production`，再次检查营销授权门禁，再开启 CAPI。任一步失败都切回 `disabled` 并保持 CAPI 关闭。

旧设计文档顶部更新为“核心架构已实现，生产放行细节由 2026-07-10 设计覆盖”，不删除历史决策。

- [ ] **Step 2: 运行 migration 和全量本地验证**

Run:

```bash
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --local --persist-to ../../.wrangler-release-verify/meta-readiness
corepack pnpm verify:meta-migration
corepack pnpm lint
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api test:coverage
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm --filter @meigallery/web test:e2e
corepack pnpm --filter @meigallery/web exec nuxt build
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
```

Expected: 全部 PASS；migration 可在空本地 D1 一次应用完成，coverage 达到全局约束。

- [ ] **Step 3: 审查敏感数据与工作区**

Run:

```bash
rg -n "META_CAPI_ACCESS_TOKEN=|META_CAPI_TEST_EVENT_CODE=|access_token=|_fbp=|_fbc=" packages scripts docs reports --glob '!**/node_modules/**'
git diff --check
git status --short
```

Expected: 第一条只命中变量名、测试 fixture 固定值或文档命令，不出现真实值；`git diff --check` 无输出；status 只包含本任务预期文档和进度变更。

- [ ] **Step 4: 更新本地进度并提交文档**

在 `.superpowers/sdd/progress.md` 记录每个 Task 的 commit、测试和复审结果。提交可追踪文档：

```bash
git add docs
git commit -m "docs: 完善 Meta 正式投放流程"
```

- [ ] **Step 5: 真实 dev 联调前置检查**

只读运行：

```bash
corepack pnpm --filter @meigallery/api exec wrangler secret list --env dev --format json
corepack pnpm --filter @meigallery/api exec wrangler queues info meigallery-meta-capi-dev
corepack pnpm --filter @meigallery/api exec wrangler queues info meigallery-meta-capi-dev-dlq
```

Expected: secret 名称包含 `META_CAPI_ACCESS_TOKEN`、`META_CAPI_TEST_EVENT_CODE`；两个 Queue 均存在。若不满足，停止在 L1，不部署 dev，不伪造 live evidence，并向用户报告需要在 Meta Events Manager 取得测试凭证。

- [ ] **Step 6: 功能闭环提交检查**

Run:

```bash
git status --short
git log --oneline --decorate -12
git rev-list --count origin/dev..HEAD
```

Expected: 工作区干净；Tasks 1-10 均有独立中文 commit；未自动推送、未部署生产。

## Execution Dependencies

```text
Task 1
  -> Task 2
  -> Task 3
  -> Task 4
  -> Task 5
  -> Task 6
  -> Task 7
  -> Task 8
  -> Task 9
  -> Task 10
```

Tasks 4 与 5 都依赖 Task 3，但二者不能并行提交：Task 5 的 Queue message 需要 Task 4 已稳定的 conversion response 和 delivery 状态转换。Task 8 依赖 Task 7 的 API shape。Task 9 依赖 Tasks 6-8 的最终状态语义。

## Production Resource Handoff

代码实施不自动创建或修改生产资源。用户明确要求上线后，按以下命令执行，secret 值通过 Wrangler 交互输入，不写入 shell history、文档或日志：

```bash
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi-dlq
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_ACCESS_TOKEN --env=""
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_TEST_EVENT_CODE --env=""
```

dev 使用对应 `-dev` 和 `-dev-dlq` 名称，并配置测试 Pixel 的独立 token/code。生产 token 不允许复用到 dev。
