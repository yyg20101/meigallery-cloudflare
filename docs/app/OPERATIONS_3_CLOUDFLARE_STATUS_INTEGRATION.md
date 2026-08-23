# Operations-3 Cloudflare 官方平台状态检测开发基线

更新时间：2026-08-20

App 版本：1.0

状态：服务端源码与 Runbook 开发完成；migration、调度、构建、测试和环境验证统一后置

## 1. 本阶段结论

Operations-3 在既有运营事件体系中接入 Cloudflare 官方公共状态信号，不新增 App API、KMP capability、后台页面或环境 secret：

- `admin-app-operations` 检测器升级为 `operations-detectors-v3`。
- Owner 运行检测时并行读取 D1 的 10 类权威检测和官方 `https://www.cloudflarestatus.com/api/v2/summary.json`。
- 官方源可用且相关服务健康时，检测运行写为 `completed`、`unavailableDetectorCount=0`，但不会创建“零异常”事件。
- 相关服务降级、局部/重大故障或维护时，创建或刷新既有 `platform_health_anomaly / platform` 事件。
- 超时、网络失败、非 2xx、超限响应、JSON 或字段不合法时不制造平台故障，只把本次运行写为 `partial`、`unavailableDetectorCount=1`。
- `0108_app_operations_cloudflare_status_runbook.sql` 只追加一份不可变系统 Runbook，不配置 binding、不写环境值，也不执行 migration。

当前可执行检测合计为 11 类：10 类 D1 权威事实和 1 类 Cloudflare 官方公共状态。本阶段完成时，公共状态源不等于 MeiGallery 账户级遥测，因此 Worker 错误率、D1 P95 延迟和 R2 错误率仍为 `unconfigured`；该历史缺口后续已由 [Operations-4 Cloudflare 账户级可观测指标开发基线](./OPERATIONS_4_CLOUDFLARE_ANALYTICS_INTEGRATION.md)补齐采集器，目标环境是否可用仍取决于独立配置和来源质量。

## 2. 官方来源与严格读取边界

唯一外部来源为 Cloudflare Status API v2 Summary。该端点公开、无需凭据，返回页面总体状态、组件状态和未解决事件。Worker 请求使用：

- `Accept: application/json`；
- `cache: no-store`，不复用陈旧中间结果；
- 4 秒 `AbortController` 超时；
- 禁止重定向；
- 响应体最大 1,000,000 字节；
- `page.updated_at`、总体 indicator、相关组件、事件 impact 和关联组件均做结构校验。

检测只保留标准化的公共组件名、状态、公开事件 ID/impact、来源更新时间和观察时间。事件名称、正文、更新正文、区域维护说明、账号信息、Cloudflare 凭据及任何 MeiGallery 用户数据均不进入运营表、通用审计或日志。

## 3. 当前相关组件

当前精确匹配以下正式组件名：

| 组件 | MeiGallery 依赖 |
|------|----------------|
| `API` | Cloudflare 控制面与已接入 API 能力的公共状态参考 |
| `D1` | 业务与运营权威事实 |
| `Durable Objects` | Message-4 Hibernation 实时刷新能力 |
| `Email Sending` | 登录与 App 账号邮箱验证 |
| `Queues` | 广告归因、ZIP 导入、隐私导出/注销执行 |
| `R2` | 私有媒体、导入包与私有导出制品 |
| `Turnstile` | 认证与高风险写操作挑战 |
| `Workers` | API 和 Web 运行时 |
| `Workers Assets` | Web 静态资源交付 |

组件列表必须完整出现；若官方重命名或移除任一当前依赖，检测器将来源标记为不可用，不能把覆盖缺失解释为健康。当前未配置的 Stream 以及未建立正式 binding 的 Workflows 不进入本次相关组件集合；它们真正启用时必须通过代码与文档版本更新显式加入。

总体 indicator 只进入证据摘要，不单独触发事件。只有相关组件状态或明确关联相关组件的未解决事件才触发，避免无关 Cloudflare 产品、站点或地区维护造成误报。

## 4. 事件映射

