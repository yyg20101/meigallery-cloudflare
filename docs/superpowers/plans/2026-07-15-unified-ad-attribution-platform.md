# Unified Ad Attribution Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Meta 与 TikTok 收口到同一套安全、可验证、可放量的广告归因控制面，在保持 Meta production `10%` 稳定运行的前提下完成旧架构清理，并让 TikTok 可按 `0% -> 10% -> 50% -> 100%` 独立上线。

**Architecture:** 继续以 `analytics_conversion_actions` 作为唯一业务事实，来源解析后只允许一个 provider；Browser 与 Server 共用同一平台事件 ID。连接、凭证、测试挑战、人工证据、rollout、incident 和质量快照进入通用控制面，Meta/TikTok 的外部协议只存在于小型 Adapter；发布采用有明确终点的 expand、通用运行时切换、24 小时观察和 contract 四阶段。

**Tech Stack:** TypeScript、Hono、Nuxt 4、Vue 3、Cloudflare Workers、D1、Queues、Web Crypto AES-256-GCM、Vitest、Node test runner、Miniflare、Playwright、pnpm。

## Global Constraints

- 所有实现、注释、文档、UI 文案和 commit message 使用中文；代码标识符、API 路径和技术缩写保留英文。
- `production` 是唯一允许调用真实 Meta/TikTok API 的环境；`dev/local` 只能使用 mock、fixture 和契约测试。
- `analytics_conversion_actions` 是唯一转化事实源；一条事实最多归属一个 provider，禁止 fan-out、广播和按启用平台猜测来源。
- `Contact` 只在用户激活通过安全 URL 校验的外部联系链接时创建；复制、二维码展开、联系面板展开只进入一方 analytics。
- `CompleteRegistration` 只由注册事务成功后的服务端路径创建；公开 conversion API 不接受注册事件。
- Browser 与 Server 对同一 provider、同一事实必须使用相同事件名和 `event_id`。
- Meta production 在通用运行时稳定前保持 target/effective `10%`；TikTok 在生产人工验证前保持 disabled、Server 关闭、rollout `0%`。
- Test Event Code 只存在于 Owner 当前页面内存和当次请求，不落 D1、不进入日志、审计、响应或 Worker Secret。
- Token 通过 AES-256-GCM 加密保存在 D1，API 永不回显；Worker Secret 最终只保留 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 和轮换期的 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS`。
- 凭证 AAD 固定包含 `provider + credential_type + credential_revision`；临时匹配上下文 AAD 固定包含 `provider + connection_revision + delivery_id + event_id`。
- 连接 revision、凭证 revision、事件映射、协议版本或证据契约变化必须使旧验证/证据失效；人工去重证据有效期为 30 天。
- Server rollout 只允许 `0 -> 10 -> 50 -> 100` 相邻人工升级；凭证拒绝或 critical incident 自动降为 effective `0%`，证据过期自动将 effective 上限降为 `10%`。
- 不删除历史 migration 文件；contract 通过新的 migration 删除生产运行表、桥接 trigger 和应用兼容代码。
- 每个任务先写失败测试，再实现，再运行聚焦测试和相关回归，最后形成中文本地 commit；非功能闭环不单独推送。
- 设计事实以 `docs/superpowers/specs/2026-07-15-unified-ad-attribution-platform-design.md` 为准。

---

## 文件结构映射

### 共享契约

- `packages/shared/src/types/index.ts`：规范事件、provider、能力、连接状态、验证挑战、证据、rollout 和 incident 的跨包类型。
- `packages/shared/src/constants/index.ts`：活动事件、rollout 阶段、证据 TTL 和 Adapter 注册约束。

### API 通用核心

- `packages/api/src/services/ad-platform/registry.ts`：平台注册、能力声明和外部事件映射；不执行网络请求。
- `packages/api/src/services/ad-platform/adapter-types.ts`：Server、Verification、Quality Adapter 的接口与统一响应分类。
- `packages/api/src/services/ad-platform/credentials-crypto.ts`：根密钥解析、凭证加解密和连接数据密钥包裹。
- `packages/api/src/services/ad-platform/credentials.ts`：D1 凭证 CRUD、revision、指纹和脱敏状态。
- `packages/api/src/services/ad-platform/connection-keys.ts`：每连接数据密钥生成、解包和轮换。
- `packages/api/src/services/ad-platform/verifications.ts`：通用连接验证读写与失效。
- `packages/api/src/services/ad-platform/test-challenges.ts`：短期成对测试 challenge 的创建、消费和幂等。
- `packages/api/src/services/ad-platform/release-evidence.ts`：30 天人工去重证据的写入、查询与失效。
- `packages/api/src/services/ad-platform/rollout-control.ts`：target/effective、升级门禁和自动降级。
- `packages/api/src/services/ad-platform/incidents.ts`：通用 incident 创建、关闭与 critical 保护。
- `packages/api/src/services/ad-platform/quality.ts`：通用质量快照读写与 Adapter 调度。
- `packages/api/src/services/ad-platform/adapters/meta.ts`：Meta Graph API、`fbp/fbc`、Dataset Quality 和 Meta 响应分类。
- `packages/api/src/services/ad-platform/adapters/tiktok.ts`：TikTok Events API、`_ttp/ttclid`、header 和 TikTok 响应分类。
- `packages/api/src/services/ad-platform/secure-outbox.ts`：使用连接数据密钥和 v3 AAD 加密临时上下文。
- `packages/api/src/services/conversions.ts`：只做事实、来源、通用 delivery planning；不得构造平台 payload。
- `packages/api/src/routes/admin/ad-platforms.ts`：统一连接、凭证、验证、挑战、证据和 rollout Owner API。
- `packages/api/src/routes/admin/attribution.ts`：按 provider 返回通用 readiness、incident 和 quality。
- `packages/api/src/index.ts`：通用根密钥 binding、Queue consumer 和通用 cron 调度。

### 数据库

- `packages/api/migrations/0051_ad_platform_control_plane_expand.sql`：新增通用控制面、凭证库、连接密钥和非敏感 backfill，保留旧 Worker 可运行结构。
- `packages/api/migrations/0051_ad_platform_control_plane_expand.test.mjs`：历史库、空库、backfill、约束和旧 Worker 兼容测试。
- `packages/api/migrations/0052_ad_platform_control_plane_contract.sql`：删除旧表、桥接 trigger、旧连接列和旧用户标识列，建立最终 schema。
- `packages/api/migrations/0052_ad_platform_control_plane_contract.test.mjs`：从 `0001` 到 contract 的最终 schema、无桥接和 provider 约束测试。

### Web

- `packages/web/app/composables/useTracking.ts`：Contact 业务口径和通用 Browser 指令执行。
- `packages/web/app/components/ContactPanel.vue`：外链激活创建 Contact；copy/QR/panel 只写 analytics。
- `packages/web/app/utils/attributionPlatforms.ts`：消费后端能力注册结果，不硬编码 Meta 专属页面能力。
- `packages/web/app/components/admin/attribution/AttributionPlatformConnectionEditor.vue`：目标 ID、Token 状态、Browser/Server 和 mode 的单连接编辑器。
- `packages/web/app/components/admin/attribution/AttributionVerificationPanel.vue`：成对测试、Browser attempted、Server accepted 和人工确认。
- `packages/web/app/components/admin/attribution/AttributionRolloutControl.vue`：通用 target/effective 和相邻升级按钮。
- `packages/web/app/components/admin/attribution/AttributionIncidentList.vue`：按 provider 隔离的 incident。
- `packages/web/app/components/admin/attribution/AttributionQualityPanel.vue`：平台质量能力和“未接入”状态。
- `packages/web/app/pages/admin/attribution/platforms.vue`：通用平台接入编排。
- `packages/web/app/pages/admin/attribution/readiness.vue`：通用发布与诊断编排。

### 发布与文档

- `scripts/verify-ad-platform-control-plane.mjs`：通用 production 资源、凭证状态、schema、连接和 rollout 只读检查。
- `scripts/verify-ad-platform-migration.mjs`：expand/contract 前置、outbox 排空和状态对账。
- `scripts/verify-meta-secret-leaks.mjs`：扩展为所有广告平台明文凭证和匹配字段扫描。
- `scripts/deploy.sh`、`scripts/verify-release.mjs`：从 Meta 专属门禁迁移到 provider-aware 通用门禁。
- `docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/AD_PLATFORM_ARCHITECTURE.md`、`docs/PROJECT_STATUS.md`：最终契约、生产步骤和清理结果。

---

## Milestone 1：通用基础与凭证库（行为不变）

### Task 1：收紧 Contact 业务口径

**Files:**
- Modify: `packages/web/app/components/ContactPanel.vue`
- Modify: `packages/web/app/components/ContactPanel.test.ts`
- Modify: `packages/web/app/composables/useTracking.ts`
- Modify: `packages/web/app/composables/useTracking.test.ts`
- Modify: `docs/TECHNICAL_SPEC.md`

**Interfaces:**
- Consumes: `ContactMethodItem` 发出的 `open_link | copy` 激活动作。
- Produces: `trackContact(input: { methodType: string; actionTarget: string; actionType: 'open_link' })`；copy 统一写 `contact_copy` analytics。

- [ ] **Step 1: 写失败测试，证明 copy 不创建广告转化**

```ts
it('复制联系方式只写一方分析，不创建 Contact', async () => {
  const { wrapper, trackContact, trackAnalytics } = await mountPanel()
  wrapper.findComponent(ContactMethodItemStub).vm.$emit('activate', 'telegram', 'copy')
  await flushPromises()
  expect(trackContact).not.toHaveBeenCalled()
  expect(trackAnalytics).toHaveBeenCalledWith('contact_copy', {
    method_type: 'telegram',
    action_type: 'copy',
  })
})
```

- [ ] **Step 2: 运行测试并确认当前实现失败**

Run: `corepack pnpm --filter @meigallery/web test:unit -- app/components/ContactPanel.test.ts app/composables/useTracking.test.ts`

Expected: FAIL，copy 路径仍调用 `trackContact` 或类型仍接受 `copy`。

- [ ] **Step 3: 最小化修改 ContactPanel 与类型**

```ts
export interface TrackContactInput {
  methodType: string
  actionTarget: string
  actionType: 'open_link'
}

