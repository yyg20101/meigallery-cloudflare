# Task 7：统一 Queue、Outbox、重试、DLQ 和恢复 Cron

状态：审查修复和本地验证已完成。

## 审查 RED 证据

先在正式 `0051_unified_attribution_expand.sql` schema 上补齐终态重复、畸形消息、异常分类、畸形 expiry、四次投递、lease/DLQ 竞态和重叠 Cron 测试。实现前聚焦命令结果：

```text
Test Files 3 failed
Tests 24 failed | 14 passed（38）
```

失败覆盖终态缺 Outbox 被误报、迟到消费者覆盖终态、DLQ 无 fencing、Adapter/D1 异常误分类、非法 expiry 未清理，以及 Queue send 后诊断异常外抛。

## 审查修复产出

- D1 claim 使用读取到的旧 `status`、`attempt_count`、`updated_at` 做 CAS，并生成递增 fencing token；retry、finalize 和 DLQ 只接受 `status='retrying'` 与对应 token，迟到消费者只能 ack。
- `accepted`、`processed`、`rejected`、`dead_letter`、`cancelled` 在 Outbox 一致性检查前处理；重复主消息和 DLQ 静默 ack，不创建 incident、不改变 Delivery 时间。
- 终态统一删除加密 Outbox，但保留已有脱敏 Provider Receipt。该行为是隐私最小化和不可重试终态决策，后续统一归因设计必须同步明确。
- 只有明确永久的 `CredentialVaultError` 才映射为 `credential_invalid`；普通 D1、Adapter、网络异常均 retry。确认损坏或过期的 Outbox 才进入 `rejected`。
- 不可解析的 `expires_at` fail closed；consumer 禁止投递，恢复清理使用 `datetime(expires_at) IS NULL OR ... <= datetime('now')`。
- Fact 事务后的即时入队改为 `Promise.allSettled` best-effort；Outbox 读取、Queue send 和诊断 UPDATE 抛错均不影响已提交请求。
- recovery 对 `planned` 立即 CAS 抢占，仅扫描 stale `queued/retrying`；重叠 Cron 不会重复发送 Queue。
- 含合法 `deliveryId` 的 malformed/extra-field 消息仍定位 Delivery，记录 critical incident 后 ack。
- Queue/Recovery 测试直接加载正式 0051 schema；provider mismatch 使用隔离 read fake，不降低 CHECK、FK 或 immutable trigger。
- Wrangler 预检先静态验证生产 3 producer、6 consumer、主 Queue `max_retries=3`、正确 DLQ、`*/15` Cron 和 dev 空 Queue/Cron，再保留六条远端 `wrangler queues info`。
- 删除旧 `meta-capi-queue`、`tiktok-events-queue`、`queue-message` 模块及三个专属测试；删除旧 `META_CAPI_QUEUE` / `TIKTOK_EVENTS_QUEUE` Bindings，旧 secrets 保留给后续迁移。
- 移除全部 `@ts-nocheck`。

## 验证结果

- Task7 focused：`44 passed`。
- conversions/index focused：`15 passed`。
- Node Queue/dev preflight：`9 passed`。
- 0051 migration：`5 passed`。
- API `tsc --noEmit`：通过。
- Wrangler production dry-run：通过，显示 `AD_META_QUEUE`、`AD_TIKTOK_QUEUE`、`AD_GOOGLE_QUEUE` 三个 producer binding。
- Wrangler dev dry-run：通过，不含 Queue binding。
- Web Nuxt build：通过。

## 全量 Vitest 基线

`corepack pnpm --filter @meigallery/api test` 已执行：

```text
Test Files 118 passed | 9 failed（127）
Tests 1119 passed | 83 failed（1202）
Unhandled Errors 6
```

失败集中在 Task 5 / 0051 后尚未迁移的旧 Meta/TikTok 连接测试替身：假 D1 未提供 `attribution_platform_connections`，旧迁移索引仍写死到 0050，旧状态假对象也未实现新 snapshot 查询。这些失败不在 Task7 Queue/Recovery 写入所有权内；本次 Task7 聚焦、类型、migration、预检和 dry-run 均通过，未通过删除或弱化正式约束掩盖这些基线问题。
