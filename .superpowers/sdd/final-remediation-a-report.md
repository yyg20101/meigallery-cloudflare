# 最终整分支审查修复组 A 报告

日期：2026-07-10
基线：`7c9a180`
状态：A 组实现与本地验证完成

## 完成项

1. 普通 `Contact`、`Lead`、`CompleteRegistration` delivery 在转化入账 batch 中固化 `tracking_mode`。consumer 只信任 D1 快照：`test` 强制读取 `META_CAPI_TEST_EVENT_CODE`，缺失时写入 `skipped/missing_test_event_code` 且不请求 Graph；`production` 永不附带 `test_event_code`。Owner direct Test Event 同样固定写入 `test`。
2. 新增 `0035_meta_capi_delivery_recovery.sql`，以 `ALTER TABLE` 保留既有 delivery、外键和索引，增加 `tracking_mode`、`queue_enqueued_at`、`queue_attempt_count`、`duplicate_suppressed_at` 及恢复索引。历史数据默认 `disabled`，避免迁移后误投生产或测试事件。
3. 初次 Queue enqueue 在 send 前以 D1 CAS 认领并累计尝试，成功后写 `queue_enqueued_at`；send 失败或成功后标记失败都保留 `pending` 恢复入口。scheduled 每次最多扫描 25 条、仅认领超过 5 分钟的 pending delivery，重投消息使用相同 `deliveryId` 和空 `userData`，不在 outbox 持久化或恢复 fbp、fbc、IP、UA。
4. 缺 Queue binding 时初次入账只写固定 `missing_queue` 诊断并保持 pending；scheduled 缺 binding 时不扫描、不认领。Queue 恢复后可在超时窗口后继续投递。
5. 已 sent delivery 的重复 Queue 消费和 DLQ 回放通过 `duplicate_suppressed_at IS NULL` CAS 与同一 D1 batch 更新日报，同一 delivery 最多增加一次 `duplicate_suppressed`。
6. `verify-meta-resources` 现同时验证 Worker identity、production/dev 主 consumer batch、等待时间、`max_retries=5`、`retry_delay=60`、预期 DLQ，以及 DLQ consumer batch。兼容 Wrangler 4.103.0 的顶层 `script/service` 与嵌套 service 身份，未知 envelope 或任一配置漂移均保守失败。
7. production 新增每 5 分钟 Meta outbox 恢复 Cron，并保留每日 UTC 00:00 完整维护 Cron；dev 按既有隔离策略只启用每 5 分钟恢复。scheduled handler 根据 `event.cron` 分流，五分钟和未知 trigger 只恢复 outbox，每日 trigger 才运行验证码清理、会员提醒、analytics 聚合与 retention。

## TDD 记录

- RED API：模式仍由调用参数控制、缺 Test Event Code 仍请求 Graph、production 可带 test code、delivery SQL 未固化模式、scheduled 恢复函数不存在、Queue 失败被终态化、重复消费日报二次累加。聚焦 60 项中 17 项按预期失败。
- RED 脚本：consumer 重试、延迟、DLQ 和 batch 漂移仍通过；11 项中 2 项按预期失败。
- RED migration：`0035` SQL 尚不存在，专用 SQLite 演练按预期失败。
- RED scheduled 分流：五分钟和未知 Cron 仍执行完整维护，3 项中 2 项按预期失败；每日恢复加聚合行为通过。
- GREEN API：Meta 服务聚焦 59 项通过；API coverage 82 files、629 tests 全绿，组合分支阈值通过。
- GREEN migration/脚本：专用 migration 演练 3 项通过；全脚本 10 suites、104 tests 通过。

## 验证结果

- API coverage：PASS，82 files、629 tests；总分支覆盖率 80.01%，Meta 组合阈值通过。
- API `tsc --noEmit`：PASS。
- Web `nuxt build`：PASS，Nitro preset `cloudflare-module`。
- 脚本完整测试：PASS，10 suites、104 tests。
- 空库 migration：PASS，独立 `--persist-to` 目录从 `0001` 到 `0035` 共 35 个 migration 全部应用成功。
- 0035 数据/索引演练：PASS，旧 delivery 字段、external/status 索引保留，新 recovery 索引存在，新增列默认值符合 fail closed 设计。
- scheduled 分流：PASS，每 5 分钟只恢复、每日恢复加完整维护、未知 Cron 保守只恢复。
- Wrangler dry-run：PASS，production 双 Cron 与 dev 五分钟 Cron 配置可被 Wrangler 正常解析和构建。
- 未运行远端命令、远端 D1、部署或推送。

## 修改文件

- `packages/api/migrations/0035_meta_capi_delivery_recovery.sql`
- `packages/api/migrations/0035_meta_capi_delivery_recovery.test.mjs`
- `packages/api/src/services/conversions.ts`
- `packages/api/src/services/conversions.test.ts`
- `packages/api/src/services/meta-capi.ts`
- `packages/api/src/services/meta-capi.test.ts`
- `packages/api/src/services/meta-capi-queue.ts`
- `packages/api/src/services/meta-capi-queue.test.ts`
- `packages/api/src/index.ts`
- `packages/api/src/index.test.ts`
- `packages/api/wrangler.toml`
- `scripts/verify-meta-resources.mjs`
- `scripts/verify-meta-resources.test.mjs`
- `.superpowers/sdd/final-remediation-a-report.md`

## 残余风险

- 自动恢复 trigger 周期约 5 分钟，实际恢复时效仍受 Cloudflare Cron 调度、Worker 执行、Queue 可用性及单批 25 条上限影响；积压超过单批容量时需要多个周期消化。
- Queue send 已成功但 D1 标记失败时可能产生重复消息。consumer 在本地状态机中跳过已 sent delivery，Meta 侧请求始终复用相同 `event_id`；并发请求仍依赖 Meta 的 event ID 去重语义，这是外部副作用无法与 D1 原子提交的固有限制。
- `0035` 将历史 delivery 的 `tracking_mode` 设为 `disabled` 以 fail closed；若上线前已有未完成历史 pending CAPI delivery，需要运营侧确认后重新创建，而不会由迁移猜测其 test/production 模式。
