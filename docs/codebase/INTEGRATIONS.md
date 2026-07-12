# 外部集成

## 1. 集成清单

| 系统 | 类型 | 用途 | 认证模型 | 重要性 | 证据 |
|------|------|------|----------|--------|------|
| Cloudflare Workers | Runtime | Web/API 运行时和部署目标 | Wrangler 登录 + account 配置 | 高 | `packages/api/wrangler.toml`、`packages/web/wrangler.toml` |
| Cloudflare D1 | 数据库 | 用户、图库、标签、会员、审计、导入记录 | Worker binding `DB` | 高 | `packages/api/wrangler.toml`、`packages/api/migrations/*.sql` |
| Cloudflare R2 | 对象存储 | 图片、头像、二维码、导入包、错误报告、案例图片 | Worker binding `R2` | 高 | `packages/api/wrangler.toml`、`packages/api/src/routes/media.ts` |
| Workers Assets | 静态资源 | Nuxt build 后的静态资源分发 | Wrangler `[assets]` 配置 | 高 | `packages/web/wrangler.toml` |
| API Service Binding | Worker-to-Worker | Web SSR 直连 API Worker | `API_SERVICE` binding | 高 | `packages/web/wrangler.toml`、`packages/web/server/api/[...].ts` |
| Cloudflare Turnstile | 外部 API | 登录、注册、验证码发送时的人机验证 | `TURNSTILE_SECRET_KEY` + site key | 高 | `packages/api/src/routes/auth.ts`、`packages/web/wrangler.toml` |
| Cloudflare Email Service | Email binding | 验证码、密码重置、会员到期提醒 | Worker `send_email` binding | 中 | `packages/api/wrangler.toml`、`packages/api/src/services/email.ts` |
| Cloudflare Stream | 外部 API | 规划中的视频签名播放和上传 | `STREAM_ACCOUNT_ID` / `STREAM_API_TOKEN` | 中 | `packages/api/src/routes/media.ts`、`docs/PROJECT_STATUS.md` |
| Telegram Bot API | 外部 API | file_id 图片拉取并写入 R2，生成图库/案例草稿 | Bot token secret per sourceBotKey | 中 | `packages/api/src/services/telegram-file-fetcher.ts`、`packages/api/src/routes/imports.ts` |
| WordPress REST API | 外部 API | 旧站文章、分类、标签和媒体迁移 | 公开 URL + 安全 URL 校验 | 中 | `packages/api/src/services/wp-fetcher.ts`、`scripts/migrate-wordpress.mjs` |
| Meta Pixel / CAPI | Browser + Server adapter | 广告归因事件 | 后台统一平台连接 + Worker secret | 中 | `packages/web/app/plugins/ad-platform.client.ts`、`packages/api/src/services/ad-platform/` |

## 2. 数据存储

| 存储 | 角色 | 访问层 | 关键风险 | 证据 |
|------|------|--------|----------|------|
| D1 `meigallery-db` / `meigallery-db-dev` | 生产/开发结构化业务数据 | API routes/services 通过 `c.env.DB` | dev 必须使用独立 `meigallery-db-dev`，不得对生产 D1 做联调写入或发布预演 | `packages/api/wrangler.toml`、`docs/DEPLOYMENT.md`、`scripts/verify-dev-resources.mjs` |
| R2 `meigallery-media` / `meigallery-media-dev` | 生产/开发私有与公开对象 | API routes/services 通过 `c.env.R2` | dev 必须使用独立 `meigallery-media-dev`；对象 key 与 D1 记录必须一致，尤其真实案例前缀迁移 | `packages/api/wrangler.toml`、`scripts/migrate-cases-r2.mjs`、`scripts/verify-dev-resources.mjs` |
| Worker secrets | 密钥 | Wrangler secret | 轮换策略未在代码中自动化 | `.env.example`、`packages/api/wrangler.toml` |

## 3. Secrets 和凭据

- `.env.example` 只提供模板，没有提交真实 secret。
- Wrangler 配置注释列出 API secret 设置命令。
- Import Token 使用 hash 存储，外部请求使用 `Authorization: Bearer <token>`。
- Telegram Bot Token 根据 `sourceBotKey` 组合出 secret 名，例如 `TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT`。
- `[ASK USER]` 当前没有文档化的 secret 轮换周期和生产事故撤销流程。

## 4. 可靠性和失败行为

- Telegram 导入使用 `waitUntil` 异步处理；失败时更新 `external_import_records`、清理 R2/DB，并记录审计日志。
- R2 cases 迁移脚本复制后用 sha256 验证，删除旧对象前再次比对。
- 媒体缩略图在 Images Transformations 失败或未启用时回退原图。
- WordPress 外部 URL 访问通过 `assertSafeExternalUrl` 防止访问 localhost/非公网地址。
- 普通 fetch 调用没有统一 timeout/circuit breaker；网络失败主要靠局部错误处理。

## 5. 可观测性

- API 使用 Hono logger 和 `console.error`。
- 业务操作通过 `admin_audit_logs` 记录。
- Cloudflare Dashboard 内置 Workers/D1/R2 指标是当前主要监控来源。
- 未发现 Logpush、APM、集中 tracing 或自定义指标配置。

## 6. 证据

- `packages/api/wrangler.toml`
- `packages/web/wrangler.toml`
- `packages/web/server/api/[...].ts`
- `packages/api/src/routes/auth.ts`
- `packages/api/src/routes/media.ts`
- `packages/api/src/services/telegram-file-fetcher.ts`
- `packages/api/src/services/telegram-file-id-import.ts`
- `packages/api/src/utils/external-url.ts`
- `scripts/migrate-cases-r2.mjs`
- `.env.example`
