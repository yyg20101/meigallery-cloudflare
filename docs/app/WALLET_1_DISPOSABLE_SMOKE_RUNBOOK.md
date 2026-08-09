# Wallet-1 一次性 D1 + 临时 Worker 功能验收 Runbook

日期：2026-08-09

适用范围：Wallet-1 合成数据功能验收，不适用于共享 dev、production 或真实账号

当前状态：工具、自动销毁、恢复收口、30 天聚合证据到期清理和局部决策包已完成；`WALLET_1_DISPOSABLE_SMOKE_GATE.json` 保持 `remoteSmokeAuthorized=false`，尚未创建任何远程 D1、Worker 或账本数据

## 1. 目的

Wallet-1 的分录、申请事件和复核请求由 D1 trigger 保证不可修改、不可删除。共享 `meigallery-db-dev` 因此只适合安装默认关闭的 schema 和执行空账本只读验收，不适合写入合成功能数据后再用普通 `DELETE` 清理。

本 Runbook 定义一个完整隔离、可追踪、失败后可恢复销毁的功能验收环境：

```text
同一 dev commit
  ├─ 一次性 D1：完整 migration + 3 个合成账号 + 合成钱包事实
  └─ 临时 API Worker：仅 workers.dev + 仅绑定该 D1
       └─ HTTP 验收完成或失败
            ├─ 先删除临时 Worker
            ├─ 再删除一次性 D1
            └─ 仓库外只保留聚合证据
```

它不安装共享 dev schema，不部署 Web，不访问 R2/Stream/Queue/Email，不导入真实用户或余额，也不授权 production 或商业交易能力。

## 2. 资源与权限边界

每次运行生成 12 位随机后缀，资源名只能匹配：

- D1：`mei-w1-db-YYYYMMDD-<12 hex>`；
- Worker：`mei-w1-api-YYYYMMDD-<12 hex>`；
- 运行 ID：`wallet1-smoke-<UTC timestamp>-<12 hex>`。

临时 Worker 配置在仓库外动态生成，固定约束如下：

- `workers_dev=true`，没有 custom domain、route、Cron 或 preview URL；
- 只存在一个 `DB` binding，且数据库名与 UUID 来自当次新建 D1；
- 不存在 R2、Queue、Durable Objects、Service binding、Email binding 或任何 secret；
- Auth 只用于预置 Bearer 会话，注册和 Turnstile 均关闭；
- 只开启 Wallet-1 与站内通知的临时运行时能力，会员、消息和安全能力关闭；
- 支付、充值、消费、礼物、装扮、转赠、兑换、转账和提现始终不存在；
- `APP_ENV=dev`、`RELEASE_COMMIT` 必须与 `origin/dev` 当前 commit 完全一致。

脚本对 `meigallery-api`、`meigallery-api-dev`、`meigallery-db`、`meigallery-db-dev` 及 production/dev R2 名称设置拒绝规则。销毁命令同样只接受上述一次性名称格式，不能把任意 manifest 改成共享资源后执行。

## 3. 三层执行门禁

远程运行必须同时通过三层门禁，缺少任意一层都会在第一个远程命令前退出：

### 3.1 书面决策与短期授权

机器可读门禁为 `docs/app/WALLET_1_DISPOSABLE_SMOKE_GATE.json`，当前故意保持关闭。局部推荐、适用范围和两步确认文本见 `WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md`。正式批准时必须由责任人基于书面结论同步：

- OQ-018：仅合成数据验收仍强制另一管理员复核、禁止负余额、禁止批量调币，并明确异常处置人；
- OQ-020：运行数据随 D1 销毁，仓库外只保留 30 天聚合证据，不保留 Token、fixture SQL、内部备注或逐笔业务数据；
- OQ-024：明确一次性 D1 的 `location` 或 `jurisdiction`，脚本不猜测位置；
- `authorization`：scope 必须为 `wallet1_disposable_synthetic_smoke`，包含审批人、批准时间和不超过 24 小时的失效时间；
- `resourcePolicy.maximumLifetimeMinutes`：5～30 分钟。

门禁 JSON 是执行输入，不是决策依据。不得仅为了运行脚本自行把 `unresolved` 改为 `approved`；必须先在开放问题记录中保存对应书面结论和责任人。

### 3.2 Git 与工作区

运行时必须同时满足：

- 当前分支为 `dev`；
- tracked worktree 干净；
- 本地 `HEAD` 为 40 位 commit；
- 本地 `HEAD == origin/dev`。

未跟踪的个人文件不参与远程制品，但任何被 Git 跟踪的未提交变更都会阻断。运行前仍需确认该 commit 的 CI 已通过；脚本不把 Git commit 本身当作审批替代品。

### 3.3 当次显式确认

在书面门禁和 Git 门禁均通过后，还必须由用户再次批准本次 Cloudflare 远程创建/部署/销毁操作，并显式提供：

