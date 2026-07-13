# 项目当前状态

更新时间：2026-07-13

本文是当前实现、部署和文档入口索引。若旧提交、历史计划或早期文档与本文冲突，以 `AGENTS.md`、本文、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md` 和 `docs/GIT_WORKFLOW.md` 为准。

## 文档边界

- 已清理历史 PRD、旧计划、旧评审台账、旧线框图和过期 Superpowers 方案，避免后续开发继续引用历史口径。
- 当前保留 `docs/superpowers/specs/2026-07-08-attribution-center-clean-design.md` 作为归因中心、后台 UI、测试矩阵和发布闸门的设计背景；当前实现事实以代码、`docs/TECHNICAL_SPEC.md` 和本文为准。
- 当前保留 `docs/superpowers/specs/2026-07-08-meta-capi-attribution-layer-design.md` 作为 Meta Pixel / CAPI、转化事件账本和去重层的历史技术输入；核心架构已实现，当前生产放行口径由 Meta CAPI v2 三阶段计划和本状态文档覆盖。
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
- Queue：仅 production 绑定 `meigallery-meta-capi` / `meigallery-meta-capi-dlq`；dev 不配置 Meta Queue 或 Meta secret。
- 视频：Cloudflare Stream 仍未接入生产链路；相关字段和密钥按规划保留。
- 生产部署：通过 PR 合入 `main` 后手动执行 `./scripts/deploy.sh production`；脚本会强制重新运行完整 `verify:release` 并只断言本次新报告，之后才允许 migration 或 Worker deploy。
- CI：`.github/workflows/ci.yml` 只做 PR 和 dev 推送验证，不自动部署生产。
- 发布快速校验：`corepack pnpm verify:quick` 先执行 `dev-resource-isolation` 与 `meta-secret-leaks`，阻断 dev 误用生产资源及 tracked/release evidence 静态泄漏。

## 发布验证体系状态

- 2026-07-12 工具链基线：Node `24.13.0`、pnpm `10.34.4`、Wrangler `4.110.0`、Workers Types `5.20260712.1`、Miniflare `4.20260708.1`、Vitest `4.1.10`、Playwright `1.61.1`。TypeScript 保持 Nuxt 当前 peer 范围支持的最新 `6.0.3`，暂不采用尚未受支持的 TypeScript 7。

- 已提供四层命令：`verify:quick`、`verify:local-runtime`、`verify:dev-rehearsal`、`verify:release`。
- `verify:quick` 适合日常提交前自检，先检查 dev/production 资源隔离与 Meta secret 泄漏。
- `verify:local-runtime` 用于本地 Cloudflare 运行时验证 D1、Queue、归因和降级链路。
- `verify:dev-rehearsal` 依赖独立 dev D1/R2 和 dev Workers URL，只验证 migration、站内转化、注册、分析与页面逻辑，不调用 Meta。
- `verify:release` 是生产放行前最终校验；Meta 远端验证默认基于 production。`RELEASE_COMMIT` 仅用于发布追溯，普通业务发布不再使已验证的 Meta 连接失效。
- `scripts/deploy.sh production` 已在远端 migration 前接入 fresh production gate；旧 `latest.json` 不能跳过 lint、API/Web coverage、scripts、tsc、build、local-runtime 和 remote gates。部署路径只负责验证、preflight、migration 与 Worker 部署，不写 setting、不关闭 incident、不调整 rollout。

## 当前已实现能力

- 公开浏览：图库、标签、搜索、真实案例、首页广告位、右下角服务流程与联系方式入口。
- 用户体系：注册、登录、用户名登录、邮箱验证开关、用户中心、个人设置、会员状态展示。
- 后台管理：图库、媒体、标签、用户、会员发放、站点设置、联系方式、首页广告、真实案例、导入任务、审计日志。
- Telegram 外部导入 API：项目只提供对外 API 接收能力，不内置 Telegram Bot 本体；对接契约见 `docs/TELEGRAM_IMPORT_API.md`。
- 数据分析：已实现一方数据采集、来源归因、邀请码、联系点击、趋势和后台 `/admin/analytics` 系列看板；后台 UI 口径见 `docs/UI_DATA_ANALYTICS_DASHBOARD.md`。
- 归因中心：已实现站内转化账本、投放追踪链接、有效联系 / 完成注册活动趋势、历史 Lead 只读对照、Meta Pixel / CAPI 同步健康、重复诊断和分级发布检查；历史 Lead 与会员发放辅助指标均不参与活动漏斗、比率或链接排序，会员发放仅保留在 `operations` 辅助结构。后台分别展示 blocker 与 warning，warning 不改变生产阻断状态；入口为 `/admin/attribution`。
- 广告平台扩展内核：delivery 仅使用 `provider + transport + connection_revision`，Meta 通过 adapter registry 运行；前端仅消费通用 `trackingInstructions`，后台以统一平台连接为配置入口。旧 Meta 设置键、旧投递列和响应兼容字段已删除，新增 TikTok/Google 不再修改联系和注册事实逻辑。
- 2026-07-12 广告平台架构收口：本地 migration 实跑确认旧投递/outbox 清空、统一连接迁移成功、业务转化事实与连接验证/诊断保留；API `1064` 条测试、Web 测试、TypeScript、Lint 和 Nuxt production build 均通过，production 只读 duplicate preflight 为 `ready`。
- Meta CAPI v2：production Dataset Quality v1 契约已由 Owner 批准，真实 Meta `v25.0 /dataset_quality` capture 已验证；collector 与两事件 live evidence 均绑定唯一 production Dataset。正式域名 Browser 与 production CAPI 通过同组 opaque event ID 验证 `Contact`、`CompleteRegistration` 去重；连接有效性由 Pixel ID、Token 指纹、Graph API 版本和 revision 决定，commit 只作审计追溯。bootstrap 强制 rollout `0`，首次放量仍要求有效 production live evidence、资源隔离证据和无 critical incident。
- Meta Test Event 门禁按最新有效的 `post-deploy` V2 资源证据判定；更新的 bootstrap 发布记录不得遮挡仍在有效期内的 post-deploy 证据。
- Meta 连接验证为状态幂等操作：配置身份未变化时仍真实发送 Test Event，但复用现有 connection revision，不使已绑定的 Live Evidence 失效；仅 Pixel ID、token 指纹或 Graph API 版本变化时轮换 revision。
- SEO：已实现基础 SEO 设置、关键词池、sitemap、robots、结构化数据和生产校验脚本；运营配置见 `docs/SEO_CONFIGURATION.md`。

## 规划和未接入

- Cloudflare Stream 视频上传、编码、播放和受保护视频访问链路。
- 完整 zip 大文件上传、解压和异步导入处理。
- Meta Marketing API 广告花费、campaign、ad set、ad 数据导入暂不属于当前实现范围；当前只维护站内转化事实和 Pixel / CAPI 同步状态。

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
- `docs/codebase/*.md`：代码库结构、架构、集成、测试和风险分析。
- `docs/superpowers/specs/2026-07-08-attribution-center-clean-design.md`：归因中心、后台归因 UI、测试矩阵和发布闸门的设计背景。
- `docs/superpowers/specs/2026-07-10-meta-dataset-quality-contract.md`：Meta Dataset Quality 已批准契约。

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
