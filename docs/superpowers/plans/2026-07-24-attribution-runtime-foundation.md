# 归因运行时基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可独立部署的 Attribution Worker、独立 D1 基线 Schema、不可变连接版本状态机、加密凭证仓库和独立运行策略。

**Architecture:** `packages/attribution` 成为归因数据和配置的唯一所有者；主 API 不直接访问归因 D1。身份配置通过候选版本状态机写入，运行开关和 rollout 使用另一套命令，二者共享稳定 `connection_id` 但没有交叉写权限。

**Tech Stack:** TypeScript 6、Hono 4、Cloudflare Workers、D1、Vitest 4、Miniflare 4、pnpm workspace。

## Global Constraints

- 本计划不接入真实平台、不切生产流量，只建立隔离运行时。
- 新 Worker 名称为 `meigallery-attribution`，新 D1 名称为 `meigallery-attribution-db`。
- `dev/local` 使用 `meigallery-attribution-dev` 和 `meigallery-attribution-db-dev`。
- 身份版本一经创建，公开配置、凭证和事件映射不可修改。
- 运行策略不得修改 `active_version_id`、版本、凭证或事件映射。
- Git commit 和 Worker 版本不得进入任何领域表或状态判断。
- 凭证明文不得写入 D1、日志、审计、异常文本或 API 响应。
- 采用 TDD；每个任务形成独立中文 commit。

---

## 文件结构

```text
packages/shared/src/types/attribution-runtime.ts
packages/shared/src/types/index.ts
packages/attribution/package.json
packages/attribution/tsconfig.json
packages/attribution/vitest.config.ts
packages/attribution/wrangler.toml
packages/attribution/src/env.ts
packages/attribution/src/index.ts
packages/attribution/src/domain/connection.ts
packages/attribution/src/domain/errors.ts
packages/attribution/src/domain/normalization.ts
packages/attribution/src/repositories/connection-repository.ts
packages/attribution/src/services/credential-vault.ts
packages/attribution/src/services/connection-commands.ts
packages/attribution/src/services/runtime-policy-commands.ts
packages/attribution/src/test/cloudflare-workers.ts
packages/attribution/src/**/*.test.ts
packages/attribution/migrations/0001_attribution_runtime.sql
packages/attribution/migrations/0001_attribution_runtime.test.mjs
```

### Task 1: 建立版本化共享契约

**Files:**
- Create: `packages/shared/src/types/attribution-runtime.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/types/attribution-runtime.test.ts`

**Interfaces:**
- Consumes: 现有 `AdAttributionProvider`、`CanonicalConversionEvent` 和 `PlatformPublicConfig`。
- Produces: `AttributionProvider`、`ConnectionVersionStatus`、`AttributionBusinessEventV1`、`AttributionRuntimeLeaseV1`、`AttributionServiceContractV1`。

- [x] **Step 1: 写契约失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_CONTRACT_VERSION,
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
} from './attribution-runtime'

