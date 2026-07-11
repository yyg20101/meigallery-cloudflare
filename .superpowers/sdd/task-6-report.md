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

## Q6 独立审查 Critical/Important 修复（追加）

### 实现

- 新增 `0041_meta_live_challenges.sql`、`meta-live-challenge.ts`：dev Worker 生成绑定 `APP_ENV=dev`、当前 40 位 `RELEASE_COMMIT`、Owner、严格 1 小时和恰好两事件的 opaque challenge。消费先以 D1 CAS 抢占并在同次 UPDATE 清空原始 ID、保存不可逆摘要，再真实向 Graph 发送 `Contact` 与 `CompleteRegistration`；失败、重放、过期、错误 commit/env/owner 和非法 ID 均 fail closed。创建新 challenge 时清理过期行。
- 后台 dev 验证按钮调用 `useTracking.sendMetaLiveChallenge()`，通过现有唯一 Pixel adapter 执行两条真实 `fbq('track', ...)`，成功后才调用 Worker consume；CLI 不再生成 session/event ID，只读取 D1 `server_sent` 脱敏摘要和 Owner 的 Events Manager 确认，成功或失败均清理 challenge。
- 新增 Owner-only `/meta/resource-attestation`。dev/prod Worker 对同一随机 nonce 用 Pixel/token/Test Event Code/data key 分别生成 HMAC 身份摘要，响应绑定 environment、当前 deployed commit 和严格 5 分钟 TTL，不返回原始值。
- `verify-meta-resources` 删除 `META_RESOURCE_IDENTITIES_FILE` 输入，从真实 Wrangler D1 info、R2 info、Queue/DLQ info/consumer、secret list、remote D1 查询响应核对身份；migration gate 升至 `0041`。production 分为 endpoint 可缺席的 rollout=0 bootstrap、部署后 `trackingMode=test` live attestation、以及要求当前 connection 的 full gate。
- `assert-production-allowed` 在本地 release 摘要校验后重新查询当前 dev Worker identity、tracked Q5 contract、dev D1 live/connection/collector/resource/incident 和 production resource/incident/rollout；查询失败全部 fail closed。本地 `latest.json` current 字段篡改不能单独放行。
- production Test Event 只允许 `trackingMode=test`，并要求当前 commit post-deploy live attestation、rollout=0、无 critical incident；`disabled`/`production` 均在 fetch 前阻断。0→10 同时要求当前 production connection/Test Event 和 full isolation summary，所有 blocker 位于 rollout D1 UPDATE 前。普通 production CAPI 仍不带 `test_event_code`。
- 文档记录真实顺序：Q5/dev live → bootstrap → deploy → post-deploy attestation → production test mode Test Event → full gate → 切 production → 0→10。未把任何外部证据写成已完成。

### TDD Evidence

- RED：`corepack pnpm --filter @meigallery/api test -- src/services/meta-live-challenge.d1.test.ts src/services/meta-resource-attestation.test.ts src/utils/analytics-migrations.test.ts` 首次失败，两个服务模块与 `0041` 不存在；其余 978 项通过。
- GREEN：核心 challenge/attestation/migration 23 项通过；生产模式、路由和 rollout 聚焦组最终 185 项、强化后 165 项通过。
- RED/GREEN：聚焦 Playwright 首次因刷新后瞬时状态文本断言失败，但已确认 consume 200 和浏览器 fbq 队列两事件；删除瞬时 UI 文案断言后同一用例通过，仍严格断言队列恰好两条 `Contact`/`CompleteRegistration`。

### 验证

- Task 6 brief tests：101 项通过。
- `corepack pnpm test:scripts`：225 项通过，包含真实顺序 migration 测试；Q5 当前仓库 contract 缺失测试稳定 fail closed。
- 相关 API：路由/connection/challenge/attestation/migration 聚焦组通过；最后一次 challenge/API 聚焦 165 项通过。
- 相关 Web unit：29 项通过；`useTracking` 单文件 26 项通过。
- 聚焦 E2E：`smoke.spec.ts --project=chromium --grep "Meta 控制面"` 1 项通过，检查真实 fbq adapter 队列恰好两事件。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`：通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build`：通过，Nuxt 4.4.8 / Nitro `cloudflare-module`。
- `git diff --check`：通过；生产旁路扫描未发现实现代码残留 `META_RESOURCE_IDENTITIES_FILE`、本地 challenge session 或 preflight 假 event ID。

