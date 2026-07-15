# 通用广告归因平台与 TikTok 接入设计

- 设计讨论状态：`已确认`
- 书面评审状态：`等待用户确认`
- 设计版本：`1`
- 适用环境：`production` 为唯一真实平台验证环境，`dev/local` 仅执行代码与模拟契约验证

## 1. 背景

项目已经具备 Meta Pixel、Conversions API、TikTok Pixel、TikTok Events API、统一转化事实、来源路由、Queue、加密 outbox、重试和后台归因看板。当前主要问题不是缺少 TikTok SDK，而是控制面仍然存在平台专属实现：Meta 使用独立的连接验证、live challenge、发布证据、rollout 和 incident，TikTok 只有较轻量的连接验证。

继续在现有结构上增加 TikTok 专属门禁会形成两套控制逻辑，后续接入 Google 时仍需复制连接、验证、证据和后台页面。目标因此调整为一次完整收口：统一业务事实、控制面和投递状态机，只把外部协议差异保留在平台 Adapter 中。

## 2. 目标

1. 将 Meta 与 TikTok 迁入同一套连接、凭证、测试挑战、发布证据、rollout、incident 和质量诊断框架。
2. TikTok 首期以 `Contact` 为主要广告优化事件，`CompleteRegistration` 为次级观察事件，两者都必须通过正式验证。
3. Pixel 全量启用后，TikTok Events API 按 `0% -> 10% -> 50% -> 100%` 人工放量。
4. Meta 与 TikTok 可以同时启用，但一条业务事实最多归属一个广告平台，禁止 fan-out。
5. 后续接入 Google 时，不修改联系、注册、来源路由、投递状态机、后台页面骨架或发布门禁核心，只新增平台注册信息与 Adapter。
6. 最终删除旧 Meta/TikTok 专属控制代码、旧运行表、双写和兼容分支。
7. Pixel/Dataset ID 与 Token 在管理后台作为一个逻辑连接管理，Token 加密保存且永不回显。

## 3. 非目标

- 本阶段不接入 Google，只保证架构和契约可以直接扩展。
- 不导入广告花费、campaign、ad group 或 ad 报表。
- 不把无广告来源的站内行为广播给任何广告平台。
- 不根据“当前启用了哪些平台”猜测归因平台。
- 不确认用户在 Telegram 等外部网站最终发送了消息；跨域目标页面的最终状态不可观测。
- 不删除已经应用的历史 migration 文件。历史 migration 是数据库演进记录，contract 只删除生产运行表和应用兼容逻辑。

## 4. 统一业务事件

### 4.1 规范事件

内部事件使用平台无关名称：

| 规范事件 | 业务口径 | 当前投递范围 |
|---|---|---|
| `Contact` | 用户激活经过安全 URL 校验的外部联系链接 | Browser + Server |
| `CompleteRegistration` | 用户注册事务已经成功完成 | Browser + Server |
| `PageView` | 允许营销追踪的公开页面被访问 | Browser |
| `ViewContent` | 重要公开内容详情被查看 | Browser |
| `Search` | 用户完成站内搜索 | Browser |

`Contact` 的“成功”表示浏览器接受合法外部链接的导航动作。复制联系方式、展开二维码、打开联系面板或点击没有合法外链的元素只进入站内行为分析，不创建广告转化事实。

这项口径对所有广告平台一致，避免 Meta 与 TikTok 对同一个业务动作产生不同定义。Meta 的事件名和去重协议不变，但复制行为不再被当作广告 `Contact`。

### 4.2 事件映射

规范事件必须经过 Adapter 显式映射：

| 规范事件 | Meta | TikTok | Google 预期示例 |
|---|---|---|---|
| `Contact` | `Contact` | `Contact` | `generate_lead` |
| `CompleteRegistration` | `CompleteRegistration` | `CompleteRegistration` | `sign_up` |
| `ViewContent` | `ViewContent` | `ViewContent` | `view_item` 或明确不支持 |
| `Search` | `Search` | `Search` | `search` |

核心不得假设不同平台的外部事件名相同。Adapter 未声明映射时必须 fail closed，不能回退到规范事件字符串。

## 5. 分层架构

```text
安全业务动作
  -> Canonical Conversion Fact
  -> Attribution Resolver
  -> 单一 provider
  -> Delivery Planner
       -> Browser Adapter
       -> Server Adapter
  -> 通用 Queue / Outbox / Retry / DLQ
  -> Provider API
```

### 5.1 通用核心

