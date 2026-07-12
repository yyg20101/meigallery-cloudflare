# Meta CAPI v2 安全投递 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cloudflare 内完成 Pixel ID、CAPI token 与测试码的强绑定，并通过 AES-256-GCM 加密临时 Outbox 安全投递 Contact 和 CompleteRegistration，其中注册事件在明确营销授权后使用邮箱 hash 与不可逆内部 external ID 增强匹配。

**Architecture:** 业务事实提交时生成 delivery 和短期加密上下文；D1 仅保存 AES-GCM 密文，Queue message 也只携带密文。Queue consumer 用当前或上一把 Worker Secret 密钥解密并调用 Meta Graph API。MetaConnection 以 Pixel ID、token HMAC 指纹和 Test Event 验证记录为整体，任一配置变化即停止投递并要求 Owner 重新验证。

**Tech Stack:** Hono、TypeScript、Cloudflare Workers Web Crypto、D1、Queues、Worker Secrets、Vitest、Node.js test runner、Wrangler、Meta Graph API v25.0。

**Source of truth:** `docs/superpowers/specs/2026-07-10-meta-capi-v2-architecture-design.md`

**Depends on:** `docs/superpowers/plans/2026-07-10-meta-capi-v2-domain-consolidation.md` 的 Phase Exit Gate 已通过。

## Global Constraints

- 所有 CAPI 常驻运行组件只使用 Cloudflare Workers、D1、Queues 和 Worker Secrets。
- `META_CAPI_ACCESS_TOKEN`、`META_CAPI_TEST_EVENT_CODE`、数据加密密钥及其派生值不能进入日志、API 响应、审计详情或测试快照。
- D1 和 Queue 中禁止保存明文 email、IP、User-Agent、`fbp`、`fbc` 或 internal external ID。
- 加密算法固定为 AES-256-GCM：32-byte base64 secret、12-byte 随机 IV、128-bit authentication tag。
- AAD 必须绑定 `schemaVersion`、`deliveryId`、`externalEventId`、`eventName`，防止密文被换绑到其他 delivery。
- 加密上下文最长保存 24 小时；入队成功后删除 D1 密文；过期、永久失败或完成后均删除残留密文。
- 当前密钥用于加密；当前密钥和上一把密钥均可解密。上一把密钥只在无活跃密文引用后移除。
- Contact 只发送浏览器匹配信号；CompleteRegistration 仅在 `consentState=granted` 时增加 `em` 和 `external_id` SHA-256 值。
- token 只通过 Worker Secret 配置。项目设置存 Pixel ID 与开关，不保存 token。
- Meta Graph API 继续固定 `v25.0`，URL 与 payload 用 contract test 锁定。
- 本计划不启用 production rollout；所有新增能力默认关闭或 test mode。

---

## Target Data Contracts

共享 Queue message 更新为：

```ts
export interface MetaCapiEncryptedEnvelope {
  schemaVersion: 2
  keyId: string
  iv: string
  ciphertext: string
  tag: string
}

export interface MetaCapiQueueMessage {
  schemaVersion: 2
  deliveryId: string
  envelope: MetaCapiEncryptedEnvelope
}
```

加密前的内存对象固定为：

```ts
export interface MetaCapiSensitiveContext {
  fbp?: string
  fbc?: string
  clientIpAddress?: string
  clientUserAgent?: string
  emailSha256?: string
  externalIdSha256?: string
}
```

该对象只能存在于创建 delivery 的请求内存、解密后的 Queue consumer 内存和测试 fixture；不得 JSON 序列化到日志或普通 D1 字段。

---

### Task 1: 增加安全投递与用户匹配数据模型

**Files:**
- Create: `packages/api/migrations/0036_meta_capi_v2_secure_delivery.sql`
- Create: `packages/api/migrations/0036_meta_capi_v2_secure_delivery.test.mjs`
- Modify: `packages/api/src/utils/analytics-migrations.test.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/api/src/index.ts`

**Schema:**

