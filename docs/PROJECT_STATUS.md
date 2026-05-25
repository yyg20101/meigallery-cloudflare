# 项目当前状态

更新时间：2026-05-26

本文档是当前实现和部署状态的索引。若历史计划或早期 PRD 与本文冲突，以本文、`AGENTS.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/GIT_WORKFLOW.md` 为准。

## 技术栈现状

- Monorepo：pnpm workspace，包为 `@meigallery/web`、`@meigallery/api`、`@meigallery/shared`。
- 前端：`packages/web` 当前依赖 `nuxt@4.4.4`、`@nuxt/ui@4.7.1`、`tailwindcss@4.2.4`，Nitro preset 为 `cloudflare-module`。
- 后端：`packages/api` 使用 Hono，入口为 `packages/api/src/index.ts`，通过 Cloudflare Worker bindings 访问 D1/R2/Email。
- 共享包：`packages/shared` 提供共享类型、会员 rank、标签类型、联系方式平台和用户名工具。
- 组件预览：仓库当前没有 Histoire 依赖或配置；历史文档中的 Histoire 是规划项。

## 运行时和部署

- 运行平台：仅使用 Cloudflare Workers + Workers Assets，不使用 Cloudflare Pages。
- 前端 Worker：`meigallery-web`，生产域名 `616618.xyz` / `www.616618.xyz`。
- API Worker：`meigallery-api`，生产域名 `api.616618.xyz`。
- 开发 Worker：`meigallery-web-dev` / `meigallery-api-dev`，仅使用 Workers dev 子域，不绑定生产域名。
- 数据库：Cloudflare D1 `meigallery-db`。
- D1 migrations：仓库当前维护到 `0019_seed_member_activity.sql`；部署前需按目标环境执行所有未应用迁移。
- 对象存储：Cloudflare R2 `meigallery-media`。
- 视频：Cloudflare Stream 仍未接入，相关 secrets 为占位符，视频能力按规划保留。
- 生产部署：PR 合入 `main` 后手动执行 `./scripts/deploy.sh production` 或等价 wrangler 命令。
- CI：`.github/workflows/ci.yml` 只做 PR/dev 推送的测试、类型检查和构建验证，不自动部署生产。

## 功能实现现状

- 已实现：公开图库/标签/搜索/真实案例、登录注册、用户名登录、邮箱验证开关、用户中心、个人设置、后台图库/标签/用户/设置/审计、图库批量操作、图片上传、封面设置、单媒体 rank 配置、WordPress 迁移辅助、Telegram `gallery` / `case` 外部导入、Facebook Pixel 设置。
- 部分实现：zip 导入任务有 API 和后台入口，但当前重点实现和测试集中在解析/校验与任务记录；大文件异步完整处理仍需按后续阶段继续收敛。
- 未接入：Cloudflare Stream 生产视频上传、编码和播放链路；相关字段、secret、媒体签名逻辑保留为规划能力。
- 已完成迁移口径：真实案例当前统一为 `cases` / `case_images`、`/cases`、`/api/cases`、`case:create`；旧 `testimonial_*` 仅存在于历史文档、迁移脚本说明或兼容拒绝测试中。

## PRD 质量状态

- 当前 PRD 质量审阅和整改索引见 `docs/PRD_QUALITY_REVIEW.md`。
- 当前可验收能力、部分实现能力和规划能力必须按 `docs/PRD_QUALITY_REVIEW.md` 的需求状态矩阵区分，不得把历史 PRD 中的规划项当作上线阻断项。
- Cloudflare Stream、Email Service、zip 大文件异步导入、旧站内容审核状态机属于需要单独补齐验收标准的重点区域。
- 后续新增或修改 PRD 时，必须为成功指标补充测试环境、数据规模、采样方法和失败路径。

## UI 质量状态

- 当前 UI 质量审阅和页面/组件验收清单见 `docs/UI_QUALITY_REVIEW.md`。
- `docs/UI_DESIGN.md` 已补充页面级完成定义、组件状态矩阵、响应式验收和可访问性检查方法。
- Stream 接入前，视频入口、视频专区、视频角标和播放器均按规划能力处理，不作为当前上线阻断项。
- 线框图留存规则见 `docs/ui/wireframes/README.md`，后续关键线框图需导出到该目录或以截图、PDF、HTML 快照形式保存。

## 代码质量整改状态

- 当前整改执行计划见 `plan/process-code-review-remediation-1.md`。
- `P1-01 Web 类型检查失败且 CI 未覆盖` 已完成：shared 不再暴露 Worker binding 类型给 Web，前端严格类型错误已修复，CI 已新增 Web typecheck。
- `P1-02 生产速率限制与文档承诺不一致` 已完成：API 内置兜底限流已对齐常量和技术文档，部署文档已补生产 Cloudflare WAF / Rate Limiting Rules 配置口径。
- `corepack pnpm --filter @meigallery/web typecheck` 当前通过，但仍打印 `vue-router/volar/sfc-route-blocks` package export 非阻断警告，后续依赖升级阶段继续跟踪。
- 下一批 P1 待处理项为密码哈希策略一致性。

## Git 状态

- `main`：生产分支，必须通过 PR 合入，禁止直接推送。
- `dev`：开发主线，当前变更先推送到 `origin/dev`。
- 合入生产：从 `dev` 创建 PR 到 `main`，验证通过后合并。

## 真实案例命名和路径

- 当前业务命名：`cases` / `case_images`。
- 当前公开路由：`/cases`、`/cases/:slug`。
- 当前公开 API：`/api/cases`、`/api/cases/:slug`、`/api/cases/images/:imageId`。
- 当前后台路由：`/admin/cases`。
- 当前 R2 key：`cases/{caseId}/{imageId}.{ext}`。
- 旧 `testimonial_*` 表已迁移并删除；旧 `testimonials/` R2 对象可以作为回滚备份保留，不参与当前读取。

## 文档说明

- 当前状态权威文档：`AGENTS.md`、本文档、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/GIT_WORKFLOW.md`。
- 产品和设计文档：`docs/PRD*.md`、`docs/PRD_QUALITY_REVIEW.md` 与 `docs/UI_DESIGN.md` 保留产品需求、路线图、验收口径和设计约束；其中标注为草案、规划或后续阶段的内容不代表当前生产状态。
- 代码与文档 review 问题台账：`docs/CODE_AND_DOC_REVIEW_ISSUES.md` 记录全项目代码、配置和文档审查发现的问题、影响和修复方案。
- 代码库分析文档：`docs/codebase/*.md` 记录从代码和配置验证出的栈、结构、架构、约定、集成、测试和风险。
- 历史归档：`docs/plans/**` 与 `docs/superpowers/**` 为历史计划、规格和实现记录，可能包含 Nuxt 3、`testimonial_*`、旧路由或旧权限名，不代表当前生产状态。
