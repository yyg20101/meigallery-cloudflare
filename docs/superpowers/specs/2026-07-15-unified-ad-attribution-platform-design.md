# Meta、TikTok、Google 通用广告归因平台设计

- 设计讨论状态：`已确认（2026-07-15）`
- 书面评审状态：`已确认（2026-07-15）`
- 设计版本：`2`
- 适用环境：`production` 是唯一真实广告平台验证环境；`dev/local` 仅执行代码、迁移、Mock 和契约验证
- 成本基线：Cloudflare Workers Free，当前设计不要求开通 Paid

## 1. 背景

项目当前已经实现 Meta Pixel/CAPI、TikTok Pixel/Events API、广告来源路由、浏览器与服务端共享事件编号、D1 Outbox、Cloudflare Queues、重试、DLQ 和后台归因工作台。

现有实现仍然存在结构性问题：

- Meta 和 TikTok 在连接验证、事件映射、凭证、质量诊断、rollout 和 incident 方面仍有平台专属分支。
- 连接模型假设一个平台只有一个目标 ID，无法表达 Google Ads Tag、Label 和 Website conversion action ID 的组合。
- 业务层直接区分 Meta/TikTok，继续增加 Google 会形成第三套处理路径。
- 归因上下文只覆盖 Meta/TikTok，无法保存 `gclid`、`gbraid`、`wbraid`。
- 部分投递统计按外部事件名称聚合；Google Ads 的不同转化都使用 `conversion`，会造成口径合并。
- Test Event Code、验证证据、Commit 门禁和定时轮询过度耦合，曾造成重复验证和发布阻断。
- 当前 Cloudflare 账户未开通 Workers Paid，架构必须在 Free 配额内具备可靠运行能力。

本次不再扩展旧实现，也不保留 Meta 兼容层。Meta、TikTok、Google Ads 一次迁移到最终通用架构，平台协议差异只能存在于 Adapter 内。

## 2. 核心决策

1. Meta、TikTok、Google Ads 本期同时纳入运行时，不把 Google 留作未来占位。
2. 业务层只创建标准转化事实，不认识 Pixel、Label、CAPI 或 Data Manager Payload。
3. 一条转化事实最多归属一个广告平台，禁止 fan-out、fallback 和“向所有已启用平台发送”。
4. 浏览器和服务端对同一平台转化使用同一个平台无关事件编号。
5. 平台配置在后台作为一套逻辑连接管理，敏感凭证单独加密且永不回显。
6. 真实广告验证仅在 production 完成；dev/local 禁止调用三家正式 API。
7. Cloudflare Queues 负责实时服务端投递，Workflows 只负责连接验证、等待诊断和 rollout 编排。
8. D1 是配置、事实、Outbox、状态和审计的唯一精确账本。
9. 不使用 Zaraz 作为归因核心，避免项目后台与 Cloudflare Dashboard 形成双控制面。
10. 不接入 GA4；Google Ads 原生转化与未来 GA4 分属广告和分析两个独立模块。
11. 不保留旧表双读、双写、旧环境变量 fallback、一次性运行时代码或平台专属业务分支。
12. 迁移失败时通过 Production D1 备份和 Worker 历史版本回滚，不通过兼容代码回滚。

## 3. 目标与非目标

### 3.1 目标

- 统一 Meta、TikTok、Google Ads 的连接、事件绑定、凭证、验证、投递、诊断、rollout 和后台管理。
- 明确定义 `Contact` 和 `CompleteRegistration`，确保三平台使用同一业务口径。
- Facebook 来源只发送 Meta，TikTok 来源只发送 TikTok，Google Ads 来源只发送 Google。
- 支持三平台同时启用，但每个访问和转化只激活一个广告平台。
- 在 Workers Free 下可靠运行，并在后台提供容量安全线和升级提示。
- 删除旧平台专属运行代码、运行表、资源、Secret 和过时文档口径。
- 以后接入新广告平台时，只增加平台注册信息、事件映射和 Adapter。

### 3.2 非目标

- 不导入广告花费、Campaign、Ad Group、Ad Set 或广告平台报表。
- 不在本期接入 GA4、Google Analytics 或跨渠道营销报表。
- 不把自然搜索、直接访问或无法确认来源的访问发送给广告平台。
- 不发送 PageView、ViewContent、Search 等行为作为服务端主要转化。
- 不确认用户跳转 Telegram 等外部网站后是否最终发送消息；项目只能确认合法联系链接被激活。
- 不删除已经应用的历史 D1 migration 文件；历史 migration 不是运行时兼容逻辑，最终 Contract migration 负责收口生产 Schema。

