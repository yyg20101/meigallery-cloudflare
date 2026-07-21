# 项目状态

更新时间：2026-07-21。

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

## Contract 状态

- `0051_unified_attribution_expand.sql` 已定义最终 11 张 `attribution_*` 表。
- `0052_unified_attribution_contract.sql` 已于 2026-07-16 在 production 应用：17 条 Meta 质量历史已迁移，400 条最终归因事实完整保留，旧事实、投递、连接、验证、Outbox、Meta 运维表、桥接 trigger 和 `users.meta_external_id` 已删除。
- 旧平台专用 API 服务、运维脚本、一次性回填/对账脚本和发布报告特例已从当前代码删除。
- Contract 发布前已生成仓库外 D1 export、Time Travel bookmark 和 SHA-256 manifest；production 发布提交为 `63d7ec1`，版本标签为 `v0.4.6`。
- 旧 `meigallery-meta-capi*`、`meigallery-tiktok-events*` Queue 和 `META_CAPI_ACCESS_TOKEN`、`META_CAPI_DATA_KEY_CURRENT` Worker Secret 已删除；通用 `meigallery-ad-*` Queue 与 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 保留。

## Production 归因状态

- 最新 production 代码提交为 `93343ae`，版本标签为 `v0.4.10`；PR #61、完整 CI、production identity、归因状态和 SEO smoke 均已通过。
- Meta 使用 production 连接并已完成真实 Contact / CompleteRegistration 验证，当前 rollout 以后台实时值为准；最近确认值为 `10%`。
- TikTok production 连接已原子配置 Pixel、Events API 凭证和 Contact / CompleteRegistration 事件绑定；2026-07-16 使用当次临时 Test Event Code 完成自动验证和 Events Manager 人工证据确认，临时测试码未持久化。
- TikTok Browser 已启用，Server target / effective 均为 `10%`；production 隔离访问只加载 TikTok Pixel SDK，Meta / Google Browser SDK 均未加载。TikTok Events Manager 的投放就绪状态仍需等待正式事件与平台最长约 24 小时刷新，不以 Test Events 代替真实流量验收。
- 2026-07-18 已在 production 使用 TikTok 来源参数验证真实页面链路：Pixel SDK 与 `/api/v2/pixel` 均返回成功，`PageView` / `ViewContent` 已从正式页面发送；TikTok 正式 Contact / CompleteRegistration 事实仍为零，必须等待真实业务动作，不以合成转化污染投放数据。
- TikTok Events Manager 保持 AAM 关闭、第一方 Cookie 开启、Enhanced Data Postback 关闭，避免超出项目标准事件和授权范围的自动采集。
- `0053_attribution_privacy_policy.sql` 已在 production 应用：非严格地区默认启用并可从隐私页退出，严格/未知/Tor 地区先选择，GPC 和明确拒绝始终优先。长期签名选择与短期 receipt 只表示用户明确选择，不把地区默认值伪装成同意。
- 访客隐私设置页按必要功能与可选效果分析分层说明数据用途、受托处理、隐私保护和选择期限，允许与拒绝保持同等视觉权重；页面不展示广告平台名称、事件名或传输实现，后台继续保留完整运维信息。无论营销衡量状态如何，站内 Contact/CompleteRegistration 事实持续记录，Meta/TikTok/Google 仍按唯一来源严格隔离。
- `v0.4.10` 已移除非严格地区的一次性底部说明和悬浮设置控件，改为页脚低干扰“隐私”入口；严格地区首次选择条保持不变。`0054_attribution_privacy_switzerland.sql` 以幂等方式补充瑞士严格地区，不覆盖后台已有地区配置。
- 当前 dev 已修复中文图库和案例链接在 SSR 直达时重复编码导致的 404，待下一次正式发布后用于广告落地页。
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
- 独立真人发现与互动 App 的 1.0 产品总纲、架构、数据迁移、API/实时通信、UI/UX、信任安全、商业账本和质量路线图处于需求讨论中，入口为 `docs/app/README.md`。App 1.0 发布范围已冻结为：真人发现、五级会员展示与管理员手动发放、所有有效会员私信、平台代运营、站内通知、管理员加扣币和用户金币明细；不接入在线支付、金币充值、系统推送、图片消息、礼物或装扮交易。详细 Feature PRD 已完成 F-01 账号与设备、F-02–F-05 发现/搜索/详情、F-06 单向互动、F-07/A-06 会员私信与代运营、F-09/A-08 会员/entitlement/手动发放、F-10/A-10 钱包账本与调币、F-12 站内通知、F-13 隐私与数据权利、A-01–A-02 真人来源/上传/MeiGallery 导入、A-03 认证发布、A-04 taxonomy/地区、A-05 推荐运营、A-07 举报安全审核和 A-13 运营看板/审计，均明确主流程、状态、权限、异常、埋点、验收与实施门禁。普通用户 Windows/macOS 客户端未承诺立项，桌面运营使用 Nuxt 管理后台；未来新增原生能力允许正常升级 App。目标架构为共享核心平台 + 渐进迁移，客户端采用 KMP + Compose Multiplatform，App 1.0 发布 Android/iOS。客户端库基线已确定为 Jetpack KMP + Ktor + Room/DataStore + Coil，视频采用 Android Media3/iOS AVPlayer 平台适配；Android App 1.0 使用 `minSdk = 26`，不兼容 API 25 及以下；精确工具链版本仍需在创建最小工程时验证。当前没有创建 KMP 工程、目标 API、真人/会话数据表或实时消息能力。
- App 1.0 客户需求确认包已完成并升级为高保真交付：`docs/app/MEIGALLERY_APP_1_0_CLIENT_PRD.md` 汇总产品范围、细节交互、异常状态、后台流程、数据迁移、验收标准和 17 项客户确认参数；`docs/app/interactive-prototype/index.html` 提供 8 个可点击移动端/后台场景、业务规则和状态反馈；配套 7 组高保真截图及客户评审签字版 DOCX。原型是需求确认与交互演示资产，不是生产 App 实现代码；下一步应组织客户逐场景评审并关闭第 17 章参数。
- App 1.0 模块级技术方案已形成冻结候选：Epic 总架构明确模块化单体、领域所有权与阶段规模；KMP 设计明确 Feature/Core、单向状态、四 Tab 导航、本地同步和平台端口；Cloudflare 后端设计明确 Hono 模块、D1 事务/Outbox、Conversation Durable Object、Queues/Workflows 的提交点与恢复；后台设计明确 capability + scope、职责分离、强认证、审批和追加审计；契约冻结计划明确 OpenAPI/JSON Schema、DTO、状态机、D1 migration 和 Gate 顺序。当前仍未创建 KMP 工程、目标 API、D1 migration 或实时资源。
- App 进入实现前必须关闭正式品牌、首发地区、应用商店、运营主体、真人/年龄核验、内容审核、支付、Cloudflare 数据位置/跨境和中国大陆备案等开放决策；现有图库人物可以进入候选导入，但没有独立 App 用途授权、认证和发布审批时不得公开。

