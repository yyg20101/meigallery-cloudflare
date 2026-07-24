# 归因生产迁移与旧逻辑清除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有生产归因无双投递地迁移到独立 Attribution Worker，保持现有投放链接和有效配置，完成全集合对账后彻底删除主 API/Web 的旧运行代码、旧表和临时迁移桥。

**Architecture:** 先发布单写者门禁和默认 `shadow` 的新运行时，再导入不可变配置候选、来源及截至水位的匿名历史日报；旧事实绝不进入新活动事实表。候选 synthetic 验证通过后将旧写者切到 `draining`，等待在途事务排空，再执行一次不读取凭证的最终历史/来源对账。集合摘要、源配置摘要、目标凭证集合摘要全部一致后，才允许 `shadow -> bridge -> active` 和 `old -> draining -> new` 单向切换。30 分钟旧页面排空和 24 小时观察完成后删除桥接代码与旧表，Git 历史只保留迁移事实。

**Tech Stack:** Cloudflare Workers、D1、Queues、Service Bindings、Wrangler 4、Node.js、Hono、Nuxt、Vitest、Playwright。

## Global Constraints

- 依赖前三份计划全部完成并通过总计划 Gate 1 至 Gate 3。
- 生产切换前必须导出旧 API D1、新 Attribution D1 并记录 Time Travel bookmark。
- 旧凭证只能由旧 API Worker 在内存中解密，通过 Service Binding 发送给新 Worker并立即重新加密。
- 凭证明文不得进入命令参数、文件、日志、审计、响应或剪贴板。
- 暗模式不得发送普通生产 delivery，只允许带单次 Test Event Code 的 synthetic 事实。
- 切换全过程只有一个生产写者；旧入口在切换后只转发，不再创建旧事实或旧 delivery。
- 旧 Contact/CompleteRegistration 只迁移为不可投递的匿名历史日报；新 `attribution_facts` 在切换前不得存在 `fact_origin='live'`。
- 初始导入只创建 `candidate`，`active_version_id` 保持空，Server effective 固定为 0；平台 synthetic 验证成功后才可激活候选。
- 初始导入和最终对账之间必须冻结旧配置写入口；最终对账用独立 runId 绑定初始 runId，原子替换历史日报与管理来源。
- 生产执行顺序固定为：单写者门禁准备发布 → shadow 发布 → 双 D1 备份 → 初始导入 → synthetic 验证 → old draining/排空 → 最终对账 → bridge/active 切换。
- 现有 connection ID、managed source ID 和原始投放链接必须保持有效。
- 任何集合不一致、跨 provider delivery、重复 event ID 或 critical Incident 立即回滚。
- 迁移桥、owner flag、旧 Queue consumer 和旧管理 API 必须在观察期结束后删除。
- 历史 migration 文件保留为数据库升级记录，但不得被运行代码导入或视为兼容层。
- 本次完整架构发布版本固定为 `v0.5.0`；若执行前该 tag 已存在，必须先修改并重新评审本计划，禁止静默复用。

---

## 文件结构

```text
scripts/provision-attribution-resources.mjs
scripts/provision-attribution-resources.test.mjs
scripts/migrate-attribution-runtime.mjs
scripts/migrate-attribution-runtime.test.mjs
scripts/verify-attribution-cutover.mjs
scripts/verify-attribution-cutover.test.mjs
packages/api/migrations/0059_attribution_runtime_cutover.sql
packages/api/migrations/0060_drop_legacy_attribution_runtime.sql
packages/attribution/migrations/0004_runtime_state.sql
packages/api/src/services/attribution-migration-export.ts
packages/api/src/routes/admin/attribution-migration.ts
packages/attribution/src/routes/migration.ts
packages/attribution/src/services/migration-import.ts
packages/web/tests/e2e/attribution-production-contract.spec.ts
docs/DEPLOYMENT.md
docs/PROJECT_STATUS.md
```

### Task 1: 创建并固化独立 Cloudflare 资源

**Files:**
- Create: `scripts/provision-attribution-resources.mjs`
- Create: `scripts/provision-attribution-resources.test.mjs`
- Modify: `packages/attribution/wrangler.toml`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: 已登录 Wrangler 和 Cloudflare 账户。
- Produces: production/dev D1、三条 production Queue 与 DLQ、Worker 配置中的真实资源 ID。

- [x] **Step 1: 写资源计划失败测试**

```js
test('资源计划不会修改 API Worker 的 D1 或 Queue', () => {
  const plan = buildResourcePlan()
  assert.deepEqual(plan.d1.map(item => item.name), [
    'meigallery-attribution-db',
    'meigallery-attribution-db-dev',
  ])
  assert.deepEqual(plan.queues.map(item => item.name), [
    'meigallery-attribution-meta',
    'meigallery-attribution-meta-dlq',
    'meigallery-attribution-tiktok',
    'meigallery-attribution-tiktok-dlq',
    'meigallery-attribution-google',
    'meigallery-attribution-google-dlq',
  ])
  assert.ok(plan.d1.every(item => !item.name.includes('meigallery-db')))
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
node --test scripts/provision-attribution-resources.test.mjs
```