```sql
ALTER TABLE users ADD COLUMN meta_external_id TEXT;

UPDATE users
SET meta_external_id = lower(hex(randomblob(16)))
WHERE meta_external_id IS NULL OR meta_external_id = '';

CREATE UNIQUE INDEX idx_users_meta_external_id
  ON users(meta_external_id)
  WHERE meta_external_id IS NOT NULL AND meta_external_id <> '';

CREATE TABLE meta_connection_verifications (
  environment TEXT PRIMARY KEY,
  pixel_id TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  graph_api_version TEXT NOT NULL,
  verified_event_name TEXT NOT NULL,
  verified_commit TEXT NOT NULL,
  dataset_quality_status TEXT NOT NULL DEFAULT 'not_checked',
  verified_at TEXT NOT NULL,
  verified_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (graph_api_version = 'v25.0'),
  CHECK (verified_event_name IN ('Contact', 'CompleteRegistration')),
  CHECK (length(verified_commit) = 40 AND verified_commit NOT GLOB '*[^0-9A-Fa-f]*'),
  CHECK (dataset_quality_status IN ('not_checked', 'available', 'permission_denied', 'error'))
);

CREATE TABLE meta_capi_secure_outbox (
  delivery_id TEXT PRIMARY KEY REFERENCES analytics_conversion_deliveries(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (schema_version = 2)
);

CREATE INDEX idx_meta_capi_secure_outbox_expiry
  ON meta_capi_secure_outbox(expires_at);

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN has_email INTEGER NOT NULL DEFAULT 0 CHECK (has_email IN (0, 1));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN has_external_id INTEGER NOT NULL DEFAULT 0 CHECK (has_external_id IN (0, 1));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN encryption_key_id TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 1: 写 migration 失败测试**

`0036_meta_capi_v2_secure_delivery.test.mjs` 在临时 D1 兼容 SQLite 中顺序执行 0001-0036，并断言：

- 两个已有用户都获得 32-char lowercase hex `meta_external_id` 且互不相同。
- 新用户可由应用显式写入随机 external ID。
- `meta_connection_verifications.environment` 唯一。
- secure outbox 拒绝 schema version 1。
- 删除 delivery 会级联删除 outbox。
- delivery 的 `has_email/has_external_id` 默认 0 且拒绝其他整数。
- CAPI delivery 可保存非敏感 `encryption_key_id`，用于 Queue 入队后继续判断旧密钥是否仍被活动消息引用。
- connection verification 保存 40-char `verified_commit` 与 Dataset Quality 权限状态，不保存 token 原值。
- 0036 不修改历史 conversion action 与 delivery 状态。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test packages/api/migrations/0036_meta_capi_v2_secure_delivery.test.mjs
corepack pnpm --filter @meigallery/api test -- src/utils/analytics-migrations.test.ts
```

Expected: FAIL，0036 和新字段尚不存在。

- [ ] **Step 3: 创建 migration 与共享类型**

添加上述 SQL。将 `MetaCapiQueueMessage` 升级为 schema version 2，并把 `MetaCapiUserData` 改名为仅供内存使用的 `MetaCapiSensitiveContext`。Bindings 增加：

```ts
META_CAPI_DATA_KEY_CURRENT?: string
META_CAPI_DATA_KEY_PREVIOUS?: string
```

不在类型中加入 token fingerprint 原值、email 原值或 external ID 原值。

- [ ] **Step 4: 运行测试并提交**

Run:

```bash
node --test packages/api/migrations/0036_meta_capi_v2_secure_delivery.test.mjs
corepack pnpm --filter @meigallery/api test -- src/utils/analytics-migrations.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/migrations/0036_meta_capi_v2_secure_delivery.sql packages/api/migrations/0036_meta_capi_v2_secure_delivery.test.mjs packages/api/src/utils/analytics-migrations.test.ts packages/shared/src/types/index.ts packages/api/src/index.ts
git commit -m "feat: 建立 CAPI 安全投递数据模型"
```

---

### Task 2: 实现 AES-GCM、HMAC 与增强匹配纯函数

**Files:**
- Create: `packages/api/src/utils/meta-capi-crypto.ts`
- Create: `packages/api/src/utils/meta-capi-crypto.test.ts`
- Modify: `packages/api/src/utils/meta-browser-identifiers.ts`
- Modify: `packages/api/src/utils/meta-browser-identifiers.test.ts`

**Interfaces:**

