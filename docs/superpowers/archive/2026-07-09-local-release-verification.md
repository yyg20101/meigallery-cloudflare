# 本地与准生产发布验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox format and must be completed in order. Do not skip verification steps.

## 目标

建立一套“本地严格验证 + 开发环境预演 + 生产发布硬闸门”的发布验证体系，避免归因、Meta 像素、Meta CAPI、数据分析和后台管理变更以补丁方式进入生产。

本计划基于已确认规格：

- `/Users/wajie/Projects/meigallery-cloudflare/docs/superpowers/specs/2026-07-09-local-release-verification-design.md`

## 范围

- 新增统一发布验证脚本入口：`quick`、`local-runtime`、`dev-rehearsal`、`release`。
- 新增结构化验证报告，生产部署必须读取通过报告。
- 拆分开发环境 Cloudflare 资源，避免 `dev` 环境继续绑定生产 D1/R2。
- 覆盖 Meta Pixel、Meta CAPI、归因链路、后台数据分析、注册/试用/联系等关键事件。
- 更新部署脚本和文档，使发布流程可重复、可审计。

## 非目标

- 不重构归因业务模型。
- 不改变生产域名、生产 Worker 名称或生产 D1/R2 资源。
- 不把 GitHub Actions 改成自动生产部署。
- 不在测试脚本中保存 Meta access token、Cloudflare token、用户真实数据或生产数据快照。

## File Structure

新增文件：

- `/Users/wajie/Projects/meigallery-cloudflare/scripts/release-verification-lib.mjs`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/release-verification-lib.test.mjs`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-release.mjs`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-dev-resources.mjs`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-local-runtime.mjs`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-dev-rehearsal.mjs`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/fixtures/release-smoke/seed-local.sql`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/fixtures/release-smoke/seed-dev.sql`
- `/Users/wajie/Projects/meigallery-cloudflare/reports/release-verification/README.md`

修改文件：

- `/Users/wajie/Projects/meigallery-cloudflare/.gitignore`
- `/Users/wajie/Projects/meigallery-cloudflare/package.json`
- `/Users/wajie/Projects/meigallery-cloudflare/scripts/deploy.sh`
- `/Users/wajie/Projects/meigallery-cloudflare/packages/api/wrangler.toml`
- `/Users/wajie/Projects/meigallery-cloudflare/docs/DEPLOYMENT.md`
- `/Users/wajie/Projects/meigallery-cloudflare/docs/PROJECT_STATUS.md`

## 报告契约

所有验证脚本写入 `/Users/wajie/Projects/meigallery-cloudflare/reports/release-verification/`，该目录只提交 `README.md`，运行产生的 JSON 报告不提交。

报告字段：

```json
{
  "schemaVersion": 1,
  "mode": "quick",
  "status": "passed",
  "startedAt": "2026-07-09T00:00:00.000Z",
  "finishedAt": "2026-07-09T00:05:00.000Z",
  "durationMs": 300000,
  "git": {
    "branch": "dev",
    "commit": "full-sha",
    "isClean": true,
    "remote": "origin"
  },
  "versions": {
    "node": "v24.x.x",
    "pnpm": "x.x.x",
    "wrangler": "x.x.x"
  },
  "steps": [
    {
      "name": "api-unit",
      "status": "passed",
      "durationMs": 1000,
      "command": "corepack pnpm --filter @meigallery/api test",
      "summary": "API unit tests passed"
    }
  ],
  "artifacts": [],
  "notes": []
}
```

规则：

- `status` 只能是 `passed`、`failed`、`skipped`。
- `mode` 只能是 `quick`、`local-runtime`、`dev-rehearsal`、`release`。
- 命令输出中必须脱敏：`TOKEN`、`SECRET`、`PASSWORD`、`ACCESS_TOKEN`、`SESSION`、`COOKIE`。
- `latest.json` 永远指向最近一次完整报告内容，不使用符号链接，兼容 Windows 和 CI。
- 生产部署只接受 `mode=release` 且 `status=passed` 的报告。

## Task 1: 验证基础库与 quick 模式

**目标：** 先建立最小可用验证入口，覆盖当前 CI 同等质量门禁，并产出结构化报告。

### Implementation

- [ ] 在 `/Users/wajie/Projects/meigallery-cloudflare/scripts/release-verification-lib.mjs` 新增公共函数：

```js
export const REPORT_DIR = new URL('../reports/release-verification/', import.meta.url)

