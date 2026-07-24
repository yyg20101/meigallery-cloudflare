# 归因后台控制面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将后台归因中心重构为面向多个 provider、多个团队连接的控制面，清晰分离身份候选、运行策略、验证记录、投递质量、Incident 和审计。

**Architecture:** 主 API 继续负责管理员身份和权限，但所有归因读写通过 `ATTRIBUTION` Service Binding 转发到独立 Worker；Web 只消费稳定 View Model。页面不接触 D1、凭证明文、内部 version ID、revision 或 Git commit。

**Tech Stack:** Hono、Cloudflare Service Bindings、Nuxt 4、Nuxt UI 4、Vue 3、Vitest、Playwright。

## Global Constraints

- 依赖运行时基础和事件投递计划全部完成。
- Owner 才能创建连接、保存候选、调整运行策略、停用或回滚。
- 所有修改请求必须携带 `Idempotency-Key`。
- 身份编辑的唯一提交文案为“保存并自动验证”。
- 运行开关与 rollout 不得放在身份编辑表单中。
- 候选失败或验证中必须明确显示“当前生产版本继续运行”。
- 页面不得展示 `version_id`、credential fingerprint、revision、Git commit、Token 或测试码。
- 停用整个连接和回滚需要确认；普通 Browser/Server 开关和 rollout 不需要人工发布门禁。
- 同一 provider 的多个连接必须并列展示，不能用 provider 作为连接主键。

---

## 文件结构

```text
packages/attribution/src/routes/admin.ts
packages/attribution/src/read-models/admin-connections.ts
packages/attribution/src/read-models/admin-quality.ts
packages/attribution/src/read-models/admin-incidents.ts
packages/attribution/src/read-models/admin-privacy.ts
packages/api/src/routes/admin/attribution-proxy.ts
packages/api/src/routes/admin/attribution-proxy.test.ts
packages/web/app/types/attribution-admin.ts
packages/web/app/composables/useAdminAttribution.ts
packages/web/app/pages/admin/attribution/{index,connections,connection-runtime,bindings,deliveries,verifications,incidents,privacy,audit}.vue
packages/web/app/components/admin/attribution/*.vue
packages/web/tests/e2e/admin-attribution.spec.ts
```

### Task 1: 建立独立 Worker 管理 API 与读模型

**Files:**
- Create: `packages/attribution/src/read-models/admin-connections.ts`
- Create: `packages/attribution/src/read-models/admin-connections.d1.test.ts`
- Create: `packages/attribution/src/read-models/admin-quality.ts`
- Create: `packages/attribution/src/read-models/admin-incidents.ts`
- Create: `packages/attribution/src/read-models/admin-privacy.ts`
- Create: `packages/attribution/src/routes/admin.ts`
- Create: `packages/attribution/src/routes/admin.test.ts`
- Modify: `packages/attribution/src/index.ts`

**Interfaces:**
- Consumes: 连接命令、运行策略命令、验证服务和聚合表。
- Produces: 设计文档第 15 节的管理员 API，响应为脱敏 View。

- [x] **Step 1: 写脱敏和幂等失败测试**

```ts
it('连接列表不泄露内部字段', async () => {
  const response = await app.request('/admin/attribution/connections', {}, env)
  const body = await response.json()
  const serialized = JSON.stringify(body)
  expect(serialized).not.toMatch(/versionId|credentialRevision|fingerprint|commit|ciphertext|token/i)
})

it('写请求缺少幂等键时拒绝', async () => {
  const response = await app.request('/admin/attribution/connections', {
    method: 'POST',
    body: JSON.stringify(validConnectionInput),
  }, env)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: 'ATTRIBUTION_IDEMPOTENCY_KEY_REQUIRED' },
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/routes/admin.test.ts src/read-models/admin-connections.d1.test.ts
```

Expected: FAIL，管理路由和读模型不存在。

- [x] **Step 3: 实现稳定 View Model 和路由**

连接 View 固定为：

```ts
export interface AdminAttributionConnectionView {
  id: string
  provider: AttributionProvider
  name: string
  isDefault: boolean
  state: 'not_configured' | 'active' | 'disabled'
  activeTarget: string
  candidate: null | {
    state: 'candidate' | 'validating' | 'ready' | 'failed'
    createdAt: string
    failureCode: string
    productionContinues: true
  }
  runtime: {
    enabled: boolean
    browserEnabled: boolean
    serverEnabled: boolean
    serverTargetPercentage: 0 | 10 | 50 | 100
    serverEffectivePercentage: 0 | 10 | 50 | 100
    circuitState: 'closed' | 'server_open'
  }
  health: {
    level: 'healthy' | 'warning' | 'critical'
    lastDeliveryAt: string
  }
}
```

