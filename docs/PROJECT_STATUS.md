# 项目当前状态

更新时间：2026-07-15

本文是当前实现、部署和文档入口索引。若旧提交、历史计划或早期文档与本文冲突，以 `AGENTS.md`、本文、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md` 和 `docs/GIT_WORKFLOW.md` 为准。

## 文档边界

- 已清理历史 PRD、旧计划、旧评审台账、代码库镜像文档和已完成的 Superpowers 设计稿，避免重复口径污染后续开发。
- `docs/superpowers/specs/` 仅保留仍有效的正式契约和已确认、待实施的专项设计；实现事实以代码、`docs/TECHNICAL_SPEC.md` 和本文为准。
- 新需求进入实施时，应直接更新当前 PRD、技术规格、UI 设计或专项文档，不再恢复历史归档目录。

## 技术栈现状

- Monorepo：pnpm workspace，包为 `@meigallery/web`、`@meigallery/api`、`@meigallery/shared`。
- 前端：`packages/web` 使用 Nuxt 4、Nuxt UI、Tailwind CSS v4，Nitro preset 为 `cloudflare-module`。
- 后端：`packages/api` 使用 Hono，入口为 `packages/api/src/index.ts`，通过 Cloudflare Worker bindings 访问 D1、R2 等资源。
- 共享包：`packages/shared` 提供共享类型、会员 rank、标签类型、联系方式平台和用户名工具。
- 组件预览：当前未配置 Histoire。

## 运行时和部署

- 运行平台：仅使用 Cloudflare Workers + Workers Assets，不使用 Cloudflare Pages。
- 前端 Worker：`meigallery-web`，生产域名 `616618.xyz` / `www.616618.xyz`。
- API Worker：`meigallery-api`，生产域名 `api.616618.xyz`。
- 开发 Worker：`meigallery-web-dev` / `meigallery-api-dev`，不绑定生产域名；当前真实地址为 `https://meigallery-web-dev.wajie.workers.dev` / `https://meigallery-api-dev.wajie.workers.dev`。
- 数据库：生产为 Cloudflare D1 `meigallery-db`，开发环境已隔离到 `meigallery-db-dev`；迁移文件位于 `packages/api/migrations/`。
- 对象存储：生产为 Cloudflare R2 `meigallery-media`，开发环境已隔离到 `meigallery-media-dev`。
- Queue：最终 production 配置 Meta/TikTok/Google 三组 `meigallery-ad-*` 主 Queue/DLQ；dev 不绑定广告平台 Queue 或凭证。旧 `meigallery-meta-capi*` / `meigallery-tiktok-events*` 在 Contract 前仅作为旧 Worker 回滚资产保留。
- 视频：Cloudflare Stream 仍未接入生产链路；相关字段和密钥按规划保留。
- 生产部署：通过 PR 合入 `main` 后手动执行 `./scripts/deploy.sh production`；完整验证由 release PR/CI 完成，部署脚本只运行一次 `verify:quick` 和远端切换门禁。`0051` 首次待应用时自动执行 preflight、仓库外 D1 备份、Expand、API/Web、回填、对账和 smoke；普通后续发布不重复历史切换。
- CI：`.github/workflows/ci.yml` 只做 PR 和 dev 推送验证，不自动部署生产。
- 发布快速校验：`corepack pnpm verify:quick` 先执行 `dev-resource-isolation` 与 `meta-secret-leaks`，阻断 dev 误用生产资源及 tracked/release evidence 静态泄漏。

## 发布验证体系状态

- 2026-07-12 工具链基线：Node `24.13.0`、pnpm `10.34.4`、Wrangler `4.110.0`、Workers Types `5.20260712.1`、Miniflare `4.20260708.1`、Vitest `4.1.10`、Playwright `1.61.1`。TypeScript 保持 Nuxt 当前 peer 范围支持的最新 `6.0.3`，暂不采用尚未受支持的 TypeScript 7。

- 已提供四层命令：`verify:quick`、`verify:local-runtime`、`verify:dev-rehearsal`、`verify:release`。
- `verify:quick` 适合日常提交前自检，先检查 dev/production 资源隔离与 Meta secret 泄漏。
- `verify:local-runtime` 用于本地 Cloudflare 运行时验证 D1、Queue、归因和降级链路。
- `verify:dev-rehearsal` 依赖独立 dev D1/R2 和 dev Workers URL，只验证 migration、站内转化、注册、分析与页面逻辑，不调用 Meta。
- `verify:release` 是生产放行前最终校验；Meta 远端验证默认基于 production。`RELEASE_COMMIT` 仅用于发布追溯，普通业务发布不再使已验证的 Meta 连接失效。
- `scripts/deploy.sh production` 只从干净 `main` 执行；完整测试在 release PR/CI 完成，部署时不重复整套 release gate。一次性 cutover 负责 preflight、备份、Expand、部署、回填、对账和 smoke，且不写平台设置、不关闭 incident、不调整 rollout。