```ts
export interface MetaCapiCryptoKeys {
  current: { id: string; key: CryptoKey }
  previous?: { id: string; key: CryptoKey }
}

export function loadMetaCapiCryptoKeys(env: {
  META_CAPI_DATA_KEY_CURRENT?: string
  META_CAPI_DATA_KEY_PREVIOUS?: string
}): Promise<MetaCapiCryptoKeys>

export function encryptMetaCapiContext(input: {
  keys: MetaCapiCryptoKeys
  aad: MetaCapiEnvelopeAad
  value: MetaCapiSensitiveContext
}): Promise<MetaCapiEncryptedEnvelope>

export function decryptMetaCapiContext(input: {
  keys: MetaCapiCryptoKeys
  aad: MetaCapiEnvelopeAad
  envelope: MetaCapiEncryptedEnvelope
}): Promise<MetaCapiSensitiveContext>

export function metaConnectionFingerprint(
  pixelId: string,
  accessToken: string,
): Promise<string>

export function normalizeAndHashEmail(email: string): Promise<string>
export function hashMetaExternalId(externalId: string): Promise<string>
```

- [ ] **Step 1: 写密码学失败测试**

测试固定覆盖：

1. 32-byte base64 key 可以 round trip。
2. 空值、非 base64、31/33-byte key 明确抛 `META_CAPI_DATA_KEY_INVALID`。
3. 每次加密使用不同 12-byte IV，相同明文产生不同 ciphertext。
4. 修改 delivery ID、event ID、event name、ciphertext 或 tag 后解密失败。
5. current 加密可由 current 解密；previous 加密可在轮换窗口由 previous 解密；未知 key ID 失败。
6. `User.Name+tag@Example.COM` 归一化为 trim + lowercase 后得到固定 SHA-256 hex。
7. external ID 直接以 UTF-8 SHA-256，返回 64-char lowercase hex。
8. connection fingerprint 同一 pixel/token 稳定，pixel 或 token 任一变化即不同；HMAC key 是 access token，message 不包含 token。
9. 抛出的 error message 不含 key、token、email、external ID 或明文 JSON。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/meta-capi-crypto.test.ts src/utils/meta-browser-identifiers.test.ts
```

Expected: FAIL，密码学模块尚不存在。

- [ ] **Step 3: 实现编码、密钥解析与 AES-GCM**

只使用 `crypto.subtle` 与 `crypto.getRandomValues`。key ID 定义为原始 32-byte key 的 SHA-256 前 16 个 hex 字符；不得把 key 本身作为 ID。AES-GCM 返回的最后 16 bytes 拆为 tag，其余作为 ciphertext，均使用 base64url 无 padding 编码。

AAD 使用稳定 UTF-8 JSON：

```ts
JSON.stringify({
  schemaVersion: 2,
  deliveryId,
  externalEventId,
  eventName,
})
```

对象键顺序由上述显式对象固定，禁止对任意对象直接 stringify。

- [ ] **Step 4: 实现 HMAC 与 SHA-256**

connection fingerprint 使用 HMAC-SHA-256，key 为 `META_CAPI_ACCESS_TOKEN`，message 固定为：

```text
meta-connection-v1\n<pixelId>
```

email 只执行 trim + lowercase；不擅自删除 Gmail dot、plus tag 或做域名规则。hash 函数只返回 hex，不返回 normalized 原值。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/utils/meta-capi-crypto.test.ts src/utils/meta-browser-identifiers.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/src/utils/meta-capi-crypto.ts packages/api/src/utils/meta-capi-crypto.test.ts packages/api/src/utils/meta-browser-identifiers.ts packages/api/src/utils/meta-browser-identifiers.test.ts
git commit -m "feat: 实现 CAPI 加密与增强匹配工具"
```

---

### Task 3: 用加密 Outbox 替换明文 Queue message

**Files:**
- Create: `packages/api/src/services/meta-capi-secure-outbox.ts`
- Create: `packages/api/src/services/meta-capi-secure-outbox.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/services/meta-capi-queue.ts`
- Rewrite: `packages/api/src/services/meta-capi-queue.test.ts`
- Modify: `packages/api/src/services/meta-capi.ts`
- Modify: `packages/api/src/services/meta-capi.test.ts`

**Interfaces:**