## 4. 标准业务事件

### 4.1 转化事件

```ts
type CanonicalConversionEvent =
  | 'Contact'
  | 'CompleteRegistration'
```

| 标准事件 | 精确业务口径 | 浏览器 | 服务端 |
|---|---|---:|---:|
| `Contact` | 用户激活通过安全 URL 校验的外部联系链接并开始导航 | 是 | 是 |
| `CompleteRegistration` | 用户注册事务已经成功提交 | 是 | 是 |

复制联系方式、展示二维码、展开联系面板、无效 URL、被安全策略阻止的 URL 和页面浏览只进入内部行为分析，不创建广告转化事实。

### 4.2 非转化浏览器信号

`PageView`、`ViewContent`、`Search` 可以由 Browser Adapter 按平台能力发送，但它们：

- 不创建服务端转化事实。
- 不进入 Contact/Registration 漏斗。
- 不参与服务端 rollout 和主要转化成功率。
- 仍然遵守营销同意和单一来源平台隔离。

### 4.3 平台映射

| 标准事件 | Meta | TikTok | Google Ads Browser | Google Data Manager API |
|---|---|---|---|---|
| `Contact` | `Contact` | `Contact` | `conversion` + Contact `send_to` | Contact Website conversion action ID |
| `CompleteRegistration` | `CompleteRegistration` | `CompleteRegistration` | `conversion` + Registration `send_to` | Registration Website conversion action ID |

Google 的两个转化都叫 `conversion`，内部看板、事实、投递和统计必须始终使用 `canonical_event`，不能按平台外部事件名聚合。

## 5. 总体架构

```text
合法业务动作
  -> Canonical Conversion Fact
  -> Attribution Resolver
  -> 唯一 attribution_provider
  -> Delivery Planner
       -> Browser Instruction
       -> D1 Delivery + Outbox
  -> Provider Queue
  -> Provider Adapter
  -> Meta / TikTok / Google API

后台验证
  -> Cloudflare Workflow
  -> 凭证/目标/Test Event/诊断步骤
  -> D1 Verification State
```

### 5.1 通用核心

通用核心只负责：

- 标准事件和精确业务口径。
- 同意快照、广告来源解析和来源冲突处理。
- 不可变的平台归属。
- 平台无关事件编号。
- 连接与事件绑定快照。
- D1 事实、Delivery、Outbox、审计和通用状态机。
- 确定性 rollout、幂等、重试、DLQ 和 incident。

通用核心禁止构造任何平台 Payload，禁止通过 `if (provider === 'meta')`、`if (provider === 'tiktok')` 或 `if (provider === 'google')` 实现业务行为。

### 5.2 Cloudflare 组件分工

| 组件 | 职责 |
|---|---|
| API Worker | 业务事实、归因解析、Browser Instruction、管理 API、Queue consumer |
| Web Worker | Nuxt 页面、同意交互、Browser Adapter |
| D1 | 配置、事实、Outbox、投递状态、验证状态、审计 |
| Queues | 三个平台的实时异步服务端投递 |
| Workflows | 连接验证、等待平台诊断、rollout 编排 |
| Worker Secret | 通用凭证主密钥及轮换密钥 |
| Workers Web Crypto | AES-256-GCM、HMAC、Google Service Account JWT |

当前不引入 KV、Durable Objects、Analytics Engine、Service Binding、R2 归因存储或 Zaraz。

### 5.3 平台物理 Queue

```text
meigallery-ad-meta
meigallery-ad-meta-dlq
meigallery-ad-tiktok
meigallery-ad-tiktok-dlq
meigallery-ad-google
meigallery-ad-google-dlq
```

三条 Queue 由同一个 API Worker 消费，但每个 Batch 必须根据 `batch.queue` 绑定唯一 Adapter。消息中的 provider、D1 Delivery provider 和 Queue provider 三者不一致时直接拒绝并记录 critical incident。

## 6. 平台注册表与 Adapter

### 6.1 能力声明

