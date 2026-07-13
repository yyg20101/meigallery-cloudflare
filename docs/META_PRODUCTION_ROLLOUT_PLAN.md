# Meta Production 放量计划

## 当前状态

- 当前阶段：production CAPI `10%` 观察期，开始时间为 2026-07-13。
- 当前模式：`ad_platform_connections.mode=production`。
- Browser Pixel 与 Server API 均已启用，target/effective rollout 均为 `10%`。
- 进入 `10%` 时连接、Dataset Quality、live evidence 与资源证明均有效，发布检查为 0 个阻断、0 个警告，未关闭 incident、pending、failed 和 secure outbox 均为 0。
- 放量后尚需积累真实生产投递样本；样本不足时不得提升至 `50%`。
- Meta 远端资源和验证仅存在于 production；dev/local 只做代码、契约、migration、类型和构建验证。
- delivery 已迁移到通用广告平台内核；本计划只控制 Meta adapter，其他平台使用独立连接、凭证、Queue 和 rollout。
- 后续每次提升前必须同步确认，不自动提高 rollout。

## 一、当前生产基线

以下项目已经完成，任一失效时必须停止升级并降回 `0%`：

1. production Dataset Quality 中 `Contact`、`CompleteRegistration` 均有符合批准契约的 `success` 快照。
2. production Browser/CAPI live evidence 已验证同组 event ID 与事件去重。
3. production 资源证明、连接验证、Queue/DLQ 和加密数据 key 均有效。
4. 连接身份与验证记录一致，运行模式为 `production`。

Dataset Quality 过期、连接失效、资源证明失效、出现 critical incident 或永久失败时，立即回退 rollout `0%`，必要时关闭 Server API。

## 二、普通业务发布

Meta 连接身份由 Dataset ID、Access Token 指纹和 Graph API 版本决定，普通业务 commit 只用于发布追溯，不使已验证连接自动失效。

每次生产发布仍必须：

1. 从 `dev` 创建 release 分支并通过 PR 合入 `main`。
2. 运行完整 production release gate 后部署 API/Web。
3. 部署后核对连接状态、rollout、incident、pending、failed、Queue/DLQ 和 secure outbox。
4. 发布流程不得自动修改连接模式、Server API 开关或 rollout。

## 三、需要重新验证的变更

只有以下变更需要重新完成连接或资源验证：

1. Dataset ID、Access Token 或 Graph API 版本变化。
2. Queue、DLQ、D1、R2、secret 或加密数据 key 绑定变化。
3. Meta Browser/CAPI event ID、payload、去重或增强匹配实现变化。
4. Dataset Quality 批准契约变化。

重新验证时先降回 rollout `0%`，再按“连接验证 -> Live Evidence -> Dataset Quality -> 资源证明 -> 发布检查”的顺序完成，不复用过期 ticket 或 challenge。

## 四、当前观察要求

在 `10%` 阶段至少观察 24 小时，并积累不少于 10 次 Server 投递尝试；成功率低于 98%、出现权限错误、retry exhausted、stale pending、DLQ、重复上报或匹配数据异常时，不允许提升至 `50%`。

## 五、分阶段放量

放量必须由 Owner 手动执行：

| 阶段 | 最低观察时间 | 核对项目 |
|------|--------------|----------|
| `0% -> 10%` | 24 小时 | CAPI 接收、Pixel/CAPI 去重、pending、failed、DLQ、事件口径 |
| `10% -> 50%` | 24 小时 | 接收比例、永久失败、重复事件、`_fbp`/`_fbc`、IP、User-Agent 覆盖 |
| `50% -> 100%` | 24–72 小时 | Dataset Quality、广告归因稳定性、单次成效费用和异常趋势 |

任一级异常时立即降回 `0%`；必要时关闭 `ad_platform_connections.server_enabled`，再将 `ad_platform_connections.mode` 切回 `disabled`。保留生产 Queue/DLQ、D1 账本、incident 和 migrations 用于诊断。

## 六、Meta 诊断观察

当前 Meta 提示：过去 7 天服务器 `Contact` 比 Pixel 少 133 条，约 19% 的 `Contact` 被判定缺少匹配参数。

处理口径：

1. 当前提示包含 CAPI 接入前的历史窗口，不作为最新链路失败结论。
2. 正式放量后观察 24–72 小时，并等待 7 天窗口滚动。
3. 重点核对 `_fbp`、`_fbc`、IP、User-Agent 的真实覆盖率。
4. 不为消除提示而伪造 Contact 的 email、手机号或 external ID。
5. 若新 Contact 仍持续进入缺少 `user_data` 诊断，再检查 production payload 与营销授权 receipt 链路。

## 七、同步确认点

- 当前已完成：连接验证、production 模式与 `0% -> 10%`。
- 下一确认点：`10% -> 50%`，必须同时满足观察时间、最小样本、成功率和零关键异常。
- 后续确认点：`50% -> 100%`，必须满足 Dataset Quality、匹配覆盖和广告归因趋势稳定。

未获得对应确认前，不进入下一阶段。
