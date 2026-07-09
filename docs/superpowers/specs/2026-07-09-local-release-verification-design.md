# 本地与准生产发布验证设计

## 0. 文档状态

- 日期：2026-07-09
- 状态：设计已确认，待实施计划
- 范围：本地验证、Cloudflare 本地运行时验证、隔离 dev 准生产演练、生产部署强阻断
- 不在范围：改动归因业务口径、引入非 Cloudflare 基础设施、复制生产媒体、自动部署生产

## 1. 背景

当前项目已经具备 CI 验证：lint、脚本测试、API/Web 类型检查、Web 单测、API 单测、API 覆盖率、Playwright mock smoke、Web build 和 API dry-run build。近期归因中心、Meta Pixel、Meta CAPI Queue、站内转化账本和后台数据分析已经接入，发布风险从“页面能否构建”升级为“Cloudflare 运行时、D1 migration、Queue、Worker secret、dev/production 资源隔离和部署顺序是否可控”。

现有 Playwright smoke 主要依赖 mock API，适合防 UI 和前端链路回归，但不能充分验证 API Worker + D1 + Queue 在 Cloudflare 本地运行时中的行为。`docs/DEPLOYMENT.md` 也记录了当前 dev 环境复用生产 D1/R2 的历史策略，这不适合后续广告投放、CAPI 联调和发布前准生产演练。

本设计目标是建立一套严格、可审计、默认不碰生产数据的发布验证体系，让正式环境问题尽量在本地和隔离 dev 阶段暴露。

Cloudflare 官方文档依据：

- D1 支持本地开发，`wrangler dev` 默认使用本地模式，本地 session 不会默认访问生产数据；D1 命令使用 `--local` 时操作本地数据库，不使用 `--local` 才操作远程数据库。
- Cloudflare Queues 支持本地开发，可在本地 Workers 运行时验证生产/消费逻辑。
- Workers 本地开发数据可以通过 Wrangler/Miniflare 管理，并用于模拟生产绑定。

参考链接：

- https://developers.cloudflare.com/d1/best-practices/local-development/
- https://developers.cloudflare.com/queues/configuration/local-development/
- https://developers.cloudflare.com/workers/local-development/local-data/

## 2. 目标

- 建立三层验证：`quick`、`local-runtime`、`dev-rehearsal`。
- dev 环境使用独立 D1/R2/Queue，不再复用生产 D1/R2。
- 生产部署必须读取最近一次验证报告，报告不满足条件时强制阻断。
- 本地默认不调用真实 Meta；dev 准生产演练允许使用测试 Pixel/token/Test Event Code 调用 Meta Test Events。
- 所有验证输出可审计、可复现、敏感信息脱敏。
- 验证失败时能明确指出失败层级、失败命令和建议处理方向。

## 3. 非目标

- 不把 GitHub Actions 改成生产自动部署。
- 不在本阶段实现 Meta Marketing API 广告花费、campaign、ad set 或 ad 数据导入。
- 不复制生产 R2 受保护媒体到 dev。
- 不把真实生产 Meta token 写入 dev 或本地环境。
- 不把全量媒体导入、视频 Stream 接入、真实广告后台报表作为发布闸门。
- 不让 mock smoke 替代 Cloudflare 本地运行时验证。

## 4. 推荐方案

采用“三层准生产验证”：

1. `quick`：日常开发快速验证。
2. `local-runtime`：本地 Cloudflare 运行时验证，使用 local D1/Queue/R2 或等价 mock，不出网调用真实 Meta。
3. `dev-rehearsal`：隔离 Cloudflare dev 资源准生产演练，部署 dev Worker，执行 dev migrations，按需调用 Meta Test Events。

生产部署脚本只接受同一 commit 的有效验证报告。报告必须显示 `local-runtime` 和 `dev-rehearsal` 均通过，否则生产部署中止。

放弃的方案：

- 只做轻量本地强检：速度快，但不能覆盖 D1/Queue/Wrangler 本地运行时。
- 每次创建临时 Cloudflare 全量环境：隔离最强，但实现和维护成本过高，容易让验证系统自身成为负担。

## 5. 验证分层

### 5.1 quick

用途：开发提交前和小改动后的快速反馈。

建议命令：

```bash
corepack pnpm verify:quick
```

覆盖：

