# Meta CAPI v2 质量运营与发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为统一后的 Meta Pixel/CAPI 增加稳定灰度、自动熔断、质量趋势、Dataset Quality 采集契约和严格生产发布证据，使 Owner 能按日期判断站内事实、投递成功、匹配质量与广告平台反馈。

**Architecture:** Owner 配置目标 rollout，系统按稳定标识一致性分桶；Circuit Breaker 根据连接、权限、解密和 15 分钟 delivery 指标自动把有效 rollout 降为 0。后台以第一方事实、delivery、质量快照和 incident 四类数据分别展示。Dataset Quality Collector 独立于发送链路，只有在 dev Dataset 获得当前 Meta 官方接口的真实响应并批准字段白名单后才能实现。

**Tech Stack:** Hono、TypeScript、Cloudflare D1、Queues、Cron Triggers、Nuxt 4、Nuxt UI v4、Vue 3、Vitest、Playwright、Node.js test runner、Wrangler、Meta Graph API v25.0。

**Source of truth:** `docs/superpowers/specs/2026-07-10-meta-capi-v2-architecture-design.md`

**Depends on:** `docs/superpowers/plans/2026-07-10-meta-capi-v2-secure-delivery.md` 的 Phase Exit Gate 已通过。

## Global Constraints

- `meta_capi_rollout_percentage` 只允许 `0 | 10 | 50 | 100`。
- Owner 只能手动升级目标 rollout；系统永不自动升级，只能因 incident 把有效 rollout 降为 0。
- Rollout 不影响第一方事实与 Pixel；未命中 CAPI 灰度仍创建 `skipped/rollout_excluded` delivery。
- Circuit Breaker 打开时保留 Owner 目标值，并把有效值设为 0；新 CAPI delivery 记录 `skipped/circuit_open`。
- Dataset Quality API 不参与实时投递或熔断；失败只产生 warning。
- 站内 Contact/Registration、Pixel attempted、CAPI sent、Meta 质量指标必须分开显示，禁止合并成“转化成功”。
- 所有日期查询使用项目统一的 Asia/Shanghai 业务日边界和 UTC 存储规则。
- 所有 rollout 变更、incident 关闭、Test Event 和强制升级都写管理员审计日志。
- production 首次部署保持 target/effective rollout 为 0，真实 Test Event 通过后才能手动升至 10。
- Dataset Quality 的 endpoint、参数、权限和字段不得根据搜索摘要或旧文档猜测。

---

## Fixed Circuit Rules

立即打开 incident：

- `connection_fingerprint_changed`
- `meta_permission_denied`（HTTP 401/403 或已确认的数据集权限错误）
- `secure_context_decryption_failed`
- `dataset_pixel_mismatch`

15 分钟窗口阈值：

- 样本不少于 10 且永久失败率 `>= 5%`。
- `retry_exhausted >= 3`。
- 至少 5 条 delivery pending 超过 10 分钟。
- 同一 `conversion_action_id + channel` 存在多条有效 delivery。

只 warning：

- 样本不少于 20 且 `duplicate_suppressed / delivery >= 10%`。
- Dataset Quality Collector 不可用或数据陈旧。

---

### Task 1: 增加 rollout、incident 与质量快照模型

**Files:**
- Create: `packages/api/migrations/0039_meta_capi_v2_operations.sql`
- Create: `packages/api/migrations/0039_meta_capi_v2_operations.test.mjs`
- Modify: `packages/api/src/utils/analytics-migrations.test.ts`
- Modify: `packages/shared/src/types/index.ts`

**Schema:**

