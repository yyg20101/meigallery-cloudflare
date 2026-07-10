# Meta CAPI v2 业务事实收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Meta 正式转化收口为 `Contact` 与 `CompleteRegistration` 两个事件，并保证每个业务动作只有一个事实生产者、一个统一 Tracking Facade 和一套可验证的双通道事件契约。

**Architecture:** 联系成功由 `POST /api/conversions/events` 创建 `Contact`；注册成功由 `POST /api/auth/register` 在用户写入后创建 `CompleteRegistration`。`analytics-ingest` 只消费分析事件，不能创建转化；Web 只能通过 `useTracking()` 执行分析与 Pixel 派生动作，页面和组件不能直接调用 Meta 适配器。

**Tech Stack:** Nuxt 4、Vue 3、Hono、TypeScript、Cloudflare D1、Cloudflare Queues、Vitest、Playwright、ESLint、Node.js test runner。

**Source of truth:** `docs/superpowers/specs/2026-07-10-meta-capi-v2-architecture-design.md`

**Depends on:** 无。本计划是另外两份 Meta CAPI v2 计划的强制前置阶段。

## Global Constraints

- 正式 Meta 事件只允许 `Contact`、`CompleteRegistration`；不再创建或投递新的 `Lead`、`StartTrial`。
- 历史 `Lead`、`start_trial` 数据保留只读，不执行 destructive migration，不把历史行重算为新口径。
- `membership_grant` 继续作为第一方运营指标，但不是 Meta 转化事件。
- 公开转化 API 只接受 `contact`；`complete_registration` 只能由注册 API 的服务端成功路径创建。
- 联系事实只在用户激活经过 URL 安全校验的原生聊天链接，或成功复制联系方式后创建；二维码展开只写第一方分析事件。浏览器无法证明第三方页面已加载，因此口径是“安全跳转已发起”，不是“对方已收到消息”。
- 注册事实只在用户记录成功写入后创建；转化写入或 Meta 投递失败不能回滚已完成注册。
- Analytics、Pixel、CAPI 都是业务事实的派生消费者，任何派生消费者都不能反向创建业务事实。
- 每项任务必须先写失败测试，再做最小实现，再运行定向测试和完整验证，最后形成中文本地 commit。
- 本计划不配置 CAPI secret、不创建生产资源、不部署生产环境。

---

## Target Ownership

| 业务事实 | 唯一生产者 | 允许的派生消费者 |
|---|---|---|
| 联系成功 | `packages/api/src/routes/conversions.ts` 调用 `recordContact()` | Analytics、Pixel `Contact`、CAPI `Contact` |
| 注册成功 | `packages/api/src/routes/auth.ts` 调用 `recordRegistration()` | Analytics、Pixel `CompleteRegistration`、CAPI `CompleteRegistration` |
| 二维码展开 | `useTracking().trackAnalytics()` | Analytics |
| 页面浏览/搜索 | `useTracking().trackAnalytics()` 与 Pixel adapter | Analytics、Pixel `PageView/ViewContent/Search` |

## Target Interfaces

在 `packages/shared/src/types/index.ts` 固定活动契约：

```ts
export type ActiveConversionActionType = 'contact' | 'complete_registration'
export type ActiveMetaEventName = 'Contact' | 'CompleteRegistration'
export type PublicConversionActionType = 'contact'

export interface MetaPixelInstruction {
  deliveryId: string
  eventName: ActiveMetaEventName
  eventId: string
  payload: Record<string, string | number | boolean>
  receiptToken: string
}
```

活动去重键固定为：Contact 使用 `contact:<sessionId>:<methodType>:<actionTarget>`；CompleteRegistration 使用 `complete_registration:user:<userId>`。注册去重不再依赖客户端 session 或业务日期。

在 `packages/api/src/services/conversions.ts` 暴露两个业务入口，通用写入函数保持模块私有：

```ts
export interface RecordContactInput extends BaseConversionInput {
  methodType: string
  actionTarget: string
}

export interface RecordRegistrationInput extends BaseConversionInput {
  userId: number
  metadata: { method: 'email' }
}

export function recordContact(
  env: ConversionEnv,
  input: RecordContactInput,
  context?: RecordConversionContext,
): Promise<RecordConversionResult>

export function recordRegistration(
  env: ConversionEnv,
  input: RecordRegistrationInput,
  context?: RecordConversionContext,
): Promise<RecordConversionResult>
```