```ts
export function createSecureOutboxStatement(
  db: D1Database,
  input: { deliveryId: string; envelope: MetaCapiEncryptedEnvelope; expiresAt: string },
): D1PreparedStatement

export function enqueueSecureMetaCapiDelivery(
  env: SecureOutboxEnv,
  deliveryId: string,
  options?: { requireStale?: boolean },
): Promise<'enqueued' | 'failed' | 'expired' | 'not_pending'>

export function purgeExpiredMetaCapiOutbox(
  db: D1Database,
  limit?: number,
): Promise<{ purged: number; skipped: number }>
```

- [ ] **Step 1: 写生命周期失败测试**

`meta-capi-secure-outbox.test.ts` 和 queue tests 覆盖：

- conversion action、delivery、outbox 在同一 D1 batch 提交；任一 statement 失败时三者均不留下。
- Queue send 收到的 message 只有 `schemaVersion`、`deliveryId`、`envelope`，序列化文本不含测试 IP、User-Agent、`fbp/fbc`、email hash 或 external ID hash。
- Queue send 成功后 D1 outbox 被删除并写 `queue_enqueued_at`。
- Queue send 失败时 outbox 保留，scheduled recovery 可重新入队。
- Queue send 成功、D1 清理失败时下次恢复可能重复入队，但相同 external event ID 只能成功状态迁移一次。
- 24 小时过期上下文不再发送，delivery 变为 `skipped/secure_context_expired`，密文被删除。
- consumer 用 current 或 previous key 解密；未知 key、AAD 不匹配或认证失败写永久失败 `secure_context_invalid` 并 ack。
- sent、permanent failure、DLQ retry exhausted 都删除残留 outbox。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-secure-outbox.test.ts src/services/meta-capi-queue.test.ts src/services/conversions.test.ts src/services/meta-capi.test.ts
```

Expected: FAIL，当前 Queue message 含明文 `userData`，recovery 用空对象丢失匹配数据。

- [ ] **Step 3: 在业务事实 batch 中写加密 Outbox**

`conversions.ts` 在规划 CAPI delivery 时：

1. 内存构造 `MetaCapiSensitiveContext`。
2. 读取密钥并以 delivery metadata 构造 AAD。
3. 加密后把 outbox insert statement 与 action、daily、delivery 放入同一 D1 batch。
4. `has_fbp/has_fbc/has_email/has_external_id` 只记录布尔覆盖率。
5. CAPI delivery 写入 envelope 的 `keyId` 作为 `encryption_key_id`；该值不是密钥，可用于轮换期统计活动 Queue 消息。
6. D1 commit 后调用 `enqueueSecureMetaCapiDelivery()`，不再把 user data 作为函数参数传入。

若加密密钥缺失，第一方 action 和 Pixel delivery 正常创建；CAPI delivery 写 `skipped/missing_data_key`，不创建 outbox。

- [ ] **Step 4: 重写 enqueue、recovery 与 consumer**

- enqueue 从 D1 读取 envelope，发送 schema v2 message。
- send 成功后在一个 batch 中更新 `queue_enqueued_at` 并删除 outbox。
- stale recovery 读取原密文，不再发送 `{}`。
- consumer 先按 delivery 查询 AAD 字段，再解密 message envelope，再调用 `sendMetaCapiEvent()`。
- consumer 的 `finally` 只在 sent、skipped、permanent failed、DLQ terminal 时删除 outbox；retryable 失败保留 Queue message 自带密文，不依赖 D1 outbox。
- scheduled handler 每次最多清理 100 条过期 outbox。

- [ ] **Step 5: 收窄 CAPI payload**

`buildMetaCapiPayload()` 只允许：

```ts
user_data: {
  fbp?: string
  fbc?: string
  client_ip_address?: string
  client_user_agent?: string
  em?: [string]
  external_id?: [string]
}
```

拒绝非 64-char lowercase hex 的 `emailSha256/externalIdSha256`。Contact 测试明确断言 `em`、`external_id` 不存在；CompleteRegistration 授权测试断言二者均为单元素数组。

- [ ] **Step 6: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi-secure-outbox.test.ts src/services/meta-capi-queue.test.ts src/services/conversions.test.ts src/services/meta-capi.test.ts src/index.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/src/services/meta-capi-secure-outbox.ts packages/api/src/services/meta-capi-secure-outbox.test.ts packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/services/meta-capi-queue.ts packages/api/src/services/meta-capi-queue.test.ts packages/api/src/services/meta-capi.ts packages/api/src/services/meta-capi.test.ts packages/api/src/index.ts packages/api/src/index.test.ts
git commit -m "refactor: 使用加密 Outbox 投递 CAPI"
```