export function redact(value) {}
export function createStep(name) {}
export async function runCommand(command, args, options = {}) {}
export async function collectVersions() {}
export async function getGitState() {}
export async function writeReport(report) {}
export async function readLatestReport() {}
export function assertReportCanGateProduction(report, options = {}) {}
```

- [ ] `runCommand` 使用 `child_process.spawn`，记录退出码、耗时、脱敏后的 stdout/stderr 摘要。失败时不直接 `process.exit`，返回失败 step，由编排层统一写报告。
- [ ] `collectVersions` 执行：

```bash
node --version
corepack pnpm --version
corepack pnpm --filter @meigallery/api exec wrangler --version
```

- [ ] `getGitState` 执行：

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --porcelain
git remote get-url origin
```

- [ ] 在 `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-release.mjs` 实现 CLI：

```bash
node scripts/verify-release.mjs quick
node scripts/verify-release.mjs assert-production-allowed
```

- [ ] `quick` 模式顺序执行：

```bash
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt typecheck
corepack pnpm --filter @meigallery/web run test:unit
corepack pnpm --filter @meigallery/web exec playwright test
corepack pnpm --filter @meigallery/web exec nuxt build
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
```

- [ ] 修改 `/Users/wajie/Projects/meigallery-cloudflare/package.json`，新增 scripts：

```json
{
  "verify:quick": "node scripts/verify-release.mjs quick",
  "verify:local-runtime": "node scripts/verify-release.mjs local-runtime",
  "verify:dev-rehearsal": "node scripts/verify-release.mjs dev-rehearsal",
  "verify:release": "node scripts/verify-release.mjs release"
}
```

- [ ] 修改 `/Users/wajie/Projects/meigallery-cloudflare/.gitignore`：

```gitignore
reports/release-verification/*.json
reports/release-verification/*.log
.wrangler-release-verify/
```

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/reports/release-verification/README.md`，说明报告目录用途、提交规则和生产部署闸门。

### Tests

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/scripts/release-verification-lib.test.mjs`，覆盖：
  - `redact` 会隐藏 token、secret、cookie、session。
  - `writeReport` 同时写入 timestamp 文件和 `latest.json`。
  - `assertReportCanGateProduction` 拒绝失败报告、非 release 报告、脏工作区报告、过期报告。
- [ ] 运行：

```bash
corepack pnpm test:scripts
corepack pnpm verify:quick
```

预期结果：

- `corepack pnpm test:scripts` 退出码为 0。
- `corepack pnpm verify:quick` 退出码为 0。
- `/Users/wajie/Projects/meigallery-cloudflare/reports/release-verification/latest.json` 中 `mode` 为 `quick`，`status` 为 `passed`。

### Commit

- [ ] 提交：

```bash
git add -A
git commit -m "test: 新增发布快速验证入口"
```

## Task 2: 拆分开发环境 Cloudflare 资源

**目标：** 让开发环境使用独立 D1/R2/Queue，避免 dev 预演污染生产资源。

### Implementation

- [ ] 先读取现有 Cloudflare 资源，确认名称：

```bash
corepack pnpm --filter @meigallery/api exec wrangler d1 list
corepack pnpm --filter @meigallery/api exec wrangler r2 bucket list
corepack pnpm --filter @meigallery/api exec wrangler queues list
```

- [ ] 如果 `meigallery-db-dev` 不存在，创建开发 D1：

```bash
corepack pnpm --filter @meigallery/api exec wrangler d1 create meigallery-db-dev
```