Web Tracking Facade 的公开表面固定为：

```ts
export function useTracking(): {
  trackAnalytics: ReturnType<typeof useAnalytics>['track']
  trackContact(input: {
    methodType: string
    actionTarget: string
    actionType: 'open_link' | 'copy'
  }): Promise<void>
  executePixelInstructions(instructions: MetaPixelInstruction[]): void
  trackPageView(): void
  trackViewContent(payload: Record<string, string | number | boolean>): void
  trackSearch(payload: Record<string, string | number | boolean>): void
}
```

---

### Task 1: 冻结活动事件契约并移除新 Lead 生成能力

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/constants/index.ts`
- Modify: `packages/shared/src/utils/conversion-events.ts`
- Modify: `packages/api/src/utils/conversions.ts`
- Modify: `packages/api/src/utils/conversions.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Rewrite: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/api/src/routes/conversions.test.ts`
- Modify: `scripts/meta-live-verification-lib.mjs`
- Modify: `scripts/meta-live-verification-lib.test.mjs`
- Modify: `scripts/record-meta-live-verification.mjs`
- Modify: `scripts/record-meta-live-verification.test.mjs`
- Modify: `scripts/verify-dev-rehearsal.mjs`
- Modify: `scripts/verify-dev-rehearsal.test.mjs`
- Modify: `scripts/release-verification-lib.mjs`
- Modify: `scripts/release-verification-lib.test.mjs`

**Interfaces:**
- Keeps historical storage type `ConversionActionType` for reading existing D1 rows.
- Adds `ActiveConversionActionType` and `ActiveMetaEventName` for all new writes and deliveries.
- Changes `PublicConversionActionType` from `contact | complete_registration` to `contact`.
- Removes `RecordConversionResult.derivedActions`.

- [ ] **Step 1: 写活动事件契约失败测试**

在 `packages/api/src/utils/conversions.test.ts` 增加编译期与运行时断言：

```ts
import { ACTIVE_CONVERSION_ACTIONS, ACTIVE_META_EVENTS } from '@meigallery/shared/constants'

it('活动 Meta 契约只包含联系和注册', () => {
  expect(ACTIVE_CONVERSION_ACTIONS).toEqual(['contact', 'complete_registration'])
  expect(ACTIVE_META_EVENTS).toEqual(['Contact', 'CompleteRegistration'])
  expect(metaEventForConversion('contact')).toBe('Contact')
  expect(metaEventForConversion('complete_registration')).toBe('CompleteRegistration')
  expect(metaEventForConversion('lead')).toBeNull()
  expect(metaEventForConversion('start_trial')).toBeNull()
  expect(metaEventForConversion('membership_grant')).toBeNull()
})

it('注册事件按服务端用户 ID 生成稳定去重键', () => {
  expect(buildConversionDedupeKey({
    actionType: 'complete_registration',
    userId: 42,
    sessionId: 'session_a',
    visitorId: 'visitor_a',
    occurredDate: '2026-07-10',
  })).toBe('complete_registration:user:42')
})
```

在 `packages/api/src/routes/conversions.test.ts` 新增断言：`contact` 返回成功，`complete_registration`、`lead`、`start_trial` 全部返回 `400 CONVERSION_ACTION_INVALID`。

将 script tests 的 live evidence 事件集合改为恰好 `Contact`、`CompleteRegistration`，并增加“出现 Lead 或 StartTrial 证据时失败”的断言。dev rehearsal 只创建 Contact 与服务端注册，不再通过公开 conversion API 创建注册。

重写 `packages/api/src/services/conversions.test.ts` 中所有 Lead 派生断言，新增：

```ts
it('首次有效联系只写入一条 contact 与两条派生 delivery', async () => {
  const result = await recordContact(env, grantedContactInput())
  expect(result.actionType).toBe('contact')
  expect(result).not.toHaveProperty('derivedActions')
  expect(db.insertedConversions.map(item => item.actionType)).toEqual(['contact'])
  expect(db.insertedDeliveries.map(item => item.eventName)).toEqual(['Contact', 'Contact'])
})
```

- [ ] **Step 2: 运行定向测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/conversions.test.ts src/services/conversions.test.ts src/routes/conversions.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: FAIL，当前常量仍含活动 Lead、公开 API 仍接受 `complete_registration`、服务仍返回 `derivedActions`。

- [ ] **Step 3: 分离历史存储类型与活动写入类型**

在 `packages/shared/src/constants/index.ts` 保留历史读取常量并新增活动常量：

```ts
export const HISTORICAL_CONVERSION_ACTIONS = [
  'contact',
  'lead',
  'complete_registration',
  'start_trial',
  'membership_grant',
] as const