function trackContactMethod(methodType: string, actionType: 'open_link' | 'copy') {
  if (actionType === 'copy') {
    trackAnalytics('contact_copy', { method_type: methodType, action_type: actionType })
    return
  }
  void Promise.resolve(trackContact({
    methodType,
    actionTarget: methodType,
    actionType: 'open_link',
  })).catch(() => undefined)
}
```

- [ ] **Step 4: 更新所有 copy 测试和技术口径并运行回归**

Run: `corepack pnpm --filter @meigallery/web test:unit -- app/components/ContactMethodItem.test.ts app/components/ContactPanel.test.ts app/composables/useTracking.test.ts`

Expected: PASS；`rg -n "actionType: 'copy'" packages/web/app` 只命中 analytics 测试或 `ContactMethodItem` 事件，不命中 `trackContact` 输入。

- [ ] **Step 5: 提交**

```bash
git add packages/web/app/components/ContactPanel.vue packages/web/app/components/ContactPanel.test.ts packages/web/app/composables/useTracking.ts packages/web/app/composables/useTracking.test.ts docs/TECHNICAL_SPEC.md
git commit -m "fix: 收紧有效联系转化口径"
```

### Task 2：建立通用能力注册表和 Adapter 契约

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/constants/index.ts`
- Create: `packages/api/src/services/ad-platform/adapter-types.ts`
- Modify: `packages/api/src/services/ad-platform/registry.ts`
- Modify: `packages/api/src/services/ad-platform/registry.test.ts`
- Modify: `packages/web/app/utils/attributionPlatforms.ts`
- Modify: `packages/web/app/utils/attributionReadiness.test.ts`

**Interfaces:**
- Consumes: `ActiveConversionActionType`、`AdPlatformProvider`。
- Produces: `AdPlatformCapabilities`、`AdPlatformDefinition`、`AdPlatformServerAdapter`、`AdPlatformVerificationAdapter`、`AdPlatformQualityAdapter`、`getAdPlatformDefinition(provider)`。

- [ ] **Step 1: 写注册完整性失败测试**

```ts
it.each(['meta', 'tiktok'] as const)('%s 已启用能力均有 Adapter 标识', (provider) => {
  const definition = getAdPlatformDefinition(provider)
  expect(definition.capabilities.browser).toBe(true)
  expect(definition.capabilities.server).toBe(true)
  expect(definition.capabilities.testEvents).toBe(true)
  expect(definition.eventNames.contact).toBe('Contact')
  expect(definition.eventNames.complete_registration).toBe('CompleteRegistration')
})

it('Google 未注册时 fail closed', () => {
  expect(() => getAdPlatformDefinition('google')).toThrow('AD_PLATFORM_ADAPTER_NOT_REGISTERED:google')
})
```

- [ ] **Step 2: 运行并确认能力字段尚不存在**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/registry.test.ts`

Expected: FAIL，`capabilities` 或 `getAdPlatformDefinition` 未定义。

- [ ] **Step 3: 写入精确通用类型与注册项**

```ts
export interface AdPlatformCapabilities {
  browser: boolean
  server: boolean
  pairedDeduplication: boolean
  testEvents: boolean
  managedRollout: boolean
  incidents: boolean
  platformQuality: boolean
}

export interface AdPlatformDefinition {
  provider: AdAttributionProvider
  credentialTypes: readonly ['access_token']
  eventNames: Readonly<Record<ActiveConversionActionType, AdPlatformConversionEventName>>
  capabilities: AdPlatformCapabilities
  protocolVersion: string
}
```

```ts
export interface AdPlatformDeliveryResult {
  outcome: 'success' | 'retryable_failure' | 'permanent_failure' | 'credential_failure' | 'protocol_failure'
  acceptedCount: number
  retryAfterSeconds?: number
  diagnosticCode: string
}

export interface AdPlatformServerEventInput {
  provider: AdAttributionProvider
  destinationId: string
  credential: string
  eventName: AdPlatformConversionEventName
  eventId: string
  eventTime: number
  pageUrl: string
  testEventCode?: string
  user: AdPlatformSensitiveContext
}

export interface AdPlatformServerAdapter {
  provider: AdAttributionProvider
  buildRequest(input: AdPlatformServerEventInput): { url: string; init: RequestInit }
  classifyResponse(response: Response, body: unknown): AdPlatformDeliveryResult
}
```

- [ ] **Step 4: 让 Web 平台定义消费共享能力而非专属布尔值**

`attributionPlatformDefinition()` 保留 UI label、颜色和目标 ID 校验，`supportsManagedRollout`、`supportsIncidents`、`supportsPlatformQuality` 改由 API 返回的 `capabilities` 控制；Meta/TikTok 标签不得改变。

- [ ] **Step 5: 运行 API/Web 聚焦测试**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/registry.test.ts && corepack pnpm --filter @meigallery/web test:unit -- app/utils/attributionReadiness.test.ts`

Expected: PASS；未注册 provider 和未声明事件映射均 fail closed。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types/index.ts packages/shared/src/constants/index.ts packages/api/src/services/ad-platform/adapter-types.ts packages/api/src/services/ad-platform/registry.ts packages/api/src/services/ad-platform/registry.test.ts packages/web/app/utils/attributionPlatforms.ts packages/web/app/utils/attributionReadiness.test.ts
git commit -m "refactor: 建立广告平台能力注册表"
```

### Task 3：新增通用控制面 expand migration

**Files:**
- Create: `packages/api/migrations/0051_ad_platform_control_plane_expand.sql`
- Create: `packages/api/migrations/0051_ad_platform_control_plane_expand.test.mjs`
- Modify: `scripts/verify-meta-migration.mjs`
- Modify: `scripts/verify-meta-migration.test.mjs`

**Interfaces:**
- Consumes: `0049` 的 `ad_platform_secure_outbox`、旧 Meta/TikTok verification、Meta rollout/incident/quality。
- Produces: 七张通用控制表、凭证表、连接密钥表和 expand 阶段双读可对账数据；旧表仍保留。

- [ ] **Step 1: 写 migration 失败测试**

测试必须断言：从 `0001` 升到 `0051` 成功；Meta verification/revision、target/effective `10`、open incident、Dataset Quality 摘要被准确 backfill；TikTok 默认 `0`；provider/revision CHECK 生效；旧表和 `trg_0049_bridge_*` 仍存在。

Run: `node --test packages/api/migrations/0051_ad_platform_control_plane_expand.test.mjs`

Expected: FAIL，`0051` 文件和通用表不存在。

- [ ] **Step 2: 创建最终命名的通用表**

```sql
ALTER TABLE ad_platform_connections ADD COLUMN rollout_target_percentage INTEGER NOT NULL DEFAULT 0 CHECK (rollout_target_percentage IN (0,10,50,100));
ALTER TABLE ad_platform_connections ADD COLUMN connection_revision TEXT;
ALTER TABLE ad_platform_connections ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0 CHECK (credential_revision >= 0);

CREATE TABLE ad_platform_credentials (
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  credential_revision INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, credential_type),
  CHECK (provider IN ('meta','tiktok')),
  CHECK (credential_type = 'access_token'),
  CHECK (credential_revision > 0)
);

CREATE TABLE ad_platform_connection_keys (
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at TEXT,
  PRIMARY KEY (provider, connection_revision),
  CHECK (provider IN ('meta','tiktok'))
);

CREATE TABLE ad_platform_connection_verifications (
  provider TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  destination_identity TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  verified_event_scope TEXT NOT NULL,
  verified_by INTEGER NOT NULL REFERENCES users(id),
  verified_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, environment),
  UNIQUE (provider, connection_revision),
  CHECK (provider IN ('meta','tiktok')),
  CHECK (environment = 'production')
);

CREATE TABLE ad_platform_test_challenges (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  event_scope_digest TEXT NOT NULL,
  browser_attempted_count INTEGER NOT NULL DEFAULT 0,
  server_accepted_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (provider IN ('meta','tiktok')),
  CHECK (browser_attempted_count BETWEEN 0 AND 2),
  CHECK (server_accepted_count BETWEEN 0 AND 2)
);

CREATE INDEX idx_ad_platform_challenges_revision
  ON ad_platform_test_challenges(provider, connection_revision, expires_at);

CREATE TABLE ad_platform_release_evidence (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES ad_platform_test_challenges(id),
  event_scope_digest TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL,
  confirmed_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT NOT NULL DEFAULT '',
  CHECK (provider IN ('meta','tiktok'))
);

CREATE INDEX idx_ad_platform_evidence_revision
  ON ad_platform_release_evidence(provider, connection_revision, expires_at);

CREATE TABLE ad_platform_rollout_states (
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  target_percentage INTEGER NOT NULL DEFAULT 0,
  effective_percentage INTEGER NOT NULL DEFAULT 0,
  effective_since TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, connection_revision),
  CHECK (provider IN ('meta','tiktok')),
  CHECK (target_percentage IN (0,10,50,100)),
  CHECK (effective_percentage IN (0,10,50,100))
);

