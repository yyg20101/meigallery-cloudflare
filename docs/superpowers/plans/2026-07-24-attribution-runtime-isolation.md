# 统一归因运行时隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Meta、TikTok、Google Ads 归因从主 API 中彻底拆为独立运行时，并在不中断现有生产归因、不双投递、不依赖 Git commit 的前提下完成迁移和旧逻辑清除。

**Architecture:** 以 `packages/attribution` 独立 Cloudflare Worker、独立 D1 和独立平台 Queue 为唯一归因运行时；业务 API 只通过版本化 Service Binding 契约写入可信业务事实。实施拆成四个独立验收阶段，每个阶段都必须保持上一阶段可运行，最终切换采用单写者门禁并删除旧运行代码。

**Tech Stack:** TypeScript 6、Hono 4、Cloudflare Workers、D1、Queues、Service Bindings、Nuxt 4、Vitest 4、Playwright。

## Global Constraints

- 规范唯一来源：`docs/superpowers/specs/2026-07-24-attribution-runtime-isolation-design.md`。
- 真实 Meta、TikTok、Google Ads 只允许 `production`；`dev/local` 只允许 Mock、测试凭证和隔离资源。
- Git SHA、Worker Version Metadata、`connection_revision` 和 `credential_revision` 不得参与连接启停、验证、rollout、回滚或投递判断。
- 身份配置、凭证、事件映射必须形成不可变候选版本；运行策略必须使用独立命令和独立表。
- 同一 provider 可有多个连接；每个事实最多路由到一个 provider 的一个 connection，禁止广播和猜测。
- `Contact` 与 `CompleteRegistration` 是唯一 Canonical Conversion Event。
- Browser 与 Server 必须复用同一 `event_id`、同一 `connection_id`、同一 `version_id`。
- 所有写命令必须幂等；同一幂等键重放为零写入、零审计、零验证。使用新幂等键提交语义相同的 no-op 时，只允许写入该键的回执，不得改业务状态、写审计或启动验证，防止该键随后被改作其他请求。
- 候选失败不得影响当前 Active；Server 熔断不得关闭 Browser。
- 生产切换禁止双写、双消费和双平台投递；观察期结束后删除旧运行路径。
- 经 Cloudflare 官方文档于 2026-07-24 核验：Workers Free 为账户级 100,000 请求/日；D1 Free 为账户级 5,000,000 rows read/日、100,000 rows written/日和 5GB 总存储；Queues Free 为账户级 10,000 operations/日且消息只保留 24 小时。容量预算不得把额度视为单个 Worker、数据库或 Queue 独享。
- 不引入 Cloudflare Pages 或非 Cloudflare 基础设施。
- 每个任务按“失败测试、最小实现、通过测试、提交”顺序执行。

---

## 执行顺序

| 阶段 | 计划 | 可独立验收产物 | 生产影响 |
|---|---|---|---|
| 1 | [运行时基础](./2026-07-24-attribution-runtime-foundation.md) | 独立 Worker、D1 Schema、不可变配置状态机、运行策略 | 无流量切换 |
| 2 | [事件与平台投递](./2026-07-24-attribution-event-delivery.md) | 可信路由、运行租约、Canonical Event、三平台 Adapter、Queue | 只使用 Mock/隔离资源 |
| 3 | [后台控制面](./2026-07-24-attribution-admin-control-plane.md) | 多连接管理、候选验证、运行控制、质量与 Incident UI | 读取新系统，不切生产投递 |
| 4 | [迁移、切换与清理](./2026-07-24-attribution-production-migration.md) | 生产资源、数据迁移、单写切换、对账、旧代码和旧表删除 | 受控生产切换 |

## 设计覆盖矩阵

