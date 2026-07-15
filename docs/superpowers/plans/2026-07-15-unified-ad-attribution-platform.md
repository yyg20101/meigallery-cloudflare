# Meta、TikTok、Google 通用广告归因平台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项实施。所有复选框必须随执行进度更新，不允许跨任务批量勾选。

**Goal:** 将现有 Meta/TikTok 两套归因实现一次性迁移到 Meta、TikTok、Google Ads 共用的最终架构，并在 production 完成三平台严格隔离、配对去重、加密凭证、可靠投递和后台运维验证。

**Architecture:** 业务层只创建 `Contact` / `CompleteRegistration` 标准事实；归因解析器为事实确定唯一 provider；通用 Planner 通过平台注册表生成 Browser Instruction 和 Server Outbox；三个物理 Queue 分别交给 Meta、TikTok、Google Adapter。D1 使用全新的 `attribution_*` 物理表，Expand 阶段不修改旧运行表、不桥接、不双写；新 Worker 只访问新表，完成回填和验证后由 Contract migration 删除旧技术表。

**Tech Stack:** Nuxt 4、Vue 3、Hono、TypeScript、Cloudflare Workers、D1、Queues、Workflows、Web Crypto、Vitest、Node Test Runner、Playwright、Wrangler。

## 全局约束

- 实施依据：`docs/superpowers/specs/2026-07-15-unified-ad-attribution-platform-design.md` 版本 2。
- 真实平台调用和人工证据只允许在 `production`；`dev/local` 只运行 Mock、契约、迁移和浏览器隔离测试。
- Meta、TikTok、Google Ads 本期一起迁移；不存在 Meta 兼容分支、旧表 fallback、双读、双写或 fan-out。
- `utm_source=google` 不等于 Google Ads；只有 `gclid`、`gbraid`、`wbraid`、签名投放链接或明确广告别名可以选择 Google。
- 同一事实只能有一个不可变 `attribution_provider`；无来源或来源冲突时创建内部事实但不创建广告 Delivery。
- 广告转化仅包含 `Contact` 和 `CompleteRegistration`。复制、二维码展开、面板展开只进入内部分析。
- 凭证明文、Click ID、邮箱、完整 Payload、IV 和完整指纹不得进入日志、响应或审计。
- Queue 正常消息最多重试 3 次；仅 `429`、网络错误和 `5xx` 可重试，参数或目标 `4xx` 直接拒绝。
- Workflows 只运行连接验证和异步诊断；每条实时转化禁止创建 Workflow。
- 当前按 Cloudflare Free 设计；三平台合计服务端转化安全线为 2,000 条/天。
- 每个任务先写失败测试，再写最小实现；每个任务独立提交，阶段性提交默认不推送。

## 最终物理表命名

为满足“Expand 不修改旧运行表”的硬约束，最终表使用新的、无版本后缀的物理名称。旧 `ad_platform_connections`、`analytics_conversion_deliveries` 和 Meta/TikTok 专属表只在 Contract 阶段删除。

| 职责 | 最终表 |
|---|---|
| 平台连接 | `attribution_platform_connections` |
| 事件绑定 | `attribution_event_bindings` |
| 加密凭证 | `attribution_credentials` |
| 标准转化事实 | `attribution_conversion_facts` |
| 投递状态 | `attribution_deliveries` |
| 加密 Outbox | `attribution_outbox` |
| 平台回执 | `attribution_provider_receipts` |
| 验证记录 | `attribution_verifications` |
| Incident | `attribution_incidents` |
| 质量快照 | `attribution_quality_snapshots` |
| Free 容量估算 | `attribution_usage_daily` |

---

## 阶段一：冻结最终共享契约

### Task 1：建立平台无关类型、事件描述和事件编号

**Files:**
- Create: `packages/shared/src/types/ad-attribution.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/constants/index.ts`
- Modify: `packages/shared/src/utils/conversion-events.ts`
- Create: `packages/shared/src/utils/ad-event-id.ts`
- Create: `packages/shared/src/utils/ad-event-id.test.ts`
- Modify: `packages/api/src/services/ad-platform/registry.test.ts`

**Interfaces:**

```ts
export type AdAttributionProvider = 'meta' | 'tiktok' | 'google'
export type CanonicalConversionEvent = 'Contact' | 'CompleteRegistration'
export type AdBrowserSignal = 'PageView' | 'ViewContent' | 'Search'

export type PlatformPublicConfig =
  | { provider: 'meta'; pixelId: string }
  | { provider: 'tiktok'; pixelCode: string }
  | {
      provider: 'google'
      tagId: string
      customerId: string
      loginCustomerId?: string
      cloudProjectId: string
    }

export interface PlatformEventDescriptor {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  browserEventName: string
  browserDestination: string
  serverDestination: string
}

export interface AdBrowserInstruction {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  descriptor: PlatformEventDescriptor
  payload: Record<string, string | number | boolean>
}
```

- [x] **Step 1：写事件编号失败测试**

覆盖同一 basis 结果稳定、不同事实不相同、只包含 URL-safe 字符、前缀为 `mg3_`、总长度不超过 64、空主密钥 fail closed。

```bash
corepack pnpm --filter @meigallery/shared exec vitest run src/utils/ad-event-id.test.ts
```

Expected: FAIL，提示 `buildAdExternalEventId` 不存在。

- [x] **Step 2：实现 HMAC 事件编号**