```sql
ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN rollout_target_percentage INTEGER NOT NULL DEFAULT 0
  CHECK (rollout_target_percentage IN (0, 10, 50, 100));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN rollout_effective_percentage INTEGER NOT NULL DEFAULT 0
  CHECK (rollout_effective_percentage IN (0, 10, 50, 100));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN rollout_bucket INTEGER
  CHECK (rollout_bucket IS NULL OR (rollout_bucket >= 0 AND rollout_bucket <= 99));

CREATE UNIQUE INDEX idx_conversion_delivery_action_channel
  ON analytics_conversion_deliveries(conversion_action_id, channel);

CREATE TABLE meta_capi_incidents (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  trigger_summary TEXT NOT NULL DEFAULT '',
  target_rollout_percentage INTEGER NOT NULL,
  effective_rollout_percentage INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '{}',
  opened_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (status IN ('open', 'closed')),
  CHECK (severity IN ('warning', 'critical')),
  CHECK (target_rollout_percentage IN (0, 10, 50, 100)),
  CHECK (effective_rollout_percentage IN (0, 10, 50, 100))
);

CREATE UNIQUE INDEX idx_meta_capi_incident_open_trigger
  ON meta_capi_incidents(environment, trigger_code)
  WHERE status = 'open';

CREATE INDEX idx_meta_capi_incident_status_time
  ON meta_capi_incidents(environment, status, opened_at);

CREATE TABLE meta_dataset_quality_snapshots (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL,
  window_start TEXT,
  window_end TEXT,
  collection_status TEXT NOT NULL DEFAULT 'success',
  error_category TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (event_name IN ('Contact', 'CompleteRegistration')),
  CHECK (contract_version >= 1),
  CHECK (collection_status IN ('success', 'error')),
  CHECK (
    (collection_status = 'success' AND metric_value IS NOT NULL AND error_category = '')
    OR (collection_status = 'error' AND metric_value IS NULL AND error_category <> '')
  )
);

CREATE INDEX idx_meta_dataset_quality_metric_time
  ON meta_dataset_quality_snapshots(environment, event_name, metric_key, collected_at);

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES ('meta_capi_rollout_percentage', '0', datetime('now'));
```

- [ ] **Step 1: 写 migration 失败测试**

测试顺序执行 0001-0039 并断言：

- rollout 默认 0，只接受四个离散值。
- bucket 只接受 0-99 或 null。
- 同一 action/channel 第二条 delivery 被唯一索引拒绝。
- 同环境同 trigger 只能有一条 open incident，关闭后可再次打开。
- incident evidence 必须是脱敏 JSON；应用层校验测试拒绝 token、email、IP、User-Agent 键。
- quality snapshot 只接受两个活动事件；成功行必须有数值 metric，错误行只保存脱敏 error category 且 metric value 为 null。
- site setting 默认 JSON number `0`，不是字符串 `"0"`。
- 所有历史 action 与 delivery 行保留。

在 migration runner 执行 0039 前增加只读 preflight：若存在 `(conversion_action_id, channel)` 重复组，立即阻断并输出组数，不自动删除历史数据。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test packages/api/migrations/0039_meta_capi_v2_operations.test.mjs scripts/verify-meta-migration.test.mjs
corepack pnpm --filter @meigallery/api test -- src/utils/analytics-migrations.test.ts
```

Expected: FAIL，0039 与重复组 preflight 尚不存在。

- [ ] **Step 3: 创建 migration 与共享运维类型**

新增：

```ts
export type MetaCapiRolloutPercentage = 0 | 10 | 50 | 100
export type MetaCapiIncidentStatus = 'open' | 'closed'
export type MetaCapiIncidentSeverity = 'warning' | 'critical'

export interface MetaCapiRolloutDecision {
  targetPercentage: MetaCapiRolloutPercentage
  effectivePercentage: MetaCapiRolloutPercentage
  bucket: number | null
  included: boolean
  reason: 'included' | 'rollout_excluded' | 'circuit_open' | 'missing_stable_id'
}
```

- [ ] **Step 4: 运行测试并提交**

Run:

```bash
node --test packages/api/migrations/0039_meta_capi_v2_operations.test.mjs scripts/verify-meta-migration.test.mjs
corepack pnpm --filter @meigallery/api test -- src/utils/analytics-migrations.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/migrations/0039_meta_capi_v2_operations.sql packages/api/migrations/0039_meta_capi_v2_operations.test.mjs packages/api/src/utils/analytics-migrations.test.ts packages/shared/src/types/index.ts scripts/verify-meta-migration.mjs scripts/verify-meta-migration.test.mjs
git commit -m "feat: 建立 CAPI 灰度与质量数据模型"
```

---

### Task 2: 实现稳定 rollout 决策与 Owner 控制

**Files:**
- Create: `packages/api/src/services/meta-capi-rollout.ts`
- Create: `packages/api/src/services/meta-capi-rollout.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/api/src/utils/site-settings.ts`
- Modify: `packages/api/src/utils/site-settings.test.ts`

**Interfaces:**

```ts
export function normalizeMetaCapiRollout(value: unknown): MetaCapiRolloutPercentage

export function rolloutBucket(stableId: string): Promise<number>

export function decideMetaCapiRollout(input: {
  targetPercentage: MetaCapiRolloutPercentage
  stableId: string
  circuitOpen: boolean
}): Promise<MetaCapiRolloutDecision>