### 变更文件

- API/migration：`0041_meta_live_challenges.sql`、`meta-live-challenge.ts`、`meta-resource-attestation.ts`、`meta-connection.ts`、admin attribution route 及测试、migration 索引测试。
- Web：`MetaConnectionStatus.vue`、`useTracking.ts` 及 unit/E2E mock/smoke。
- scripts：live recorder、dev rehearsal、resource verifier、release verifier/lib 及测试。
- docs：`DEPLOYMENT.md`、`PROJECT_STATUS.md`、`TECHNICAL_SPEC.md`。

### 残余风险

- 按要求未访问远端、未部署、未推送，因而没有真实 dev/prod attestation、Meta Events Manager 去重截图或 production Test Event 证据。
- Q5 approved contract 仍不存在，真实 release/assert gate 会稳定失败；production rollout 必须保持 0。
- Wrangler Queue info 为文本响应，验证器要求响应中出现精确资源名并同时校验 consumer JSON；若未来 Wrangler 改变输出格式会 fail closed，需要按当时官方 CLI contract 更新解析器。

## Q6 第三轮定向修复（追加）

### RED

- CLI 测试证明旧实现会把 Owner Cookie 发往可编辑的 `VERIFY_*_API_URL`，没有一次性 ticket，也不校验 redirect/final URL。
- store 测试证明旧递归布尔 schema 无法写入真实 V2 `meta_live` 摘要；migration 测试证明 Wrangler 4.103.0 的 ANSI `✅ No migrations to apply!` 被误拒。
- API/Web 测试证明 production 0→10 未读取 `meta_tracking_mode`，production Owner 按钮隐藏；assert 测试证明 `latest.initialMetaRollout` 可改变受信 phase。
- `0042` 连续 migration 与 D1 原子 ticket 测试首次失败：migration、ticket service 均不存在。

### GREEN

- attestation 固定 dev `https://meigallery-api-dev.wajie.workers.dev` 与 production `https://api.616618.xyz`；Owner Cookie 仅用于换取 60 秒、绑定 environment/commit/nonce 的 `0042` D1 ticket。最终请求无 Cookie、`redirect=manual`，并精确校验响应 URL/origin/path；ticket 原子一次性消费且 D1 只存 SHA-256 摘要。
- release store 按 verification type 使用精确字段 allowlist；V2 `meta_live` 仅接受固定两事件、contract version/digest 与布尔结论，拒绝 secret、PII、raw ID 和额外对象。真实 store 写入后由 dev 远端 gate 读取通过。
- migration parser 兼容 Wrangler 4.103.0 ANSI/版本前缀，pending migration、`.sql` 行和含糊输出继续 fail closed；资源 migration gate 与文档升至 `0042`。
- production Owner 可见 Test Event 按钮，dev 保留 Browser/CAPI challenge；production 直接展示后端 blocker。production 0→10 额外读取并要求 `meta_tracking_mode=production`，在 rollout UPDATE 前阻断 test/disabled。
- `assert-production-allowed` 不再把本地 report 的 `initialMetaRollout` 传入受信 gate。phase 仅由 production D1 当前 commit、未过期、严格 bootstrap `meta_resources` permit 决定；无 permit 走 full gate，双向篡改测试均通过。
- deploy 路径继续不写 settings、rollout 或 incident；Q5 缺失继续稳定 fail closed。未生成 contract/evidence，未访问远端、未部署、未推送。

### 第三轮验证

