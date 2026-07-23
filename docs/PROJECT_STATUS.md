# 项目状态

更新时间：2026-07-23。

## 文档边界

本文件只记录当前真实状态，不承担历史 changelog。版本历史以 Git、PR、tag 和 `docs/releases/` 为准；技术契约见 `docs/TECHNICAL_SPEC.md`，部署规则见 `docs/DEPLOYMENT.md`。

## 技术栈

- pnpm monorepo。
- Web：Nuxt 4 + Tailwind CSS v4 + Nuxt UI v4，部署为 Cloudflare Worker。
- API：Hono + Cloudflare Workers。
- 数据：Cloudflare D1、R2、Queues、Workflows。
- Web 与 API 为两个独立 Worker，不使用 Cloudflare Pages。

## 环境与部署

- production：`meigallery-web`、`meigallery-api`、`meigallery-db`。
- dev：独立 Worker 和 D1，不绑定真实广告平台 Queue 或凭证，不请求 Meta/TikTok/Google API。
- production 只允许通过 PR 合入 `main` 后，在干净 `main` 执行 `./scripts/deploy.sh production`。
- release PR/CI 承担完整测试；部署脚本只执行快速代码门禁、必要的 D1 备份、migration、两个 Worker 部署、通用归因健康校验、identity 和 SEO smoke。
- 非关键、非关联或阶段性提交默认保留本地；功能闭环、需要 CI/协作或准备部署时再统一推送。

## 当前能力

- 公开图库、标签、搜索、真实案例、首页广告和联系方式。
- 注册、登录、邮箱验证、用户中心、会员状态与后台手动会员发放。
- 图库、媒体、标签、用户、会员、设置、联系方式、广告、案例、导入任务和审计日志后台。
- Telegram 仅提供外部导入 API，不内置 Bot。
- 一方数据分析、来源、邀请码、联系点击、趋势与后台 `/admin/analytics` 看板。
- SEO 设置、sitemap、robots、结构化数据和 production 校验。

## 独立 App 1.0 产品设计状态

- 当前只完成产品、交互与客户确认资料，不代表已启动 App 研发，也未创建 KMP 工程、App 专用 API 或数据库 migration。
- 已形成 App 1.0 单一需求基线，明确观看者、认证真人、平台运营和管理员角色；当前平台话题由运营接收，不冒充真人本人。
- 已完成 49 个移动端页面、43 个管理后台页面，共 92 个页面的逐页目标、状态、操作、异常与验收设计。
- 已完成 8 个高保真关键旅程原型，覆盖登录发现、真人详情、五级心享会员、会员申请与管理员发放、平台话题、通知与金币、真人发布、运营处理与调币审批。
- 已生成客户版《产品需求确认书》和《逐页交互设计确认册》DOCX；已完成 35 页与 16 页排版检查、无障碍检查和表格几何检查。
- 开发前仍须由客户确认 C-01～C-08，并由产品、运营、内容合规、设计和技术负责人关闭对应专业门禁；会员额度、运营容量和首批内容规模均为待确认的建议基线。
- 客户确认入口见 `docs/app/README.md`，交互原型见 `docs/app/interactive-prototype/`。

## 通用广告归因

- 唯一业务事实表：`attribution_conversion_facts`。
- 活动事件：`Contact`、`CompleteRegistration`。
- Meta、TikTok、Google 共享 schema、Planner、授权、Queue 状态机和后台连接 API，但使用独立来源、凭证、Queue/DLQ、验证、incident 和 rollout。
- 单条事实最多属于一个 provider；跨平台冲突或无可信来源时只保留站内事实，零广告投递。
- 前端只消费 provider-aware `trackingInstructions`，按唯一 provider adapter 发送 Browser 事件。
- Owner 在统一后台原子保存 destination、事件映射、加密凭证、模式和开关；明文凭证不回显、不记录。
- Test Event Code 仅是单次验证参数，不持久化，正式事件不携带测试码。
- Meta Dataset Quality 由通用 collector 写入 `attribution_quality_snapshots`。
- Google Data Manager 已实现可信 Consent、`requestId` 接收校验和 `requestStatus.retrieve` 异步诊断；TikTok 质量在后台明确要求 Events Manager 人工证据，不伪造平台质量分。
- Meta/TikTok Server 投递会在营销授权有效时使用 Cloudflare 可信 IP 与浏览器 User-Agent 提升匹配质量；该组合只进入 24 小时加密 Outbox，不进入事实、分析、日志或 Google 请求。