export const ACTIVE_CONVERSION_ACTIONS = ['contact', 'complete_registration'] as const
export const ACTIVE_META_EVENTS = ['Contact', 'CompleteRegistration'] as const
```

删除 `META_EVENT_BY_CONVERSION.lead = 'Lead'` 的活动映射；`metaEventForConversion()` 对历史事件返回 `null`。`ConversionDedupeInput` 增加 `userId?: number`，`buildConversionDedupeKey()` 对活动注册要求正整数 user ID 并返回 `complete_registration:user:<userId>`；删除 `lead` 的新写入分支，但保留对历史 union 的确定性 fallback，避免后台读取旧行时报错。

- [ ] **Step 4: 将 conversion service 改为两个命名业务入口**

在 `packages/api/src/services/conversions.ts`：

1. 将 `recordConversionAction()` 改为模块私有 `recordActiveConversion()`。
2. 新增导出的 `recordContact()` 与 `recordRegistration()`，在入口处构造固定 `actionType`。
3. 删除 `leadAction`、`derivedActions`、Lead 查询、Lead daily 聚合和 Lead delivery 规划。
4. 将 `RecordConversionInput.actionType` 收窄为 `ActiveConversionActionType`。
5. 保留现有 dedupe、并发 `INSERT OR IGNORE`、Pixel receipt 与 delivery 状态逻辑。

`RecordConversionResult` 精确变为：

```ts
export interface RecordConversionResult {
  id: string
  actionType: ActiveConversionActionType
  created: boolean
  duplicateOf: string
  pixelEvents: MetaPixelInstruction[]
}
```

- [ ] **Step 5: 收窄公开 API 为 Contact**

`packages/api/src/routes/conversions.ts`：

- `PUBLIC_CONVERSION_ACTIONS` 改为 `new Set(['contact'])`。
- 路由只调用 `recordContact()`。
- `methodType` 与 `actionTarget` 为空时返回 `400 CONVERSION_CONTACT_CONTEXT_INVALID`，防止无口径联系。
- 继续由请求构建 `fbp/fbc/IP/User-Agent`，但仅作为派生投递上下文。

同步修改当前 live/release evidence library：活动事件集合只含两个事件；旧 evidence 中包含 Lead 时视为旧口径并拒绝复用。完整 schema v2、增强匹配和 Dataset Quality gate 在质量运营计划 Task 6 完成。

- [ ] **Step 6: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/conversions.test.ts src/services/conversions.test.ts src/routes/conversions.test.ts
node --test scripts/meta-live-verification-lib.test.mjs scripts/record-meta-live-verification.test.mjs scripts/verify-dev-rehearsal.test.mjs scripts/release-verification-lib.test.mjs
corepack pnpm --filter @meigallery/shared typecheck
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/shared/src/types/index.ts packages/shared/src/constants/index.ts packages/shared/src/utils/conversion-events.ts packages/api/src/utils/conversions.ts packages/api/src/utils/conversions.test.ts packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/routes/conversions.ts packages/api/src/routes/conversions.test.ts scripts/meta-live-verification-lib.mjs scripts/meta-live-verification-lib.test.mjs scripts/record-meta-live-verification.mjs scripts/record-meta-live-verification.test.mjs scripts/verify-dev-rehearsal.mjs scripts/verify-dev-rehearsal.test.mjs scripts/release-verification-lib.mjs scripts/release-verification-lib.test.mjs
git commit -m "refactor: 收口 Meta 活动事件契约"
```