---

### Task 4: 建立 MetaConnection 绑定与失效机制

**Files:**
- Create: `packages/api/src/services/meta-connection.ts`
- Create: `packages/api/src/services/meta-connection.test.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/meta-capi.ts`
- Modify: `packages/web/app/pages/admin/attribution/meta.vue`
- Create: `packages/web/app/pages/admin/attribution/meta.test.ts`
- Modify: `packages/web/app/composables/useAdminAttribution.ts`

**Interfaces:**

```ts
export type MetaConnectionState =
  | 'not_configured'
  | 'unverified'
  | 'verified'
  | 'configuration_changed'

export interface MetaConnectionStatus {
  state: MetaConnectionState
  environment: 'dev' | 'production'
  pixelIdConfigured: boolean
  tokenConfigured: boolean
  testEventCodeConfigured: boolean
  verifiedAt: string | null
  verifiedCommit: string | null
  graphApiVersion: 'v25.0'
  datasetQualityStatus: 'not_checked' | 'available' | 'permission_denied' | 'error'
  invalidationReason: string
}

export function verifyMetaConnection(
  env: MetaConnectionEnv,
  ownerUserId: number,
  eventName: 'Contact' | 'CompleteRegistration',
): Promise<MetaConnectionStatus>

export function requireVerifiedMetaConnection(
  env: MetaConnectionEnv,
): Promise<{ pixelId: string; trackingMode: 'test' | 'production' }>
```

- [ ] **Step 1: 写连接状态失败测试**

覆盖以下状态转换：

1. Pixel ID/token 缺失为 `not_configured`。
2. 配置完整但无验证行为 `unverified`。
3. Owner 在 dev test mode 发送真实 Test Event 成功后写 `verified`。
4. Pixel ID 改变、token 改变或 Graph API version 改变后为 `configuration_changed`。
5. test event code 改变不影响 production fingerprint，但 test mode 仍要求非空测试码。
6. 未验证连接不创建 CAPI outbox，delivery 为 `skipped/connection_unverified`。
7. token 原值不出现在 D1 bind snapshot、日志或 admin JSON。
8. 非 Owner 调用验证 route 返回 403 并产生审计日志。
9. 验证记录绑定当前 40-char `RELEASE_COMMIT`；commit 缺失或不合法时不写 verified row。
10. dev 与 production 可分别绑定独立 Pixel/Dataset，不复用 verification row。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-connection.test.ts src/routes/admin/attribution.test.ts src/services/conversions.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/pages/admin/attribution/meta.test.ts
```

Expected: FAIL，当前 Pixel ID 与 token 分开判断，没有持久化绑定记录。

- [ ] **Step 3: 实现连接读取和 HMAC 比对**

`meta-connection.ts`：

- 从 site settings 读取 `facebook_pixel_id` 和 tracking mode。
- 从 Worker Secret 读取 token/test code。
- 使用 access token 作为 HMAC key、领域前缀与 Pixel ID 作为 message 计算不可逆连接 fingerprint；token 不进入 message。
- 按 `APP_ENV` 映射 `dev | production`，其他环境只能返回 unverified。
- 常规运行要求持久化记录的 pixel ID、fingerprint、Graph API version 全部匹配。
- 验证成功时保存当前 40-char `RELEASE_COMMIT`；缺失合法 release commit 时不得写 verified row。

- [ ] **Step 4: 实现 Test Event bootstrap**

本阶段唯一 bootstrap 例外是 Owner 在 dev 主动调用 admin test route。dev 必须为 tracking mode=test，并要求 dev Pixel ID/token/test code/data key 配置完整。只有 Meta 返回 HTTP success 且 `events_received=1` 后才能 upsert dev verification row。

admin Test Event 可显式携带 `test_event_code`；正常事件 payload 永远不得携带该字段。production bootstrap 在本阶段固定返回 `409 META_PRODUCTION_TEST_GATE_PENDING`，待质量运营计划建立 rollout、incident 和最终 main commit 门禁后再启用，避免引用尚不存在的运维状态。任何测试失败都不写 verification row。

- [ ] **Step 5: 接入投递门禁与后台状态**

业务事实规划 CAPI delivery 前调用 `requireVerifiedMetaConnection()`；未验证只影响 CAPI，不影响 action、Analytics 或 Pixel。后台只显示布尔配置状态、连接状态、verified time、Graph version 和失效原因，不返回 fingerprint。

- [ ] **Step 6: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-connection.test.ts src/routes/admin/attribution.test.ts src/services/conversions.test.ts src/services/meta-capi.test.ts
corepack pnpm --filter @meigallery/web test:unit -- app/pages/admin/attribution/meta.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt typecheck
git diff --check
git add packages/api/src/services/meta-connection.ts packages/api/src/services/meta-connection.test.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts packages/api/src/services/conversions.ts packages/api/src/services/meta-capi.ts packages/web/app/pages/admin/attribution/meta.vue packages/web/app/pages/admin/attribution/meta.test.ts packages/web/app/composables/useAdminAttribution.ts
git commit -m "feat: 绑定并验证 MetaConnection"
```

