# Wallet-1 开发环境迁移与验收 Runbook

日期：2026-08-08

适用范围：独立 `dev` D1 `meigallery-db-dev`、API Worker `meigallery-api-dev`

状态：共享 dev 迁移门禁、一次性 D1 + 临时 Worker 功能 smoke 工具与失败恢复均已就绪；所有远程执行 gate 仍关闭，尚未执行 migration、创建隔离资源、写入合成账务数据或开启任何钱包能力

## 1. 目标与非目标

本 Runbook 只负责安全推进 Wallet-1 的开发环境 schema 安装和后续隔离验收。完成 schema 安装也不代表钱包业务获准启用，更不代表可以发布 production。

本阶段不执行：

- production migration、Worker 发布或策略切换；
- `APP_WALLET_ENABLED`、`APP_WALLET_ADMIN_ENABLED` 或任意通知生成开关启用；
- 真实账号余额导入、管理员实际调币、支付、充值、消费、礼物、装扮、转赠、兑换、转账或提现；
- 在共享 dev D1 中直接写入无法普通清理的合成账本数据。

## 2. 当前只读基线

2026-08-08 的只读检查结果：

- dev 待执行 migration 顺序严格为 `0075_app_membership_applications.sql` → `0076_app_in_app_notifications.sql` → `0077_app_wallet_ledger.sql`；
- 当时观察到的 Time Travel bookmark 为 `0000004b-00000000-000050c1-5d3a0b82ee4ac7c4df510c96f93fffee`；
- production/dev 的四个 Wallet-1 运行时变量均保持关闭；
- 未执行 migration、D1 写入、Worker 部署或策略启用。

该 bookmark 只是当时的观察证据，不是未来操作可复用的恢复点。任何获准迁移都必须在同一变更窗口重新读取 bookmark、重新导出 SQL 并生成新的短期 manifest。

## 3. 为什么共享 dev 不能直接做写入 smoke

`0077` 通过 trigger 永久禁止更新或删除 `app_wallet_entries`、`app_wallet_adjustment_events` 和 `app_wallet_review_requests`。这保证了账本证据不可篡改，也意味着测试完成后不能用常规 `DELETE` 完整清理合成调币事实。

因此验收分为两层：

1. 共享 dev 只安装默认关闭的 schema，并执行只读结构、安全策略和空业务账本验收。
2. 加币、扣币、批准、拒绝、并发冲突、完整冲正和通知恢复等写入流程，默认在一次性 D1 + 临时 Worker 中执行；测试后销毁整套隔离资源。

共享 dev 的 Time Travel restore 会覆盖数据库当前状态并中断进行中的查询，不是日常测试清理手段。只有在独占维护窗口、确认无人并发使用、具有新鲜备份和书面变更单时，才能把它作为事故恢复方案。不得为了清理一条测试分录临时恢复共享数据库。

## 4. 执行前决策门禁

在设置任何部署放行变量前，负责人必须书面关闭：

- OQ-018：调币职责、双人复核、数量/频率阈值、负余额、异常处置和对账责任；
- OQ-020：钱包、申请、分录、复核、审计、通知、备份和数据权利的保留/删除边界；
- OQ-024：Cloudflare D1/R2 数据位置、跨境和目标地区适用性。

还必须确认：

- 当前分支为 `dev`，已提交的 tracked worktree 干净；
- 本次只安装 schema，所有 Wallet-1 与 Message-3 运行时开关继续为 `false`；
- 一次性 D1 + 临时 Worker 方案已按 `WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md` 评审，机器 gate 获得有期限的书面批准；
- 变更窗口内没有其他 dev migration 或 D1 写入；
- 操作人知道迁移失败、只读验收失败和 Worker 部署失败分别如何停止，而不是盲目 restore。

## 5. 迁移前备份与短期 manifest

通过仓库根脚本生成：

```bash
corepack pnpm prepare:wallet1:dev
```

脚本会 fail closed，并同时校验：

- 目标只能是 `meigallery-db-dev`，且 dev/production D1 ID 必须隔离；
- 当前 commit、`dev` 分支和 tracked worktree 状态；
- production/dev 钱包运行时开关全部关闭；
- `0075`～`0077` 本地 migration 没有钱包业务 seed；
- 远端待执行 migration 必须恰好是 `0075`、`0076`、`0077`，顺序不得变化；
- 迁移前 SQL 中尚不存在 Wallet-1 schema；
- 当前 Time Travel bookmark 可读取。

SQL 和 manifest 默认写入仓库外的 `~/.meigallery/dev-backups/d1/wallet1`，权限为 `0600`。manifest 保存 SQL SHA-256、字节数、数据库 ID、commit、待执行 migration 和 bookmark，并在 30 分钟后失效。不得把 SQL、manifest、凭证或 Token 提交到 Git。

任何 commit、bookmark、migration 队列、备份文件或 30 分钟窗口变化都会使 manifest 作废；必须重新准备，不能修改 JSON 绕过。

## 6. 受控 dev schema 部署

只有第 4 节已书面关闭且第 5 节刚生成有效 manifest 时，才允许执行：

```bash
ALLOW_WALLET1_DEV_MIGRATIONS=true \
WALLET1_DEV_READINESS_MANIFEST=/绝对路径/到/manifest.json \
./scripts/deploy.sh dev api
```

