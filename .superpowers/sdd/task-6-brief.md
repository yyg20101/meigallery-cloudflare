### Task 6: 更新 live evidence、release gate 与生产冷启动

**Files:**
- Modify: `scripts/meta-live-verification-lib.mjs`
- Modify: `scripts/meta-live-verification-lib.test.mjs`
- Modify: `scripts/record-meta-live-verification.mjs`
- Modify: `scripts/record-meta-live-verification.test.mjs`
- Modify: `scripts/verify-dev-rehearsal.mjs`
- Modify: `scripts/verify-dev-rehearsal.test.mjs`
- Modify: `scripts/release-verification-lib.mjs`
- Modify: `scripts/release-verification-lib.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/verify-meta-resources.mjs`
- Modify: `scripts/verify-meta-resources.test.mjs`
- Modify: `scripts/deploy.sh`
- Modify: `packages/api/src/services/meta-connection.ts`
- Modify: `packages/api/src/services/meta-connection.test.ts`
- Modify: `packages/api/src/routes/admin/attribution.ts`
- Modify: `packages/api/src/routes/admin/attribution.test.ts`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/GIT_WORKFLOW.md`
- Modify: `docs/PROJECT_STATUS.md`

**Evidence schema v2:**

```ts
interface MetaLiveEvidenceV2 {
  schemaVersion: 2
  commitSha: string
  environment: 'dev' | 'production'
  pixelIdMasked: string
  connectionVerifiedAt: string
  capturedAt: string
  expiresAt: string
  events: Array<{
    eventName: 'Contact' | 'CompleteRegistration'
    browserEventId: string
    serverEventId: string
    browserSeen: boolean
    serverSeen: boolean
    deduplicated: boolean
    eventsReceived: 1
  }>
  enhancedMatch: {
    completeRegistrationEmail: boolean
    completeRegistrationExternalId: boolean
    contactContainsRegistrationIdentity: false
  }
  forbiddenEventsAbsent: {
    Lead: true
    StartTrial: true
  }
  datasetQualityContractVersion: number
  datasetQualityCollectorCurrent: boolean
}
```

- [ ] **Step 1: 写发布门禁失败测试**

覆盖：

- evidence 必须恰好包含 Contact、CompleteRegistration，各一组 Browser/Server 相同 event ID 且 deduplicated。
- 出现 Lead、StartTrial 或额外事件即失败。
- evidence commit 必须等于当前 40-char HEAD，环境匹配，24 小时内有效。
- resources verification 要求 migrations 0036/0037/0038/0039、Queue/DLQ、data key、verified connection、无 open critical incident。
- Dataset Quality contract 和 collector 未完成时 release 失败。
- production initial gate 要求 target/effective rollout 都为 0。
- production deploy 后 Test Event evidence 未通过时不能升到 10。
- production Owner Test Event 只在最终 main commit 已部署、target/effective rollout 均为 0、资源检查通过且无 open critical incident 时允许；否则 route 返回 409。
- deploy script 不自动改变 rollout。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test scripts/meta-live-verification-lib.test.mjs scripts/record-meta-live-verification.test.mjs scripts/verify-dev-rehearsal.test.mjs scripts/release-verification-lib.test.mjs scripts/verify-release.test.mjs scripts/verify-meta-resources.test.mjs
```

Expected: FAIL，旧 evidence 仍允许/要求 Lead，且没有 incident、rollout、connection、quality gate。

- [ ] **Step 3: 升级 evidence 与 release verifier**

旧 schema version 1 一律视为过期，不做自动转换。record script 逐项要求 Owner 确认 Events Manager 中 Browser、Server、deduplication、禁止事件缺席，并从 D1 readiness 读取增强匹配布尔覆盖，不要求用户输入 hash。

release verifier 固定执行：

```text
git clean/status gate
dependency install lockfile gate
lint
API/Web tests and coverage
script tests
API tsc
Web build
local-runtime verification
dev resource verification
current-commit dev live evidence
Dataset Quality collector freshness
open incident gate
production resource verification
initial rollout zero gate
```

- [ ] **Step 4: 实现冷启动发布顺序检查**

`verify-meta-resources --initial-meta-rollout` 明确检查 site setting target=0、无 open incident、secure outbox 无过期行、previous key active count 可解释。`deploy.sh production` 只部署 Worker，不写 site settings。

同时启用 production MetaConnection bootstrap：Owner 调用 admin Test Event route，使用 production 独立 Pixel/Dataset 和 test code；Meta 返回 `events_received=1` 后写入 production verification row，并绑定当前 `RELEASE_COMMIT`。普通 production CAPI payload 继续禁止 `test_event_code`。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
node --test scripts/meta-live-verification-lib.test.mjs scripts/record-meta-live-verification.test.mjs scripts/verify-dev-rehearsal.test.mjs scripts/release-verification-lib.test.mjs scripts/verify-release.test.mjs scripts/verify-meta-resources.test.mjs
corepack pnpm test:scripts
git diff --check
git add scripts packages/api/wrangler.toml packages/api/src/services/meta-connection.ts packages/api/src/services/meta-connection.test.ts packages/api/src/routes/admin/attribution.ts packages/api/src/routes/admin/attribution.test.ts docs/DEPLOYMENT.md docs/GIT_WORKFLOW.md docs/PROJECT_STATUS.md
git commit -m "test: 升级 Meta 生产发布证据门禁"
```

---

### 控制器补充约束（必须满足）

1. migration gate 使用当前真实范围 `0036..0040`，不得停留在计划旧值 0039；所有 remote migration 仍先执行只读 duplicate preflight。
2. Q5 未批准时，contract/collector gate 必须稳定失败并保持 production rollout 0；测试不得用伪 fixture 把当前仓库标成 release-ready。
3. Evidence V2 的 event ID 只能来自本次合成验证且必须是 opaque/non-PII；报告、CLI、审计只保存一致性布尔值或不可逆摘要，不输出用户级原始 ID。
4. production Test Event bootstrap 只允许 APP_ENV=production、当前 commit 40位且已部署、当前 production meta_resources passed/未过期、target/effective=0、无 open critical incident、独立 production Pixel/token/test code/data key/Queue 已配置。任一失败 409 且不 fetch、不写 verification。
5. production 合成 Test Event 可携带 test_event_code；普通 production delivery 继续禁止。不得复用 dev Dataset evidence。
6. deploy.sh 只能迁移/部署，不写 site_settings、不自动关闭 incident、不自动调整 rollout。测试扫描所有部署路径。
7. evidence v1 直接拒绝；V2 恰好两个事件，每个 Browser+Server ID相同、seen、deduplicated、eventsReceived=1，禁止 Lead/StartTrial/额外事件。
8. release verifier 查询失败全部 fail closed；current commit、24h、环境、contract version、collector freshness、incident、connection、resource 与 rollout 证据必须同一发布链。
9. 本任务只实现门禁与本地测试，不伪造 live evidence、不访问远端、不部署、不推送、不更新 progress.md。