CREATE TABLE ad_platform_incidents (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  severity TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  diagnostic_summary TEXT NOT NULL DEFAULT '{}',
  CHECK (provider IN ('meta','tiktok')),
  CHECK (severity IN ('warning','critical')),
  CHECK (status IN ('open','resolved'))
);

CREATE UNIQUE INDEX idx_ad_platform_incident_open
  ON ad_platform_incidents(provider, connection_revision, trigger_code)
  WHERE status = 'open';

CREATE TABLE ad_platform_quality_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  contract_digest TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK (provider IN ('meta','tiktok')),
  CHECK (json_valid(metrics_json))
);

CREATE INDEX idx_ad_platform_quality_revision
  ON ad_platform_quality_snapshots(provider, connection_revision, collected_at DESC);
```

所有通用状态查询必须同时限定 `provider, connection_revision`；challenge `expires_at` 和 `consumed_at` 分离，evidence 同时保存 `confirmed_at` 与 `expires_at`。

- [ ] **Step 3: 写非敏感 backfill 和幂等约束**

```sql
UPDATE ad_platform_connections
SET rollout_target_percentage = rollout_percentage,
    connection_revision = revision;

INSERT INTO ad_platform_rollout_states (
  provider, connection_revision, target_percentage, effective_percentage, updated_at
)
SELECT 'meta', COALESCE(revision, ''), rollout_percentage,
       CASE WHEN EXISTS (SELECT 1 FROM meta_capi_incidents WHERE status = 'open' AND severity = 'critical') THEN 0 ELSE rollout_percentage END,
       datetime('now')
FROM ad_platform_connections
WHERE provider = 'meta' AND revision IS NOT NULL;
```

Backfill 不复制 Token、Test Event Code、完整 event ID 或匹配字段；相同历史行重跑测试 fixture 时不得产生重复逻辑记录。

- [ ] **Step 4: 运行 migration 与全历史演练**

Run: `node --test packages/api/migrations/0051_ad_platform_control_plane_expand.test.mjs scripts/verify-meta-migration.test.mjs`

Expected: PASS；空库与历史库均建立 `0051` schema，旧 Worker 查询仍通过。

- [ ] **Step 5: 提交**

```bash
git add packages/api/migrations/0051_ad_platform_control_plane_expand.sql packages/api/migrations/0051_ad_platform_control_plane_expand.test.mjs scripts/verify-meta-migration.mjs scripts/verify-meta-migration.test.mjs
git commit -m "feat: 扩展通用广告归因控制面"
```

### Task 4：实现通用加密凭证库和连接数据密钥

**Files:**
- Create: `packages/api/src/services/ad-platform/credentials-crypto.ts`
- Create: `packages/api/src/services/ad-platform/credentials-crypto.test.ts`
- Create: `packages/api/src/services/ad-platform/credentials.ts`
- Create: `packages/api/src/services/ad-platform/credentials.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/connection-keys.ts`
- Create: `packages/api/src/services/ad-platform/connection-keys.d1.test.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**
- Consumes: `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT/PREVIOUS`，每项为 32-byte base64url key。
- Produces: `setCredential()`、`readCredential()`、`deleteCredential()`、`credentialStatus()`、`ensureConnectionDataKey()`、`unwrapConnectionDataKey()`。

- [ ] **Step 1: 写加密和 D1 失败测试**

```ts
it('凭证不能跨 provider 或 revision 解密', async () => {
  const encrypted = await encryptCredential(keys, {
    provider: 'meta', credentialType: 'access_token', credentialRevision: 1, plaintext: 'secret-token',
  })
  await expect(decryptCredential(keys, {
    provider: 'tiktok', credentialType: 'access_token', credentialRevision: 1, encrypted,
  })).rejects.toThrow('AD_PLATFORM_CREDENTIAL_AUTHENTICATION_FAILED')
})
```

覆盖：篡改 ciphertext/tag、未知 key ID、previous key 解密、current key 写入、同连接重复读取不轮换数据密钥、revision 改变生成新密钥。

- [ ] **Step 2: 运行并确认模块不存在**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/credentials-crypto.test.ts src/services/ad-platform/credentials.d1.test.ts src/services/ad-platform/connection-keys.d1.test.ts`

Expected: FAIL，导入模块不存在。

- [ ] **Step 3: 实现固定 AAD 和根密钥轮换**

```ts
export type CredentialIdentity = {
  provider: AdAttributionProvider
  credentialType: 'access_token'
  credentialRevision: number
}

function credentialAad(input: CredentialIdentity) {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, ...input }))
}

export async function encryptCredential(
  keys: MasterKeySet,
  input: CredentialIdentity & { plaintext: string },
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: credentialAad(input), tagLength: 128 },
    keys.current.cryptoKey,
    new TextEncoder().encode(input.plaintext),
  )
  return splitCiphertextAndTag(keys.current.id, iv, new Uint8Array(encrypted))
}
```

- [ ] **Step 4: 实现 D1 原子写入和无明文状态**

```ts
export async function setCredential(env: CredentialEnv, input: {
  provider: AdAttributionProvider
  credentialType: 'access_token'
  plaintext: string
  ownerUserId: number
}): Promise<{ credentialRevision: number; fingerprintPrefix: string; updatedAt: string }>
```

同一事务/CAS 中计算 `credential_revision + 1`、写密文、更新连接 `credential_revision`、使旧 verification/evidence 失效、将 target/effective 归零并写脱敏审计。返回值只允许 12 位指纹前缀。

- [ ] **Step 5: 添加 Bindings 并验证 previous 引用归零能力**

`Bindings` 删除动作留到 contract；本任务只新增：

```ts
AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
```

并提供 `countEncryptedValuesByKeyId(db, keyId)`，仅当结果为 `0` 时才允许运维删除 previous secret。

- [ ] **Step 6: 运行聚焦测试并提交**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/credentials-crypto.test.ts src/services/ad-platform/credentials.d1.test.ts src/services/ad-platform/connection-keys.d1.test.ts`

Expected: PASS，测试输出和 snapshot 不包含 `secret-token`。

```bash
git add packages/api/src/services/ad-platform/credentials-crypto.ts packages/api/src/services/ad-platform/credentials-crypto.test.ts packages/api/src/services/ad-platform/credentials.ts packages/api/src/services/ad-platform/credentials.d1.test.ts packages/api/src/services/ad-platform/connection-keys.ts packages/api/src/services/ad-platform/connection-keys.d1.test.ts packages/api/src/index.ts
git commit -m "feat: 新增广告平台加密凭证库"
```

### Task 5：提供统一连接与凭证 Owner API

**Files:**
- Modify: `packages/api/src/routes/admin/ad-platforms.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/api/src/services/ad-platform/connections.ts`
- Modify: `packages/api/src/services/ad-platform/status.ts`
- Modify: `packages/api/src/services/ad-platform/status.test.ts`
- Create: `packages/api/src/middleware/admin-origin.ts`
- Create: `packages/api/src/middleware/admin-origin.test.ts`

**Interfaces:**
- Consumes: Task 4 凭证服务和 Task 2 capability registry。
- Produces: `GET/PATCH /api/admin/attribution/platforms/:provider`、`PUT/DELETE /:provider/credentials/access_token`。

- [ ] **Step 1: 写 API 安全失败测试**

覆盖：非 Owner `403`、非 production `409`、非法 Origin/CSRF `403`、超过 8 KiB `413`、Token 不回显、更新 Token 使 revision 递增且 rollout 归零、重复提交相同 Token 仍视为显式轮换并产生新 revision。

- [ ] **Step 2: 运行并确认凭证路由为 404**

Run: `corepack pnpm --filter @meigallery/api test -- src/routes/admin/attribution.test.ts src/services/ad-platform/status.test.ts`

Expected: FAIL，凭证路由不存在或状态仍读取 Worker Secret。

- [ ] **Step 3: 把连接状态改为通用返回结构**

```ts
export interface AdPlatformConnectionStatus {
  provider: AdAttributionProvider
  capabilities: AdPlatformCapabilities
  enabled: boolean
  mode: AdPlatformTrackingMode
  browserEnabled: boolean
  serverEnabled: boolean
  destinationId: string
  rolloutTargetPercentage: AdPlatformRolloutPercentage
  rolloutEffectivePercentage: AdPlatformRolloutPercentage
  connectionRevision: string | null
  credential: { configured: boolean; revision: number; fingerprintPrefix: string; updatedAt: string }
  verification: { state: 'not_configured' | 'unverified' | 'verified' | 'invalidated'; verifiedAt: string }
  resources: { queue: boolean; connectionKey: boolean }
}
```

- [ ] **Step 4: 实现生产 Owner 同源和请求体保护 middleware**

```ts
export const ownerProductionOriginGuard: MiddlewareHandler<{
  Bindings: Bindings
  Variables: Variables
}> = async (c, next) => {
  if (c.get('userRole') !== 'owner') return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
  if (c.env.APP_ENV !== 'production') {
    return errorJson(c, 409, '广告平台连接只允许在生产环境配置', { code: 'AD_PLATFORM_PRODUCTION_ONLY' })
  }
  const contentLength = Number(c.req.header('content-length') || '0')
  if (!Number.isFinite(contentLength) || contentLength > 8192) {
    return errorJson(c, 413, '请求体过大', { code: 'REQUEST_BODY_TOO_LARGE' })
  }
  const origin = c.req.header('origin') || ''
  let allowed = ''
  try {
    allowed = new URL(c.env.SITE_URL || '').origin
  }
  catch {
    return errorJson(c, 503, '生产站点地址未配置', { code: 'ADMIN_ORIGIN_NOT_CONFIGURED' })
  }
  if (origin !== allowed) return errorJson(c, 403, '请求来源无效', { code: 'ADMIN_ORIGIN_INVALID' })
  await next()
}
```