```bash
corepack pnpm smoke:wallet1:disposable -- \
  --confirm-disposable=wallet1-isolated-smoke
```

当前执行该命令只会返回 `WALLET1_SMOKE_GATE_NOT_AUTHORIZED`，不会创建远程资源。

## 4. 自动执行顺序

获准后，单次运行严格执行：

1. 读取并验证 gate、`dev` 分支、tracked 状态和 `origin/dev` commit。
2. 在仓库外 `~/.meigallery/wallet1-disposable-smoke/runs/<runId>` 写入 `0600` 恢复 manifest。
3. 使用已批准的 `--location` 或 `--jurisdiction` 创建一次性 D1。
4. 通过 `wrangler d1 info --json` 读取实际 UUID，不解析人类可读创建输出。
5. 生成只绑定该 D1 的临时 Worker JSON 配置。
6. 对空 D1 应用仓库完整 migration 队列，并确认无剩余 migration。
7. 生成 3 个合成账号：观看者、调币发起管理员、独立复核管理员。
8. fixture SQL 只包含 Token SHA-256；执行后立即删除本地 SQL 文件。
9. 部署临时 API Worker，并只接受与当次 Worker 名完全匹配的 `workers.dev` URL。
10. 等待 `/api/health` 返回同一 commit 后执行第 5 节功能验收。
11. 无论通过或失败，都先删除 Worker，再删除 D1。
12. 两项销毁成功后删除运行目录，只保留带 30 天 `deleteAfter` 的第 6 节聚合证据。

30 分钟是操作门禁和脚本阶段检查，不是 Cloudflare 自动 TTL。如果进程被强制结束、电脑断电或网络在销毁时中断，操作人必须使用第 7 节恢复命令；不得假设资源会自动消失。

## 5. 功能验收矩阵

| ID | 验收项 | 通过标准 |
|----|--------|----------|
| W1-SMOKE-01 | Release/契约 | health 为 `dev` 且 commit 一致；bootstrap 为 `1.10.0` |
| W1-SMOKE-02 | 商业边界 | wallet/notification 可用于测试；支付、充值、消费、转赠、兑换、提现和系统推送均关闭 |
| W1-SMOKE-03 | 虚拟零余额 | 首次 GET 返回 0/sequence 0，不创建钱包或分录 |
| W1-SMOKE-04 | 管理账号查询 | 稳定 App account ID 可查询，验证真实 migration 的 `account_id` 契约 |
| W1-SMOKE-05 | 申请预览 | 加币 100 的前后余额正确，仅出现“未决策略全部复核”风险 |
| W1-SMOKE-06 | 请求幂等 | 同键同请求重放原申请，不创建第二条申请 |
| W1-SMOKE-07 | 职责分离 | 发起人自批返回 `SELF_REVIEW_FORBIDDEN` |
| W1-SMOKE-08 | 独立批准 | 另一管理员批准后生成一条 posted 分录，余额和 sequence 同步前进；批准重放不重复入账 |
| W1-SMOKE-09 | 负余额 | 扣除 101 的预览不可提交，创建返回 `NEGATIVE_BALANCE_FORBIDDEN` |
| W1-SMOKE-10 | 拒绝 | 拒绝追加申请事件和复核事实，不创建分录，不改变余额 |
| W1-SMOKE-11 | 旧预览冲突 | 两个申请基于同一 sequence；第一笔生效后第二笔返回 `WALLET_BALANCE_CHANGED` |
| W1-SMOKE-12 | 完整冲正 | 原加币按同数量反向生成新分录；第二次冲正被拒绝 |
| W1-SMOKE-13 | 通知关闭边界 | 通知策略关闭期间已生效分录不产生钱包 Outbox |
| W1-SMOKE-14 | 必要通知 | 仅在一次性 D1 开启 development 通知策略后，新补偿分录生成本人通知；文案不含内部备注 |
| W1-SMOKE-15 | 账本不可变 | 对已生效分录执行 UPDATE/DELETE 均由 D1 trigger 拒绝 |
| W1-SMOKE-16 | 聚合完整性 | 最终余额 15、sequence 4、4 条分录、6 条申请；余额链无断点、自批为 0、审计和通知数量符合预期 |

所有钱包业务事实都必须通过临时 Worker 的真实 HTTP API 产生。D1 直连只允许：开启一次性 development 策略、验证不可变 trigger、读取聚合证据；不得用 SQL 直接插入或修补账本分录。

## 6. 数据与证据最小化

原始凭证只存在于 Node.js 进程内存：

- App access/refresh Token 和两个管理员 session Token 不写入 manifest、日志或证据；
- fixture SQL 只保存 Token 哈希，权限为 `0600`，seed 命令结束即删除；
- 不创建真实邮箱、真实账号、真实金额、真实业务单或真实内部备注；
- 成功或业务失败且资源已清理时，运行目录整体删除。

