# 独立归因运行时与零中断配置发布设计

- 设计讨论状态：`已确认（2026-07-24）`
- 书面评审状态：`已确认（2026-07-24）`
- 设计版本：`1`
- 适用平台：Meta、TikTok、Google Ads，以及后续通过统一 Adapter 接入的平台
- 运行环境：真实平台只允许 `production`；`dev/local` 只使用 Mock、测试凭证和隔离资源
- 成本基线：Cloudflare Workers Free，不以开通 Paid 作为实施前提
- 替代文档：本设计替代已从工作树删除的 2026-07-15 版本；旧内容仅保留在 Git 历史中

## 1. 背景与问题定义

当前通用归因已经具备统一事实、平台 Adapter、Browser/Server 配对、D1 Outbox、Queue、验证和后台管理，但连接配置仍与运行控制、验证和代码发布耦合：

1. 后台连接数据尚未加载时，空白草稿可能以“全部关闭、0%”提交。
2. 无论内容是否变化，保存都会生成新的连接版本、作废验证并把 Server effective 降为 0。
3. Pixel ID、Token、事件映射、启停和 rollout 通过同一个写入口保存。
4. Git commit、连接验证和生产放量存在运行时依赖，普通代码发布可能阻断归因。
5. Web/API/归因共用部署单元，其他模块发布会扩大归因故障半径。
6. 当前连接表以 provider 唯一，无法自然表达同一平台由多个投放团队分别使用不同 Pixel 或广告账户。
7. 当前验证主要直接调用平台测试 API，没有覆盖正常的事实、路由、Outbox、Queue 和 Adapter 全链路。

2026-07-20 至 2026-07-23 的生产事实证明，这些不是纯理论风险：连接保存曾将 Browser、Server 和 rollout 一起归零，真实 Contact 与 CompleteRegistration 因此没有生成平台 delivery。

本次不增加局部防护或 Meta 特例，而是重新定义归因运行时、连接生命周期和部署边界。

## 2. 设计目标

1. 其他业务模块发布不得修改归因 Active 配置、凭证、运行策略或投递运行时。
2. Pixel ID、Token 或事件映射变更必须先形成候选版本，自动验证成功后再原子切换。
3. 候选验证失败、超时或并发冲突时，当前 Active 版本继续工作。
4. 启停、Browser 开关和 Server rollout 与身份配置完全分离。
5. 同一平台支持多个逻辑连接，并通过签名投放来源严格路由到唯一连接。
6. 一条业务事实最多归属一个平台、一个连接；禁止广播、猜测和跨平台发送。
7. Meta、TikTok、Google 共用相同状态机、事实、路由、投递和后台能力。
8. 新平台只能通过平台注册表、配置 Schema 和 Adapter 接入。
9. Git commit 不参与归因验证、激活、放量、回滚或运行判断。
10. 迁移完成后删除旧归因运行代码、旧表和永久兼容路径。

## 3. 非目标

1. 不导入广告花费、Campaign 报表或广告平台财务数据。
2. 不实现跨平台多触点分摊；一个转化只选择一个可信来源。
3. 不把普通 UTM 当作可信平台身份。
4. 不因平台质量接口缺失或异常而自动关闭整个连接。
5. 不承诺网站整体不可用、业务按钮被删除或业务事务失败时仍能产生归因事件。
6. 不使用 Git 历史、Worker 部署版本或人工 commit 证明作为业务配置状态。

## 4. 核心决策

### 4.1 独立部署单元

新增 `packages/attribution`：

```text
packages/
  web/           Nuxt 页面和稳定 Attribution SDK loader
  api/           业务 API 与可信业务事件 outbox
  attribution/   独立 Hono Worker、Queue consumer、验证 Workflow
  shared/        Canonical Event Contract 与 Service Binding 类型
```

生产资源：

```text
Worker: meigallery-attribution
D1:     meigallery-attribution-db
Queue:  meigallery-attribution-meta / -dlq
Queue:  meigallery-attribution-tiktok / -dlq
Queue:  meigallery-attribution-google / -dlq
```

