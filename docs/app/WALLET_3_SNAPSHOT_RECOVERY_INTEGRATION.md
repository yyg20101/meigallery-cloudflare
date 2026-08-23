# Wallet-3 钱包快照重建与受控解冻交付基线

App 版本：1.0

状态：Cloudflare API 与 Nuxt 开发完成；migration、配置、构建、测试和恢复演练统一后置

## 1. 目标与边界

Wallet-3 补齐 Operations-1 保护性冻结与 Wallet-2 对账处置之间缺失的正式恢复闭环。恢复的唯一数据源是 `app_wallet_entries` 不可变分录；命令只把 `app_wallets` 查询快照重建为当前有效分录末态，并在同一原子边界关闭已认领差异、把钱包从 `frozen` 恢复为 `active`。

本切片不提供余额直改、历史分录编辑、自动补账、自动解冻或复核绕过。若不可变分录本身存在 sequence 缺口、前后余额断链或未被已解决 forward-fix 覆盖的链断点，恢复继续 fail-closed，必须升级钱包 Runbook。

## 2. Figma 与页面状态

管理后台继续复用 Figma `ADM-WAL-06`，没有新增 Page ID 或正式状态：

| 状态 | Node ID | Wallet-3 语义 |
|------|---------|---------------|
| 正常 | `159:111365` | 钱包已恢复 `active`，没有未终结差异 |
| 钱包冻结 | `159:111569` | 展示保护性冻结、恢复条件检查与证据输入 |
| 差异未解释 | `159:111772` | 存在未认领、他人认领、处理中或分录链断点 |

页面仍以 Figma 为唯一视觉和状态基线。总量保持 99 个 Page ID、408 个正式状态；Mobile 仍为 50 页、208 状态。

## 3. D1 恢复事实

`0107_app_wallet_snapshot_recovery.sql` 新增：

- `app_wallet_recovery_commands`：Owner、幂等键、请求哈希、案件集合摘要、恢复结论、证据引用、恢复前快照和分录重建末态；只允许 `executing -> applied`。
- `app_wallet_recovery_case_links`：命令覆盖的案件、执行前版本、状态和原始证据哈希；更新与删除均被 trigger 拒绝。
- 钱包快照 trigger：普通余额变化仍必须有同 sequence 的 posted 分录；只有精确匹配的 executing 恢复命令可以把快照跳转到分录末态。
- 钱包状态 trigger：`frozen -> active` 必须存在精确匹配的恢复命令，不能用普通 SQL 或其他业务流程直接解冻。
- 案件状态 trigger：只为恢复命令增加受约束的 `claimed -> resolved`，既有状态机和 `version + 1` 约束保持不变。

命令完成前，数据库再次验证：

1. 钱包已变为 `active`，余额和 sequence 等于命令记录的重建值。
2. 重建值等于当前末条有效分录；无分录时只能为 `0 / 0`。
3. 分录数量与末 sequence 一致，前后余额链没有未解释断点。
4. 覆盖案件数量、版本、证据哈希和负责人均匹配。
5. 同一钱包不存在任何 `resolved / dismissed` 之外的案件。

任一条件不成立，最终状态迁移由 trigger 中止，整个 D1 batch 回滚，不留下已解冻钱包、半关闭案件或假审计。

## 4. 管理 API

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| `GET` | `/api/admin/app/wallets/reconciliation/cases/:caseId/recovery-preview` | Owner | 重读钱包、分录链和全部未终结案件，返回阻断原因与 `caseSetDigest` |
| `POST` | `/api/admin/app/wallets/reconciliation/cases/:caseId/recover` | Owner | 要求 16–128 位 `Idempotency-Key`、锚点版本、预览摘要、恢复结论和证据引用 |

恢复请求只有在以下条件全部成立时执行：

- 钱包当前为 `frozen`。
- 锚点案件为当前 Owner 已认领的 `claimed`，或已经验证的 `resolved`。
- 同钱包所有未终结案件均为当前 Owner 认领的 `claimed`。
- 预览后的钱包快照、分录末态、案件集合、版本和证据没有变化。
- 分录链自身完整；恢复覆盖案件不超过 200 条。

相同管理员、相同幂等键和相同请求返回原命令；同键不同请求返回 `IDEMPOTENCY_CONFLICT`。成功后 API 发布仅含 `wallet` scope 的 Message-4 账号级刷新事件，客户端仍通过 HTTP 重读权威余额。

## 5. Nuxt 交互

`/admin/app/reconciliation` 在既有“钱包冻结”状态内增加受控恢复区：

1. 先执行只读“检查恢复条件”，显示当前快照、分录重建值、覆盖案件数和全部阻断原因。
2. 条件通过后必须填写恢复结论和事件、Runbook、工单或受控证据引用。
3. 二次确认明确展示 `余额 / sequence` 的前后值和覆盖案件数。
4. 成功后刷新案件列表，钱包显示为可用，并展示最近恢复命令引用。

浏览器不会自行计算正确余额，也不能绕过预览摘要；服务端在提交时重新构建同一预览并进行条件写入。

## 6. 审计与隐私

- 钱包恢复写 `app.wallet.recovery.apply`，记录冻结/恢复状态、前后快照、命令 ID、案件集合摘要和证据引用。
- 每个由恢复命令关闭的案件写 `app.wallet.reconciliation.recover_case` 和不可变 `resolved` 事件。
- 通用审计不复制恢复结论正文；正文只保存在受限恢复命令事实中。
- API 不返回内部钱包 ID、用户登录标识、分录备注或其他账号数据。
- 新 Action 仍需按 Audit-3 由两位 Owner 走正式口径治理；代码存在不等于生产 Registry 已发布。

## 7. 当前后置项

- 不执行 `0107`，不修改远端 D1 或 Wrangler 配置。
- 不运行构建、测试、迁移验证、浏览器/模拟器/真机 QA 或截图验收。
- 全部开发结束后必须覆盖：幂等重放、预览过期、并发案件、直接解冻阻断、余额/sequence 快照破坏、空钱包、forward-fix 覆盖断点、真实链断点硬阻断、D1 batch 回滚、审计和 Message-4 刷新。
- 生产启用仍受 OQ-018、OQ-020、OQ-024、钱包 capability、管理员门禁及恢复演练共同约束。