测试必须覆盖缺失 Origin、伪造 Origin、无效 `SITE_URL`、超限 `Content-Length` 和合法 Owner production 请求。

- [ ] **Step 5: 实现凭证路由，不接受 JSON 回显**

```ts
adminAdPlatformRoutes.put('/:provider/credentials/access_token', ownerProductionOriginGuard, async (c) => {
  const provider = requireRegisteredProvider(c.req.param('provider'))
  const body = await c.req.json<{ value?: unknown }>()
  const value = typeof body.value === 'string' ? body.value : ''
  if (!value || value.length > 4096 || value.trim() !== value) {
    return errorJson(c, 400, '访问令牌无效', { code: 'AD_PLATFORM_CREDENTIAL_INVALID' })
  }
  return c.json({ data: await setCredential(c.env, {
    provider, credentialType: 'access_token', plaintext: value, ownerUserId: c.get('userId')!,
  }) })
})
```

错误映射只返回稳定 code，不返回平台 body、Token、密文、IV、tag 或完整指纹。

- [ ] **Step 6: 运行路由/状态测试并提交**

Run: `corepack pnpm --filter @meigallery/api test -- src/middleware/admin-origin.test.ts src/routes/admin/attribution.test.ts src/services/ad-platform/status.test.ts`

Expected: PASS；`JSON.stringify(response)` 不包含测试 Token。

```bash
git add packages/api/src/routes/admin/ad-platforms.ts packages/api/src/routes/admin/attribution.test.ts packages/api/src/services/ad-platform/connections.ts packages/api/src/services/ad-platform/status.ts packages/api/src/services/ad-platform/status.test.ts packages/api/src/middleware/admin-origin.ts packages/api/src/middleware/admin-origin.test.ts
git commit -m "feat: 统一广告平台连接与凭证接口"
```

---

## Milestone 2：通用控制面与 Meta 迁移

### Task 6：实现通用连接验证、成对 challenge 与人工证据

**Files:**
- Create: `packages/api/src/services/ad-platform/verifications.ts`
- Create: `packages/api/src/services/ad-platform/verifications.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/test-challenges.ts`
- Create: `packages/api/src/services/ad-platform/test-challenges.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/release-evidence.ts`
- Create: `packages/api/src/services/ad-platform/release-evidence.d1.test.ts`
- Modify: `packages/api/src/routes/admin/ad-platforms.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`

**Interfaces:**
- Consumes: 当前连接、凭证 fingerprint、protocolVersion、`Contact` 和 `CompleteRegistration` Adapter 映射。
- Produces: `startTestChallenge()`、`consumeTestChallenge()`、`confirmReleaseEvidence()`、`readCurrentVerification()`、`readValidReleaseEvidence()`。

- [ ] **Step 1: 写状态机失败测试**

测试固定时钟，覆盖 10 分钟 challenge 过期、单次消费、重复确认幂等、跨 provider/revision 拒绝、两事件缺一不可、Browser 只能记录 attempted、Server 必须 `acceptedCount === 1`、Test Event Code 不落库。

- [ ] **Step 2: 运行并确认模块不存在**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/verifications.d1.test.ts src/services/ad-platform/test-challenges.d1.test.ts src/services/ad-platform/release-evidence.d1.test.ts`

Expected: FAIL，通用状态机模块不存在。

- [ ] **Step 3: 实现 challenge 契约**

```ts
export interface PairedTestChallenge {
  id: string
  provider: AdAttributionProvider
  connectionRevision: string
  expiresAt: string
  browser: Array<{ eventName: AdPlatformConversionEventName; eventId: string; attempted: boolean }>
  server: Array<{ eventName: AdPlatformConversionEventName; eventId: string; accepted: boolean }>
}

export async function startTestChallenge(env: ControlPlaneEnv, input: {
  provider: AdAttributionProvider
  ownerUserId: number
  testEventCode: string
  now?: Date
}): Promise<PairedTestChallenge>
```

`testEventCode` 在调用 Verification Adapter 后立即离开作用域；D1 只保存 challenge ID、事件摘要、脱敏 event ID digest、attempted/accepted 和时间。

- [ ] **Step 4: 实现 30 天 evidence 幂等确认**

```ts
export async function confirmReleaseEvidence(env: ControlPlaneEnv, input: {
  provider: AdAttributionProvider
  challengeId: string
  ownerUserId: number
  confirmed: true
  now?: Date
}): Promise<{ id: string; idempotent: boolean; expiresAt: string }>
```

必须原子检查 challenge 当前 revision、已消费、两事件 Browser attempted/Server accepted、未过期；同一 challenge 第二次确认返回原 evidence 且 `idempotent: true`。

- [ ] **Step 5: 暴露通用 API**

- `POST /api/admin/attribution/platforms/:provider/test-challenges`
- `POST /api/admin/attribution/platforms/:provider/test-challenges/:id/browser-receipts`
- `POST /api/admin/attribution/platforms/:provider/test-challenges/:id/consume`
- `POST /api/admin/attribution/platforms/:provider/release-evidence`

所有 mutation 都需要 Owner、production、同源校验和脱敏审计。

- [ ] **Step 6: 运行测试并提交**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/verifications.d1.test.ts src/services/ad-platform/test-challenges.d1.test.ts src/services/ad-platform/release-evidence.d1.test.ts src/routes/admin/attribution.test.ts`

Expected: PASS，重复点击不会轮换 connection revision 或新增 evidence。

```bash
git add packages/api/src/services/ad-platform/verifications.ts packages/api/src/services/ad-platform/verifications.d1.test.ts packages/api/src/services/ad-platform/test-challenges.ts packages/api/src/services/ad-platform/test-challenges.d1.test.ts packages/api/src/services/ad-platform/release-evidence.ts packages/api/src/services/ad-platform/release-evidence.d1.test.ts packages/api/src/routes/admin/ad-platforms.ts packages/api/src/routes/admin/attribution.test.ts
git commit -m "feat: 统一广告平台测试与发布证据"
```

### Task 7：实现通用 rollout、incident 与质量快照

**Files:**
- Create: `packages/api/src/services/ad-platform/rollout-control.ts`
- Create: `packages/api/src/services/ad-platform/rollout-control.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/incidents.ts`
- Create: `packages/api/src/services/ad-platform/incidents.d1.test.ts`
- Create: `packages/api/src/services/ad-platform/quality.ts`
- Create: `packages/api/src/services/ad-platform/quality.d1.test.ts`
- Modify: `packages/api/src/services/ad-platform/rollout.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution-rollout.d1.test.ts`

**Interfaces:**
- Consumes: verification/evidence、delivery 指标、Queue backlog、Adapter quality metrics。
- Produces: `evaluateRolloutChange()`、`setRolloutTarget()`、`effectiveRollout()`、`openIncident()`、`closeIncident()`、`collectPlatformQuality()`。

- [ ] **Step 1: 写完整门禁表测试**

```ts
it.each([
  [0, 10, true], [10, 50, true], [50, 100, true],
  [0, 50, false], [10, 100, false],
] as const)('%i -> %i 相邻规则为 %s', (from, to, allowed) => {
  expect(evaluateRolloutChange(healthyFixture({ from, to })).allowed).toBe(allowed)
})
```

额外覆盖：`0->10` 两事件 accepted；`10->50` 有效人工证据+真实 Contact+无跨平台/凭证/重试错误；`50->100` 稳定 24h、Server >=20、最终成功率 >=99%、无 backlog/critical；证据过期 effective cap 10；credential failure 和 critical incident effective 0。

- [ ] **Step 2: 运行并确认通用服务不存在**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/rollout-control.d1.test.ts src/services/ad-platform/incidents.d1.test.ts src/services/ad-platform/quality.d1.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现统一门禁结果**

```ts
export interface RolloutGateResult {
  provider: AdAttributionProvider
  from: AdPlatformRolloutPercentage
  to: AdPlatformRolloutPercentage
  allowed: boolean
  blockers: Array<{
    code: string
    severity: 'blocker' | 'warning'
    message: string
  }>
}
```

warning 不得改变 `allowed`；blocker 才阻断升级。任何降级请求立即允许，且审计保留原 target/effective。

- [ ] **Step 4: 实现 incident 和质量调度**

`openIncident()` 唯一键为 `provider + connection_revision + trigger_code + status=open`；重复触发更新 `last_seen_at/count`。`collectPlatformQuality()` 仅在 capability 为 true 时调用 Adapter；否则返回 `{ supported: false, metrics: [] }`，不能伪装零问题。