后续平台按照相同命名规范增加物理 Queue。独立 Worker 通过 Service Binding 接收 API 的可信事件，通过同站点跟踪入口接收 Browser 事件。

### 4.2 独立数据所有权

归因 D1 独占以下数据：

- 逻辑连接和不可变连接版本
- 加密平台凭证
- 事件映射
- 运行策略
- 连接验证
- 可信来源绑定和归因上下文
- 转化事实、Delivery、Outbox 和平台回执
- Incident、质量快照、容量统计和归因审计

业务 D1 只保留业务事实和“待发送业务领域事件”。业务 migration 不得访问归因 D1；归因 migration 只随 Attribution Worker 发布。

### 4.3 配置版本与运行策略分离

身份配置包括：

- Pixel ID、Dataset ID、Tag ID、Customer ID 等公开目标
- Token、Service Account 等加密凭证
- Canonical Event 到平台事件的映射
- Adapter 所需且会改变投递身份的配置

运行策略包括：

- 整个连接是否启用
- Browser 是否启用
- Server target/effective rollout
- 通道熔断和恢复状态

修改运行策略不创建配置版本，不作废连接验证，不更换凭证。

## 5. 领域模型

### 5.1 逻辑连接

`attribution_connections` 表示稳定的投放账户或团队连接：

```ts
interface AttributionConnection {
  id: string
  provider: AdPlatformProvider
  name: string
  isDefault: boolean
  activeVersionId: string | null
  createdAt: string
  updatedAt: string
}
```

约束：

- 同一 provider 可以有多个连接。
- 同一 provider 最多一个默认连接。
- `id` 在迁移和版本切换中保持稳定。
- 未产生 Active 版本的连接不能投递。

### 5.2 不可变连接版本

`attribution_connection_versions` 保存完整身份快照：

```ts
type ConnectionVersionStatus =
  | 'candidate'
  | 'validating'
  | 'ready'
  | 'active'
  | 'draining'
  | 'failed'
  | 'superseded'
  | 'retired'

interface AttributionConnectionVersion {
  id: string
  connectionId: string
  provider: AdPlatformProvider
  baseActiveVersionId: string | null
  status: ConnectionVersionStatus
  publicConfig: PlatformPublicConfig
  configHash: string
  createdBy: number
  createdAt: string
  validatedAt: string | null
  activatedAt: string | null
  drainingAt: string | null
  retiredAt: string | null
  failureCode: string
}
```

版本创建后不得修改公开配置、凭证或事件映射。验证结果、状态和时间字段只能由领域状态机更新。

### 5.3 凭证和事件映射

- `attribution_version_credentials`：每个版本一条加密凭证；明文不回显、不记录日志。
- `attribution_version_bindings`：每个版本完整保存所有 Canonical Event 映射。
- 凭证使用独立 Attribution Worker secret 加密。
- 相同明文凭证可以通过 HMAC 指纹识别，但指纹不返回前端。
- 只保留最近一个 retired 版本及其凭证，回滚期固定为 7 天；更早版本立即销毁凭证，7 天结束后由 Cron 销毁最后一个 retired 凭证。

### 5.4 运行策略

`attribution_runtime_policies` 与连接一一对应：

```ts
interface AttributionRuntimePolicy {
  connectionId: string
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
  serverEffectivePercentage: 0 | 10 | 50 | 100
  circuitState: 'closed' | 'server_open'
  runtimeGeneration: number
  updatedBy: number
  updatedAt: string
}
```

`runtimeGeneration` 只用于服务端并发控制，不在后台展示。运行策略写入口不能更新连接版本、凭证或事件映射。

## 6. 配置版本状态机

```text
candidate -> validating -> ready -> active -> draining -> retired
                          \-> failed
candidate/validating/ready -> superseded
```

规则：