export function evaluateRolloutPromotion(input: {
  from: MetaCapiRolloutPercentage
  to: MetaCapiRolloutPercentage
  sent: number
  failed: number
  permissionErrors: number
  retryExhausted: number
  stalePending: number
  criticalQualityDiagnostics: number
}): { allowed: boolean; requiresOverrideReason: boolean; blockers: string[] }
```

- [ ] **Step 1: 写 rollout 失败测试**

覆盖：

- 非法配置保守归一化为 0。
- SHA-256(`meta-capi-rollout-v1\n${stableId}`) 前 4 bytes 按 unsigned big-endian `% 100`，同 stable ID 始终同 bucket。
- 0 全排除，100 全包含；10/50 以 `bucket < percentage` 判断。
- Contact 使用 visitor ID；注册缺 visitor ID 时使用用户 `meta_external_id`；两者都缺失时排除并记录 `missing_stable_id`。
- open incident 时 effective=0 且 reason=`circuit_open`。
- rollout excluded/circuit open 创建 skipped delivery，但不创建 secure outbox。
- 10 -> 50 至少 10 次、成功率 >=98%、无权限错误/DLQ/stale pending。
- 50 -> 100 至少 50 次、成功率 >=99%、无关键质量诊断。
- 0 -> 10 要求 verified connection 和当前 commit dev live evidence，在 route 集成测试中验证。
- 降级始终允许；升级只允许 Owner；强制升级必须至少 20 个中文字符理由并写审计。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-rollout.test.ts src/services/conversions.test.ts src/routes/admin/attribution.test.ts src/utils/site-settings.test.ts
```

Expected: FAIL，当前没有 rollout decision 与控制 API。

- [ ] **Step 3: 实现纯 rollout service**

仅使用 Web Crypto SHA-256，不依赖平台随机数。将稳定 ID 先 trim；空字符串直接返回 `missing_stable_id`，不 hash。`evaluateRolloutPromotion()` 使用整数计数计算比率，避免格式化后的百分比参与决策。

- [ ] **Step 4: 接入 conversion planning**

只在授权、连接 verified、CAPI enabled 后执行 rollout decision。无论 included 与否均创建一条 CAPI delivery，并快照 target/effective/bucket：

- included: `pending` + secure outbox。
- excluded: `skipped/rollout_excluded`，无 outbox。
- circuit open: `skipped/circuit_open`，无 outbox。
- missing ID: `skipped/missing_stable_id`，无 outbox。

Pixel delivery 不写 rollout bucket，target/effective 保持 0。

- [ ] **Step 5: 实现 Owner rollout route**

新增：

```text
GET  /api/admin/attribution/meta/rollout
POST /api/admin/attribution/meta/rollout
```

POST body：

```ts
{
  percentage: 0 | 10 | 50 | 100
  force: boolean
  reason?: string
}
```

route 返回 target、effective、promotion checks、open incident。任何变更写 `attribution.meta_rollout_update` 审计，before/after 不含 secret。

- [ ] **Step 6: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-rollout.test.ts src/services/conversions.test.ts src/routes/admin/attribution.test.ts src/utils/site-settings.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/src/services/meta-capi-rollout.ts packages/api/src/services/meta-capi-rollout.test.ts packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts packages/api/src/utils/site-settings.ts packages/api/src/utils/site-settings.test.ts
git commit -m "feat: 增加 CAPI 稳定灰度控制"
```

---

### Task 3: 实现自动 Circuit Breaker 与 Incident 生命周期

**Files:**
- Create: `packages/api/src/services/meta-capi-circuit-breaker.ts`
- Create: `packages/api/src/services/meta-capi-circuit-breaker.test.ts`
- Modify: `packages/api/src/services/meta-connection.ts`
- Modify: `packages/api/src/services/meta-capi.ts`
- Modify: `packages/api/src/services/meta-capi-queue.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/index.test.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`

**Interfaces:**

```ts
export interface MetaCircuitSnapshot {
  totalAttempts: number
  permanentFailures: number
  retryExhausted: number
  stalePending: number
  duplicateSuppressed: number
  duplicateDeliveryGroups: number
}

export function evaluateMetaCircuit(snapshot: MetaCircuitSnapshot): {
  criticalTriggers: MetaIncidentTrigger[]
  warnings: MetaIncidentTrigger[]
}

export function openMetaCapiIncident(
  env: CircuitEnv,
  trigger: MetaIncidentTrigger,
): Promise<{ id: string; created: boolean }>

