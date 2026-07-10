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