Expected: FAIL，脚本不存在。

- [x] **Step 3: 实现可重复执行的资源脚本**

脚本先调用 `wrangler d1 list --json` 和 `wrangler queues list`，只创建缺失资源；已有同名资源复用其真实 ID。当前 Wrangler 4 的 Queue 列表没有 JSON 参数，因此脚本按表头识别 `id` / `name` 列，不依赖固定列序。写入 `wrangler.toml` 时只替换 `database_id` 精确字段，并在写入后重新解析确认：

```js
const required = {
  d1: ['meigallery-attribution-db', 'meigallery-attribution-db-dev'],
  queues: [
    'meigallery-attribution-meta',
    'meigallery-attribution-meta-dlq',
    'meigallery-attribution-tiktok',
    'meigallery-attribution-tiktok-dlq',
    'meigallery-attribution-google',
    'meigallery-attribution-google-dlq',
  ],
}
```

脚本输出只包含资源名称和非敏感 ID，不输出 secret。

- [x] **Step 4: 运行 dry-run 和真实资源创建**

Run:

```bash
node scripts/provision-attribution-resources.mjs --dry-run
node scripts/provision-attribution-resources.mjs --apply
corepack pnpm --filter @meigallery/attribution build
```

Expected: dry-run 输出 `2 D1 / 6 Queues`；apply 输出每个资源 `created` 或 `reused`；构建退出码为 `0`。

- [ ] **Step 5: 首次 shadow 部署后设置独立 Secret**

首次执行时目标 Worker 尚不存在，`wrangler secret put` 不得逐次创建三个半配置版本。
本步骤与 Task 2 Step 4 连续执行：先应用 D1 migration，再由一次性 bootstrap 工具把
默认 `shadow` 代码和三把内存随机 Secret 原子部署到同一个版本。已有 Worker 时工具必须
拒绝运行，已有 Secret 只复用、不覆盖。

Run:

```bash
node scripts/bootstrap-attribution-worker.mjs --dry-run
node scripts/bootstrap-attribution-worker.mjs --apply
```

Expected: Wrangler 只部署一个 `shadow` 版本并原子配置三个 Secret；终端不得回显
secret 值。

- [x] **Step 6: 提交非敏感资源配置**

```bash
git add scripts/provision-attribution-resources* packages/attribution/wrangler.toml docs/DEPLOYMENT.md
git commit -m "deploy: 配置独立归因 Cloudflare 资源"
```

### Task 2: 部署暗模式 Attribution Worker

**Files:**
- Create: `packages/attribution/migrations/0004_runtime_state.sql`
- Create: `packages/attribution/migrations/0004_runtime_state.test.mjs`
- Modify: `packages/attribution/src/env.ts`
- Modify: `packages/attribution/src/index.ts`
- Modify: `packages/attribution/wrangler.toml`
- Create: `packages/attribution/src/runtime-mode.test.ts`
- Modify: `scripts/deploy-attribution.sh`

**Interfaces:**
- Consumes: 独立资源和 Secret。
- Produces: `runtimeMode='shadow'`，公共业务事件返回 `503 ATTRIBUTION_NOT_ACTIVE`，synthetic 验证可运行。

- [x] **Step 1: 写暗模式失败测试**

```ts
it('shadow 拒绝普通事实，bridge 只接受内部转发', async () => {
  const ordinary = await app.request('/v1/events/contact', {
    method: 'POST',
    body: JSON.stringify(contactEvent),
  }, shadowEnv)
  expect(ordinary.status).toBe(503)

  const synthetic = await internalClient.createSyntheticFact(validationEvent)
  expect(synthetic.accepted).toBe(true)

  await setRuntimeMode(db, 'bridge')
  expect((await publicClient.sendContact(contactEvent)).status).toBe(503)
  expect((await internalClient.forwardLegacyContact(contactEvent)).accepted).toBe(true)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
node --test packages/attribution/migrations/0004_runtime_state.test.mjs
corepack pnpm --filter @meigallery/attribution exec vitest run src/runtime-mode.test.ts
```

Expected: 两条命令均 FAIL，运行时状态表和模式门禁尚未实现。

- [x] **Step 3: 实现运行时模式**

`0004_runtime_state.sql` 创建 Attribution D1 单行状态表；模式只保存在该表中，不使用环境或
Git commit 决策：

```sql
CREATE TABLE attribution_runtime_state (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  mode TEXT NOT NULL CHECK (mode IN ('shadow','bridge','active')),
  activated_at TEXT
);
INSERT INTO attribution_runtime_state (id, mode) VALUES ('global', 'shadow');
```

生产 Worker 启动后默认 `shadow`。状态只允许 `shadow -> bridge -> active`；`bridge` 只接受
Service Binding 的迁移转发和 synthetic 事实，公共事件仍返回
`503 ATTRIBUTION_NOT_ACTIVE`。只有 `activateRuntime()` 领域命令能完成状态转换。

