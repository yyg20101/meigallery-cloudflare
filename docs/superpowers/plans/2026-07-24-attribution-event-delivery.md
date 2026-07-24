# 归因事件与平台投递 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立 Attribution Worker 内完成可信来源路由、运行租约、Canonical Event 事实、Browser/Server 配对、三平台 Adapter、Queue 恢复和全链路自动验证。

**Architecture:** 所有事件先解析为一个可信 `connection_id`，再基于租约锁定一个不可变 `version_id`；事实、delivery 和 outbox 在 Attribution D1 中原子创建。平台协议仅存在于 Adapter，业务核心通过注册表分派，绝不广播到其他 provider。

**Tech Stack:** TypeScript 6、Hono 4、Cloudflare Workers、D1、Queues、Workflows、Web Crypto、Nuxt 4、Vitest 4、Playwright。

## Global Constraints

- 依赖 [运行时基础计划](./2026-07-24-attribution-runtime-foundation.md) 全部完成。
- 路由优先级固定为：有效管理链接、有效第一方上下文、唯一可用连接的平台 click ID、无来源。
- 普通 UTM 不得声明 provider 或 connection。
- 多平台冲突和同平台多连接歧义必须零投递并创建 Incident。
- Browser 与 Server 对同一事件复用同一 `event_id`、`connection_id` 和 `version_id`。
- `draining` 版本只接受已签发租约的在途事件；租约最长 30 分钟，离线补交最长 24 小时。
- synthetic 事实不得进入业务指标。
- Test Event Code 仅作为加密临时验证输入，终态立即销毁。
- Adapter 不得创建事实、选择连接、修改运行策略或读取其他 provider 凭证。
- Server 平台异常只影响 Server；Browser 继续运行。

---

## 文件结构

```text
packages/attribution/migrations/0002_event_delivery.sql
packages/attribution/src/domain/routing.ts
packages/attribution/src/services/managed-source-service.ts
packages/attribution/src/services/context-service.ts
packages/attribution/src/services/privacy-policy.ts
packages/attribution/src/services/runtime-lease.ts
packages/attribution/src/services/fact-service.ts
packages/attribution/src/services/delivery-planner.ts
packages/attribution/src/services/secure-outbox.ts
packages/attribution/src/services/queue-consumer.ts
packages/attribution/src/services/validation-service.ts
packages/attribution/src/workflows/candidate-validation.ts
packages/attribution/src/adapters/{registry,types,meta,tiktok,google}.ts
packages/attribution/src/routes/{browser,internal}.ts
packages/api/migrations/0058_attribution_business_outbox.sql
packages/api/src/services/attribution-business-outbox.ts
packages/api/src/services/attribution-service-client.ts
packages/web/app/plugins/attribution.client.ts
packages/web/app/adapters/{registry,meta,tiktok,google}.client.ts
packages/web/app/composables/useAdAttribution.ts
```

### Task 1: 建立事件投递 Schema

**Files:**
- Create: `packages/attribution/migrations/0002_event_delivery.sql`
- Create: `packages/attribution/migrations/0002_event_delivery.test.mjs`
- Modify: `packages/attribution/src/test/attribution-schema.ts`

**Interfaces:**
- Consumes: `connection_id`、`version_id` 和运行策略。
- Produces: 来源、上下文、事实、delivery、outbox、Browser 回执、验证和质量表。

- [ ] **Step 1: 写迁移失败测试**

```js
test('事件 Schema 具备事实和投递唯一约束', () => {
  assert.match(migration, /UNIQUE\s*\(dedupe_key\)/i)
  assert.match(migration, /UNIQUE\s*\(fact_id,\s*connection_id,\s*transport\)/i)
  assert.match(migration, /CHECK\s*\(transport IN \('browser','server'\)\)/i)
  assert.doesNotMatch(migration, /release_commit|verified_commit/i)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test packages/attribution/migrations/0002_event_delivery.test.mjs
```

Expected: FAIL，迁移文件不存在。

- [ ] **Step 3: 编写事件 Schema**

核心表和唯一约束必须为：

```sql
CREATE TABLE attribution_managed_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES attribution_connections(id),
  campaign TEXT NOT NULL,
  medium TEXT NOT NULL,
  content TEXT NOT NULL,
  proof_hmac TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_contexts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  source_id TEXT,
  identifiers_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE attribution_facts (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL CHECK (event_name IN ('Contact','CompleteRegistration')),
  fact_origin TEXT NOT NULL CHECK (fact_origin IN ('live','synthetic')),
  dedupe_key TEXT NOT NULL UNIQUE,
  connection_id TEXT,
  version_id TEXT,
  provider TEXT,
  external_event_id TEXT,
  occurred_at TEXT NOT NULL,
  consent_json TEXT NOT NULL,
  analytics_dimensions_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_deliveries (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES attribution_facts(id),
  connection_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('browser','server')),
  destination TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','queued','accepted','processed','retrying','rejected','dead_letter','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queue_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fact_id, connection_id, transport)
);

CREATE TABLE attribution_outbox (
  delivery_id TEXT PRIMARY KEY REFERENCES attribution_deliveries(id),
  provider TEXT NOT NULL,
  version_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_browser_receipts (
  delivery_id TEXT PRIMARY KEY REFERENCES attribution_deliveries(id),
  attempted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_validations (
  id TEXT PRIMARY KEY,
  candidate_version_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','verified','failed','timed_out')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  failure_code TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_validation_secrets (
  validation_id TEXT PRIMARY KEY REFERENCES attribution_validations(id),
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE attribution_quality_daily (
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  numerator INTEGER,
  denominator INTEGER,
  value REAL,
  availability TEXT NOT NULL,
  PRIMARY KEY (date, connection_id, metric_key)
);

CREATE TABLE attribution_privacy_policy (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  default_mode TEXT NOT NULL CHECK (default_mode IN ('notice_opt_out','prior_consent','disabled')),
  prior_consent_country_codes_json TEXT NOT NULL CHECK (json_valid(prior_consent_country_codes_json)),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: 运行迁移测试**

Run:

```bash
node --test packages/attribution/migrations/0002_event_delivery.test.mjs
corepack pnpm --filter @meigallery/attribution exec wrangler d1 migrations apply meigallery-attribution-db --local
```

Expected: PASS，Wrangler 显示第二个 migration applied。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/migrations packages/attribution/src/test
git commit -m "feat: 建立归因事件投递数据模型"
```