预期输出包含 `database_id`。实施者必须把该 UUID 写入 `packages/api/wrangler.toml` 的 `[env.dev]` D1 绑定。

- [ ] 如果 `meigallery-media-dev` 不存在，创建开发 R2 bucket：

```bash
corepack pnpm --filter @meigallery/api exec wrangler r2 bucket create meigallery-media-dev
```

- [ ] 如果 `meigallery-meta-capi-dev` 不存在，创建开发 Queue：

```bash
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi-dev
```

- [ ] 修改 `/Users/wajie/Projects/meigallery-cloudflare/packages/api/wrangler.toml`：
  - `[env.dev].d1_databases[0].database_name` 改为 `meigallery-db-dev`。
  - `[env.dev].d1_databases[0].database_id` 改为 `wrangler d1 create meigallery-db-dev` 输出的 UUID。
  - `[env.dev].r2_buckets[0].bucket_name` 改为 `meigallery-media-dev`。
  - `[env.dev].queues.producers[0].queue` 保持 `meigallery-meta-capi-dev`。
  - `[env.dev].queues.consumers[0].queue` 保持 `meigallery-meta-capi-dev`。

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-dev-resources.mjs`：
  - 读取 `packages/api/wrangler.toml`。
  - 断言生产 D1 名称为 `meigallery-db`。
  - 断言 dev D1 名称为 `meigallery-db-dev`。
  - 断言生产 R2 名称为 `meigallery-media`。
  - 断言 dev R2 名称为 `meigallery-media-dev`。
  - 断言 dev D1 `database_id` 与生产 D1 `database_id` 不相同。
  - 断言 dev R2 bucket 与生产 R2 bucket 不相同。

- [ ] 将 `verify-dev-resources.mjs` 接入 `verify-release.mjs quick` 的第一步，资源隔离失败时阻断所有模式。

### Tests

- [ ] 运行：

```bash
node scripts/verify-dev-resources.mjs
corepack pnpm verify:quick
```

预期结果：

- `node scripts/verify-dev-resources.mjs` 退出码为 0。
- `corepack pnpm verify:quick` 报告中包含 `dev-resource-isolation` 且状态为 `passed`。

### Commit

- [ ] 提交：

```bash
git add -A
git commit -m "chore: 隔离开发环境资源"
```

## Task 3: local-runtime 模式

**目标：** 使用本地 Wrangler runtime 验证 API、D1、本地会话、归因事件和后台读取，避免只靠 mock E2E。

### Implementation

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/scripts/fixtures/release-smoke/seed-local.sql`，包含本地 smoke 所需最小数据：
  - Owner 用户：`release-owner@example.test`，角色 `owner`，状态 `active`。
  - 默认会员等级：`free`、`vip`、`svip`，rank 分别为 0、10、20。
  - 站点设置：开启 analytics、Meta Pixel，关闭真实 Meta CAPI 发送。
  - 联系方式：Telegram 与 Email 各一条，避免 Top 点击混淆为重复联系方式。
  - 归因测试 source：`release-local-fb`。

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-local-runtime.mjs`，导出：

```js
export async function runLocalRuntimeVerification(options = {}) {}
```

- [ ] `runLocalRuntimeVerification` 执行：

```bash
rm -rf .wrangler-release-verify/local-runtime
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --local --persist-to ../../.wrangler-release-verify/local-runtime
corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db --local --persist-to ../../.wrangler-release-verify/local-runtime --file ../../scripts/fixtures/release-smoke/seed-local.sql
```

- [ ] `runLocalRuntimeVerification` 生成一个本地测试 session：
  - token 固定为当前进程生成的随机值，不写入报告。
  - 使用 Node `crypto.createHash('sha256')` 计算 `token_hash`。
  - 通过 `wrangler d1 execute --local` 插入 `sessions` 表。
  - HTTP 请求携带 `Cookie: mei_session=<token>`。

- [ ] `runLocalRuntimeVerification` 启动本地 API Worker：

```bash
corepack pnpm --filter @meigallery/api exec wrangler dev --local --persist-to ../../.wrangler-release-verify/local-runtime --port 8789
```

- [ ] 等待 `http://127.0.0.1:8789/api/health` 返回 200 后开始 smoke。