`packages/attribution/wrangler.toml` 在此阶段增加生产 Custom Domain：

```toml
routes = [
  { pattern = "track.616618.xyz", custom_domain = true }
]
```

公开路由从 `ATTRIBUTION_PUBLIC_ORIGINS` 读取精确 allowlist 并返回 credentialed CORS；
production Wrangler 配置为 `https://616618.xyz,https://www.616618.xyz`。源码不得写死域名，
Service Binding 内部路由不返回 CORS header。

- [ ] **Step 4: 应用新 D1 migration 并部署**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec wrangler d1 migrations apply ATTRIBUTION_DB --env="" --remote
./scripts/deploy-attribution.sh production
curl --fail https://track.616618.xyz/health
```

Expected: `0004_runtime_state.sql` 只应用一次；Worker 部署成功；健康检查返回 `status=ok`
和 `runtimeMode=shadow`。

- [x] **Step 5: 提交**

```bash
git add packages/attribution/migrations/0004_runtime_state.sql packages/attribution/migrations/0004_runtime_state.test.mjs packages/attribution/src/env.ts packages/attribution/src/index.ts packages/attribution/src/runtime-mode.test.ts packages/attribution/wrangler.toml scripts/deploy-attribution.sh
git commit -m "deploy: 以暗模式发布独立归因运行时"
```

### Task 3: 实现受控内存凭证迁移

**Files:**
- Create: `packages/shared/src/types/attribution-migration.ts`
- Modify: `packages/shared/src/constants/index.ts`
- Modify: `packages/api/src/services/attribution-service-client.ts`
- Create: `packages/api/src/services/attribution-migration-export.ts`
- Create: `packages/api/src/services/attribution-migration-export.test.ts`
- Create: `packages/api/src/routes/admin/attribution-migration.ts`
- Create: `packages/api/src/routes/admin/attribution-migration.test.ts`
- Create: `packages/attribution/src/services/migration-import.ts`
- Create: `packages/attribution/src/services/migration-import.d1.test.ts`
- Create: `packages/attribution/src/routes/migration.ts`
- Create: `packages/attribution/migrations/0005_migration_history.sql`
- Modify: `packages/attribution/src/index.ts`
- Create: `scripts/migrate-attribution-runtime.mjs`
- Create: `scripts/migrate-attribution-runtime.test.mjs`

**Interfaces:**
- Consumes: 旧 API D1 密文和旧 API Worker Secret。
- Produces: 新 D1 的连接候选、effective=0 的运行策略、来源 proof 不可逆摘要、全量匿名历史日报、迁移清单和最终对账回执。

- [x] **Step 1: 写明文泄露和幂等失败测试**

```ts
it('迁移响应、日志和审计不含凭证明文', async () => {
  const result = await exportAndImport(oldEnv, newBinding)
  expect(JSON.stringify(result)).not.toContain('plain-meta-token')
  expect(logger.lines.join('\n')).not.toContain('plain-meta-token')
  expect(await auditContains(db, 'plain-meta-token')).toBe(false)
})

it('重复迁移返回相同集合且零新增版本', async () => {
  const first = await importSnapshot(env, snapshot, 'migration-run-1')
  const second = await importSnapshot(env, snapshot, 'migration-run-1')
  expect(second).toEqual(first)
  expect(await countConnectionVersions(db)).toBe(first.versionCount)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-migration-export.test.ts src/routes/admin/attribution-migration.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/migration-import.d1.test.ts
node --test scripts/migrate-attribution-runtime.test.mjs
```

Expected: FAIL，迁移模块不存在。

- [x] **Step 3: 实现一次性迁移流**

旧 API 迁移服务执行：

```ts
const oldCredential = await decryptOldCredentialInMemory(oldEnvelope)
try {
  return await attributionBinding.fetch('/internal/migration/v1/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': migrationRunId,
    },
    body: JSON.stringify({
      runId: migrationRunId,
      snapshot: attachPlaintextCredentials(
        sanitizedSnapshot,
        oldCredential,
      ),
    }),
  })
}
finally {
  oldCredential = ''
}
```

禁止 `console.log(snapshot)`，禁止脚本接收 token 参数。迁移来源 proof 时把旧原始 proof 通过 Service Binding 发送，新 Worker
只保存不可逆摘要。导入保持现有 `connection_id`、source ID、配置和 rollout。
所有旧事实都按北京时间业务日迁移为匿名日汇总，`live` 映射为
`archived_live`；禁止向新 `attribution_facts` 写入旧事实，也不重放旧
Browser/Server delivery。初始导入只创建候选版本并保存期望运行策略，
实际 Server effective 为 0。旧写者排空后执行 `reconcile`，不再次读取凭证，
原子替换管理来源和历史日报。

- [x] **Step 4: 运行迁移测试**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-migration-export.test.ts src/routes/admin/attribution-migration.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/migration-import.d1.test.ts
node --test scripts/migrate-attribution-runtime.test.mjs
```

Expected: PASS，测试输出不含任何 fixture token。