- `corepack pnpm lint`
- `corepack pnpm test:scripts`
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit`
- `corepack pnpm --filter @meigallery/web typecheck`
- `corepack pnpm --filter @meigallery/api test`
- `corepack pnpm --filter @meigallery/web test:unit`
- `corepack pnpm --filter @meigallery/api test:coverage`
- `corepack pnpm --filter @meigallery/web test:e2e`
- `corepack pnpm --filter @meigallery/web build`
- `corepack pnpm --filter @meigallery/api build`

说明：

- `quick` 仍可使用 mock API 的 Playwright smoke。
- `quick` 通过不代表可以部署生产，只代表基础质量闸门通过。

### 5.2 local-runtime

用途：验证 API Worker 在 Cloudflare 本地运行时下的核心业务和降级行为。

建议命令：

```bash
corepack pnpm verify:local-runtime
```

要求：

- 使用本地 D1，不读取远程 D1。
- 使用本地 Queue 或 mock Queue consumer，不调用真实 Meta。
- 本地 R2 仅使用 fixture 或空 bucket。
- 每次验证前清理或隔离持久目录，避免历史本地状态污染。

覆盖：

- 本地 D1 应用全部 migrations。
- 启动 API Worker 本地运行时，访问 `/api/health`。
- 调用 `/api/conversions/events` 写入 `contact`，验证 D1 中出现 `analytics_conversion_actions`。
- `meta_capi_enabled=false` 时，CAPI delivery 必须为 `skipped/disabled`。
- `meta_capi_enabled=true` 且缺少 secret 时，CAPI delivery 必须为 `skipped/missing_secret`。
- CAPI payload mock 验证不包含邮箱、手机号、联系方式值、token、私有 R2 key、后台路径。
- Owner session 可读取 `/api/admin/attribution/overview`、`/api/admin/attribution/meta`、`/api/admin/attribution/readiness`。
- 非 owner 触发 `/api/admin/attribution/meta/test-event` 必须返回 403。
- 本地验证不得访问生产域名、生产 D1、生产 R2 或真实 Meta API。

### 5.3 dev-rehearsal

用途：验证隔离 Cloudflare dev 资源中的部署、migration、绑定、Worker secret 和核心用户链路。

建议命令：

```bash
corepack pnpm verify:dev-rehearsal
```

覆盖：

- 确认 `packages/api/wrangler.toml` 的 `[env.dev]` 绑定指向 dev 资源。
- 对 `meigallery-db-dev` 执行 remote migrations。
- 部署 `meigallery-api-dev` 和 `meigallery-web-dev`。
- 运行 dev URL smoke：首页、搜索、图库详情、登录、后台首页、归因中心。
- 创建投放追踪链接，访问链接后点击联系方式，后台能看到对应 `utm_content`、`contact` 和 `lead`。
- Owner 触发 Meta Test Event：
  - 配置测试 token/test code 时，允许调用 Meta Test Events。
  - 未配置测试 token 时，必须显示 `missing_secret`，不能误判为业务失败。
- 验证 dev 页面有测试环境标识和 noindex 策略。
- 验证脚本没有访问或写入生产域名、生产 D1、生产 R2。

## 6. dev 资源隔离

dev 环境资源固定命名：

| 类型 | dev 资源 |
|------|----------|
| D1 | `meigallery-db-dev` |
| R2 | `meigallery-media-dev` |
| Queue | `meigallery-meta-capi-dev` |
| API Worker | `meigallery-api-dev` |
| Web Worker | `meigallery-web-dev` |

`packages/api/wrangler.toml` 的 `[env.dev]` 需要改为 dev D1/R2/Queue 绑定。顶层生产配置继续指向生产资源。

dev 数据不直接从生产远程读取。准生产演练使用三类 seed：

- 最小系统 seed：owner/admin 用户、基础会员等级、必要站点设置、Pixel/CAPI 开关默认关闭。
- 业务 smoke seed：1-2 个图库、标签、联系方式、投放追踪链接、邀请码。
- 归因 seed：一次联系、注册、Lead、CAPI delivery 可验证路径。

R2 dev 只放测试图片或小型 fixture。后续若需要真实内容视觉验收，应单独设计脱敏样本导出，不纳入默认发布闸门。

## 7. secret 和外部服务边界

dev 使用独立 secret：

- `SESSION_SECRET`
- `TURNSTILE_SECRET_KEY`
- `META_CAPI_ACCESS_TOKEN`
- `META_CAPI_TEST_EVENT_CODE`

规则：

- dev 的 Meta token 必须指向测试 Pixel 或测试数据集。
- 生产 Meta token 不允许写入 dev。
- 本地验证默认不需要真实 secret。
- 缺失 secret 是必须覆盖的降级场景。
- 验证报告只记录 secret 是否存在，不记录 secret 值。
- 所有命令输出和报告必须脱敏 `token`、`secret`、`password`、`access_token` 等字段。

## 8. 验证报告

建议统一写入：

```text
reports/release-verification/
  latest.json
  history/
    2026-07-09T10-30-00Z-<sha>.json
