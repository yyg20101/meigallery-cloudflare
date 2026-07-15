# Task 7：统一 Queue、Outbox、重试、DLQ 和恢复 Cron

状态：已实现，验证通过，待本地提交。

## RED 证据

先创建 `queue-runtime.d1.test.ts` 与 `recovery.test.ts`，在实现模块前执行：

```text
Cannot find module './queue-runtime'
Cannot find module './recovery'
```

随后实现最小 Queue 消息、D1 租约状态机、DLQ 与恢复扫描，测试转绿。

## 产出

- 三个平台 producer 和对应主 Queue/DLQ consumer，主 consumer `max_retries = 3`。
- Queue 消息固定为 `{ schemaVersion: 1, deliveryId, provider }`，不含密文或用户信号。
- consumer 按六个物理 Queue 映射 provider，发生 Queue、消息、Delivery、Fact、Connection 或 Outbox provider 不一致时终止并写 critical incident。
- D1 Outbox 在终态才删除；429/5xx/网络 retry，4xx/凭据/目标错误拒绝，DLQ 标记 `dead_letter`。
- 使用 `updated_at` 和 `attempt_count` 实现至少一次投递下的租约与超时恢复。
- D1 batch 成功后立即尝试发送 Queue；发送失败不回滚事实或 Outbox，恢复 Cron 接管。
- Cron 改为生产每 15 分钟，UTC `0/15/30/45` 执行 `recoverAttributionOutbox(env, 100)`；dev 保持无 Queue/无 Cron。

## 后续 Task 14

历史 Meta/TikTok Queue 模块与旧类型引用仍保留在仓库中，但 Worker 入口和 Wrangler 不再加载或绑定它们；Task 14 应删除这些历史模块、旧 Queue 相关测试和遗留 Bindings 类型字段。

## 验证

- `vitest run secure-outbox/queue-runtime/recovery`：16 passed。
- `node --test scripts/verify-ad-platform-queues.test.mjs`：4 passed。
- `tsc --noEmit`：通过。
- `vitest run conversions/conversions.d1/index`：14 passed。
- `wrangler deploy --dry-run`：通过，确认三个新 producer binding。