1. Owner 保存身份配置时只创建 `candidate`。
2. 同一连接最多有一个未终结候选；新候选会把旧候选标记为 `superseded`。
3. Workflow 领取候选后进入 `validating`。
4. 所有自动步骤通过后进入 `ready`。
5. 激活事务必须确认 `baseActiveVersionId` 仍等于当前 `activeVersionId`。
6. 激活事务一次完成：
   - 新版本设为 `active`
   - 连接指针切到新版本
   - 旧 Active 设为 `draining`
   - 写入审计
7. 如果 Active 指针已变化，候选进入 `superseded`，禁止旧页面覆盖新配置。
8. 验证失败或超时只更新候选，不触碰 Active 和运行策略。
9. 首次配置在验证完成前保持不可投递；验证成功后才产生第一个 Active。
10. 激活后 smoke 失败时自动将指针回滚到上一版本并记录 critical incident。
11. 候选自动验证的总时限为 30 分钟；超时进入 `failed`，不等待人工证据。
12. 已打开页面持有最长 30 分钟的签名运行租约；旧 Active 在所有租约到期后从 `draining` 进入 `retired`。
13. `draining` 不再签发新配置，只接受该版本已签发租约对应的在途事件。
14. Browser 事件和 Server Delivery 必须使用运行租约声明的同一版本，禁止切换瞬间分别发往新旧目标。

## 7. revision 与 Git commit 语义

### 7.1 内部版本标识

旧 `connection_revision` 和 `credential_revision` 不再承担“保存即切换”的作用。最终模型只使用不可变 `version_id` 表示身份快照。

`version_id`：

- 由系统生成。
- 不显示给普通后台用户。
- 不要求人工复制、提交或确认。
- 只用于状态机、幂等、审计和投递快照。

### 7.2 Git commit 完全退出运行控制

以下逻辑全部禁止：

- 当前 commit 与验证 commit 不一致时停用连接
- 部署新 commit 后要求重新发送 Test Event
- commit 变化时把 rollout 降为 0
- 使用 commit attestation 决定 Pixel/CAPI 是否可用

Worker Version Metadata 可以作为日志维度帮助排障，但不得成为 SQL 条件、状态机输入、后台阻断或发布门禁。

## 8. 唯一写入口

路由、页面、Workflow、Cron 和脚本都不得直接修改连接表。

统一命令：

```ts
interface AttributionConnectionCommands {
  createConnection(input: CreateConnectionInput): Promise<ConnectionView>
  createCandidate(input: CreateCandidateInput): Promise<CandidateView>
  setRuntimePolicy(input: SetRuntimePolicyInput): Promise<RuntimePolicyView>
  activateCandidate(input: ActivateCandidateInput): Promise<ConnectionView>
  rollbackActiveVersion(input: RollbackInput): Promise<ConnectionView>
  disableConnection(input: DisableConnectionInput): Promise<RuntimePolicyView>
}
```

写入口必须：

- 校验 Owner 权限
- 校验 provider Schema
- 执行并发条件
- 使用 D1 原子 batch/事务
- 写入结构化审计
- 返回稳定错误码
- 不泄露凭证或内部加密字段

幂等规则：

- 标准化后的公开配置、事件映射和凭证指纹与 Active 完全一致时，返回当前 Active，零 D1 写入、零验证、零审计。
- 与现有未终结候选完全一致时，返回原候选，不创建新 Workflow。
- 运行策略提交值与当前值一致时零写入。
- 相同幂等键只能得到同一个领域结果。

读模型与写模型分离。后台只读取聚合 View，不拼装可写 SQL。

## 9. 可信来源与多连接隔离

### 9.1 签名投放链接

后台生成的链接必须绑定：

```ts
interface ManagedAdSource {
  sourceId: string
  provider: AdPlatformProvider
  connectionId: string
  campaign: string
  medium: string
  content: string
  expiresAt: string | null
  proof: string
}
```

`proof` 绑定 provider、connectionId、sourceId 和关键 Campaign 字段。只修改 UTM 不能改变投递连接。

具体实现使用不可预测的 256-bit opaque proof。归因 D1 只保存 proof 的 HMAC，验证成功后从同一数据库行读取 provider、connectionId 和 Campaign；URL 原始 proof 不写日志或审计。迁移时对现有 proof 计算 HMAC，因此已有投放链接无需改变。