describe('attribution runtime contract', () => {
  it('只接受版本 1 的两个 Canonical Event', () => {
    const contact: AttributionBusinessEventV1 = {
      schemaVersion: 1,
      eventId: 'evt_01',
      eventName: 'Contact',
      occurredAt: '2026-07-24T00:00:00.000Z',
      dedupeKey: 'contact:s1:telegram:c1',
      sourceContextToken: 'ctx_token',
      consent: { marketingAllowed: true, adUserDataAllowed: true, adPersonalizationAllowed: false },
      payload: {
        contactMethodId: 'c1',
        contactPlatform: 'telegram',
        contactAction: 'open_link',
      },
    }
    expect(ATTRIBUTION_CONTRACT_VERSION).toBe(1)
    expect(isAttributionBusinessEventV1(contact)).toBe(true)
    expect(isAttributionBusinessEventV1({ ...contact, sourceContextToken: null })).toBe(true)
    expect(isAttributionBusinessEventV1({ ...contact, sourceContextToken: 123 })).toBe(false)
    expect(isAttributionBusinessEventV1({ ...contact, eventName: 'PageView' })).toBe(false)
    expect(isAttributionBusinessEventV1({ ...contact, schemaVersion: 2 })).toBe(false)
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/shared exec vitest run src/types/attribution-runtime.test.ts
```

Expected: FAIL，提示无法解析 `./attribution-runtime`。

- [x] **Step 3: 实现共享契约**

```ts
import type { AdAttributionProvider, CanonicalConversionEvent } from './ad-attribution'

export const ATTRIBUTION_CONTRACT_VERSION = 1 as const
export type AttributionProvider = AdAttributionProvider
export type ConnectionVersionStatus =
  | 'candidate' | 'validating' | 'ready' | 'active'
  | 'draining' | 'failed' | 'superseded' | 'retired'

export interface AttributionBusinessEventV1 {
  schemaVersion: 1
  eventId: string
  eventName: CanonicalConversionEvent
  occurredAt: string
  dedupeKey: string
  sourceContextToken: string | null
  consent: {
    marketingAllowed: boolean
    adUserDataAllowed: boolean
    adPersonalizationAllowed: boolean
  }
  payload:
    | {
        contactMethodId: string
        contactPlatform: string
        contactAction: 'open_link' | 'copy'
      }
    | { userId: number; hashedEmail?: string }
}

export interface AttributionRuntimeLeaseV1 {
  schemaVersion: 1
  connectionId: string
  versionId: string
  provider: AttributionProvider
  issuedAt: number
  expiresAt: number
  signature: string
}

export interface AttributionServiceContractV1 {
  ingestRegistrationEvent(input: AttributionBusinessEventV1): Promise<{ accepted: true; eventId: string }>
  dispatchBusinessOutbox(input: { limit: number }): Promise<{ claimed: number; accepted: number }>
  getSignedBrowserInstruction(input: { eventId: string }): Promise<{ instructionToken: string }>
}

export function isAttributionBusinessEventV1(value: unknown): value is AttributionBusinessEventV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.schemaVersion === 1
    && (item.eventName === 'Contact' || item.eventName === 'CompleteRegistration')
    && typeof item.eventId === 'string' && item.eventId.length > 0
    && typeof item.dedupeKey === 'string' && item.dedupeKey.length > 0
    && typeof item.occurredAt === 'string' && Number.isFinite(Date.parse(item.occurredAt))
    && (item.sourceContextToken === null
      || (typeof item.sourceContextToken === 'string' && item.sourceContextToken.length > 0))
    && isConsentV1(item.consent)
    && isCanonicalPayload(item.eventName, item.payload)
}

function isConsentV1(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const consent = value as Record<string, unknown>
  return typeof consent.marketingAllowed === 'boolean'
    && typeof consent.adUserDataAllowed === 'boolean'
    && typeof consent.adPersonalizationAllowed === 'boolean'
}

function isCanonicalPayload(eventName: unknown, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (eventName === 'Contact') {
    return typeof payload.contactMethodId === 'string'
      && typeof payload.contactPlatform === 'string'
      && (payload.contactAction === 'open_link' || payload.contactAction === 'copy')
  }
  return eventName === 'CompleteRegistration'
    && Number.isInteger(payload.userId)
    && (payload.hashedEmail === undefined || typeof payload.hashedEmail === 'string')
}
```

在 `packages/shared/src/types/index.ts` 增加：

```ts
export * from './attribution-runtime'
```

- [x] **Step 4: 运行共享包测试和类型检查**

Run:

```bash
corepack pnpm --filter @meigallery/shared exec vitest run src/types/attribution-runtime.test.ts
corepack pnpm --filter @meigallery/shared exec tsc --noEmit
```

Expected: PASS，退出码为 `0`。

- [x] **Step 5: 提交**

```bash
git add packages/shared/src/types
git commit -m "feat: 建立归因运行时版本化契约"
```

### Task 2: 创建独立 Attribution Worker

**Files:**
- Create: `packages/attribution/package.json`
- Create: `packages/attribution/tsconfig.json`
- Create: `packages/attribution/vitest.config.ts`
- Create: `packages/attribution/wrangler.toml`
- Create: `packages/attribution/src/env.ts`
- Create: `packages/attribution/src/index.ts`
- Create: `packages/attribution/src/index.test.ts`

**Interfaces:**
- Consumes: `@meigallery/shared` 契约。
- Produces: 独立 Worker `app`、`AttributionBindings` 和 `/health`。

- [x] **Step 1: 写 Worker 失败测试**

```ts
import { describe, expect, it } from 'vitest'
import app from './index'

describe('attribution worker', () => {
  it('健康检查不依赖业务 API', async () => {
    const response = await app.request('/health', {}, {
      APP_ENV: 'local',
      ATTRIBUTION_PUBLIC_ORIGINS: 'http://localhost:3000',
      ATTRIBUTION_COOKIE_DOMAIN: '',
      DB: {} as D1Database,
      ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: 'test-key',
      ATTRIBUTION_SIGNING_KEY: 'test-signing-key',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      service: 'meigallery-attribution',
      status: 'ok',
      contractVersion: 1,
    })
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution test
```

Expected: FAIL，workspace 中尚不存在 `@meigallery/attribution`。

- [x] **Step 3: 创建包与 Worker**

`packages/attribution/package.json`：

```json
{
  "name": "@meigallery/attribution",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "wrangler deploy --env=\"\" --dry-run --outdir=dist",
    "deploy": "wrangler deploy --env=\"\"",
    "dev": "wrangler dev"
  },
  "dependencies": {
    "@meigallery/shared": "workspace:*",
    "hono": "^4.12.29"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260712.1",
    "miniflare": "4.20260708.1",
    "typescript": "^6.0.3",
    "vitest": "^4.1.10",
    "wrangler": "^4.110.0"
  }
}
```

`packages/attribution/src/env.ts`：

```ts
export interface AttributionBindings {
  DB: D1Database
  APP_ENV: 'production' | 'dev' | 'local'
  ATTRIBUTION_PUBLIC_ORIGINS: string
  ATTRIBUTION_COOKIE_DOMAIN: string
  ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: string
  ATTRIBUTION_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
  ATTRIBUTION_SIGNING_KEY: string
}
```

`packages/attribution/src/index.ts`：

```ts
import { ATTRIBUTION_CONTRACT_VERSION } from '@meigallery/shared'
import { Hono } from 'hono'
import type { AttributionBindings } from './env'

const app = new Hono<{ Bindings: AttributionBindings }>()

app.get('/health', c => c.json({
  service: 'meigallery-attribution',
  status: 'ok',
  contractVersion: ATTRIBUTION_CONTRACT_VERSION,
}))

export default app
```

`wrangler.toml` 只声明独立 Worker 和独立 D1，暂不声明平台 Queue：

```toml
name = "meigallery-attribution"
main = "src/index.ts"
compatibility_date = "2026-05-26"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

[[d1_databases]]
binding = "DB"
database_name = "meigallery-attribution-db"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[vars]
APP_ENV = "production"
ATTRIBUTION_PUBLIC_ORIGINS = "https://616618.xyz,https://www.616618.xyz"
ATTRIBUTION_COOKIE_DOMAIN = ".616618.xyz"

[env.dev]
name = "meigallery-attribution-dev"
workers_dev = true

[env.dev.vars]
APP_ENV = "dev"
ATTRIBUTION_PUBLIC_ORIGINS = "http://localhost:3000"
ATTRIBUTION_COOKIE_DOMAIN = ""
```

`00000000-0000-0000-0000-000000000000` 是仅允许 local/dry-run 的固定 sentinel。
Task 8 的部署脚本在检测到该值时必须退出并输出
`ATTRIBUTION_D1_RESOURCE_NOT_PROVISIONED`；生产迁移计划 Task 1 会以 Cloudflare 返回的真实
database ID 原子替换该值。
域名和 Origin 只出现在对应 Wrangler 环境配置，非测试 `src/**` 不得出现
`616618.xyz`、`localhost:3000` 或基于 `APP_ENV` 选择域名的条件分支。启动时解析并校验
`ATTRIBUTION_PUBLIC_ORIGINS`；空值、非法 URL、通配符或生产环境空 Cookie domain 必须 fail closed。

- [x] **Step 4: 安装 workspace lockfile 并验证**

Run:

```bash
corepack pnpm install --lockfile-only
corepack pnpm --filter @meigallery/attribution test
corepack pnpm --filter @meigallery/attribution typecheck
```

Expected: 健康检查 PASS，类型检查退出码为 `0`。

- [x] **Step 5: 提交**

```bash
git add packages/attribution pnpm-lock.yaml
git commit -m "feat: 创建独立归因 Worker"
```

### Task 3: 建立单一基线 Schema

**Files:**
- Create: `packages/attribution/migrations/0001_attribution_runtime.sql`
- Create: `packages/attribution/migrations/0001_attribution_runtime.test.mjs`
- Create: `packages/attribution/src/test/attribution-schema.ts`

**Interfaces:**
- Consumes: Task 1 的状态枚举。
- Produces: 连接、版本、凭证、映射、运行策略、幂等回执、审计和 Incident 的唯一新 Schema。

- [x] **Step 1: 写 Schema 失败测试**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('./0001_attribution_runtime.sql', import.meta.url), 'utf8')

test('基线 Schema 不包含 Git 或旧 revision 门禁', () => {
  assert.doesNotMatch(migration, /release_commit|verified_commit|connection_revision|credential_revision/i)
  for (const table of [
    'attribution_connections',
    'attribution_connection_versions',
    'attribution_version_credentials',
    'attribution_version_bindings',
    'attribution_runtime_policies',
    'attribution_command_receipts',
    'attribution_audit_logs',
    'attribution_incidents',
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
node --test packages/attribution/migrations/0001_attribution_runtime.test.mjs
```

Expected: FAIL，迁移文件不存在。

- [x] **Step 3: 编写基线迁移**

迁移必须包含以下核心约束，字段名保持一致：

```sql
CREATE TABLE attribution_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  active_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX attribution_connections_provider_name
  ON attribution_connections(provider, name);
CREATE UNIQUE INDEX attribution_connections_one_default
  ON attribution_connections(provider) WHERE is_default = 1;

CREATE TABLE attribution_connection_versions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_connections(id),
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  base_active_version_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate','validating','ready','active','draining','failed','superseded','retired')),
  public_config_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  validated_at TEXT,
  activated_at TEXT,
  draining_at TEXT,
  retired_at TEXT,
  failure_code TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX attribution_versions_one_live_candidate
  ON attribution_connection_versions(connection_id)
  WHERE status IN ('candidate','validating','ready');

CREATE TABLE attribution_version_credentials (
  version_id TEXT PRIMARY KEY REFERENCES attribution_connection_versions(id),
  provider TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  destroy_after TEXT
);

CREATE TABLE attribution_version_bindings (
  version_id TEXT NOT NULL REFERENCES attribution_connection_versions(id),
  canonical_event TEXT NOT NULL CHECK (canonical_event IN ('Contact','CompleteRegistration')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  browser_destination TEXT NOT NULL,
  server_destination TEXT NOT NULL,
  PRIMARY KEY (version_id, canonical_event)
);

CREATE TABLE attribution_runtime_policies (
  connection_id TEXT PRIMARY KEY REFERENCES attribution_connections(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  browser_enabled INTEGER NOT NULL CHECK (browser_enabled IN (0,1)),
  server_enabled INTEGER NOT NULL CHECK (server_enabled IN (0,1)),
  server_target_percentage INTEGER NOT NULL CHECK (server_target_percentage IN (0,10,50,100)),
  server_effective_percentage INTEGER NOT NULL CHECK (server_effective_percentage IN (0,10,50,100)),
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('closed','server_open')),
  runtime_generation INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_activation_fences (
  connection_id TEXT PRIMARY KEY,
  candidate_version_id TEXT NOT NULL,
  expected_active_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_incidents (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  code TEXT NOT NULL,
  affected_transport TEXT NOT NULL,
  affected_fact_count INTEGER NOT NULL DEFAULT 0,
  affected_delivery_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution TEXT NOT NULL DEFAULT ''
);
```

- [x] **Step 4: 运行 Schema 测试和本地迁移**

Run:

```bash
node --test packages/attribution/migrations/0001_attribution_runtime.test.mjs
corepack pnpm --filter @meigallery/attribution exec wrangler d1 migrations apply meigallery-attribution-db --local
```

Expected: 测试 PASS，Wrangler 输出 `1 migration applied`。

- [x] **Step 5: 提交**

```bash
git add packages/attribution/migrations packages/attribution/src/test
git commit -m "feat: 建立归因运行时基线数据库"
```

### Task 4: 实现凭证加密仓库

**Files:**
- Create: `packages/attribution/src/services/credential-vault.ts`
- Create: `packages/attribution/src/services/credential-vault.test.ts`
- Create: `packages/attribution/src/services/credential-retention.ts`
- Create: `packages/attribution/src/services/credential-retention.d1.test.ts`
- Create: `packages/attribution/src/domain/errors.ts`

**Interfaces:**
- Consumes: `ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT`。
- Produces: `sealCredential()`、`openCredential()`、`fingerprintCredential()`；只返回密文或内存明文。

- [x] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { openCredential, sealCredential } from './credential-vault'

describe('credential vault', () => {
  it('使用 version/provider 作为 AAD 且不把明文放入 envelope', async () => {
    const keys = { current: '0123456789abcdef0123456789abcdef' }
    const envelope = await sealCredential(keys, {
      versionId: 'ver_1',
      provider: 'meta',
      plaintext: 'secret-token',
    })
    expect(JSON.stringify(envelope)).not.toContain('secret-token')
    await expect(openCredential(keys, {
      versionId: 'ver_2',
      provider: 'meta',
      envelope,
    })).rejects.toThrow('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
    expect(await openCredential(keys, {
      versionId: 'ver_1',
      provider: 'meta',
      envelope,
    })).toBe('secret-token')
  })
})

it('只保留最近一个 retired 凭证且最多 7 天', async () => {
  await retireVersion(db, 'ver_oldest', '2026-07-01T00:00:00.000Z')
  await retireVersion(db, 'ver_latest', '2026-07-24T00:00:00.000Z')
  await enforceCredentialRetention(db, new Date('2026-07-24T00:00:00.000Z'))
  expect(await credentialExists(db, 'ver_oldest')).toBe(false)
  expect(await credentialDestroyAfter(db, 'ver_latest'))
    .toBe('2026-07-31T00:00:00.000Z')
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/credential-vault.test.ts src/services/credential-retention.d1.test.ts
```

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现 AES-GCM 与 HMAC 指纹**

实现固定签名：

```ts
export interface CredentialEnvelope {
  schemaVersion: 1
  keyId: string
  iv: string
  ciphertext: string
  tag: string
  fingerprint: string
}

export async function sealCredential(
  keys: { current: string },
  input: { versionId: string; provider: AttributionProvider; plaintext: string },
): Promise<CredentialEnvelope>

export async function openCredential(
  keys: { current: string; previous?: string },
  input: { versionId: string; provider: AttributionProvider; envelope: CredentialEnvelope },
): Promise<string>

export async function fingerprintCredential(
  key: string,
  plaintext: string,
): Promise<string>
```

AAD 必须严格为：

```ts
const aad = new TextEncoder().encode(
  `credential:v1:${input.provider}:${input.versionId}`,
)
```

解密失败统一抛出不含原始错误的 `AttributionDomainError('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')`。

`enforceCredentialRetention()` 对每个 connection 只保留最近一个 `retired` 版本的密文，并把
`destroy_after` 固定为 `retired_at + 7 days`；更早 retired 版本的 credential 当次事务立即删除。
到期 Cron 删除最后一个 retired credential，但不得删除当前 `active` 或 `draining` credential。

- [x] **Step 4: 运行测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/credential-vault.test.ts src/services/credential-retention.d1.test.ts
```

Expected: PASS，且测试输出不包含 `secret-token`。

- [x] **Step 5: 提交**

```bash
git add packages/attribution/src/services/credential-vault* packages/attribution/src/services/credential-retention* packages/attribution/src/domain/errors.ts
git commit -m "feat: 隔离归因凭证加密仓库"
```

### Task 5: 实现连接读模型与标准化哈希

**Files:**
- Create: `packages/attribution/src/domain/connection.ts`
- Create: `packages/attribution/src/domain/normalization.ts`
- Create: `packages/attribution/src/domain/normalization.test.ts`
- Create: `packages/attribution/src/repositories/connection-repository.ts`
- Create: `packages/attribution/src/repositories/connection-repository.test.ts`

**Interfaces:**
- Consumes: Task 3 Schema、Task 4 凭证 envelope。
- Produces: `normalizeCandidateInput()`、`hashCandidateIdentity()`、`readConnectionAggregate()`。

- [x] **Step 1: 写标准化与快照失败测试**

```ts
it('字段顺序和空白不同但语义相同的候选得到相同 hash', async () => {
  const first = await hashCandidateIdentity(normalizeCandidateInput({
    provider: 'meta',
    publicConfig: { pixelId: ' 1615446443914929 ' },
    bindings: [
      { canonicalEvent: 'Contact', enabled: true, browserDestination: 'meta_pixel', serverDestination: 'meta_capi' },
      { canonicalEvent: 'CompleteRegistration', enabled: true, browserDestination: 'meta_pixel', serverDestination: 'meta_capi' },
    ],
    credentialFingerprint: 'fp_1',
  }))
  const second = await hashCandidateIdentity(normalizeCandidateInput({
    provider: 'meta',
    publicConfig: { pixelId: '1615446443914929' },
    bindings: [
      { canonicalEvent: 'CompleteRegistration', enabled: true, browserDestination: 'meta_pixel', serverDestination: 'meta_capi' },
      { canonicalEvent: 'Contact', enabled: true, browserDestination: 'meta_pixel', serverDestination: 'meta_capi' },
    ],
    credentialFingerprint: 'fp_1',
  }))
  expect(second).toBe(first)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/domain/normalization.test.ts src/repositories/connection-repository.test.ts
```

Expected: FAIL，函数尚未定义。

- [x] **Step 3: 实现领域类型和稳定哈希**

`normalizeCandidateInput()` 必须：

```ts
return {
  provider: input.provider,
  publicConfig: Object.fromEntries(
    Object.entries(input.publicConfig).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value.trim()]),
  ),
  bindings: [...input.bindings].sort((a, b) =>
    a.canonicalEvent.localeCompare(b.canonicalEvent)),
  credentialFingerprint: input.credentialFingerprint,
}
```

`hashCandidateIdentity()` 使用 SHA-256 和稳定 JSON；仓库一次读取 connection、active version、live candidate、runtime policy、bindings、credential metadata，并把重复行或 provider 不一致视为 `ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID`。

- [x] **Step 4: 运行测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/domain/normalization.test.ts src/repositories/connection-repository.test.ts
```

Expected: PASS，包括 provider 不一致和重复 credential 行拒绝用例。

- [x] **Step 5: 提交**

```bash
git add packages/attribution/src/domain packages/attribution/src/repositories
git commit -m "feat: 建立归因连接聚合读模型"
```

### Task 6: 实现候选创建和原子激活状态机

**Files:**
- Create: `packages/attribution/src/services/connection-commands.ts`
- Create: `packages/attribution/src/services/connection-commands.test.ts`
- Create: `packages/attribution/src/services/connection-commands.d1.test.ts`

**Interfaces:**
- Consumes: `readConnectionAggregate()`、凭证仓库和候选哈希。
- Produces: `createConnection()`、`createCandidate()`、`beginCandidateValidation()`、`markCandidateReady()`、`activateCandidate()`、`rollbackActiveVersion()`、`disableConnection()`。

- [x] **Step 1: 写状态机失败测试**

必须覆盖以下表驱动用例：

```ts
it.each([
  ['candidate', 'validating', true],
  ['validating', 'ready', true],
  ['ready', 'active', true],
  ['active', 'draining', true],
  ['draining', 'retired', true],
  ['candidate', 'active', false],
  ['failed', 'active', false],
  ['retired', 'active', false],
])('%s -> %s 是否允许', (from, to, allowed) => {
  expect(canTransitionConnectionVersion(from, to)).toBe(allowed)
})
```

D1 测试必须证明：

```ts
expect(await activeVersionId(db, connectionId)).toBe(oldActiveId)
await expect(activateCandidate(db, {
  connectionId,
  candidateId,
  expectedBaseActiveVersionId: 'other_active',
  idempotencyKey: 'activate-1',
  actorId: 1,
})).rejects.toThrow('ATTRIBUTION_ACTIVE_VERSION_CHANGED')
expect(await activeVersionId(db, connectionId)).toBe(oldActiveId)
```

还必须覆盖：

```ts
it('新候选 supersede 旧候选且同 provider 可有多个连接', async () => {
  const first = await commands.createCandidate(candidateInput('conn_meta_a', 'pixel-a'))
  const second = await commands.createCandidate(candidateInput('conn_meta_a', 'pixel-b'))
  expect((await version(db, first.id)).status).toBe('superseded')
  expect((await version(db, second.id)).status).toBe('candidate')
  await commands.createConnection(connectionInput('conn_meta_b', 'meta', false))
  expect(await connectionCount(db, 'meta')).toBe(2)
})

it('同 provider 不允许两个默认连接', async () => {
  await commands.createConnection(connectionInput('conn_meta_a', 'meta', true))
  await expect(commands.createConnection(connectionInput('conn_meta_b', 'meta', true)))
    .rejects.toThrow('ATTRIBUTION_DEFAULT_CONNECTION_CONFLICT')
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/connection-commands.test.ts src/services/connection-commands.d1.test.ts
```

Expected: FAIL，命令未实现。

- [x] **Step 3: 实现唯一写入口**

导出固定接口：

```ts
export interface AttributionConnectionCommands {
  createConnection(input: CreateConnectionInput): Promise<ConnectionView>
  createCandidate(input: CreateCandidateInput): Promise<CandidateView>
  beginCandidateValidation(input: BeginValidationInput): Promise<CandidateView>
  markCandidateReady(input: MarkReadyInput): Promise<CandidateView>
  activateCandidate(input: ActivateCandidateInput): Promise<ConnectionView>
  rollbackActiveVersion(input: RollbackInput): Promise<ConnectionView>
  disableConnection(input: DisableConnectionInput): Promise<RuntimePolicyView>
}
```

幂等实现规则：

```ts
if (active?.configHash === requestHash) return activeView
if (liveCandidate?.configHash === requestHash) return candidateView(liveCandidate)
const receipt = await readCommandReceipt(input.idempotencyKey)
if (receipt) {
  if (receipt.requestHash !== requestHash) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  return JSON.parse(receipt.resultJson)
}
```

激活 batch 必须先插入 `attribution_activation_fences`。该表的 `BEFORE INSERT` trigger 使用
`RAISE(ABORT, 'ATTRIBUTION_ACTIVE_VERSION_CHANGED')` 校验候选为 `ready`、候选
`base_active_version_id` 等于连接当前 `active_version_id`；随后同一 D1 atomic batch 更新旧
Active、新候选和连接指针，写审计并删除 fence。任一语句失败会回滚整个 batch，不能使用
“先更新再读取修补”的补偿流程。

- [x] **Step 4: 运行故障注入与幂等测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/connection-commands.test.ts src/services/connection-commands.d1.test.ts
```

Expected: PASS；重复候选为零新增版本、零新增审计；故障注入后旧 Active 保持不变。

- [x] **Step 5: 提交**

```bash
git add packages/attribution/src/services/connection-commands*
git commit -m "feat: 实现归因候选原子激活状态机"
```

### Task 7: 实现独立运行策略命令

**Files:**
- Create: `packages/attribution/src/services/runtime-policy-commands.ts`
- Create: `packages/attribution/src/services/runtime-policy-commands.test.ts`
- Create: `packages/attribution/src/services/runtime-policy-commands.d1.test.ts`

**Interfaces:**
- Consumes: 稳定 `connection_id` 和 Active 快照健康检查。
- Produces: `setRuntimePolicy()`、`openServerCircuit()`、`closeServerCircuit()`。

- [ ] **Step 1: 写隔离失败测试**

```ts
it('调整 rollout 不改变 Active Version', async () => {
  const before = await readConnectionAggregate(db, 'conn_meta_team_a')
  await setRuntimePolicy(env, {
    connectionId: 'conn_meta_team_a',
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    serverTargetPercentage: 50,
    idempotencyKey: 'policy-50',
    actorId: 1,
  })
  const after = await readConnectionAggregate(db, 'conn_meta_team_a')
  expect(after.connection.activeVersionId).toBe(before.connection.activeVersionId)
  expect(after.runtimePolicy.serverEffectivePercentage).toBe(50)
})
```

另写测试证明 target 降低立即生效、target 提高健康检查失败时策略整体不变、重复值零写入。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/runtime-policy-commands.test.ts src/services/runtime-policy-commands.d1.test.ts
```

Expected: FAIL，运行策略命令不存在。

- [ ] **Step 3: 实现运行策略命令**

固定健康检查接口：

```ts
export interface RuntimePromotionHealth {
  activeSnapshotReadable: boolean
  credentialDecryptable: boolean
  queueBound: boolean
  adapterConstructable: boolean
}
```

提升规则：

```ts
const effective = input.serverTargetPercentage <= current.serverEffectivePercentage
  ? input.serverTargetPercentage
  : allHealthy(await health.check(connectionId))
    ? input.serverTargetPercentage
    : current.serverEffectivePercentage
```

若 target 提高但健康检查失败，抛出 `ATTRIBUTION_RUNTIME_PROMOTION_BLOCKED`，不得部分写入 target。`openServerCircuit()` 只设置 `circuit_state='server_open'` 和 `server_effective_percentage=0`，不得修改 Browser。

- [ ] **Step 4: 运行测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/runtime-policy-commands.test.ts src/services/runtime-policy-commands.d1.test.ts
```

Expected: PASS，Active Version 在所有运行策略用例中不变。

- [ ] **Step 5: 提交**

```bash
git add packages/attribution/src/services/runtime-policy-commands*
git commit -m "feat: 分离归因运行策略命令"
```

### Task 8: 建立运行时边界与发布门禁

**Files:**
- Create: `packages/attribution/src/architecture-boundaries.test.ts`
- Create: `packages/attribution/src/scheduled.ts`
- Create: `packages/attribution/src/scheduled.test.ts`
- Modify: `packages/attribution/src/index.ts`
- Modify: `package.json`
- Modify: `scripts/deploy.sh`
- Create: `scripts/deploy-attribution.sh`
- Create: `scripts/deploy-attribution.test.mjs`

**Interfaces:**
- Consumes: 独立 package 和 Worker 配置。
- Produces: 普通部署不触碰 Attribution；归因部署只能由专属脚本触发。

- [ ] **Step 1: 写边界失败测试**

```ts
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

it('归因运行时不导入业务 API', async () => {
  const files = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true })
  for (const [path, source] of Object.entries(files)) {
    expect(String(source), path).not.toMatch(/packages\/api|@meigallery\/api/)
    expect(String(source), path).not.toMatch(/RELEASE_COMMIT|verifiedCommit/)
  }
})
```

部署脚本测试断言普通 `production` 路径不包含 `@meigallery/attribution deploy`，专属脚本只部署 attribution。
scheduled 测试使用固定时间断言到期 retired credential 被删除，Active/Draining credential 保持不变。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/architecture-boundaries.test.ts
node --test scripts/deploy-attribution.test.mjs
```

Expected: FAIL，专属脚本尚不存在。

- [ ] **Step 3: 实现专属脚本和根命令**

根 `package.json` 增加：

```json
{
  "scripts": {
    "build:attribution": "corepack pnpm --filter @meigallery/attribution build",
    "deploy:attribution": "corepack pnpm --filter @meigallery/attribution deploy",
    "test:attribution": "corepack pnpm --filter @meigallery/attribution test"
  }
}
```

`scripts/deploy-attribution.sh` 必须按顺序执行：

```bash
if rg -q '00000000-0000-0000-0000-000000000000' packages/attribution/wrangler.toml; then
  echo "ATTRIBUTION_D1_RESOURCE_NOT_PROVISIONED"
  exit 1
fi
corepack pnpm --filter @meigallery/attribution test
corepack pnpm --filter @meigallery/attribution typecheck
corepack pnpm --filter @meigallery/attribution build
corepack pnpm --filter @meigallery/attribution exec wrangler d1 migrations apply meigallery-attribution-db --remote
corepack pnpm --filter @meigallery/attribution deploy
```

普通 `scripts/deploy.sh production` 保持只部署 API 和 Web。

Attribution Worker 的 `scheduled()` 只调用归因自身维护任务：

```ts
export async function runAttributionMaintenance(env: AttributionBindings, now: Date) {
  await enforceCredentialRetention(env.DB, now)
}
```

- [ ] **Step 4: 运行阶段验收**

Run:

```bash
corepack pnpm --filter @meigallery/attribution test
corepack pnpm --filter @meigallery/attribution typecheck
corepack pnpm --filter @meigallery/attribution build
node --test scripts/deploy-attribution.test.mjs
git diff --check
```

Expected: 全部 PASS，dry-run 产物只包含 `meigallery-attribution`。

- [ ] **Step 5: 提交**

```bash
git add package.json scripts/deploy-attribution.sh scripts/deploy-attribution.test.mjs packages/attribution
git commit -m "test: 固化归因独立部署边界"
```