- [ ] **Step 5: 运行聚焦与现有 Meta rollout 回归**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/rollout-control.d1.test.ts src/services/ad-platform/incidents.d1.test.ts src/services/ad-platform/quality.d1.test.ts src/services/meta-capi-rollout.test.ts src/routes/admin/attribution-rollout.d1.test.ts`

Expected: PASS；Meta fixture 的 target/effective 仍为 `10/10`。

- [ ] **Step 6: 提交**

```bash
git add packages/api/src/services/ad-platform/rollout-control.ts packages/api/src/services/ad-platform/rollout-control.d1.test.ts packages/api/src/services/ad-platform/incidents.ts packages/api/src/services/ad-platform/incidents.d1.test.ts packages/api/src/services/ad-platform/quality.ts packages/api/src/services/ad-platform/quality.d1.test.ts packages/api/src/services/ad-platform/rollout.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution-rollout.d1.test.ts
git commit -m "feat: 统一广告平台放量与故障保护"
```

### Task 8：将 Meta 协议迁入 Adapter 和通用 outbox v3

**Files:**
- Create: `packages/api/src/services/ad-platform/adapters/meta.ts`
- Create: `packages/api/src/services/ad-platform/adapters/meta.test.ts`
- Create: `packages/api/src/services/ad-platform/queue-consumer.ts`
- Create: `packages/api/src/services/ad-platform/queue-consumer.d1.test.ts`
- Modify: `packages/api/src/services/ad-platform/secure-outbox.ts`
- Modify: `packages/api/src/services/ad-platform/secure-outbox.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/services/meta-capi.ts`
- Modify: `packages/api/src/services/meta-capi-queue.ts`
- Modify: `packages/api/src/services/meta-dataset-quality.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**
- Consumes: Task 2 Adapter 类型、Task 4 credential/connection key、Task 6/7 控制面。
- Produces: `metaServerAdapter`、`metaVerificationAdapter`、`metaQualityAdapter`；通用运行时不再读取 Meta Worker token/data key。

- [ ] **Step 1: 写 Meta 契约与跨 revision 解密失败测试**

覆盖 Bearer header、Graph API `events_received=1` 严格成功、429/5xx 可重试、401/403 credential failure、其他 4xx permanent、`fbp/fbc` 清洗、production payload 不含 test code、v3 AAD 跨 provider/revision/delivery/event 均失败。

- [ ] **Step 2: 运行并确认 Adapter 尚未实现**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/adapters/meta.test.ts src/services/ad-platform/secure-outbox.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 Meta Adapter 分类**

```ts
export const metaServerAdapter: AdPlatformServerAdapter = {
  provider: 'meta',
  buildRequest(input) {
    return {
      url: `https://graph.facebook.com/v25.0/${encodeURIComponent(input.destinationId)}/events`,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMetaPayload(input)),
      },
    }
  },
  classifyResponse(response, body) {
    if (response.ok && isRecord(body) && body.events_received === 1) return successResult(1)
    if (response.status === 401 || response.status === 403) return credentialFailure('meta_credential_rejected')
    if (response.status === 429 || response.status >= 500) return retryableFailure('meta_retryable')
    return permanentFailure('meta_rejected')
  },
}
```

- [ ] **Step 4: 升级 secure outbox AAD**

```ts
export interface AdPlatformOutboxAad {
  provider: AdAttributionProvider
  connectionRevision: string
  deliveryId: string
  eventId: string
}
```

新 envelope `schemaVersion: 3`，加解密 key 来自 `unwrapConnectionDataKey()`；Task 12 切换前必须证明 schema v2 pending/retrying 为 0。

- [ ] **Step 5: conversions 和 Queue 只调用通用 planner/consumer**

删除 `planMetaDeliveries()` 内的平台 payload/secret 读取，保留 provider 严格来源和 delivery 创建。新增 `handleAdPlatformQueueBatch(env, provider, batch)`，固定读取通用连接、凭证、outbox v3 和平台注册 Adapter；`index.ts` 只根据 Queue 名确定 provider，不导入平台业务服务。Meta 文件可在 expand 窗口保留薄包装导出，但不得保存第二套状态或 fallback。

- [ ] **Step 6: 运行 Meta 全链聚焦测试并提交**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/adapters/meta.test.ts src/services/ad-platform/queue-consumer.d1.test.ts src/services/ad-platform/secure-outbox.test.ts src/services/conversions.test.ts src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/services/meta-dataset-quality.test.ts`

Expected: PASS；Browser/Server event ID 一致，测试日志无 Token、匹配原文和 Test Event Code。

```bash
git add packages/api/src/services/ad-platform/adapters/meta.ts packages/api/src/services/ad-platform/adapters/meta.test.ts packages/api/src/services/ad-platform/queue-consumer.ts packages/api/src/services/ad-platform/queue-consumer.d1.test.ts packages/api/src/services/ad-platform/secure-outbox.ts packages/api/src/services/ad-platform/secure-outbox.test.ts packages/api/src/services/conversions.ts packages/api/src/services/conversions.test.ts packages/api/src/services/meta-capi.ts packages/api/src/services/meta-capi-queue.ts packages/api/src/services/meta-dataset-quality.ts packages/api/src/index.ts
git commit -m "refactor: 迁移Meta至通用归因运行时"
```

### Task 9：将后台平台接入与发布诊断彻底通用化

**Files:**
- Create: `packages/web/app/components/admin/attribution/AttributionVerificationPanel.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionVerificationPanel.test.ts`
- Create: `packages/web/app/components/admin/attribution/AttributionRolloutControl.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionRolloutControl.test.ts`
- Create: `packages/web/app/components/admin/attribution/AttributionIncidentList.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionQualityPanel.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionPlatformConnectionEditor.vue`
- Modify: `packages/web/app/pages/admin/attribution/platforms.vue`
- Modify: `packages/web/app/pages/admin/attribution/platforms.test.ts`
- Modify: `packages/web/app/pages/admin/attribution/readiness.vue`
- Modify: `packages/web/app/pages/admin/attribution/readiness.test.ts`
- Modify: `packages/web/app/composables/useAdminAttribution.ts`

**Interfaces:**
- Consumes: Tasks 5-7 的通用状态/API。
- Produces: Meta/TikTok 共用的平台接入和发布诊断 UI；Token 输入成功/失败后立即清空。

- [ ] **Step 1: 写通用 UI 失败测试**

覆盖：切换 provider 不串状态；Token 不回显且 `autocomplete="new-password"`；Meta/TikTok 均显示同一成对测试组件；Browser 显示“已尝试”、Server 显示“API 已接收”；不支持 quality 时显示明确文案；warning 不计入 blocker；按钮按 capability 隐藏。

- [ ] **Step 2: 运行并确认仍依赖 Meta 专属组件**

Run: `corepack pnpm --filter @meigallery/web test:unit -- app/pages/admin/attribution/platforms.test.ts app/pages/admin/attribution/readiness.test.ts app/components/admin/attribution/AttributionVerificationPanel.test.ts app/components/admin/attribution/AttributionRolloutControl.test.ts`

Expected: FAIL，页面仍导入 `MetaConnectionStatus/MetaRolloutControl/MetaIncidentList`。

- [ ] **Step 3: 实现单连接编辑器的凭证区域**

```vue
<input
  v-model="credentialValue"
  type="password"
  autocomplete="new-password"
  maxlength="4096"
  aria-label="访问令牌"
>
```

保存连接与设置 Token 为两个明确命令；Token 请求完成的 `finally` 必须执行 `credentialValue = ''`。状态只显示“已配置”、更新时间和短指纹。

- [ ] **Step 4: 替换平台/诊断页专属分支**

页面只通过 `connection.capabilities` 组合通用组件；不得出现 `selectedProvider === 'meta'` 来决定验证、rollout 或 incident。平台 label、目标 ID 校验和质量 Adapter 文案可来自 registry。

- [ ] **Step 5: 运行单测和五视口 E2E**

Run: `corepack pnpm --filter @meigallery/web test:unit -- app/pages/admin/attribution/platforms.test.ts app/pages/admin/attribution/readiness.test.ts app/components/admin/attribution/AttributionVerificationPanel.test.ts app/components/admin/attribution/AttributionRolloutControl.test.ts`

Run: `corepack pnpm --filter @meigallery/web test:e2e -- tests/e2e/admin-attribution.spec.ts`

Expected: PASS；桌面/移动无重叠，敏感字段不出现在 DOM snapshot。

- [ ] **Step 6: 提交**

```bash
git add packages/web/app/components/admin/attribution packages/web/app/pages/admin/attribution/platforms.vue packages/web/app/pages/admin/attribution/platforms.test.ts packages/web/app/pages/admin/attribution/readiness.vue packages/web/app/pages/admin/attribution/readiness.test.ts packages/web/app/composables/useAdminAttribution.ts
git commit -m "refactor: 通用化归因平台管理界面"
```

### Task 10：将发布门禁和资源检查改为 provider-aware

**Files:**
- Create: `scripts/verify-ad-platform-control-plane.mjs`
- Create: `scripts/verify-ad-platform-control-plane.test.mjs`
- Create: `scripts/verify-ad-platform-migration.mjs`
- Create: `scripts/verify-ad-platform-migration.test.mjs`
- Create: `scripts/verify-ad-platform-secret-leaks.mjs`
- Create: `scripts/verify-ad-platform-secret-leaks.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/deploy.sh`
- Modify: `package.json`
- Modify: `packages/api/wrangler.toml`

**Interfaces:**
- Consumes: 通用 control plane 状态和两个 provider Queue。
- Produces: `verify-ad-platform-control-plane` JSON 报告、expand/contract 前置检查和快速失败的生产部署门禁。

- [ ] **Step 1: 写脚本失败测试**

断言：Meta 10/TikTok 0 状态正确才通过；任一 Queue 缺失、旧 outbox 非空、凭证未导入、schema 不匹配时在 D1 migration/Worker deploy 前退出；普通 commit 不使连接证据失效；报告不含 Token、密文、完整指纹或 Test Event Code。

- [ ] **Step 2: 运行并确认新脚本不存在**