Expected: 定向测试与类型检查通过，提交中不存在新 Lead 写入路径。

---

### Task 2: 切断 Analytics 反向生成转化事实

**Files:**
- Modify: `packages/api/src/services/analytics-ingest.ts`
- Modify: `packages/api/src/services/analytics-ingest.test.ts`
- Create: `packages/api/src/architecture-boundaries.test.ts`
- Modify: `packages/api/vitest.config.ts`

**Interfaces:**
- `ingestAnalyticsEvents()` 只写 raw events、session summary 与 analytics aggregates。
- `recordAcceptedConversions()`、`conversionInputFromEvent()` 和对 `services/conversions` 的 import 被删除。

- [ ] **Step 1: 写依赖边界与行为失败测试**

在 `packages/api/src/architecture-boundaries.test.ts` 读取源码并断言：

```ts
it('Analytics 服务不能依赖转化事实服务', async () => {
  const source = await readFile(new URL('./services/analytics-ingest.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/from ['"].*services\/conversions['"]/)
  expect(source).not.toContain('recordConversionAction')
  expect(source).not.toContain('recordContact')
  expect(source).not.toContain('recordRegistration')
})
```

修改 `analytics-ingest.test.ts`：

- `contact_method_click` 仍更新 Analytics 联系统计，但不插入 `analytics_conversion_actions`。
- `register_success` 仍更新 Analytics 注册统计，但不插入 `analytics_conversion_actions`。
- 重复分析批次不会创建任何 Meta delivery。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/analytics-ingest.test.ts src/architecture-boundaries.test.ts
```

Expected: FAIL，当前 `analytics-ingest.ts` 导入并调用 `recordConversionAction()`。

- [ ] **Step 3: 删除反向生成逻辑**

从 `analytics-ingest.ts` 删除：

- `recordConversionAction`、`RecordConversionInput` import。
- `recordAcceptedConversions()`。
- `conversionInputFromEvent()`。
- 批量接收完成后的 conversion side effect。

保留 `contact_method_click`、`register_success`、`membership_granted_conversion` 的第一方分析聚合，因为它们是分析消费者，不是转化事实生产者。

- [ ] **Step 4: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/analytics-ingest.test.ts src/architecture-boundaries.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/src/services/analytics-ingest.ts packages/api/src/services/analytics-ingest.test.ts packages/api/src/architecture-boundaries.test.ts packages/api/vitest.config.ts
git commit -m "refactor: 切断分析事件反向生成转化"
```

---

### Task 3: 将 CompleteRegistration 收归注册 API

**Files:**
- Modify: `packages/api/src/routes/auth.ts`
- Modify: `packages/api/src/routes/auth-security.test.ts`
- Create: `packages/api/src/routes/auth-registration-conversion.test.ts`
- Create: `packages/api/src/services/registration-conversion-recovery.ts`
- Create: `packages/api/src/services/registration-conversion-recovery.test.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/index.test.ts`
- Modify: `packages/web/app/pages/register.vue`
- Modify: `packages/web/app/pages/register.test.ts`
- Create: `packages/web/app/composables/useTracking.ts`
- Create: `packages/web/app/composables/useTracking.test.ts`

**Interfaces:**
- 注册请求携带脱敏归因上下文与授权状态，但不能决定 `actionType`。
- 注册响应增加 `pixelEvents: MetaPixelInstruction[]`。
- 修复任务只补第一方 `CompleteRegistration` 事实，不创建 Pixel/CAPI delivery。

- [ ] **Step 1: 写服务端权威注册失败测试**

`auth-registration-conversion.test.ts` 覆盖：

1. 用户插入成功后只调用一次 `recordRegistration()`。
2. 请求伪造 `actionType: 'lead'` 不影响固定事件类型。
3. 同一用户重试通过 `registration:user:<userId>` 去重。
4. 转化写入失败仍返回 `201`，同时写结构化错误日志，不删除用户与 session。
5. 注册响应只返回 Pixel 指令，不返回 CAPI payload、邮箱 hash 或内部 external ID。
6. 无营销授权时创建第一方注册事实，但 `pixelEvents` 为空。