export function closeMetaCapiIncident(
  env: CircuitEnv,
  input: { incidentId: string; ownerUserId: number; resolution: string },
): Promise<void>
```

- [ ] **Step 1: 写阈值边界失败测试**

每个阈值都测试边界前后：

- `9/9 failed` 不以比例打开，因为样本不足 10；`10 total + 1 permanent` 打开。
- `2 retry_exhausted` 不开；`3` 打开。
- `4 stale pending` 不开；`5` 打开。
- duplicate delivery groups `1` 立即打开。
- `19 total + 19 duplicate_suppressed` 不 warning；`20 total + 2 duplicate_suppressed` warning。
- 同 trigger 重复观察只更新 `last_observed_at`，不创建重复 open incident。
- connection fingerprint、401/403、解密失败、dataset mismatch 立即打开。
- 打开 incident 后读取有效 rollout 为 0。

- [ ] **Step 2: 写关闭门禁失败测试**

Owner 关闭 incident 必须同时满足：

- resolution 至少 20 个字符。
- MetaConnection 当前 verified。
- incident 打开之后存在成功 Test Event verification。
- 当前 15 分钟窗口不再命中 critical trigger。
- data key、Queue/DLQ、migration readiness 正常。

任一条件不满足返回 409，incident 保持 open。非 Owner 返回 403。成功关闭写 `attribution.meta_incident_close` 审计。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-circuit-breaker.test.ts src/services/meta-connection.test.ts src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/routes/admin/attribution.test.ts src/index.test.ts
```

Expected: FAIL，Circuit Breaker service 尚不存在。

- [ ] **Step 4: 实现阈值查询与定时评估**

查询固定使用 `datetime('now', '-15 minutes')`，stale pending 额外要求 `created_at < datetime('now', '-10 minutes')`。scheduled handler 每分钟评估一次，使用 D1 open incident 唯一索引实现并发幂等。

`evidence` 只保存计数、比率、error category 和时间窗，不保存 delivery payload、外部标识或 Meta 原始响应。

- [ ] **Step 5: 接入立即触发点**

- `requireVerifiedMetaConnection()` 检测 fingerprint 变化时 open `connection_fingerprint_changed`。
- CAPI 401/403 或经过 contract test 确认的权限错误 open `meta_permission_denied`。
- AES-GCM 解密失败 open `secure_context_decryption_failed`。
- 已验证 connection 的 dataset/pixel 不一致 open `dataset_pixel_mismatch`。

`dataset_pixel_mismatch` 只能使用已批准 Dataset Quality contract 明确定义的 dataset identity 与当前 MetaConnection 比较；contract/collector 未完成时不推断 mismatch，而是保持 quality warning 和 production readiness blocked。

这些调用使用 `ctx.waitUntil()` 或在 Queue consumer 当前任务内 await，incident 写入失败不能吞掉原始 delivery failure。

- [ ] **Step 6: 实现 incident API**

新增：

```text
GET  /api/admin/attribution/meta/incidents
POST /api/admin/attribution/meta/incidents/:id/close
```

支持 `from/to/status` 过滤，默认最近 30 天，使用统一日期解析器。

- [ ] **Step 7: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-circuit-breaker.test.ts src/services/meta-connection.test.ts src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/routes/admin/attribution.test.ts src/index.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/src/services/meta-capi-circuit-breaker.ts packages/api/src/services/meta-capi-circuit-breaker.test.ts packages/api/src/services/meta-connection.ts packages/api/src/services/meta-capi.ts packages/api/src/services/meta-capi-queue.ts packages/api/src/index.ts packages/api/src/index.test.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts
git commit -m "feat: 增加 CAPI 自动熔断与事件处置"
```

---

### Task 4: 重整后台归因数据与趋势看板

**Files:**
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/web/app/composables/useAdminAttribution.ts`
- Modify: `packages/web/app/pages/admin/attribution/index.vue`
- Modify: `packages/web/app/pages/admin/attribution/conversions.vue`
- Modify: `packages/web/app/pages/admin/attribution/meta.vue`
- Modify: `packages/web/app/pages/admin/attribution/readiness.vue`
- Modify: `packages/web/app/pages/admin/attribution/links.vue`
- Delete: `packages/web/app/pages/admin/attribution/duplicates.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionTrendPanel.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionTrendPanel.test.ts`
- Create: `packages/web/app/components/admin/attribution/MetaConnectionStatus.vue`
- Create: `packages/web/app/components/admin/attribution/MetaRolloutControl.vue`
- Create: `packages/web/app/components/admin/attribution/MetaIncidentList.vue`
- Create: `packages/web/app/pages/admin/attribution/index.test.ts`
- Create: `packages/web/app/pages/admin/attribution/meta.test.ts`
- Modify: `packages/web/app/layouts/admin.vue`