## Contract 状态

- `0051_unified_attribution_expand.sql` 已定义最终 11 张 `attribution_*` 表。
- `0052_unified_attribution_contract.sql` 已于 2026-07-16 在 production 应用：17 条 Meta 质量历史已迁移，400 条最终归因事实完整保留，旧事实、投递、连接、验证、Outbox、Meta 运维表、桥接 trigger 和 `users.meta_external_id` 已删除。
- production 已应用 `0055_attribution_tracking_integrity.sql`：投放来源约束统一支持 Meta/TikTok/Google，每个管理来源持有独立随机 `link_proof`，只有数据库匹配的 `mg_source + mg_proof` 才能建立平台来源，UTM 只参与冲突检测；历史管理链接的 referral 误分类、来源/页面/邀请日报和有效联系聚合已按事件发生的北京时间自然日从原始事实重建。
- production 已应用 `0056_attribution_fact_source_integrity.sql`：2 条旧版 `utm_alias` TikTok 推测事实及其 Delivery/Receipt 已从活跃事实源删除，并由 D1 trigger 强制 `provider=null` 只能对应 `none/conflict`、广告 provider 只能对应 `click_id/managed_link`。migration 前 D1 备份和 Time Travel 保留原始审计证据。
- `0057_contact_aggregate_integrity.sql` 仅使用强制完整保留的 `contact_method_click` 原始事实，按北京时间重建事件趋势和来源点击日报；页面浏览等抽样事件不会被原始抽样表覆盖。production 发布门禁会逐日、逐来源对账两个联系日报。
- 旧平台专用 API 服务、运维脚本、一次性回填/对账脚本和发布报告特例已从当前代码删除。
- Contract 发布前已生成仓库外 D1 export、Time Travel bookmark 和 SHA-256 manifest；production 发布提交为 `63d7ec1`，版本标签为 `v0.4.6`。
- 旧 `meigallery-meta-capi*`、`meigallery-tiktok-events*` Queue 和 `META_CAPI_ACCESS_TOKEN`、`META_CAPI_DATA_KEY_CURRENT` Worker Secret 已删除；通用 `meigallery-ad-*` Queue 与 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 保留。

## Production 归因状态