`packages/web/app/pages/register.test.ts` 改为断言：页面不再调用 `trackConversion('complete_registration')`，而是执行注册响应中的 Pixel 指令。`useTracking.test.ts` 先锁定 `executePixelInstructions()` 会执行活动事件并上报 attempted receipt，拒绝 `Lead` 指令。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/auth-security.test.ts src/routes/auth-registration-conversion.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/pages/register.test.ts
```

Expected: FAIL，注册 API 当前不创建转化，Web 仍自行上报 `complete_registration`。

- [ ] **Step 3: 定义并校验注册归因上下文**

在注册 body 中加入：

```ts
type RegistrationAttributionContext = {
  visitorId?: string
  sessionId?: string
  occurredAt?: string
  routeName?: string
  path?: string
  sourceChannel?: string
  sourceName?: string
  trackingSourceSlug?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  consentState?: AnalyticsConsentState
  browserIdentifiers?: unknown
}
```

所有 ID、路径、UTM 和 source 字段复用 conversion route 的长度与格式规则；缺失 visitor/session 时使用 `registration_user_<userId>` 作为服务端稳定 fallback，不接受客户端提供 `userId` 或 `actionType`。

- [ ] **Step 4: 在注册成功路径调用 recordRegistration**

用户、邀请码绑定和 session 创建成功后调用：

```ts
const registration = await recordRegistration(c.env, {
  userId,
  visitorId,
  sessionId,
  occurredAt,
  routeName,
  path,
  sourceChannel,
  sourceName,
  trackingSourceSlug,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
  consentState,
  metadata: { method: 'email' },
}, {
  getMetaCapiUserData: () => buildMetaCapiUserData(c.req.raw, attribution.browserIdentifiers),
})
```

`recordRegistration()` 必须把服务端 `userId` 传入共享 dedupe builder；客户端 visitor/session 只用于归因和 rollout，不参与注册事实去重。

调用包裹独立 `try/catch`。错误日志只允许 `userId`、error code，不输出 email、请求头或 browser identifiers。

- [ ] **Step 5: 增加第一方注册事实修复任务**

`registration-conversion-recovery.ts` 查询创建时间在 24 小时内、尚无 `complete_registration` action 的用户，每批最多 100 个。修复调用一个明确禁止 Meta delivery 的内部模式：

```ts
await recordRegistrationFactOnly(env.DB, {
  userId: user.id,
  occurredAt: user.created_at,
  visitorId: `registration_user_${user.id}`,
  sessionId: `registration_user_${user.id}`,
  sourceChannel: 'unknown',
  metadata: { method: 'email', recovery: true },
})
```

该函数只写 conversion action 与 daily aggregate，不调用 delivery planning。将任务接入现有 scheduled handler，每小时最多执行一次；测试时间窗、批量上限、幂等和“零 delivery”。

- [ ] **Step 6: 建立最小 Tracking Facade 并消费注册响应指令**

创建 `useTracking.ts` 的第一版，只公开 `executePixelInstructions()`：内部复用现有 `useFacebookPixel()`，校验 `Contact | CompleteRegistration` 指令，执行 Pixel 后调用 `/api/conversions/pixel-receipts` 并保留现有有界重试。删除 `trackRegistrationConversion()` 和 `useConversionTracking()` 的注册调用。注册请求统一携带 `useAnalytics().getContext()`、营销授权状态、`fbp/fbc`，注册成功后调用 `useTracking().executePixelInstructions(response.pixelEvents)`。Task 4 会把其内部 Pixel 依赖替换为 adapter，并扩展完整 Facade；本任务提交时不存在未定义接口。

- [ ] **Step 7: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/auth-security.test.ts src/routes/auth-registration-conversion.test.ts src/services/registration-conversion-recovery.test.ts src/index.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/pages/register.test.ts app/composables/useTracking.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt typecheck
git diff --check
git add packages/api/src/routes/auth.ts packages/api/src/routes/auth-security.test.ts packages/api/src/routes/auth-registration-conversion.test.ts packages/api/src/services/registration-conversion-recovery.ts packages/api/src/services/registration-conversion-recovery.test.ts packages/api/src/index.ts packages/api/src/index.test.ts packages/web/app/pages/register.vue packages/web/app/pages/register.test.ts packages/web/app/composables/useTracking.ts packages/web/app/composables/useTracking.test.ts
git commit -m "refactor: 由注册 API 统一创建注册转化"
```