Run: `node --test scripts/verify-ad-platform-control-plane.test.mjs scripts/verify-ad-platform-migration.test.mjs scripts/verify-ad-platform-secret-leaks.test.mjs scripts/verify-release.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 实现稳定 JSON 报告**

```js
{
  schemaVersion: 1,
  environment: 'production',
  providers: {
    meta: { connectionVerified: true, target: 10, effective: 10, criticalIncidents: 0 },
    tiktok: { enabled: false, target: 0, effective: 0, criticalIncidents: 0 }
  },
  queuesReady: true,
  schemaReady: true,
  outboxV2Pending: 0
}
```

脚本打印的仅是状态、计数、provider 和 revision digest；不得打印远端命令原始 secret 输出。

- [ ] **Step 4: 将 deploy.sh 门禁顺序固定为只读资源 -> quick -> migration preflight -> migration -> release -> deploy**

expand 发布允许旧表存在；contract 发布额外要求通用运行时已稳定 24 小时、旧 outbox 为 0、一次性 importer 已删除。任一步失败立即退出且不继续 deploy。

- [ ] **Step 5: 运行 scripts 全套并提交**

Run: `corepack pnpm test:scripts`

Expected: PASS；secret scan 同时识别 Meta/TikTok/通用根密钥的非法赋值，但允许 `env.KEY_NAME` 标识符引用。

```bash
git add scripts/verify-ad-platform-control-plane.mjs scripts/verify-ad-platform-control-plane.test.mjs scripts/verify-ad-platform-migration.mjs scripts/verify-ad-platform-migration.test.mjs scripts/verify-ad-platform-secret-leaks.mjs scripts/verify-ad-platform-secret-leaks.test.mjs scripts/verify-release.mjs scripts/verify-release.test.mjs scripts/deploy.sh package.json packages/api/wrangler.toml
git commit -m "refactor: 统一广告归因发布门禁"
```

### Task 11：执行 Meta expand、凭证导入和生产对账

**Files:**
- Create: `packages/api/src/routes/admin/ad-platform-credential-import.ts`
- Create: `packages/api/src/routes/admin/ad-platform-credential-import.test.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: production 旧 `META_CAPI_ACCESS_TOKEN`、`META_CAPI_DATA_KEY_CURRENT`，Task 4 凭证库。
- Produces: 一次性 Owner import 路由；Meta 通用凭证和 connection key；只读迁移报告。

- [ ] **Step 1: 写一次性导入失败测试**

覆盖：production+Owner+同源；仅 provider `meta`；已有相同 fingerprint 时幂等；旧 secret 缺失拒绝；通用凭证写入后不回显；TikTok 禁止通过旧 secret importer；审计仅记录 revision。

- [ ] **Step 2: 实现受限 importer**

```ts
adminCredentialImportRoutes.post('/meta', ownerProductionOriginGuard, async (c) => {
  const token = c.env.META_CAPI_ACCESS_TOKEN
  if (!token) return errorJson(c, 409, '旧 Meta 凭证不存在', { code: 'META_LEGACY_CREDENTIAL_MISSING' })
  const result = await importLegacyCredential(c.env, {
    provider: 'meta', credentialType: 'access_token', plaintext: token, ownerUserId: c.get('userId')!,
  })
  return c.json({ data: result })
})
```

路由只能存在于 expand release，Task 14 必须删除。

- [ ] **Step 3: 运行本地完整门禁**

Run: `corepack pnpm verify:quick && corepack pnpm verify:local-runtime && corepack pnpm verify:release`

Expected: PASS；fixture 中 Meta 保持 `10/10`，TikTok 保持 `0/0 disabled`。

- [ ] **Step 4: 提交并按 Git 流程发布 expand**

```bash
git add packages/api/src/routes/admin/ad-platform-credential-import.ts packages/api/src/routes/admin/ad-platform-credential-import.test.ts packages/api/src/routes/admin/index.ts docs/DEPLOYMENT.md docs/PROJECT_STATUS.md
git commit -m "feat: 提供Meta凭证一次性安全导入"
```

从 `dev` 创建 release 分支、PR 合入 `main`，在干净 `main` 执行 `./scripts/deploy.sh production`。部署前后分别保存 `verify-ad-platform-control-plane` 脱敏报告。

- [ ] **Step 5: 在 production 设置根密钥并执行一次 importer**

Run: `corepack pnpm --filter @meigallery/api exec wrangler secret put AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT --env=""`

Expected: Wrangler 确认 secret 已设置，不在终端历史中显示值。

Owner 调用 importer 后，只读确认 Meta credential configured、fingerprint 与旧连接一致、connection key 已创建、Meta target/effective 仍 `10/10`、TikTok `0/0`、旧 outbox v2 为 0。

### Task 12：切换通用 Meta 运行时并观察 24 小时

**Files:**
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/meta-capi-queue.ts`
- Modify: `packages/api/src/services/meta-dataset-quality.ts`
- Modify: `scripts/verify-ad-platform-control-plane.mjs`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: 通用凭证、connection key、verification/evidence/rollout/incident/quality。
- Produces: production Meta 所有新 delivery 只读写通用控制面和 outbox v3。

- [ ] **Step 1: 写“旧 secret 不参与运行时”失败测试**

测试 env 同时提供错误旧 Meta secret 和正确 D1 凭证，投递必须成功；删除 D1 凭证但保留旧 secret 必须 fail closed；不得 fallback。

- [ ] **Step 2: 运行并确认当前代码仍读取旧 binding**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/conversions.test.ts src/services/meta-capi-queue.test.ts src/services/meta-dataset-quality.test.ts`

Expected: FAIL，旧 secret 仍影响运行时。

- [ ] **Step 3: 删除运行时旧读取并统一调度**

Queue consumer 流程固定为：读取 delivery provider/revision -> 读取当前 verification -> 解包 connection key -> 解密 outbox v3 -> 解密 D1 credential -> 调用 provider Adapter -> 通用状态转换。任一 provider/revision 不匹配都跳过并记录稳定错误码，不改投其他平台。

- [ ] **Step 4: 运行完整本地与发布验证**

Run: `corepack pnpm verify:quick && corepack pnpm verify:local-runtime && corepack pnpm verify:release`

Expected: PASS；代码扫描 `rg -n "env\.META_CAPI_ACCESS_TOKEN|env\.META_CAPI_DATA_KEY" packages/api/src` 只命中一次性 importer，不命中生产投递。

- [ ] **Step 5: 提交、发布并观察**

```bash
git add packages/api/src/index.ts packages/api/src/services/conversions.ts packages/api/src/services/meta-capi-queue.ts packages/api/src/services/meta-dataset-quality.ts scripts/verify-ad-platform-control-plane.mjs docs/PROJECT_STATUS.md
git commit -m "refactor: 切换Meta通用归因运行时"
```

生产发布后至少观察 24 小时；验收必须同时满足：Meta `10/10`、连接有效、真实 Contact 成功样本、最终成功率无下降、无 pending/retrying 积压、无 critical incident、无跨平台 delivery、TikTok 仍 disabled `0/0`。未满足时停止 contract，按现有连接开关将 Meta Server effective 降至 `0`，不恢复双写。

---

## Milestone 3：TikTok 关闭态通用化与 Contract 清理

### Task 13：将 TikTok 协议迁入通用 Adapter

**Files:**
- Create: `packages/api/src/services/ad-platform/adapters/tiktok.ts`
- Create: `packages/api/src/services/ad-platform/adapters/tiktok.test.ts`
- Modify: `packages/api/src/services/ad-platform/registry.ts`
- Modify: `packages/api/src/services/ad-platform/queue-consumer.ts`
- Modify: `packages/api/src/services/ad-platform/queue-consumer.d1.test.ts`
- Modify: `packages/api/src/services/tiktok-events.ts`
- Modify: `packages/api/src/services/tiktok-events-delivery.ts`
- Modify: `packages/api/src/services/tiktok-events-queue.ts`
- Modify: `packages/api/src/services/tiktok-events.test.ts`
- Modify: `packages/api/src/services/tiktok-events-delivery.d1.test.ts`
- Modify: `packages/api/src/services/tiktok-events-queue.d1.test.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**
- Consumes: 通用 credential、connection key、challenge/evidence、rollout/incident 和 Queue consumer。
- Produces: `tiktokServerAdapter`、`tiktokVerificationAdapter`；TikTok disabled `0/0` 状态下已完全使用通用运行时。

- [ ] **Step 1: 写 TikTok 官方契约失败测试**

覆盖 v1.3 endpoint、`Access-Token` header、`event_source=web`、pixel_code、event/event_time/event_id/user/page、test code 仅验证请求携带、production 禁止 test code、TikTok 响应 code 成功/重试/凭证/永久/协议分类、Contact/CompleteRegistration 两事件。

- [ ] **Step 2: 运行并确认仍依赖旧 secret/verification**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/adapters/tiktok.test.ts src/services/ad-platform/queue-consumer.d1.test.ts src/services/tiktok-events.test.ts src/services/tiktok-events-delivery.d1.test.ts src/services/tiktok-events-queue.d1.test.ts`

Expected: FAIL，旧模块仍读取 TikTok Worker secret 或专属 verification。

- [ ] **Step 3: 实现 TikTok Adapter 严格分类**

```ts
export const tiktokServerAdapter: AdPlatformServerAdapter = {
  provider: 'tiktok',
  buildRequest(input) {
    return {
      url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/',
      init: {
        method: 'POST',
        headers: { 'Access-Token': input.credential, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTikTokPayload(input)),
      },
    }
  },
  classifyResponse(response, body) {
    if (response.ok && isTikTokAccepted(body)) return successResult(1)
    if (isTikTokCredentialFailure(response, body)) return credentialFailure('tiktok_credential_rejected')
    if (response.status === 429 || response.status >= 500) return retryableFailure('tiktok_retryable')
    return permanentFailure('tiktok_rejected')
  },
}
```

- [ ] **Step 4: 接入通用 Queue 与自动保护**

