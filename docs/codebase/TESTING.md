# 测试

## 1. 测试栈和命令

- 主要测试框架：Vitest `^4.1.5`。
- 断言/Mock：Vitest `expect`、`vi`，以及测试内手写 mock D1/R2/env。
- 前端 smoke：Playwright `^1.60.0`，使用本地 mock API 覆盖核心页面和多视口响应式。
- 命令：

```bash
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/api test:coverage
corepack pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web test:e2e
corepack pnpm --filter @meigallery/web exec nuxt build
```

API coverage 当前使用 Vitest v8 provider，报告目录为 `packages/api/coverage/`。Web 已接入 Vitest + Vue Test Utils + happy-dom 组件测试基线。

## 2. 测试布局

- 测试文件和源码同目录，命名为 `*.test.ts`。
- Vitest include：`src/**/*.test.ts`。
- API 测试分布在 `middleware`、`routes`、`routes/admin`、`services`、`utils`。
- Web Playwright 配置位于 `packages/web/playwright.config.ts`，用例位于 `packages/web/tests/e2e/`。
- Web 目录已存在 `packages/web/vitest.config.ts` 和组件/工具测试文件，当前覆盖会员徽章、媒体锁定提示、搜索输入、标签 Chip、首页广告位、联系方式点击、安全 Markdown 渲染、公开站点设置归一化和后台媒体 URL 归一化的基础状态及危险链接边界。

## 3. 测试范围矩阵

| 范围 | 是否覆盖 | 典型目标 | 备注 |
|------|----------|----------|------|
| 单元测试 | 是 | 密码、session、权限、会员、导入校验、URL 安全、邮件模板、Pixel 设置、WordPress 解析 | `packages/api/src/utils/*.test.ts`、`packages/api/src/services/*.test.ts`；公开设置、首页广告、公开封面、后台媒体 URL 和邮件模板覆盖显式解析、危险协议、HTML 转义、空白、编码控制字符和历史脏数据读取边界 |
| 路由级测试 | 是 | 公开图库/搜索/媒体/案例/站点设置、后台设置/媒体/案例/Import Token/外部导入 | `packages/api/src/routes/**/*.test.ts`；媒体、图库、搜索和后台媒体测试覆盖封面/缩略图外链重定向或下发时的 HTTPS 归一化与内部地址拦截 |
| 集成测试 | 部分 | 使用 mock D1/R2/env 验证路由和服务流程 | 没有真实 Cloudflare 远程集成测试 |
| 前端组件测试 | 是 | `corepack pnpm --filter @meigallery/web test:unit` | 当前覆盖 `MembershipBadge`、`MediaLock`、`SearchInput`、`TagChip`、`HomeAdBand`、`ContactMethodItem`、`safeMarkdown`、`siteSettingsSecurity`、`mediaUrlSecurity`，其中 `HomeAdBand`、`safeMarkdown`、`siteSettingsSecurity` 和 `mediaUrlSecurity` 覆盖链接文案转义、危险协议、内部地址和编码控制字符边界；后续扩展复杂组件状态 |
| E2E | 是 | 首页、搜索、图库详情、登录、用户中心、后台首页 | Playwright smoke 覆盖 360/768/1024/1440 视口、横向溢出和私有 key 泄露断言 |

## 4. Mock 和隔离策略

- D1 通过测试内 mock 对象模拟 `prepare().bind().first()/all()/run()` 行为。
- R2 在涉及上传/删除的路由测试中使用内联 mock。
- Telegram 文件拉取测试 mock `fetch`，覆盖 getFile、download 和 MIME 校验。
- Playwright smoke 使用 `packages/web/tests/e2e/mock-api.mjs` 提供公开设置、登录态、图库、搜索、案例、联系方式和后台概览数据，不依赖线上 API、真实 D1/R2 或外部图片。
- 测试隔离依赖每个测试构造新 mock；未发现全局 setup 文件。

## 5. 覆盖和质量信号

- 当前测试文件数：47 个 API `*.test.ts` 文件、9 个 Web `*.test.ts` 文件、1 个 Web Playwright smoke spec。
- 扫描输出显示生产代码无 TODO/FIXME/HACK。
- CI 会运行 API 类型检查、Web 类型检查、API 单元测试、API coverage、Web Playwright smoke、Web build、API dry-run build。
- 覆盖率：API 已配置核心安全/导入模块 coverage 基线，当前阈值为 statements 70%、branches 65%、functions 75%、lines 75%；HTML 和 JSON summary 报告输出到 `packages/api/coverage/` 并由 CI 上传 artifact。
- 已知缺口：前端后台复杂组件测试覆盖仍少；Cloudflare D1/R2/Email/Workers 真实远程链路无自动化集成测试；Stream 规划能力未有端到端测试。

## 6. 证据

- `packages/api/vitest.config.ts`
- `packages/api/package.json`
- `pnpm-lock.yaml`
- `.github/workflows/ci.yml`
- `packages/api/src/utils/import-validation.test.ts`
- `packages/api/src/services/telegram-file-fetcher.test.ts`
- `packages/api/src/routes/galleries.test.ts`
- `packages/api/src/routes/admin/settings.test.ts`
- `packages/web/playwright.config.ts`
- `packages/web/tests/e2e/smoke.spec.ts`
- `packages/web/tests/e2e/mock-api.mjs`
- `.github/workflows/ci.yml`