---

### Task 4: 建立 Web Tracking Facade 并修正联系成功口径

**Files:**
- Create: `packages/web/app/adapters/metaPixel.client.ts`
- Create: `packages/web/app/adapters/metaPixel.client.test.ts`
- Modify: `packages/web/app/composables/useTracking.ts`
- Modify: `packages/web/app/composables/useTracking.test.ts`
- Modify: `packages/web/app/composables/useConversionTracking.ts`
- Rewrite: `packages/web/app/composables/useConversionTracking.test.ts`
- Modify: `packages/web/app/components/ContactMethodItem.vue`
- Modify: `packages/web/app/components/ContactMethodItem.test.ts`
- Modify: `packages/web/app/components/ContactPanel.vue`
- Modify: `packages/web/app/components/ContactPanel.test.ts`
- Modify: `packages/web/app/plugins/facebook-pixel.client.ts`
- Modify: `packages/web/app/plugins/facebook-pixel.client.test.ts`
- Modify: `packages/web/app/pages/search.vue`
- Modify: `packages/web/app/pages/gallery/[slug].vue`
- Modify: `packages/web/app/pages/login.vue`
- Modify: `packages/web/app/pages/discover.vue`

**Interfaces:**
- `metaPixel.client.ts` 是唯一可访问 `window.fbq` 的文件。
- `useTracking()` 是页面、组件和 plugin 的唯一营销追踪入口。
- `useConversionTracking()` 只保留兼容包装 `trackContact()`，完成迁移后在 Task 5 删除。

- [ ] **Step 1: 写 Facade 与联系成功失败测试**

`ContactMethodItem.test.ts` 精确覆盖：

```ts
it('激活通过安全校验的原生聊天链接后发出 open_link', async () => {
  const link = wrapper.get('a[data-contact-action]')
  expect(link.attributes('href')).toBe('https://t.me/example')
  expect(link.attributes('target')).toBe('_blank')
  expect(link.attributes('rel')).toContain('noopener')
  await link.trigger('click')
  expect(wrapper.emitted('activate')).toEqual([['telegram', 'open_link']])
})

it('URL 未通过安全校验时不渲染聊天链接且不发出 open_link', () => {
  expect(wrapper.find('a[data-contact-action]').exists()).toBe(false)
  expect(wrapper.emitted('activate')).toBeUndefined()
})
```

另测 clipboard reject 不触发 `activate`；clipboard resolve 触发一次 `copy`；二维码按钮只触发 `qr_expand` 分析回调，不触发 Contact API。这里不把第三方页面加载或消息送达作为成功口径，因为浏览器无法可靠观察这两个状态。

`useTracking.test.ts` 覆盖：

