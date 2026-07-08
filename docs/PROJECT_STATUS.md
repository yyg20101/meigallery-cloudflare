# 项目当前状态

更新时间：2026-07-08

本文是当前实现、部署和文档入口索引。若旧提交、历史计划或早期文档与本文冲突，以 `AGENTS.md`、本文、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md` 和 `docs/GIT_WORKFLOW.md` 为准。

## 文档边界

- 已清理历史 PRD、旧计划、旧评审台账、旧线框图和过期 Superpowers 方案，避免后续开发继续引用历史口径。
- 当前保留 `docs/superpowers/specs/2026-07-08-meta-capi-attribution-layer-design.md` 作为 Meta 归因与转化事件账本的下一阶段设计输入；该设计尚未实施。
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
- 开发 Worker：`meigallery-web-dev` / `meigallery-api-dev`，不绑定生产域名。
- 数据库：Cloudflare D1 `meigallery-db`；迁移文件位于 `packages/api/migrations/`。
- 对象存储：Cloudflare R2 `meigallery-media`。
- 视频：Cloudflare Stream 仍未接入生产链路；相关字段和密钥按规划保留。
- 生产部署：通过 PR 合入 `main` 后手动执行 `./scripts/deploy.sh production` 或等价 wrangler 命令。
- CI：`.github/workflows/ci.yml` 只做 PR 和 dev 推送验证，不自动部署生产。

## 当前已实现能力

- 公开浏览：图库、标签、搜索、真实案例、首页广告位、右下角服务流程与联系方式入口。
- 用户体系：注册、登录、用户名登录、邮箱验证开关、用户中心、个人设置、会员状态展示。
- 后台管理：图库、媒体、标签、用户、会员发放、站点设置、联系方式、首页广告、真实案例、导入任务、审计日志。
- Telegram 外部导入 API：项目只提供对外 API 接收能力，不内置 Telegram Bot 本体；对接契约见 `docs/TELEGRAM_IMPORT_API.md`。
- 数据分析：已实现一方数据采集、来源归因、邀请码、联系点击、趋势和后台 `/admin/analytics` 系列看板；后台 UI 口径见 `docs/UI_DATA_ANALYTICS_DASHBOARD.md`。
- Meta Pixel：已实现浏览器侧 Pixel 设置、标准事件和站内数据分析口径区分；数据分析中的 `fb` / `facebook` / `meta` 表示站内 UTM、推广链接或 referrer 归因，不等同于 Meta Pixel 回传数据。
- SEO：已实现基础 SEO 设置、关键词池、sitemap、robots、结构化数据和生产校验脚本；运营配置见 `docs/SEO_CONFIGURATION.md`。

## 规划和未接入

- Cloudflare Stream 视频上传、编码、播放和受保护视频访问链路。
- 完整 zip 大文件上传、解压和异步导入处理。
- Meta Conversions API 服务端回传、去重层和站内转化事件账本，按当前 Meta 归因设计单独实施。
- Meta Marketing API 广告花费、campaign、ad set、ad 数据导入暂不属于当前实现范围。

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
- `docs/codebase/*.md`：代码库结构、架构、集成、测试和风险分析。
- `docs/superpowers/specs/2026-07-08-meta-capi-attribution-layer-design.md`：Meta 归因与转化事件账本下一阶段设计。

## Git 状态

- `main`：生产分支，必须通过 PR 合入，禁止直接推送。
- `dev`：开发主线，日常变更先推送到 `origin/dev`。
- `feature/*`、`fix/*`：只保留必要工作分支，完成合并后及时删除。

## 当前命名

- 真实案例统一使用 `cases` / `case_images`。
- 公开路由为 `/cases`、`/cases/:slug`。
- 公开 API 为 `/api/cases`、`/api/cases/:slug`、`/api/cases/images/:imageId`。
- 后台路由为 `/admin/cases`。
- 旧 `testimonial_*` 仅作为历史迁移背景，不参与当前读取。