```

报告字段：

```json
{
  "schemaVersion": 1,
  "commit": "git sha",
  "branch": "dev",
  "generatedAt": "2026-07-09T10:30:00.000Z",
  "expiresAt": "2026-07-10T10:30:00.000Z",
  "nodeVersion": "v24.x",
  "pnpmVersion": "10.x",
  "wranglerVersion": "4.x",
  "productionDeployAllowed": true,
  "resources": {
    "devD1": "meigallery-db-dev",
    "devR2": "meigallery-media-dev",
    "devQueue": "meigallery-meta-capi-dev"
  },
  "steps": [
    {
      "name": "quick",
      "status": "passed",
      "durationMs": 123000
    },
    {
      "name": "local-runtime",
      "status": "passed",
      "durationMs": 45000
    },
    {
      "name": "dev-rehearsal",
      "status": "passed",
      "durationMs": 180000,
      "metaTestEvent": "mock-or-real-or-skipped"
    }
  ]
}
```

报告是构建产物，不应提交到 Git。建议通过 `.gitignore` 忽略 `reports/release-verification/*.json` 和 `reports/release-verification/history/*.json`，但保留目录说明文档。

## 9. 生产部署强阻断

`./scripts/deploy.sh production` 在执行测试、migration 或部署前先检查验证报告。

阻断条件：

- 当前 commit 与报告 commit 不一致。
- 报告缺失。
- 报告已过期，默认有效期 24 小时。
- `local-runtime` 未通过。
- `dev-rehearsal` 未通过。
- `productionDeployAllowed` 不为 true。
- 工作树不干净。
- 当前分支不是 `main` 或明确允许的 `release/*`。
- 能通过 `gh` 查询 CI 时，同一 commit 的 CI 未成功。

紧急绕过：

```bash
ALLOW_PRODUCTION_VERIFY_BYPASS=true ./scripts/deploy.sh production
```

绕过要求：

- 打印醒目的中文风险提示。
- 要求二次确认。
- 要求填写 `PRODUCTION_VERIFY_BYPASS_REASON`。
- 写入 `reports/release-verification/bypass-<timestamp>.json`。
- 不把绕过报告提交到 Git。

默认不使用绕过。绕过只用于线上紧急修复且无法等待完整 dev 演练的场景。

## 10. 文件范围

预计实施涉及：

- `package.json`：新增 `verify:*` 命令。
- `scripts/verify-release.mjs`：编排 quick/local/dev 验证并生成报告。
- `scripts/verify-local-runtime.mjs`：本地 Cloudflare runtime smoke。
- `scripts/verify-dev-rehearsal.mjs`：隔离 dev 准生产演练。
- `scripts/release-verification-lib.mjs`：命令执行、版本采集、报告写入、脱敏输出。
- `scripts/deploy.sh`：生产部署前读取报告并硬阻断。
- `packages/api/wrangler.toml`：`env.dev` 改用独立 dev D1/R2/Queue。
- `docs/DEPLOYMENT.md`：补充验证体系、dev 资源隔离、强阻断和绕过规则。
- `docs/PROJECT_STATUS.md`：更新 dev 资源隔离状态。
- `reports/release-verification/README.md`：说明报告目录。
- `.gitignore`：忽略验证报告 JSON。
- `scripts/fixtures/release-smoke/*`：只放测试 seed，不放生产媒体。

## 11. 上线顺序

1. 提交本设计规格。
2. 用户审阅并确认规格。
3. 编写实施计划。
4. 实现脚本、dev 资源配置和文档。
5. 本地跑 `verify:quick` 和 `verify:local-runtime`。
6. 创建 dev D1/R2/Queue，并设置 dev secrets。
7. 跑 `verify:dev-rehearsal`。
8. 跑 `verify:release` 生成报告。
9. 只有报告通过后，生产部署脚本允许继续。

## 12. 成功标准

- `verify:quick` 能在本地稳定通过。
- `verify:local-runtime` 能在不访问生产资源、不调用真实 Meta 的情况下验证 D1/Queue/归因降级链路。
- `verify:dev-rehearsal` 能在独立 dev Cloudflare 资源上完成 migration、部署和核心 smoke。
- `./scripts/deploy.sh production` 能在缺失、过期、commit 不匹配或失败报告时阻断。
- 验证报告不包含 secret、token、联系方式明文、私有 R2 key、生产媒体 URL。
- dev Worker 不绑定生产域名，不进入 sitemap 或公开导航。
- CI 保持测试和构建验证，不承担生产自动部署。

## 13. 风险和缓解

| 风险 | 缓解 |
|------|------|
| 验证命令太慢，开发者跳过 | 分层设计，日常跑 `quick`，生产前跑 `verify:release` |
| dev 数据污染生产 | dev D1/R2/Queue 独立资源，脚本检查资源名 |
| Meta Test Events 不稳定影响发布 | 本地默认 mock；dev 真实 Test Event 失败只在配置了测试 token 时阻断 |
| 报告被旧 commit 复用 | 部署脚本检查当前 commit、分支和报告有效期 |
| GitHub artifact 配额满导致 CI 注解 | artifact 上传继续保持非阻断；发布阻断看测试/构建作业状态 |
| 本地持久 D1 状态污染 | `local-runtime` 每次使用隔离目录或清理策略 |

## 14. 待实施前确认

本设计已按用户确认采用：

- 准生产演练级别：最严路线。
- dev 资源隔离：新建独立 dev D1/R2/Queue。
- 生产部署：验证报告强阻断。
- Meta：本地 mock，dev 可用测试 token 调 Test Events。

实施计划应在下一阶段拆分任务，不在本设计阶段写代码。
