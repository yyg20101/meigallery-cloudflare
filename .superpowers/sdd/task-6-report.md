# Task 6 报告：加固 CAPI 超时、状态转换、重试与 DLQ

## 状态

已完成。实现范围仅覆盖 Task 6：Meta CAPI 组合超时、响应判定、固定脱敏错误、delivery 状态桶转换、Queue 逐条重试、DLQ 回写和生产/dev Queue 隔离；未提前实现 Task 7 管理 API 或 Task 9 发布 gate，未推送、未部署。

## RED

### CAPI 与 Queue

- 先扩展 `meta-capi.test.ts` 并创建 `meta-capi-queue.test.ts`，覆盖 Graph API v25.0、`events_received=1` 唯一成功条件、2xx/0 永久失败、网络/超时 retryable、调用方 signal、固定脱敏错误、退避表、DLQ 回写、逐条 ack/retry、sent 重投诊断和状态桶计数。
- 首次运行 `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts` 失败：Queue service 不存在；13 个 CAPI 测试中 6 个失败，缺少 `eventsReceived`、领域错误、可注入 fetch/timeout/signal，旧实现也未校验 `events_received`。
- RED 结果：2 个测试文件失败；其余现有测试通过。

### 资源隔离

- 先扩展 `verify-dev-resources.test.mjs`，要求解析生产/dev 主 Queue 与 DLQ、`max_retries=5`、`retry_delay=60`，并拒绝环境交叉。
- 首次运行 `node --test scripts/verify-dev-resources.test.mjs` 失败 2 项：旧脚本不返回 Queue 配置，也不会拒绝主 Queue/DLQ 复用。

## GREEN

### CAPI adapter

- `sendMetaCapiEvent()` 支持注入 `fetchFn`、`timeoutMs` 和调用方 `signal`，默认超时为 8 秒；同一 AbortController 覆盖请求和响应体读取。
- Graph API 固定为 `/v25.0/<pixel-id>/events`；仅 HTTP 2xx 且 `events_received === 1` 返回 `sent`。
- 429、5xx、网络错误和超时抛出固定文本的 `MetaCapiDeliveryError(retryable=true)`；确定性 4xx 与 2xx/0 返回 permanent failure。
- 结果增加 `eventsReceived` 和清洗后的 `traceId`；token、Queue 临时 `userData`、Meta 原始错误体和异常原文均不进入结果、D1 错误字段或日志。

### 状态与日报桶

- 抽取 `transitionDeliveryStatus()`，Pixel attempted、CAPI sent/failed/skipped 和 Queue 提交失败共用同一状态转换入口。
- delivery 创建与 action/derived action 一起在原 D1 batch 中写入 `pending` 日报桶。
- 状态变化使用单个 D1 batch：条件更新 delivery，增加新桶，再减少旧桶；同状态只更新错误诊断、`attempt_count` 和 `last_attempt_at`，不重复增加日报。
- `sent` 为不可降级终态；重投不调用 Meta、不修改 delivery 或 sent 桶，只增加一次 `duplicate_suppressed/already_sent` 诊断并 ack。

### Queue 与 DLQ

- 新增 `handleMetaCapiBatch()`；主 Queue 逐条 await，成功和永久失败 ack，可重试错误按 60/300/900/1800 秒退避并封顶。
- DLQ 通过 queue 名称后缀识别，将非 sent delivery 回写为 `failed/retry_exhausted` 后 ack；sent 消息仍遵守不可降级规则。
- `index.ts` Queue 入口仅委托新 service，继续传递 Task 5 的临时 `userData`。

### Cloudflare 配置

- 生产主 Queue：`meigallery-meta-capi`；DLQ：`meigallery-meta-capi-dlq`。
- dev 主 Queue：`meigallery-meta-capi-dev`；DLQ：`meigallery-meta-capi-dev-dlq`。
- 两套主 consumer 均配置 `max_retries=5`、`retry_delay=60` 和对应 `dead_letter_queue`；DLQ consumer 独立配置。
- 资源隔离脚本解析重复 consumer 段，校验 producer/consumer/DLQ 对应关系、重试参数和环境隔离。

## 验证

- `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/services/conversions.test.ts`
  - 结果：81 个测试文件、544 项测试通过。