部署脚本在任何 D1 写入前重新验证 manifest。验证通过后才会按顺序应用 migration、部署 API Worker，并自动执行第 7 节的只读验收。

重要边界：

- 这两个环境变量只放行一次 dev schema 安装，不会打开 Wallet-1 用户端、管理员端或通知生成能力；
- `0077` 仍待执行时，production 部署会被脚本无条件阻断；
- 不允许手工执行 `wrangler d1 migrations apply` 绕过部署门禁；
- migration 应用完成后，旧 manifest 因 migration 队列和 bookmark 已变化而自然失效。

## 7. 迁移后只读验收

部署流程会自动运行，也可独立复核：

```bash
corepack pnpm verify:wallet1:schema:dev
```

只读验收必须同时满足：

- dev `/api/health` 的环境和 commit 与当前仓库一致；
- bootstrap 契约为 `1.10.0`，`wallet=false`、`payments=false`、`systemPush=false`；
- 钱包中的支付、充值、消费、转赠和提现配置全部为 `false`；
- `0075`～`0077` 没有剩余 migration；
- 17 张预期表和 15 个预期 trigger 全部存在；
- development 钱包策略唯一且调币、production-ready、负余额、批量、迁移和三个决策状态全部关闭或未决；
- 钱包、调币申请、分录、申请事件、复核请求均为 0；
- Message-3 没有可生成通知的策略，Wallet-1 事件/模板只处于安全 development 状态，钱包通知 Outbox 为 0。

任何一项失败都停止后续功能验证。由于运行时开关仍关闭，失败不会自动向用户开放钱包；不得为了让验收变绿而直接修改 D1 记录或 Wrangler 变量。

## 8. 一次性环境功能 smoke

一次性环境的创建、完整 HTTP 验收、自动销毁和恢复工具已完成，执行入口为：

```bash
corepack pnpm smoke:wallet1:disposable -- \
  --confirm-disposable=wallet1-isolated-smoke
```

当前机器 gate 保持 `remoteSmokeAuthorized=false`，所以该命令只会 fail closed，不会创建远程资源。未来获得 OQ-018、OQ-020、OQ-024 书面结论、短期授权和当次用户批准后，工具才会：

- 从同一 `origin/dev` commit 创建一次性 D1 并应用完整 migration；
- 部署只绑定该 D1、没有 route/R2/Queue/Email/secret 的临时 Worker；
- 使用三个合成账号覆盖零余额、请求/批准幂等、自批拒绝、独立复核、负余额拦截、拒绝、旧预览冲突、完整冲正、二次冲正拒绝、通知双门禁和不可变 trigger；
- 通过真实 HTTP API 产生账本事实，D1 直连只做策略切换、不可变验证和聚合取证；
- 无论通过或失败都先删除 Worker、再删除 D1；销毁成功后只保留仓库外聚合证据。

完整 16 项验收矩阵、资源命名、30 分钟边界、证据最小化和恢复命令见 `WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md`。测试不会保存访问 Token、fixture SQL、内部备注正文、资源名或 D1 UUID；只有销毁失败时才暂存严格受限的恢复 manifest。

## 9. 失败处理

| 失败点 | 数据状态 | 必须动作 |
|--------|----------|----------|
| manifest 准备或复验失败 | 无远端写入 | 停止，修复原因后重新生成，不复用旧文件 |
| migration apply 失败 | 当前失败 migration 由 D1 回滚；此前已成功 migration 可能保留 | 停止部署，重新列出 migration、核对 D1 与 SQL 备份，不立即打开任何开关 |
| Worker 部署失败 | schema 可能已安装，旧 Worker 仍可能运行 | 保持所有钱包开关关闭，修复 Worker 后重新部署并执行只读验收 |
| 只读验收失败 | schema/Worker 可能不一致，但钱包仍关闭 | 保存失败代码和查询证据，停止后续；由变更负责人决定前向修复或事故恢复 |
| 一次性 smoke 业务失败 | 只存在合成数据 | 工具先删 Worker、再删 D1，只保留聚合失败证据；修复后必须使用新 run ID |
| 一次性资源销毁失败 | 临时 Worker 或 D1 可能残留 | 使用工具输出的严格恢复 manifest/confirm-destroy 命令继续清理，不复用到共享 dev |
| 误写共享 dev 不可变账本 | 普通 DELETE 无法清理 | 立即停止其他写入并升级为事故；不得自行 restore 或篡改 trigger |

D1 每个 migration 失败时会回滚该 migration，但此前成功的 migration 不会自动撤销；迁移状态必须重新读取。D1 Time Travel 会自动维护恢复能力，但 restore 是覆盖性操作。详细行为以 Cloudflare 官方的 [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) 和 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 为准。

## 10. 本阶段完成定义

当前阶段完成于“共享 dev 门禁、一次性功能 smoke、失败恢复、文档和本地测试就绪”。进入任何远端阶段前仍需：

1. OQ-018、OQ-020、OQ-024 有书面最终结论；
2. `WALLET_1_DISPOSABLE_SMOKE_GATE.json` 获得与书面结论一致的短期批准，并先完成一次实际隔离 smoke；
3. 明确变更窗口、操作人、复核人和事故负责人；
4. 重新生成当次有效的 SQL 备份、bookmark 和短期 manifest；
5. 用户再次明确批准执行 dev 远端变更。

未满足以上条件时，正确状态是保留代码和 schema 默认关闭，而不是继续远程部署。