- [ ] local-runtime smoke 必须验证：
  - `GET /api/health` 返回 200。
  - `POST /api/conversions` 写入 `contact` 事件，payload 包含 `source=release-local-fb`、`utm_source=facebook`、`fbclid`。
  - `POST /api/conversions` 写入 `trial_start` 或项目当前使用的开始试用事件名。
  - `POST /api/conversions` 写入 `complete_registration` 或项目当前使用的完成注册事件名。
  - `GET /api/admin/analytics` 或当前后台数据分析 API 能读到上述事件。
  - `GET /api/admin/attribution` 或当前归因中心 API 能按 source 展示上述事件。
  - 队列/CAPI 关闭时不会真实发送 Meta 请求，报告中记录为 `meta-capi-disabled-in-local`。

- [ ] `verify-release.mjs local-runtime` 调用 `runLocalRuntimeVerification`，并合并到统一报告。

### Tests

- [ ] 运行：

```bash
corepack pnpm verify:local-runtime
```

预期结果：

- 命令退出码为 0。
- 报告包含 `local-d1-migrate`、`local-d1-seed`、`local-api-health`、`local-conversion-contact`、`local-admin-analytics`、`local-admin-attribution`。
- `reports/release-verification/latest.json` 中 `mode` 为 `local-runtime`，`status` 为 `passed`。

### Commit

- [ ] 提交：

```bash
git add -A
git commit -m "test: 新增本地运行时发布验证"
```

## Task 4: dev-rehearsal 模式

**目标：** 在 Cloudflare dev Worker 与 dev D1/R2/Queue 上做发布预演，验证远端环境与本地一致。

