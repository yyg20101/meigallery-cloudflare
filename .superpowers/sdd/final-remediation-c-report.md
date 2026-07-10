# 最终整分支审查修复组 C 报告

日期：2026-07-10
基线：`7c9a180`
状态：C 组实现与本地验证完成

## 完成项

1. API `/api/health` 返回真实 `APP_ENV` 对应的 `environment`、40 位 `RELEASE_COMMIT` 和 D1 状态，并设置 `Cache-Control: no-store`；环境、commit 或 D1 非健康时显式返回 `unhealthy`，不生成占位 commit。
2. Web 新增 `/__release`，直接读取 Cloudflare env 的 `NUXT_PUBLIC_APP_ENV` 与 `RELEASE_COMMIT`，返回轻量 no-store JSON；缺失或非法 binding 返回 `503 unhealthy`。
3. dev rehearsal 在部署 API/Web 后并行读取两个发布身份端点，强制两端均为 `environment=dev` 且 commit 等于本次 `releaseCommit`，任一旧部署、错 URL、缺 binding 或不一致都会在业务 smoke 前停止。
4. Meta live evidence CLI 在任何交互录入和 evidence 写入前要求 `VERIFY_DEV_API_URL`、`VERIFY_DEV_WEB_URL`，校验 API/Web 的 dev 环境及 commit 与本地 Git HEAD 完全一致。错误信息不包含响应原文，URL 禁止携带用户名或密码。
5. attribution 默认 `overview`、`conversions`、`links`、`readiness` 从 SQL 层排除历史 `start_trial`；默认响应不再返回其 KPI、趋势、来源、动作、样本或链接字段，仅含该历史动作时 readiness 的 `conversion_ledger` blocker 不通过。
6. attribution overview 的 Meta 聚合改为显式 `pixel_*` 与 `capi_*`：Pixel 仅统计 attempted/pending/skipped，CAPI 仅统计 sent/failed/skipped/duplicate；`last_sent_at` 仅查询 `meta_capi + sent`。现有趋势 UI 的 `failed_count` 兼容键只映射自 `capi_failed_count`。
7. 后台转化页来源分母移除历史 `start_trial`，空态文案仅描述当前有效联系、Lead、完成注册和会员发放事件。

## 验证结果

- API 聚焦 Vitest：PASS，2 files、67 tests。
- API `tsc --noEmit`：PASS。
- Web 聚焦 Vitest：PASS，2 files、5 tests。
- Web 完整 unit：PASS，45 files、212 tests。
- Web `nuxt typecheck`：PASS。
- Web `nuxt build`：PASS，Nitro preset `cloudflare-module`。
- 脚本聚焦 Node tests：PASS，2 suites、16 tests。
- Web 本地 Wrangler 运行时：PASS；`/__release` 返回 `200`、`Cache-Control: no-store`、`environment=dev` 和注入的 40 位 commit，验证后进程已关闭。
- `git diff --check`：PASS。
- 未运行远端检查、远端 D1、部署或推送。

## 修改文件

- `packages/api/src/routes/health.ts`
- `packages/api/src/routes/health.test.ts`
- `packages/api/src/routes/admin/attribution.ts`
- `packages/api/src/routes/admin/attribution.test.ts`
- `packages/web/app/server/routes/__release.ts`
- `packages/web/app/server/routes/__release.test.ts`
- `packages/web/nuxt.config.ts`
- `packages/web/app/pages/admin/attribution/conversions.vue`
- `packages/web/app/pages/admin/attribution/conversions.test.ts`
- `scripts/verify-dev-rehearsal.mjs`
- `scripts/verify-dev-rehearsal.test.mjs`
- `scripts/record-meta-live-verification.mjs`
- `scripts/record-meta-live-verification.test.mjs`
- `.superpowers/sdd/final-remediation-c-report.md`

## 残余风险

- 既有 dev/production Worker 若未通过发布命令注入合法 `RELEASE_COMMIT`，新端点会按设计保持 unhealthy；下一次真实验证必须先完成 API/Web 同 commit 部署。
- 历史 `start_trial` 数据仍保留在 D1 以兼容既有账本，但当前默认归因报表和 readiness 不读取；本组未改 migration 或采集链路。
- 本次仅做本地运行时证明，未访问 Cloudflare 或 Meta 远端资源，真实 dev evidence 仍需在授权运维窗口执行。

## Follow-up：local-runtime 同 commit 修复

整合验证发现 `/api/health` 已要求合法 `RELEASE_COMMIT`，但 local-runtime 仍只注入 `APP_ENV=dev`，导致 Worker 返回 `unhealthy` 并最终等待超时。本轮修复完成：

1. `verify-local-runtime.mjs` 在任何本地 D1 操作前通过 `git rev-parse HEAD` 读取并校验当前 40 位 SHA，测试可通过 `options.getCommit` 注入。
2. Wrangler dev 启动参数新增 `--var RELEASE_COMMIT:<HEAD>`，不使用固定或伪造 SHA。
3. `waitForLocalApi` 同时校验 `status=ok`、`db=ok`、`environment=dev` 和响应 commit 与当前 HEAD 完全一致；端点可达但身份缺失或不匹配时立即失败。
4. 身份失败摘要不包含响应原文；runner 不再把完整 Worker 日志重复写入 notes。进程提前退出或超时仍在步骤摘要中保留经过脱敏和截断的必要诊断。
5. 当前隐私口径下，`consentState=limited` 且 CAPI 关闭时不创建 CAPI delivery；local Meta smoke 已同步验证“没有任何 meta_capi delivery”，不再要求历史 `skipped/disabled` 记录。

验证结果：

- 聚焦 Node tests：PASS，2 suites、31 tests，其中 local-runtime 新增 6 tests。
- 真实 `corepack pnpm verify:local-runtime`：PASS，11 个步骤全部通过；`local-api-health` 确认 `db=ok`、`environment=dev`、commit 与运行时 Git HEAD 一致。
- 通过报告：`reports/release-verification/2026-07-10T09-23-30.718Z-local-runtime-a5eb949bc0f7.json`（按仓库规则忽略，不提交）。
- 未访问远端 D1、Cloudflare 或 Meta，未部署、未推送。
