# Meta CAPI v2 安全交付 S4 报告

## 交付结果

已完成 MetaConnection 绑定、验证和失效机制，并接入 CAPI producer 与 Queue consumer 双门禁。

- MetaConnection 有效性同时绑定 `APP_ENV`、规范化 Pixel ID、Access Token HMAC fingerprint、Graph API `v25.0` 和当前合法 40-char `RELEASE_COMMIT`。
- Pixel ID、token、Graph API 版本或 release commit 变化后立即 fail closed 为 `configuration_changed`，并持久化稳定失效原因。
- Test Event Code 不参与 fingerprint；test mode 仍要求 Test Event Code 非空。
- 未验证连接保留一方 conversion、Analytics 与 Pixel，只创建 `skipped/connection_unverified` CAPI delivery，不创建安全 outbox。
- Queue consumer 在解密/Graph 调用前重新验证连接；连接失效时迁移为 `skipped/connection_unverified`、删除密文并 ack，不进入 Queue 重试。
- `sendMetaCapiEvent()` 在实际 Graph fetch 前再次验证连接并核对 delivery 固化的 tracking mode，直接调用也不能绕过门禁。
- 删除旧的业务 conversion/delivery Test Event bootstrap；dev 改用专用合成 Graph 请求，只使用固定合成 IP、User-Agent、URL 和随机合成 delivery ID。
- dev bootstrap 要求 Owner、`APP_ENV=dev`、test mode、Pixel ID、token、Test Event Code、Queue、严格 canonical 32-byte Base64 data key 和合法 `RELEASE_COMMIT` 全部成立。
- production bootstrap 在任何业务记录、Graph fetch 或 verification upsert 前固定返回 `409 META_PRODUCTION_TEST_GATE_PENDING`。
- 只有 HTTP success 且 `events_received === 1` 才 upsert 当前环境 verification row。
- 普通 test/production CAPI payload 均不再携带 `test_event_code`；该字段只存在于 dev bootstrap Graph 请求。
- 后台只返回 MetaConnection 配置布尔值、状态、验证时间、commit、Graph 版本、质量状态和稳定失效原因，不返回 Pixel ID、token、fingerprint、Test Event Code、payload 或 trace。
- 非 Owner、production gate、配置缺失、Meta 拒绝和成功均写脱敏审计。

## 修改文件

### API 与共享契约

- `packages/api/src/services/meta-connection.ts`
- `packages/api/src/services/meta-connection.test.ts`
- `packages/api/src/services/conversions.ts`
- `packages/api/src/services/conversions.test.ts`
- `packages/api/src/services/meta-capi.ts`
- `packages/api/src/services/meta-capi.test.ts`
- `packages/api/src/services/meta-capi-queue.ts`
- `packages/api/src/services/meta-capi-queue.test.ts`
- `packages/api/src/routes/admin/attribution.ts`
- `packages/api/src/routes/admin/attribution.test.ts`
- `packages/api/src/routes/conversions.test.ts`
- `packages/api/src/index.test.ts`
- `packages/shared/src/types/index.ts`

### Web

- `packages/web/app/composables/useAdminAttribution.ts`
- `packages/web/app/pages/admin/attribution/meta.vue`
- `packages/web/app/pages/admin/attribution/meta.test.ts`

未修改 `.superpowers/sdd/progress.md`。

## TDD 证据

先完成状态转换、release commit、producer/consumer 双门禁、bootstrap 前置阻断和泄密边界测试，再实现代码。

红灯：

- API 首次目标运行：`meta-connection.ts` 尚不存在；其余目标测试出现 12 个行为失败，明确暴露未验证 producer 仍创建 outbox、consumer 仍 fetch、普通 test payload 携带 Test Event Code、production 使用旧错误码、dev bootstrap 读取请求 IP/User-Agent 等旧行为。
- Web 首次目标运行：`meta.test.ts` 3/3 失败，后台尚未区分“已配置/已验证”、未限制 production 验证按钮，也未展示失效状态。

绿灯：

- S4 API 相关：5 个测试文件、167 项测试通过。
- `meta-connection.test.ts`：21 项状态机与安全边界测试通过。
- S4 Web 页面：3 项测试通过。

## 最终验证

- `corepack pnpm --filter @meigallery/api test`：88 个文件、729 项测试通过。
- S4 API 指定测试：5 个文件、167 项测试通过。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`：通过。
- `corepack pnpm --filter @meigallery/web test:unit`：48 个文件、235 项测试通过。
- `corepack pnpm --filter @meigallery/web exec nuxt typecheck`：通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build`：通过，Cloudflare module preset 构建完成。
- `git diff --check`：通过。

## Commit

- 实现提交：`5459abc75ad1ac4fcc50c3c787ad74d3a35e516c`（`feat: 绑定并验证 MetaConnection`）

## 遗留风险与边界

- production bootstrap 按本阶段计划保持硬关闭，必须等待质量运营计划补齐 rollout、incident 和最终 main commit 门禁后另行启用。
- 本次仅使用 mock Graph 响应完成自动化验证，没有使用真实 dev Meta 凭证发起联调；首次实际 dev 验证仍需 Owner 在配置完整后主动执行。
- Dataset Quality 状态沿用 `not_checked`，实际质量采集和权限运营属于后续质量运营阶段。
- 未执行 push、部署或 worktree 操作。