```ts
interface AdPlatformCapabilities {
  browser: boolean
  server: boolean
  pairedDeduplication: boolean
  temporaryTestCode: boolean
  validateOnly: boolean
  asynchronousDiagnostics: boolean
  managedRollout: boolean
  platformQuality: boolean
}
```

后台字段、验证步骤、质量区域和操作按钮从平台注册表与类型化 Schema 生成，不在 Vue 页面内维护平台分支。

### 6.2 Adapter 边界

```ts
interface EventMappingAdapter {
  describe(input: CanonicalEventInput): PlatformEventDescriptor | null
}

interface BrowserTrackingAdapter {
  initialize(config: BrowserPublicConfig): Promise<void>
  track(instruction: BrowserInstruction): Promise<BrowserTrackingResult>
  teardown(): Promise<void>
}

interface ServerTrackingAdapter {
  buildPayload(input: ServerDeliveryInput): Promise<unknown>
  send(input: ServerRequestInput): Promise<ProviderReceipt>
  classifyError(error: unknown): DeliveryClassification
}

interface VerificationAdapter {
  buildWorkflow(input: VerificationInput): VerificationPlan
}

interface PlatformQualityAdapter {
  collect(input: QualityInput): Promise<QualitySnapshot>
}
```

核心只消费类型化结果：`accepted`、`processed`、`retryable`、`rejected`、`credential_invalid`、`destination_invalid`。平台错误码解析只能存在于对应 Adapter。

## 7. 连接、事件绑定与凭证

为满足 Expand 阶段不修改旧运行表的约束，以下名称是逻辑模型名；最终物理表固定使用 `attribution_platform_connections`、`attribution_event_bindings` 和 `attribution_credentials`。旧 `ad_platform_connections` 只在 Contract 阶段删除，不参与新运行时。

### 7.1 `ad_platform_connections`

通用连接表保存：

- `id`
- `provider`
- `enabled`
- `mode`
- `browser_enabled`
- `server_enabled`
- `public_config_json`
- `attribution_window_days`
- `rollout_target_percentage`
- `rollout_effective_percentage`
- `connection_revision`
- `credential_revision`
- `created_at` / `updated_at`

`public_config_json` 是由 Adapter Schema 验证的 discriminated union：

```ts
type PlatformPublicConfig =
  | { provider: 'meta'; pixelId: string }
  | { provider: 'tiktok'; pixelCode: string }
  | {
      provider: 'google'
      tagId: string
      customerId: string
      loginCustomerId?: string
      cloudProjectId: string
    }
```

不增加 `meta_pixel_id`、`tiktok_pixel_code`、`google_tag_id` 等平台专属数据库列。

Provider 使用开放字符串标识并由平台注册表校验，数据库不得再使用只允许 `meta/tiktok/google` 的封闭 `CHECK`。Delivery 和 Outbox 通过 connection ID、provider 的组合外键与触发器保持一致；未来新增平台时不重建核心事实表。

### 7.2 `ad_platform_event_bindings`

每个平台、每个标准事件独立保存：

- `provider`
- `canonical_event`
- `enabled`
- `browser_destination`
- `server_destination`
- `mapping_revision`
- `config_json`
- `updated_at`

Meta/TikTok 可以使用连接目标；Google 必须为 Contact 和 Registration 分别配置：

- Browser：`AW-ID/LABEL`
- Server：Website conversion action ID

Browser Label 与 Server conversion action ID 必须属于同一个 Google Ads 转化操作。

### 7.3 `ad_platform_credentials`

凭证表保存：

- `connection_id`
- `provider`
- `credential_type`
- `ciphertext`
- `key_id`
- `fingerprint`
- `credential_revision`
- `created_by`
- `created_at` / `updated_at`

凭证 Bundle：

- Meta：CAPI Access Token
- TikTok：Events API Access Token
- Google：Service Account JSON

公开配置、事件绑定和凭证在后台作为一次逻辑保存操作提交，共享新的连接 revision。凭证写入失败时整个保存失败，不能形成“新 ID + 旧 Token”的半配置状态。

## 8. 归因上下文与来源隔离

### 8.1 来源信号

| 平台 | 强来源信号 |
|---|---|
| Meta | `fbclid`，以及按协议生成或保留的 `fbc` |
| TikTok | `ttclid` |
| Google Ads | `gclid`、`gbraid`、`wbraid` |

来源解析优先级：

