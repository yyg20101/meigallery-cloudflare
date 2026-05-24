# 测试

## 1. 测试栈和命令

- 主要测试框架：Vitest `^4.1.5`。
- 断言/Mock：Vitest `expect`、`vi`，以及测试内手写 mock D1/R2/env。
- 命令：

```bash
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
```

未发现覆盖率命令、覆盖率阈值、前端单测或 E2E 测试配置。

## 2. 测试布局

- 测试文件和源码同目录，命名为 `*.test.ts`。
- Vitest include：`src/**/*.test.ts`。
- API 测试分布在 `middleware`、`routes`、`routes/admin`、`services`、`utils`。
- Web 目录未发现 `*.test.ts`、Playwright 或 Vitest 前端配置。

## 3. 测试范围矩阵

| 范围 | 是否覆盖 | 典型目标 | 备注 |
|------|----------|----------|------|
| 单元测试 | 是 | 密码、session、权限、会员、导入校验、URL 安全、Pixel 设置、WordPress 解析 | `packages/api/src/utils/*.test.ts`、`packages/api/src/services/*.test.ts` |
| 路由级测试 | 是 | 公开图库/搜索/媒体/案例、后台设置/案例/Import Token/外部导入 | `packages/api/src/routes/**/*.test.ts` |
| 集成测试 | 部分 | 使用 mock D1/R2/env 验证路由和服务流程 | 没有真实 Cloudflare 远程集成测试 |
| 前端组件测试 | 否 | `[TODO]` | 未发现前端测试框架 |
| E2E | 否 | `[TODO]` | 当前依赖 Nuxt build 和手动/浏览器验收 |

## 4. Mock 和隔离策略

- D1 通过测试内 mock 对象模拟 `prepare().bind().first()/all()/run()` 行为。
- R2 在涉及上传/删除的路由测试中使用内联 mock。
- Telegram 文件拉取测试 mock `fetch`，覆盖 getFile、download 和 MIME 校验。
- 测试隔离依赖每个测试构造新 mock；未发现全局 setup 文件。

## 5. 覆盖和质量信号

- 当前测试文件数：33 个 API `*.test.ts` 文件。
- 扫描输出显示生产代码无 TODO/FIXME/HACK。
- CI 会运行 API 类型检查、API 单元测试、Web build、API dry-run build。
- 覆盖率：`[TODO]`，未配置报告和阈值。
- 已知缺口：前端页面/组件无自动化测试；Cloudflare D1/R2/Email/Workers 真实远程链路无自动化集成测试；Stream 规划能力未有端到端测试。

## 6. 证据

- `packages/api/vitest.config.ts`
- `packages/api/package.json`
- `.github/workflows/ci.yml`
- `packages/api/src/utils/import-validation.test.ts`
- `packages/api/src/services/telegram-file-fetcher.test.ts`
- `packages/api/src/routes/galleries.test.ts`
- `packages/api/src/routes/admin/settings.test.ts`
- `.github/workflows/ci.yml`
