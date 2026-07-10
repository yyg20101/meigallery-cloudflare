# 最终整分支审查修复组 B 报告

日期：2026-07-10
基线：`7c9a180`
状态：B 组实现与本地验证完成

## 完成项

1. 主 conversion 请求在每次初次发送和重试时实时读取 `marketingConsent.state` 与 `canTrackMarketing`，非 Meta-eligible 状态降级为 `denied` 或 `limited`，且新建 body 不包含 `browserIdentifiers`。
2. Pixel 指令消费前再次检查实时营销授权。授权撤回后即使服务端返回旧指令也不调用 Pixel；Pixel receipt 仍只包含 delivery、attempted 和短期 token，不新增用户标识。
3. analytics compatibility 事件派生 conversion 时固定使用 `consentState=denied`，保留一方转化账本，不创建 Pixel/CAPI delivery 或 Queue 消息。
4. 新增用途隔离的必要转化身份：优先复用合法 analytics ID；否则生成无 PII 随机 `conversion_visitor_*` 和 `conversion_session_*`。仅写入 `sessionStorage` 键 `mg_necessary_conversion_identity_v1`，生命周期随浏览器标签页会话结束，不使用 cookie 或 `localStorage`，不形成长期广告追踪。
5. `/api/conversions/events` 在进入 conversion service 前校验 `visitorId`、`sessionId`，仅接受 8 到 120 位字母、数字、下划线和连字符；空值、缺失、非字符串和非法格式返回 `400 / CONVERSION_ID_INVALID`。

## TDD 记录

- RED Web：授权撤回后的 retry 仍发送 `consentState=granted` 和旧浏览器标识；analytics 关闭时 conversion ID 为空。聚焦测试 2 项按预期失败。
- RED API：4 组空/非法 ID 请求仍返回 201；compatibility granted 事件创建 Meta delivery。聚焦测试 5 项按预期失败。
- GREEN Web：`useConversionTracking.test.ts` 16/16 通过。
- GREEN API：`analytics-ingest.test.ts` 与 `routes/conversions.test.ts` 合计 41/41 通过。

## 验证结果

- Web unit：PASS，44 files、211 tests。
- Web E2E：PASS，80/80，覆盖 360、768、1024、1440 四个 viewport。
- Web Nuxt build：PASS，Nitro preset `cloudflare-module`。
- API B 组聚焦：PASS，2 files、41 tests。
- API `tsc --noEmit`：PASS。
- Web `nuxt typecheck`：BLOCKED，失败来自其他代理新增的 `packages/web/app/server/routes/__release.test.ts` 两处 `H3Event` mock 类型不完整，本组未修改该文件。
- API 完整 suite：BLOCKED，605/621 通过；16 个失败位于其他代理正在修改的 `src/index.test.ts`、`conversions.test.ts`、`meta-capi.test.ts`、`meta-capi-queue.test.ts`，不属于 B 组文件。
- 未运行远端检查、部署或推送。

## 修改文件

- `packages/web/app/composables/useConversionTracking.ts`
- `packages/web/app/composables/useConversionTracking.test.ts`
- `packages/web/app/utils/conversionIdentity.ts`
- `packages/api/src/services/analytics-ingest.ts`
- `packages/api/src/services/analytics-ingest.test.ts`
- `packages/api/src/routes/conversions.ts`
- `packages/api/src/routes/conversions.test.ts`
- `.superpowers/sdd/final-remediation-b-report.md`

## 残余风险

- 浏览器禁用或拒绝 `sessionStorage` 时，必要身份只能保证单次调用随机且无 PII，无法跨页面复用；正常浏览器会话按指定 key 稳定复用。
- 完整 API suite 和 Web typecheck 需待其他修复组完成其未提交实现后统一复跑；B 组聚焦测试、API tsc、Web unit/E2E/build 均已有独立通过证据。