- [x] **Step 5: 提交迁移能力**

```bash
git add packages/api/src/services/attribution-migration-export* packages/api/src/routes/admin/attribution-migration* packages/attribution/src/services/migration-import* packages/attribution/src/routes/migration.ts scripts/migrate-attribution-runtime*
git commit -m "feat: 安全迁移现有归因配置与凭证"
```

### Task 4: 完成迁移核验工具并准备 shadow 发布

**Files:**
- Create: `scripts/verify-attribution-cutover.mjs`
- Create: `scripts/verify-attribution-cutover.test.mjs`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: 两个生产 D1 和迁移服务。
- Produces: 可机器核验的迁移清单、集合摘要和回滚 bookmark。

- [x] **Step 1: 写 preflight 失败测试**

```js
test('preflight 要求旧写者唯一且新运行时为 shadow', async () => {
  const result = await preflight(fixture)
  assert.equal(result.oldWriter, 'active')
  assert.equal(result.newRuntimeMode, 'shadow')
  assert.equal(result.productionDeliveryCountNew, 0)
  assert.equal(result.ready, true)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
node --test scripts/verify-attribution-cutover.test.mjs
```

Expected: FAIL，核验脚本不存在。

- [x] **Step 3: 实现全集合摘要**

摘要必须包含：

```js
{
  connections: [{ id, provider, activeTargetHash, runtimePolicyHash }],
  managedSources: [{ id, connectionId, proofHash }],
  history: { rowCount, factCount, contentHash },
  pendingDeliveries: { count, idSetHash },
  incidents: { openCriticalCount },
}
```

脚本只输出 hash、count 和稳定 ID，不输出 public target 原值、凭证、proof、IP、UA 或 Cookie。

- [x] **Step 4: 将迁移协议收口为历史归档和最终对账**

要求：

- `sourceConfigurationHash` 覆盖连接、事件绑定、凭证 revision、运行策略和隐私策略。
- `credentialSetHash` 由旧 API 与新 Worker 分别从内存明文/重新加密结果独立计算，不写日志或审计。
- 初始导入和最终对账回执都包含精确 `capturedAt`、历史行数和历史事实总数。
- 核验目标活动事实必须为 0，来源、历史、隐私、配置和凭证摘要全部一致。

- [ ] **Step 5: 先合入单写者门禁和 shadow 准备版本**

禁止在 Task 5 完成前执行任何生产数据迁移。准备版本只创建 migration 路由、
owner/epoch 门禁和默认 `shadow` Worker；不得改变旧生产归因写者。

- [ ] **Step 6: 执行生产备份和初始迁移**

Run:

```bash
node scripts/export-production-d1-backup.mjs
corepack pnpm --filter @meigallery/attribution exec wrangler d1 time-travel info meigallery-attribution-db --env=""
node scripts/migrate-attribution-runtime.mjs
node scripts/migrate-attribution-runtime.mjs --phase initial
node scripts/verify-attribution-cutover.mjs migrated
```

Expected: 输出旧 API D1 backup 路径、Attribution D1 bookmark、`MIGRATION_SET_MATCHED`；新运行时仍为 `shadow`，候选未激活、普通 production delivery 和活动事实均为 `0`。

- [ ] **Step 7: 执行三平台可用连接的 synthetic 测试**

Run:

```bash
node scripts/verify-attribution-cutover.mjs synthetic --prompt-test-codes
```

Expected: 每个已配置且启用的连接都完成 `Contact` 和 `CompleteRegistration` synthetic 事实；未配置平台明确显示 `SKIPPED_NOT_CONFIGURED`；测试事实不进入业务指标。

脚本只在 TTY 中无回显读取当前平台测试码，直接调用候选验证入口；测试码不进入命令参数、环境变量、
文件或输出，验证终态后新 D1 的临时密文立即删除。

- [ ] **Step 8: 冻结旧写者并执行最终对账**

Run:

```bash
node scripts/migrate-attribution-runtime.mjs \
  --phase reconcile \
  --initial-run-id migration-production-v1 \
  --run-id migration-production-reconcile-v1
node scripts/verify-attribution-cutover.mjs migrated \
  --run-id migration-production-reconcile-v1
```

Expected: 配置摘要未变化，历史与来源集合精确一致，目标活动事实为 0，
manifest 状态为 `reconciled`。

- [ ] **Step 9: 提交核验工具和状态**

```bash
git add scripts/verify-attribution-cutover* docs/PROJECT_STATUS.md
git commit -m "test: 完成归因生产迁移预检"
```

### Task 5: 实现单写者切换和 30 分钟排空桥

**Files:**
- Create: `packages/api/migrations/0059_attribution_runtime_cutover.sql`
- Create: `packages/api/migrations/0059_attribution_runtime_cutover.test.mjs`
- Create: `packages/api/src/services/attribution-runtime-owner.ts`
- Create: `packages/api/src/services/attribution-runtime-owner.test.ts`
- Modify: `packages/api/src/routes/conversions.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/routes/auth.ts`
- Create: `packages/attribution/src/services/runtime-activation.ts`
- Create: `packages/attribution/src/services/runtime-activation.d1.test.ts`
- Modify: `scripts/verify-attribution-cutover.mjs`