通用核心负责：

- 规范业务事件和有效口径。
- 营销授权与广告来源解析。
- 单平台归属和冲突 fail closed。
- Browser/Server delivery 规划。
- 同一平台、同一事实的共享 `event_id`。
- 连接 revision、加密 outbox、lease、重试、DLQ 和幂等。
- 测试挑战、人工证据、rollout target/effective、incident 和审计。
- 按 provider 隔离的趋势、转化、匹配覆盖、重复诊断和发布状态。

核心业务模块不得通过 `if (provider === 'meta')` 或 `if (provider === 'tiktok')` 构造平台 payload。平台分支只允许存在于注册表或对应 Adapter 内部。

### 5.2 平台能力注册表

每个平台声明能力，不支持的能力必须显式为 `false`：

```ts
interface AdPlatformCapabilities {
  browser: boolean
  server: boolean
  pairedDeduplication: boolean
  testEvents: boolean
  managedRollout: boolean
  incidents: boolean
  platformQuality: boolean
}
```

后台导航、连接编辑器、验证步骤、发布门禁和质量区域均从能力注册表生成，不再通过 Meta/TikTok 页面分支拼装。

### 5.3 平台 Adapter

平台实现拆成小型接口，避免一个大型 Adapter 同时承担浏览器、服务端和运维职责：

```ts
interface EventMappingAdapter {
  mapEvent(event: CanonicalEvent): PlatformEvent | null
}

interface BrowserTrackingAdapter {
  initialize(destinationId: string): boolean
  pageView(): boolean
  track(event: PlatformEvent, payload: object, eventId?: string): boolean
  teardown(): void
}

interface ServerTrackingAdapter {
  buildPayload(input: ServerEventInput): object
  buildRequest(credential: string, payload: object): RequestInit
  classifyResponse(response: Response, body: unknown): DeliveryResult
}

interface VerificationAdapter {
  buildTestPlan(input: TestPlanInput): TestPlan
  verifyConnection(input: VerificationInput): Promise<VerificationResult>
}

interface PlatformQualityAdapter {
  collect(input: QualityInput): Promise<QualityMetric[]>
}
```

Meta 保留 Graph API、`fbp/fbc`、Dataset Quality 和 Meta 错误分类；TikTok 保留 Events API、`_ttp/ttclid`、`Access-Token` 和 TikTok 错误分类。这些协议差异不能互相复用验证结果。

## 6. 来源隔离与数据流

1. 页面只在营销授权有效且属于公开营销路由时解析广告来源。
2. `fbclid`、`ttclid`、明确平台 UTM 或后台投放链接只能解析出一个 provider。
3. 同时出现 Meta 与 TikTok 信号、显式未知来源、非法输入、过期签名或数据库错误时，解析结果为空。
4. 业务动作先创建一次规范事实，事实保存唯一 `attribution_provider`。
5. Delivery Planner 只读取事实上的 provider，不枚举所有已启用平台。
6. Browser 与 Server 对同一平台转化共用事件名和 `event_id`。
7. D1 约束拒绝事实 provider 与 delivery provider 不一致的写入。
8. 平台切换前先卸载旧 Browser Adapter，任何时刻最多激活一个广告 Pixel。

Meta 与 TikTok 同时开启只表示两个平台都具备服务能力，不表示同一用户事件向两个平台发送。

## 7. 通用数据模型

### 7.1 连接与凭证

`ad_platform_connections` 继续作为公开配置和运行状态入口，至少包含：

- `provider`
- `enabled`
- `mode`
- `browser_enabled`
- `server_enabled`
- `destination_id`
- `rollout_target_percentage`
- `connection_revision`
- `credential_revision`
- `updated_at`

新增 `ad_platform_credentials`：

- `provider`
- `credential_type`
- `ciphertext`
- `key_id`
- `fingerprint`
- `credential_revision`
- `created_by`
- `created_at`
- `updated_at`

凭证唯一键为 `provider + credential_type`。当前 Meta/TikTok 只需要 `access_token`，Google 可注册不同 credential type，但核心无需迁移。

### 7.2 连接数据密钥

新增 `ad_platform_connection_keys`。每个平台连接生成独立随机数据密钥，用于加密临时匹配上下文；数据密钥由通用根密钥包裹后保存。outbox 的 AAD 必须包含 `provider + connection_revision + delivery_id + event_id`，禁止跨平台或跨 revision 解密。

### 7.3 验证与证据

新增：