- `trackContact()` 只调用一次 `/api/conversions/events` 且 action 固定为 `contact`。
- 同一 API 返回的 `Contact` Pixel instruction 使用相同 `eventID`。
- 授权不是 `granted` 时仍写第一方 Contact，且不执行 Pixel。
- Pixel attempted 回执失败走有界重试，不重复创建 Contact。
- `trackPageView/ViewContent/Search` 只委托 adapter。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- app/components/ContactMethodItem.test.ts app/components/ContactPanel.test.ts app/composables/useTracking.test.ts app/plugins/facebook-pixel.client.test.ts
```

Expected: FAIL，当前组件使用脚本式 `window.open`，完整 Facade 与 adapter 尚不存在。

- [ ] **Step 3: 提取 Meta Pixel adapter**

将 `packages/web/app/utils/facebookPixel.ts` 中所有 `fbq` 调用迁入 `app/adapters/metaPixel.client.ts`。adapter 公开：

```ts
export interface MetaPixelAdapter {
  initialize(pixelId: string): boolean
  pageView(): boolean
  standardEvent(
    eventName: 'ViewContent' | 'Search' | 'Contact' | 'CompleteRegistration',
    payload?: Record<string, string | number | boolean>,
    options?: { eventID?: string },
  ): boolean
}
```

`facebook-pixel.client.ts` plugin 只负责根据公开配置和授权调用 `useTracking().trackPageView()`，不直接调用 adapter。SSR 中 adapter 始终返回 `false`。

- [ ] **Step 4: 实现 useTracking Facade**

把 `useConversionTracking.ts` 中以下能力迁到 `useTracking.ts`：

- 构造脱敏归因上下文。
- 读取授权范围内 `fbp/fbc/fbclid`。
- 调用 Contact API。
- 执行服务端 Pixel instructions。
- 上报 attempted receipt 及有界重试。
- 写 `contact_method_click` 第一方兼容分析事件。

`executePixelInstructions()` 只接受 `Contact | CompleteRegistration`，拒绝 `Lead`。`useConversionTracking()` 暂时变为：

```ts
export function useConversionTracking() {
  const tracking = useTracking()
  return { trackConversion: tracking.trackContact }
}
```

- [ ] **Step 5: 修正 ContactMethodItem 与二维码行为**

有安全 URL 时把主动作渲染为原生 `<a>`，固定 `target="_blank"`、`rel="noopener noreferrer nofollow"`、`referrerpolicy="no-referrer"`，在未阻止默认行为的 click handler 中 emit `open_link`，定义为“浏览器已发起安全导航”。无 URL 时渲染复制按钮，只在 Clipboard API 或 fallback copy 明确成功后 emit `copy`。二维码按钮 emit 新事件 `inspect(methodType, 'qr_expand')`，`ContactPanel` 将其传给 `trackAnalytics('contact_qr_expand', ...)`，禁止调用 `trackContact()`。

- [ ] **Step 6: 迁移所有直接 Pixel 调用方**

将以下文件改为只使用 `useTracking()`：

- `pages/search.vue`
- `pages/gallery/[slug].vue`
- `pages/login.vue`
- `pages/discover.vue`
- `plugins/facebook-pixel.client.ts`
- `components/ContactPanel.vue`
- `pages/register.vue`

用 `rg -n "useFacebookPixel|window\\.fbq|trackStandardEvent" packages/web/app` 验证只有 adapter、adapter 测试和待删除兼容模块命中。

- [ ] **Step 7: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/web test:unit -- app/adapters/metaPixel.client.test.ts app/composables/useTracking.test.ts app/components/ContactMethodItem.test.ts app/components/ContactPanel.test.ts app/pages/register.test.ts app/plugins/facebook-pixel.client.test.ts
corepack pnpm --filter @meigallery/web exec nuxt typecheck
git diff --check
git add packages/web/app/adapters packages/web/app/composables/useTracking.ts packages/web/app/composables/useTracking.test.ts packages/web/app/composables/useConversionTracking.ts packages/web/app/composables/useConversionTracking.test.ts packages/web/app/components/ContactMethodItem.vue packages/web/app/components/ContactMethodItem.test.ts packages/web/app/components/ContactPanel.vue packages/web/app/components/ContactPanel.test.ts packages/web/app/plugins/facebook-pixel.client.ts packages/web/app/plugins/facebook-pixel.client.test.ts packages/web/app/pages/search.vue packages/web/app/pages/gallery/[slug].vue packages/web/app/pages/login.vue packages/web/app/pages/discover.vue packages/web/app/pages/register.vue packages/web/app/pages/register.test.ts
git commit -m "refactor: 建立统一 Tracking Facade"
```

---

### Task 5: 清理旧入口并加入架构约束

**Files:**
- Delete: `packages/web/app/composables/useConversionTracking.ts`
- Delete: `packages/web/app/composables/useConversionTracking.test.ts`
- Delete: `packages/web/app/utils/facebookPixel.ts`
- Delete: `packages/web/app/utils/facebookPixel.test.ts`
- Modify: `eslint.config.mjs`
- Create: `packages/web/app/architecture-boundaries.test.ts`
- Modify: `packages/web/vitest.config.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/web/app/pages/admin/attribution/index.vue`
- Modify: `packages/web/app/pages/admin/attribution/conversions.vue`
- Modify: `packages/web/app/pages/admin/attribution/conversions.test.ts`
- Modify: `packages/web/app/pages/admin/attribution/links.vue`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- 禁止页面、组件、layout、plugin 导入 `~/adapters/metaPixel.client`。
- 禁止任何文件再导入 `useConversionTracking` 或 `useFacebookPixel`。
- adapter 只能由 `useTracking.ts` 导入。