**Interfaces:**
- Consumes: 暗模式新运行时和旧生产入口。
- Produces: `old -> draining -> new` 单调单写状态；旧页面只转发到新 Worker。

- [ ] **Step 1: 写双写防护失败测试**

```ts
it('owner=new 后旧入口只转发且不写旧事实或 delivery', async () => {
  await setRuntimeOwner(db, 'new')
  const before = await oldAttributionCounts(db)
  await oldConversionRoute.request(contactRequest)
  const after = await oldAttributionCounts(db)
  expect(after).toEqual(before)
  expect(attributionBinding.fetch).toHaveBeenCalledOnce()
})

it('owner 状态不可从 new 回到 old，只有显式 restore 命令可以回滚', async () => {
  await setRuntimeOwner(db, 'new')
  await expect(setRuntimeOwner(db, 'old')).rejects.toThrow(
    'ATTRIBUTION_RUNTIME_OWNER_REGRESSION',
  )
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test packages/api/migrations/0059_attribution_runtime_cutover.test.mjs
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-runtime-owner.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/runtime-activation.d1.test.ts
```

Expected: FAIL，owner 状态和激活命令不存在。

- [ ] **Step 3: 实现单写状态**

API D1：

```sql
CREATE TABLE attribution_runtime_cutover (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  owner TEXT NOT NULL CHECK (owner IN ('old','draining','new')),
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO attribution_runtime_cutover (id, owner) VALUES ('global', 'old');
```

切换顺序固定为：

```text
1. Attribution D1: shadow -> bridge
2. API D1: old -> draining
3. 旧 API 路由停止旧写并通过 Service Binding 转发
4. Attribution D1: bridge -> active
5. API D1: draining -> new
6. 部署新 Web SDK
```

旧 Contact 和注册入口在 `draining/new` 下只通过 Service Binding 转发；禁止调用旧 Planner、旧 outbox 或旧 Queue。

- [ ] **Step 4: 运行双写防护测试**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/services/attribution-runtime-owner.test.ts src/routes/conversions.test.ts
corepack pnpm --filter @meigallery/attribution exec vitest run src/services/runtime-activation.d1.test.ts
```

Expected: PASS，任意 owner 状态下最多一个事实写者。

- [ ] **Step 5: 提交**

```bash
git add packages/api/migrations/0059_attribution_runtime_cutover* packages/api/src/services/attribution-runtime-owner* packages/api/src/routes/conversions.ts packages/api/src/services/conversions.ts packages/api/src/routes/auth.ts packages/attribution/src/services/runtime-activation* scripts/verify-attribution-cutover.mjs
git commit -m "feat: 建立归因生产单写切换"
```

### Task 6: 执行生产切换和实时烟测

**Files:**
- Modify: `scripts/deploy.sh`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/release-verification-lib.mjs`
- Create: `packages/web/tests/e2e/attribution-production-contract.spec.ts`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: 单写切换命令和新 Web SDK。
- Produces: 新运行时成为唯一写者；普通 API/Web 发布不部署 Attribution。

- [ ] **Step 1: 写部署隔离失败测试**

```js
test('普通 production deploy 不部署 Attribution Worker', () => {
  const script = readDeployScript()
  assert.doesNotMatch(script, /@meigallery\/attribution.*deploy/)
  assert.doesNotMatch(script, /assert-production-attribution/)
})

test('Attribution deploy 不部署 API 或 Web', () => {
  const script = readAttributionDeployScript()
  assert.doesNotMatch(script, /@meigallery\/(api|web).*deploy/)
})
```

- [ ] **Step 2: 运行切换前门禁**

Run:

```bash
node scripts/verify-attribution-cutover.mjs preflight
node scripts/verify-release.mjs release
```

Expected: 输出 `ATTRIBUTION_CUTOVER_PREFLIGHT_OK`；若任何配置、Queue、凭证或集合不一致则停止。

- [ ] **Step 3: 执行单写切换**

Run:

```bash
node scripts/verify-attribution-cutover.mjs activate
./scripts/deploy.sh production
```

Expected: 激活命令输出 `RUNTIME_OWNER_NEW`；部署只更新 API/Web，Attribution Worker 版本保持不变。

- [ ] **Step 4: 执行真实生产 smoke**

Run:

```bash
node scripts/verify-attribution-cutover.mjs live-smoke
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/attribution-production-contract.spec.ts
```

Expected:

```text
META_CONTACT_BROWSER_SERVER_PAIRED
META_REGISTRATION_BROWSER_SERVER_PAIRED
TIKTOK_CONTACT_BROWSER_SERVER_PAIRED 或 SKIPPED_NOT_ENABLED
GOOGLE_CONTACT_BROWSER_SERVER_PAIRED 或 SKIPPED_NOT_ENABLED
NO_CROSS_PROVIDER_DELIVERY
```