1. 明确 Click ID。
2. 后台生成并签名的广告投放链接。
3. 严格广告来源别名。
4. 无可靠信号时不建立广告归因。

`utm_source=google` 可能是自然搜索，不能判定为 Google Ads。只有 `google-ads`、`google_ads`、`adwords` 等明确广告别名可以作为低优先级广告信号。

同一请求同时存在多个平台强信号时，结果为 `attribution_conflict`：不选择平台、不加载 Pixel、不创建广告 Delivery，只记录脱敏冲突审计。

### 8.2 加密归因上下文

用户同意营销追踪后，服务端设置 `Secure + HttpOnly + SameSite=Lax` 的加密 Cookie：

```ts
interface AdAttributionContext {
  version: 1
  contextId: string
  provider: AdAttributionProvider
  source: 'click_id' | 'managed_link' | 'utm_alias'
  identifiers: Record<string, string>
  issuedAt: number
  expiresAt: number
}
```

默认窗口为 30 天，可按平台连接调整。`contextId` 是随机、非 PII 标识，用于撤回同意时取消尚未投递的 Outbox。Cookie 不保存 PII。新的明确广告点击替换旧上下文；普通站内导航不修改来源。

浏览器不能读取加密 Cookie。站点配置接口只返回当前 provider 和对应 Browser Instruction，不返回 Click ID、Token 或其他敏感内容。

### 8.3 不可变平台归属

业务事实创建时保存唯一 `attribution_provider`。创建后禁止修改：

- Meta Adapter 只能接收 `fbclid/fbc/fbp`。
- TikTok Adapter 只能接收 `ttclid/ttp`。
- Google Adapter 只能接收 `gclid/gbraid/wbraid`。
- 无来源事实继续进入内部分析，但广告 Delivery 数量为零。
- D1 触发器拒绝 Fact、Delivery、Outbox provider 不一致的写入。

## 9. 同意与隐私

### 9.1 标准同意快照

```ts
interface AdConsentSnapshot {
  consentVersion: number
  marketingAllowed: boolean
  adUserDataAllowed: boolean
  adPersonalizationAllowed: boolean
  decidedAt: string
}
```

没有营销同意时：

- 内部必要业务事实可以记录。
- 不加载广告平台脚本。
- 不保存广告 Click ID。
- 不创建广告平台 Delivery。
- 不向任何广告平台发送事件。

首次进入且未作选择时，Click ID 只保留在当前页面内存；用户同意后才提交服务端建立加密上下文。撤回同意时删除归因 Cookie、项目设置的广告 Cookie，并取消尚未投递的 Outbox。

### 9.2 Google Consent Mode v2

采用 Basic Consent Mode。加载 Google Tag 前先设置默认状态：

```ts
{
  ad_storage: marketingAllowed ? 'granted' : 'denied',
  ad_user_data: adUserDataAllowed ? 'granted' : 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied'
}
```

当前不接入 GA4，因此 `analytics_storage` 始终为 `denied`。未来 GA4 必须使用独立分析同意，不能借用广告授权自动启用。

### 9.3 匹配数据

| 平台 | 允许匹配数据 |
|---|---|
| Meta | `fbc/fbp`、经同意的 IP/UA、注册时的哈希邮箱 |
| TikTok | `ttclid/ttp`、经同意的 IP/UA、注册时的哈希邮箱 |
| Google | `gclid/gbraid/wbraid`、经同意的哈希邮箱 |

Google Adapter 永不显式发送 IP。邮箱只在服务端规范化并执行 SHA-256，不发送明文，也不进入 Browser Instruction。Contact 没有邮箱时只发送真实存在的点击和浏览器标识，禁止伪造匹配数据。

## 10. 通用事件编号与投递

### 10.1 事件编号

现有 Meta 命名空间事件编号被删除。新格式：

```text
mg3_<base64url-hmac>
```

编号基于事实 ID、标准事件和版本生成一次后持久化，长度不得超过 64 字符。映射如下：

- Meta：`event_id`
- TikTok：`event_id`
- Google Browser：`transaction_id`
- Google Server：`transactionId`

重复请求、Queue 重试和浏览器重放必须复用同一编号。

### 10.2 D1 原子事实与 Outbox

同一 D1 batch/transaction 写入：

1. Canonical Fact。
2. Provider Delivery。
3. 加密 Outbox。
4. 脱敏审计。

