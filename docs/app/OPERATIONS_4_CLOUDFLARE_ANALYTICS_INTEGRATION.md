# Operations-4 Cloudflare 账户级可观测指标开发基线

更新时间：2026-08-20

App 版本：1.0

状态：服务端源码开发完成；凭据与资源配置、GraphQL schema 复核、构建、测试和环境验证统一后置

## 1. 本阶段结论

Operations-4 在既有 `ADM-OV-01` 和 `POST /api/admin/app/operations/overview/refresh` 中接入 Cloudflare GraphQL Analytics API，不新增页面、App API v2、KMP capability、数据库表或 migration：

- `platform.worker_error_rate`：指定 Worker scripts 最近 5 分钟的 `errors / requests`。
- `platform.d1_latency_p95`：指定 D1 database 当日 UTC 滚动 `queryBatchTimeMsP95`。
- `platform.r2_error_rate`：指定 R2 buckets 最近 5 分钟的 `internalError / all requests`；`userError` 进入分母，但不视为平台故障。
- `operations-metrics-v2`：一次刷新只请求一次账户级 GraphQL，随后把三项结果与 15 项 D1 业务指标共同写入既有不可变快照。

三项指标不再是“没有采集器”的固定占位：未配置时为 `unconfigured`，已配置但来源不可读时为 `unknown`，结构或数值违约时为 `invalid`，只有来源与口径都有效且窗口内有样本时才为 `known`。任何缺失、空样本或请求失败都不会显示为 `0`。

## 2. 官方来源与认证边界

唯一账户级来源为 `POST https://api.cloudflare.com/client/v4/graphql`。生产配置必须使用专用 API Token，权限限制为 Account → Account Analytics → Read，并把资源范围限制到 MeiGallery 所在账户。不得复用 Global API Key、部署令牌或具备写权限的 Token。

本阶段只声明以下可选 Worker binding 类型，不写入 `wrangler.toml`、本地 secret 或目标环境：

| Binding | 用途 | 是否敏感 |
|---------|------|----------|
| `APP_OPERATIONS_CLOUDFLARE_ACCOUNT_ID` | 账号级 `accountTag` | 内部配置 |
| `APP_OPERATIONS_CLOUDFLARE_ANALYTICS_TOKEN` | 最小只读 Analytics API Token | secret |
| `APP_OPERATIONS_CLOUDFLARE_WORKER_SCRIPTS` | 1–8 个逗号分隔 Worker script name | 内部配置 |
| `APP_OPERATIONS_CLOUDFLARE_D1_DATABASE_ID` | 单个 D1 database UUID | 内部配置 |
| `APP_OPERATIONS_CLOUDFLARE_R2_BUCKETS` | 1–8 个逗号分隔 bucket reference；受 jurisdiction 限制的 bucket 使用官方前缀 | 内部配置 |

账号或 Token 缺失/非法时，三项均保持 `unconfigured` 且不发起网络请求。资源配置按指标独立：例如只缺 R2 bucket 时，R2 为 `unconfigured`，配置正确的 Worker 与 D1 仍可请求。

## 3. 查询与指标口径

### 3.1 Worker 错误率

每个已登记 script 使用独立 GraphQL alias 和变量查询 `workersInvocationsAdaptive`，时间范围为刷新时刻向前 300 秒，聚合 `sum.requests` 与 `sum.errors`。多个 script 的估算值相加后计算整体错误率。

- 分母为指定 scripts 的全部请求估算；分子为 `errors` 估算。
- 请求数为零时返回 `unknown / NO_REQUESTS_IN_WINDOW`，不能返回 0% 健康。
- `errors > requests`、负值、非有限数或累计超过 JavaScript 安全整数范围时返回 `invalid`。

### 3.2 D1 P95 延迟

D1 官方 `d1AnalyticsAdaptiveGroups` 示例按 `Date` 过滤，不提供与 Worker/R2 相同的精确五分钟过滤契约。因此本指标明确使用刷新时刻所在 UTC 日期，读取 `queryBatchTimeMsP95`，含义是 D1 服务端查询响应与序列化时间的当日滚动 P95，不伪装成最近五分钟 P95。

- 配置阶段必须通过 Cloudflare GraphQL introspection 复核目标账户当前 schema 包含 `queryBatchTimeMsP95`。
- GraphQL schema 拒绝、返回 `errors`、日期不一致或数值非法时不回退为 P90，也不沿用旧值；当前快照写 `unknown` 或 `invalid`。
- 当日无观测时返回 `unknown / NO_D1_OBSERVATION_IN_PERIOD`。