**Dashboard structure:**

1. 连接状态。
2. 业务转化趋势。
3. 投递趋势。
4. 质量趋势。
5. 发布控制。

- [ ] **Step 1: 写 API 口径失败测试**

为一个指定单日 `from=2026-07-10&to=2026-07-10` 构造 fixture，断言：

- business trend 只统计第一方 `contact`、`complete_registration` action。
- 历史 Lead 可在“历史数据”字段显示，但不计入活动转化、漏斗或成功率。
- delivery trend 分开 `pixel_attempted/capi_sent/failed/skipped/pending/retry_exhausted`。
- `capi_sent` 只表示 API 接收，不命名为 Meta 归因成功。
- match trend 分开 `fbp/fbc/email/external_id` coverage，并返回 numerator/denominator。
- UTM campaign/content、推广链接维度使用 conversion fact 作为基数，再 join delivery，不因双通道把业务数翻倍。
- 每个 endpoint 都尊重 from/to 和单日范围。

- [ ] **Step 2: 写 UI 失败测试**

测试：

- 页面首次加载带默认 7 日范围，选择单日后所有 panel 共用同一 query。
- 五个区域按固定顺序出现。
- 图例明确“站内事实 / Pixel 尝试 / CAPI 接收 / Meta 质量”。
- rollout 使用 0/10/50/100 segmented control；incident 打开时控件显示 target 与 effective=0。
- 强制升级要求填写原因 modal；关闭 incident 要求 resolution modal。
- 没有 quality snapshot 时显示“尚未取得 Meta 质量数据”，不显示 0 分。
- 360px、768px、1440px 下表格与图例不溢出，控件和文字不重叠。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/admin/attribution.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/components/admin/attribution/AttributionTrendPanel.test.ts app/pages/admin/attribution/index.test.ts app/pages/admin/attribution/meta.test.ts
```

Expected: FAIL，当前页面仍以 Lead 为活动漏斗层级，运维数据分散且缺少统一趋势。

- [ ] **Step 4: 重构 admin API 响应**

保留现有 `/api/admin/attribution` namespace，固定新增/整理：

```text
GET /summary?from&to
GET /trends?from&to&granularity=day
GET /quality?from&to
GET /breakdown?from&to&dimension=utm_campaign|utm_content|tracking_link
GET /meta/status?from&to
GET /readiness?from&to
```

所有接口返回 `range`、`usage`、`data`；趋势按缺失日期补零。移除运行时 SQL 中 `action_type IN ('contact','lead','complete_registration')`，活动查询统一为两个事件。历史 Lead 只在单独 `historical` 对象返回。

- [ ] **Step 5: 重构 UI 为五个全宽区域**

复用现有 `AnalyticsTrendPanel` 的坐标与响应式逻辑，抽取适合归因多序列的 `AttributionTrendPanel`。不在 card 内嵌 card；页面使用全宽 band、紧凑表格和最多 8px radius。所有图表使用稳定高度和可横向滚动的图例区域。

删除独立 `duplicates.vue`，把 duplicate warning 和样本入口合并到质量区；链接效果仍留在 `links.vue`，但从总览直接按当前日期范围跳转。

- [ ] **Step 6: Playwright 视觉与交互验证**

Run:

```bash
corepack pnpm dev
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/admin-attribution.spec.ts --project=chromium
```

新增 `packages/web/tests/e2e/admin-attribution.spec.ts`，使用 mock API 验证 360x800、768x1024、1440x1000：

- 单日筛选发出一致查询。
- 趋势图非空且 SVG path 长度大于 0。
- rollout/incident 操作有确认与错误状态。
- 页面无水平 document overflow，无可见元素 overlap。

测试完成后停止本任务启动的 dev server；不得终止用户已有服务。

- [ ] **Step 7: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/admin/attribution.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/components/admin/attribution app/pages/admin/attribution
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
git diff --check
git add packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts packages/web/app/composables/useAdminAttribution.ts packages/web/app/pages/admin/attribution packages/web/app/components/admin/attribution packages/web/app/layouts/admin.vue packages/web/tests/e2e/admin-attribution.spec.ts
git commit -m "feat: 重整 Meta 归因质量看板"
```

---