### 9.2 路由优先级

1. 有效的管理链接签名
2. 已签发且仍有效的第一方归因上下文
3. 平台 click ID，且该 provider 恰好只有一个已启用且具有 Active 版本的连接
4. 无可信来源

规则：

- 新的可信付费来源覆盖旧付费来源。
- 自然访问不会覆盖仍在窗口内的可信付费来源。
- 多个平台信号冲突时不向任何平台投递，并记录 incident。
- 同一 provider 存在多个可用连接时，即使其中一个标记为默认连接，仅有 click ID 仍不得猜测。
- 普通 UTM 只用于站内分析和冲突诊断，不能声明 provider 或 connection。

## 10. Canonical Event 数据流

标准转化事件保持：

```ts
type CanonicalConversionEvent =
  | 'Contact'
  | 'CompleteRegistration'
```

业务流：

```text
业务动作
  -> Canonical Event Contract
  -> Attribution Worker
  -> 可信来源解析
  -> 唯一事实去重
  -> Browser Instruction + Server Delivery/Outbox
  -> 唯一 Provider Adapter
```

### 10.1 Contact

- 只有通过安全 URL 校验并开始外部联系导航，或明确复制合法联系方式成功的动作才是 Contact；展开面板、展示二维码、复制失败和无效 URL 均不是 Contact。
- Attribution SDK 在导航前生成稳定 `event_id`。
- SDK 使用预加载 Active 配置执行 Browser 指令。
- 同一个事件通过 `sendBeacon` 或 `fetch keepalive` 写入 Attribution Worker。
- 页面关闭前未完成的请求进入有限本地重试队列。

SDK 取得的运行配置包含 `connection_id`、`version_id` 和最长 30 分钟的签名运行租约。租约自动刷新；事件发生后即使 Active 已切换，Attribution Worker 仍使用租约版本完成 Browser/Server 配对。租约内已发生但因离线延迟的事件最多允许在 24 小时内补交，之后只保留站内失败证据，不创建新的平台 Delivery。

### 10.2 CompleteRegistration

- 只有注册事务成功后才创建。
- API 在业务事务内写入领域事件 outbox。
- API D1 中的 Dispatcher 领取领域 outbox，通过 Service Binding 发送到 Attribution Worker；成功后标记完成，失败保持待重试。
- API 响应只携带已签名的 Browser 指令引用，客户端不能声明注册成功。

### 10.3 配对与去重

- Browser 和 Server 对同一 provider/connection 复用同一 `event_id`。
- 事实唯一键阻止重复业务事件。
- Delivery 唯一键阻止相同事实、连接、通道重复计划。
- Queue 重试和回放必须复用原 `event_id`。
- 不同 provider 或 connection 不共享 Delivery。

## 11. Adapter 边界

每个平台实现统一接口：

```ts
interface AttributionProviderAdapter {
  validateCandidate(input: CandidateValidationInput): Promise<ValidationEvidence>
  buildBrowserInstruction(input: BrowserInstructionInput): BrowserInstruction
  deliverServerEvent(input: ServerDeliveryInput): Promise<ProviderDeliveryResult>
  readQualitySignal(input: QualitySignalInput): Promise<QualitySignalResult>
}
```

Adapter 只负责：

1. 平台配置和凭证校验。
2. Canonical Event 到平台协议的转换。
3. Browser 指令构造。
4. Server 请求和响应分类。
5. 平台质量信号。

Adapter 禁止：

- 创建业务事实
- 选择来源或连接
- 修改运行策略
- 广播到其他平台
- 直接激活候选版本
- 读取其他平台凭证或 Outbox

业务核心不得出现 `if (provider === 'meta')` 等平台协议分支；分发只能通过注册表。

## 12. 自动验证与激活

验证必须通过正常链路，而不是只直接调用平台 API。

步骤：

