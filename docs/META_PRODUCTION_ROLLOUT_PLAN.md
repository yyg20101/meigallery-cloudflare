# Meta Production 放量计划

## 当前状态

- 当前阶段：等待 Dataset Quality 首份有效 production 快照。
- 当前模式：`ad_platform_connections.mode=test`。
- CAPI：关闭，target/effective rollout 均为 `0%`。
- Meta 远端资源和验证仅存在于 production；dev/local 只做代码、契约、migration、类型和构建验证。
- delivery 已迁移到通用广告平台内核；本计划仍只控制 Meta adapter，TikTok/Google 使用独立连接和 rollout。
- 后续每个阶段开始前先同步确认，不自动开启 CAPI，不自动提高 rollout。

## 一、等待 Dataset Quality

待确认：

1. production 每日 Dataset Quality collector 已执行。
2. `Contact`、`CompleteRegistration` 均有 `success` 快照。
3. 快照 contract version/digest 与仓库批准契约一致。
4. 两项快照均在 24 小时新鲜度窗口内。

停止条件：快照缺失、过期、权限不足或结构不符合批准契约时，保持 test 模式、CAPI 关闭和 rollout `0%`。

## 二、同步代码并发布

Dataset Quality 通过后：

1. 确认 `dev` 工作区干净，测试和构建通过。
2. 将当前功能闭环提交统一推送到 `origin/dev`。
3. 从 `dev` 创建 release 分支。
4. 通过 PR 合入 `main`，禁止直接推送 `main`。
5. 在最终 `main` HEAD 运行生产发布门禁并部署 production API/Web。

新 commit 会使旧 Meta live evidence 和资源摘要失效。dev 不创建 Meta Queue、Meta secret、Meta attestation 或真实 Graph API 事件。

## 三、重新生成正式证据

最终 production commit 部署后：

1. 保持 `ad_platform_connections.mode=test`、CAPI 关闭、rollout `0%`。
2. 运行 production post-deploy resource attestation。
3. 在 production 后台输入 Events Manager 当前显示的 Test Event Code。
4. 触发 production synthetic Test Event，要求 Meta 返回 `events_received=1`；连接验证与 `Live Evidence` 必须共用上述页面内存值。
5. 在 production 后台触发 `Live Evidence`。
6. 在 Meta Events Manager 确认：
   - `Contact` 同时存在 Browser/Server，且 event ID 相同。
   - `CompleteRegistration` 同时存在 Browser/Server，且 event ID 相同。
   - 两项事件均正确去重为一条转化。
   - `CompleteRegistration` 包含 email、external ID、IP、User-Agent。
   - `Contact` 包含 IP、User-Agent，不伪造 email、手机号或注册用户 ID。
   - 没有活动 `Lead` 或 `StartTrial`。
7. 运行 `corepack pnpm verify:meta-live`。
8. 运行 `corepack pnpm verify:meta-resources` 写入完整 production 摘要。
9. 确认后台发布检查没有阻断项。

## 四、切换 Production 模式

全部正式证据通过后：

1. 将 `ad_platform_connections.mode` 从 `test` 调整为 `production`。
2. 保持 CAPI rollout `0%`，观察连接、incident、Queue/DLQ 和永久失败。
3. 确认 production payload 不再携带 `test_event_code`。

出现连接失效、critical incident、retry exhausted、永久 4xx、事件 ID 不一致或重复上报时，不允许进入放量。

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

- 确认点 A：Dataset Quality 首份有效快照已产生。
- 确认点 B：`dev` 提交可以推送并进入 release 流程。
- 确认点 C：最终 `main` 已部署，可以重新执行 production live evidence。
- 确认点 D：完整 production 门禁通过，可以切换 production 模式。
- 确认点 E：每次 rollout 从 `0%`、`10%`、`50%` 向上调整前。

未获得对应确认前，不进入下一阶段。