### Task 2: 实现管理来源 Proof 和严格路由

**Files:**
- Create: `packages/attribution/src/domain/routing.ts`
- Create: `packages/attribution/src/domain/routing.test.ts`
- Create: `packages/attribution/src/services/managed-source-service.ts`
- Create: `packages/attribution/src/services/managed-source-service.d1.test.ts`

**Interfaces:**
- Consumes: `attribution_managed_sources`、当前有效连接集合。
- Produces: `createManagedSource()`、`resolveAttributionRoute()`。

- [ ] **Step 1: 写完整路由矩阵失败测试**

```ts
it.each([
  ['meta proof A', { proof: 'proof-a' }, 'conn_meta_a'],
  ['meta proof B', { proof: 'proof-b' }, 'conn_meta_b'],
  ['tiktok proof', { proof: 'proof-tiktok' }, 'conn_tiktok_a'],
  ['google proof', { proof: 'proof-google' }, 'conn_google_a'],
  ['direct', {}, null],
])('%s', async (_name, signals, expected) => {
  expect((await resolveAttributionRoute(repository, signals)).connectionId).toBe(expected)
})

it('多连接只有 click ID 时不猜测', async () => {
  const result = await resolveAttributionRoute(repositoryWithTwoMetaConnections, {
    identifiers: { fbclid: 'fb-click' },
  })
  expect(result).toEqual({
    resolution: 'ambiguous',
    provider: 'meta',
    connectionId: null,
    incidentCode: 'ATTRIBUTION_CONNECTION_AMBIGUOUS',
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/domain/routing.test.ts src/services/managed-source-service.d1.test.ts
```

Expected: FAIL，路由服务不存在。

- [ ] **Step 3: 实现 opaque proof**

`createManagedSource()` 使用 32 字节随机 proof：

```ts
const proofBytes = crypto.getRandomValues(new Uint8Array(32))
const proof = base64Url(proofBytes)
const proofHmac = await hmac(signingKey, `managed-source:v1:${proof}`)
```

D1 只保存 `proof_hmac`。`resolveAttributionRoute()` 固定执行：

```ts
if (validManagedSource) return exactManagedConnection
if (validFirstPartyContext) return inheritedConnection
if (conflictingProviderSignals) return conflictWithoutDelivery
if (clickProvider && eligibleConnections.length === 1) return eligibleConnections[0]
if (clickProvider && eligibleConnections.length > 1) return ambiguousWithoutDelivery
return noAttribution
```

任何普通 `utm_source=facebook|tiktok|google` 均不能改变结果。

- [ ] **Step 4: 运行测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/domain/routing.test.ts src/services/managed-source-service.d1.test.ts
```

Expected: PASS，矩阵中每个来源只返回一个 connection 或 `null`。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src/domain/routing* packages/attribution/src/services/managed-source-service*
git commit -m "feat: 实现归因来源严格路由"
```

### Task 3: 实现地区隐私决策、第一方上下文和运行租约

**Files:**
- Create: `packages/attribution/src/services/privacy-policy.ts`
- Create: `packages/attribution/src/services/privacy-policy.test.ts`
- Create: `packages/attribution/src/services/privacy-policy.d1.test.ts`
- Create: `packages/attribution/src/services/context-service.ts`
- Create: `packages/attribution/src/services/context-service.test.ts`
- Create: `packages/attribution/src/services/runtime-lease.ts`
- Create: `packages/attribution/src/services/runtime-lease.test.ts`
- Create: `packages/attribution/src/services/version-retirement.ts`
- Create: `packages/attribution/src/services/version-retirement.d1.test.ts`

**Interfaces:**
- Consumes: Task 2 路由结果、Cloudflare country、`Sec-GPC`、用户选择、Active Version 和运行策略。
- Produces: `resolvePrivacyDecision()`、`savePrivacyPolicy()`、`issueAttributionContext()`、`resolveAttributionContext()`、`issueRuntimeLease()`、`verifyRuntimeLease()`、`retireDrainedVersions()`。

- [ ] **Step 1: 写租约失败测试**

```ts
it('Active 切换后旧租约仍锁定旧版本', async () => {
  const lease = await issueRuntimeLease(keys, {
    connectionId: 'conn_meta_a',
    versionId: 'ver_old',
    provider: 'meta',
    nowSeconds: 1_000,
  })
  repository.activeVersionId = 'ver_new'
  const verified = await verifyRuntimeLease(keys, lease, 1_100)
  expect(verified.versionId).toBe('ver_old')
})

it('租约超过 30 分钟后拒绝新事件', async () => {
  const lease = await issueRuntimeLease(keys, inputAt(1_000))
  await expect(verifyRuntimeLease(keys, lease, 2_801))
    .rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_EXPIRED')
})

it('draining 满 30 分钟后退休但仍接受租约内已发生的 24 小时补交', async () => {
  await retireDrainedVersions(db, new Date('2026-07-24T00:30:00.000Z'))
  expect((await version(db, 'ver_old')).status).toBe('retired')
  expect(await verifyDelayedEvent(oldLease, {
    occurredAt: '2026-07-24T00:29:59.000Z',
    receivedAt: '2026-07-24T20:00:00.000Z',
  })).toMatchObject({ accepted: true, versionId: 'ver_old' })
})
```

