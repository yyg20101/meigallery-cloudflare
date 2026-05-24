# 代码库结构

## 1. 顶层结构

| 路径 | 用途 | 证据 |
|------|------|------|
| `packages/web/` | Nuxt Web Worker，包含前台页面、后台页面、SSR API 代理和前端组件 | `packages/web/package.json`、`packages/web/nuxt.config.ts` |
| `packages/api/` | Hono API Worker，包含公开 API、管理员 API、服务、工具、D1 migrations 和测试 | `packages/api/package.json`、`packages/api/src/index.ts` |
| `packages/shared/` | 前后端共享类型、常量和工具 | `packages/shared/package.json`、`packages/shared/src/types/index.ts` |
| `docs/` | 当前状态、产品、技术、部署、历史计划和代码库分析文档 | `docs/PROJECT_STATUS.md`、`docs/TECHNICAL_SPEC.md` |
| `scripts/` | Cloudflare 初始化、部署、WordPress 和 R2 迁移脚本 | `scripts/deploy.sh`、`scripts/setup.sh`、`scripts/migrate-cases-r2.mjs` |
| `.github/workflows/` | CI 验证流程 | `.github/workflows/ci.yml` |
| `pnpm-workspace.yaml` | workspace 包声明 | `pnpm-workspace.yaml` |

## 2. 入口点

- API Worker 主入口：`packages/api/src/index.ts`，由 `packages/api/wrangler.toml` 的 `main = "src/index.ts"` 选中。
- Web Worker 主入口：Nuxt build 输出 `.output/server/index.mjs`，由 `packages/web/wrangler.toml` 的 `main = ".output/server/index.mjs"` 选中。
- Web 源码入口：`packages/web/app/app.vue` 和 Nuxt 文件路由 `packages/web/app/pages/**`。
- SSR API 代理入口：`packages/web/server/api/[...].ts`，通过 Service Binding 或本地 HTTP 转发 API。
- 定时任务入口：`packages/api/src/index.ts` 默认导出对象中的 `scheduled` handler。
- 运维入口：`scripts/deploy.sh`、`scripts/setup.sh`、`scripts/migrate-media.mjs`、`scripts/migrate-wordpress.mjs`、`scripts/migrate-cases-r2.mjs`。

## 3. 模块边界

| 边界 | 应放内容 | 不应放内容 |
|------|----------|------------|
| `packages/api/src/routes/` | Hono 路由、请求校验、响应映射、权限入口 | 前端展示状态和 Vue 组件 |
| `packages/api/src/routes/admin/` | 需要 admin/owner 的后台 API | 无权限公开 API |
| `packages/api/src/services/` | Telegram、WordPress、邮件、媒体下载等外部流程编排 | 页面模板和组件状态 |
| `packages/api/src/utils/` | 可测试的纯工具、权限、session、导入校验、查询构造 | 直接渲染 UI |
| `packages/api/migrations/` | D1 schema 和种子迁移 | 运行时代码 |
| `packages/web/app/pages/` | Nuxt 页面路由 | 数据库访问和 Cloudflare binding 直连 |
| `packages/web/app/components/` | 可复用 Vue 组件 | API 权限判断的最终来源 |
| `packages/web/app/composables/` | 前端 API、认证、设置、Turnstile、Pixel 状态复用 | D1/R2 操作 |
| `packages/shared/src/` | 共享类型、常量、可复用纯函数 | 依赖 Worker 环境的逻辑 |

## 4. 命名和组织规则

- 文件命名：API 多数使用 kebab-case，例如 `telegram-file-id-import.ts`、`import-api-tokens.ts`；Vue 组件使用 PascalCase，例如 `GalleryCard.vue`、`ContactPanel.vue`。
- 目录组织：API 按层和功能混合组织，`routes/admin` 按后台资源拆分；Web 按 Nuxt 约定分为 `pages`、`components`、`layouts`、`middleware`、`composables`。
- 导入约定：API/Vitest 通过 alias 解析 `@meigallery/shared`、`@meigallery/shared/constants`、`@meigallery/shared/utils`；包内文件多用相对路径。
- 生成产物边界：`.output/`、`.wrangler/`、`.wrangler-web-dry-run/` 是构建/运行产物，不应作为源码模式依据。

## 5. 证据

- `packages/api/src/index.ts`
- `packages/api/src/routes/admin/index.ts`
- `packages/web/nuxt.config.ts`
- `packages/web/server/api/[...].ts`
- `packages/shared/src/constants/index.ts`
- `pnpm-workspace.yaml`
- `package.json`
- `rg --files` 输出