## 当前已实现能力

- 公开浏览：图库、标签、搜索、真实案例、首页广告位、右下角服务流程与联系方式入口。
- 用户体系：注册、登录、用户名登录、邮箱验证开关、用户中心、个人设置、会员状态展示。
- 后台管理：图库、媒体、标签、用户、会员发放、站点设置、联系方式、首页广告、真实案例、导入任务、审计日志。
- Telegram 外部导入 API：项目只提供对外 API 接收能力，不内置 Telegram Bot 本体；对接契约见 `docs/TELEGRAM_IMPORT_API.md`。
- 数据分析：已实现一方数据采集、来源归因、邀请码、联系点击、趋势和后台 `/admin/analytics` 系列看板；后台 UI 口径见 `docs/UI_DATA_ANALYTICS_DASHBOARD.md`。
- 归因中心：已重构为 `总览 / 转化明细 / 投放链接 / 平台接入 / 发布与诊断` 五页工作台，共用平台能力注册表与 URL `provider` 上下文。转化明细、链接、趋势、campaign、匹配质量和重复诊断均按 Meta / TikTok 严格隔离；连接验证只在平台接入处理，Meta 受控放量与 incident 只在发布与诊断处理。历史 Lead 不进入平台活动明细、漏斗、比率或排序；warning 不改变生产阻断状态。旧 `Meta 运维` 页面及重复 UI 已删除。
- 广告平台扩展内核：delivery 仅使用 `provider + transport + connection_revision`，Meta 与 TikTok 通过 adapter registry 运行；前端仅消费通用 `trackingInstructions`，后台以统一平台连接为配置入口。旧 Meta 设置键、旧投递列和响应兼容字段已删除，新增平台不再修改联系和注册事实逻辑。
- TikTok Pixel / Events API：`0048` 初始化默认关闭的连接，`0049` 增加 TikTok 匹配字段、production 连接验证和通用加密 outbox。Browser 已接入 PageView、ViewContent、Search、Contact、CompleteRegistration；Server 使用 Events API v1.3、独立 token/data key、Queue/DLQ、lease、重试与 rollout。Contact / CompleteRegistration 的 Browser/Server 共用平台 event ID；Test Event Code 仅存在于 Owner 单次验证请求。生产仍默认关闭，待 production Pixel ID、secret、Queue 和 TikTok Test Events 人工验证后再放量。
- 2026-07-15 通用广告归因平台设计 v2：设计讨论和书面评审均已确认。Meta、TikTok、Google Ads 将一次性迁入最终通用 Schema 和 Adapter 运行时，不保留 Meta 兼容层、双读、双写或平台 fallback；Google 使用原生 Google Tag 与 Data Manager API，GA4 不属于本期。Cloudflare 采用 Free-first 的 D1 + Queues + Workflows + Web Crypto 组合，Workflows 只处理幂等连接验证和长时间诊断，实时转化仍走平台 Queue；三平台合计服务端转化安全线为 2,000 条/天。可执行实施计划已重写为 14 个任务，覆盖 Expand、三平台迁移、生产回填、Contract 和旧资源清理。
- 2026-07-15 三平台归因本地发布门禁：最终 11 张 attribution 表、Queue/Workflow mock、dev 真实平台网络禁用和 Meta/TikTok/Google 桌面与移动端来源隔离均已接入 `verify:local-runtime`。冲突来源与无来源只保留站内事实，Browser Contact/Registration 仅允许命中当前归因平台；Shared `5` 项、API `1119` 项、Web `282` 项、scripts/migration `298` 项、Playwright `35` 项、Lint、全仓 TypeScript、API TypeScript、Nuxt production build 和本地发布门禁全部通过。本阶段未访问真实平台 API，未修改 production 配置、数据或放量；生产回填、远端对账和切换属于后续 Task 13。
- 2026-07-15 通用归因 production 切换工具：新增固定 production 快照、幂等事实回填、双采样 Queue preflight、仓库外 D1 export/Time Travel manifest 和只读对账。部署编排去除重复 `verify:release`、重复 API 测试和重复 Web build；裸 remote migration 命令已禁用。6 条新 Queue 已创建、均无积压且尚未绑定新 Worker；初始化脚本已对 Cloudflare Queue 创建后的最终一致性增加重试。32 字节通用主密钥已备份到本机登录钥匙串并写入 production Secret，API/Web 仍保持原 production commit 且健康检查通过。最终三平台查询已从旧 Meta 运维路由拆出，转化 SQL 统一进入 `attribution-dashboard` 服务；API `1144/1144`、整体 coverage statements `87.35%` / branches `80.78%`、通用后台路由 statements `95.67%` / branches `91.04%` 均通过。当前真实 production 只读 preflight 仅阻断于旧 Meta Server 仍有效，因此尚未应用 `0051`、未部署新运行时、未修改 rollout 或发送平台事件。
- 2026-07-14 后台归因工作台重构：归因后台收口为 `总览 / 转化明细 / 投放链接 / 平台接入 / 发布与诊断` 五页，共用平台注册表和 URL `provider` 上下文；Meta 与 TikTok 的转化、链接、趋势、质量、重复诊断、连接和发布门禁全程隔离。后台入口统一为“广告归因”，旧 `Meta 运维` 页面已删除，连接验证不再与总览、发布控制重复。API `1156` 项、Web `277` 项、归因 Playwright 五视口 `15` 项、Lint、API TypeScript 和 Nuxt production build 全部通过；未修改 production 配置、数据、Meta rollout 或 TikTok 开关。
- 2026-07-14 Telegram 联系短链调整：`t.me` 当日进入 `serverHold` 并停止全球 DNS 解析后，系统生成的 Telegram 用户名链接改用 `https://telegram.me/<username>`。Owner 手动填写的完整链接按输入域名、路径和参数原样保存并返回，不做 `t.me` / `telegram.me` 相互替换；Web 单测仅阻止锚点真实导航，不再产生外网 DNS 噪声。API `1158` 项、Web `278` 项全部通过；归因后台重构后的部署文档 CI 契约已同步至 `/admin/attribution/platforms?provider=meta`；无 migration、无生产配置变更。
- 2026-07-14 v0.3.2 正式发布：归因转化 API 强制平台隔离后，local-runtime 与 dev-rehearsal smoke 均显式使用 `provider=meta`，并通过真实营销授权与 `/api/ad-attribution` 签发 Meta 来源 receipt，再创建联系和注册事实；测试替身同时拒绝缺少平台或 receipt 的旧调用。Meta 人工去重确认在连接身份与 Dataset Quality 契约未变化时统一按 30 天复用。production D1 无待执行 migration，API/Web 已部署 commit `63e137ccb7d594c8a3cdda8c1c6f1b6adc8a6cd5`，版本分别为 `aaa67941-4065-459d-9b96-627e95bb4526` / `ae1e0205-033f-4b78-8831-3abd11cf846c`；API health、两个生产域名和 SEO 校验通过。Meta 保持 production rollout `10%`、连接有效、无 critical incident 与 pending/retrying 积压，TikTok 保持 disabled / rollout `0%`。
- 2026-07-14 Meta live 时效口径收口：live challenge 保持严格 24 小时完成窗口，完成后的人工去重确认改为在连接 revision 未变化、未失效且 Dataset Quality 契约一致时复用 30 天；普通业务 commit 不再因每日证据 TTL 重复要求人工确认。后台 readiness、rollout 与 CLI release gate 使用同一条件，连接重新验证或身份变化仍立即阻断。
- 2026-07-14 Meta Test Event Code 清理：删除 `META_CAPI_TEST_EVENT_CODE` 的 Worker binding、配置说明、连接状态、readiness、资源证明和发布摘要依赖；Meta Test Event Code 仅由 Owner 在验证请求中临时提交，正式 `Contact` / `CompleteRegistration` payload 禁止携带。资源 attestation 升级为 V2，Meta 资源摘要升级为 V3，旧摘要不能通过新门禁。API `1156` 项、Web `275` 项、scripts/migration `281` 项、Lint、API TypeScript、Nuxt production build 与 secret scan 全部通过。`v0.3.1` 已通过 PR #46 发布到 production，API/Web release identity 为 `5053e827eeea3fffdc9ccaac47abe9c587957baa`；旧 production Secret 已删除，删除后的 V3 full 资源检查通过。Meta 保持 production rollout `10%`、连接有效且无 open critical incident，TikTok 保持 disabled / rollout `0`。
- 2026-07-14 Meta 收尾与 TikTok 接入准备：production Meta 只读核验确认连接有效、无 open incident、无 Server pending/retry 积压，继续保持 10% rollout；唯一近期 `attempted` 为 Browser Pixel 记录。TikTok 重复验证会按当次 Test Event Code 重新发送 `Contact` 与 `CompleteRegistration`，但保持已验证 revision 幂等；每次发送写脱敏审计，测试码不落库。归因后台按选中平台隔离配置和发布控制，TikTok 独立展示 token、Queue、数据密钥、连接、Browser/Server 与 rollout 检查。API `1156` 项、Web `275` 项、scripts/migration `273` 项及 Playwright 五视口 `15` 项已通过。当时尚未补齐的 TikTok Queue 和 `0048–0050` migration 已在同日 v0.3.2 发布中完成；TikTok token/data key 未配置且平台保持 disabled / rollout `0%`。
- 2026-07-14 广告来源严格隔离：新增 `0050_strict_ad_source_routing.sql`、服务端签名来源 receipt 和后台广告平台必选项。Meta click ID/投放链接只创建 Meta Pixel/CAPI delivery，TikTok 来源只创建 TikTok Pixel/Events API delivery；冲突、未知、过期、校验失败或无来源均为零广告投递，只保留站内事实。浏览器来源校验串行执行并使旧响应失效，平台切换会先卸载旧 Pixel。D1 对已明确归因事实实施同平台写入约束，历史未绑定平台的广告链接自动停用且不做名称猜测。归因看板按 provider 读取事实并显示不一致/未路由数量。API `1156` 项、Web `274` 项、`0050` 真实 D1 `6` 项、`0001–0050` 发布演练 `61` 项、Lint、API TypeScript、API Worker dry-run 与 Nuxt production build 已通过；未修改 production 资源、配置、数据或 Meta rollout。
- 2026-07-13 广告平台安全迁移收口：`0049` 改为 expand 迁移，保留旧 Meta 用户标识与加密 outbox，并仅由八个数据库 trigger 在发布/回滚窗口双向桥接；应用代码仍只使用通用结构。production 部署与远端 migration 包命令均新增四条 Queue 的 migration 前只读门禁，Queue 缺失时不执行 D1 migration 或 Worker deploy；contract 清理推迟到独立后续版本。历史库、空库与递归 trigger 真实 D1 演练通过，API `1125` 项、Web `261` 项、scripts/migration `261` 项、Lint、API TypeScript、API Worker dry-run、Nuxt production build 与 secret scan 全部通过。未修改 production 资源、D1、配置或 Meta rollout。
- 2026-07-13 TikTok Events API 本地实现：完成官方 payload/header 契约、连接指纹验证、凭证失效、加密临时匹配上下文、Queue/DLQ 恢复、注册/联系身份口径、后台统一配置与 Meta/TikTok 数据切换。真实 D1 已验证 provider 隔离、`fbp/fbc` 与 `_ttp/ttclid` 覆盖、旧 outbox 迁移和空库 0001-0049 全链；API `1125` 项及高阈值 coverage、Web `261` 项、scripts/migration `253` 项、Lint、TypeScript、Nuxt production build、API Worker dry-run 均通过。生产资源、配置和开关均未修改。
- 2026-07-13 广告平台开发前瘦身：移除 19 个未使用的 Tiptap 直接依赖、代码库镜像和已完成历史设计稿；共享类型、连接状态、Browser adapter 与 Meta/TikTok 投递统一改由广告平台 registry 驱动，平台连接路由从归因大文件独立。未新增 migration、未修改生产数据或 Meta 事件 ID 协议。API `1077`、Web `259`、Playwright 五视口 `125` 项、scripts/migration、Lint、TypeScript、Nuxt production build、secret scan 与 `verify:quick` 均通过。
- 2026-07-13 TikTok 官方文档复核与本地验收：按当前标准事件、参数、Test Events、Diagnostics 和 Pixel Helper 说明复核实现；修复仅配置 TikTok 时营销模式仍错误读取 Meta 的问题。API `1070`、Web `257`、Playwright 五视口 `125` 项、Lint、TypeScript 和 Nuxt production build 均通过；浏览器测试确认授权后才向 TikTok CDN 发起请求、脚本位于 `head`、首次 PageView 只入队一次，进入后台后卸载。
- 2026-07-12 广告平台架构收口：本地 migration 实跑确认旧投递/outbox 清空、统一连接迁移成功、业务转化事实与连接验证/诊断保留；API `1064` 条测试、Web 测试、TypeScript、Lint 和 Nuxt production build 均通过，production 只读 duplicate preflight 为 `ready`。
- Meta CAPI v2：production Dataset Quality v1 契约已由 Owner 批准，真实 Meta `v25.0 /dataset_quality` capture 已验证；collector 与两事件 live evidence 均绑定唯一 production Dataset。正式域名 Browser 与 production CAPI 通过同组 opaque event ID 验证 `Contact`、`CompleteRegistration` 去重；连接有效性由 Pixel ID、Token 指纹、Graph API 版本和 revision 决定，commit 只作审计追溯。bootstrap 强制 rollout `0`，首次放量仍要求有效 production live evidence、资源隔离证据和无 critical incident。
- Meta Test Event 门禁按最新有效的 `post-deploy` V3 资源摘要判定；摘要引用资源 attestation V2，更新的 bootstrap 发布记录不得遮挡仍在有效期内的 post-deploy 证据。
- Meta 连接验证为状态幂等操作：配置身份未变化时仍真实发送 Test Event，但复用现有 connection revision，不使已绑定的 Live Evidence 失效；仅 Pixel ID、token 指纹或 Graph API 版本变化时轮换 revision。
- Meta Test Event Code 已改为 Owner 页面内存中的请求级会话值，验证连接与 Live Evidence 共用当前 `TEST...` 代码；服务端不从长期 secret 读取 payload 代码，也不将该值写入 D1、审计或响应，避免 Meta 换码后服务器事件进入旧 Test Events 会话。
- Meta live 录入命令在人工确认通过后同时写入本地脱敏报告与 production D1 门禁摘要，并将 D1 无时区时间按 UTC 规范化；失败仍销毁一次性 challenge，避免残留记录被后续误用。
- SEO：已实现基础 SEO 设置、关键词池、sitemap、robots、结构化数据和生产校验脚本；运营配置见 `docs/SEO_CONFIGURATION.md`。