- [ ] **Step 5: 提交发布流程调整**

```bash
git add scripts/deploy.sh scripts/verify-release.mjs scripts/release-verification-lib.mjs packages/web/tests/e2e/attribution-production-contract.spec.ts docs/PROJECT_STATUS.md
git commit -m "deploy: 切换独立归因生产运行时"
```

### Task 7: 对账、故障演练和回滚验证

**Files:**
- Modify: `scripts/verify-attribution-cutover.mjs`
- Modify: `scripts/verify-attribution-cutover.test.mjs`
- Create: `docs/operations/ATTRIBUTION_RUNBOOK.md`

**Interfaces:**
- Consumes: 切换前后集合和两个 D1 bookmark。
- Produces: 30 分钟全集合对账、Server 熔断演练、Worker 回滚演练和明确恢复步骤。

- [ ] **Step 1: 写集合差异失败测试**

```js
test('任何重复 delivery 都阻断清理', () => {
  assert.throws(
    () => reconcile({
      facts: ['fact_1'],
      deliveries: [
        ['fact_1', 'conn_meta_a', 'browser'],
        ['fact_1', 'conn_meta_a', 'browser'],
      ],
    }),
    /DUPLICATE_DELIVERY/,
  )
})
```

- [ ] **Step 2: 运行测试**

Run:

```bash
node --test scripts/verify-attribution-cutover.test.mjs
```

Expected: PASS。

- [ ] **Step 3: 执行 30 分钟排空和全集合对账**

Run:

```bash
node scripts/verify-attribution-cutover.mjs reconcile --window-minutes=30
```

Expected: 输出：

```text
FACT_SET_MATCHED
DELIVERY_SET_VALID
NO_DUPLICATE_DELIVERY
NO_CROSS_PROVIDER_DELIVERY
OLD_WRITER_ZERO_NEW_ROWS
```

- [ ] **Step 4: 演练 Server 熔断**

Run:

```bash
node scripts/verify-attribution-cutover.mjs drill-server-circuit --provider=meta
```

Expected: Server effective 临时为 `0`、Browser 保持启用、恢复后 effective 回到原 target；Active Version 不变。

- [ ] **Step 5: 演练 Attribution Worker 独立回滚**

Run:

```bash
node scripts/verify-attribution-cutover.mjs drill-worker-rollback
```

Expected: Worker 回滚不部署 API/Web，不修改 Active Version、运行策略或凭证指纹。

- [ ] **Step 6: 验证普通功能发布隔离**

Run:

```bash
node scripts/verify-attribution-cutover.mjs capture-isolation-baseline
node scripts/verify-attribution-cutover.mjs simulate-unrelated-api-web-release
node scripts/verify-attribution-cutover.mjs isolation
```

Expected: 图库、会员、SEO 或 Telegram fixture 变化只生成 API/Web dry-run 产物；
Attribution Worker deployment version、Active Version、运行策略、凭证指纹和 Queue consumer
保持不变，并输出 `DEPLOYMENT_ISOLATION_OK`。

- [ ] **Step 7: 提交 Runbook**

```bash
git add scripts/verify-attribution-cutover* docs/operations/ATTRIBUTION_RUNBOOK.md
git commit -m "docs: 固化归因事故与回滚流程"
```

### Task 8: 删除旧运行代码和临时迁移桥

