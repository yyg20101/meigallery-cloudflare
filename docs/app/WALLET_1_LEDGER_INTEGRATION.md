# Wallet-1 金币账本跨仓交付基线

App 版本：1.0

App API：v2 / `1.10.0`

日期：2026-08-08

状态：代码闭环、本地验证、dev 迁移前备份门禁与迁移后只读验收工具完成；production/dev 默认关闭；未执行远端 migration、真实余额导入、远程联调或生产发布

## 1. 本阶段目标

Wallet-1 建立“管理员申请 → 另一管理员独立复核 → D1 原子追加分录 → 钱包权威快照 → 用户只读余额/明细 → 必要站内通知”的最小闭环。它只解决当前明确需要的管理员加币、扣币、补偿与纠错，不提前开放商业交易能力。

不可改变的边界：

- 金币是平台封闭式整数记账单位，不是法币、储值账户、加密资产或可提现收益。
- 用户只能读取本人余额与已生效分录；待复核、拒绝、冲突或失败申请不会进入用户账本。
- 用户端没有充值、支付、消费、礼物、装扮购买、转赠、兑换、转账、提现或申诉入口。
- 管理员不能直接修改余额、编辑/删除分录、批量调币、自动修账、导入旧余额或绕过独立复核。
- OQ-018 尚未关闭，因此本阶段所有单笔申请都强制另一管理员复核；不存在“低风险直接生效”。
- production 与 dev 的运行时开关均保持关闭；migration 也不会创建账号钱包、导入余额或开启策略。

## 2. 权威数据模型