### Task 5: 固化 Dataset Quality 官方契约硬门槛

**Files:**
- Create: `docs/superpowers/specs/2026-07-10-meta-dataset-quality-contract.md`
- Create: `scripts/record-meta-dataset-quality-contract.mjs`
- Create: `scripts/record-meta-dataset-quality-contract.test.mjs`
- Modify: `docs/PROJECT_STATUS.md`

**Why this is a blocking discovery task:** 当前仓库没有来自项目 dev Dataset 的官方 Dataset Quality API 响应，Meta 的个性化设置页面与账户权限会影响可用 endpoint、权限和字段。根据已批准架构，不能从第三方文章或搜索摘要推断生产契约。因此本任务只固化真实契约；collector 实现必须在契约批准后生成一份补充 implementation plan。

- [ ] **Step 1: 写脱敏契约记录器失败测试**

记录器必须交互读取一个本地临时 JSON 响应并输出 contract draft，测试断言：

- 输出不包含 access token、test event code、用户级数据或未知原始字段值。
- 只记录实际请求的 HTTP method、Graph version、endpoint path、query key 名、所需权限名、响应字段路径、类型、可空性、错误分类。
- dataset ID 只保留前 4/后 4 位用于证据展示；正式 collector 从 verified MetaConnection 获取完整 ID。
- 原始响应文件在 contract 生成后由脚本删除；删除失败使任务失败。
- contract 绑定 `RELEASE_COMMIT`、dev environment、capturedAt 和 Meta UI/官方文档 URL。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test scripts/record-meta-dataset-quality-contract.test.mjs
```

Expected: FAIL，记录器和 contract 文档尚不存在。

- [ ] **Step 3: 从 Meta 官方界面取得当前接口说明**

在 Events Manager 选中项目专用 dev Dataset，进入“设置 / 转化 API / Dataset Quality”相关官方入口；使用 Meta 官方 Graph API Explorer 或个性化接入说明取得：

- 精确 HTTP method。
- 精确 Graph API v25.0 path。
- dataset 标识来源。
- query 参数名。
- access token 所需权限。
- 成功响应和常见权限失败响应。

只使用 Meta 官方 UI、`developers.facebook.com` 或 Graph API 实际响应。浏览器截图可作为人工证据，但 token 必须遮挡，截图不提交仓库。

- [ ] **Step 4: 生成并审查契约文档**

`record-meta-dataset-quality-contract.mjs` 读取临时响应、让 Owner 逐项 allowlist 字段路径，然后生成文档。文档必须包含以下完成态章节，不允许空章节：

```text
1. 验证环境与 commit
2. 官方入口与权限
3. HTTP request contract
4. allowlisted response schema
5. error classification
6. freshness/window semantics
7. retention and privacy
8. redacted acceptance evidence
9. rejected unknown fields
```

由 Owner 明确确认 contract 后形成 commit：

```bash
node --test scripts/record-meta-dataset-quality-contract.test.mjs
git diff --check
git add docs/superpowers/specs/2026-07-10-meta-dataset-quality-contract.md scripts/record-meta-dataset-quality-contract.mjs scripts/record-meta-dataset-quality-contract.test.mjs docs/PROJECT_STATUS.md
git commit -m "docs: 固化 Meta Dataset Quality 官方契约"
```

- [ ] **Step 5: 生成并批准 collector 补充计划**

使用 writing-plans skill 基于已确认 contract 生成：

```text
docs/superpowers/plans/2026-07-10-meta-dataset-quality-collector.md
```

该计划必须写出准确 endpoint、query、response allowlist、collector 测试 fixture、Cron 频率、API/UI 映射和错误退避，所有字段必须来自实际官方响应。完成并执行该补充计划前：

- `meta_dataset_quality_snapshots` 可以存在但保持空。
- 后台显示 `contract_pending` 或 `collector_pending` warning。
- production readiness 必须为 blocked。
- CAPI test mode 可继续验证，production rollout 不得高于 0。

这不是可跳过项；它是防止未知 Meta 契约污染正式环境的发布门禁。

---

### Task 6: 更新 live evidence、release gate 与生产冷启动

**Files:**
- Modify: `scripts/meta-live-verification-lib.mjs`
- Modify: `scripts/meta-live-verification-lib.test.mjs`
- Modify: `scripts/record-meta-live-verification.mjs`
- Modify: `scripts/record-meta-live-verification.test.mjs`
- Modify: `scripts/verify-dev-rehearsal.mjs`
- Modify: `scripts/verify-dev-rehearsal.test.mjs`
- Modify: `scripts/release-verification-lib.mjs`
- Modify: `scripts/release-verification-lib.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/verify-meta-resources.mjs`
- Modify: `scripts/verify-meta-resources.test.mjs`
- Modify: `scripts/deploy.sh`
- Modify: `packages/api/src/services/meta-connection.ts`
- Modify: `packages/api/src/services/meta-connection.test.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/GIT_WORKFLOW.md`
- Modify: `docs/PROJECT_STATUS.md`

**Evidence schema v2:**

```ts
interface MetaLiveEvidenceV2 {
  schemaVersion: 2
  commitSha: string
  environment: 'dev' | 'production'
  pixelIdMasked: string
  connectionVerifiedAt: string
  capturedAt: string
  expiresAt: string
  events: Array<{
    eventName: 'Contact' | 'CompleteRegistration'
    browserEventId: string
    serverEventId: string
    browserSeen: boolean
    serverSeen: boolean
    deduplicated: boolean
    eventsReceived: 1
  }>
  enhancedMatch: {
    completeRegistrationEmail: boolean
    completeRegistrationExternalId: boolean
    contactContainsRegistrationIdentity: false
  }
  forbiddenEventsAbsent: {
    Lead: true
    StartTrial: true
  }
  datasetQualityContractVersion: number
  datasetQualityCollectorCurrent: boolean
}
```

- [ ] **Step 1: 写发布门禁失败测试**

覆盖：

- evidence 必须恰好包含 Contact、CompleteRegistration，各一组 Browser/Server 相同 event ID 且 deduplicated。
- 出现 Lead、StartTrial 或额外事件即失败。
- evidence commit 必须等于当前 40-char HEAD，环境匹配，24 小时内有效。
- resources verification 要求 migrations 0036/0037/0038/0039、Queue/DLQ、data key、verified connection、无 open critical incident。
- Dataset Quality contract 和 collector 未完成时 release 失败。
- production initial gate 要求 target/effective rollout 都为 0。
- production deploy 后 Test Event evidence 未通过时不能升到 10。
- production Owner Test Event 只在最终 main commit 已部署、target/effective rollout 均为 0、资源检查通过且无 open critical incident 时允许；否则 route 返回 409。
- deploy script 不自动改变 rollout。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test scripts/meta-live-verification-lib.test.mjs scripts/record-meta-live-verification.test.mjs scripts/verify-dev-rehearsal.test.mjs scripts/release-verification-lib.test.mjs scripts/verify-release.test.mjs scripts/verify-meta-resources.test.mjs
```