- [ ] **Step 2: 写地区与 GPC 决策失败测试**

```ts
it.each([
  ['US', null, false, 'granted'],
  ['US', 'denied', false, 'denied'],
  ['DE', null, false, 'choice_required'],
  ['DE', 'granted', false, 'granted'],
  ['US', 'granted', true, 'denied'],
  ['XX', null, false, 'choice_required'],
])('country=%s choice=%s gpc=%s', (country, choice, gpc, expected) => {
  expect(resolvePrivacyDecision(policy, { country, choice, gpc }).state).toBe(expected)
})

it('上下文只通过 HttpOnly 第一方 Cookie 返回且篡改后失效', async () => {
  const response = await issueAttributionContextResponse(
    validManagedSourceRequest,
    productionBindings,
  )
  expect(response.headers.get('Set-Cookie')).toMatch(
    /__Secure-mg_attribution_context=.*HttpOnly.*Secure.*SameSite=Lax.*Domain=\.616618\.xyz/i,
  )
  expect(await response.json()).not.toHaveProperty('sourceContextToken')
  await expect(resolveAttributionContext(tamperCookie(response)))
    .rejects.toThrow('ATTRIBUTION_CONTEXT_INVALID')
})
```

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/privacy-policy.test.ts src/services/privacy-policy.d1.test.ts src/services/context-service.test.ts src/services/runtime-lease.test.ts src/services/version-retirement.d1.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现地区策略、签名上下文和租约**

隐私优先级固定为：

```ts
if (input.gpc) return denied('gpc')
if (policy.defaultMode === 'disabled') return denied('disabled')
if (input.choice === 'denied') return denied('explicit')
if (input.choice === 'granted') return granted('explicit')
if (!knownCountry(input.country) || policy.priorConsentCountryCodes.includes(input.country)) {
  return choiceRequired()
}
return granted('regional_default')
```

只有 `granted` 才能签发归因上下文和运行租约。`choice_required` 与 `denied` 仍允许保存最小一方业务事实，但 Planner 必须返回零广告 Delivery。策略写入使用独立幂等命令，国家代码标准化为大写、去重、排序的 ISO 3166-1 alpha-2 列表。

上下文与租约签名必须覆盖全部路由身份：

```ts
const leasePayload = {
  schemaVersion: 1,
  connectionId,
  versionId,
  provider,
  issuedAt: nowSeconds,
  expiresAt: nowSeconds + 30 * 60,
}
const signature = await hmac(signingKey, stableJson(leasePayload))
```

`draining` 版本只在签名租约的 `versionId` 与事实相同且事件发生时间不晚于租约 `expiresAt` 时接受；离线到达时间不得晚于事件发生后 24 小时。
`retireDrainedVersions()` 在 `draining_at + 30 minutes` 后把版本设为 `retired` 并启动 7 天凭证
保留计时；已签发租约的迟到事件仍按其 `occurredAt` 和 24 小时接收窗口验证，不会改投新 Active。

签名上下文只通过名为 `__Secure-mg_attribution_context` 的
`HttpOnly; Secure; SameSite=Lax; Path=/` Cookie 传递，不返回给 JavaScript；生产响应的
`Domain` 读取 `ATTRIBUTION_COOKIE_DOMAIN=.616618.xyz`，dev/local 空值表示 host-only，
最长保留 30 天。`616618.xyz`、`api.616618.xyz` 和 `track.616618.xyz` 请求均使用
`credentials: 'include'`；主 API 可以读取并原样放入注册业务 outbox，但不得验签、解析、记录或
回显。只有 Attribution Worker 可以验签并解析 connection/version/provider；缺失 Cookie 表示
无归因来源，篡改 Cookie 表示无投递并创建安全 Incident，二者都不得阻断正常业务。

- [ ] **Step 5: 运行测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/privacy-policy.test.ts src/services/privacy-policy.d1.test.ts src/services/context-service.test.ts src/services/runtime-lease.test.ts src/services/version-retirement.d1.test.ts
```

Expected: PASS；GPC 和显式拒绝优先；未知地区 fail closed；篡改 connection、version、provider 或时间任一字段均失败。

- [ ] **Step 6: 提交**

```bash
git add packages/attribution/src/services/privacy-policy* packages/attribution/src/services/context-service* packages/attribution/src/services/runtime-lease* packages/attribution/src/services/version-retirement*
git commit -m "feat: 统一地区隐私与归因运行租约"
```

### Task 4: 实现事实、去重和 Delivery Planner

**Files:**
- Create: `packages/attribution/src/services/fact-service.ts`
- Create: `packages/attribution/src/services/fact-service.d1.test.ts`
- Create: `packages/attribution/src/services/delivery-planner.ts`
- Create: `packages/attribution/src/services/delivery-planner.test.ts`
- Create: `packages/attribution/src/services/browser-receipt.ts`
- Create: `packages/attribution/src/services/browser-receipt.test.ts`

**Interfaces:**
- Consumes: 已验证租约、Active/Draining 版本快照和运行策略。
- Produces: `recordCanonicalFact()`、`planDeliveries()`、`recordBrowserReceipt()`。

- [ ] **Step 1: 写去重和配对失败测试**

```ts
it('同一事实重复提交只保留一组 Browser/Server delivery', async () => {
  const first = await recordCanonicalFact(env, validContactEvent)
  const second = await recordCanonicalFact(env, validContactEvent)
  expect(second.factId).toBe(first.factId)
  expect(await countFacts(db, validContactEvent.dedupeKey)).toBe(1)
  expect(await countDeliveries(db, first.factId)).toBe(2)
  expect(new Set(await externalEventIds(db, first.factId))).toEqual(
    new Set([first.externalEventId]),
  )
})