- `ad_platform_connection_verifications`
- `ad_platform_test_challenges`
- `ad_platform_release_evidence`
- `ad_platform_rollout_states`
- `ad_platform_incidents`
- `ad_platform_quality_snapshots`

连接验证绑定 `provider + destination identity + credential fingerprint + protocol version`。测试挑战保存短期状态，默认 10 分钟过期；Test Event Code 不落库。发布证据保存 provider、连接 revision、事件范围摘要、确认人、确认时间、失效时间和失效原因，不保存原始 event ID、Token、匹配参数或截图。

人工 Browser/Server 去重证据有效期为 30 天。连接身份、凭证、事件映射、协议版本或证据契约变化时立即失效。

### 7.4 数据完整性

- provider 必须来自平台注册表允许值。
- connection verification、challenge、evidence、rollout、incident 和 quality 均包含 provider。
- 所有更新必须同时限定 provider 和 connection revision。
- 一个 challenge 只能消费一次，一个人工确认只能绑定当前有效 challenge。
- 旧 revision 的验证、证据和 delivery 不得被新连接复用。

## 8. 通用加密凭证库

管理后台把目标 ID、Token、Browser、Server、验证和放量作为一个逻辑连接管理。敏感值采用不同安全级别存储：

- 公开目标 ID 保存在连接表。
- Token 使用 AES-256-GCM 加密后保存到 D1。
- Worker Secret 只保留 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 和轮换期使用的 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS`。
- 凭证 AAD 包含 `provider + credential_type + credential_revision`。
- API 永不返回 Token 原值；编辑页面只显示存在状态、更新时间和脱敏指纹。
- Token 只在 Owner 提交请求和 Worker 调用平台 API时短暂存在内存。
- 凭证写入、轮换和删除必须同时通过 Owner 权限、同源 Origin/CSRF 校验和请求体大小限制；输入框禁用自动填充，成功或失败后立即清空。
- 审计日志只记录设置、轮换、删除和 revision，不记录明文、密文、IV、完整指纹或 Test Event Code。
- current/previous 根密钥轮换完成前必须证明旧 key ID 引用归零，之后才能删除 previous。

密文篡改、错误 AAD、跨 provider 解密和未知 key ID 均必须 fail closed。

## 9. 测试挑战与人工证据

### 9.1 通用流程

1. Owner 输入当前平台的临时 Test Event Code。
2. 服务端校验资源、连接、凭证和 production 环境。
3. 创建包含 `Contact` 与 `CompleteRegistration` 的短期 challenge，每个事件生成新的 event ID。
4. Browser Adapter 尝试发送两项 Pixel 事件。
5. Server Adapter 使用相同事件名和 event ID 发送测试事件。
6. 平台 API 必须满足 Adapter 的严格成功契约。
7. 后台只显示 Browser“已尝试”和 Server“已接收”，不得把 Browser 尝试描述为平台已接收。
8. Owner 在平台 Test Events 中确认 Browser/Server 成对出现并完成去重。
9. Owner 回到后台提交人工确认，系统写入脱敏 release evidence。

重复点击开始测试会创建新 challenge，但不会创建生产业务事实。重复消费同一 challenge 或重复确认必须返回幂等结果，不能重复轮换连接 revision。

### 9.2 平台差异

- Meta verification Adapter 使用 Meta Pixel、Graph API 和 Meta Test Events。
- TikTok verification Adapter 使用 TikTok Pixel、Events API 和 TikTok Test Events。
- 两个平台都验证 `Contact`、`CompleteRegistration`，但证据不能跨 provider 复用。
- Test Event Code 只存在于当前页面内存和当次请求，刷新或离开页面后清空。

## 10. Rollout 与自动保护

Pixel 在连接、授权和来源条件满足后可全量运行；Server API 使用通用 target/effective rollout：

| 调整 | 必须满足 |
|---|---|
| `0% -> 10%` | 资源完整、连接有效、两个成对测试事件均被 Server API 接收 |
| `10% -> 50%` | 当前 revision 的人工去重证据有效、存在真实 `Contact` 成功样本、无跨平台投递、无凭证错误和重试耗尽 |
| `50% -> 100%` | 在 50% 至少稳定运行 24 小时、最近至少 20 条 Server 转化、最终成功率不低于 99%、无严重积压或 critical incident |

升级只允许 Owner 人工执行。降级可随时执行：

- 凭证被平台拒绝：连接失效、Server 关闭、effective 和 target rollout 归零。
- 连接 revision 变化：旧证据失效，effective rollout 归零。
- 人工证据超过 30 天：target 保留，effective rollout 自动上限降为 10%，重新确认后恢复。
- Queue、加密上下文或来源约束异常：对应 delivery fail closed，不改投其他平台。
- critical incident：effective rollout 自动归零，target 保留供故障恢复后人工处理。

Meta 当前 production 10% target/effective 必须在迁移前后保持一致。TikTok 在完成生产配置前始终保持 disabled、Server 关闭、rollout 0%。

## 11. 管理后台

现有 `总览 / 转化明细 / 投放链接 / 平台接入 / 发布与诊断` 五页结构保留，页面骨架全部通用化。

### 11.1 平台接入

- 从平台注册表生成 provider 切换和能力区域。
- 在同一连接编辑器中管理目标 ID、Token 写入、Browser、Server 和 mode。
- 显示凭证、Queue、数据密钥、连接验证和 challenge 状态，但不显示敏感值。
- 提供开始成对测试、Server 结果和人工去重确认。

### 11.2 发布与诊断

- blocker、warning、target/effective rollout 和 incident 按 provider 查询。
- 平台专属质量能力通过可选 quality Adapter 插入，不创建平台专属页面。
- Meta Dataset Quality 迁入 `ad_platform_quality_snapshots`，仍由 Meta Adapter 采集。
- 不支持质量 API 的平台明确显示“未接入平台质量诊断 API”，不能伪装成零问题。

### 11.3 准确文案

- Browser `attempted` 只显示“已尝试”。
- Server `sent` 只表示平台 API 满足严格成功契约，不表示广告归因成功。
- warning 不改变 blocker 状态。
- 历史 Lead 不进入活动漏斗、排序、比率或 rollout 门禁。

## 12. 错误处理、隐私与审计

- 所有平台错误先由 Adapter 归类为成功、可重试、永久失败、凭证失败或协议失败。
- 通用状态机只消费分类结果，不解析平台错误码。
- 重试使用 Queue 和 lease/CAS；达到上限进入平台独立 DLQ。
- 凭证失败必须使当前 verification 失效，阻止后续 Server delivery。
- 页面 URL、搜索词和属性继续经过 allowlist 与清洗；不向平台发送联系方式原文或敏感页面查询参数。
- `Contact` 与 `CompleteRegistration` 不发送无业务必要的 value、currency 或自定义描述。
- CompleteRegistration 仅在营销授权允许时发送已规范化并散列的 email/external_id。
- 所有连接、凭证、验证、人工确认、rollout、incident 和密钥轮换操作写入脱敏审计。

## 13. 测试策略

### 13.1 单元和契约测试

- 规范事件口径与平台映射。
- 每个已启用能力必须存在对应 Adapter。
- Meta/TikTok payload、header、响应成功和错误分类。
- Browser/Server 相同事件名和 event ID。
- 凭证加密、篡改、错误 AAD、跨 provider 解密和根密钥轮换。
- rollout gate、证据过期、incident 降级和幂等。

### 13.2 D1 与 Queue 集成测试

- 使用 Miniflare 运行全部 migration、backfill、约束和 contract。
- 验证 Meta 旧数据准确迁入通用表。
- 验证事实与 delivery provider 不一致时由 D1 拒绝。
- 覆盖 lease、并发消费、重试、DLQ、过期 outbox 和旧 revision。
- 验证 production 空库从 `0001` 到最新 migration 可完整建立最终 schema。

### 13.3 前端和端到端测试

- 未授权时不加载任何广告 Pixel。
- Meta 与 TikTok 同时开启时，每个来源只初始化自身 Pixel。
- 复制、二维码和面板动作不产生广告转化。
- 合法外链激活和真实注册产生正确 provider delivery。
- provider 切换后旧 Pixel 被卸载。
- 后台五页在 Meta/TikTok 下均显示正确、无跨平台状态、无敏感值。
- 使用桌面和移动视口验证状态、表格和控制按钮无重叠。

### 13.4 回归与构建

- 完整 API/Web 测试与覆盖率门禁。
- scripts/migration 测试、secret scan、lint、API TypeScript。
- API Worker dry-run 与 Nuxt production build。
- dev/local 的 fetch 必须使用模拟平台响应，禁止调用真实 Meta/TikTok API。

### 13.5 生产人工验收

- Meta `Contact`、`CompleteRegistration` Browser/CAPI 成对去重回归。
- Meta Dataset Quality、连接、incident 和 10% effective rollout 与迁移前一致。
- TikTok 两项事件 Browser/Server 成对出现并人工确认去重。
- TikTok 先启用 Pixel，再将 Events API 升至 10%；50% 和 100% 严格遵循门禁。

## 14. 生产迁移与清理

Cloudflare Worker 与 D1 无法原子发布，因此采用有终点的 expand/contract，不追求危险的一次性删除。

### 14.1 Expand

1. 只读记录 Meta 当前连接、revision、证据、rollout、incident、Queue 和 outbox 状态。
2. 创建通用表并迁移非敏感 Meta/TikTok 状态。
3. 设置通用根密钥。
4. 部署一次性 Owner 凭证导入能力，普通生产投递仍走当前稳定路径，不双写。
5. Worker 在内存中读取现有 Meta Secret，将其加密写入凭证库；验证指纹后完成审计。
6. 若存在旧 data key 加密的 pending/retrying outbox，先停止升级并等待排空，不进行不可靠的密文转换。

### 14.2 通用运行时切换

1. 在本地和真实 D1 fixture 中证明通用表状态与旧状态一致。
2. 部署只读取通用控制面的运行时。
3. Meta 保持 10%，TikTok 保持 0%，核对真实事件和后台状态。
4. 至少稳定观察 24 小时，期间不得出现连接失效、跨平台写入、重试耗尽或 critical incident。

### 14.3 Contract

1. 删除一次性凭证导入入口和旧运行分支。
2. 删除 `meta_connection_verifications`、`tiktok_connection_verifications`、`meta_live_challenges`、`meta_capi_incidents`、旧 Meta release verification/resource attestation 运行表和已被通用 outbox 取代的旧表。
3. 将 Meta Dataset Quality 历史摘要迁入通用质量表后删除旧运行表。
4. 删除 `META_CAPI_ACCESS_TOKEN`、Meta/TikTok 专属 data key Secret；只保留通用根密钥 current/previous。
5. 删除旧服务、路由、组件、类型、测试替身和过时文档说明。
6. 运行最终 schema、代码引用和 secret 扫描，确保不存在双写、fallback 或平台专属控制面。

历史 migration 文件继续保留。新的 contract migration 负责把经过全部历史迁移的数据库收敛到唯一最终 schema。

## 15. Google 扩展验收标准

未来接入 Google 时只允许新增：

1. Google provider 注册项和能力声明。
2. Google 事件映射。
3. Google Browser、Server、Verification 和可选 Quality Adapter。
4. Google 凭证类型和独立 Queue binding。
5. Google 官方契约测试。

以下模块不得因 Google 接入而修改业务分支：联系与注册事实、来源解析、通用 delivery planner、凭证库、challenge/evidence、rollout、incident、后台页面骨架和分析 API。若必须修改，说明本次通用化验收失败。

## 16. 完成标准

- Meta 与 TikTok 都由通用连接、凭证、验证、证据、rollout 和 incident 核心管理。
- 生产 Meta 的连接和 10% rollout 无回归。
- TikTok `Contact` 与 `CompleteRegistration` 通过生产 Browser/Server 去重验证。
- TikTok 来源只发送 TikTok，Meta 来源只发送 Meta，同时启用不产生 fan-out。
- 复制、二维码和面板展开不再计为广告 `Contact`。
- Token、Test Event Code、匹配参数和根密钥无明文泄漏。
- contract 后不存在旧平台专属控制表、双写、fallback 或兼容代码。
- Google 可按第 15 节扩展，不复制业务与控制面。

## 17. 实施拆分

该设计按四个可独立验证和回滚的里程碑实施，不把数据库迁移、Meta 切换和 TikTok 放量混入一次不可回退的发布：

1. **通用基础与凭证库**：完成通用 schema、根密钥、加密凭证、连接数据密钥和 Adapter 契约，生产行为不切换。
2. **Meta 迁移与通用控制面**：导入 Meta 凭证和状态，切换连接验证、challenge、evidence、rollout、incident、quality 与后台 UI，保持 production 10%。
3. **Contract 清理**：稳定观察后删除旧表、旧 Secret、一次性导入入口和全部兼容代码，验证最终 schema。
4. **TikTok 生产接入**：配置 TikTok Pixel/Token，完成两事件成对测试和人工去重确认，再执行 `0% -> 10% -> 50% -> 100%`。

每个里程碑都必须形成独立本地 commit、完整测试证据和明确回滚点；只有达到远端协作、CI、生产验证或部署节点时才统一推送。
