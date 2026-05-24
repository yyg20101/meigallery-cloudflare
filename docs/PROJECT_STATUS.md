# 项目当前状态

更新时间：2026-05-24

本文档是当前实现和部署状态的索引。若历史计划或早期 PRD 与本文冲突，以本文、`AGENTS.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/GIT_WORKFLOW.md` 为准。

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

- `AGENTS.md`、本文档、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/GIT_WORKFLOW.md` 为当前实现和部署状态文档。
- `docs/PRD*.md` 与 `docs/UI_DESIGN.md` 保留产品需求、路线图和设计约束，可能包含尚未接入的规划能力；遇到运行状态冲突时，以本文档和技术/部署文档为准。
- `docs/plans/**` 与 `docs/superpowers/**` 为历史计划、规格和实现记录，可能包含旧命名或已变更的路径，不代表当前生产状态。
