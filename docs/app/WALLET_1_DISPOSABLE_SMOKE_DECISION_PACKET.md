# Wallet-1 一次性合成数据 Smoke 局部决策包

日期：2026-08-09

状态：推荐方案已完成技术评审，等待项目 Owner 明确确认；未授权远程执行

适用范围：仅限 `wallet1_disposable_synthetic_smoke`，不适用于共享 dev、production、真实账号、真实余额或商业交易

## 1. 决策边界

本文件只为一次性 D1 + 临时 Worker 的合成功能验收提供可执行结论，不关闭全局 OQ-018、OQ-020、OQ-024：

- 全局 OQ-018 仍需财务与安全负责人冻结 production 调币角色、金额/频率阈值、对账和异常处置；
- 全局 OQ-020 仍需隐私、法务与安全负责人决定真实账号、消息、账务、安全证据和备份的分类保留期；
- 全局 OQ-024 仍需结合首发地区、运营主体、跨境和 Cloudflare 合同形成生产结论。

本局部决策一旦超出合成数据、一次运行或一次性资源范围立即失效，不能复制到共享 dev 或 production。

## 2. OQ-018-SMOKE：调币内控

推荐结论：批准以下仅用于合成 smoke 的保守规则。

| 项目 | 局部结论 |
|------|----------|
| 操作身份 | 仅使用脚本生成的观看者、调币发起管理员、独立复核管理员三个合成身份 |
| 职责分离 | 所有申请必须由不同管理员身份复核；发起身份自批必须失败 |
| 负余额 | 任何场景均禁止；预览和提交分别验证 |
| 批量调币 | 禁止；只允许固定验收矩阵内的单笔请求 |
| 数量边界 | smoke 最大单笔测试值为 101 金币；`0077.max_single_amount=1000000` 只是 schema 技术上限，不是已批准业务阈值 |
| 频率边界 | 单次运行固定产生 6 条申请、4 条生效分录，不开放循环、随机压测或外部输入 |
| 异常处置 | 任一断言失败立即停止业务步骤，先删 Worker、再删 D1；不得直接 SQL 修账、删除 trigger 或转写共享 dev |
| 责任 | 当次执行人为操作责任人；项目 Owner 为升级与残留资源处置责任人 |

该结论验证的是实现能否执行职责分离、幂等、负余额拦截、冲正和不可变账本，不代表正式财务权限已经建立。

## 3. OQ-020-SMOKE：数据与证据保留

推荐结论：批准以下最小化与确定性删除规则。

| 数据 | 保存位置 | 保留规则 |
|------|----------|----------|
| App/Admin 原始 Token | 仅 Node.js 进程内存 | 进程结束即消失，不写日志、manifest 或证据 |
| 合成 fixture SQL | 仓库外运行目录，权限 `0600` | seed 命令结束立即删除；只含 Token SHA-256 |
| 合成账号、钱包、申请、分录、通知 | 当次一次性 D1 | 成功或失败均销毁整个 D1，不逐表清理 |
| 临时 Worker | Cloudflare 账户 | 功能步骤结束后优先删除；不得复用 |
| 恢复 manifest | 仓库外运行目录，权限 `0600` | 仅在资源销毁未完成时保留；恢复销毁成功后删除运行目录 |
| 聚合证据 | 仓库外 evidence 目录，权限 `0600` | 固定保留 30 天，包含 `deleteAfter`；不含资源名、UUID、Token、SQL、逐笔正文或内部备注 |

到期聚合证据使用以下显式命令清理：

```bash
corepack pnpm cleanup:wallet1:evidence -- \
  --confirm-prune=wallet1-expired-evidence
```

命令只读取专用 evidence 目录中格式严格匹配的 JSON，只删除 `deleteAfter` 已到期的文件；未知、损坏或符号链接文件会 fail closed。未清理完成的资源恢复 manifest 不参与定时证据删除。

该 30 天结论只适用于无真实个人数据、无真实价值的 smoke 聚合证据，不是生产账务或审计保留承诺。

## 4. OQ-024-SMOKE：D1 位置

推荐结论：一次性合成 smoke 使用 `location=apac`。

- `apac` 是 D1 primary 的位置提示，不是数据驻留保证；Cloudflare 只承诺尽量选择接近该偏好的可用位置。
- 本次不使用 `jurisdiction=eu|fedramp`，因为尚无已确认的 EU/FedRAMP 合规范围，不能借测试资源暗示生产适用性。
- 数据库只包含合成账号、合成余额和固定测试文本，不包含真实个人信息、授权证据、支付或生产密钥。
- 临时 Worker 仍通过随机 `workers.dev` 地址运行；D1 位置设置只约束数据库实例选择，不限制 Worker 从何处被访问。
- 若首发地区、运营主体或专业意见要求 jurisdiction，本推荐立即失效，必须修订 Gate 后重新评审，不能在创建后修改既有 D1 的 jurisdiction。

依据：Cloudflare 当前文档列出 `apac` 等六个 location hint；location hint 不保证精确位置。`eu`/`fedramp` jurisdiction 只能在数据库创建时设置，且会覆盖 location hint。

## 5. 当次授权参数

| 参数 | 推荐值 |
|------|--------|
| Gate scope | `wallet1_disposable_synthetic_smoke` |
| Gate 有效期 | 批准后最多 24 小时 |
| 单次资源最长生命周期 | 30 分钟 |
| D1 placement | `location=apac` |
| 数据 | 仅合成数据 |
| 证据 | 仅聚合证据，30 天到期 |
| 调币 | 全部独立复核、禁止负余额、禁止批量 |
| 共享 dev / production | 不授权 |

## 6. 确认与执行分离

第一步是确认本局部决策。项目 Owner 可使用以下明确文本：

```text
确认 Wallet-1 一次性合成数据 smoke 局部决策：采用 APAC location hint；全部调币强制独立复核，禁止负余额和批量；聚合证据保留 30 天；Gate 最长有效 24 小时。全局 OQ-018、OQ-020、OQ-024 及共享 dev/production 仍保持未决和关闭。
```

收到确认后，才允许把机器 Gate 的局部决策、位置和短期时间窗更新为 approved，并提交、推送和等待 CI。更新 Gate 本身仍不创建任何 Cloudflare 资源。

第二步是在已批准 Gate 对应 commit 的 CI 通过后，对当次远程资源操作单独授权：

```text
批准执行本次 Wallet-1 隔离 smoke：只允许创建并销毁一次性 APAC D1 和临时 workers.dev Worker，不允许修改共享 dev 或 production。
```

只有两步都完成，才运行 `smoke:wallet1:disposable`。任何措辞不清、Gate 过期、commit 不一致或清理责任人不可用时继续 fail closed。

## 7. 技术依据

- [Cloudflare D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Wallet-1 一次性功能验收 Runbook](./WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md)
- [Wallet-1 金币账本跨仓交付基线](./WALLET_1_LEDGER_INTEGRATION.md)