---

### Task 5: 为服务端注册增加授权增强匹配

**Files:**
- Modify: `packages/api/src/routes/auth.ts`
- Modify: `packages/api/src/routes/auth-registration-conversion.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/services/meta-capi.test.ts`
- Modify: `packages/api/src/services/registration-conversion-recovery.ts`
- Modify: `packages/api/src/services/registration-conversion-recovery.test.ts`

**Data rule:**
- Contact: `fbp/fbc/client_ip_address/client_user_agent` only.
- CompleteRegistration with granted consent: browser identifiers plus `em` and `external_id` hashes.
- CompleteRegistration without granted consent: first-party fact only; no Pixel/CAPI delivery.
- Recovery-created registration fact: never creates Meta delivery.

- [ ] **Step 1: 写增强匹配失败测试**

测试：

- 注册成功后从刚写入用户读取 `email` 与 `meta_external_id`，只在内存中 hash。
- granted 时加密上下文包含 hash，delivery flags 均为 1。
- limited/denied 时不调用 hash 函数、不创建 CAPI outbox，flags 为 0。
- Contact 即使用户已登录也不查询用户 email/external ID。
- CAPI request JSON 只有 hash，没有 email 原值和 external ID 原值。
- registration recovery 仍为 fact-only。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/auth-registration-conversion.test.ts src/services/conversions.test.ts src/services/meta-capi.test.ts src/services/registration-conversion-recovery.test.ts
```

Expected: FAIL，当前注册上下文没有服务端 email/external ID hash。

- [ ] **Step 3: 在注册 route 构造增强匹配上下文**

用户插入后确保 `meta_external_id` 已生成；新用户 insert 由应用使用 `crypto.getRandomValues(new Uint8Array(16))` 生成 32-char hex，migration 的 randomblob 只用于历史回填。注册 route 将原始 email/external ID 传给 `recordRegistration()` 的专用服务端参数，conversion service 立即 hash 后丢弃原值。

`RecordRegistrationSensitiveInput` 不导出到 shared package，也不进入返回类型：

```ts
interface RecordRegistrationSensitiveInput {
  email: string
  metaExternalId: string
}
```

- [ ] **Step 4: 锁定 payload 和日志边界**

为 `console.error/warn` 使用结构化代码和 delivery ID；测试 spy 递归检查所有日志参数不含测试 email、external ID、token、IP 和 User-Agent。Meta error body 经 allowlist 提取 error code 与 trace ID，不持久化完整响应。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/auth-registration-conversion.test.ts src/services/conversions.test.ts src/services/meta-capi.test.ts src/services/registration-conversion-recovery.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
git diff --check
git add packages/api/src/routes/auth.ts packages/api/src/routes/auth-registration-conversion.test.ts packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/services/meta-capi.test.ts packages/api/src/services/registration-conversion-recovery.ts packages/api/src/services/registration-conversion-recovery.test.ts
git commit -m "feat: 增强注册事件匹配质量"
```

---

### Task 6: 加固资源检查、密钥轮换与泄漏扫描