路由必须逐一映射到领域命令，不直接执行 SQL：

```ts
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

候选读取只按连接返回脱敏状态，不向 Web 暴露 `candidateId` 或
`versionId`。GET 为纯读取；幂等键只用于修改命令。

- [x] **Step 4: 运行路由测试**

Run:

```bash
corepack pnpm --filter @meigallery/attribution exec vitest run src/routes/admin.test.ts src/read-models
```

Expected: PASS；重复 `Idempotency-Key` 返回同一领域结果且 D1 行数不变。

实际结果：Attribution 完整套件 `40` 个测试文件、`280` 项测试通过；
包含并发重复创建、候选自动验证、Workflow 同实例恢复、跨连接幂等隔离、
请求体上限、公开管理路由默认 `404` 和脱敏快照损坏关闭。

- [x] **Step 5: 提交**

```bash
git add packages/attribution/src/routes/admin* packages/attribution/src/read-models packages/attribution/src/index.ts
git commit -m "feat: 建立归因独立管理 API"
```

### Task 2: 通过主 API 执行管理员鉴权和 Service Binding 转发

**Files:**
- Create: `packages/api/src/routes/admin/attribution-proxy.ts`
- Create: `packages/api/src/routes/admin/attribution-proxy.test.ts`
- Modify: `packages/api/src/routes/admin/index.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/index.test.ts`
- Modify: `packages/api/src/architecture-boundaries.test.ts`
- Modify: `packages/api/wrangler.toml`
- Modify: `packages/attribution/src/index.ts`
- Modify: `packages/attribution/src/index.test.ts`
- Modify: `packages/attribution/src/test/cloudflare-workers.ts`
- Modify: `packages/attribution/vitest.config.ts`
- Modify: `packages/shared/src/constants/index.ts`

**Interfaces:**
- Consumes: 已认证 `userId/userRole` 和指向命名
  `AttributionServiceEntrypoint` 的 `ATTRIBUTION` Fetcher binding。
- Produces: `/api/admin/attribution-runtime/*` 同源代理；写请求注入可信
  actor，不信任浏览器 actor 字段。独立 Worker 的默认公网 `fetch` 不挂载内部
  事件路由或管理路由。

- [x] **Step 1: 写权限和头过滤失败测试**

```ts
it.each([
  [null, null, 401],
  [2, 'admin', 403],
  [1, 'owner', 200],
])('actor=%s role=%s', async (userId, role, status) => {
  const response = await requestProxy({ userId, role })
  expect(response.status).toBe(status)
})

it('丢弃客户端伪造 actor 和内部认证头', async () => {
  await requestProxy({
    userId: 1,
    role: 'owner',
    headers: {
      'X-Attribution-Actor-Id': '999',
      'X-Attribution-Internal-Auth': 'forged',
    },
  })
  expect(binding.fetch).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      headers: expectHeaders({
        'X-Attribution-Actor-Id': '1',
        'X-Attribution-Actor-Role': 'owner',
      }),
    }),
  )
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/routes/admin/attribution-proxy.test.ts
```

Expected: FAIL，代理路由不存在。

- [x] **Step 3: 实现最小可信代理**

允许转发的请求头仅为：

```ts
const FORWARDED_HEADERS = new Set([
  'content-type',
  'idempotency-key',
])
```

API 注入：

```ts
headers.set('X-Attribution-Actor-Id', String(c.get('userId')))
headers.set('X-Attribution-Actor-Role', 'owner')
headers.set('X-Attribution-Request-Id', crypto.randomUUID())
```

API 的 Wrangler binding 必须固定到：

```toml
[[services]]
binding = "ATTRIBUTION"
service = "meigallery-attribution"
entrypoint = "AttributionServiceEntrypoint"
```

独立 Worker 使用 Cloudflare 命名 `WorkerEntrypoint` 承载 `/internal/v1/*`
和 `/admin/attribution/*`。默认公网 `fetch` 只承载 Browser API 与健康检查，
因此公网即使伪造内部头也无法命中私有路由。Service Binding 自身是账户配置
授予的 capability，不再增加共享 HMAC secret、签名轮换或兼容认证路径。
代理只允许 `GET/POST/PATCH`，请求体上限为 64 KiB，响应只保留
`Content-Type` 并强制 `no-store`；API 的 CORS 白名单显式允许
`Idempotency-Key`，确保跨子域后台写命令可以完成预检。

- [x] **Step 4: 运行代理和类型测试**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/routes/admin/attribution-proxy.test.ts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
```

Expected: PASS，非 Owner 不能修改或读取敏感连接信息。

实际结果：

- API 完整套件：`119` 个测试文件、`1004` 项测试通过。
- Attribution 完整套件：`40` 个测试文件、`282` 项测试通过。
- Shared 完整套件：`4` 个测试文件、`16` 项测试通过。
- API、Attribution、Shared 类型检查通过。
- API 与 Attribution Wrangler dry-run 通过，API 明确显示
  `meigallery-attribution#AttributionServiceEntrypoint`。

- [x] **Step 5: 提交**

```bash
git add packages/api/src/routes/admin/attribution-proxy* \
  packages/api/src/routes/admin/index* \
  packages/api/src/index* \
  packages/api/src/architecture-boundaries.test.ts \
  packages/api/wrangler.toml \
  packages/attribution/src/index* \
  packages/attribution/src/test/cloudflare-workers.ts \
  packages/attribution/vitest.config.ts \
  packages/shared/src/constants/index.ts
git commit -m "feat: 代理归因控制面并统一 Owner 鉴权"
```

### Task 3: 重写后台类型与数据 composable

**Files:**
- Create: `packages/web/app/types/attribution-admin.ts`
- Modify: `packages/web/app/composables/useAdminAttribution.ts`
- Rewrite: `packages/web/app/composables/useAdminAttribution.test.ts`
- Modify: `packages/web/app/utils/attributionPlatforms.ts`
- Create: `packages/web/app/utils/attributionPlatforms.test.ts`

**Interfaces:**
- Consumes: Task 1 的脱敏 View Model。
- Produces: `useAttributionConnections()`、`useAttributionCandidate()`、`useAttributionRuntimePolicy()`、`useAttributionQuality()`。

- [x] **Step 1: 写异步初始化和并发失败测试**

```ts
it('加载完成前保存按钮保持禁用且不会提交空默认值', async () => {
  const state = useAttributionConnections(deferredApi)
  expect(state.canSave.value).toBe(false)
  await expect(state.saveCandidate('conn_meta_a')).rejects.toThrow(
    'ATTRIBUTION_FORM_NOT_READY',
  )
  deferredApi.resolve(connectionResponse)
  await nextTick()
  expect(state.canSave.value).toBe(true)
})

it('重复点击保存复用同一个幂等键和 Promise', async () => {
  const first = state.saveCandidate('conn_meta_a')
  const second = state.saveCandidate('conn_meta_a')
  expect(second).toBe(first)
  expect(api.post).toHaveBeenCalledOnce()
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/composables/useAdminAttribution.test.ts app/utils/attributionPlatforms.test.ts
```

Expected: FAIL，旧 composable 不满足新接口。

- [x] **Step 3: 实现按命令拆分的 composable**

身份保存 payload：

```ts
export interface CreateCandidateRequest {
  publicConfig: Record<string, string>
  credential?: { type: 'access_token' | 'service_account_json'; plaintext: string }
  eventBindings: Array<{
    canonicalEvent: 'Contact' | 'CompleteRegistration'
    enabled: boolean
    browserDestination: string
    serverDestination: string
  }>
  testEventCode?: string
}
```

运行策略 payload：

```ts
export interface SetRuntimePolicyRequest {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
}
```

两个 payload 类型和提交函数不得共享对象。每次新用户动作生成一个 UUID 幂等键；同一 pending Promise 内复用该键。

- [x] **Step 4: 运行 composable 测试**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/composables/useAdminAttribution.test.ts app/utils/attributionPlatforms.test.ts
```

Expected: PASS，加载前、错误后和重复点击均不会提交空配置。

实际结果：

- 新控制面 composable、平台 Schema 和统一 API 请求头测试共 `20` 项通过。
- Web 完整套件 `61` 个测试文件、`287` 项测试通过。
- Web `vue-tsc --noEmit`、生产 Nuxt build 和 API TypeScript 检查通过。
- 身份候选与运行策略使用不同类型和不同写命令；重复点击复用同一
  Promise 与 `Idempotency-Key`。
- Web 只通过 `/api/admin/attribution-runtime/*` 访问新的控制面；统一
  `useApi` 在 CSR、SSR 和 Service Binding 请求中保留幂等键。

- [x] **Step 5: 提交**

```bash
git add packages/web/app/types/attribution-admin.ts \
  packages/web/app/composables/useAdminAttribution* \
  packages/web/app/composables/useApi* \
  packages/web/app/utils/attributionPlatforms* \
  docs/superpowers/plans/2026-07-24-attribution-admin-control-plane.md
git commit -m "refactor: 分离归因后台写命令"
```

### Task 4: 重构连接、候选和运行控制页面

**Files:**
- Delete: `packages/web/app/pages/admin/attribution/platforms.vue`
- Delete: `packages/web/app/pages/admin/attribution/platforms.test.ts`
- Create: `packages/web/app/pages/admin/attribution/connections.vue`
- Create: `packages/web/app/pages/admin/attribution/connections/[id].vue`
- Create: `packages/web/app/components/admin/attribution/AttributionConnectionList.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionConnectionFilter.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionIdentityCandidateForm.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionRuntimePolicyPanel.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionCandidateStatus.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionManagedSourceList.vue`
- Delete: `packages/web/app/pages/admin/attribution/links.vue`
- Delete: `packages/web/app/components/admin/attribution/AttributionCredentialEditor.vue`
- Delete: `packages/web/app/components/admin/attribution/AttributionPlatformConnectionEditor.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionPageShell.vue`
- Modify: `packages/web/app/layouts/admin.vue`
- Modify: `packages/web/app/pages/admin/analytics/sources.vue`
- Create: `packages/web/app/pages/admin/attribution/connections.test.ts`

**Interfaces:**
- Consumes: Task 3 composable。
- Produces: provider 分组多连接列表和完全分开的身份/运行控制界面。

- [x] **前置修复：管理投放来源凭证可独立解析**

  新建投放来源返回的一次性凭证无需等待 Meta、TikTok 或 Google 附加点击标识即可签发
  一方上下文；无凭证的请求仍必须包含合法平台点击标识。浏览器路由回归测试与
  Attribution Worker 类型检查已通过。

- [x] **Step 1: 写页面语义失败测试**

```ts
it('候选验证中仍显示生产继续运行且没有运行开关', async () => {
  const wrapper = mountConnectionPage(validatingFixture)
  expect(wrapper.text()).toContain('当前生产版本继续运行')
  expect(wrapper.find('[data-test="identity-candidate-form"]').exists()).toBe(true)
  expect(wrapper.find('[data-test="identity-candidate-form"] input[name="browserEnabled"]').exists()).toBe(false)
})

it('页面不显示内部实现字段', async () => {
  const text = mountConnectionPage(activeFixture).text()
  expect(text).not.toMatch(/revision|commit|version id|credential fingerprint/i)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution/connections.test.ts
```

Expected: FAIL，新页面不存在。

- [x] **Step 3: 实现页面信息架构**

导航固定为：

```ts
const attributionNavigation = [
  { label: '总览', to: '/admin/attribution' },
  { label: '连接', to: '/admin/attribution/connections' },
  { label: '事件映射', to: '/admin/attribution/bindings' },
  { label: '投递质量', to: '/admin/attribution/deliveries' },
  { label: '验证记录', to: '/admin/attribution/verifications' },
  { label: 'Incident', to: '/admin/attribution/incidents' },
  { label: '地区策略', to: '/admin/attribution/privacy' },
  { label: '审计日志', to: '/admin/attribution/audit' },
]
```

连接详情使用两个独立无嵌套卡片区块：

```vue
<AttributionIdentityCandidateForm
  :connection="connection"
  @save="saveCandidate"
/>
<AttributionRuntimePolicyPanel
  :policy="connection.runtime"
  @save="saveRuntimePolicy"
  @disable="confirmDisable"
  @rollback="confirmRollback"
/>
<AttributionManagedSourceList
  :connection-id="connection.id"
  :provider="connection.provider"
  @create="createManagedSource"
  @disable="disableManagedSource"
/>
```

新建来源表单只提交 campaign、medium、content 和可选到期时间；返回的完整投放 URL 仅在创建成功
响应中展示一次。列表只显示来源名称、Campaign 字段、状态和到期时间，不回显原始 proof。
旧 `/admin/attribution/platforms` 和 `/admin/attribution/links` 页面不保留 redirect 或兼容组件；
后台导航、数据分析来源页和所有内部链接直接改为 `/admin/attribution/connections`。身份表单是
公开配置、凭证和事件映射的唯一编辑入口，已删除的四个旧编辑器不得被新组件包装复用。

- [x] **Step 4: 运行页面测试和构建**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution/connections.test.ts
corepack pnpm --filter @meigallery/web exec nuxt build
```

Result: 页面语义测试、完整 Web 单测（287 项）、Web 类型检查、API 类型检查和生产构建
通过。375px 与 1440px 的真实浏览器截图和横向溢出检查统一在 Task 7 执行，避免在没有
认证测试环境时把结构断言误写成视觉验收。

- [x] **Step 5: 提交**

```bash
git add packages/web/app/pages/admin/attribution packages/web/app/components/admin/attribution packages/web/app/layouts/admin.vue packages/web/app/pages/admin/analytics/sources.vue
git commit -m "feat: 重构归因连接与运行控制页面"
```

### Task 5: 重构质量、验证、Incident 和审计页面

**Files:**
- Modify: `packages/web/app/pages/admin/attribution/index.vue`
- Modify: `packages/web/app/pages/admin/attribution/bindings.vue`
- Modify: `packages/web/app/pages/admin/attribution/deliveries.vue`
- Modify: `packages/web/app/pages/admin/attribution/verifications.vue`
- Create: `packages/web/app/pages/admin/attribution/incidents.vue`
- Modify: `packages/web/app/pages/admin/attribution/privacy.vue`
- Modify: `packages/web/app/pages/admin/attribution/audit.vue`
- Delete: `packages/web/app/pages/admin/attribution/conversions.vue`
- Delete: `packages/web/app/pages/admin/attribution/conversions.test.ts`
- Delete: `packages/web/app/pages/admin/attribution/readiness.vue`
- Delete: `packages/web/app/utils/attributionReadiness.ts`
- Delete: `packages/web/app/utils/attributionReadiness.test.ts`
- Delete: `packages/web/app/components/admin/attribution/AttributionProviderSwitch.vue`
- Delete: `packages/web/app/components/admin/attribution/AttributionEventBindingEditor.vue`
- Delete: `packages/web/app/components/admin/attribution/AttributionRolloutControl.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionHealthStrip.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionIncidentList.vue`
- Modify: `packages/web/app/components/admin/attribution/AttributionVerificationPanel.vue`
- Create: `packages/web/app/components/admin/attribution/AttributionDeliveryFunnel.vue`
- Create: `packages/web/app/pages/admin/attribution/operations.test.ts`

**Interfaces:**
- Consumes: 归因读模型的聚合指标。
- Produces: 可按日期和 provider/connection 筛选的运营视图。

- [x] **Step 1: 写指标口径失败测试**

```ts
it('业务事实与投递状态分开展示', () => {
  const wrapper = mountOperationsPage(fixture)
  expect(metric(wrapper, '业务 Contact')).toBe('12')
  expect(metric(wrapper, 'Browser Attempted')).toBe('10')
  expect(metric(wrapper, 'Server Processed')).toBe('8')
  expect(metric(wrapper, '未归因事实')).toBe('2')
})

it('Incident 显示影响范围和恢复状态', () => {
  const row = incidentRow(wrapper)
  expect(row.text()).toContain('Meta / 美国 BJ 团队')
  expect(row.text()).toContain('Server')
  expect(row.text()).toContain('影响事实 6')
  expect(row.text()).toContain('已恢复')
})

it('地区策略明确区分事先同意和告知退出地区', () => {
  const privacy = mountPrivacyPage(privacyFixture)
  expect(privacy.getByLabel('默认地区模式').element.value).toBe('notice_opt_out')
  expect(privacy.getByLabel('需事先同意的国家或地区').element.value).toContain('DE')
  expect(privacy.text()).toContain('GPC 和用户明确拒绝始终优先')
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution/operations.test.ts
```

Expected: FAIL，新指标组件尚未实现。

- [x] **Step 3: 实现运营视图**

日期筛选继续支持 `7 天`、`30 天`、`90 天` 和 `单日`。漏斗顺序固定为：

```text
业务事实 -> 已归因事实 -> Browser Attempted -> Server Planned
-> Server Queued -> Server Processed
```

平台质量无权限或无数据时显示“平台质量暂不可用”，不得显示为连接失败或把 rollout 改为 0。
地区策略页面只展示隐私目的、默认模式和国家代码，不展示 Meta、TikTok、Google、Cookie 名称或平台协议细节；保存调用独立的隐私策略幂等命令。
事件映射页只按 connection 展示当前 Active 与候选差异，不提供独立保存按钮；任何映射变化必须
回到连接详情并创建完整候选。所有运营页统一使用 `AttributionConnectionFilter`，不再以 provider
作为唯一筛选主键。旧转化页、readiness 页、ProviderSwitch 和 readiness serializer 同任务删除。

- [x] **Step 4: 运行页面测试**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run app/pages/admin/attribution/operations.test.ts app/components/admin/attribution
```

Expected: PASS，单日查询只展示该自然日数据。

Result: Web 完整套件 `60` 个测试文件、`286` 项测试通过；Attribution
完整套件 `41` 个测试文件、`289` 项测试通过。API、Attribution、Web
类型检查和 Nuxt 生产构建通过；新增 D1 测试确认 synthetic 事实不会进入运营
数据，Incident 单日筛选使用北京时间自然日。后台运行时代码已无旧
`/api/admin/attribution/platforms`、readiness 页面或 provider-only
编辑组件引用。

- [x] **Step 5: 提交**

```bash
git add packages/web/app/pages/admin/attribution packages/web/app/components/admin/attribution
git commit -m "feat: 完善归因质量与事故看板"
```

### Task 6: 完成控制面 E2E 和无障碍回归

**Files:**
- Rewrite: `packages/web/tests/e2e/admin-attribution.spec.ts`
- Modify: `packages/web/tests/e2e/mock-api.mjs`
- Create: `packages/web/tests/e2e/admin-attribution-mobile.spec.ts`
- Modify: `packages/web/app/architecture-boundaries.test.ts`
- Modify: `packages/web/tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: 完整后台控制面。
- Produces: 身份候选、运行控制、重复点击、失败保持 Active、多连接和日期筛选 E2E 证据。

- [ ] **Step 1: 写 E2E 场景**

```ts
test('候选失败不影响 Active 和运行策略', async ({ page }) => {
  await page.goto('/admin/attribution/connections/conn_meta_a')
  await page.getByLabel('Pixel ID').fill('invalid')
  await page.getByRole('button', { name: '保存并自动验证' }).click()
  await expect(page.getByText('验证失败')).toBeVisible()
  await expect(page.getByText('当前生产版本继续运行')).toBeVisible()
  await expect(page.getByLabel('Browser')).toBeChecked()
  await expect(page.getByLabel('Server')).toBeChecked()
})

test('运行策略重复提交保持幂等', async ({ page }) => {
  await page.getByLabel('Server rollout').getByText('50%').dblclick()
  await expect(page.getByText('已更新运行策略')).toBeVisible()
  expect(mockApi.commandWrites('setRuntimePolicy')).toBe(1)
})
```

- [ ] **Step 2: 运行 E2E 确认失败**

Run:

```bash
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/admin-attribution.spec.ts tests/e2e/admin-attribution-mobile.spec.ts
```

Expected: FAIL，mock 和选择器尚未对齐新控制面。

- [ ] **Step 3: 完成 mock、移动布局和边界测试**

Mock API 必须记录每个 `Idempotency-Key` 的写入次数，并在重复请求时返回第一次结果。移动端 375x812 下，导航允许横向滚动但页面主体不得横向溢出；所有开关有可访问 label，确认对话框有焦点锁定。
边界测试还必须断言旧 `platforms`、`links`、`conversions`、`readiness` 路由和四个旧编辑器均不存在，
后台源码不再请求旧 `/api/admin/attribution/platforms`、`/links` 或 `/conversions`。

- [ ] **Step 4: 运行阶段验收**

Run:

```bash
corepack pnpm --filter @meigallery/web exec vitest run
corepack pnpm --filter @meigallery/web exec playwright test tests/e2e/admin-attribution.spec.ts tests/e2e/admin-attribution-mobile.spec.ts
corepack pnpm --filter @meigallery/api exec vitest run src/routes/admin/attribution-proxy.test.ts
corepack pnpm --filter @meigallery/web exec nuxt build
git diff --check
```

Expected: 全部 PASS；后台不包含旧 Meta 专属运维页、commit 门禁或 revision 控件。

- [ ] **Step 5: 提交**

```bash
git add packages/web/tests/e2e packages/web/app/architecture-boundaries.test.ts packages/web/app
git commit -m "test: 完成归因后台控制面回归"
```
