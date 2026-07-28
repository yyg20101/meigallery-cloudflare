# 项目状态

更新时间：2026-07-26。

本文件只记录当前状态。历史变更以 Git、PR、tag 和 `docs/releases/` 为准。

## 技术栈

- pnpm monorepo。
- Web：Nuxt 4、Tailwind CSS v4、Nuxt UI v4，部署为 Cloudflare Worker。
- API：Hono，部署为独立 Cloudflare Worker。
- 数据与运行资源：Cloudflare D1、R2、Queues、Turnstile。
- 不使用 Cloudflare Pages。

## 已有能力

- 公开图库、标签、搜索、案例、首页广告和联系方式。
- 注册、登录、邮箱验证、用户中心、会员状态和后台手动会员管理。
- 图库、媒体、标签、用户、会员、设置、联系方式、广告、案例、导入任务和审计后台。
- Telegram 只提供外部导入 API，不内置 Bot。
- 一方数据分析、来源、邀请码、有效联系、转化趋势和后台看板。
- SEO 设置、sitemap、robots、结构化数据和 production 校验。

## 通用广告归因

- 唯一业务事实：`Contact`、`CompleteRegistration`。
- 唯一事实表：`attribution_conversion_facts`。
- 一条事实最多属于 Meta、TikTok、Google 中的一个 provider。
- `fbclid`、`ttclid`、Google click ID 或后台受管投放链接决定唯一平台；普通 UTM 不决定平台。
- 没有新来源时继承 30 天内最近一次有效广告来源；自然流量没有历史来源时不加载 Pixel。
- 跨平台信号冲突或来源不可信时只记录站内事实，不向任何广告平台发送。
- Browser 与 Server 共用 external event ID，支持同平台去重。
- Meta、TikTok、Google 使用独立凭证、目标映射、Queue 和 DLQ。
- 平台凭证由 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 加密，管理端不回显明文。
- Test Event Code 只用于单次同步连接测试，不持久化，也不进入正式事件。
- 平台连接只保留连接、Browser、Server 三个开关，不存在 rollout、验证 Workflow 或发布门禁。

## 归因瘦身

当前归因运行时已收口到 `packages/api`：

- 删除独立 Attribution Worker。
- 删除 owner、epoch、cutover、bridge、shadow 和代理 API。
- 删除独立业务 Outbox 和验证工作流。
- 删除按比例 rollout。
- 删除 Git commit 与归因运行时绑定。
- 删除后台 verification/revision/rollout 交互。
- 删除地区判断、营销授权页、Banner、Consent Cookie、授权 API 和地区策略表。
- 删除前端 `adAttributionState` 放行字段；服务端优先信任加密来源上下文，Cookie 偶发缺失时只允许同一来源路由器根据当前官方 click ID 或 active 受管广告链接恢复平台，始终拒绝客户端直接声明 provider。
- 浏览器由单一 adapter registry 保证同一时刻只激活一个平台；平台变化或变为空时整页刷新。
- 连接读取改为 connection、bindings、credential 三张表直接查询。
- 连接内部 Outbox 作用域创建后保持稳定，保存配置不会使排队事件失效。
- `0060_attribution_control_plane_cleanup.sql` 清理 production 中旧控制面表和写入冻结 trigger，同时保留事实、投递、加密 Outbox、回执、故障和质量数据。
- `0061_attribution_source_router_cleanup.sql` 物理删除 consent、region、rollout、mode、revision 和冗余 provider 字段，并原值保留现有连接、最新加密凭证、事实、投递与 Outbox。
- `0062_attribution_runtime_garbage_cleanup.sql` 删除旧连接配置产生的质量快照和无读取方的 usage 表，不触碰业务事实或有效平台配置。
- `0063_attribution_tracking_source_contract.sql` 物理删除推广来源的旧 `link_proof` 列，逐字段保留全部来源及其状态、UTM、平台绑定和审计信息。

详细契约见 `docs/AD_PLATFORM_ARCHITECTURE.md`。

## 来源路由精简发布状态

- 来源路由精简已发布到 production，不存在关闭全部 Pixel 的中间版本。
- Meta、TikTok、Google、UTM、自然流量、冲突来源和最近来源继承均由同一来源路由器处理。
- D1 migration 保留有效连接、最新凭证、业务事实、Delivery、Outbox 和平台隔离约束。
- 发布验收以来源隔离、同事件 ID、类型检查、受影响 Worker 构建和 production smoke 为准，不在文档固化易过期的测试数量。

## 环境

- production：`meigallery-web`、`meigallery-api`、`meigallery-db`。
- dev：独立 Worker、D1、R2，不绑定广告 Queue，不请求真实平台。
- production 平台连接和实时质量以后台“归因”页面为准；文档不记录易过期的开关、比例、测试码或 commit。

## 发布

- PR CI 执行完整 lint、测试、覆盖率、Playwright、类型检查和构建。
- production 只允许从干净 `main` 手动发布。
- API/Web 可以按影响范围独立部署：

```bash
./scripts/deploy.sh production api
./scripts/deploy.sh production web
./scripts/deploy.sh production all
```

- API/Web commit 只用于观察，不要求相同，也不参与归因放行。
- 运行数据异常会产生警告，但不能阻止修复版本发布。
- 紧急故障先用最小改动恢复受影响 Worker，再完成完整复盘和相邻风险检查。

## 验证入口

```bash
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
node scripts/verify-production.mjs all
corepack pnpm verify:seo:production
```

## 规划

- 使用真实广告流量继续观察 Meta、TikTok、Google 的 Browser/Server 配对与平台质量。
- 广告花费、campaign、ad set 和 ad 维度导入不属于 Pixel/Server API 同步范围。
- Cloudflare Stream 和完整 zip 异步导入仍待实现。

## 文档入口

- `AGENTS.md`：开发和分支规范。
- `docs/TECHNICAL_SPEC.md`：API、Schema、权限和安全契约。
- `docs/AD_PLATFORM_ARCHITECTURE.md`：归因架构。
- `docs/DEPLOYMENT.md`：Cloudflare 资源和发布流程。
- `docs/GIT_WORKFLOW.md`：分支、PR、tag 和 commit。
- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`：数据分析口径。
- `docs/TELEGRAM_IMPORT_API.md`：外部导入 API。
- `docs/SEO_CONFIGURATION.md`：SEO 配置。