## 规划和未接入

- Cloudflare Stream 视频上传、编码、播放和受保护视频访问链路。
- 完整 zip 大文件上传、解压和异步导入处理。
- Meta / TikTok 广告花费、campaign、ad set、ad 数据导入暂不属于当前实现范围；当前只维护站内转化事实和 Pixel / Server API 同步状态。

## 当前文档入口

- `AGENTS.md`：项目开发指南、分支策略、部署流程和任务完成要求。
- `docs/PRD.md`：产品需求、边界和验收口径。
- `docs/TECHNICAL_SPEC.md`：API、数据模型、权限、安全和迁移设计。
- `docs/DEPLOYMENT.md`：Cloudflare 部署、环境变量和生产发布说明。
- `docs/GIT_WORKFLOW.md`：分支、PR、tag 和发布规范。
- `docs/UI_DESIGN.md`：全站 UI 设计约束。
- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`：后台数据分析看板设计。
- `docs/TELEGRAM_IMPORT_API.md`：Telegram 外部导入 API 对接契约。
- `docs/SEO_CONFIGURATION.md`：SEO 关键词和运营配置说明。
- `docs/META_PRODUCTION_ROLLOUT_PLAN.md`：Meta production 证据、发布、放量和同步确认计划。
- `docs/AD_PLATFORM_ARCHITECTURE.md`：Meta、TikTok、Google 等 Pixel/API 的统一事实、投递和 adapter 架构。
- `docs/superpowers/specs/2026-07-10-meta-dataset-quality-contract.md`：Meta Dataset Quality 已批准契约。
- `docs/superpowers/specs/2026-07-15-unified-ad-attribution-platform-design.md`：Meta/TikTok/Google Ads 三平台一次性通用化、Cloudflare Free 架构、加密凭证、严格来源隔离与生产切换设计。

## Git 状态

- `main`：生产分支，必须通过 PR 合入，禁止直接推送。
- `dev`：开发主线，日常开发在此汇总；非关键、非关联或阶段性提交默认先保留本地，功能闭环、需要 CI/协作或准备部署时再统一推送到 `origin/dev`。
- `feature/*`、`fix/*`：只保留必要工作分支，完成合并后及时删除。

## 当前命名

- 真实案例统一使用 `cases` / `case_images`。
- 公开路由为 `/cases`、`/cases/:slug`。
- 公开 API 为 `/api/cases`、`/api/cases/:slug`、`/api/cases/images/:imageId`。
- 后台路由为 `/admin/cases`。
- 旧 `testimonial_*` 仅作为历史迁移背景，不参与当前读取。