it('Meta 来源不创建 TikTok 或 Google delivery', async () => {
  const result = await recordCanonicalFact(env, metaContactEvent)
  expect(result.deliveries.map(item => item.provider)).toEqual(['meta', 'meta'])
})

it.each([
  ['无上下文', null],
  ['篡改上下文', 'tampered'],
])('%s仍保留业务事实但不创建广告 delivery', async (_label, sourceContextToken) => {
  const result = await recordCanonicalFact(env, {
    ...validRegistrationEvent,
    sourceContextToken,
  })
  expect(result.factId).toBeTruthy()
  expect(result.deliveries).toEqual([])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/fact-service.d1.test.ts src/services/delivery-planner.test.ts
```

Expected: FAIL，事实服务不存在。

- [ ] **Step 3: 实现事实与 Planner**

稳定事件 ID：

```ts
const externalEventId = await hmacId(
  eventKey,
  `v1:${event.eventName}:${event.eventId}:${lease.connectionId}:${lease.versionId}`,
)
```

Planner 只接受一个已解析 connection：

```ts
export interface DeliveryPlanInput {
  factId: string
  externalEventId: string
  connectionId: string
  versionId: string
  provider: AttributionProvider
  eventName: CanonicalConversionEvent
  runtimePolicy: AttributionRuntimePolicy
}
```

当 `browserEnabled=true` 创建一条 Browser delivery；当 `serverEnabled=true`、熔断关闭且稳定分桶小于 effective 时创建一条 Server delivery。事实、delivery 和加密 outbox 使用同一 D1 `batch` 写入。

- [ ] **Step 4: 运行测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/fact-service.d1.test.ts src/services/delivery-planner.test.ts src/services/browser-receipt.test.ts
```

Expected: PASS；重复请求、刷新和 Queue 重试均不产生新 `external_event_id`。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src/services/fact-service* packages/attribution/src/services/delivery-planner* packages/attribution/src/services/browser-receipt*
git commit -m "feat: 统一归因事实与投递计划"
```

### Task 5: 建立 Provider Adapter 注册表

**Files:**
- Create: `packages/attribution/src/adapters/types.ts`
- Create: `packages/attribution/src/adapters/registry.ts`
- Create: `packages/attribution/src/adapters/registry.test.ts`
- Create: `packages/attribution/src/adapters/meta.ts`
- Create: `packages/attribution/src/adapters/meta.test.ts`
- Create: `packages/attribution/src/adapters/tiktok.ts`
- Create: `packages/attribution/src/adapters/tiktok.test.ts`
- Create: `packages/attribution/src/adapters/google.ts`
- Create: `packages/attribution/src/adapters/google.test.ts`

**Interfaces:**
- Consumes: Canonical Event、不可变版本配置和解密后的当前 provider 凭证。
- Produces: `AttributionProviderAdapter` 以及 Meta、TikTok、Google 唯一实现。

- [ ] **Step 1: 写 Adapter 契约和跨平台拒绝测试**

```ts
export interface AttributionProviderAdapter {
  validateCandidate(input: CandidateValidationInput): Promise<ValidationEvidence>
  buildBrowserInstruction(input: BrowserInstructionInput): BrowserInstruction
  deliverServerEvent(input: ServerDeliveryInput): Promise<ProviderDeliveryResult>
  readQualitySignal(input: QualitySignalInput): Promise<QualitySignalResult>
}

it('Meta Adapter 拒绝 TikTok connection', async () => {
  await expect(metaAdapter.deliverServerEvent({
    provider: 'tiktok',
    connectionId: 'conn_tiktok_a',
  } as ServerDeliveryInput)).rejects.toThrow('ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH')
})
```

每个平台测试还必须断言标准事件映射：

```ts
expect(metaAdapter.eventName('Contact')).toBe('Contact')
expect(tiktokAdapter.eventName('CompleteRegistration')).toBe('CompleteRegistration')
expect(googleAdapter.eventName('Contact')).toBe('conversion')
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/adapters
```

Expected: FAIL，Adapter 尚未实现。

- [ ] **Step 3: 迁移并收口三平台协议**

注册表只允许：

```ts
const adapters: ReadonlyMap<AttributionProvider, AttributionProviderAdapter> =
  new Map([
    ['meta', metaAdapter],
    ['tiktok', tiktokAdapter],
    ['google', googleAdapter],
  ])

export function getProviderAdapter(provider: AttributionProvider) {
  const adapter = adapters.get(provider)
  if (!adapter) throw new AttributionDomainError('ATTRIBUTION_PROVIDER_UNSUPPORTED')
  return adapter
}
```

平台 HTTP 请求、字段名、错误分类和质量读取分别留在对应文件。核心服务不得出现 `provider === 'meta'`、`provider === 'tiktok'` 或 `provider === 'google'`。

- [ ] **Step 4: 运行 Adapter 测试和边界扫描**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/adapters
rg -n "provider === '(meta|tiktok|google)'" packages/attribution/src --glob '!adapters/**'
```

Expected: Adapter 测试 PASS；`rg` 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src/adapters
git commit -m "feat: 统一三平台归因 Adapter"
```

### Task 6: 实现加密 Outbox、Queue 和熔断

**Files:**
- Create: `packages/attribution/src/services/secure-outbox.ts`
- Create: `packages/attribution/src/services/secure-outbox.test.ts`
- Create: `packages/attribution/src/services/queue-consumer.ts`
- Create: `packages/attribution/src/services/queue-consumer.d1.test.ts`
- Create: `packages/attribution/src/services/circuit-breaker.ts`
- Create: `packages/attribution/src/services/circuit-breaker.test.ts`
- Modify: `packages/attribution/src/env.ts`
- Modify: `packages/attribution/src/index.ts`
- Modify: `packages/attribution/wrangler.toml`

**Interfaces:**
- Consumes: Server delivery outbox 和 Provider Adapter。
- Produces: 平台专属 Queue consumer、DLQ、D1 恢复和 Server-only circuit。

- [ ] **Step 1: 写 Queue 故障测试**

```ts
it('TikTok consumer 拒绝 Meta 消息', async () => {
  await expect(consumeProviderMessage(env, 'tiktok', {
    schemaVersion: 1,
    provider: 'meta',
    deliveryId: 'delivery_1',
  })).rejects.toThrow('ATTRIBUTION_QUEUE_PROVIDER_MISMATCH')
})

it('连续瞬时错误只打开 Server 熔断', async () => {
  await recordTransientFailures(env, 'conn_meta_a', 5)
  const policy = await readRuntimePolicy(db, 'conn_meta_a')
  expect(policy.circuitState).toBe('server_open')
  expect(policy.browserEnabled).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/secure-outbox.test.ts src/services/queue-consumer.d1.test.ts src/services/circuit-breaker.test.ts
```

Expected: FAIL，Queue 服务不存在。

- [ ] **Step 3: 实现三条物理 Queue**

绑定名称固定为：

```toml
[[queues.producers]]
binding = "META_QUEUE"
queue = "meigallery-attribution-meta"

[[queues.producers]]
binding = "TIKTOK_QUEUE"
queue = "meigallery-attribution-tiktok"

[[queues.producers]]
binding = "GOOGLE_QUEUE"
queue = "meigallery-attribution-google"
```

每条 Queue 配置对应 DLQ。consumer 先比较物理 provider、消息 provider、delivery provider 和 version provider，四者不一致立即拒绝并创建 critical Incident。429、5xx、网络超时分类为 transient；权限、目标资源不匹配和 payload schema 错误分类为 deterministic。

- [ ] **Step 4: 运行 Queue、恢复和熔断测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/secure-outbox.test.ts src/services/queue-consumer.d1.test.ts src/services/circuit-breaker.test.ts
```

Expected: PASS；D1 outbox 可在 Queue 消息过期后复投，复投仍使用原 `external_event_id`。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src packages/attribution/wrangler.toml
git commit -m "feat: 隔离归因平台队列与服务端熔断"
```

### Task 7: 实现全链路候选验证和自动激活

**Files:**
- Create: `packages/attribution/src/services/validation-service.ts`
- Create: `packages/attribution/src/services/validation-service.d1.test.ts`
- Create: `packages/attribution/src/workflows/candidate-validation.ts`
- Create: `packages/attribution/src/workflows/candidate-validation.test.ts`
- Modify: `packages/attribution/src/index.ts`
- Modify: `packages/attribution/src/env.ts`
- Modify: `packages/attribution/wrangler.toml`

**Interfaces:**
- Consumes: 候选状态机、事实服务、Queue、Adapter。
- Produces: `startCandidateValidation()` 和 `CandidateValidationWorkflow`。

- [ ] **Step 1: 写验证失败测试**

```ts
it('验证失败保持旧 Active 和运行策略', async () => {
  const before = await snapshotConnection(db, connectionId)
  adapter.validateCandidate.mockRejectedValueOnce(new Error('invalid credential'))
  await runCandidateValidation(env, validationId)
  const after = await snapshotConnection(db, connectionId)
  expect(after.activeVersionId).toBe(before.activeVersionId)
  expect(after.runtimePolicy).toEqual(before.runtimePolicy)
  expect(after.candidate.status).toBe('failed')
})

it('验证成功使用正常事实和 Queue 链路后自动激活', async () => {
  await runCandidateValidation(env, validationId)
  expect(await syntheticFacts(db, candidateId)).toHaveLength(2)
  expect(await queuedSyntheticDeliveries(db, candidateId)).toHaveLength(2)
  expect((await snapshotConnection(db, connectionId)).activeVersionId).toBe(candidateId)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/validation-service.d1.test.ts src/workflows/candidate-validation.test.ts
```

Expected: FAIL，Workflow 未实现。

- [ ] **Step 3: 实现 30 分钟自动验证**

Workflow 固定步骤：

```ts
await validateSchemaAndBindings(candidate)
await adapter.validateCandidate(candidateInput)
const contact = await createSyntheticFact('Contact', validationId)
const registration = await createSyntheticFact('CompleteRegistration', validationId)
await dispatchAndAwaitServerDeliveries([contact, registration])
await verifyBrowserInstructionPairing([contact, registration])
await assertSyntheticExcludedFromMetrics(validationId)
await markCandidateReady(...)
await activateCandidate(...)
await runDeterministicActivationSmoke(...)
await destroyValidationSecret(validationId)
```

任何终态都执行 `destroyValidationSecret()`。总执行时间超过 30 分钟写入 `timed_out`，不等待人工证据。429、5xx 和网络超时不得触发身份回滚。

- [ ] **Step 4: 运行验证测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/validation-service.d1.test.ts src/workflows/candidate-validation.test.ts
```

Expected: PASS；测试结束后 `attribution_validation_secrets` 中没有终态 validation 行。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src/services/validation-service* packages/attribution/src/workflows packages/attribution/wrangler.toml
git commit -m "feat: 自动验证并激活归因候选"
```

### Task 8: 接入可信业务 outbox 和 Service Binding

**Files:**
- Create: `packages/api/migrations/0058_attribution_business_outbox.sql`
- Create: `packages/api/migrations/0058_attribution_business_outbox.test.mjs`
- Create: `packages/api/src/services/attribution-business-outbox.ts`
- Create: `packages/api/src/services/attribution-business-outbox.d1.test.ts`
- Create: `packages/api/src/services/attribution-service-client.ts`
- Create: `packages/api/src/services/attribution-service-client.test.ts`
- Create: `packages/attribution/src/services/contact-capability.ts`
- Create: `packages/attribution/src/services/contact-capability.test.ts`
- Create: `packages/attribution/src/routes/internal.ts`
- Create: `packages/attribution/src/routes/internal.test.ts`
- Modify: `packages/attribution/src/index.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/routes/auth.ts`
- Modify: `packages/api/src/routes/contact-methods.ts`
- Modify: `packages/api/src/routes/contact-methods.test.ts`
- Modify: `packages/api/wrangler.toml`

**Interfaces:**
- Consumes: Task 1 的 `AttributionBusinessEventV1`。
- Produces: 注册事务 outbox、`dispatchAttributionBusinessOutbox()`、签名联系人 capability 和 `ATTRIBUTION` Service Binding。

- [ ] **Step 1: 写注册事务失败测试**

```ts
it('注册失败不产生归因 outbox', async () => {
  await expect(registerUser(env, duplicateEmailInput)).rejects.toThrow()
  expect(await countAttributionBusinessOutbox(db)).toBe(0)
})

it('注册成功在同一 batch 写用户和 CompleteRegistration outbox', async () => {
  const user = await registerUser(env, validInput)
  const outbox = await readAttributionBusinessOutbox(db)
  expect(outbox.event_name).toBe('CompleteRegistration')
  expect(JSON.parse(outbox.payload_json).payload.userId).toBe(user.id)
  expect(JSON.parse(outbox.payload_json).sourceContextToken).toBe(signedContextCookieValue)
})

it('联系人接口在归因不可用时仍返回联系人但不伪造 capability', async () => {
  attributionBinding.fetch.mockRejectedValueOnce(new Error('unavailable'))
  const response = await contactMethodRoutes.request('/', {}, env)
  expect(response.status).toBe(200)
  expect((await response.json()).data[0].attributionCapability).toBeNull()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-business-outbox.d1.test.ts src/services/attribution-service-client.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/contact-capability.test.ts src/routes/internal.test.ts
```

Expected: FAIL，outbox 和 Service Binding client 不存在。

- [ ] **Step 3: 实现业务 outbox 和 Binding client**

API D1 表：

```sql
CREATE TABLE attribution_business_outbox (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL CHECK (event_name = 'CompleteRegistration'),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

Binding：

```toml
[[services]]
binding = "ATTRIBUTION"
service = "meigallery-attribution"
```

Client 固定调用 `/internal/v1/registration-events`，请求体必须通过共享 type guard；成功后更新 `completed`，失败保留 pending 并指数退避。

共享 `AttributionServiceContractV1` 与 fetch 路由一一映射：

```text
ingestRegistrationEvent()   -> POST /internal/v1/registration-events
dispatchBusinessOutbox()    -> API 本地 Dispatcher 领取后调用 ingestRegistrationEvent()
getSignedBrowserInstruction() -> GET /internal/v1/events/:eventId/browser-instruction
```

`attribution-service-client.ts` 是主 API 唯一允许调用 `ATTRIBUTION.fetch()` 的模块；业务路由和
outbox 服务只能调用上述类型化方法，不得自行拼接内部 URL。

注册路由只从 `__Secure-mg_attribution_context` Cookie 读取 opaque token，并原样写入同一事务的
business outbox；缺失时写 `null`。API 不解析、不验签、不回显且日志中必须过滤该 Cookie。
注册事务提交后立即尝试 dispatch 对应 outbox；Attribution Worker 接受时返回
`instructionToken`，API 把它作为 `attributionInstructionToken` 放入成功注册响应。即时调用失败时
注册仍成功，outbox 保持 pending 并由 Dispatcher 重试，客户端不能自行声明
`CompleteRegistration`。

联系人接口把 `{ contactMethodId, platform, destinationDigest }[]` 通过 Service Binding 发送到
`/internal/v1/contact-capabilities`。Attribution Worker 返回最长 24 小时的签名 capability，绑定
三项字段和到期时间；API 只把 capability 附在对应联系人响应中。Binding 失败不得影响联系人本身，
但该动作不具备广告投递资格。

capability payload 固定为：

```ts
interface ContactCapabilityV1 {
  schemaVersion: 1
  contactMethodId: string
  platform: string
  destinationDigest: string
  issuedAt: number
  expiresAt: number
}
```

签名输入为 `contact-capability:v1:${base64Url(stableJson(payload))}`，使用
`ATTRIBUTION_SIGNING_KEY` HMAC-SHA256。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --test packages/api/migrations/0058_attribution_business_outbox.test.mjs
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-business-outbox.d1.test.ts src/services/attribution-service-client.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/contact-capability.test.ts src/routes/internal.test.ts
```

Expected: PASS；重复 dispatch 不会在 Attribution D1 产生重复事实。

- [ ] **Step 5: 提交**

```bash
git add packages/api/migrations/0058_attribution_business_outbox* packages/api/src/services/attribution-* packages/api/src/index.ts packages/api/src/routes/auth.ts packages/api/src/routes/contact-methods* packages/api/wrangler.toml packages/attribution/src/services/contact-capability* packages/attribution/src/routes/internal* packages/attribution/src/index.ts
git commit -m "feat: 通过 Service Binding 投递注册归因"
```

### Task 9: 实现 Browser SDK 和公开路由

**Files:**
- Create: `packages/attribution/src/routes/browser.ts`
- Create: `packages/attribution/src/routes/browser.test.ts`
- Modify: `packages/attribution/src/index.ts`
- Create: `packages/web/app/adapters/registry.client.ts`
- Delete: `packages/web/app/adapters/adPlatformBrowser.client.ts`
- Delete: `packages/web/app/adapters/adPlatformBrowser.client.test.ts`
- Modify: `packages/web/app/adapters/metaPixel.client.ts`
- Modify: `packages/web/app/adapters/tiktokPixel.client.ts`
- Modify: `packages/web/app/adapters/googleAds.client.ts`
- Create: `packages/web/app/plugins/attribution.client.ts`
- Create: `packages/web/app/plugins/attribution.client.test.ts`
- Delete: `packages/web/app/plugins/ad-platform.client.ts`
- Delete: `packages/web/app/plugins/ad-platform.client.test.ts`
- Rewrite: `packages/web/app/composables/useAdAttribution.ts`
- Rewrite: `packages/web/app/composables/useAdAttribution.test.ts`
- Modify: `packages/web/app/composables/useTracking.ts`
- Modify: `packages/web/app/composables/useTracking.test.ts`
- Modify: `packages/web/app/composables/useMarketingConsent.ts`
- Modify: `packages/web/app/components/ContactMethodItem.vue`
- Modify: `packages/web/app/components/ContactPanel.vue`
- Modify: `packages/web/app/architecture-boundaries.test.ts`
- Create: `packages/web/tests/e2e/attribution-runtime.spec.ts`

**Interfaces:**
- Consumes: `/v1/context`、`/v1/runtime-config`、`/v1/events/contact`、`/v1/browser-receipts`。
- Produces: 页面初始化、Contact sendBeacon/keepalive、本地有限重试和三平台 Browser Adapter。

- [ ] **Step 1: 写 Browser 失败测试**

```ts
it('只加载可信来源对应的 Pixel', async () => {
  server.runtimeConfig.mockResolvedValue(metaRuntimeConfig)
  await plugin.start()
  expect(meta.load).toHaveBeenCalledOnce()
  expect(tiktok.load).not.toHaveBeenCalled()
  expect(google.load).not.toHaveBeenCalled()
})

it('Contact 先生成事件并发送后再导航', async () => {
  await contact.open(validContact)
  expect(beacon).toHaveBeenCalledWith(
    expect.stringContaining('/v1/events/contact'),
    expect.any(Blob),
  )
  expect(navigate).toHaveBeenCalledWith(validContact.url)
})

it('复制成功才产生 Contact，二维码展示和复制失败不产生', async () => {
  await contact.copy(validContact)
  expect(beacon).toHaveBeenCalledOnce()
  beacon.mockClear()
  clipboard.writeText.mockRejectedValueOnce(new Error('denied'))
  await expect(contact.copy(validContact)).rejects.toThrow()
  await contact.showQr(validContact)
  expect(beacon).not.toHaveBeenCalled()
})

it('GPC 或地区策略未授权时不加载任何平台脚本', async () => {
  server.privacyDecision.mockResolvedValue({ state: 'denied', source: 'gpc' })
  await plugin.start()
  expect(meta.load).not.toHaveBeenCalled()
  expect(tiktok.load).not.toHaveBeenCalled()
  expect(google.load).not.toHaveBeenCalled()
})

it('建立上下文时不读取 token 响应体且所有跨子域请求携带 credentials', async () => {
  await plugin.start()
  expect(server.contextRequest).toMatchObject({ credentials: 'include' })
  expect(server.runtimeConfigRequest).toMatchObject({ credentials: 'include' })
  expect(plugin.exposedState()).not.toHaveProperty('sourceContextToken')
})

it('业务 Tracking 只把 Contact 委托给唯一归因 facade 一次', async () => {
  await tracking.trackContact(validContact)
  expect(firstPartyAnalytics.trackContact).toHaveBeenCalledOnce()
  expect(adAttribution.trackContact).toHaveBeenCalledOnce()
  expect(api.callsTo('/api/conversions/contact')).toHaveLength(0)
  expect(api.callsTo('/api/ad-attribution')).toHaveLength(0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/plugins/attribution.client.test.ts app/composables/useAdAttribution.test.ts app/composables/useTracking.test.ts app/architecture-boundaries.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/routes/browser.test.ts
```

Expected: FAIL，新插件和公开路由不存在。

- [ ] **Step 3: 实现公开路由和 SDK**

路由固定为：

```ts
browserRoutes.put('/v1/context', resolveAndIssueContext)
browserRoutes.get('/v1/privacy-decision', resolveRequestPrivacyDecision)
browserRoutes.put('/v1/privacy-decision', saveExplicitPrivacyDecision)
browserRoutes.get('/v1/runtime-config', returnSignedRuntimeConfig)
browserRoutes.post('/v1/events/contact', recordSignedContact)
browserRoutes.post('/v1/browser-receipts', recordReceipt)
```

`recordSignedContact` 只接受 `open_link` 或 `copy`，并验证 Task 8 签发的联系人 capability；
`open_link` 还必须通过 URL scheme 校验。Web 仅在 Clipboard Promise 成功后提交 `copy`。
展开面板、展示二维码、复制失败、过期或篡改 capability、空目标和不安全 URL 均返回零事实。

SDK 本地重试只保存：

```ts
interface PendingAttributionEvent {
  eventId: string
  endpoint: '/v1/events/contact' | '/v1/browser-receipts'
  body: string
  occurredAt: string
  expiresAt: string
  attemptCount: number
}
```

不得保存凭证、原始 proof、IP、UA 或平台 Cookie。超过 24 小时或 5 次失败立即删除。

Browser 所有权固定为：

```text
ContactMethodItem/ContactPanel
  -> useTracking（业务分析）
  -> useAdAttribution（唯一归因 facade）
  -> attribution.client（上下文与生命周期）
  -> adapters/registry.client（唯一平台分派）
  -> 单个 provider adapter
```

`useTracking` 可以继续记录第一方分析，但不得直接调用平台 Adapter、旧 `/api/conversions/*`、
旧 `/api/ad-attribution*` 或解析平台指令；一次用户动作只能调用
`useAdAttribution.trackContact()` 一次。`CompleteRegistration` 只接受注册成功响应中的
`attributionInstructionToken`，同一个 token 由 facade 幂等消费一次，客户端不得自行构造注册事件。
`adPlatformBrowser.client.*` 和 `ad-platform.client.*` 在同一任务删除，禁止保留代理兼容层。
架构测试扫描所有非测试 Web 源码，确保只有 `registry.client.ts` 可以导入 provider adapter，
只有 `attribution.client.ts` 可以管理初始化和 teardown。

- [ ] **Step 4: 运行 Browser、E2E 和隔离测试**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/plugins/attribution.client.test.ts app/composables/useAdAttribution.test.ts app/composables/useTracking.test.ts app/adapters app/architecture-boundaries.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/routes/browser.test.ts
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/attribution-runtime.spec.ts
```

Expected: PASS；Meta 来源只出现 Meta 网络请求，TikTok 和 Google 请求数为 `0`，其他矩阵同理。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src/routes packages/attribution/src/index.ts packages/web/app/adapters packages/web/app/plugins packages/web/app/composables/useAdAttribution* packages/web/app/composables/useTracking* packages/web/app/composables/useMarketingConsent* packages/web/app/components/ContactMethodItem.vue packages/web/app/components/ContactPanel.vue packages/web/app/architecture-boundaries.test.ts packages/web/tests/e2e/attribution-runtime.spec.ts
git commit -m "feat: 完成归因 Browser 与 Server 配对"
```

### Task 10: 完成阶段回归与容量保护

**Files:**
- Create: `packages/attribution/src/services/capacity-monitor.ts`
- Create: `packages/attribution/src/services/capacity-monitor.test.ts`
- Create: `packages/attribution/src/services/quality-collector.ts`
- Create: `packages/attribution/src/services/quality-collector.test.ts`
- Create: `packages/attribution/src/attribution-isolation.test.ts`
- Modify: `packages/attribution/src/index.ts`

**Interfaces:**
- Consumes: 每日事实、delivery、Queue 和 D1 使用聚合。
- Produces: 70%、85%、95% 容量告警、平台质量日报和阶段验收。

- [ ] **Step 1: 写容量阈值失败测试**

```ts
it.each([
  [69, 'ok'],
  [70, 'warning'],
  [85, 'high'],
  [95, 'critical'],
])('使用率 %s%%', (ratio, level) => {
  expect(capacityLevel(ratio / 100)).toBe(level)
})

it('质量 API 无权限只记录 unavailable 且不修改运行策略', async () => {
  adapter.readQualitySignal.mockResolvedValue({
    availability: 'unavailable',
    reason: 'permission_denied',
  })
  const before = await readRuntimePolicy(db, 'conn_meta_a')
  await collectQualitySignals(env, operationDate)
  expect(await latestQuality(db, 'conn_meta_a')).toMatchObject({
    availability: 'unavailable',
  })
  expect(await readRuntimePolicy(db, 'conn_meta_a')).toEqual(before)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/capacity-monitor.test.ts src/services/quality-collector.test.ts src/attribution-isolation.test.ts
```

Expected: FAIL，容量服务不存在。

- [ ] **Step 3: 实现日报聚合与边界扫描**

容量服务只读取按日聚合，不做后台全表扫描。质量收集器通过 Adapter 注册表逐连接调用
`readQualitySignal()`，把 `available`、`unavailable` 或 `error` 写入日报；任何结果都不得调用
运行策略命令。`attribution-isolation.test.ts` 必须扫描核心服务并拒绝平台分支、业务 API
import、Git commit 字段和跨 provider Queue 使用。
边界扫描还必须拒绝 `packages/attribution/src/**` 非测试源码出现生产/dev 域名字符串或
`APP_ENV === 'production'` 域名选择逻辑；Origin 与 Cookie domain 只能来自已校验 bindings。

容量分母使用 Cloudflare 账户级 Free 额度，不把三个归因 Queue 分别按 10,000 operations 计算。
一条小于 64KB 且成功消费的消息按 write、read、delete 至少计 3 次操作，retry 和 DLQ 另计；
本地日报采用实际 operations，不用消息数代替。达到 85% 后停止非必要 synthetic/质量请求；
达到 95% 后 Server 新 delivery 留在加密 D1 outbox 等待 UTC 日额度重置，Browser 保持运行，
不得丢弃事实、伪装成功或跨平台改投。Queue Free 仅保留 24 小时，因此恢复任务必须优先处理
最早 outbox，并在 `expiresAt` 前仍未恢复时创建 critical Incident。

Attribution scheduled handler 每 15 分钟依次执行 `retireDrainedVersions()`、过期 outbox 恢复和
credential retention；每日执行质量与容量聚合。单项失败记录结构化 Incident，后续任务仍继续。

- [ ] **Step 4: 运行阶段门禁**

Run:

```bash
corepack pnpm --filter @meigallery/attribution test
corepack pnpm --filter @meigallery/attribution typecheck
corepack pnpm --filter @meigallery/attribution build
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
git diff --check
```

Expected: 全部退出码为 `0`；构建仍未切换生产路由。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution
git commit -m "test: 完成归因事件投递阶段门禁"
```