| 字段 | 值 |
|------|----|
| detector key | `cloudflare.platform_health` |
| incident key | `detector:platform_health_anomaly:global` |
| type / domain | `platform_health_anomaly / platform` |
| source reference | `cloudflare_status:summary_v2` |
| Runbook | `oprb_cloudflare_platform_health_v1` |

严重级别采用保守映射：

- 相关组件 `major_outage` 或事件 impact `critical`：P0；
- 相关组件 `partial_outage` 或事件 impact `major`：P1；
- `degraded_performance`、`under_maintenance` 或 minor/none 未解决事件：P2。

`impact_count` 是受影响相关组件的去重数量，至少为 1；`impact_scope_json` 只含公共状态 indicator、组件名、降级状态和相关事件数量。检测器不自动暂停人物发布、推荐、运营消息、会员或钱包控制，也不会自动关闭已建立事件；Owner 必须结合项目自身症状、受控证据和既有事件状态机处置。

## 5. 运行、幂等与证据

外部读取与 10 类 D1 查询并行执行，避免把网络等待串行叠加在数据库扫描后。运行级 `evidence_digest` 同时覆盖：

- 稳定排序后的全部 finding key、数量和严重级别；
- 官方源可用性与不可用原因；
- 观察时间、来源更新时间、九个相关组件状态；
- 相关公开事件 ID、状态、impact 与组件集合。

每个 finding 的摘要还覆盖来源引用、影响范围和严重级别。相同 Owner 与 `Idempotency-Key` 仍返回原检测运行；相同 key 改变请求版本会冲突。外部源失败不会阻止 D1 发现形成事件，运行只从 `completed` 降为 `partial`。

## 6. Figma 与后台复用

本阶段严格复用 Figma 已登记的 `ADM-OV-01/02/03`：

- 总览显示检测运行的完成/部分完成状态、不可用来源数量和平台专题；
- 事件中心使用既有 `platform_health_anomaly` 类型筛选；
- 事件详情展示安全摘要、固定 Runbook、时间线和带证据关闭流程。

没有新增页面、弹层或页面状态，注册表继续保持 99 个 Page ID、408 个正式状态、Mobile 50 页/208 状态、Admin 49 页/200 状态。

<a id="runbook-cloudflare-platform-health"></a>
## 7. Cloudflare 平台状态异常 Runbook

1. 固定检测运行 ID、来源更新时间、相关组件和公开事件引用，不复制官方事件正文。
2. 打开 Cloudflare Status 核对事件当前阶段，并分别检查 API/Web Worker、D1、R2、Queue、邮箱、Turnstile 与实时刷新是否出现项目自身症状。
3. 公共状态只能证明 Cloudflare 报告的全局/区域信号；没有账户级错误率、延迟或日志证据时，不把影响范围扩大为全部 MeiGallery 用户。
4. 需要业务降级时，使用对应领域既有开关、Runbook 和审批，不从平台事件自动暂停五类安全控制。
5. Cloudflare 恢复后再次运行检测，并用项目 smoke、账户级观测或受控业务核对确认恢复；保存稳定证据引用。
6. 负责人按既有状态机缓解或关闭事件。若官方源不可读，保留 `partial` 运行并人工核对，不创建虚假故障或虚假恢复。

## 8. 开发结束后统一完成

当前明确后置，不在本阶段执行：

- 按顺序执行到 `0108_app_operations_cloudflare_status_runbook.sql` 并核对不可变 Runbook；
- 对健康、三档故障、相关/无关事件、维护、超时、非 2xx、超限、畸形载荷、组件重命名和幂等重放执行专项测试；
- 运行 API 类型检查、构建与 Operations 管理 API 回归；
- 配置受控检测调度，并验证 Worker 出站请求策略、速率和失败预算；
- 在 `ADM-OV-01/02/03` 完成权限、部分来源、事件重开、窄屏和无障碍验收；
- Operations-4 已另行接入账户级 Workers/D1/R2 采集器；后续配置最小只读 Token、精确资源并完成 schema/质量验证后，才能在目标环境消除三项 `unconfigured`。

在以上事项完成前，源码存在不等于目标环境已应用 `0108` 或已配置 Operations-4，不构成生产调度、平台健康 SLA 或账户级可观测已就绪的声明。