Expected: FAIL，旧 evidence 仍允许/要求 Lead，且没有 incident、rollout、connection、quality gate。

- [ ] **Step 3: 升级 evidence 与 release verifier**

旧 schema version 1 一律视为过期，不做自动转换。record script 逐项要求 Owner 确认 Events Manager 中 Browser、Server、deduplication、禁止事件缺席，并从 D1 readiness 读取增强匹配布尔覆盖，不要求用户输入 hash。

release verifier 固定执行：

```text
git clean/status gate
dependency install lockfile gate
lint
API/Web tests and coverage
script tests
API tsc
Web build
local-runtime verification
dev resource verification
current-commit dev live evidence
Dataset Quality collector freshness
open incident gate
production resource verification
initial rollout zero gate
```

- [ ] **Step 4: 实现冷启动发布顺序检查**

`verify-meta-resources --initial-meta-rollout` 明确检查 site setting target=0、无 open incident、secure outbox 无过期行、previous key active count 可解释。`deploy.sh production` 只部署 Worker，不写 site settings。

同时启用 production MetaConnection bootstrap：Owner 调用 admin Test Event route，使用 production 独立 Pixel/Dataset 和 test code；Meta 返回 `events_received=1` 后写入 production verification row，并绑定当前 `RELEASE_COMMIT`。普通 production CAPI payload 继续禁止 `test_event_code`。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
node --test scripts/meta-live-verification-lib.test.mjs scripts/record-meta-live-verification.test.mjs scripts/verify-dev-rehearsal.test.mjs scripts/release-verification-lib.test.mjs scripts/verify-release.test.mjs scripts/verify-meta-resources.test.mjs
corepack pnpm test:scripts
git diff --check
git add scripts packages/api/wrangler.toml packages/api/src/services/meta-connection.ts packages/api/src/services/meta-connection.test.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts docs/DEPLOYMENT.md docs/GIT_WORKFLOW.md docs/PROJECT_STATUS.md
git commit -m "test: 升级 Meta 生产发布证据门禁"
```

---

### Task 7: 完成全链路本地验证与上线前审查

**Files:**
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/UI_DATA_ANALYTICS_DASHBOARD.md`
- Move to archive or Delete after reference audit: superseded Meta implementation plans under `docs/superpowers/plans/`