- [ ] **Step 1: 写源码边界失败测试**

`packages/web/app/architecture-boundaries.test.ts` 遍历 `app/pages`、`app/components`、`app/layouts`、`app/plugins`，断言不含：

```ts
const forbidden = [
  /useFacebookPixel\s*\(/,
  /useConversionTracking\s*\(/,
  /from ['"]~\/adapters\/metaPixel\.client['"]/,
  /window\.fbq/,
]
```

另断言整个 `app` 中 `metaPixel.client` 只有 `useTracking.ts` 和测试文件导入。

- [ ] **Step 2: 配置 ESLint import 限制**

在 `eslint.config.mjs` 针对 `packages/web/app/{pages,components,layouts,plugins}/**/*.{ts,vue}` 配置 `no-restricted-imports`，patterns 禁止：

```js
[
  '~/adapters/metaPixel.client',
  '~/composables/useConversionTracking',
  '~/composables/useFacebookPixel',
]
```

测试先确认 lint 对 fixture 中直接 adapter import 报错，再修正所有命中。

- [ ] **Step 3: 删除兼容层和旧 Pixel utility**

确认 Task 4 已完成全部调用迁移后删除四个文件。运行：

```bash
rg -n "useConversionTracking|useFacebookPixel|utils/facebookPixel|window\\.fbq|Lead" packages/web/app packages/api/src/services packages/api/src/routes packages/shared/src
```

Expected: `window.fbq` 仅 adapter 内出现；`Lead` 仅历史读取标签或 migration/test fixture 中出现；不存在新事件生产代码。

- [ ] **Step 4: 更新技术与状态文档**

先把现有归因页中的 Lead 从活动漏斗移出：API 活动总计和比率只使用 Contact、CompleteRegistration，历史行通过 `historical.leadCount` 单独返回；页面标签统一为“历史 Lead”，不参与联系率、注册率、推广链接活动效果排序。完整五区趋势重构留在质量运营计划 Task 4。

`docs/TECHNICAL_SPEC.md` 增加“归因事实所有权”表，写明 Contact、CompleteRegistration、QR 展开所有者和派生关系。`docs/PROJECT_STATUS.md` 把 Meta CAPI v2 标记为“阶段 1 完成，尚不可生产放量”，并链接本计划与后续两份计划。

- [ ] **Step 5: 运行阶段完整验证**

Run:

```bash
corepack pnpm lint
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
corepack pnpm verify:quick
git diff --check
```

Expected: 全部通过。任何 `Lead` live evidence、公开注册 conversion API 或 Analytics 反向写 conversion 的测试必须已删除或改为拒绝断言。

- [ ] **Step 6: 提交阶段结果**

Run:

```bash
git add -A
git commit -m "refactor: 完成 Meta 业务事实单一收口"
```

---

## Phase Exit Gate

本计划完成必须同时满足：

- 新写入 `analytics_conversion_actions` 只有命名入口 `recordContact()`、`recordRegistration()` 和注册事实修复函数。
- `analytics-ingest` 不依赖 conversion service。
- `POST /api/conversions/events` 拒绝 `complete_registration`、`lead`、`start_trial`。
- Contact 不派生 Lead；证据 schema 只要求 Contact 与 CompleteRegistration。
- 浏览器无法自行声明注册成功，只能执行注册 API 返回的 Pixel 指令。
- 未通过 URL 安全校验时不记录 Contact；原生安全链接激活按“跳转已发起”记录；复制失败和二维码展开不记录 Contact。
- 页面和组件只通过 `useTracking()` 追踪。
- API test、Web test、script test、lint、API tsc、Web build、quick verification 全部通过。

本门禁通过后才能执行 `2026-07-10-meta-capi-v2-secure-delivery.md`。