事务提交后尝试写入 Queue。Queue 发送失败、请求中断或消息过期时，Outbox 仍保留。每 15 分钟执行一次轻量恢复 Cron，扫描 `pending` 和超时 `queued` 记录并重新入队。

### 10.3 状态机

```text
planned -> queued -> accepted -> processed
                    -> retrying
                    -> rejected
                    -> dead_letter
                    -> cancelled
```

`accepted` 只表示平台 API 接收，不代表归因、匹配或最终处理成功。Google 的异步诊断、Meta/TikTok 回执分别保存为通用 Provider Receipt。

只有平台提供可核验的下游诊断时才能进入 `processed`；没有下游处理查询能力的平台保持 `accepted`，后台不得伪造“处理完成”。

匹配信息使用通用 `match_signals_json`，例如 `['gclid', 'hashed_email']`，不再增加 `has_fbc`、`has_ttclid` 等平台列。

### 10.4 Queue 规则

- Cloudflare Queues 是至少一次投递，消费者必须幂等。
- 正常消息最多自动重试 3 次。
- `4xx` 参数/目标错误直接拒绝，不重试。
- `429`、网络错误和 `5xx` 才允许延迟重试。
- 达到上限进入对应 DLQ，并同步 D1 状态。
- Queue 消息小于 64 KB。
- Outbox 只有在最终处理或人工取消后才能清除加密 Payload。

## 11. Google Ads 接入

### 11.1 Browser

Google Ads Browser Adapter 使用 Google Tag：

```ts
gtag('event', 'conversion', {
  send_to: 'AW-ID/LABEL',
  transaction_id: externalEventId,
})
```

Contact 和 CompleteRegistration 使用两个独立 Google Ads Website conversion action 和 Label。项目不使用 GA4 的 `generate_lead`、`sign_up` 代替 Ads 原生转化。

### 11.2 Server

Google Server Adapter 使用 Data Manager API：

```text
POST https://datamanager.googleapis.com/v1/events:ingest
Scope: https://www.googleapis.com/auth/datamanager
```

请求包含：

- `operatingAccount`：`{ accountType: 'GOOGLE_ADS', accountId: Google Ads Customer ID }`。
- `loginAccount`：可选的 `{ accountType: 'GOOGLE_ADS', accountId: Manager Account ID }`。
- `productDestinationId`：对应 Website conversion action ID。
- `transactionId`：与 Browser `transaction_id` 相同。
- `eventSource: 'WEB'`；上传哈希用户数据时请求级 `encoding: 'HEX'`。
- `gclid/gbraid/wbraid` 或经同意的哈希用户数据。

本项目事件编号只写入 `events[].transactionId`。请求顶层不发送自定义 `requestId`；成功响应中的 `requestId` 由 Google 生成，用于后续状态诊断。Service Account REST 请求发送 `x-goog-user-project`，值为连接配置的 Google Cloud Project ID。

Data Manager API 不需要 Google Ads Developer Token。

### 11.3 Google 凭证

推荐 Google Cloud Service Account：

1. 创建 Google Cloud Project。
2. 启用 Data Manager API。
3. 创建 Service Account 和 JSON Key。
4. 将 Service Account 邮箱加入 Google Ads Account 或 Manager Account。
5. 在项目后台导入 Service Account JSON。

Worker 使用 Web Crypto 的 RSA 能力签发短期 JWT，再交换 OAuth Access Token。Token 只缓存在当前 Worker isolate 内存，到期前刷新，不写入 D1、KV 或日志。多个 isolate 偶尔重复换 Token 可以接受。

Cloudflare Workers 不能直接使用 Google Cloud 原生 Workload Identity，因此静态 Service Account Key 是明确风险。后台必须支持凭证 revision 轮换：新 Key 验证通过后再由 Owner 在 Google Cloud 删除旧 Key，项目不保留旧 Key fallback。

## 12. 凭证安全