| 已确认设计章节 | 落地计划 | 主要验收 |
|---|---|---|
| 4-8 独立运行时、领域模型、状态机、唯一写入口 | 阶段 1 | D1 状态机、原子激活、运行策略隔离、Git commit 零依赖 |
| 9-13 可信来源、Canonical Event、Adapter、验证与故障 | 阶段 2 | 严格单连接路由、Browser/Server 去重、三平台隔离、Server 熔断 |
| 14-15 后台信息架构与 Service Binding | 阶段 3 | 身份候选与运行控制分离、管理员鉴权、审计和无凭证明文 |
| 16 隐私与数据最小化 | 阶段 2、3 | 地区/GPC 决策、最小保留、后台可审计策略 |
| 17 部署隔离 | 阶段 1、4 | 独立 Worker 发布、普通 API/Web 发布不触碰归因运行时 |
| 18 Free 容量边界 | 阶段 2、4 | 日容量预算、Queue 降级、容量 Incident |
| 19 一次性迁移 | 阶段 4 | 暗模式、单写者桥、全集合对账、可演练回滚 |
| 20-21 测试策略与完成标准 | 全阶段 | 各阶段门禁、生产 smoke、24 小时观察、旧代码零残留 |

## 总门禁

- [x] **Gate 1: 基础运行时验收**

Run:

```bash
corepack pnpm --filter @meigallery/attribution test
corepack pnpm --filter @meigallery/attribution typecheck
corepack pnpm --filter @meigallery/attribution build
```

Expected: 三条命令退出码均为 `0`；状态机故障注入、幂等和运行策略隔离测试全部通过。

- [ ] **Gate 2: 事件与平台隔离验收**

Run:

```bash
corepack pnpm --filter @meigallery/attribution test
corepack pnpm --filter @meigallery/web test -- ad-platform
corepack pnpm --filter @meigallery/api test -- attribution-outbox
```

Expected: Meta、TikTok、Google 路由矩阵全部通过；任何测试事实只产生一个目标 connection 的 delivery；Browser/Server `event_id` 完全一致。

- [ ] **Gate 3: 控制面验收**

Run:

```bash
corepack pnpm --filter @meigallery/web test -- admin-attribution
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/admin-attribution.spec.ts
corepack pnpm --filter @meigallery/api test -- attribution-proxy
```

Expected: 身份保存、运行控制、验证、回滚和停用界面彼此独立；页面不出现 Git commit、revision 或凭证明文。

- [ ] **Gate 4: 生产切换批准**

Run:

```bash
node scripts/verify-attribution-cutover.mjs preflight
node scripts/verify-release.mjs release
git diff --check
```

Expected: 输出 `ATTRIBUTION_CUTOVER_PREFLIGHT_OK` 和发布验证通过；旧写者尚未停用，生产平台 delivery 仍由旧系统唯一发送。

- [ ] **Gate 5: 切换后集合对账**

Run:

```bash
node scripts/verify-attribution-cutover.mjs reconcile --window-minutes=30
node scripts/verify-attribution-cutover.mjs isolation
```

Expected: 输出 `FACT_SET_MATCHED`、`NO_DUPLICATE_DELIVERY` 和 `DEPLOYMENT_ISOLATION_OK`；不允许以抽样代替全集合对账。

- [ ] **Gate 6: 旧逻辑删除验收**

Run:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
rg -n "RELEASE_COMMIT|verifiedCommit|connectionRevision|credentialRevision|AD_META_QUEUE|AD_TIKTOK_QUEUE|AD_GOOGLE_QUEUE" \
  packages/attribution \
  packages/api/src/services/attribution-service-client.ts \
  packages/api/src/services/attribution-business-outbox.ts \
  packages/api/src/routes/admin/attribution-proxy.ts \
  packages/web/app/plugins/attribution.client.ts
```

Expected: 测试、类型检查和构建退出码均为 `0`；`rg` 无输出。API/Web 自身可以继续记录 release identity 用于部署诊断，但归因运行模块不得读取或判断该信息。

## 提交策略

每份子计划使用独立提交序列，不把四个阶段压成单个提交。阶段完成提交格式：

```text
feat: 建立独立归因运行时
feat: 统一归因事件与平台投递
feat: 重构归因后台控制面
deploy: 切换独立归因生产运行时
refactor: 删除旧归因运行逻辑
```

生产发布必须从 `dev` 创建 `release/vX.Y.Z`，通过 PR 合入 `main`。普通 Web/API 发布不得调用 Attribution Worker 部署命令；只有 `packages/attribution/**`、其 migration 或归因专属部署脚本变化时才允许部署 `meigallery-attribution`。

## 容量口径依据

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