## 文档入口

- `AGENTS.md`：开发、分支和任务完成规范。
- `docs/TECHNICAL_SPEC.md`：API、Schema、权限与安全契约。
- `docs/DEPLOYMENT.md`：Cloudflare 资源和发布流程。
- `docs/GIT_WORKFLOW.md`：分支、PR、tag 和 commit 规范。
- `docs/AD_PLATFORM_ARCHITECTURE.md`：通用广告归因架构。
- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`：后台数据分析看板口径。
- `docs/TELEGRAM_IMPORT_API.md`：外部导入 API 契约。
- `docs/SEO_CONFIGURATION.md`：SEO 配置。
- `docs/app/README.md`：独立真人发现与互动 App 1.0 与共享业务平台的需求、KMP/CMP 客户端、迁移、UI、安全、商业化和路线图索引。
- `docs/app/MEIGALLERY_APP_1_0_CLIENT_PRD.md`：客户需求确认基线，含详细功能交互、7 组高保真原型图、验收和 17 项待确认参数。
- `docs/app/interactive-prototype/index.html`：App 1.0 高保真交互原型，覆盖 8 个移动端与后台场景。
- `docs/app/deliverables/MeiGallery_App_1.0_产品需求确认书.docx`：供客户评审、填写意见和签字确认的完整交付版。
- `docs/ways-of-work/plan/real-person-discovery-platform/README.md`：App 1.0 Feature PRD 索引、拆分顺序、依赖主链与详细验收入口。
- `docs/ways-of-work/plan/real-person-discovery-platform/arch.md`：App Epic 总体架构、领域边界、执行模型、技术价值、规模和实现出口。
- `docs/app/KMP_CLIENT_TECH_STACK.md`：Jetpack KMP、网络、图片、本地存储、视频播放、媒体缓存和平台 source set 边界。
- `docs/app/KMP_CLIENT_MODULE_DESIGN.md`：KMP 模块依赖、页面状态、Navigation 3、同步、实时恢复和平台端口。
- `docs/app/CLOUDFLARE_BACKEND_MODULE_DESIGN.md`：Hono 模块、D1 所有权、Outbox、DO/Queue/Workflow 和故障恢复。
- `docs/app/ADMIN_RBAC_AND_WORKFLOW_DESIGN.md`：后台 capability/scope、强认证、审批、职责分离、敏感读取和审计。
- `docs/app/API_DATA_CONTRACT_FREEZE_PLAN.md`：OpenAPI/JSON Schema、DTO、状态机、D1 migration、兼容和冻结 Gate。
- `docs/app/MOBILE_APP_INTERACTION_SPEC.md`：移动端 Screen ID、页面目录、关键旅程、低保真结构和页面级验收。
- `docs/app/ADMIN_CONSOLE_INTERACTION_SPEC.md`：Nuxt 后台 Page ID、角色、工作台、审批状态、并发、低保真结构和后台验收。
- `docs/app/UI_STATE_COPY_AND_ANALYTICS_CATALOG.md`：统一状态/文案/埋点 key、API 错误映射、危险操作和组件状态矩阵。