Migration：`0077_app_wallet_ledger.sql`。

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_wallet_policies` | 版本化钱包与调币策略 | 初始为 development；调币、production-ready、风险/保留/数据位置结论全部关闭或未决 |
| `app_wallets` | 每账号一个余额快照 | 账号唯一；整数非负余额；sequence 单调；不由读取创建 |
| `app_wallet_adjustments` | 单笔调币申请 | 业务引用唯一；请求幂等；保存预览余额/sequence；发起人与复核人分离 |
| `app_wallet_entries` | 已生效权威分录 | 每申请最多一条；钱包 sequence 唯一；前后余额可验证；UPDATE/DELETE trigger 永久禁止 |
| `app_wallet_adjustment_events` | 申请状态追加事件 | 记录申请、入账、拒绝和旧预览冲突；不可编辑或删除 |
| `app_wallet_review_requests` | 复核幂等事实 | 复核人 + 幂等键唯一；保存请求哈希、决定和结果；不可编辑或删除 |

钱包快照是读取优化，但不能独立表达业务变化。`trg_app_wallet_balance_requires_entry` 要求余额和 sequence 每次只前进一步，并且已经存在与该次变化完全匹配的 posted 分录；否则 D1 拒绝更新。

读取从未产生过分录的账号时，服务端返回余额 `0`、账本版本 `0` 和正常状态，但不会插入 `app_wallets`。这避免页面浏览制造业务事实，也为未来迁移保留明确起点。

## 3. 调币动作与固定原因

| actionType | direction | 使用场景 | 本阶段限制 |
|------------|-----------|----------|------------|
| `admin_credit` | `credit` | 管理员明确加币 | 正整数、独立复核 |
| `admin_debit` | `debit` | 管理员明确扣币 | 正整数、不得负余额、独立复核 |
| `compensation` | `credit` | 服务补偿 | 正整数、独立复核 |
| `reversal` | 与原分录相反 | 纠正一条已生效分录 | 只允许一次完整冲正，不支持部分冲正 |

固定原因代码为 `manual_adjustment`、`service_compensation`、`correction` 和 `reversal`。用户 API 与通知只使用固定原因标签和受控业务引用；内部备注只在管理员受控详情中可见，不进入用户响应、通知正文、通用日志或分析事件。

当前余额永不允许小于零。未来若 OQ-018 产生不同结论，也必须通过新策略版本、migration 和独立验收变更，不能直接修改 development 记录或客户端常量。

## 4. 单笔申请与独立复核

### 4.1 申请流程

```text
管理员查找并确认账号
→ 服务端读取账号状态、余额和 sequence
→ 选择加币/扣币/补偿/完整冲正并填写依据
→ 服务端预览方向、数量、前后余额和风险代码
→ 使用 Idempotency-Key 创建 pending_review 申请
→ 余额和用户明细保持不变
```

同一管理员、路由和幂等键绑定规范化请求哈希；同键同请求返回原申请，同键不同请求返回 `IDEMPOTENCY_CONFLICT`。业务引用也唯一，不能用新幂等键重复创建同一业务调币。

### 4.2 复核流程

```text
另一管理员读取待复核申请
→ 核对账号、发起人、原因、前后余额和风险代码
→ 批准或拒绝，并使用独立 Idempotency-Key
→ 批准时重新校验账号、钱包状态、余额和 sequence
→ 同一 D1 条件批次追加分录、更新快照、记录复核和审计
→ 成功后用户余额/明细可见，并按通知策略写入 Outbox
```

- 发起人批准自己的申请时服务端直接拒绝，不能靠前端隐藏按钮代替授权。
- 预览后余额或 sequence 已变化时，申请保持待复核并记录 `wallet_changed`；复核人必须刷新并重新发起，不能沿用旧预览。
- 拒绝只追加复核和申请事件，不创建钱包或分录。
- 批准成功以权威分录和钱包快照同时一致为准；仅有“已批准”状态不能视为入账。
- 冲正保留原分录，并创建方向相反、数量相同、双向可查询的新分录；同一原分录不能再次冲正。

## 5. 用户 App API

所有接口要求有效 Auth-1 Bearer 会话、`X-Contract-Version: 1.10.0`，响应使用 `Cache-Control: no-store`。

| 方法 | 路径 | 责任 |
|------|------|------|
| GET | `/api/v2/me/wallet` | 本人权威余额、账本版本、最后入账/同步时间和边界说明 |
| GET | `/api/v2/me/wallet/entries` | 按 `all`、`credit`、`debit` 游标分页查询本人已生效分录 |
| GET | `/api/v2/me/wallet/entries/:entryId` | 本人分录详情、前后余额、安全业务引用及原分录/冲正关系 |

游标绑定账号与方向，不能跨账号或跨筛选复用；非法 ID、其他账号分录和不合法游标统一按安全错误处理。客户端不从列表本地求和，也不把通知中的历史数量当作当前余额。

Bootstrap 只有在 Auth、运行时钱包开关、policy ID 和 D1 策略全部满足时才返回 `capabilities.wallet=true`。钱包配置固定：

- `currencyCode=mei_coin`
- `displayName=金币`
- `minorUnit=0`
- 方向只有 `credit`、`debit`
- `payments/recharge/spending/transfer/withdrawal` 全部为 `false`

任何未知方向、原因、状态、稳定 ID、时间、余额关系、冲正关系或交易开关矛盾都必须使客户端拒绝该响应或关闭入口，不能扩大权限。

## 6. 管理员 API 与 Nuxt 工作台

当前过渡路由使用受现有 admin+ Web 会话保护的 `/api/admin/app/wallets`：

| 方法 | 路径 | 责任 |
|------|------|------|
| GET | `/accounts` | 按稳定账号 ID、邮箱或昵称查找并返回脱敏摘要 |
| GET | `/accounts/:accountId` | 钱包摘要、最近分录和相关申请；敏感读取审计 |
| POST | `/adjustments/preview` | 服务端预览单笔动作和风险，不写业务事实 |
| POST | `/adjustments` | 幂等创建待复核申请 |
| GET | `/adjustments` | 按受控状态读取复核队列 |
| GET | `/adjustments/:adjustmentId` | 读取单笔申请详情 |
| POST | `/adjustments/:adjustmentId/approve` | 另一管理员幂等批准并尝试原子入账 |
| POST | `/adjustments/:adjustmentId/reject` | 另一管理员幂等拒绝 |

Nuxt 页面 `/admin/app/wallets` 提供账号确认、余额摘要、分录、申请、预览、二次确认和复核队列。窄屏操作区允许换行/全宽，不使用横向溢出的固定按钮组。页面明确展示默认关闭、强制独立复核与禁止交易边界。

本阶段没有细分财务角色，沿用现有 admin/owner 认证域；因此 production 启用前必须把职责分离、强认证、人员范围和紧急操作 Runbook 作为 OQ-018 的一部分书面确认，不能把“两名普通管理员可操作”直接视为正式财务权限模型。

## 7. 站内通知集成

`0077` 激活 Message-3 已预留的 `wallet.entry_posted` 必要通知定义，增加 development 模板和分录 trigger。只有通知策略 `generation_enabled=1` 且事件定义有效时才会写入 Outbox；Wallet-1 与 Message-3 默认开关均关闭，所以 migration 本身不会发送通知。

投递服务在生成用户通知时重新读取本人分录，并从方向、整数数量和固定原因构造安全文案：

- 不复制 `userVisibleNote`、内部备注、业务原始工单或管理员身份。
- 目标必须是当前账号本人且分录仍为 posted。
- action 只允许 `open_wallet_entry`，打开后重新请求权威详情与余额。
- 通知失败不回滚分录或钱包；Outbox 恢复仍使用 Message-3 的防重和重试规则。

## 8. KMP 客户端

- “我的”页仅在严格 wallet capability 可用且用户已登录时显示金币入口。
- 钱包页覆盖加载、未登录、不可用、错误、零余额、空明细、全部/增加/扣减筛选、分页和详情状态。
- 余额卡明确说明金币不可购买、消费、转赠、兑换或提现；页面没有任何交易 CTA 或未来功能占位按钮。
- 分录详情展示固定原因、用户安全业务单号、前后余额和完整冲正关系，不显示内部说明或管理员信息。
- `open_wallet_entry` 通知动作先进入钱包，再重新拉取指定分录；目标失效时显示安全错误，不使用通知快照代替详情。
- 所有请求复用 Auth-1 的 Bearer 单航班续期与会话失效清理；capability 关闭时零网络请求。

## 9. 运行开关与启用门禁

| 变量 | 含义 | 当前 production/dev |
|------|------|---------------------|
| `APP_WALLET_ENABLED` | 用户余额与明细能力 | `false` |
| `APP_WALLET_ADMIN_ENABLED` | 管理员单笔调币工作台 | `false` |
| `APP_WALLET_POLICY_VERSION` | 选择钱包策略 | development ID，仅配置不启用 |
| `APP_WALLET_PRODUCTION_READY` | production 额外门禁 | `false` |

启用前必须完成：

1. 关闭 OQ-018，书面确认调币角色、双人复核、数量/频率阈值、负余额、异常处置、对账责任和紧急操作。
2. 关闭 OQ-020，明确钱包、申请、分录、复核、审计、通知和备份的保留、删除与数据权利边界。
3. 关闭 OQ-024，确认 Cloudflare D1/R2 相关数据位置和生产适用性。
4. 新建 published 且 production-ready 的策略版本，不原地提升 development 记录。
5. 按 `WALLET_1_DEV_VALIDATION_RUNBOOK.md` 在共享 dev 完成仓库外备份、短期 manifest、默认关闭的 schema 安装和只读验收；写入型功能 smoke 必须在一次性 D1 + 临时 Worker 中完成并销毁整套资源，不能依赖 `DELETE` 清理不可变账本。
6. 完成 Android/iOS 真机、多设备、断网、恢复、大字体、屏幕阅读器、窄屏和长中文验收。
7. 先开启管理员只读观察，再按书面变更单开启单笔写入和用户读取；production 需独立审批，不能从 dev 自动复制。

任何门禁未关闭时都继续 fail closed。不得通过手工修改 D1 策略、临时环境变量、前端显隐或直接 SQL 写余额绕过。

## 10. 验证记录与未完成项

已验证：

- migration 默认关闭、无钱包/余额/调币 seed、无旧数据回填、无批量或自动清理。
- 空钱包读取不写表、扣币不产生负余额、待复核不改变余额、发起人不能自批。
- 请求与复核幂等、同键异请求冲突、业务引用唯一、旧预览冲突不产生分录。
- 一次完整冲正、原分录/冲正关系、钱包 sequence、分录/申请事件/复核记录不可变。
- 账号与游标隔离、用户响应最小化、钱包必要通知目标归属和固定安全文案。
- App API 路由/OpenAPI、Nuxt 管理页面、KMP 三条授权请求、capability 关闭零请求和非法响应安全拒绝。
- API 125 个测试文件/989 项、Web 60 个测试文件/301 项和脚本 51 项全量通过；lint、API TypeScript、Web Vue TypeScript、Nuxt production build 与 API Worker dry-run build 通过。
- KMP Android Host Test、Debug APK 与 iOS Simulator Kotlin/Native 编译通过；本机 Framework 链接仅因未接受 Xcode 许可导致 `xcrun` 69 失败，正式结果由 macOS CI 门禁确认。
- `prepare-dev-wallet1.mjs` 已实现 dev 目标、资源隔离、关闭开关、migration 顺序、仓库外 SQL、SHA-256、Time Travel bookmark、commit 和 30 分钟 manifest 复验；`deploy.sh` 在 `0077` 待执行时对 production 硬阻断，dev 必须显式放行并提供有效 manifest。
- `verify-dev-wallet1-schema.mjs` 已实现迁移后只读验收：校验部署 commit、`1.10.0` 契约、关闭 capability、完整 schema/trigger、development 安全策略、空业务账本和零钱包通知 Outbox。

尚未完成：

- dev/production `0077` migration、远程 Worker 部署、真实 HTTP smoke、真机 UI 和双管理员实际账号验收；共享 dev 当前只允许未来执行默认关闭的 schema/只读验收，写入 smoke 尚待一次性 D1 + 临时 Worker 方案。
- OQ-018、OQ-020、OQ-024、正式财务权限、告警阈值、对账/事件处置/恢复 Runbook。
- 真实余额导入、旧系统迁移、批量调币、部分冲正、用户申诉、客服工单、自动对账与导出。
- 充值、支付、消费、礼物、装扮购买、转赠、兑换、转账、提现和任何 production 商业化能力。

dev 的完整执行顺序、失败处理与恢复边界见 `docs/app/WALLET_1_DEV_VALIDATION_RUNBOOK.md`。
