# 编码约定

## 1. 命名规则

| 项 | 规则 | 示例 | 证据 |
|----|------|------|------|
| API 文件 | kebab-case，按功能命名 | `telegram-file-id-import.ts`、`import-api-tokens.ts` | `packages/api/src/services/`、`packages/api/src/routes/admin/` |
| Vue 组件 | PascalCase | `GalleryCard.vue`、`ContactPanel.vue` | `packages/web/app/components/` |
| Vue 页面 | Nuxt 文件路由命名，动态段使用 `[id].vue` / `[slug].vue` | `pages/gallery/[slug].vue`、`pages/admin/users/[id].vue` | `packages/web/app/pages/` |
| 函数 | camelCase | `validateTelegramImportPayload`、`writeAuditLog` | `packages/api/src/utils/import-validation.ts`、`packages/api/src/utils/permission.ts` |
| 类型/interface | PascalCase | `CloudflareEnv`、`TelegramImportPayload` | `packages/shared/src/types/index.ts`、`packages/api/src/utils/import-validation.ts` |
| 常量/env | 常量对象用 UPPER_CASE 成员，环境变量用 UPPER_SNAKE_CASE | `MEMBERSHIP_RANKS`、`SESSION_SECRET` | `packages/shared/src/constants/index.ts`、`.env.example` |

## 2. 格式化和 lint

- Formatter：根目录 `.editorconfig` 统一 UTF-8、LF、2 空格缩进、末尾换行和默认去除行尾空格；当前未接入 Prettier。
- Linter：根目录 `eslint.config.mjs` 使用 ESLint flat config，覆盖 `packages/**/*.{ts,js,mjs,vue}`。
- 当前 lint 为零 warning 基线：`pnpm lint` 使用 `--max-warnings=0`，错误和 warning 均阻断 CI。
- TypeScript：API/shared 使用 `tsc --noEmit`；Web package 提供 `nuxt typecheck`，但 `nuxt.config.ts` 中 `typescript.typeCheck` 为 `false`。
- 运行命令：

```bash
corepack pnpm lint
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
corepack pnpm --filter @meigallery/api test
```

## 3. 导入和模块约定

- API 和 Web 通过 workspace 依赖引用 `@meigallery/shared`。
- Vitest 配置将 `@meigallery/shared`、`@meigallery/shared/constants`、`@meigallery/shared/utils` 映射到共享源码。
- 包内模块多使用相对路径，例如 API route 引用 `../utils/...` 或 `../../middleware/auth`。
- `packages/shared/src/constants/index.ts` 和 `packages/shared/src/utils/index.ts` 是共享导出的主要入口。

## 4. 错误和日志约定

- API 普通错误多返回 `{ statusCode, message }` 或 `{ error }`，状态码由路由显式指定。
- Telegram 外部导入使用 `ImportError` 和 `importErrorBody` 统一错误 code/message/status。
- 全局未处理错误在 `packages/api/src/index.ts` 中 `console.error('未处理异常:', err)` 后返回 500。
- 后台修改操作通过 `writeAuditLog` 写入 `admin_audit_logs`，如图库批量操作、媒体上传、设置修改、用户管理。
- 敏感数据规则在代码中部分体现：Import Token 只存 hash，Telegram 文件 URL 不暴露给客户端；完整脱敏规则仍依赖测试和评审。

## 5. 测试约定

- 测试文件与源码同目录，命名为 `*.test.ts`。
- API 测试使用 Vitest `describe` / `it` / `expect`，部分测试构造 mock D1/R2/env。
- 纯工具和路由均有测试样例；前端目前没有对应测试框架。
- API coverage 已配置核心安全/导入模块基线阈值；前端组件测试仍未配置。

## 6. 证据

- `packages/api/vitest.config.ts`
- `packages/api/src/routes/imports.ts`
- `packages/api/src/utils/import-validation.ts`
- `packages/api/src/utils/permission.ts`
- `packages/shared/src/constants/index.ts`
- `packages/web/nuxt.config.ts`
- `package.json`
- `eslint.config.mjs`
- `.editorconfig`
- `packages/api/vitest.config.ts`