- 平台凭证使用 AES-256-GCM 加密保存到 D1。
- Worker Secret 只保存 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 和轮换窗口使用的 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS`。
- 凭证、Outbox 和归因上下文使用 HKDF 从主密钥派生不同 purpose key，禁止同一原始密钥跨用途直接加密。
- AAD 包含 connection ID、provider、credential type 和 credential revision。
- 后台只显示“已配置”、更新时间和截断指纹，不返回明文或密文。
- Token、Service Account、IV、完整指纹、原始 Click ID、邮箱和完整 Payload 禁止写入日志。
- 保存、轮换和删除凭证必须要求 Owner、同源 Origin/CSRF 校验、请求体限制和审计。
- 密文篡改、错误 AAD、未知 key ID 和跨 provider 解密全部 fail closed。

不使用 Cloudflare Secrets Store 保存平台凭证。当前单 Secret 大小和部署绑定模型不适合后台动态管理 Google Service Account JSON。未来仅允许把通用主密钥迁移到成熟的集中 Secret 能力，业务 Schema 不变。

## 13. 连接验证与 Workflows

### 13.1 幂等实例

```text
verify:<provider>:<connectionId>:<connectionRevision>:<credentialRevision>:<attempt>
```

“验证连接”创建或返回当前 attempt 的 Workflow。重复点击只返回现有状态，不重复发送测试事件。“重新验证”必须原子递增 attempt 后再创建新实例。

任何公开配置、凭证、事件绑定或协议 revision 变化都会使旧验证失效。Commit SHA 只作审计，不是连接或发布门禁。

### 13.2 平台验证

| 平台 | 自动验证 | 人工证据 |
|---|---|---|
| Meta | Pixel、Token、Graph API、事件绑定 | Events Manager Browser/Server 成对事件 |
| TikTok | Pixel、Token、Events API、事件绑定 | Events Manager Browser/Server 成对事件 |
| Google | OAuth、Data Manager `validateOnly`、转化操作绑定 | Tag Assistant 和真实 Production 诊断 |

Meta/TikTok Test Event Code：

- 每次验证时由 Owner 输入当前代码。
- 仅加密存在于本次 Workflow 输入。
- 完成或超时后清除。
- 不进入连接配置、Worker Secret、D1 长期状态或正式业务 Payload。

Google 没有 Test Event Code。先通过 `validateOnly` 验证身份、Schema 和目标，再使用真实且已授权的 production 流量完成 Live Evidence；禁止制造虚假广告转化。

### 13.3 Rollout

```text
browserEffective: 0% | 100%
serverTarget:     0% | 10% | 50% | 100%
serverEffective:  0% | 10% | 50% | 100%
```

服务端 rollout 使用 `externalEventId` 做确定性采样。鉴权失败、目标不匹配、拒绝率异常或 critical incident 只将对应平台 Server effective 降为 0，不影响其他平台、Browser 或内部分析。

平台验证和 Google 诊断可以使用 Workflow 的 sleep/retry；实时转化禁止创建 Workflow，避免步骤成本和不必要状态。

## 14. 管理后台

入口统一命名为“广告归因”：

```text
广告归因
  总览
  平台连接
    Meta
    TikTok
    Google Ads
  事件绑定
  投递质量
  验证记录
  审计日志