1. 配置 Schema、目标 ID、凭证格式和事件绑定完整性。
2. 凭证对目标资源的最小权限验证。
3. 创建标记为 synthetic 的 Contact 和 CompleteRegistration 测试事实。
4. 通过正式 Planner、Outbox、Provider Queue 和 Adapter 发送 Server 测试事件。
5. 使用生产构建的 Attribution SDK 验证 Browser 指令和网络请求。
6. 核对 Browser/Server 使用相同 `event_id`。
7. 核对所有 synthetic 事实不进入业务转化统计。
8. 生成结构化验证证据，进入 `ready` 并自动激活。

激活后的 smoke 只在确定性错误时自动回滚，包括 Active 快照不可读、凭证无法解密、事件映射不完整、Browser 指令无法构造或正常链路无法生成 Delivery。平台 429、5xx 和网络超时属于瞬时故障，只打开 Server 熔断并重试，不能回滚身份配置。

Test Event Code：

- 只作为单次验证输入。
- 进入 Workflow 前加密。
- 不写审计、普通日志或 API 响应。
- 验证终结后立即销毁。
- 正式业务事件禁止携带测试码。

平台异步诊断不能安全自动查询时，显示为“等待平台诊断”，但不要求 Git commit 或人工证据才能保持 Active。

## 13. 运行控制与故障处理

### 13.1 运行控制

- `enabled=false`：显式停用整个连接。
- `browserEnabled=false`：只停 Browser。
- `serverEnabled=false`：只停 Server。
- target 降低立即生效。
- target 提高时先执行凭证可读、Active 快照、Queue 绑定和 Adapter 构造健康检查；通过后在一个运行策略事务中把 effective 提升到 target，不要求 Test Event、Git commit 或人工确认。
- 保存身份配置不得改变上述任何字段。

### 13.2 故障策略

- 候选失败：Active 不变。
- Server 平台异常：Queue 重试，D1 outbox 保留恢复依据。
- Queue 超过 Free 计划保留期：D1 恢复任务重新投递。
- Server 错误达到阈值：只打开 `server_open` 熔断，Browser 继续。
- 质量 API 无权限、无数据或异常：产生 warning，不改变运行状态。
- D1/Queue/凭证解密失败：记录 critical incident，不把错误伪装成成功。
- 只有 Owner 显式停用才能同时关闭整个连接。

## 14. 后台管理信息架构

后台归因中心使用以下入口：

1. 总览
2. 连接
3. 事件映射
4. 投递质量
5. 验证记录
6. Incident
7. 地区策略
8. 审计日志

### 14.1 连接

- 按 provider 分组展示多个连接。
- 显示团队名称、Active 目标、Browser/Server 状态、rollout 和最近健康状态。
- 身份编辑按钮为“保存并自动验证”。
- 候选状态明确说明“当前生产版本继续运行”。
- 不显示内部 version ID、credential revision、指纹或 Git commit。

### 14.2 运行控制

- 与身份编辑分开。
- 普通启停和比例调整使用独立命令。
- 只有停用整个连接和回滚需要明确确认。
- 重复点击、刷新和重复验证必须幂等。

### 14.3 Incident

每条 incident 至少展示：

- provider 和 connection
- 受影响通道和事件
- 开始、检测、恢复时间
- 影响事实数和 delivery 数
- 自动动作
- 当前恢复状态

## 15. API 与 Service Binding 契约

管理员 API：

```text
GET    /admin/attribution/connections
GET    /admin/attribution/connections/:id
POST   /admin/attribution/connections
POST   /admin/attribution/connections/:id/candidates
GET    /admin/attribution/connections/:id/candidate
PATCH  /admin/attribution/connections/:id/runtime-policy
POST   /admin/attribution/connections/:id/rollback
POST   /admin/attribution/connections/:id/disable
GET    /admin/attribution/connections/:id/sources
POST   /admin/attribution/connections/:id/sources
POST   /admin/attribution/connections/:id/sources/:sourceId/disable
GET    /admin/attribution/quality
GET    /admin/attribution/incidents
GET    /admin/attribution/privacy-policy
PATCH  /admin/attribution/privacy-policy
```