```ts
export async function buildAdExternalEventId(secret: string, factId: string, event: CanonicalConversionEvent) {
  if (!secret.trim() || !factId.trim()) throw new Error('AD_EVENT_ID_INPUT_INVALID')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v3:${event}:${factId}`))
  return `mg3_${base64Url(new Uint8Array(digest)).slice(0, 43)}`
}
```

- [x] **Step 3：将共享类型改为三平台统一类型**

删除 `Extract<AdPlatformProvider, 'meta' | 'tiktok'>`，删除只含 `eventName` / `destinationId` 的旧 Browser Instruction；`google` 必须进入所有 provider 类型守卫。

- [x] **Step 4：更新 registry 契约测试**

断言三个 provider 都有能力声明，事件映射返回 `PlatformEventDescriptor`，Google 两个事件的 `browserEventName` 都是 `conversion`，但 destination 不同。

- [x] **Step 5：运行测试并提交**

```bash
corepack pnpm --filter @meigallery/shared exec vitest run src/utils/ad-event-id.test.ts
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/registry.test.ts
git add packages/shared packages/api/src/services/ad-platform/registry.test.ts
git commit -m "refactor: 冻结三平台归因共享契约"
```

Expected: tests PASS，提交成功。

---

## 阶段二：建立最终 D1 Schema

### Task 2：创建 Expand migration 和数据库约束测试

**Files:**
- Create: `packages/api/migrations/0051_unified_attribution_expand.sql`
- Create: `packages/api/migrations/0051_unified_attribution_expand.test.mjs`
- Create: `packages/api/src/test-support/attribution-schema.ts`
- Modify: `scripts/verify-meta-migration.mjs`
- Modify: `scripts/verify-meta-migration.test.mjs`

- [x] **Step 1：写空库升级和 production 快照失败测试**

验证从 `0001` 到 `0051` 可完整应用；旧表和旧 trigger 在 Expand 后原样存在；11 张 `attribution_*` 表存在；provider 使用开放字符串；Fact provider 不可修改；Fact、Delivery、Outbox provider 不一致被拒绝。

```bash
node --test packages/api/migrations/0051_unified_attribution_expand.test.mjs
```

Expected: FAIL，迁移文件尚不存在。

- [x] **Step 2：创建最终表**

`0051` 只创建新表、索引和新表之间的 trigger，不得包含 `ALTER TABLE`、旧表 trigger、旧表回填或旧表删除。

```sql
CREATE TABLE attribution_platform_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'disabled',
  browser_enabled INTEGER NOT NULL DEFAULT 0,
  server_enabled INTEGER NOT NULL DEFAULT 0,
  public_config_json TEXT NOT NULL,
  attribution_window_days INTEGER NOT NULL DEFAULT 30,
  rollout_target_percentage INTEGER NOT NULL DEFAULT 0,
  rollout_effective_percentage INTEGER NOT NULL DEFAULT 0,
  connection_revision TEXT NOT NULL,
  credential_revision TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_conversion_facts (
  id TEXT PRIMARY KEY,
  canonical_event TEXT NOT NULL,
  fact_origin TEXT NOT NULL,
  external_event_id TEXT UNIQUE,
  attribution_provider TEXT,
  attribution_source TEXT NOT NULL,
  attribution_context_id TEXT,
  occurred_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  consent_snapshot_json TEXT NOT NULL,
  analytics_dimensions_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (fact_origin IN ('live', 'historical_backfill')),
  CHECK (
    (fact_origin = 'live' AND external_event_id IS NOT NULL)
    OR (fact_origin = 'historical_backfill' AND external_event_id IS NULL)
  )
);
```

`attribution_deliveries.status` 只允许 `planned`、`queued`、`accepted`、`processed`、`retrying`、`rejected`、`dead_letter`、`cancelled`。

- [x] **Step 3：加入 provider 一致性 trigger**

```sql
CREATE TRIGGER attribution_delivery_provider_guard
BEFORE INSERT ON attribution_deliveries
WHEN NOT EXISTS (
  SELECT 1
  FROM attribution_conversion_facts f
  JOIN attribution_platform_connections c ON c.id = NEW.connection_id
  WHERE f.id = NEW.fact_id
    AND f.attribution_provider = NEW.provider
    AND c.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH');
END;
```

远端 D1 的 migration query 路径会将 trigger 内嵌 `CASE ... END` 与 trigger 自身的 `END` 误判为不完整输入；provider guard 统一使用 `WHEN NOT EXISTS (...)`，保持约束语义且与远端迁移解析器兼容。

- [x] **Step 4：运行迁移测试并提交**

```bash
node --test packages/api/migrations/0051_unified_attribution_expand.test.mjs scripts/verify-meta-migration.test.mjs
git add packages/api/migrations/0051_unified_attribution_expand.sql packages/api/migrations/0051_unified_attribution_expand.test.mjs packages/api/src/test-support/attribution-schema.ts scripts/verify-meta-migration.mjs scripts/verify-meta-migration.test.mjs
git commit -m "feat: 创建通用归因最终数据结构"
```

Expected: PASS，提交成功。

---

## 阶段三：统一加密、凭证和归因上下文

### Task 3：实现通用加密域和 D1 凭证库

**Files:**
- Create: `packages/api/src/utils/attribution-crypto.ts`
- Create: `packages/api/src/utils/attribution-crypto.test.ts`
- Create: `packages/api/src/services/ad-platform/credential-vault.ts`
- Create: `packages/api/src/services/ad-platform/credential-vault.d1.test.ts`
- Modify: `packages/api/src/index.ts`

**Binding:**

```ts
AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: string
AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
```

- [x] **Step 1：写加密域失败测试**

覆盖 AES-256-GCM 往返、HKDF purpose 隔离、错误 AAD、篡改、未知 key ID、previous key 读取、跨 provider 解密拒绝和日志安全错误码。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/utils/attribution-crypto.test.ts src/services/ad-platform/credential-vault.d1.test.ts
```

Expected: FAIL。

- [x] **Step 2：实现 HKDF purpose key 和凭证原子替换**

```ts
export type AttributionCryptoPurpose = 'credential' | 'outbox' | 'context' | 'verification_input' | 'event_id'

export interface AttributionAad {
  purpose: AttributionCryptoPurpose
  provider: string
  subjectId: string
  revision: string
}

export interface SaveCredentialInput {
  connectionId: string
  provider: AdAttributionProvider
  credentialType: 'access_token' | 'service_account_json'
  plaintext: string
  credentialRevision: string
  createdBy: number
}
```

Service Account JSON 必须解析 `type`、`client_email`、`private_key`、`token_uri`，数据库只保存密文和截断指纹。Planner 生成事件编号时使用 `event_id` purpose 派生出的 HMAC key，不直接复用主密钥或 credential key。

- [x] **Step 3：运行测试并提交**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/utils/attribution-crypto.test.ts src/services/ad-platform/credential-vault.d1.test.ts
git add packages/api/src/utils/attribution-crypto.ts packages/api/src/utils/attribution-crypto.test.ts packages/api/src/services/ad-platform/credential-vault.ts packages/api/src/services/ad-platform/credential-vault.d1.test.ts packages/api/src/index.ts
git commit -m "feat: 统一广告平台凭证加密"
```

Expected: PASS，提交成功。

### Task 4：替换短期 receipt 为加密 30 天归因上下文

**Files:**
- Modify: `packages/api/src/services/ad-attribution-routing.ts`
- Modify: `packages/api/src/services/ad-attribution-routing.test.ts`
- Create: `packages/api/src/utils/ad-attribution-context.ts`
- Create: `packages/api/src/utils/ad-attribution-context.test.ts`
- Create: `packages/api/src/services/ad-attribution-consent.ts`
- Create: `packages/api/src/services/ad-attribution-consent.d1.test.ts`
- Modify: `packages/api/src/routes/ad-attribution.ts`
- Modify: `packages/api/src/routes/ad-attribution.test.ts`
- Modify: `packages/api/src/utils/marketing-consent-receipt.ts`
- Modify: `packages/api/src/routes/marketing-consent.ts`
- Modify: `packages/web/app/composables/useAdAttribution.ts`
- Modify: `packages/web/app/composables/useAdAttribution.test.ts`

- [x] **Step 1：写三平台来源和同意失败测试**

覆盖 `fbclid`、`ttclid`、`gclid`、`gbraid`、`wbraid`，签名链接，明确广告别名，普通 `google` 不归因，多平台强信号冲突，新点击替换旧来源，30 天过期，拒绝/撤回同意删除 Cookie。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-attribution-routing.test.ts src/utils/ad-attribution-context.test.ts src/services/ad-attribution-consent.d1.test.ts src/routes/ad-attribution.test.ts
```

Expected: FAIL。

- [x] **Step 2：实现标准同意快照和上下文**

```ts
export interface AdConsentSnapshot {
  consentVersion: number
  marketingAllowed: boolean
  adUserDataAllowed: boolean
  adPersonalizationAllowed: boolean
  decidedAt: string
}

export interface AdAttributionContext {
  version: 1
  contextId: string
  provider: AdAttributionProvider
  source: 'click_id' | 'managed_link' | 'utm_alias'
  identifiers: Record<string, string>
  issuedAt: number
  expiresAt: number
}
```

Cookie 名为 `mei_ad_attribution`，属性为 `Secure + HttpOnly + SameSite=Lax`，加密 purpose 为 `context`。`contextId` 是随机、非 PII 标识，写入事实后用于同意撤回时取消尚未完成的投递。

- [x] **Step 3：更新公开路由和 Web 查询收集**

```ts
type AttributionSignals = {
  fbclid?: string
  ttclid?: string
  gclid?: string
  gbraid?: string
  wbraid?: string
  utmSource?: string
  trackingSourceSlug?: string
  managedLinkToken?: string
}
```

未同意时清理 Cookie；冲突返回 `resolution: 'conflict'`。撤回同意时，服务端先把同一 `contextId` 下仍为 `planned`、`queued`、`retrying` 的 Delivery 改为 `cancelled` 并删除对应 Outbox，再删除 Cookie；已进入 `accepted` 或 `processed` 的历史不可篡改。Queue consumer 后续收到已取消消息只 ack，不调用平台。客户端只保存 provider / resolution，不保存 Click ID。

- [x] **Step 4：运行测试并提交**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-attribution-routing.test.ts src/utils/ad-attribution-context.test.ts src/services/ad-attribution-consent.d1.test.ts src/routes/ad-attribution.test.ts
corepack pnpm --filter @meigallery/web exec vitest run app/composables/useAdAttribution.test.ts
git add packages/api/src/services/ad-attribution-routing.ts packages/api/src/services/ad-attribution-routing.test.ts packages/api/src/services/ad-attribution-consent.ts packages/api/src/services/ad-attribution-consent.d1.test.ts packages/api/src/utils/ad-attribution-context.ts packages/api/src/utils/ad-attribution-context.test.ts packages/api/src/routes/ad-attribution.ts packages/api/src/routes/ad-attribution.test.ts packages/api/src/utils/marketing-consent-receipt.ts packages/api/src/routes/marketing-consent.ts packages/web/app/composables/useAdAttribution.ts packages/web/app/composables/useAdAttribution.test.ts
git commit -m "refactor: 统一三平台广告来源上下文"
```

Expected: PASS，提交成功。

---

## 阶段四：通用 Planner 与服务端 Adapter

### Task 5：实现注册表、连接快照和无平台分支 Planner

**Files:**
- Modify: `packages/api/src/services/ad-platform/registry.ts`
- Modify: `packages/api/src/services/ad-platform/registry.test.ts`
- Rewrite: `packages/api/src/services/ad-platform/connections.ts`
- Create: `packages/api/src/services/ad-platform/connections.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/planner.ts`
- Create: `packages/api/src/services/ad-platform/planner.test.ts`
- Rewrite: `packages/api/src/services/conversions.ts`
- Rewrite: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/services/conversions.d1.test.ts`
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/api/src/routes/conversions.test.ts`

- [x] **Step 1：写 Planner 失败测试**

覆盖三平台唯一选择、无来源零 Delivery、冲突零 Delivery、同意拒绝零 Delivery、Browser/Server 共用 event ID、Google 两个 destination 分离、rollout 确定性、未知 provider fail closed。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/planner.test.ts src/services/conversions.test.ts
```

Expected: FAIL。

- [x] **Step 2：将事件映射改为 Adapter 描述器**

```ts
export interface AdPlatformDefinition {
  provider: AdAttributionProvider
  capabilities: AdPlatformCapabilities
  publicConfigSchema: PlatformConfigSchema
  credentialSchema: PlatformCredentialSchema
  describeEvent(input: CanonicalEventInput): PlatformEventDescriptor | null
}
```

核心 registry 只查表和调用接口；禁止在 `conversions.ts`、`planner.ts`、`connections.ts` 出现 provider 比较分支。

- [x] **Step 3：实现一次连接快照读取**

单次查询读取 connection、event bindings 和 credential metadata，返回经过 Schema 验证的 discriminated union；任何 revision 不一致都返回 `connection_invalid`。

- [x] **Step 4：重写事实和投递原子写入**

```ts
const statements = [
  insertFactStatement(input),
  ...plan.deliveries.map(insertDeliveryStatement),
  ...plan.serverDeliveries.map(insertEncryptedOutboxStatement),
  insertAuditStatement(input),
]
await env.DB.batch(statements)
```

`analytics_conversion_actions` 不再由运行时代码读写；内部数据分析需要的标准事实直接从 `attribution_conversion_facts` 聚合。

- [x] **Step 5：只允许有效 Contact**

公开请求增加 `contactMethodId` 和 `actionType: 'open_link'`。服务端读取启用的联系方式，确认 ID、平台和安全 URL 均有效后才创建 Contact；`copy` 返回 `PUBLIC_CONVERSION_ACTION_INVALID`。

- [x] **Step 6：运行测试和分支静态检查**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/registry.test.ts src/services/ad-platform/connections.d1.test.ts src/services/ad-platform/planner.test.ts src/services/conversions.test.ts src/services/conversions.d1.test.ts src/routes/conversions.test.ts
rg -n "provider\s*===|provider\s*!==" packages/api/src/services/conversions.ts packages/api/src/services/ad-platform/planner.ts packages/api/src/services/ad-platform/connections.ts
```

Expected: tests PASS；`rg` 无输出。

- [x] **Step 7：提交**

```bash
git add packages/api/src/services/ad-platform packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/services/conversions.d1.test.ts packages/api/src/routes/conversions.ts packages/api/src/routes/conversions.test.ts
git commit -m "refactor: 统一转化事实与投递规划"
```

### Task 6：实现 Meta、TikTok、Google 服务端 Adapter

**Files:**
- Create: `packages/api/src/services/ad-platform/adapters/meta-server.ts`
- Create: `packages/api/src/services/ad-platform/adapters/meta-server.test.ts`
- Create: `packages/api/src/services/ad-platform/adapters/tiktok-server.ts`
- Create: `packages/api/src/services/ad-platform/adapters/tiktok-server.test.ts`
- Create: `packages/api/src/services/ad-platform/adapters/google-auth.ts`
- Create: `packages/api/src/services/ad-platform/adapters/google-auth.test.ts`
- Create: `packages/api/src/services/ad-platform/adapters/google-server.ts`
- Create: `packages/api/src/services/ad-platform/adapters/google-server.test.ts`
- Create: `packages/api/src/services/ad-platform/server-adapter.ts`
- Create: `packages/api/src/services/ad-platform/server-adapter.test.ts`

- [x] **Step 1：写三平台契约失败测试**

使用固定 Mock 覆盖 Payload、Header、事件编号、匹配数据、错误分类和敏感字段清洗。Google 额外覆盖 JWT claim、RSA 签名、OAuth token 缓存、Data Manager `validateOnly`、Destination 和 `transactionId`。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/adapters/meta-server.test.ts src/services/ad-platform/adapters/tiktok-server.test.ts src/services/ad-platform/adapters/google-auth.test.ts src/services/ad-platform/adapters/google-server.test.ts src/services/ad-platform/server-adapter.test.ts
```

Expected: FAIL。

- [x] **Step 2：迁移 Meta/TikTok Payload 构造**

```ts
export interface ServerDeliveryInput {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  eventTime: number
  pageUrl: string
  destination: string
  matchSignals: Record<string, string>
  hashedEmail?: string
}
```

Meta 只读取 `fbc/fbp`，TikTok 只读取 `ttclid/ttp`；输入出现其他平台 Click ID 时返回 `destination_invalid` 并记录 critical incident。

- [x] **Step 3：实现 Google OAuth 和 Data Manager Adapter**

JWT `aud` 使用 Service Account `token_uri`，scope 固定为 `https://www.googleapis.com/auth/datamanager`，access token 只缓存在模块内存且在过期前 60 秒刷新。

```ts
const request = {
  validateOnly: input.validateOnly,
  encoding: 'HEX',
  destinations: [{
    operatingAccount: {
      accountType: 'GOOGLE_ADS',
      accountId: customerId,
    },
    ...(loginCustomerId ? {
      loginAccount: {
        accountType: 'GOOGLE_ADS',
        accountId: loginCustomerId,
      },
    } : {}),
    productDestinationId: input.destination,
  }],
  events: [{
    eventTimestamp: toRfc3339(input.eventTime),
    transactionId: input.externalEventId,
    eventSource: 'WEB',
    adIdentifiers: googleAdIdentifiers(input.matchSignals),
    userData: input.hashedEmail ? { userIdentifiers: [{ emailAddress: input.hashedEmail }] } : undefined,
  }],
}
```

`POST https://datamanager.googleapis.com/v1/events:ingest` 成功响应中的 `requestId` 是 Google 生成的异步请求编号，不得把本项目 `externalEventId` 错放到请求顶层；去重编号只写 `events[].transactionId`。若配置 `loginCustomerId`，按上述官方 `ProductAccount` 结构加入 `loginAccount`；不得添加 Developer Token。Service Account 请求同时发送 `x-goog-user-project: cloudProjectId`。

- [x] **Step 4：统一错误分类**

```ts
export type DeliveryClassification =
  | 'accepted'
  | 'processed'
  | 'retryable'
  | 'rejected'
  | 'credential_invalid'
  | 'destination_invalid'
```

- [x] **Step 5：运行测试并提交**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/adapters/meta-server.test.ts src/services/ad-platform/adapters/tiktok-server.test.ts src/services/ad-platform/adapters/google-auth.test.ts src/services/ad-platform/adapters/google-server.test.ts src/services/ad-platform/server-adapter.test.ts
git add packages/api/src/services/ad-platform/adapters packages/api/src/services/ad-platform/server-adapter.ts packages/api/src/services/ad-platform/server-adapter.test.ts
git commit -m "feat: 接入三平台服务端适配器"
```

Expected: PASS，提交成功。

### Task 7：统一 Queue、Outbox、重试、DLQ 和恢复 Cron

**Files:**
- Rewrite: `packages/api/src/services/ad-platform/secure-outbox.ts`
- Rewrite: `packages/api/src/services/ad-platform/secure-outbox.test.ts`
- Create: `packages/api/src/services/ad-platform/queue-runtime.ts`
- Create: `packages/api/src/services/ad-platform/queue-runtime.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/recovery.ts`
- Create: `packages/api/src/services/ad-platform/recovery.test.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/wrangler.toml`
- Rewrite: `scripts/verify-ad-platform-queues.mjs`
- Rewrite: `scripts/verify-ad-platform-queues.test.mjs`

**第二轮审查收口：** Queue consumer 按 expected Queue、严格 body、Delivery/Fact/Connection provider、终态/Outbox 的顺序校验；正常终态重复消息才允许幂等清理同 provider Outbox。finalize、DLQ 与 expiry 都用 D1 batch 内唯一 fence 限定 winner 副作用，任何 batch 语句失败整体回滚。`accepted` 仅表示平台接收且服务端发送不可重试，不表示归因成功；五种投递终态立即删除敏感 Outbox，后续只保留外部事件编号和脱敏 Provider Receipt。

- [x] **Step 1：写 Queue 状态机失败测试**

覆盖重复消费幂等、provider/queue/fact/connection/outbox 不一致、unknown/cross/malformed 终态消息、3 次重试、`4xx` 直接拒绝、`429/5xx` retry、并发 DLQ 单 incident、lease 超时、expiry/finalize 同终态竞态、batch 回滚、Outbox 恢复、ack/retry 异常隔离和最终清理。Queue/Outbox/Registration D1 测试加载正式 `0051_unified_attribution_expand.sql`。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/queue-runtime.d1.test.ts src/services/ad-platform/recovery.test.ts
```

Expected: FAIL。

- [x] **Step 2：注册三个物理 Queue**

```toml
[[queues.producers]]
binding = "AD_META_QUEUE"
queue = "meigallery-ad-meta"

[[queues.producers]]
binding = "AD_TIKTOK_QUEUE"
queue = "meigallery-ad-tiktok"

[[queues.producers]]
binding = "AD_GOOGLE_QUEUE"
queue = "meigallery-ad-google"
```

每个 consumer 设置 `max_retries = 3` 并绑定对应 `meigallery-ad-*-dlq`；dev 的 producers/consumers 继续为空。

- [x] **Step 3：按 Queue 名绑定 Adapter**

```ts
const QUEUE_PROVIDERS: ReadonlyMap<string, AdAttributionProvider> = new Map([
  ['meigallery-ad-meta', 'meta'],
  ['meigallery-ad-meta-dlq', 'meta'],
  ['meigallery-ad-tiktok', 'tiktok'],
  ['meigallery-ad-tiktok-dlq', 'tiktok'],
  ['meigallery-ad-google', 'google'],
  ['meigallery-ad-google-dlq', 'google'],
])
```

未注册 Queue、畸形消息或 provider 不一致必须 ack 并写 critical incident，禁止投递到其他 Adapter，也禁止借终态分支清理 Outbox。Queue 注册表使用 `ReadonlyMap`，避免 `constructor`、`toString` 等对象原型属性被误识别为合法 Queue。finalize、DLQ、expiry 的 delete/receipt/incident 只认当次唯一 fence，batch 结束前清为最终 `last_error_code`。

- [x] **Step 4：Cron 改为每 15 分钟恢复**

删除每分钟 Meta circuit、Meta Queue 和 TikTok Queue 专属任务；统一 `recoverAttributionOutbox(env, 100)`，仅在 UTC 分钟为 `0/15/30/45` 时执行。

- [x] **Step 5：运行测试和 dry-run**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/secure-outbox.test.ts src/services/ad-platform/queue-runtime.d1.test.ts src/services/ad-platform/recovery.test.ts
node --test scripts/verify-ad-platform-queues.test.mjs
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
git add packages/api/src/services/ad-platform packages/api/src/index.ts packages/api/wrangler.toml scripts/verify-ad-platform-queues.mjs scripts/verify-ad-platform-queues.test.mjs
git commit -m "refactor: 统一广告平台异步投递"
```

Expected: PASS；production setup 与 preflight 共用六条新 Queue 清单，dry-run 包含三个 producer 和六个 consumer；dev 保持 Queue/Cron 为空；提交成功。

---

## 阶段五：统一 Browser Adapter 与真实业务入口

### Task 8：接入 Google Tag 并完成浏览器严格隔离

**独立审查收口：** Browser lifecycle 全部串行化，并发切换、撤销同意与初始化失败均 fail closed；三平台检测到非本模块持有的全局 SDK 时拒绝接管。Google 使用 Basic Consent Mode `default denied -> update current consent -> load tag`，撤销时先写入 denied update，`send_to` 必须与当前 Tag ID 一致。`/bootstrap` 仅返回浏览器必需字段，Contact 对瞬时错误使用同一请求体有界幂等重试，公开归因路由纳入统一限流。最终独立复审结论：`Approved`。

**Files:**
- Rewrite: `packages/web/app/adapters/adPlatformBrowser.client.ts`
- Rewrite: `packages/web/app/adapters/adPlatformBrowser.client.test.ts`
- Modify: `packages/web/app/adapters/metaPixel.client.ts`
- Modify: `packages/web/app/adapters/metaPixel.client.test.ts`
- Modify: `packages/web/app/adapters/tiktokPixel.client.ts`
- Modify: `packages/web/app/adapters/tiktokPixel.client.test.ts`
- Create: `packages/web/app/adapters/googleAds.client.ts`
- Create: `packages/web/app/adapters/googleAds.client.test.ts`
- Rewrite: `packages/web/app/utils/adPlatformBrowserIdentifiers.ts`
- Rewrite: `packages/web/app/utils/adPlatformBrowserIdentifiers.test.ts`
- Modify: `packages/web/app/plugins/ad-platform.client.ts`
- Modify: `packages/web/app/plugins/ad-platform.client.test.ts`
- Modify: `packages/web/app/composables/useTracking.ts`
- Modify: `packages/web/app/composables/useTracking.test.ts`
- Modify: `packages/web/app/components/ContactMethodItem.vue`
- Modify: `packages/web/app/components/ContactMethodItem.test.ts`
- Modify: `packages/web/app/components/ContactPanel.vue`
- Modify: `packages/web/app/components/ContactPanel.test.ts`

- [x] **Step 1：写 Browser Adapter 和 Contact 失败测试**

覆盖未同意零脚本、只初始化当前 provider、来源替换时 teardown、Google Basic Consent Mode、Google `send_to` / `transaction_id`、复制不创建广告转化、合法链接才创建 Contact。

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/adapters/*.test.ts app/composables/useTracking.test.ts app/components/ContactMethodItem.test.ts app/components/ContactPanel.test.ts
```

Expected: FAIL。

- [x] **Step 2：实现统一 Browser 接口**

```ts
export interface BrowserTrackingAdapter {
  initialize(config: BrowserPublicConfig, consent: AdConsentSnapshot): Promise<boolean>
  track(instruction: AdBrowserInstruction): Promise<boolean>
  trackSignal(signal: AdBrowserSignal, payload: Record<string, string | number | boolean>): Promise<boolean>
  teardown(): Promise<void>
}
```

adapter map 允许平台注册，但插件一次只持有一个 active provider。`PageView`、`ViewContent`、`Search` 只作为 Browser Signal 发送，不创建标准事实、Server Delivery 或事件编号。

- [x] **Step 3：实现 Google Tag**

初始化顺序固定为设置 Consent 默认值、加载 `gtag.js?id=AW-*`、执行 `js`、执行 `config`。转化调用：

```ts
gtag('event', 'conversion', {
  send_to: instruction.descriptor.browserDestination,
  transaction_id: instruction.externalEventId,
})
```

- [x] **Step 4：收口 Contact 行为和公开配置**

`ContactMethodItem` 的 `activate` 携带 `contactMethodId`、`methodType`、`actionType`。只有安全外链的 `open_link` 调用 `trackContact`；copy 只调用 `trackAnalytics('contact_value_copy')`。

Web 不再从 `/api/settings/public` 读取全平台目标，改为 `/api/ad-attribution/bootstrap`，响应只包含当前 provider 的公开配置和 Browser Instruction。

- [x] **Step 5：运行测试并提交**

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/adapters/*.test.ts app/plugins/ad-platform.client.test.ts app/composables/useTracking.test.ts app/components/ContactMethodItem.test.ts app/components/ContactPanel.test.ts
git add packages/web/app packages/api/src/index.ts packages/api/src/routes/ad-attribution.ts packages/api/src/routes/ad-attribution.test.ts
git commit -m "feat: 完成三平台浏览器隔离与转化上报"
```

Expected: PASS，提交成功。

---

## 阶段六：通用连接管理、验证 Workflow 与后台 UI

### Task 9：实现原子连接 API 和通用验证 Workflow

**Files:**
- Rewrite: `packages/api/src/routes/admin/ad-platforms.ts`
- Create: `packages/api/src/routes/admin/ad-platforms.test.ts`
- Create: `packages/api/src/services/ad-platform/connection-service.ts`
- Create: `packages/api/src/services/ad-platform/connection-service.d1.test.ts`
- Create: `packages/api/src/workflows/ad-platform-verification.ts`
- Create: `packages/api/src/workflows/ad-platform-verification.test.ts`
- Create: `packages/api/src/services/ad-platform/adapters/meta-verification.ts`
- Create: `packages/api/src/services/ad-platform/adapters/tiktok-verification.ts`
- Create: `packages/api/src/services/ad-platform/adapters/google-verification.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/wrangler.toml`

- [ ] **Step 1：写连接原子性和验证幂等失败测试**

覆盖公开配置、事件绑定、凭证同批提交；凭证失败全回滚；revision 变化使验证失效；重复“验证连接”返回同一 Workflow；“重新验证”原子增加 attempt；Test Event Code 完成/超时后无法读取。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/connection-service.d1.test.ts src/workflows/ad-platform-verification.test.ts src/routes/admin/ad-platforms.test.ts
```

Expected: FAIL。

- [ ] **Step 2：实现统一连接写入命令**

```ts
export interface SavePlatformConnectionCommand {
  provider: AdAttributionProvider
  enabled: boolean
  mode: AdPlatformTrackingMode
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: PlatformPublicConfig
  eventBindings: PlatformEventBindingInput[]
  credential?: { type: 'access_token' | 'service_account_json'; plaintext: string }
  rolloutTargetPercentage: 0 | 10 | 50 | 100
  actorId: number
}
```

Adapter Schema 负责字段校验；路由只解析通用 command，不包含平台分支。

- [ ] **Step 3：实现 Workflow ID、attempt 和 binding**

```ts
const workflowId = [
  'verify', input.provider, input.connectionId,
  input.connectionRevision, input.credentialRevision,
  String(input.attempt),
].join(':')
```

```toml
[[workflows]]
binding = "AD_PLATFORM_VERIFICATION_WORKFLOW"
name = "meigallery-ad-platform-verification"
class_name = "AdPlatformVerificationWorkflow"
```

- [ ] **Step 4：实现三平台验证计划**

Meta/TikTok：目标、凭证、事件绑定、Test Event、人工 Evidence。Google：Service Account、OAuth、Data Manager `validateOnly`、转化绑定、Tag Assistant / production Evidence。Commit SHA 只写审计，不参与状态判断。

- [ ] **Step 5：运行测试和 dry-run 并提交**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/ad-platform/connection-service.d1.test.ts src/workflows/ad-platform-verification.test.ts src/routes/admin/ad-platforms.test.ts
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
git add packages/api/src/routes/admin/ad-platforms.ts packages/api/src/routes/admin/ad-platforms.test.ts packages/api/src/services/ad-platform packages/api/src/workflows packages/api/src/index.ts packages/api/wrangler.toml
git commit -m "feat: 统一三平台连接与验证工作流"
```

Expected: PASS；dry-run 包含 Workflow binding；提交成功。

---

### Task 10：重构后台“广告归因”信息架构

**Files:**
- Rewrite: `packages/web/app/composables/useAdminAttribution.ts`
- Rewrite: `packages/web/app/utils/attributionPlatforms.ts`
- Rewrite: `packages/web/app/components/admin/attribution/AttributionPlatformConnectionEditor.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionEventBindingEditor.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionCredentialEditor.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionVerificationPanel.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionRolloutControl.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionIncidentList.vue`
- Delete: `packages/web/app/components/admin/attribution/MetaConnectionStatus.vue`
- Delete: `packages/web/app/components/admin/attribution/MetaConnectionStatus.test.ts`
- Delete: `packages/web/app/components/admin/attribution/MetaRolloutControl.vue`
- Delete: `packages/web/app/components/admin/attribution/MetaRolloutControl.test.ts`
- Delete: `packages/web/app/components/admin/attribution/MetaIncidentList.vue`
- Rewrite: `packages/web/app/pages/admin/attribution/platforms.vue`
- Create: `packages/web/app/pages/admin/attribution/bindings.vue`
- Create: `packages/web/app/pages/admin/attribution/deliveries.vue`
- Create: `packages/web/app/pages/admin/attribution/verifications.vue`
- Create: `packages/web/app/pages/admin/attribution/audit.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionPageShell.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionPageShell.test.ts`
- Rewrite: `packages/web/tests/e2e/admin-attribution.spec.ts`

- [x] **Step 1：写 Schema 驱动 UI 失败测试**

测试平台注册表渲染三平台字段；Google 显示 Tag ID、Customer ID、可选 Manager ID、Cloud Project、两个 Label、两个 conversion action ID 和 Service Account 文件输入；任何平台页面都不出现凭证明文。

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution/platforms.test.ts app/components/admin/attribution/AttributionPageShell.test.ts
```

Expected: FAIL。

- [x] **Step 2：统一后台导航**

```text
广告归因
  总览
  平台连接
  事件绑定
  投递质量
  验证记录
  审计日志
```

Provider 切换只出现在需要平台上下文的页面；日期范围只在总览、投递质量、验证和审计出现。

- [x] **Step 3：从 API Schema 渲染字段**

平台定义只负责 label、input type、校验提示和能力，不在页面写 provider 分支。文件凭证只在请求内存中提交，成功或失败后立即清空。

- [x] **Step 4：实现通用验证与 rollout**

“验证连接”轮询当前 Workflow 状态；重复点击不新建；“重新验证”有独立确认。Server rollout 只允许 0/10/50/100，Browser 只允许 0/100。

- [x] **Step 5：运行 UI、E2E 和静态检查**

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution app/components/admin/attribution
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/admin-attribution.spec.ts
rg -n "selectedProvider\s*===|provider\s*===|MetaConnectionStatus|MetaRolloutControl|MetaIncidentList" packages/web/app/pages/admin/attribution packages/web/app/components/admin/attribution
```

Expected: tests PASS；`rg` 无输出。

- [x] **Step 6：提交**

```bash
git add packages/web/app/composables/useAdminAttribution.ts packages/web/app/utils/attributionPlatforms.ts packages/web/app/components/admin/attribution packages/web/app/pages/admin/attribution packages/web/tests/e2e/admin-attribution.spec.ts
git commit -m "refactor: 重构三平台广告归因后台"
```

---

## 阶段七：投递质量、Free 容量与隔离验收

### Task 11：统一后台数据口径和容量预警

**Files:**
- Modify: `packages/shared/src/types/ad-attribution.ts`
- Create: `packages/api/src/services/ad-platform/browser-attempt-receipt.ts`
- Create: `packages/api/src/services/ad-platform/browser-attempt-receipt.test.ts`
- Modify: `packages/api/src/services/ad-platform/planner.ts`
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/web/app/composables/useTracking.ts`
- Rewrite: `packages/api/src/services/attribution-dashboard.ts`
- Rewrite: `packages/api/src/services/attribution-dashboard.d1.test.ts`
- Rewrite: `packages/api/src/routes/admin/attribution.ts`
- Rewrite: `packages/api/src/routes/admin/attribution.test.ts`
- Create: `packages/api/src/services/ad-platform/usage-estimator.ts`
- Create: `packages/api/src/services/ad-platform/usage-estimator.test.ts`
- Rewrite: `packages/web/app/pages/admin/attribution/index.vue`
- Rewrite: `packages/web/app/pages/admin/attribution/conversions.vue`
- Rewrite: `packages/web/app/components/admin/attribution/AttributionHealthStrip.vue`
- Rewrite: `packages/web/app/components/admin/attribution/AttributionTrendPanel.vue`

- [x] **Step 1：写数据口径失败测试**

覆盖标准事实数、唯一来源平台、未归因、冲突、Browser attempted、Server planned/queued/accepted/processed/rejected、配对覆盖、匹配信号、retry/DLQ；Google 两个外部 `conversion` 必须按 canonical event 分开。Browser attempted 必须来自客户端执行后的签名幂等 Receipt，不得把已下发的 `planned` 伪装成 attempted。

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-dashboard.d1.test.ts src/services/ad-platform/usage-estimator.test.ts src/routes/admin/attribution.test.ts
```

Expected: FAIL。

- [x] **Step 2：从最终事实表聚合**

所有活动统计只读取 `attribution_conversion_facts`、`attribution_deliveries`、`attribution_provider_receipts`；旧 `analytics_conversion_delivery_daily` 和平台专属质量表不得进入运行查询。

- [x] **Step 3：实现 Free 容量估算**

```ts
export const FREE_SAFETY_LIMITS = {
  workerRequests: 70_000,
  queueOperations: 7_000,
  d1RowsRead: 3_500_000,
  d1RowsWritten: 70_000,
  workflowSteps: 2_100,
  serverConversions: 2_000,
} as const
```

估算值写明“项目内部估算”，按事实、Delivery、Queue attempt、Workflow step 和已知查询成本计算，不冒充 Cloudflare 官方账单。额度计费日按 Cloudflare UTC 重置边界展示，不使用上海业务日替代。

- [x] **Step 4：运行测试并提交**

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-dashboard.d1.test.ts src/services/ad-platform/usage-estimator.test.ts src/routes/admin/attribution.test.ts
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution app/components/admin/attribution
git add packages/api/src/services/attribution-dashboard.ts packages/api/src/services/attribution-dashboard.d1.test.ts packages/api/src/services/ad-platform/usage-estimator.ts packages/api/src/services/ad-platform/usage-estimator.test.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts packages/web/app/pages/admin/attribution packages/web/app/components/admin/attribution
git commit -m "feat: 统一归因质量与容量看板"
```

Expected: PASS，提交成功。

验收记录：Task 11 重点 API 32/32、Web 46/46、Web 全量 281/281、API typecheck 与 Nuxt production build 通过；Browser attempted 已改为客户端实际执行后写入的 10 分钟有效签名幂等 Receipt，容量按 UTC 计费日显示项目内部 70% 安全线。全量 API 测试仍有旧 Meta/TikTok 服务测试、未加载 `0051` 的旧 D1 fixture 和 migration 数量断言失败，因此当前只完成本任务，不构成生产发布放行结论。

### Task 12：建立三平台网络隔离和完整本地放行门禁

**前置条件：** 先处理全量 API 中遗留的旧平台测试与 `0051` fixture；不得通过跳过、静默排除或降低阈值伪造全绿。若旧服务按 Contract 计划删除，则同步删除其测试；仍保留的运行代码必须迁移到最终表并通过测试。

**Files:**
- Create: `packages/web/tests/e2e/ad-attribution-isolation.spec.ts`
- Create: `packages/api/src/architecture-attribution-v3.test.ts`
- Modify: `packages/web/app/architecture-boundaries.test.ts`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/fixtures/release-smoke/seed-local.sql`
- Modify: `scripts/fixtures/release-smoke/seed-dev.sql`

- [x] **Step 1：写架构边界失败测试**

禁止业务核心和后台页面包含平台分支；禁止读取旧表、旧 secret 和旧 Queue binding；禁止 tracked 文件出现真实 Test Event Code、Token 或 Service Account private key。

- [x] **Step 2：写桌面/移动网络隔离 E2E**

矩阵：Meta、TikTok、Google、无来源、冲突来源 × 未同意/同意 × Contact/Registration。每个场景拦截全部 request，命中非当前平台域名立即失败。

```ts
const PLATFORM_HOSTS = {
  meta: ['connect.facebook.net', 'www.facebook.com'],
  tiktok: ['analytics.tiktok.com', 'business-api.tiktok.com'],
  google: ['www.googletagmanager.com', 'www.googleadservices.com', 'googleads.g.doubleclick.net'],
} as const
```

- [x] **Step 3：接入 release 验证**

`verify:local-runtime` 加入 D1 final schema、Queue mock、Workflow mock 和隔离 E2E；`verify:dev-rehearsal` 明确禁止三家真实 API 请求。

- [x] **Step 4：运行完整本地验证并提交**

```bash
corepack pnpm test:scripts
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/ad-attribution-isolation.spec.ts tests/e2e/admin-attribution.spec.ts
corepack pnpm verify:local-runtime
corepack pnpm build
git add packages/api/src/architecture-attribution-v3.test.ts packages/web/app/architecture-boundaries.test.ts packages/web/tests/e2e/ad-attribution-isolation.spec.ts scripts/verify-release.mjs scripts/verify-release.test.mjs scripts/fixtures/release-smoke
git commit -m "test: 建立三平台归因发布门禁"
```

Expected: 全部 PASS，提交成功。

验收记录：Task 12 已恢复旧平台测试与 `0051` fixture 的全量基线，并将最终 11 张 attribution 表、Queue/Workflow mock、dev 禁止真实平台网络和桌面/移动三平台隔离 E2E 接入 `verify:local-runtime`。Shared 5/5、API 1119/1119、Web 282/282、scripts/migration 298/298、Playwright 35 项通过且 30 项按非目标视口规则跳过；Lint、全仓 TypeScript、API TypeScript、Nuxt production build 和本地发布门禁均通过。本阶段没有访问真实 Meta、TikTok 或 Google API，没有修改 production 配置、数据或放量；生产回填与切换仍由 Task 13 单独执行。

---

## 阶段八：一次性回填、发布和旧系统 Contract

### Task 13：实现可审计的生产切换脚本

**Files:**
- Create: `scripts/attribution-v3-backfill.sql`
- Create: `scripts/verify-attribution-v3-migration.mjs`
- Create: `scripts/verify-attribution-v3-migration.test.mjs`
- Create: `scripts/export-attribution-production-backup.mjs`
- Create: `docs/releases/v0.4.0.md`
- Modify: `scripts/deploy.sh`
- Modify: `package.json`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/TECHNICAL_SPEC.md`

- [x] **Step 1：写回填幂等和对账失败测试**

固定 production 快照 fixture，连续执行两次 `INSERT OR IGNORE` 结果不变；只迁移 Contact/CompleteRegistration 标准事实和必要历史汇总，不迁移旧 Delivery、Outbox、验证或 incident，不生成新事件编号，不重新投递。

```bash
node --test scripts/verify-attribution-v3-migration.test.mjs
```

Expected: FAIL。

- [x] **Step 2：实现备份、preflight、backfill 和 reconcile**

```text
node scripts/verify-attribution-v3-migration.mjs preflight
node scripts/export-attribution-production-backup.mjs
node scripts/verify-attribution-v3-migration.mjs backfill
node scripts/verify-attribution-v3-migration.mjs reconcile
```

preflight 必须确认旧 Meta/TikTok server effective 为 0、新 Google server effective 为 0、旧 pending/retrying/DLQ 为 0、新 Queue/Workflow/主密钥已配置；任一不满足都退出非零。

- [x] **Step 3：重写 production deploy 阶段**

```text
verify:quick
-> attribution preflight
-> production D1 backup
-> apply 0051 Expand
-> deploy API/Web final runtime
-> backfill
-> reconcile
-> production smoke
```

脚本不修改 rollout、不写平台凭证、不伪造验证证据。

验收记录：production 固定快照幂等回填、仓库外 D1 备份、双采样 Queue preflight、只读 reconcile 和统一部署顺序已实现；专项脚本测试 52/52 通过。6 条新 Queue 已创建、无积压且尚未绑定新 Worker；32 字节通用主密钥已备份到本机登录钥匙串并写入 production Secret。真实 production 只读 preflight 只剩旧 Meta Server 有效配置未降为 0，因此尚未应用 `0051`、未部署新运行时，也未写入 production 数据或 rollout。

- [ ] **Step 4：运行脚本测试和 release 验证**

```bash
node --test scripts/verify-attribution-v3-migration.test.mjs scripts/verify-release.test.mjs
corepack pnpm verify:release
```

Expected: PASS；未提供 production 凭证时只运行 dry-run/只读门禁，不调用平台 API。

阶段记录：脚本专项测试 52/52、全量 scripts/migration 313/313、API 1144/1144 和高阈值 coverage 已通过；整体 coverage statements 87.35%、branches 80.78%，最终通用后台路由 statements 95.67%、branches 91.04%。Queue 初始化测试已按“先检查、再创建、再确认”的真实幂等流程隔离状态，并验证远端错误不会泄漏敏感输出。production preflight 已改为顺序读取外部状态；Queue 指标采用顺序双采样，并对网络、429 和 5xx 进行最多 3 次短退避重试，未知状态仍失败关闭。通用归因后台最终四层契约已同步到 E2E mock，完整 Playwright 125 通过、30 个按项目配置跳过、0 失败，覆盖三平台来源隔离和 5 档视口。Lint、API/Web TypeScript、Web 282 个单测和 Nuxt production build 通过。完整 `verify:release` 仍等待旧 Meta Server 降为 0 后在 release 分支执行，因此 Step 4 尚未放行。

- [x] **Step 5：提交并统一推送 dev**

```bash
git add scripts package.json docs/DEPLOYMENT.md docs/TECHNICAL_SPEC.md docs/releases/v0.4.0.md
git commit -m "deploy: 准备通用归因生产切换"
git push origin dev
```

验收记录：切换工具已提交为 `ca64c0e` 并统一推送到 `origin/dev`；Cloudflare Queue 创建后的短暂可见性问题在下一关联提交中增加幂等重试。

- [ ] **Step 6：创建 release 并合规合入 main**

```bash
git switch -c release/v0.4.0 dev
git push -u origin release/v0.4.0
gh pr create --base main --head release/v0.4.0 --title "release: 发布通用广告归因平台" --body-file docs/releases/v0.4.0.md
gh pr checks --watch
gh pr merge --merge --delete-branch
```

Expected: CI 全绿，PR 合入成功；禁止直接 push main。

- [ ] **Step 7：执行 Expand 和新运行时部署**

```bash
git switch main
git pull --ff-only origin main
./scripts/deploy.sh production
```

Expected: 备份文件已生成并记录校验值；`0051` 已应用；新 API/Web release identity 一致；回填和对账通过。

- [ ] **Step 8：production 重新配置和验证**

在统一后台依次保存 Meta、TikTok、Google 连接；Meta/TikTok 使用当次 Test Event Code；Google 完成 OAuth、`validateOnly`、Tag Assistant 和真实 Live Evidence。先恢复 Meta Server 10%，观察无跨平台、无重复、无敏感日志后再处理 TikTok/Google。

### Task 14：执行 Contract migration 并彻底删除旧代码与资源

**Files:**
- Create: `packages/api/migrations/0052_unified_attribution_contract.sql`
- Create: `packages/api/migrations/0052_unified_attribution_contract.test.mjs`
- Delete: `packages/api/src/services/meta-capi-circuit-breaker.ts`
- Delete: `packages/api/src/services/meta-capi-circuit-breaker.test.ts`
- Delete: `packages/api/src/services/meta-capi-delivery-lease.d1.test.ts`
- Delete: `packages/api/src/services/meta-capi-incident-evidence.ts`
- Delete: `packages/api/src/services/meta-capi-incident-evidence.test.ts`
- Delete: `packages/api/src/services/meta-capi-key-rotation.ts`
- Delete: `packages/api/src/services/meta-capi-key-rotation.test.ts`
- Delete: `packages/api/src/services/meta-capi-queue.ts`
- Delete: `packages/api/src/services/meta-capi-queue.test.ts`
- Delete: `packages/api/src/services/meta-capi-rollout.ts`
- Delete: `packages/api/src/services/meta-capi-rollout.test.ts`
- Delete: `packages/api/src/services/meta-capi.ts`
- Delete: `packages/api/src/services/meta-capi.test.ts`
- Delete: `packages/api/src/services/meta-connection.ts`
- Delete: `packages/api/src/services/meta-connection.test.ts`
- Delete: `packages/api/src/services/meta-connection.d1.test.ts`
- Delete: `packages/api/src/services/meta-dataset-quality.ts`
- Delete: `packages/api/src/services/meta-dataset-quality.test.ts`
- Delete: `packages/api/src/services/meta-graph.ts`
- Delete: `packages/api/src/services/meta-graph.test.ts`
- Delete: `packages/api/src/services/meta-live-challenge.ts`
- Delete: `packages/api/src/services/meta-live-challenge.d1.test.ts`
- Delete: `packages/api/src/services/meta-resource-attestation.ts`
- Delete: `packages/api/src/services/meta-resource-attestation.test.ts`
- Delete: `packages/api/src/services/meta-resource-attestation-ticket.ts`
- Delete: `packages/api/src/services/meta-resource-attestation-ticket.d1.test.ts`
- Delete: `packages/api/src/services/tiktok-connection.ts`
- Delete: `packages/api/src/services/tiktok-connection.d1.test.ts`
- Delete: `packages/api/src/services/tiktok-events.ts`
- Delete: `packages/api/src/services/tiktok-events.test.ts`
- Delete: `packages/api/src/services/tiktok-events-delivery.ts`
- Delete: `packages/api/src/services/tiktok-events-delivery.d1.test.ts`
- Delete: `packages/api/src/services/tiktok-events-queue.ts`
- Delete: `packages/api/src/services/tiktok-events-queue.d1.test.ts`
- Delete: `packages/api/src/utils/meta-capi-crypto.ts`
- Delete: `packages/api/src/utils/meta-capi-crypto.test.ts`
- Delete: `packages/api/src/utils/tiktok-events-crypto.ts`
- Delete: `packages/api/src/utils/tiktok-events-crypto.test.ts`
- Delete: `packages/api/src/routes/meta-resource-attestation.ts`
- Delete: `packages/api/src/meta-resource-attestation-route.test.ts`
- Delete: `packages/api/src/meta-resource-attestation-ticket-route.test.ts`
- Delete: `scripts/meta-dataset-quality-contract-lib.mjs`
- Delete: `scripts/meta-dataset-quality-contract-lib.test.mjs`
- Delete: `scripts/meta-live-verification-lib.mjs`
- Delete: `scripts/meta-live-verification-lib.test.mjs`
- Delete: `scripts/meta-resources-summary-fixture.mjs`
- Delete: `scripts/record-meta-dataset-quality-contract.mjs`
- Delete: `scripts/record-meta-dataset-quality-contract.test.mjs`
- Delete: `scripts/record-meta-live-verification.mjs`
- Delete: `scripts/record-meta-live-verification.test.mjs`
- Delete: `scripts/verify-meta-migration.mjs`
- Delete: `scripts/verify-meta-migration.test.mjs`
- Delete: `scripts/verify-meta-resources.mjs`
- Delete: `scripts/verify-meta-resources.test.mjs`
- Delete: `scripts/verify-meta-secret-leaks.mjs`
- Delete: `scripts/verify-meta-secret-leaks.test.mjs`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/wrangler.toml`
- Modify: `package.json`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/DEPLOYMENT.md`

- [ ] **Step 1：写 Contract 失败测试**

Contract 仅在新事实对账完成、Meta 10% 正常、新 Queue 无旧消息时允许执行。测试确认旧技术表和 bridge trigger 全部删除，标准业务历史和审计仍存在，最终运行查询不引用旧表。

```bash
node --test packages/api/migrations/0052_unified_attribution_contract.test.mjs
```

Expected: FAIL。

- [ ] **Step 2：删除旧技术 Schema 和运行代码**

删除所有 Meta/TikTok 旧连接、验证、challenge、attestation、rollout、incident、质量、Delivery、Outbox、Receipt、DLQ 运行表和 `trg_0049_bridge_*`。已应用的历史 migration 保留。删除旧平台服务、旧 crypto、旧 Queue consumer、旧 release evidence、旧 API 和旧测试替身。

- [ ] **Step 3：运行冗余扫描**

```bash
rg -n "META_CAPI_|TIKTOK_EVENTS_|meta_connection_verifications|tiktok_connection_verifications|meta_live_|resource_attestation|meta_capi_secure_outbox|ad_platform_secure_outbox|analytics_conversion_deliveries" packages scripts docs --glob '!packages/api/migrations/00*.sql' --glob '!docs/superpowers/specs/2026-07-15-unified-ad-attribution-platform-design.md'
```

Expected: 无运行时代码、当前脚本或当前文档命中；历史 migration 可保留。

- [ ] **Step 4：执行最终完整验证**

```bash
corepack pnpm test:scripts
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm --filter @meigallery/web test:e2e
corepack pnpm verify:local-runtime
corepack pnpm verify:release
corepack pnpm build
```

Expected: 全部 PASS。

- [ ] **Step 5：提交、PR、部署 Contract**

```bash
git add -A
git commit -m "refactor: 删除旧广告归因实现"
git push origin dev
```

通过新的 release PR 合入 `main` 后执行 `./scripts/deploy.sh production`。Contract 部署完成后删除旧 Cloudflare Queue：`meigallery-meta-capi`、`meigallery-meta-capi-dlq`、`meigallery-tiktok-events`、`meigallery-tiktok-events-dlq`，并删除旧平台 Token/Data Key Secret。删除前再次确认旧 Queue 消息为 0。

- [ ] **Step 6：最终 production 验收**

确认三平台同时启用时一条事实只投递一个 provider；Browser/Server 共用 `mg3_` 编号；未同意、无来源和冲突来源零广告请求；Test Event Code 不长期保存；Google 不依赖 GA4 或 Developer Token；后台数据口径和 Free 预警准确；任一平台可独立将 Server effective 调为 0。

---

## 执行顺序与停止条件

1. Task 1-12 在 `dev` 完成并通过全部本地验证前，不创建 production 连接、不调用真实平台 API。
2. Task 13 的 production preflight 任一项失败，立即停止，不应用 Expand。
3. Expand 后新 Worker 部署失败，部署上一 Worker 版本；因为旧表未修改，旧运行时可以恢复。
4. 新 Worker 部署成功但回填/对账失败，Server rollout 保持 0，修复后重新执行幂等 backfill；不得执行 Contract。
5. Contract 前必须具备 D1 备份、旧 Worker 版本号、新事实对账结果和 Meta 10% 观察证据。
6. Contract 后回滚必须恢复 D1 备份并部署上一 Worker 版本，禁止临时恢复旧兼容代码。

## 最终完成定义

- [ ] 三个平台经过同一 registry、connection service、planner、queue runtime、verification workflow 和后台骨架。
- [ ] 业务核心不存在 provider 分支，平台协议只存在于 Adapter。
- [ ] production 网络证据证明三平台严格隔离且无 fan-out。
- [ ] 旧运行表、旧 Queue、旧 Secret、旧 API、旧组件和旧运行代码全部删除。
- [ ] 历史标准事实和必要分析趋势完整，旧技术状态未重新投递。
- [ ] Google production 验证通过，GA4 未被误接入。
- [ ] Cloudflare Free 安全线和 70% 预警生效，未新增固定成本。
- [ ] `docs/PROJECT_STATUS.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md` 与最终代码一致。