- [ ] **Step 1: 执行旧代码与旧文档引用审计**

Run:

```bash
rg -n "recordConversionAction|recordAcceptedConversions|derivedActions|useConversionTracking|useFacebookPixel|meta:Lead|eventName: 'Lead'|action_type IN \('contact','lead'" packages scripts docs
rg -n "META_CAPI_ACCESS_TOKEN|META_CAPI_TEST_EVENT_CODE|META_CAPI_DATA_KEY" . --glob '!node_modules/**' --glob '!.git/**'
```

Expected:

- 第一条只允许历史 migration、历史数据说明和禁止事件测试命中。
- 第二条只允许 Bindings、secret presence check 和部署命令命中，不出现值。

将被新三阶段计划完全取代、且不再提供独立历史价值的旧 Meta readiness 计划移至 `docs/superpowers/archive/`；任何仍被 PROJECT_STATUS 或 evidence 引用的文档保留。不得批量删除与 Meta 无关文档。

- [ ] **Step 2: 执行完整自动验证**

Run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm --filter @meigallery/api test:coverage
corepack pnpm --filter @meigallery/web exec vitest run --coverage
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
corepack pnpm verify:quick
corepack pnpm verify:local-runtime
node scripts/verify-meta-secret-leaks.mjs
git diff --check
```

Expected: 全部通过。Meta 关键服务 statements >=85%、branches >=80%、functions >=85%、lines >=85%。

- [ ] **Step 3: 执行故障注入测试**

在 local D1/Queue mock 依次注入：

- Queue send 失败。
- Meta timeout、429、500、400、401、403。
- AES current/previous/unknown key。
- outbox 过期。
- fingerprint 改变。
- 15 分钟 permanent failure、retry exhausted、stale pending 边界。
- duplicate Queue delivery。

每个场景断言第一方事实不丢失、external event ID 不变、incident/重试分类正确、日志无敏感值。

- [ ] **Step 4: 生成 dev 候选证据但不部署 production**

在独立 dev Dataset 与 dev Worker 资源准备后执行：

```bash
./scripts/deploy.sh dev
corepack pnpm verify:dev-rehearsal
corepack pnpm verify:meta-live
node scripts/verify-meta-resources.mjs --env dev
```

确认 Contact、CompleteRegistration Browser/Server 去重、增强匹配覆盖、Dataset Quality collector 当前、无 Lead/StartTrial、无 open incident。所有证据绑定同一最终 commit。

- [ ] **Step 5: 更新状态并提交阶段结果**

`PROJECT_STATUS.md` 只在 Dataset Quality 补充计划已经执行、全量验证和 dev evidence 全部通过后标记“满足生产候选条件”；否则明确列出 blocker，不使用“基本完成”。

Run:

```bash
git add -A
git commit -m "test: 完成 Meta CAPI v2 上线前验证"
```

---

## Production Release Gate

满足以下全部条件前，结论必须是“不满足正式部署条件”：

- 三份 Meta CAPI v2 主计划全部执行并通过各自 Phase Exit Gate。
- Dataset Quality 官方契约已由 Owner 确认，补充 collector 计划已生成并完整执行。
- dev 与 production 使用独立 Pixel/Dataset、token、test code、data key、Queue 和 DLQ。
- migrations 0036/0037/0038/0039 已在 dev 演练，production migration preflight 无重复 action/channel。
- 当前最终 commit 的 API/Web/script tests、lint、coverage、API tsc、Web build、local runtime 全通过。
- 当前最终 commit 的 dev Meta live evidence 在 24 小时内，且只有 Contact、CompleteRegistration。
- MetaConnection verified，无 open critical incident，Dataset Quality 数据当前。
- production 资源检查通过，target/effective rollout 都为 0。
- PR 按项目规范合入 `main`，用最终 main commit 重新部署 dev 并重新生成 evidence。
- production 部署后真实 Test Event 成功，Owner 才可从 0 手动升到 10。

生产放量顺序固定为 `0 -> 10 -> 50 -> 100`。系统只能自动降到 0；任何回滚不得恢复 Lead 派生、Analytics conversion fallback 或页面直连 Pixel。