Browser API：

```text
PUT  /v1/context
GET  /v1/runtime-config
POST /v1/events/contact
POST /v1/browser-receipts
```

内部 Service Binding 使用命名 `AttributionServiceEntrypoint`，通过 HTTP
`fetch` 契约承载：

```text
POST /internal/v1/privacy-decision
POST /internal/v1/registration-events
GET  /internal/v1/events/:eventId/browser-instruction
POST /internal/v1/contact-capabilities
*    /admin/attribution/*
```

API Worker 的 `ATTRIBUTION` binding 必须通过 Wrangler 的 `entrypoint` 字段
固定到该命名入口。默认公网 `fetch` 不挂载 `/internal/v1/*` 或
`/admin/attribution/*`；内部身份由主 API 完成登录和 Owner 鉴权后注入，
浏览器提供的 actor、内部认证、Cookie 和 Authorization 头一律不转发。
不再维护共享内部认证 secret 或 HTTP 兼容入口。

所有修改 API 必须使用幂等键。并发条件通过内部 Active Version/Runtime Generation 自动传递，用户不需要理解版本号。

## 16. 隐私与数据最小化

- 继续使用地区策略决定是否允许广告投递，不允许平台 Adapter 自行判断。
- 严格地区先选择，其他地区按已确认的告知与退出策略执行。
- GPC、全局停用和用户明确拒绝优先于地区默认值。
- 未获允许时仍可保留必要的一方业务事实，但不创建广告 Delivery。
- IP、User-Agent、平台 Cookie、click ID 只进入短期加密 Outbox。
- Token、测试码、签名、nonce、原始 IP/UA 不进入普通日志、审计或分析表。
- 用户界面只展示隐私目的和选择，不披露平台实现细节。

## 17. 部署隔离

### 17.1 发布单位

- Web、API、Attribution 分别构建和部署。
- 普通 Web/API 发布不得部署 Attribution Worker。
- Attribution 仅在自身代码、配置或 migration 变化时发布。
- Attribution D1 migration 不进入 API 部署脚本。

### 17.2 合同稳定性

- `packages/shared` 维护版本化 Canonical Event Contract。
- 非破坏性字段采用可选扩展。
- 破坏性变更使用新 API 版本，完成消费者切换后删除旧版本。
- 禁止永久双写、双读或 fallback。

### 17.3 发布与回滚

- Worker 发布不修改 D1 Active 指针或运行策略。
- Worker 回滚不回滚业务配置。
- 自动 smoke 失败时回滚 Worker 版本，但不关闭 Active 连接。
- Git SHA 不参与归因运行状态。

## 18. Cloudflare Free 容量边界

截至 2026-07-24 的官方基线：

- Workers Free：100,000 请求/日。
- D1 Free：5,000,000 rows read/日、100,000 rows written/日、账户总计 5GB。
- Queues Free：10,000 operations/日，消息保留 24 小时。

独立 Worker 和独立 D1 不产生固定新增费用，但使用量计入账户总额度。系统必须：

- 使用日报聚合而不是后台全表扫描。
- 对 D1 查询建立范围索引。
- 批量发送 Queue 消息。
- 使用 D1 outbox 覆盖 Queue 24 小时保留限制。
- 在 70%、85%、95% 三档生成容量告警。
- 达到 Free 安全线前给出 Paid 升级建议，但不能静默丢弃转化。

## 19. 一次性迁移

### 19.1 准备

1. 冻结旧归因结构修改。
2. 导出 production D1 和 Time Travel bookmark。
3. 建立新 Attribution Worker、D1、Queue 和 Secret。
4. 在新 D1 应用单一基线 Schema。

### 19.2 数据迁移

迁移：

- 当前逻辑连接和名称
- 当前 Active Pixel/Dataset/Tag 配置
- 当前事件映射
- 当前运行策略
- 当前有效投放来源和签名
- 仍在窗口内的事实、未完成 delivery、outbox 和 incident
- 必要的审计与质量历史