**Files:**
- Delete: `packages/api/src/services/ad-platform/`
- Delete: `packages/api/src/workflows/ad-platform-verification.ts`
- Delete: `packages/api/src/workflows/ad-platform-verification.test.ts`
- Delete: `packages/api/src/services/ad-attribution-routing.ts`
- Delete: `packages/api/src/services/ad-attribution-routing.test.ts`
- Delete: `packages/api/src/services/conversions.ts`
- Delete: `packages/api/src/services/conversions.test.ts`
- Delete: `packages/api/src/services/conversions.d1.test.ts`
- Delete: `packages/api/src/services/registration-conversion-recovery.ts`
- Delete: `packages/api/src/services/registration-conversion-recovery.test.ts`
- Delete: `packages/api/src/services/attribution-dashboard.ts`
- Delete: `packages/api/src/services/attribution-dashboard.d1.test.ts`
- Delete: `packages/api/src/routes/ad-attribution.ts`
- Delete: `packages/api/src/routes/ad-attribution.test.ts`
- Delete: `packages/api/src/routes/conversions.ts`
- Delete: `packages/api/src/routes/conversions.test.ts`
- Delete: `packages/api/src/routes/marketing-consent.ts`
- Delete: `packages/api/src/routes/marketing-consent.test.ts`
- Delete: `packages/api/src/routes/admin/ad-platforms.ts`
- Delete: `packages/api/src/routes/admin/ad-platforms.test.ts`
- Delete: `packages/api/src/routes/admin/attribution.ts`
- Delete: `packages/api/src/routes/admin/attribution.test.ts`
- Delete: `packages/api/src/routes/admin/attribution-dashboard.ts`
- Delete: `packages/api/src/routes/admin/attribution-privacy-policy.ts`
- Delete: `packages/api/src/routes/admin/attribution-privacy-policy.test.ts`
- Delete: `packages/api/src/services/ad-attribution-consent.ts`
- Delete: `packages/api/src/services/ad-attribution-consent.d1.test.ts`
- Delete: `packages/api/src/services/attribution-privacy-policy.ts`
- Delete: `packages/api/src/utils/marketing-consent-request.ts`
- Delete: `packages/api/src/utils/marketing-consent-receipt.ts`
- Delete: `packages/api/src/utils/marketing-consent-receipt.test.ts`
- Delete: `packages/api/src/utils/ad-attribution-context.ts`
- Delete: `packages/api/src/utils/ad-attribution-context.test.ts`
- Delete: `packages/api/src/utils/ad-attribution-receipt.ts`
- Delete: `packages/api/src/utils/ad-attribution-receipt.test.ts`
- Delete: `packages/api/src/utils/ad-platform-identifiers.ts`
- Delete: `packages/api/src/utils/ad-platform-identifiers.test.ts`
- Delete: `packages/api/src/utils/attribution-crypto.ts`
- Delete: `packages/api/src/utils/attribution-crypto.test.ts`
- Delete: `packages/api/src/utils/conversions.ts`
- Delete: `packages/api/src/utils/conversions.test.ts`
- Delete: `packages/api/src/test-support/attribution-schema.ts`
- Delete: `packages/api/src/test/ad-platform-fixture.ts`
- Delete: `packages/api/src/services/attribution-migration-export.ts`
- Delete: `packages/api/src/services/attribution-migration-export.test.ts`
- Delete: `packages/api/src/routes/admin/attribution-migration.ts`
- Delete: `packages/api/src/routes/admin/attribution-migration.test.ts`
- Delete: `packages/attribution/src/routes/migration.ts`
- Delete: `packages/attribution/src/services/migration-import.ts`
- Delete: `packages/attribution/src/services/migration-import.d1.test.ts`
- Modify: `packages/api/src/architecture-attribution.test.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Modify: `packages/api/wrangler.toml`
- Create: `packages/api/migrations/0060_drop_legacy_attribution_runtime.sql`
- Create: `packages/api/migrations/0060_drop_legacy_attribution_runtime.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: 对账和回滚演练成功证据。
- Produces: 主 API 不再拥有归因运行时、Queue、Workflow、凭证或事实表。

- [ ] **Step 1: 写旧逻辑存在性失败测试**

```js
test('主 API 最终 Schema 不含旧归因运行表', () => {
  for (const table of [
    'attribution_platform_connections',
    'attribution_event_bindings',
    'attribution_credentials',
    'attribution_conversion_facts',
    'attribution_deliveries',
    'attribution_outbox',
    'attribution_provider_receipts',
    'attribution_verifications',
    'attribution_incidents',
    'attribution_quality_snapshots',
    'attribution_usage_daily',
    'attribution_privacy_policy',
    'attribution_runtime_cutover',
  ]) assert.match(migration, new RegExp(`DROP TABLE IF EXISTS ${table}`))
  assert.match(migration, /DROP COLUMN meta_external_id/i)
})

test('0060 使用先部署新 API 再删表的两阶段顺序', () => {
  const steps = productionDeploySteps({ pendingMigrations: ['0060_drop_legacy_attribution_runtime.sql'] })
  assert.ok(steps.indexOf('deploy-api') < steps.indexOf('apply-0060'))
  assert.ok(steps.indexOf('smoke-api') < steps.indexOf('apply-0060'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test packages/api/migrations/0060_drop_legacy_attribution_runtime.test.mjs
```

Expected: FAIL，清理 migration 不存在。

- [ ] **Step 3: 删除旧代码、绑定和表**

`packages/api/wrangler.toml` 删除：

```text
AD_META_QUEUE
AD_TIKTOK_QUEUE
AD_GOOGLE_QUEUE
AD_PLATFORM_VERIFICATION_WORKFLOW
```

保留 `ATTRIBUTION` Service Binding。`0060` 删除旧运行表、旧归因 site setting、
`users.meta_external_id` 列及其索引，并保留业务分析所需的普通 UTM/analytics 表。执行顺序必须
先部署不再引用旧表的新 API Worker并通过健康检查，再应用 `0060`；部署脚本测试必须阻止
“先 DROP TABLE、后部署代码”的顺序。

`architecture-attribution.test.ts` 重写为最终边界测试：主 API 只允许
`attribution-service-client.ts` 使用 `ATTRIBUTION.fetch()`，只允许
`attribution-business-outbox.ts` 持有业务 outbox SQL；任何其他 API 模块不得引用归因 D1 表、
provider Adapter、平台 Queue、平台 Secret 或旧 conversion route。旧测试 Schema 和 fixture
直接删除，不迁移到新 API 测试目录。

- [ ] **Step 4: 执行静态清理扫描**

Run:

