# 技术栈

## 1. 运行时摘要

| 范围 | 当前值 | 证据 |
|------|--------|------|
| 主要语言 | TypeScript / Vue Single File Component | `packages/api/src/index.ts`、`packages/web/app/app.vue`、`packages/shared/src/types/index.ts` |
| Node 版本要求 | Node.js `>=20.0.0` | `package.json` |
| 包管理器 | pnpm workspace，锁定 `pnpm@9.14.2` | `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` |
| 前端运行时 | Nuxt 4 + Vue 3，Nitro preset `cloudflare-module` | `packages/web/package.json`、`packages/web/nuxt.config.ts` |
| API 运行时 | Hono on Cloudflare Workers | `packages/api/package.json`、`packages/api/src/index.ts`、`packages/api/wrangler.toml` |
| 数据运行时 | Cloudflare D1 + R2 + Email binding | `packages/api/wrangler.toml`、`packages/api/src/index.ts` |

## 2. 生产依赖

| 依赖 | 版本声明 | 作用 | 证据 |
|------|----------|------|------|
| `nuxt` | `^4.4.4` | Web Worker SSR/CSR 应用框架 | `packages/web/package.json` |
| `vue` | `^3.5.0` | 前端组件运行时 | `packages/web/package.json` |
| `vue-router` | `^4.4.0` | 前端路由 | `packages/web/package.json` |
| `@nuxt/ui` | `^4.7.1` | 后台和部分 UI 组件基础 | `packages/web/package.json` |
| `tailwindcss` | `^4.2.4` | 前台和后台样式工具 | `packages/web/package.json`、`packages/web/app/assets/css/main.css` |
| `hono` | `^4.6.0` | API Worker HTTP 路由框架 | `packages/api/package.json` |
| `@meigallery/shared` | workspace | 共享类型、常量和工具 | `packages/api/package.json`、`packages/web/package.json`、`packages/shared/package.json` |

## 3. 开发工具链

| 工具 | 用途 | 证据 |
|------|------|------|
| TypeScript | API、共享包类型检查 | `package.json`、`packages/api/tsconfig.json`、`packages/shared/tsconfig.json` |
| Vitest | API 单元/路由测试 | `packages/api/package.json`、`packages/api/vitest.config.ts` |
| Wrangler | Worker 构建、D1 migration、部署 | `packages/api/package.json`、`packages/web/package.json`、`scripts/deploy.sh` |
| GitHub Actions | PR/dev 验证，不部署生产 | `.github/workflows/ci.yml` |
| Nuxt CLI | Web build、dev、typecheck | `packages/web/package.json` |
| ESLint | packages 源码 lint 渐进基线 | `package.json`、`eslint.config.mjs`、`.github/workflows/ci.yml` |

未发现仓库根目录 Prettier 或 Histoire 配置；当前组件预览仍为 `[TODO]`。

## 4. 关键命令

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
./scripts/deploy.sh dev
./scripts/deploy.sh production
```

## 5. 环境和配置

- 配置来源：`packages/api/wrangler.toml`、`packages/web/wrangler.toml`、`packages/web/nuxt.config.ts`、`.env.example`。
- API secrets：`SESSION_SECRET`、`TURNSTILE_SECRET_KEY`、`STREAM_ACCOUNT_ID`、`STREAM_API_TOKEN`、`TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT`。
- API vars：`APP_ENV`、`CORS_ORIGIN`、`EMAIL_FROM`、`IMAGE_RESIZING_ENABLED`、`IMPORT_TOKEN_DAILY_LIMIT`。
- Web vars：`NUXT_PUBLIC_API_BASE_URL`、`NUXT_PUBLIC_TURNSTILE_SITE_KEY`、`NUXT_PUBLIC_APP_ENV`、`NUXT_PUBLIC_SITE_URL`。
- 生产部署约束：GitHub Actions 只做验证；生产通过本地 Wrangler 手动部署并显式使用 `--env=""`。

## 6. 证据

- `package.json`
- `pnpm-workspace.yaml`
- `packages/web/package.json`
- `packages/web/nuxt.config.ts`
- `packages/api/package.json`
- `packages/api/wrangler.toml`
- `packages/web/wrangler.toml`
- `.github/workflows/ci.yml`
- `.env.example`