- `corepack pnpm test:scripts`
  - 结果：6 个 suite、59 项测试通过。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`
  - 结果：通过。
- `corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist`
  - 结果：通过；Wrangler 4.103.0 解析生产配置，主 Queue 绑定为 `meigallery-meta-capi`。
- `corepack pnpm --filter @meigallery/api exec wrangler deploy --env dev --dry-run --outdir=dist-dev`
  - 结果：通过；Wrangler 4.103.0 解析 dev 配置，主 Queue 绑定为 `meigallery-meta-capi-dev`。
- `corepack pnpm --filter @meigallery/web exec nuxt build`
  - 结果：通过；Nuxt 4.4.8 / Nitro `cloudflare-module` 构建完成。

## 自审

- D1 状态转换 batch 以 `changes()` 串联新桶增加和旧桶减少；并发条件更新失败时不会移动日报桶。
- retryable 重试、DLQ 同状态回写和 sent 重投均有 attempt/日报不重复断言。
- Queue 日志只包含 delivery ID、固定 error code、attempt 和 delay；不记录异常对象或消息 `userData`。
- 保留 Task 5 的四字段临时链路及二次清洗，不把临时匹配数据写入 D1。
- 未修改 Task 7 管理 API、Task 9 发布 gate，也未推送或部署。

## 疑虑

无阻断性疑虑。Wrangler dry-run 能确认 TOML 可解析和主 Queue binding，但不会证明远端 DLQ 已创建；实际资源存在性应在后续发布资源检查中验证。本任务按要求未创建远端 Queue/DLQ、未部署。

## 复审 Important 修复（追加）

### RED

- 新增 Queue CAS 竞争测试：首次读取为 `pending`，写 sent 前由另一处理者原子切到 `failed`；要求当前处理者重读后完成 `failed -> sent`，后续重投只增加 `duplicate_suppressed` 且不再次调用 Meta。
- 新增 CAS 连续三次失败测试：无法确认 D1 为 sent 时必须抛固定脱敏 retryable 错误，由 Queue 调用 `retry({ delaySeconds: 300 })`，不得 ack 假成功。
- 新增永久 4xx 与并发 sent 竞争测试，要求 delivery 和日报 sent 桶不可降级或增加 failed 桶。
- 新增 Admin Test Event 原子创建测试，覆盖 action、delivery、pending 日报三个 batch 步骤分别失败时全部回滚；正常缺 secret 转换前必须创建 pending 桶，转换后 pending 正确减为 0。
- 首次运行 `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/routes/admin/attribution.test.ts` 失败 5 项：CAS 竞争后 D1 仍为 failed、CAS 耗尽仍 ack、Test Event 未创建 pending 桶、delivery/daily 创建失败未触发原子回滚。其余 543 项通过。

### GREEN

- 新增 `confirmDeliveryTransition()`，最多执行三次 CAS。每次 `changed=false` 都重新读取 delivery：已 sent 立即确认；pending/failed 使用实际状态重新执行原子转换；仍无法确认时抛 `meta_delivery_state_conflict`、`retryable=true` 的固定错误。
- success、2xx/0、4xx、429/5xx、网络和超时路径均使用状态确认；并发已 sent 时返回 D1 的 sent 事实，不写 failed/skipped，不把外部异常原文带入结果或日志。
- DLQ 的 `retry_exhausted` 回写同样复用状态确认；若竞争后发现 sent，只记录重投诊断，不降级。
- 新增 `createMetaCapiTestDelivery()`，通过单个 D1 batch 原子写 conversion action、meta_capi pending delivery 和 `analytics_conversion_delivery_daily/pending` 桶；batch 任一步异常统一抛固定创建错误。
- Admin Test Event 仅替换创建方式，保留既有 API 状态码、响应结构和 readiness 行为，未提前实现 Task 7 strict API shape/readiness。

### 复审验证

- `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/routes/admin/attribution.test.ts`
  - 结果：81 个测试文件、550 项测试通过。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`
  - 结果：通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build`
  - 结果：通过；Nuxt 4.4.8 / Nitro `cloudflare-module` 构建完成。

### 复审自检

- CAS 重读不会再次调用 Meta；只重试 D1 状态确认，避免放大外部投递。
- sent 仍是不可降级终态，成功和永久失败竞争均有测试覆盖。
- 创建失败测试验证 action、delivery 和 pending 桶状态全部回滚；正常 skipped 转换验证 pending 桶减少。
- 新错误 code、message 和 Queue 日志均为固定文本，不包含 access token、Meta 原始错误或临时 `userData`。
- 未修改 Task 7 readiness/API shape 或 Task 9 发布 gate，未推送、未部署。

## 复审 DLQ 全状态修复（追加）

### RED

- 扩展 Queue 状态 fixture 到完整 `ConversionDeliveryStatus`，新增 `skipped`、历史 `attempted` 进入 DLQ 后必须原子转为 `failed/retry_exhausted` 并 ack 的测试。
- 新增 DLQ CAS 途中变 sent 测试：必须保持 sent、只增加 `duplicate_suppressed` 诊断并 ack。
- 新增任意非 sent 状态连续三次 CAS 冲突测试：耗尽后 retry 1800 秒，不得 ack 假成功。
- 首次运行 `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-queue.test.ts src/services/meta-capi.test.ts` 失败 3 项：skipped、attempted 被窄状态确认器拒绝，CAS 竞争变 sent 也未进入确认流程；其余 551 项通过。

### GREEN

- `confirmDeliveryTransition()` 新增显式 `allowAnyNonSent` 参数；默认仍只允许主投递的 pending/failed，避免放宽正常 CAPI 状态机。
- DLQ `retry_exhausted` 路径单独启用 `allowAnyNonSent`，因此 pending、failed、skipped、attempted、duplicate_suppressed 等任何非 sent 历史状态都能基于当前实际状态执行原子 CAS。
- 每次 CAS 失败仍重新读取 delivery；发现 sent 时不降级并记录重投诊断，其余非 sent 状态继续以实际状态重试；三次耗尽继续由 DLQ handler retry。
- 修正测试 fixture，使无条件 `duplicate_suppressed` upsert 不错误继承前一条 CAS 的 `changes()`；生产 SQL 未作放宽。

### 验证与自检

- `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-queue.test.ts src/services/meta-capi.test.ts`
  - 结果：81 个测试文件、554 项测试通过。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`
  - 结果：通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build`
  - 结果：通过；Nuxt 4.4.8 / Nitro `cloudflare-module` 构建完成。
- 状态迁移继续复用 `transitionDeliveryStatus()` 的同一 D1 batch，旧日报桶减少与 failed 桶增加保持原子。
- DLQ 日志仍只包含固定文案和 delivery ID；`retry_exhausted` 错误字段保持固定脱敏，不记录 token、Meta 原始错误或临时 `userData`。
- 未修改 Task 7/9，未推送、未部署。