```bash
rg -n "RELEASE_COMMIT|verifiedCommit|connectionRevision|credentialRevision" packages/api/src packages/web/app | rg "attribution|ad-platform|Meta 运维"
rg -n "AD_META_QUEUE|AD_TIKTOK_QUEUE|AD_GOOGLE_QUEUE|AD_PLATFORM_VERIFICATION_WORKFLOW" packages/api
rg -n "services/ad-platform|workflows/ad-platform-verification|routes/ad-attribution|routes/conversions" packages/api/src
rg -n "adPlatformBrowser|plugins/ad-platform|/api/ad-attribution|/api/conversions" packages/web/app
```

Expected: 四条命令均无输出。API/Web 的通用 release identity 可以保留，但不得进入任何归因模块。

- [ ] **Step 5: 运行完整验证**

Run:

```bash
node --test packages/api/migrations/0060_drop_legacy_attribution_runtime.test.mjs
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
node scripts/verify-attribution-cutover.mjs isolation
git diff --check
```

Expected: 全部 PASS，输出 `DEPLOYMENT_ISOLATION_OK`。

- [ ] **Step 6: 提交**

```bash
git add -u packages/api/src packages/api/wrangler.toml scripts/deploy.sh scripts/verify-release.mjs
git add packages/api/src/architecture-attribution.test.ts
git add packages/api/migrations/0060_drop_legacy_attribution_runtime.sql packages/api/migrations/0060_drop_legacy_attribution_runtime.test.mjs
git commit -m "refactor: 删除旧归因运行逻辑"
```

### Task 9: 最终生产发布和 24 小时收口

**Files:**
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/TECHNICAL_SPEC.md`
- Modify: `docs/AD_PLATFORM_ARCHITECTURE.md`
- Modify: `docs/operations/ATTRIBUTION_RUNBOOK.md`

**Interfaces:**
- Consumes: 已删除旧运行时的 release。
- Produces: 最终生产状态、24 小时监控证据和无兼容层架构。

- [ ] **Step 1: 创建 release 并执行最终门禁**

Run:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
node scripts/verify-release.mjs release
node scripts/verify-attribution-cutover.mjs pre-cleanup-release
```

Expected: 全部退出码为 `0`。

- [ ] **Step 2: 通过 release PR 合入 main**

Run:

```bash
git switch dev
git pull --ff-only origin dev
git switch -c release/v0.5.0
git push -u origin release/v0.5.0
gh pr create --base main --head release/v0.5.0 --title "deploy: 发布独立归因运行时 v0.5.0" --body "完成独立 Attribution Worker、三平台统一归因、生产迁移和旧运行逻辑清理。"
gh pr checks --watch
gh pr merge --merge --delete-branch
git switch main
git pull --ff-only origin main
```

Expected: PR 检查全部通过，`main` 包含 release merge。

- [ ] **Step 3: 部署生产**

Run:

```bash
./scripts/deploy-attribution.sh production
./scripts/deploy.sh production
```

Expected: Attribution 和 API/Web 分别部署；每个脚本只部署自己的 Worker 集合。

- [ ] **Step 4: 执行生产 smoke 和集合核验**

Run:

```bash
node scripts/verify-attribution-cutover.mjs live-smoke
node scripts/verify-attribution-cutover.mjs reconcile --window-minutes=30
node scripts/verify-attribution-cutover.mjs isolation
```

Expected: smoke、集合、去重、跨平台隔离和部署隔离全部通过。

- [ ] **Step 5: 标记已验证生产版本**

Run:

```bash
git tag -a v0.5.0 -m "独立归因运行时 v0.5.0"
git push origin v0.5.0
```

Expected: tag `v0.5.0` 指向已完成生产 smoke 的 `main` 提交。

- [ ] **Step 6: 观察 24 小时**

每 15 分钟自动检查：

```text
critical Incident = 0
cross-provider delivery = 0
duplicate delivery = 0
expired recoverable outbox = 0
Browser enabled connection 的 Browser Attempt > 0 或明确无业务事实
Server processed / planned 在无平台故障时保持健康
Free 额度使用率 < 70%，或已有明确告警
```

任何 critical 条件触发 Runbook 回滚，不等待下一次人工确认。

- [ ] **Step 7: 更新最终文档并提交**

```bash
git switch main
git pull --ff-only origin main
git switch -c docs/attribution-v0.5.0-closeout
git add docs/PROJECT_STATUS.md docs/TECHNICAL_SPEC.md docs/AD_PLATFORM_ARCHITECTURE.md docs/operations/ATTRIBUTION_RUNBOOK.md
git commit -m "docs: 完成独立归因生产迁移"
git push -u origin docs/attribution-v0.5.0-closeout
gh pr create --base main --head docs/attribution-v0.5.0-closeout --title "docs: 收口独立归因生产迁移" --body "记录 v0.5.0 生产 smoke、24 小时观察和旧运行时清理结果。"
gh pr checks --watch
gh pr merge --merge --delete-branch
```

Expected: closeout PR 合入 `main`，文档记录真实时间、集合计数、Incident 数和容量水位，不包含凭证、proof、IP、UA 或 Cookie。
