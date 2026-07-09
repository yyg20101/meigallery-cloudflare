# 架构

## 1. 架构风格

- 主要风格：前后端分离的 Cloudflare Workers monorepo，API 侧为轻量分层架构，Web 侧为 Nuxt 文件路由架构。
- 分类依据：`packages/web` 与 `packages/api` 各自有独立 `wrangler.toml` 和部署目标；API 入口在 `packages/api/src/index.ts` 挂载公开路由、后台路由、中间件和定时任务；Web 使用 Nuxt `pages`、`components`、`composables`。
- 主要约束：Cloudflare 是唯一运行平台；受保护媒体必须服务端鉴权；生产部署只通过手动 Wrangler 流程。

## 2. 系统流程

```text
浏览器 / Nuxt SSR
  -> Web composable 或 SSR API 代理
  -> Hono API Worker
  -> auth/rate-limit/cache middleware
  -> route/service/utils
  -> D1/R2/Email/Telegram/Stream
  -> JSON 或媒体响应
```

典型请求流程：

1. 前端通过 `useApi()` 或 SSR 相对 `/api/...` 请求 API；SSR 环境由 `packages/web/server/api/[...].ts` 使用 `API_SERVICE` Service Binding 转发。
2. API Worker 在 `packages/api/src/index.ts` 先应用 logger、secure headers、CORS、noindex、速率限制和 `authMiddleware`。
3. 公开路由如 `/api/galleries`、`/api/cases`、`/api/media` 在入口文件直接挂载；后台路由统一挂载到 `/api/admin`。
4. `packages/api/src/routes/admin/index.ts` 对所有后台路由应用 `requireAdmin`，再分发到图库、标签、用户、设置、案例等子路由。
5. 路由使用 D1 prepared statement、R2 bucket、Email binding 或服务函数完成业务操作，并通过 `writeAuditLog` 记录后台修改。
6. 受保护媒体由 `packages/api/src/routes/media.ts` 校验 session 和会员 rank 后返回内容或签名访问结果。

## 3. 层和模块职责

| 层或模块 | 负责 | 不负责 | 证据 |
|----------|------|--------|------|
| Web pages/layouts | 前台和后台页面结构、响应式展示、路由视图 | 最终权限判断和 D1/R2 访问 | `packages/web/app/pages/**`、`packages/web/app/layouts/**` |
| Web composables | API 调用、认证状态、站点设置、Pixel、Turnstile 状态 | 后端业务规则 | `packages/web/app/composables/useApi.ts`、`packages/web/app/composables/useAuth.ts` |
| SSR API proxy | SSR 时桥接 Web Worker 到 API Worker | 业务决策 | `packages/web/server/api/[...].ts` |
| API entry/middleware | 全局安全头、CORS、速率限制、认证上下文、路由挂载 | 页面渲染 | `packages/api/src/index.ts` |
| Public API routes | 公开图库、标签、搜索、真实案例、媒体访问 | 后台管理操作 | `packages/api/src/routes/galleries.ts`、`packages/api/src/routes/cases.ts` |
| Admin API routes | 管理员 CRUD、批量操作、设置、审计、导入 | 无鉴权公开读取 | `packages/api/src/routes/admin/index.ts` |
| Services | 外部导入、WordPress、Telegram、Email、媒体下载编排 | HTTP 路由挂载 | `packages/api/src/services/telegram-file-id-import.ts`、`packages/api/src/services/email.ts` |
| Utils/shared | 纯校验、权限、session、导入 token、常量和共享类型 | 直接依赖 Vue 组件 | `packages/api/src/utils/**`、`packages/shared/src/**` |

## 4. 复用模式

| 模式 | 位置 | 目的 |
|------|------|------|
| Hono 子路由聚合 | `packages/api/src/index.ts`、`packages/api/src/routes/admin/index.ts` | 分离公开和后台 API，集中应用权限中间件 |
| Worker binding 适配 | `packages/api/wrangler.toml`、`packages/web/server/api/[...].ts` | 将 D1/R2/Email/API Service Binding 注入运行时 |
| D1 prepared statements | 多数 `packages/api/src/routes/**/*.ts` | 参数绑定，减少 SQL 注入风险 |
| 审计日志 helper | `packages/api/src/utils/permission.ts` | 后台修改操作统一记录 |
| Import Token 权限映射 | `packages/api/src/utils/import-validation.ts`、`packages/api/src/utils/import-token.ts` | Telegram 外部导入按 `gallery:create` / `case:create` 授权 |
| Nuxt 文件路由 | `packages/web/app/pages/**` | 页面路由和布局按文件结构生成 |

## 5. 已知架构风险

- API 路由文件中存在多个超过 400 行的文件，例如 `admin/galleries.ts`、`auth.ts`、`admin/users.ts`、`admin/media.ts`；继续增长会提高修改风险。
- Dev 环境已配置独立 D1/R2/Queue 资源，用于真实 dev Worker 预演；后台写操作只应影响 dev 测试数据。
- Cloudflare Stream 相关字段和签名逻辑存在，但生产视频上传/编码链路未接入；文档和 UI 需要持续避免暗示视频已完整可用。
- 当前已有 Web Playwright smoke 覆盖核心页面和多视口响应式，并扩展了 Vitest 组件测试；后台复杂组件局部状态仍需要继续补充测试覆盖。

## 6. 证据

- `packages/api/src/index.ts`
- `packages/api/src/routes/admin/index.ts`
- `packages/api/src/routes/media.ts`
- `packages/web/server/api/[...].ts`
- `packages/web/nuxt.config.ts`
- `packages/api/wrangler.toml`
- `packages/web/wrangler.toml`