- 最新 production 代码提交为 `12e5781`，版本标签为 `v0.4.14`；PR #66 已先行发布 Meta 零投递保护，production identity、归因状态和 SEO smoke 均已通过。
- Meta 使用 production 连接并已完成真实 Contact / CompleteRegistration 验证，当前 rollout 以后台实时值为准；最近确认值为 `10%`。
- TikTok production 连接已原子配置 Pixel、Events API 凭证和 Contact / CompleteRegistration 事件绑定；2026-07-16 使用当次临时 Test Event Code 完成自动验证和 Events Manager 人工证据确认，临时测试码未持久化。
- TikTok Browser 已启用，Server target / effective 均为 `10%`；production 隔离访问只加载 TikTok Pixel SDK，Meta / Google Browser SDK 均未加载。TikTok Events Manager 的投放就绪状态仍需等待正式事件与平台最长约 24 小时刷新，不以 Test Events 代替真实流量验收。
- 2026-07-18 已在 production 使用 TikTok 来源参数验证真实页面链路：Pixel SDK 与 `/api/v2/pixel` 均返回成功，`PageView` / `ViewContent` 已从正式页面发送；截至 2026-07-23，production 已有 2 条 TikTok Contact 事实及对应 Browser 尝试回执，10% Server 分桶尚未产生正式 Server 样本，不能据此判定 Events API 异常。
- TikTok Events Manager 保持 AAM 关闭、第一方 Cookie 开启、Enhanced Data Postback 关闭，避免超出项目标准事件和授权范围的自动采集。
- `0053_attribution_privacy_policy.sql` 已在 production 应用：非严格地区默认启用并可从隐私页退出，严格/未知/Tor 地区先选择，GPC 和明确拒绝始终优先。长期签名选择与短期 receipt 只表示用户明确选择，不把地区默认值伪装成同意。
- 访客隐私设置页按必要功能与可选效果分析分层说明数据用途、受托处理、隐私保护和选择期限，允许与拒绝保持同等视觉权重；页面不展示广告平台名称、事件名或传输实现，后台继续保留完整运维信息。无论营销衡量状态如何，站内 Contact/CompleteRegistration 事实持续记录，Meta/TikTok/Google 仍按唯一来源严格隔离。
- `v0.4.10` 已移除非严格地区的一次性底部说明和悬浮设置控件，改为页脚低干扰“隐私”入口；严格地区首次选择条保持不变。`0054_attribution_privacy_switzerland.sql` 以幂等方式补充瑞士严格地区，不覆盖后台已有地区配置。
- `v0.4.12` / `v0.4.13` 已修复中文图库和案例链接在 Service Binding、SSR 直达时的编码与响应头问题，可用于 production 广告落地页。
- 待发布分支已修复 `paid_social` 来源识别、`utm_content` 跨页面持久化、Meta Dataset Quality 的 Graph API 包裹响应、投放追踪链接缺失 API、有效联系重复口径、每日聚合归零和容量统计 UTC 跨日偏差；Click ID、后台绑定平台与明确平台 UTM 互相冲突时失败关闭，禁止 Meta/TikTok/Google 跨平台投递，并补齐 Meta/TikTok Server 的可信 IP/UA 匹配上下文。以上变更待合规发布后生效。
- Google 的启用状态以统一后台实时连接为准；代码部署不会自动开启平台或提高 rollout。
- production 域名：`616618.xyz`、`www.616618.xyz`；API：`api.616618.xyz`。

## 当前验证入口

- `corepack pnpm verify:quick`
- `corepack pnpm verify:local-runtime`
- `corepack pnpm verify:dev-rehearsal`
- `corepack pnpm verify:release`
- `node scripts/verify-release.mjs assert-production-attribution`
- `node scripts/verify-release.mjs assert-production-identity`
- `corepack pnpm verify:seo:production`

## 规划

- TikTok 继续完成真实广告来源下 Browser / Server 配对去重与 `10% -> 50% -> 100%` 观察；Google 仍需 production 凭证、转化操作、异步 request status 与分级 rollout 验收。
- 广告花费、campaign、ad set、ad 数据导入不属于当前 Pixel/Server API 同步范围。
- Cloudflare Stream 视频链路和完整 zip 异步导入仍待实现。
- 独立 App 在客户确认需求后进入视觉定稿、契约冻结和研发排期；客户端技术基线为 KMP + Compose Multiplatform，首期不接入支付、系统推送或普通用户桌面端。

## 文档入口

- `AGENTS.md`：开发、分支和任务完成规范。
- `docs/TECHNICAL_SPEC.md`：API、Schema、权限与安全契约。
- `docs/DEPLOYMENT.md`：Cloudflare 资源和发布流程。
- `docs/GIT_WORKFLOW.md`：分支、PR、tag 和 commit 规范。
- `docs/AD_PLATFORM_ARCHITECTURE.md`：通用广告归因架构。
- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`：后台数据分析看板口径。
- `docs/TELEGRAM_IMPORT_API.md`：外部导入 API 契约。
- `docs/SEO_CONFIGURATION.md`：SEO 配置。
