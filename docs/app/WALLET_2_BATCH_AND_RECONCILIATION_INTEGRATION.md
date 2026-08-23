# Wallet-2 批量调币与钱包对账交付基线

App 版本：1.0

状态：Cloudflare 与 Nuxt 开发完成；Wallet-3 已补齐快照恢复与解冻；migration、配置、测试和真实调账后置

## 1. 产品边界

Wallet-2 增加管理员批量调币编排和钱包账本对账，但不改变 Wallet-1 的核心规则：只有追加式分录可以改变余额，所有调币仍由另一位管理员逐单复核，不存在余额直改、批量直接入账或自动修账。

### 批量调币

- 只接受固定七列表头 CSV，最多 200 行、500 KB。
- 预览逐行复用 Wallet-1 账号、金额、原因、余额、钱包状态和业务单号校验，预览不入账。
- 批次内重复业务单号标记为无效项；其他有效项仍可独立提交。
- 总金币绝对额超过治理上限时保留预览证据，但整个批次硬阻断提交，不能只显示风险后继续执行。
- 每个有效行只创建普通 `pending_review` 调币申请，确定性逐行幂等键防止重复创建。
- 提交采用 10 分钟租约与执行令牌；Worker 中断后仅任务创建人可恢复过期任务。

### 钱包对账

- 对比钱包快照、最新 posted 分录和 sequence/前后余额连续性。
- 扫描不直接改余额；发现差异后创建不可变案件证据。
- 只有“单纯余额差异、sequence 一致、金额不超过单笔上限”可创建追加式 forward-fix 调币申请；仍需另一管理员独立复核。
- sequence 差异、分录链断点和超限差额必须进入人工 Runbook。
- 扫描采用 10 分钟租约；同一时刻只允许一个有效扫描，过期或异常任务标记失败并写审计。

## 2. Figma 页面与状态

| 页面 | 状态 | Figma 节点 | 服务端/UI 判定 |
|---|---|---|---|
| `ADM-WAL-05` 批量调币 | 正常 | `159:110550` | 预览/提交正常 |
| `ADM-WAL-05` 批量调币 | 部分成功 | `159:110754` | 无效或提交失败项与成功项并存 |
| `ADM-WAL-05` 批量调币 | 重复项 | `159:110958` | 批次内重复业务单号 |
| `ADM-WAL-05` 批量调币 | 总额异常 | `159:111162` | `TOTAL_AMOUNT_HIGH`，提交硬阻断 |
| `ADM-WAL-06` 对账差异 | 正常 | `159:111365` | 无未解决差异 |
| `ADM-WAL-06` 对账差异 | 钱包冻结 | `159:111569` | 未解决 P0 完整性差异/冻结边界 |
| `ADM-WAL-06` 对账差异 | 差异未解释 | `159:111772` | open/claimed/creating 状态仍未闭环 |

Nuxt 路由分别为 `/admin/app/coin-adjustment-batches` 与 `/admin/app/reconciliation`。Figma 是页面结构、颜色、间距、文字和状态命名的唯一视觉依据。

## 3. 权威数据与状态机

Migration：`0099_app_wallet_batches_and_reconciliation.sql`。

- 批量：控制表、批次、逐行证据、幂等请求；控制默认关闭且开启必须有决策证据。
- 对账：扫描任务、差异案件、不可变事件。
- 批次预览证据、CSV 行证据、对账快照、证据哈希、请求哈希和创建身份不可原地修改。
- 状态机由 D1 trigger 约束，终态和不可变事件禁止更新/删除。
- 批量与扫描租约只解决 Worker 中断恢复，不允许并发执行或绕过调币复核。

## 4. 管理员 API

批量：

- `GET /api/admin/app/wallets/batches`
- `POST /api/admin/app/wallets/batches/preview`
- `GET /api/admin/app/wallets/batches/:batchId`
- `POST /api/admin/app/wallets/batches/:batchId/submit`

对账：

- `GET /api/admin/app/wallets/reconciliation/runs`
- `GET /api/admin/app/wallets/reconciliation/cases`
- `POST /api/admin/app/wallets/reconciliation/scans`
- `POST /api/admin/app/wallets/reconciliation/cases/:caseId/claim`
- `POST /api/admin/app/wallets/reconciliation/cases/:caseId/forward-fix`
- `POST /api/admin/app/wallets/reconciliation/cases/:caseId/verify`
- `GET /api/admin/app/wallets/reconciliation/cases/:caseId/recovery-preview`
- `POST /api/admin/app/wallets/reconciliation/cases/:caseId/recover`

后两条由 Wallet-3 提供：只有 Owner 可以在全部未终结案件由本人认领、不可变分录链完整且预览摘要未变化时，原子重建查询快照、关闭覆盖案件并解冻。完整约束见 `WALLET_3_SNAPSHOT_RECOVERY_INTEGRATION.md`。

批量预览/提交、扫描和 forward-fix 使用幂等键；状态变更使用 `expectedVersion`。对账扫描、认领和处置仅限 Owner。

## 5. 默认关闭与后置验收

- `app_wallet_batch_controls.enabled=0`，不会因 migration 自动开放批量任务。
- Wallet-1 调币与 production-ready 门禁继续生效。
- 当前不执行 `0099`、不改变 Wrangler、不处理真实 CSV、不生成真实调币申请。
- 开发完成后的验证必须覆盖 CSV 注入/引号、重复行、总额上限、部分失败、过期租约恢复、并发扫描、账本链断点、forward-fix 独立复核，以及 Wallet-3 的快照重建、直接解冻阻断和原子回滚。