TikTok consumer 与 Meta 共用 lease/CAS/outbox v3 流程，但 Queue、DLQ、provider、connection revision 和 Adapter 独立。credential failure 必须使 TikTok verification 失效并将 TikTok target/effective 归零，不能影响 Meta。旧 TikTok 服务在本任务内只保留调用通用 Adapter/consumer 的薄包装，Task 14 删除。

- [ ] **Step 5: 运行 TikTok、Meta 和来源隔离回归**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/adapters/tiktok.test.ts src/services/ad-platform/queue-consumer.d1.test.ts src/services/tiktok-events.test.ts src/services/tiktok-events-delivery.d1.test.ts src/services/tiktok-events-queue.d1.test.ts src/services/ad-attribution-routing.test.ts src/services/conversions.test.ts src/services/ad-platform/adapters/meta.test.ts`

Expected: PASS；Meta source 只产生 Meta delivery，TikTok source 只产生 TikTok delivery，冲突/无来源产生零广告 delivery；TikTok 连接继续 disabled `0/0`。

- [ ] **Step 6: 提交**

```bash
git add packages/api/src/services/ad-platform/adapters/tiktok.ts packages/api/src/services/ad-platform/adapters/tiktok.test.ts packages/api/src/services/ad-platform/registry.ts packages/api/src/services/ad-platform/queue-consumer.ts packages/api/src/services/ad-platform/queue-consumer.d1.test.ts packages/api/src/services/tiktok-events.ts packages/api/src/services/tiktok-events-delivery.ts packages/api/src/services/tiktok-events-queue.ts packages/api/src/services/tiktok-events.test.ts packages/api/src/services/tiktok-events-delivery.d1.test.ts packages/api/src/services/tiktok-events-queue.d1.test.ts packages/api/src/index.ts
git commit -m "refactor: 迁移TikTok至通用归因运行时"
```

### Task 14：删除旧表、桥接、专属控制代码和旧 Secret

**Files:**
- Create: `packages/api/migrations/0052_ad_platform_control_plane_contract.sql`
- Create: `packages/api/migrations/0052_ad_platform_control_plane_contract.test.mjs`
- Delete: `packages/api/src/routes/admin/ad-platform-credential-import.ts`
- Delete: `packages/api/src/routes/admin/ad-platform-credential-import.test.ts`
- Delete: `packages/api/src/routes/meta-resource-attestation.ts`
- Delete: `packages/api/src/meta-resource-attestation-route.test.ts`
- Delete: `packages/api/src/meta-resource-attestation-ticket-route.test.ts`
- Delete: `packages/api/src/services/meta-connection.ts`
- Delete: `packages/api/src/services/meta-connection.test.ts`
- Delete: `packages/api/src/services/meta-connection.d1.test.ts`
- Delete: `packages/api/src/services/meta-live-challenge.ts`
- Delete: `packages/api/src/services/meta-live-challenge.d1.test.ts`
- Delete: `packages/api/src/services/meta-resource-attestation.ts`
- Delete: `packages/api/src/services/meta-resource-attestation.test.ts`
- Delete: `packages/api/src/services/meta-resource-attestation-ticket.ts`
- Delete: `packages/api/src/services/meta-resource-attestation-ticket.d1.test.ts`
- Delete: `packages/api/src/services/meta-capi-circuit-breaker.ts`
- Delete: `packages/api/src/services/meta-capi-circuit-breaker.test.ts`
- Delete: `packages/api/src/services/meta-capi-incident-evidence.ts`
- Delete: `packages/api/src/services/meta-capi-incident-evidence.test.ts`
- Delete: `packages/api/src/services/meta-capi-rollout.ts`
- Delete: `packages/api/src/services/meta-capi-rollout.test.ts`
- Delete: `packages/api/src/services/meta-capi.ts`
- Delete: `packages/api/src/services/meta-capi.test.ts`
- Delete: `packages/api/src/services/meta-capi-queue.ts`
- Delete: `packages/api/src/services/meta-capi-queue.test.ts`
- Delete: `packages/api/src/services/meta-capi-delivery-lease.d1.test.ts`
- Delete: `packages/api/src/services/meta-capi-key-rotation.ts`
- Delete: `packages/api/src/services/meta-capi-key-rotation.test.ts`
- Delete: `packages/api/src/services/meta-dataset-quality.ts`
- Delete: `packages/api/src/services/meta-dataset-quality.test.ts`
- Delete: `packages/api/src/services/meta-graph.ts`
- Delete: `packages/api/src/services/meta-graph.test.ts`
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
- Delete: `packages/web/app/components/admin/attribution/MetaConnectionStatus.vue`
- Delete: `packages/web/app/components/admin/attribution/MetaConnectionStatus.test.ts`
- Delete: `packages/web/app/components/admin/attribution/MetaRolloutControl.vue`
- Delete: `packages/web/app/components/admin/attribution/MetaRolloutControl.test.ts`
- Delete: `packages/web/app/components/admin/attribution/MetaIncidentList.vue`
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
- Modify: `packages/api/src/index.test.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Modify: `packages/api/src/routes/admin/ad-platforms.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `packages/api/src/routes/admin/attribution-rollout.d1.test.ts`
- Modify: `packages/api/src/services/ad-platform/connections.ts`
- Modify: `packages/api/src/services/ad-platform/status.ts`
- Modify: `packages/api/src/services/ad-platform/status.test.ts`
- Modify: `packages/api/src/services/attribution-dashboard.ts`
- Modify: `packages/api/src/services/attribution-dashboard.d1.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/services/conversions.test.ts`
- Modify: `packages/api/src/services/conversions.d1.test.ts`
- Modify: `packages/api/wrangler.toml`
- Modify: `package.json`
- Modify: `scripts/setup.sh`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/fixtures/release-smoke/seed-local.sql`
- Modify: `scripts/fixtures/release-smoke/seed-dev.sql`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/AD_PLATFORM_ARCHITECTURE.md`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: Task 12 的 24 小时稳定证据、Task 13 的 TikTok 通用 Adapter 和 `outbox v2 pending = 0`。
- Produces: 只含通用控制面和平台 Adapter 的最终 schema/code；历史 migration 文件保留。

- [ ] **Step 1: 写最终 schema 失败测试**

断言以下对象不存在：`meta_connection_verifications`、`tiktok_connection_verifications`、`meta_live_challenges`、`meta_capi_incidents`、`meta_dataset_quality_snapshots`、`meta_resource_attestation_tickets`、`meta_capi_secure_outbox`、全部 `trg_0049_bridge_*`、`users.meta_external_id`、连接旧列 `rollout_percentage/credential_secret_name/revision`。通用表和 `trg_0050_*` provider 约束必须存在。

- [ ] **Step 2: 运行并确认旧对象仍存在**

Run: `node --test packages/api/migrations/0052_ad_platform_control_plane_contract.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 编写 contract migration**

先用 CHECK guard 阻止危险 contract，再删除八个桥接 trigger 和旧运行对象：

```sql
CREATE TABLE _0052_contract_guard (
  ready INTEGER NOT NULL CHECK (ready = 1)
);

INSERT INTO _0052_contract_guard (ready)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM ad_platform_secure_outbox o
    JOIN analytics_conversion_deliveries d ON d.id = o.delivery_id AND d.provider = o.provider
    WHERE o.schema_version < 3 AND d.status IN ('pending','retrying')
  )
  AND NOT EXISTS (
    SELECT 1 FROM ad_platform_connections c
    WHERE c.server_enabled = 1
      AND NOT EXISTS (
        SELECT 1 FROM ad_platform_credentials k
        WHERE k.provider = c.provider AND k.credential_type = 'access_token'
      )
  )
  THEN 1 ELSE 0 END;

DROP TRIGGER trg_0049_bridge_user_identity_insert;
DROP TRIGGER trg_0049_bridge_user_identity_update;
DROP TRIGGER trg_0049_bridge_meta_outbox_legacy_insert;
DROP TRIGGER trg_0049_bridge_meta_outbox_legacy_update;
DROP TRIGGER trg_0049_bridge_meta_outbox_legacy_delete;
DROP TRIGGER trg_0049_bridge_meta_outbox_current_insert;
DROP TRIGGER trg_0049_bridge_meta_outbox_current_update;
DROP TRIGGER trg_0049_bridge_meta_outbox_current_delete;

UPDATE ad_platform_connections
SET rollout_target_percentage = rollout_target_percentage,
    connection_revision = connection_revision;

ALTER TABLE ad_platform_connections DROP COLUMN rollout_percentage;
ALTER TABLE ad_platform_connections DROP COLUMN credential_secret_name;
ALTER TABLE ad_platform_connections DROP COLUMN revision;
ALTER TABLE users DROP COLUMN meta_external_id;

DROP TABLE meta_connection_verifications;
DROP TABLE tiktok_connection_verifications;
DROP TABLE meta_live_challenges;
DROP TABLE meta_capi_incidents;
DROP TABLE meta_dataset_quality_snapshots;
DROP TABLE meta_resource_attestation_tickets;
DROP TABLE meta_capi_secure_outbox;
DROP TABLE _0052_contract_guard;
```

通用质量、verification、rollout 和 incident 在 expand backfill 后是唯一读源；contract 测试必须证明删除前后的 Meta `10/10`、TikTok `0/0`、有效 verification/evidence 和质量摘要完全相同。

- [ ] **Step 4: 删除应用专属控制面并运行零引用扫描**

Run:

```bash
rg -n "meta_connection_verifications|tiktok_connection_verifications|meta_live_challenges|meta_capi_incidents|meta_dataset_quality_snapshots|meta_resource_attestation|credential_secret_name|META_CAPI_ACCESS_TOKEN|META_CAPI_DATA_KEY|TIKTOK_EVENTS_ACCESS_TOKEN|TIKTOK_EVENTS_DATA_KEY|trg_0049_bridge" packages scripts docs --glob '!packages/api/migrations/00{36,37,39,41,42,44,45,46,47,49}_*' --glob '!docs/superpowers/**'
```