短期证据位于 `~/.meigallery/wallet1-disposable-smoke/evidence/<runId>.json`，固定保留 30 天，只包含：

- gate SHA-256、commit、批准的数据位置；
- 测试项布尔结果；
- 钱包余额、sequence、分录/申请/审计/通知数量；
- Worker/D1 是否已删除；
- 资源名组合的 SHA-256，不保存资源名或 UUID。

每份证据都包含 `retention.days=30` 和确定的 `retention.deleteAfter`。到期后执行：

```bash
corepack pnpm cleanup:wallet1:evidence -- \
  --confirm-prune=wallet1-expired-evidence
```

清理器只删除严格匹配且已经到期的 evidence JSON；未知、损坏、被改名或符号链接文件会阻断本次清理。该命令不读取、修改或删除仍用于残留资源恢复的运行 manifest。

证据不构成 production 决策，也不能代替 OQ-018、OQ-020 或 OQ-024 的最终结论。

## 7. 失败与恢复销毁

正常异常由脚本的 `finally` 自动清理。只有 Worker 或 D1 删除失败时，仓库外运行 manifest 才会保留，并输出不含凭证的恢复命令：

```bash
corepack pnpm cleanup:wallet1:disposable -- \
  --manifest=/绝对路径/manifest.json \
  --confirm-destroy=<runId>
```

恢复销毁成功后会生成同样受 30 天期限约束的聚合证据并删除运行目录。恢复流程具有以下保护：

- 不依赖已过期或后来重新关闭的执行 gate，避免“失去授权后反而不能清理资源”；
- manifest 必须在仓库外且不能是符号链接；
- run ID、D1 名、Worker 名和随机后缀必须相互一致；
- 只接受一次性资源状态和 UUID 格式；
- 删除顺序仍为 Worker → D1；资源已不存在时按幂等成功处理。

| 失败点 | 自动动作 | 人工动作 |
|--------|----------|----------|
| gate/Git/确认失败 | 无远程命令 | 修复决策或工作区，不修改脚本绕过 |
| D1 创建失败 | 不继续部署 | 核对 Cloudflare 控制台是否出现同名 D1；不删除未知资源 |
| migration/seed 失败 | 删除已确认创建的 D1 | 检查 migration 错误；不得切到共享 dev 继续 |
| Worker 部署或 HTTP 验收失败 | 尝试删除 Worker，再删除 D1 | 查看聚合失败代码；修复后使用全新 run ID |
| Worker 删除失败 | 仍尝试删除 D1，并保留 manifest | 使用恢复命令；确认 Worker 不再可访问 |
| D1 删除失败 | 保留 manifest | 使用恢复命令；在 Cloudflare 控制台复核 UUID 后升级处理 |

不得通过删除 immutable trigger、直接 DELETE 分录或恢复共享 dev 数据库来“修复”一次性 smoke。

## 8. 与共享 dev 迁移的关系

一次性 smoke 和共享 dev schema 安装是两个独立变更：

- 一次性 smoke 先证明完整 migration 在空 D1 可安装、真实 HTTP 业务闭环可运行、资源可销毁；
- 共享 dev 仍保持 Wallet/Notification 运行时开关关闭，只执行 schema 安装和空账本只读验收；
- 一次性 smoke 通过不自动授权 `ALLOW_WALLET1_DEV_MIGRATIONS=true`；共享 dev 仍需新鲜备份、Time Travel bookmark、30 分钟 readiness manifest 和当次明确批准；
- 任一阶段都不授权 production migration、真实余额导入或钱包开放。

共享 dev 操作见 `WALLET_1_DEV_VALIDATION_RUNBOOK.md`，完整产品与技术边界见 `WALLET_1_LEDGER_INTEGRATION.md`。

## 9. 本阶段完成定义

当前代码阶段完成条件：

- gate 默认关闭且未经批准不能触发第一个远程命令；
- 临时配置不引用共享 Cloudflare 资源或 secret；
- 成功与功能失败路径都验证 Worker → D1 清理顺序；
- 销毁失败存在严格、幂等、仓库外恢复路径；
- W1-SMOKE-01～16 均有自动断言；
- fixture 与证据不包含明文凭证；
- 脚本测试、API 测试、类型检查和 Web 构建通过。

远程验收不属于本阶段完成条件。只有 `WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md` 的局部结论获明确确认、gate 获得最长 24 小时批准、CI 通过且用户再次批准 Cloudflare 远程变更后，才能进入实际运行阶段。全局 OQ-018、OQ-020、OQ-024 仍可保持未决，但不得把局部批准外推到共享 dev 或 production。

Cloudflare 命令和位置选项以当前官方文档为准：[D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)、[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、[D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)。