### Implementation

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/scripts/fixtures/release-smoke/seed-dev.sql`，内容与 local seed 语义一致，但测试数据使用 `release-dev-*` 前缀，避免与人工测试数据混淆。

- [ ] 新增 `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-dev-rehearsal.mjs`，导出：

```js
export async function runDevRehearsalVerification(options = {}) {}
```

- [ ] `runDevRehearsalVerification` 必须要求环境变量：

```bash
VERIFY_DEV_API_URL
VERIFY_DEV_WEB_URL
```

变量值必须由实施者从 `wrangler deploy --env dev` 输出或 Cloudflare Workers 控制台复制实际 HTTPS 地址；代码中不得猜测 workers.dev 子域名。

- [ ] `runDevRehearsalVerification` 执行：

```bash
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db-dev --env dev --remote
corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db-dev --env dev --remote --file ../../scripts/fixtures/release-smoke/seed-dev.sql
corepack pnpm --filter @meigallery/api exec wrangler deploy --env dev
corepack pnpm --filter @meigallery/web exec wrangler deploy --env dev
```

- [ ] dev-rehearsal smoke 必须验证：
  - `GET $VERIFY_DEV_API_URL/api/health` 返回 200。
  - `GET $VERIFY_DEV_WEB_URL` 返回 200 且页面 HTML 包含 Nuxt app root。
  - 通过 API 写入 `contact`、`trial_start`、`complete_registration` 事件。
  - 后台 analytics API 能按日期查询当天数据。
  - 后台 attribution API 能按测试 source 查询数据。
  - 如果设置了 `META_CAPI_TEST_EVENT_CODE`，Meta CAPI 队列任务标记为测试事件；如果未设置，报告中记录 `meta-test-event-code-missing`，但 dev-rehearsal 不失败。

- [ ] `verify-release.mjs dev-rehearsal` 调用 `runDevRehearsalVerification`，并合并到统一报告。

### Tests

- [ ] 运行：

```bash
corepack pnpm verify:dev-rehearsal
```

运行前置条件：

```bash
test -n "$VERIFY_DEV_API_URL"
test -n "$VERIFY_DEV_WEB_URL"
```

预期结果：

- 命令退出码为 0。
- 报告包含 `dev-d1-migrate`、`dev-d1-seed`、`dev-api-deploy`、`dev-web-deploy`、`dev-api-health`、`dev-web-health`、`dev-admin-analytics`、`dev-admin-attribution`。
- `reports/release-verification/latest.json` 中 `mode` 为 `dev-rehearsal`，`status` 为 `passed`。

### Commit

- [ ] 提交：

```bash
git add -A
git commit -m "test: 新增开发环境发布预演"
```

## Task 5: release 模式与生产部署硬闸门

**目标：** 生产部署前必须有同一 commit 的完整发布验证报告，防止未验证代码上线。

### Implementation

- [ ] 扩展 `/Users/wajie/Projects/meigallery-cloudflare/scripts/verify-release.mjs`：

```bash
node scripts/verify-release.mjs release
```

- [ ] `release` 模式顺序执行：
  - `quick`
  - `local-runtime`
  - `dev-rehearsal`
  - 生成最终 `mode=release` 报告

- [ ] `release` 报告必须满足：
  - `status=passed`
  - `git.isClean=true`
  - `git.commit` 等于当前 `git rev-parse HEAD`
  - `startedAt` 距离当前时间不超过 24 小时
  - 每个子模式都有 passed step 摘要

- [ ] 扩展：

```bash
node scripts/verify-release.mjs assert-production-allowed
```

检查逻辑：

```text
1. 读取 reports/release-verification/latest.json
2. 断言 mode=release
3. 断言 status=passed
4. 断言报告 commit 等于当前 HEAD
5. 断言当前工作区干净
6. 断言报告未超过 24 小时
7. 断言当前分支是 main 或 release/*
```

- [ ] 修改 `/Users/wajie/Projects/meigallery-cloudflare/scripts/deploy.sh`：
  - 当环境为 `production` 时，在生产确认后、远端迁移前执行：

```bash
node scripts/verify-release.mjs assert-production-allowed
```

  - 如果断言失败，停止生产部署并输出：

```text
生产部署被发布验证闸门阻断。请先运行 corepack pnpm verify:release，并确认报告通过。
```

- [ ] 保持 `dev` 部署不要求 release 报告，但 `dev` 部署仍继续执行现有构建和测试。

### Tests

- [ ] 扩展 `/Users/wajie/Projects/meigallery-cloudflare/scripts/release-verification-lib.test.mjs`，覆盖：
  - 非 `release` 报告不能通过生产闸门。
  - commit 不一致不能通过生产闸门。
  - 报告超过 24 小时不能通过生产闸门。
  - 分支不是 `main` 或 `release/*` 不能通过生产闸门。
  - `VERIFY_RELEASE_ALLOW_BRANCH=dev` 只允许测试用例绕过分支限制，生产部署脚本不得设置该变量。

- [ ] 运行：

```bash
corepack pnpm test:scripts
node scripts/verify-release.mjs assert-production-allowed
```

预期结果：

- `corepack pnpm test:scripts` 退出码为 0。
- 在 `dev` 分支且没有 release 报告时，`assert-production-allowed` 退出码为 1，并输出生产闸门阻断原因。

### Commit

- [ ] 提交：

```bash
git add -A
git commit -m "deploy: 增加生产发布验证闸门"
```

## Task 6: 文档、状态索引与最终验证

**目标：** 让后续开发者知道什么时候运行哪种验证，生产发布时不会遗漏步骤。

### Implementation

- [ ] 更新 `/Users/wajie/Projects/meigallery-cloudflare/docs/DEPLOYMENT.md`：
  - 增加“发布验证分层”章节。
  - 写清 `verify:quick`、`verify:local-runtime`、`verify:dev-rehearsal`、`verify:release` 使用场景。
  - 写清生产部署前必须有同一 commit 的 release 报告。
  - 写清 dev 资源与 production 资源隔离表。

- [ ] 更新 `/Users/wajie/Projects/meigallery-cloudflare/docs/PROJECT_STATUS.md`：
  - 增加发布验证体系状态。
  - 记录 dev D1/R2/Queue 独立资源名称。
  - 记录生产部署仍为手动执行，不由 GitHub Actions 自动触发。

- [ ] 确认 `/Users/wajie/Projects/meigallery-cloudflare/docs/GIT_WORKFLOW.md` 已包含“非关键提交不推送，功能完成后统一推送”的规范；如果缺失，在本任务补充该规范。

### Tests

- [ ] 运行完整本地验证：

```bash
corepack pnpm verify:quick
corepack pnpm verify:local-runtime
```

- [ ] 在已配置 dev URL 和 Cloudflare 凭据的环境运行：

```bash
test -n "$VERIFY_DEV_API_URL"
test -n "$VERIFY_DEV_WEB_URL"
corepack pnpm verify:dev-rehearsal
```

- [ ] 在 `release/*` 分支或测试允许分支变量下运行：

```bash
test -n "$VERIFY_DEV_API_URL"
test -n "$VERIFY_DEV_WEB_URL"
VERIFY_RELEASE_ALLOW_BRANCH=dev corepack pnpm verify:release
```

预期结果：

- `verify:quick` 通过。
- `verify:local-runtime` 通过。
- `verify:dev-rehearsal` 在 dev 资源存在时通过。
- `verify:release` 在所有子模式通过后生成 `mode=release` 报告。

### Commit

- [ ] 提交：

```bash
git add -A
git commit -m "docs: 完善发布验证流程"
```

## Final Verification

全部任务完成后运行：

```bash
git status --short
corepack pnpm test:scripts
corepack pnpm verify:quick
corepack pnpm verify:local-runtime
```

如果当前机器具备 Cloudflare 登录态和 dev URL，再运行：

```bash
test -n "$VERIFY_DEV_API_URL"
test -n "$VERIFY_DEV_WEB_URL"
corepack pnpm verify:dev-rehearsal
```

发布前运行：

```bash
test -n "$VERIFY_DEV_API_URL"
test -n "$VERIFY_DEV_WEB_URL"
corepack pnpm verify:release
```

生产部署命令保持：

```bash
./scripts/deploy.sh production
```

预期结果：

- 生产部署脚本在没有通过 `verify:release` 的同 commit 报告时阻断。
- 生产部署脚本在报告通过、commit 一致、工作区干净、分支合规时继续执行原有部署流程。

## Rollback

如果新验证脚本阻断紧急生产修复：

- [ ] 不删除验证脚本。
- [ ] 在 `release/*` 或 `fix/*` 分支修复阻断原因。
- [ ] 重新运行 `corepack pnpm verify:release`。
- [ ] 通过 PR 合入 `main` 后再执行 `./scripts/deploy.sh production`。

如果 Cloudflare dev 资源创建错误：

- [ ] 保留生产资源不变。
- [ ] 修正 `/Users/wajie/Projects/meigallery-cloudflare/packages/api/wrangler.toml` 的 `[env.dev]` 绑定。
- [ ] 重新运行 `node scripts/verify-dev-resources.mjs`。
- [ ] 重新运行 `corepack pnpm verify:dev-rehearsal`。

## Self-Review Checklist

- [ ] 计划覆盖规格中的三层验证：quick、local-runtime、dev-rehearsal。
- [ ] 计划覆盖生产部署硬闸门。
- [ ] 计划覆盖 Meta Pixel、Meta CAPI、归因、数据分析、联系、开始试用、完成注册。
- [ ] 计划明确 dev 资源与 production 资源隔离。
- [ ] 计划没有要求提交 secret、token、cookie 或真实用户数据。
- [ ] 计划给出了每个任务的文件、命令、预期结果和提交信息。