Expected: no matches。平台名仍可存在于 Adapter、Queue binding、UI label、官方契约测试和历史 migration 中。

- [ ] **Step 5: 运行完整 contract 验证**

Run: `node --test packages/api/migrations/0052_ad_platform_control_plane_contract.test.mjs scripts/verify-ad-platform-migration.test.mjs`

Run: `corepack pnpm verify:quick && corepack pnpm verify:local-runtime && corepack pnpm verify:release`

Expected: PASS；`0001 -> 0052` 空库和历史 fixture 均建立唯一最终 schema。

- [ ] **Step 6: 提交、发布 contract 并删除旧 production Secrets**

```bash
git add -A
git commit -m "refactor: 删除旧广告归因控制架构"
```

先发布 contract Worker/migration并确认 Meta `10/10` 稳定，再逐项执行 `wrangler secret delete` 删除 `META_CAPI_ACCESS_TOKEN`、`META_CAPI_DATA_KEY_CURRENT/PREVIOUS`、`TIKTOK_EVENTS_ACCESS_TOKEN`、`TIKTOK_EVENTS_DATA_KEY_CURRENT/PREVIOUS`。删除后重新运行 production 控制面只读检查；任何凭证读取必须继续来自 D1 vault。

---

## Milestone 4：TikTok 正式接入与独立放量

### Task 15：完成全量本地回归和 production TikTok `0 -> 10`

**Files:**
- Modify: `packages/web/tests/e2e/admin-attribution.spec.ts`
- Modify: `scripts/fixtures/release-smoke/seed-local.sql`
- Modify: `scripts/fixtures/release-smoke/seed-dev.sql`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: 完整通用运行时和 TikTok production Pixel ID/Access Token/Test Event Code。
- Produces: TikTok production 有效 connection revision、成对测试 challenge、人工 evidence 和 rollout `10/10`；Meta 继续 `10/10`。

- [ ] **Step 1: 增加端到端隔离验收**

Playwright 必须覆盖：未授权不加载 Pixel；Meta/TikTok 同时配置时仅来源 provider 初始化；provider 切换先 teardown；copy/QR/panel 无 conversion；合法外链与注册生成单 provider Browser 指令；后台两 provider 无状态串线且不显示 Token。

- [ ] **Step 2: 运行全部本地测试门禁**

Run:

```bash
corepack pnpm test:scripts
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @meigallery/api test:coverage
corepack pnpm --filter @meigallery/web test:unit
corepack pnpm --filter @meigallery/web test:e2e -- tests/e2e/admin-attribution.spec.ts
corepack pnpm verify:local-runtime
corepack pnpm --filter @meigallery/api build
corepack pnpm --filter @meigallery/web build
```

Expected: all exit `0`；dev/local 的 fetch spy 对 Meta/TikTok 官方域名调用次数为 `0`。

- [ ] **Step 3: 提交测试与部署说明**

```bash
git add packages/web/tests/e2e/admin-attribution.spec.ts scripts/fixtures/release-smoke/seed-local.sql scripts/fixtures/release-smoke/seed-dev.sql docs/DEPLOYMENT.md docs/PROJECT_STATUS.md
git commit -m "test: 完成TikTok归因上线验收"
```

- [ ] **Step 4: 发布关闭态代码并在后台配置 TikTok 逻辑连接**

按 release PR 合入 `main`，执行 `./scripts/deploy.sh production`。Owner 在同一连接编辑器设置 Pixel ID 和 Access Token，保持 `enabled=false`、Browser=false、Server=false、target/effective `0/0`；确认 Token 不回显且 Meta 状态未变化。

- [ ] **Step 5: 完成 TikTok 成对测试与人工去重确认**

Owner 输入当前 Test Event Code，创建 challenge；确认 TikTok Test Events 中 `Contact`、`CompleteRegistration` 均出现 Browser/Server 同 event ID，并由平台显示去重后提交人工 evidence。后台 Browser 只能显示“已尝试”，Server 只有严格成功时显示“API 已接收”。

- [ ] **Step 6: 启用 Pixel 并人工执行 `0 -> 10`**

先启用 production Browser Pixel；再开启 Server 并将 target 从 `0` 调至 `10`。只读验证必须显示 TikTok `10/10`、有效 evidence、两个 Queue 可用、无 credential failure/critical incident；Meta 仍为 `10/10` 且没有新增 TikTok 来源 delivery。

- [ ] **Step 7: 按门禁继续 `10 -> 50 -> 100`**

`10->50` 仅在有效 30 天证据、真实 Contact 成功样本、无跨平台/凭证/重试耗尽时执行。`50->100` 仅在 50% 稳定至少 24 小时、Server 转化至少 20、最终成功率至少 99%、无严重积压或 critical incident 时执行；未满足即保持当前比例，不使用人工 override 绕过。

---

## Task 16：最终清理、Google 扩展保护与文档收口

**Files:**
- Modify: `packages/api/src/services/ad-platform/registry.test.ts`
- Modify: `packages/api/src/services/ad-attribution-routing.test.ts`
- Modify: `packages/web/app/utils/attributionPlatforms.ts`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/AD_PLATFORM_ARCHITECTURE.md`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: Meta/TikTok 最终实现。
- Produces: Google 扩展架构守护测试和无旧兼容代码的文档基线。

- [ ] **Step 1: 写架构守护测试**

注册表测试固定断言未注册的 `google` fail closed，且 capability=true 时缺少对应 Adapter 会在 registry 初始化阶段抛出 `AD_PLATFORM_CAPABILITY_ADAPTER_MISSING`。静态架构测试读取 `conversions.ts`、Contact、registration、来源解析、rollout、incident 和后台页面，断言不存在 `provider === 'meta'`、`provider === 'tiktok'` 或 `provider === 'google'` 的业务分支；允许这些字符串存在于平台注册表和平台 Adapter 文件中。

- [ ] **Step 2: 运行守护测试和旧代码扫描**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/ad-platform/registry.test.ts src/services/ad-attribution-routing.test.ts`

Run: `rg -n "兼容|fallback|legacy|meta_connection_verifications|tiktok_connection_verifications|credential_secret_name|pixelEvents" packages/api/src packages/web/app`

Expected: 测试 PASS；扫描只允许业务明确需要的非归因兼容代码，不允许旧归因路径。

- [ ] **Step 3: 更新最终文档事实**

技术规范必须写明：Contact 新口径、通用 vault、通用控制表、v3 outbox、Meta/TikTok Adapter、生产唯一真实验证、当前各平台 target/effective、根密钥轮换和 Google 接入只新增注册项/Adapter/凭证类型/Queue。

- [ ] **Step 4: 执行最终发布级验证**

Run: `corepack pnpm verify:quick && corepack pnpm verify:local-runtime && corepack pnpm verify:release`

Run: `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm --filter @meigallery/api build && corepack pnpm --filter @meigallery/web build`

Expected: all exit `0`；production 只读检查确认 Meta/TikTok 状态按实际放量值隔离，无旧 secret、旧运行表、旧 trigger、旧路由、旧组件或双写。

- [ ] **Step 5: 提交最终收口**

```bash
git add packages/api/src/services/ad-platform/registry.test.ts packages/api/src/services/ad-attribution-routing.test.ts packages/web/app/utils/attributionPlatforms.ts docs/TECHNICAL_SPEC.md docs/DEPLOYMENT.md docs/AD_PLATFORM_ARCHITECTURE.md docs/PROJECT_STATUS.md
git commit -m "docs: 收口通用广告归因平台"
```

---

## 执行顺序与强制停点

1. Tasks 1-10 在 `dev` 完成本地实现与验证，形成一个功能闭环后统一推送。
2. Task 11 expand 发布完成后，只有 production 凭证导入、状态对账和 outbox 排空全部通过才进入 Task 12。
3. Task 12 的 24 小时观察是 contract 强制停点；期间任何 Meta critical incident、跨平台 delivery、成功率下降或积压都停止 Tasks 13-14。
4. Task 13 先在 TikTok disabled `0/0` 状态迁入通用 Adapter；Task 14 contract 完成并验证 Meta 稳定后，才删除旧 production Secret。
5. Task 15 的真实 Test Event Code 和 TikTok 放量只在 production 后台执行。
6. 每个生产阶段都先保存脱敏 before 报告，失败时优先把对应 provider effective rollout 降为 `0`，不得恢复双写、伪造证据或把事件改投其他平台。

## 计划自检结果

- 设计覆盖：规范事件、单 provider 来源、通用 Adapter、加密凭证、connection key、challenge/evidence、rollout/incident/quality、后台 UI、expand/contract、Meta 10%、TikTok 分阶段上线和 Google 扩展均有对应任务。
- 占位扫描：计划不含未定义的后续实现占位；每个新增接口均在首次使用任务中给出签名或结构。
- 类型一致：全计划统一使用 `AdAttributionProvider`、`AdPlatformRolloutPercentage`、`connectionRevision`、`credentialRevision`、`rolloutTargetPercentage`、`rolloutEffectivePercentage` 和 `AdPlatformDeliveryResult`。
- 安全检查：Token/Test Event Code/匹配字段不落日志和响应；跨 provider/revision 解密、来源冲突和 Adapter 缺失全部 fail closed。
- 发布检查：Meta 迁移和 TikTok 上线均有独立停点、回滚动作和 production 人工证据，普通 commit 不作为归因门禁。