```

### 14.1 平台连接

- 按平台注册表动态渲染配置字段。
- 公开 ID、事件目标和凭证作为一套连接保存。
- 显示 Browser/Server 开关、连接 revision、凭证指纹、验证和 rollout。
- 不显示 Token、Service Account、Test Event Code 或原始 Click ID。

### 14.2 数据口径

总览必须区分：

- 内部标准转化数。
- 按唯一来源平台划分的转化数。
- Browser attempted。
- Server planned/queued/accepted/processed/rejected。
- 浏览器与服务端去重覆盖。
- 匹配信号完整率。
- Queue retry/DLQ。
- 未归因与来源冲突数量。

Browser attempted 不能描述为平台已接收，Server accepted 不能描述为平台已归因。

### 14.3 Free 容量面板

后台显示当日内部估算：

- Worker 动态请求。
- Queue 操作估算。
- D1 行读取与写入估算。
- Workflow 步骤。
- 服务端转化数。

达到 Free 额度 70% 时显示预警，但不自动切换到另一条投递路径。

这些数值是项目依据事实、Delivery、重试和查询元数据计算的容量估算，不冒充 Cloudflare 账单数据。Worker 账户总请求和官方资源用量仍以 Cloudflare Dashboard 为准；项目不为读取账单指标保存高权限 Cloudflare API Token。

## 15. Cloudflare Free 成本边界

当前公开 Free 配额及项目安全线：

| 资源 | Free 配额 | 项目安全线 |
|---|---:|---:|
| Worker 动态请求 | 100,000/天 | 70,000/天 |
| Queue 操作 | 10,000/天 | 7,000/天 |
| D1 读取 | 5,000,000 行/天 | 3,500,000 行/天 |
| D1 写入 | 100,000 行/天 | 70,000 行/天 |
| Workflow 步骤 | 3,000/天 | 2,100/天 |

一条正常 Queue 消息约产生写入、读取、删除三次操作。为重试和 DLQ 预留空间后，Meta、TikTok、Google 合计服务端转化安全线为 2,000 条/天。

达到以下任一条件时再评估 Workers Paid：

- Queue 连续 3 天超过 7,000 操作/天。
- 服务端转化接近 2,000 条/天。
- Worker 请求超过 70,000/天。
- D1 写入超过 70,000 行/天。
- Google JWT 或 Payload 构建持续触发 10ms CPU 限制。
- 业务已无法接受 Free Queue 24 小时消息保留窗口。

升级 Paid 只改变 Cloudflare 配额，不改变代码、数据库或归因协议。

## 16. 一次性迁移与清理

### 16.1 保留与删除

保留：

- Contact/CompleteRegistration 标准业务事实。
- 发生时间、历史来源平台和数据分析所需脱敏维度。
- 必要管理审计。

删除：

- Meta/TikTok 旧连接、验证、challenge、release evidence、rollout、incident 和质量运行表。
- 旧 Delivery、Outbox、Receipt、DLQ 和平台专属匹配字段。
- Commit 发布门禁、Live Attestation 和硬编码 Test Event Code。
- 旧 Token/Pixel 环境变量读取、旧 Queue 绑定、旧 API、旧组件和旧测试替身。
- 所有双读、双写、fallback 和兼容响应字段。

历史事实不重新投递，不补生成新事件编号。

### 16.2 切换步骤

1. 导出完整 Production D1 备份。
2. 将三平台 Server rollout 设为 0，等待旧 Queue、pending、retrying、DLQ 全部清零；未清零则中止迁移。
3. 执行安全 Expand migration，只创建最终通用表，不增加桥接 trigger、不双写、不修改旧运行表。
4. 部署只读取和写入新 Schema 的 API/Web；新运行时没有旧表读取路径。
5. 立即使用 `INSERT OR IGNORE` 将部署前的标准业务事实和必要历史统计从旧表一次性回填到新表；部署后的新事实已经直接进入新表。
6. 对账新旧标准事实数量、事件口径和历史趋势；不迁移旧技术投递状态。
7. 通过统一后台重新配置 Meta、TikTok、Google 并依次执行 production 验证。
8. 确认新运行时、事实对账和 Meta 10% 恢复全部通过后，执行 Contract migration 删除旧归因技术表和触发器。
9. 按门禁调整 TikTok 和 Google rollout。
10. 确认新 Queue 无旧消息后删除旧 Cloudflare Queue 和旧 Secret。

Expand 只解决 D1 与 Worker 无法原子发布的问题，不是兼容层：旧 Worker 只使用旧表，新 Worker 只使用新表，任何时刻都没有双读或双写。Contract 前失败可以部署上一 Worker 版本；Contract 后回滚必须恢复 D1 备份并部署上一 Worker 版本。

## 17. 测试策略

### 17.1 核心单元测试

- 来源解析、优先级、替换、过期和多平台冲突。
- Consent 拒绝、同意、撤回和 Cookie 清理。
- 标准事件口径和无效 Contact 行为。
- 平台无关事件编号稳定、幂等且小于等于 64 字符。
- Adapter 注册、事件描述和未知能力 fail closed。
- 凭证加密、轮换、错误 AAD、篡改和跨平台解密。
- 确定性 rollout 和 provider 不可变。

来源路由、同意、Delivery Planner、事件编号、Adapter 选择和跨平台阻断要求 100% 分支覆盖。

### 17.2 D1、Queue 与 Workflow

- Production Schema 快照迁移演练。
- 从 `0001` 到最新 migration 的空库演练。
- Fact、Delivery、Outbox 原子写入和 provider 约束。
- Queue 重复消费、3 次重试、消息过期、DLQ 和恢复入队。
- Workflow 重复验证幂等、超时、重启和旧 revision 失效。
- Test Event Code 自动清除。
- Free 配额计数和 70% 预警。

### 17.3 平台契约测试

- Meta/TikTok/Google 请求 Payload、Header、成功契约和错误分类。
- Google Service Account JWT、OAuth、`validateOnly`、Destination 和 `transactionId`。
- 三个平台 Browser/Server 相同事件编号。
- `4xx` 不重试，`429/5xx` 延迟重试。

### 17.4 浏览器隔离测试

Playwright 对每个平台执行桌面和移动测试：

- 未同意时零广告脚本和零平台请求。
- Meta 来源只允许 Meta 域名请求。
- TikTok 来源只允许 TikTok 域名请求。
- Google 来源只允许 Google Tag/Ads 请求。
- 无来源和冲突来源零广告请求。
- 新来源替换旧来源并卸载旧 Browser Adapter。
- Contact 只在合法外链导航时创建。
- CompleteRegistration 只在注册成功后创建。

任何来源访问其他平台域名都使测试立即失败。

### 17.5 Production 验证

- Meta/TikTok 使用当前 Test Event Code 完成 Browser/Server 成对去重。
- Google 完成 OAuth、`validateOnly`、Tag Assistant 和真实 Live Evidence。
- Google JWT 和 Payload 构建满足 Workers Free 10ms CPU 门禁。
- 验证后台事实、Delivery、回执和平台后台事件编号一致。
- 验证不存在跨平台请求、重复业务事实和敏感日志。

## 18. 发布流程

```text
API/Web 类型检查与构建
-> 单元、D1、Queue、Workflow、Playwright 测试
-> Production D1 快照迁移演练
-> Wrangler dry-run
-> Production D1 备份
-> 一次性 Schema 切换
-> 部署 API/Web
-> 平台重新配置
-> Production 验证
-> Server 0% -> 10% -> 50% -> 100%
```

- Dev 只验证代码、Mock、迁移和浏览器隔离。
- Production 真实验证不依赖 Commit SHA。
- Meta、TikTok、Google 可以使用不同 rollout，但底层通用 Schema 和运行时必须一次切换。
- 平台连接或凭证变化只使对应平台验证失效，不影响无关功能部署。
- 紧急停止通过后台将对应平台 Server effective 设为 0，不需要部署代码。

## 19. 完成标准

- Meta、TikTok、Google 都由同一连接、事件绑定、凭证、验证、投递和 rollout 核心管理。
- 业务代码不存在平台 Payload 分支、旧表读取、双写或 fallback。
- Meta、TikTok、Google 来源严格隔离，同时开启不产生 fan-out。
- Contact 和 CompleteRegistration 在三平台保持同一业务口径。
- Browser/Server 共享小于等于 64 字符的事件编号并正确去重。
- Google Ads 原生 Tag 和 Data Manager API 通过 production 验证。
- Test Event Code 不硬编码、不长期保存、不进入正式 Payload。
- 凭证、Click ID、邮箱和完整 Payload 不泄漏。
- Free 容量面板和 70% 预警生效，当前不产生新增固定费用。
- 旧运行表、旧 Queue、旧 Secret、旧路由、旧 UI、旧兼容测试和过时文档口径完成清理。
- 后续新增广告平台不修改 Contact、Registration、Consent、Attribution Resolver、Delivery Planner、后台页面骨架或通用状态机。

## 20. 官方参考

- Google Ads 网站转化：https://developers.google.com/tag-platform/devguides/conversions
- Google Ads Transaction ID：https://support.google.com/google-ads/answer/6386790
- Google Data Manager API 事件：https://developers.google.com/data-manager/api/devguides/events/send-events
- Google Ads 在线转化：https://developers.google.com/data-manager/api/devguides/events/google-ads/online
- Google Data Manager API 鉴权：https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- Google Consent Mode：https://developers.google.com/tag-platform/security/guides/consent
- Cloudflare Queues 投递保证：https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Cloudflare Queues 定价：https://developers.cloudflare.com/queues/platform/pricing/
- Cloudflare Workflows：https://developers.cloudflare.com/workflows/
- Cloudflare Workflows 定价：https://developers.cloudflare.com/workflows/reference/pricing/
- Cloudflare Workers Web Crypto：https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Cloudflare D1 batch/transaction：https://developers.cloudflare.com/d1/worker-api/d1-database/