- Q6 brief tests：106/106 通过。
- `corepack pnpm test:scripts`：232/232 通过。
- API unit：99 个文件、1001/1001 通过；包含 `0042` 真实 D1 并发一次性消费、admin route、rollout 与 migration。
- Web unit：52 个文件、250/250 通过。
- 聚焦 E2E：dev challenge 与 production Test Event/blocker 在 chromium、mobile-360、tablet-768、desktop-1024、desktop-1440 共 10/10 通过。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`：通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build`：通过，Nuxt 4.4.8 / Nitro `cloudflare-module`。
- `git diff --check`：通过。

### 第三轮 concerns

- 按要求未访问远端，固定可信 origin、远端 migration 和真实 D1 permit 尚需后续受控发布流程验证；当前 Q5 contract 缺失会继续阻断 release，production rollout 必须保持 0。

## Q6 第四轮最终定向修复（追加）

### 实现

- `readRemoteDevGate` 先拒绝非 40 位 commit，严格校验 D1 row 的 `verified_at`、`expires_at` 和固定 24 小时 TTL，并与 writer 共用 `assertReleaseVerificationSummary`/严格 row 校验；固定事件顺序、`eventsVerified=true` 和精确字段 allowlist。
- `meta_resources` 对 bootstrap、post-deploy、full 建立 phase-specific 严格语义。bootstrap 的连接、live attestation、rollout、outbox、previous key 与环境隔离布尔全部按冷启动事实约束；不完整摘要不能写入或作为 permit。
- migration 状态解析显式拒绝 warning/error/failed/unable/unavailable/partial/unknown 等冲突文本，只允许 Wrangler 版本 banner、分隔线和唯一成功终态。
- `verify-meta-migration` 在旧库上顺序应用 `0039`、`0040`、`0041`、`0042`，验证四个 circuit index、challenge/ticket 表与索引，并保全历史 action/delivery/connection/outbox/claim/incident/quality；同次演练另用空库真实应用 `0001..0042`。
- production 0→10 只接受精确 schema V2/full 资源摘要；最终 D1 UPDATE 同时 CAS 旧 rollout 和当前 JSON 字符串 `"production"` mode。真实 Miniflare D1 证明快照后 mode 并发改变时 `changes=0`、返回 409 且不写审计。
- 公开 resource attestation 复用现有公开 API IP 限流，ticket issue/consume 全响应 `Cache-Control: no-store`，消费响应与审计不回显 ticket；WAF 与部署文档同步。

### 验证

- Q6 聚焦脚本：115/115 通过。
- `corepack pnpm test:scripts`：242/242 通过；Q5 contract 缺失继续稳定 fail closed。
- API 全量：101 个文件、1007/1007 通过；包含 rollout 与 attestation 真实 D1/路由反例。
- Web 相关 unit：7 个文件、42/42 通过。
- Meta 相关 E2E：20/20 多视口通过；production Owner Test Event/blocker 另 5/5 通过。
- API `tsc --noEmit`、Nuxt 4.4.8 / Nitro `cloudflare-module` build、`git diff --check` 全部通过。
- 本地提交：`8938d37 fix: 加固 Meta 发布事实一致性`。

### Concerns

- 按要求未访问远端、未部署、未推送；固定可信 origin、远端 D1 permit 和真实 Meta evidence 仍需后续受控发布验证。
- Q5 approved contract 仍缺失，因此 production release 必须继续 fail closed，rollout 保持 0。

## Q6 最后一轮小修（追加，未提交）

### 实现

- production Test Event gate 现在只接受当前 commit、未过期的 `meta_resources` schema V2 `post-deploy` 摘要：顶层和 `environmentIsolation` 均要求精确字段集，所有 ready/outbox/key/noIncident/rollout/isolation 结论必须满足 post-deploy 语义。`bootstrap`、`full`、旧格式和额外 raw 字段均在 Graph fetch 前阻断。
- scripts release store 与 API 共享 post-deploy 测试 fixture，分别证明同一精确字段集可被 store 接受、被 API gate 接受；API 反例逐项覆盖所有资源、隔离、phase 与 rollout/incident 门禁。
- `verify-meta-resources` 将 migrations stdout 与 stderr 合并执行冲突检查；即使命令 exit 0 且 stdout 为成功终态，stderr 的 warning/error/partial 也会 fail closed。
- 精确 ticket 签发路径在认证和管理员限流之前设置 `Cache-Control: no-store`。真实全局路由覆盖 200、409、403、429，且证明其他管理员路由未被误加该 header。

