# Task 7：统一 Queue、Outbox、重试、DLQ 和恢复 Cron

状态：最后一项基础设施事件审计修复和本地验证已完成。

## 审查 RED 证据

先在正式 `0051_unified_attribution_expand.sql` schema 上补齐终态重复、畸形消息、异常分类、畸形 expiry、四次投递、lease/DLQ 竞态和重叠 Cron 测试。实现前聚焦命令结果：

```text
Test Files 3 failed
Tests 24 failed | 14 passed（38）
```

失败覆盖终态缺 Outbox 被误报、迟到消费者覆盖终态、DLQ 无 fencing、Adapter/D1 异常误分类、非法 expiry 未清理，以及 Queue send 后诊断异常外抛。

第二轮先新增终态安全校验、同终态 winner 副作用、并发 DLQ 和 setup Queue 回归。实现前结果：

```text
Task7 focused：5 failed | 46 passed（51）
setup：3 failed | 3 passed（6）
registration 正式 0051 schema：8 passed
```

失败准确覆盖 unknown/cross/malformed 消息借终态分支删除 Outbox、两个 DLQ consumer 重复写 incident、expiry 已先 `rejected` 后迟到 finalize 借相同终态写 receipt，以及 setup 仍创建四条旧 Queue。

最后一项先补正式 0051 D1 schema 上的无法定位 Delivery 场景。实现前结果：

```text
Queue runtime：4 failed | 42 passed（46）
0051 migration：1 failed | 5 passed（6）
```

失败准确覆盖 known Queue 空 body、unknown Queue 空 body、缺失或非法 `deliveryId`、unknown Queue 中可识别 provider 被静默 ack 而未写 critical incident，以及 `attribution_incidents.connection_id NOT NULL` 阻止基础设施事件落库。

## 审查修复产出

- D1 claim 使用读取到的旧 `status`、`attempt_count`、`updated_at` 做 CAS；finalize、DLQ 和 expiry 在同一 D1 batch 中写入唯一 fence，delete/receipt/incident 只认当次 fence，最后清成正式错误码。CAS loser 即使看到相同终态和 attempt 也不能产生副作用，batch 任一语句失败则整体回滚。
- 安全校验严格按 expected Queue、body、Delivery row、Delivery/Fact/Connection provider 执行；非终态再要求同 provider Outbox。只有完整校验通过的正常终态重复消息静默 ack 并幂等清理同 provider Outbox。
- unknown Queue、跨平台 Queue 和 malformed body 即使定位到终态 Delivery，也写 critical incident、ack 且不删除 Outbox。
- `attribution_incidents.connection_id` 改为 nullable FK。能够定位 Delivery 的连接级 incident 仍使用该行的 connection/provider；无法定位 Delivery 的基础设施级 incident 使用 `connection_id=NULL`，provider 优先取 expected Queue，其次取消息中可安全识别的 `meta`/`tiktok`/`google`，完全不可识别时使用开放字符串 `system`。
- known/unknown Queue 空 body、缺失或非法 `deliveryId` 和 unknown Queue 可识别 provider 均写 critical incident 后 ack；单条畸形消息不阻塞同批次后续消息。基础设施级 evidence 严格只有 Queue 名，不保存 body、`deliveryId`、token 或用户数据。
- DLQ CAS 同时递增 `attempt_count` 并写唯一 fence，两个 consumer 同读旧 row 只有 winner 写 incident；活动 consumer 的迟到 finalize 不得覆盖 `dead_letter`。
- `accepted`、`processed`、`rejected`、`dead_letter`、`cancelled` 终态统一删除加密 Outbox，但保留已有脱敏 Provider Receipt。`accepted` 仅表示平台接收且服务端发送不可重试，不代表归因成功；后续诊断不保留匹配 Payload。
- 只有明确永久的 `CredentialVaultError` 才映射为 `credential_invalid`；普通 D1、Adapter、网络异常均 retry。确认损坏或过期的 Outbox 才进入 `rejected`。
- 不可解析的 `expires_at` fail closed；consumer 禁止投递，恢复清理使用 `datetime(expires_at) IS NULL OR ... <= datetime('now')`。
- Fact 事务后的即时入队改为 `Promise.allSettled` best-effort；Outbox 读取、Queue send 和诊断 UPDATE 抛错均不影响已提交请求。
- recovery 对 `planned` 立即 CAS 抢占，仅扫描 stale `queued/retrying`；重叠 Cron 不会重复发送 Queue。
- 含合法 `deliveryId` 的 malformed/extra-field 消息仍定位 Delivery，记录 critical incident 后 ack。
- Queue/Recovery 测试直接加载正式 0051 schema；provider mismatch 使用隔离 read fake，不降低 CHECK、FK 或 immutable trigger。
- Registration Fact/Delivery/Outbox D1 测试也改为加载正式 0051 schema，不再维护手写简化表。
- Wrangler 预检先静态验证生产 3 producer、6 consumer、主 Queue `max_retries=3`、正确 DLQ、`*/15` Cron 和 dev 空 Queue/Cron，再保留六条远端 `wrangler queues info`。
- `setup.sh production` 只创建 `meigallery-ad-meta`、`meigallery-ad-tiktok`、`meigallery-ad-google` 及各自 DLQ；setup 测试直接复用 preflight 的六 Queue 清单。
- 删除旧 `meta-capi-queue`、`tiktok-events-queue`、`queue-message` 模块及三个专属测试；删除旧 `META_CAPI_QUEUE` / `TIKTOK_EVENTS_QUEUE` Bindings，旧 secrets 保留给后续迁移。
- 移除全部 `@ts-nocheck`。

## 验证结果

- Task7 focused：`56 passed`。
- conversions/index focused：`15 passed`。
- Node setup/Queue preflight：`12 passed`。
- 0051 migration：`6 passed`。
- API `tsc --noEmit`：通过。
- Wrangler production dry-run：通过，显示 `AD_META_QUEUE`、`AD_TIKTOK_QUEUE`、`AD_GOOGLE_QUEUE` 三个 producer binding。
- Wrangler dev dry-run：通过，不含 Queue binding。
- Web Nuxt build：通过。

## 全量 Vitest 基线

`corepack pnpm --filter @meigallery/api test` 已执行：

```text
Test Files 118 passed | 9 failed（127）
Tests 1127 passed | 83 failed（1210）
Unhandled Errors 6
```

失败数与审查前基线相同，没有新增失败。失败集中在 Task 5 / 0051 后尚未迁移的旧 Meta/TikTok 连接测试替身：假 D1 未提供 `attribution_platform_connections`，旧迁移索引仍写死到 0050，旧状态假对象也未实现新 snapshot 查询。这些失败不在 Task7 Queue/Recovery 写入所有权内；本次 Task7 聚焦、类型、migration、预检和 dry-run 均通过，未通过删除或弱化正式约束掩盖这些基线问题。