### 3.3 R2 错误率

每个 bucket 使用独立 alias 查询 `r2OperationsAdaptiveGroups` 最近 300 秒数据，按官方 `actionStatus` 聚合请求量：

```text
平台错误率 = internalError requests / (success + userError + internalError requests)
```

用户请求错误可用于另行诊断，但不能冒充 Cloudflare 平台失败。总请求为零时返回 `unknown / NO_REQUESTS_IN_WINDOW`。

### 3.4 采样与用途

三个数据集均按 Cloudflare adaptive analytics 语义标记 `sampled=true`；安全详情只保存窗口、资源数量、观测行数和聚合估算，不保存 account ID、script/bucket/database 名称、Token 或 GraphQL 原始响应。这些数据用于运营健康判断，不作为账单、结算或单用户行为事实。

## 4. 失败与安全边界

GraphQL 读取采用 5 秒超时、`no-store`、拒绝 redirect、响应体 1 MB 上限和严格 JSON/对象校验。以下任一情况都拒绝本次账户级结果：

- 网络错误、超时、非 2xx 或响应超限；
- HTTP 200 但 `errors` 非空；
- `data.viewer.accounts` 缺失、不是数组或不精确等于一个账户；
- dataset alias、聚合字段、维度或数值不符合固定 schema。

GraphQL 级错误会让本次已请求的三项来源统一成为 `unknown`；未配置的指标仍保持 `unconfigured`。单个 dataset 在 GraphQL 成功后出现结构违约时，只把该项标为 `invalid`，不伪造数值。API Token、Authorization header 和原始错误正文不得进入日志、快照、安全详情或管理员审计。

## 5. API、UI 与审计

- 管理路由与响应 schema 不变；Owner 仍通过 `POST /api/admin/app/operations/overview/refresh` 人工刷新。
- 刷新写操作继续要求 `Idempotency-Key`，运行版本提升到 `operations-metrics-v2`；同一幂等键重放既有快照，不重复请求外部来源。
- 三项数据继续进入 `app_operational_metric_snapshots.safe_details_json`，服从 `0092` 的追加式约束；不增加第二套技术指标表。
- `ADM-OV-01` 继续只在 `known` 时显示数值，其他质量状态显示 `—`，并沿用既有指标来源、治理和新鲜度展示。
- Operations-3 的公共 Status 检测与本阶段账户级遥测相互独立：公共状态用于发现 Cloudflare 已公告事件，账户级指标用于反映 MeiGallery 指定资源的实际遥测；任一来源都不会自动暂停业务控制。

本阶段复用 Figma 已登记的 `ADM-OV-01` 正式状态，不新增 Page ID、页面状态或交互。页面总量保持 99 个 Page ID、408 个正式状态；Mobile 保持 50 页、208 个状态。

## 6. 开发结束后统一完成

当前明确后置，不在本阶段执行：

1. 创建专用只读 API Token，并在目标环境配置五项 binding；不得把 secret 写入仓库。
2. 通过官方 GraphQL introspection 核对 Workers、D1 与 R2 字段、过滤器和目标账户数据可用性。
3. 分别验证未配置、部分配置、空窗口、采样数据、HTTP/GraphQL 错误、畸形载荷、超时和超限。
4. 验证幂等重放、18 项快照原子写入、质量摘要、新鲜度降级和 `ADM-OV-01` 窄屏/无障碍状态。
5. 完成构建、专项测试、dev 环境联调、Token 轮换与撤销演练，再决定 production 启用。

本阶段没有 migration。源码存在不等于目标环境已配置，也不构成生产可观测、告警、SLA 或发布授权。

## 7. 官方依据

- GraphQL 认证与专用 Token：<https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/>
- GraphQL endpoint 与 headers：<https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/graphql-client-headers/>
- Workers 指标查询：<https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/>
- D1 指标与 GraphQL datasets：<https://developers.cloudflare.com/d1/observability/metrics-analytics/>
- R2 指标、`actionStatus` 与时间过滤：<https://developers.cloudflare.com/r2/platform/metrics-analytics/>
- GraphQL 错误：<https://developers.cloudflare.com/analytics/graphql-api/errors/>
- Adaptive sampling：<https://developers.cloudflare.com/analytics/graphql-api/sampling/>