**Files:**
- Modify: `packages/api/wrangler.toml`
- Modify: `scripts/setup.sh`
- Modify: `scripts/verify-meta-resources.mjs`
- Modify: `scripts/verify-meta-resources.test.mjs`
- Create: `scripts/verify-meta-secret-leaks.mjs`
- Create: `scripts/verify-meta-secret-leaks.test.mjs`
- Modify: `package.json`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/PROJECT_STATUS.md`

- [ ] **Step 1: 写资源和泄漏检查失败测试**

资源检查必须把以下项列为 CAPI readiness 必需：

- `META_CAPI_ACCESS_TOKEN`
- `META_CAPI_TEST_EVENT_CODE`（test mode）
- `META_CAPI_DATA_KEY_CURRENT`
- 主 Queue 与 DLQ
- consumer `max_retries=5`、`retry_delay=60`、dead letter queue 正确绑定
- migration 0036 已应用
- MetaConnection 为 verified

泄漏扫描测试构造带 token、email、IP、User-Agent、64-char hash 的 fixture，确认 scanner 能在受检目录的非测试输出 fixture 中失败；真实仓库扫描排除 `.git`、`node_modules`、构建产物和测试中明确的假数据。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test scripts/verify-meta-resources.test.mjs scripts/verify-meta-secret-leaks.test.mjs
```

Expected: FAIL，资源检查尚不知道 data key 与 connection，泄漏脚本尚不存在。

- [ ] **Step 3: 更新配置与 setup**

`wrangler.toml` 为 dev 和 production 明确主 Queue/DLQ consumer 参数；注释新增 data key secret 命令，但不写 secret 值。`setup.sh` 幂等创建四个 Queue，并在已存在时继续。

- [ ] **Step 4: 实现密钥轮换检查**

资源检查只验证 secret 名存在，不读取值。后台 readiness 通过 Worker 内部 status endpoint 报告：current key valid、previous key configured、引用 previous key 的 active outbox count、引用 previous key 且状态为 pending/failed 的 delivery count。只有两个 count 都为 0 才显示“可移除上一把密钥”。已 sent 的重复 Queue message 在读取 delivery 后直接 ack，不需要旧密钥解密。

部署文档固定轮换顺序：

1. 把旧 current 复制到 previous。
2. 生成 `openssl rand -base64 32` 作为新 current。
3. 部署并等待 previous outbox count 与 active delivery count 都为 0。
4. 删除 previous secret，再次部署。

- [ ] **Step 5: 实现静态泄漏扫描**

扫描 tracked files 以及 release evidence JSON，拒绝：

- secret 名后直接出现疑似真实值。
- `access_token=` URL。
- CAPI payload 中非 hash email。
- secure outbox 之外的 `client_ip_address/client_user_agent/fbp/fbc` 持久化 SQL。

脚本输出只显示文件路径和规则 ID，不回显命中原文。

- [ ] **Step 6: 运行阶段完整验证**

Run:

```bash
node --test scripts/verify-meta-resources.test.mjs scripts/verify-meta-secret-leaks.test.mjs
node scripts/verify-meta-secret-leaks.mjs
corepack pnpm lint
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
corepack pnpm verify:quick
git diff --check
```

- [ ] **Step 7: 提交阶段结果**

Run:

```bash
git add -A
git commit -m "test: 加固 CAPI 安全投递门禁"
```

---

## Phase Exit Gate

本计划完成必须同时满足：

- Pixel ID、token fingerprint 与 Graph API version 作为一个 MetaConnection 验证，配置变化自动失效。
- D1 与 Queue 均无明文敏感匹配数据；加密密文最长存活 24 小时。
- Queue recovery 不再丢失匹配数据，且所有重试使用相同 external event ID。
- 当前/上一把 AES 密钥轮换路径有单元测试和运行检查。
- Contact payload 不含 `em/external_id`；授权注册 payload 含两个合法 SHA-256 值。
- secret、日志、API 响应和 release evidence 泄漏扫描通过。
- dev 环境可用独立 Pixel/Dataset 完成真实 Test Event bootstrap；production Meta tracking 保持 disabled，尚不允许 production bootstrap。
- API test、Web test、script test、lint、API tsc、Web build、quick verification 全部通过。

本门禁通过后才能执行 `2026-07-10-meta-capi-v2-quality-operations.md`。