凭证通过受控迁移命令读取旧密文、在内存中解密并使用新 Worker key 重新加密。明文不得写入文件、参数、日志或剪贴板。

### 19.3 验证与切换

1. 新系统完成三平台 Mock、D1、Queue、Browser E2E 和生产测试事件。
2. 保持现有 connection ID、source ID 和签名契约，现有投放链接继续有效。
3. 切换同站点跟踪路由和 API Service Binding。
4. 旧系统立即停止新写入；禁止向平台双投递。
5. 对迁移窗口内事件进行集合对账。
6. 观察通过后删除旧归因 Worker 路由、API 服务、Web 平台逻辑和主 D1 旧表。
7. 历史 migration 文件仅保留数据库升级事实，不属于运行时兼容逻辑。

### 19.4 回滚

- 切换前：直接放弃新资源，旧 Active 不受影响。
- 切换后观察期：回切路由并恢复切换 bookmark，禁止两边同时消费 Queue。
- 观察期结束：删除运行时回滚路径，只保留脱敏事故证据和 Cloudflare 备份。

## 20. 测试策略

### 20.1 状态机和数据层

- 首次候选验证成功
- 候选失败时 Active 不变
- 新候选 supersede 旧候选
- Active 并发变化阻止旧候选激活
- D1 任一步失败时激活事务整体回滚
- 重复命令不产生重复版本、审计或 delivery
- 运行策略修改不改变 Active Version

### 20.2 平台隔离矩阵

至少覆盖：

```text
Meta source   -> Meta connection A only
Meta source B -> Meta connection B only
TikTok source -> TikTok only
Google source -> Google only
direct        -> none
conflict      -> none + incident
invalid proof -> none
single default + click ID -> default connection
multiple connections + click ID only -> none + incident
```

### 20.3 Browser 与业务行为

- PageView 只初始化可信来源平台
- Contact 外链、复制和移动端跳转
- 注册事务成功和失败
- Browser/Server 同一 event ID
- 页面隐藏、关闭和离线恢复
- 地区授权、GPC、退出和来源切换

### 20.4 Queue 与平台

- Queue enqueue 失败
- consumer 超时和重试
- DLQ 和 D1 outbox 恢复
- 平台 4xx、5xx、超时和非法响应
- Adapter 跨平台 payload 拒绝
- synthetic 测试事件不进入业务指标

### 20.5 部署隔离

- 仅修改图库、会员、SEO、Telegram 等模块并发布 Web/API。
- 发布前后 Active Version、凭证指纹、运行策略和 Attribution Worker 版本保持不变。
- Attribution Worker 独立回滚不影响 Web/API 业务数据。

## 21. 完成标准

只有以下条件全部满足才算完成：

1. Attribution Worker、D1、Queue、Secret 和部署脚本独立。
2. Git commit 已从所有归因运行判断中删除。
3. 身份配置和运行策略使用不同命令、表和权限边界。
4. 候选验证和原子激活状态机通过故障注入测试。
5. Meta、TikTok、Google 通过同一 Adapter 契约。
6. 同平台多连接和跨平台隔离矩阵全部通过。
7. 正常验证覆盖事实、Planner、Outbox、Queue 和 Adapter 全链路。
8. 其他模块发布不会部署 Attribution Worker，也不会修改归因 D1。
9. 生产切换期间没有双投递，现有投放链接保持有效。
10. 旧归因运行代码、旧数据表和永久兼容逻辑全部删除。
11. 后台不再显示 revision、credential revision 或 Git commit 门禁。
12. 生产 smoke、集合对账、回滚演练和容量检查均通过。

## 22. 官方参考

- Cloudflare Service Bindings: <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/>
- Cloudflare D1: <https://developers.cloudflare.com/d1/>
- Cloudflare D1 Pricing: <https://developers.cloudflare.com/d1/platform/pricing/>
- Cloudflare Queues Pricing: <https://developers.cloudflare.com/queues/platform/pricing/>
- Cloudflare Queues Limits: <https://developers.cloudflare.com/queues/platform/limits/>
- Cloudflare Workers Pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