### 验证

- API：102 个文件、1015 项通过。
- scripts：244 项通过。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`：通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build`：通过。
- `git diff --check`：通过。

### Concerns

- 按要求未访问远端、未部署、未推送；生产 Test Event 仍依赖后续受控发布中的真实远端 permit 与 Meta evidence。
- Q5 approved contract 仍缺失，production release 继续 fail closed，rollout 保持 0。

## 最终复审 2 Important + 3 Minor 修复（追加）

### TDD 与实现

- RED：真实 Miniflare D1 证明 DLQ `retry_exhausted`、connection drift、legacy/security terminate 会在 Graph winner 持有 active lease 时越权写终态、删除 outbox 并 ack；Web unit 证明 receipt 请求直连 API Worker、历史 granted refresh 失败不降级、plugin 初始化抛错和 async handler 可程序化重入；migration gate 只检查索引名称。
- GREEN：`transitionDeliveryStatus()` 的无 token 分支在同一 delivery `UPDATE` CAS 中要求 lease 为空或已过期，持 token winner 仍只匹配自身 token；Queue/DLQ/security 与 bulk expiry 共用该 transition，active lease loser 保留 outbox 并重试，过期 lease 可接管，`sent` 不回归。
- `useApi` 增加显式 `sameOrigin` 浏览器代理选项，仅用于 marketing consent GET/PUT、Contact conversion、registration 与 Pixel receipt 重试；代理在 Cloudflare 使用 `API_SERVICE`、本地测试回退 API URL，逐条转发多个 `Set-Cookie` 及后续 cookie。API receipt 继续 `SameSite=Lax`，CORS 未放宽。
- `useMarketingConsent.refresh()` 失败先降级 `limited`；facebook plugin 初始化失败 teardown 后安全返回；`MetaConnectionStatus` 两个 async handler 最前检查统一 busy 状态。
- `verify-meta-migration` 同时核验 `0043` 两列定义、lease expiry 部分索引目标列与 `WHERE`、`registration_conversion_recovery_cursor='0'`，真实旧库与空库均走相同 schema gate。

### 聚焦验证

- API lease/Queue/CAPI/secure outbox：79/79 通过，含真实 D1 active winner、四类无 token loser、lease 过期与 sent 不回归。
- Web 同源/consent/plugin/busy：46/46 通过；同源 receipt 注册/联系 Playwright：1/1 通过。
- migration 真实旧库/空库及反例：31/31 通过。
- API `tsc --noEmit`、Web `nuxt typecheck`：通过。

### 约束

- 未访问远端、未部署、未推送；Q5 approved contract 仍缺失，production release 继续 fail closed，rollout 必须保持 0。

### 最终全量验证

- API coverage：106 个文件、1043/1043 通过；statements 89.12%、branches 81.96%、functions 97.24%、lines 92.98%。故障注入覆盖 Queue send、Graph timeout/4xx/5xx、AES key、outbox expiry、connection drift、DLQ 与 duplicate delivery。
- Web unit：55 个文件、263/263 通过；Web E2E：120/120 通过，五个视口分别验证同源 receipt 的 `Set-Cookie`、后续 cookie 转发、Contact 与 registration。
- scripts：251/251 通过；migration 真实旧库、空库、重复组阻断和 0043 schema 反例全部通过。
- lint、全仓 typecheck、API/Web build、API dry-run、secret scan、`git diff --check`：通过。
- `verify:quick`：通过；`verify:local-runtime`：通过。Q5 缺失继续由 release gate fail closed，本轮未运行 production release、远端命令或部署。
