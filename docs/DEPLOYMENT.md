# Cloudflare 部署说明

## 架构

| 组件 | production | dev |
|---|---|---|
| Web Worker | `meigallery-web` | `meigallery-web-dev` |
| API Worker | `meigallery-api` | `meigallery-api-dev` |
| D1 | `meigallery-db` | `meigallery-db-dev` |
| R2 | `meigallery-media` | `meigallery-media-dev` |
| 广告 Queue | Meta/TikTok/Google 独立 Queue/DLQ | 不绑定 |

生产域名：

- Web：`https://616618.xyz`、`https://www.616618.xyz`
- API：`https://api.616618.xyz`

Web 和 API 都部署为 Cloudflare Workers，不使用 Cloudflare Pages。

## 首次初始化

```bash
./scripts/setup.sh
```

初始化脚本负责创建 Cloudflare 资源。首次发布前还需要配置 Worker secrets。

## 正式部署

完整 lint、测试、覆盖率、Playwright、类型检查和构建由 PR CI 执行。合入 `main` 后，根据实际影响范围选择一次部署命令：

```bash
# 只改 API、归因后端或 migration
./scripts/deploy.sh production api

# 只改 Web 或后台前端
./scripts/deploy.sh production web

# API 与 Web 同时修改
./scripts/deploy.sh production all
```

正式脚本要求：

- 当前分支是干净的 `main`。
- Wrangler 已登录。
- API 部署通过 TypeScript；migration 测试统一在 CI 执行，production 发现任意待执行 migration 时先导出 D1 备份。
- Web 部署通过 Nuxt build。
- 只在部署 API 时检查和应用 D1 migration。
- production 存在任意待执行 migration 时由脚本导出 D1 备份；专项高风险 migration 还必须满足各自附加门禁。
- API 与 Web 都先上传不接流量的 Worker Version，再执行向后兼容的 migration；成功后连续激活两个已就绪 Version。删除列或表的 contract migration 必须等兼容代码先完成独立生产发布后，再在下一次发布执行。
- 部署后仅验证受影响服务。

生产验证不要求 API 和 Web 的 Git commit 相同。commit 仍写入 Worker 供观察和排障，但不参与运行时或发布放行。

运行期 dead letter、过期 Outbox、critical incident 或连接配置异常会输出警告，不能阻止修复版本发布。服务不可用、最终归因核心表缺失或旧控制面表重新出现才视为阻断。

## Dev 部署

```bash
./scripts/deploy.sh dev api
./scripts/deploy.sh dev web
./scripts/deploy.sh dev all
```

dev 使用独立 Worker、D1 和 R2，不绑定真实广告 Queue，不执行 Cron，也不请求真实广告平台。Meta、TikTok、Google 的最终人工验证默认在 production 完成。

### Wallet-1 dev migration

`0077_app_wallet_ledger.sql` 尚未获准远端执行。一次性 D1 + 临时 Worker 的完整功能 smoke、失败自动销毁、30 天证据清理和局部决策包已经完成，但机器 gate 当前保持关闭，尚未创建任何远程资源。先按 `docs/app/WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md` 明确确认仅限合成 smoke 的局部结论和当次执行，再按 `docs/app/WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md` 完成隔离 smoke；通过不自动关闭全局 OQ，也不自动放行共享 dev。共享 dev 前仍须关闭全局 OQ-018、OQ-020、OQ-024 并再次获得明确批准，才生成仓库外短期备份清单：

```bash
corepack pnpm prepare:wallet1:dev
```

清单只在 30 分钟内对同一 `dev` commit、同一 D1 bookmark 和严格 `0075`～`0077` migration 队列有效。随后按输出的绝对路径执行：

```bash
ALLOW_WALLET1_DEV_MIGRATIONS=true \
WALLET1_DEV_READINESS_MANIFEST=/绝对路径/到/manifest.json \
./scripts/deploy.sh dev api
```

部署脚本会在写入前复验 manifest，并在 migration/Worker 完成后自动执行只读 schema 验收。Wallet-1 用户、管理员和通知生成开关仍保持关闭。可手工重复只读验收：

```bash
corepack pnpm verify:wallet1:schema:dev
```

production 只要仍有 `0077` 待执行就会被部署脚本硬阻断，不能沿用 dev 放行变量。共享 dev 不执行会产生不可删除分录的功能 smoke；共享 dev 的完整流程、失败处理和 Time Travel 边界见 `docs/app/WALLET_1_DEV_VALIDATION_RUNBOOK.md`，一次性功能验收见 `docs/app/WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md`。

## CI

`.github/workflows/ci.yml` 在 PR 到 `main`/`dev` 和推送 `dev` 时执行：

- 依赖锁定安装
- ESLint
- 脚本与 migration 测试
- dev 资源隔离检查
- Shared/API/Web 测试
- API 覆盖率
- API/Web 类型检查
- Playwright
- API dry-run 与 Web build

正式发布不在本机重复这套全量流程。

## Production 验证

```bash
node scripts/verify-production.mjs api
node scripts/verify-production.mjs web
node scripts/verify-production.mjs all
```

API 验证：

- `/api/health` 可用且环境为 production。
- 最终归因核心表完整且旧控制面表不存在。
- 启用的平台连接具有有效通道、一份当前凭证和两个标准事件绑定。

Web 验证：

- `/__release` 可用且环境为 production。

Web 部署后还执行：

```bash
node scripts/verify-production-seo.mjs
```

## D1 备份

高风险 migration 由部署脚本自动执行：

```bash
node scripts/export-production-d1-backup.mjs
```

备份写入仓库外的 `~/.meigallery/production-backups/d1`，包含 SQL、SHA-256、Git commit 和 Time Travel bookmark。不要把备份、凭证或 token 写入仓库。

`0062_attribution_runtime_garbage_cleanup.sql` 只删除早于当前连接配置的质量快照和无读取方的空 usage 表。部署前后必须核对连接、凭证、事件映射和业务事实数量不变。

`0063_attribution_tracking_source_contract.sql` 只重建推广来源表并删除旧 proof 列。部署脚本必须先导出生产 D1 备份，再应用 migration；迁移前后逐字段核对全部推广来源，且生产验证要求该旧列为零。

`0017_cases_cleanup.sql` 仍需先完成 R2 Cases 专项核验，确认后显式设置：

```bash
ALLOW_CASES_CLEANUP_MIGRATION=true ./scripts/deploy.sh production api
```

## Secrets

API production 必填：

```text
SESSION_SECRET
TURNSTILE_SECRET_KEY
AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT
```

按功能启用：

```text
STREAM_ACCOUNT_ID
STREAM_API_TOKEN
TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT
TELEGRAM_BOT_TOKEN_OPS_CASE_BOT
```

独立 App 账号能力当前默认关闭。只有 G-01/G-03 结论、正式文档版本和客户端安全存储验收完成后，才可在目标环境同时配置：

```text
APP_AUTH_ENABLED=true
APP_AUTH_REGISTRATION_ENABLED=true
APP_AUTH_TERMS_VERSION=<正式条款版本>
APP_AUTH_PRIVACY_VERSION=<正式隐私版本>
APP_AUTH_PLATFORM_NOTICE_VERSION=<正式平台运营说明版本>
APP_AUTH_ELIGIBILITY_VERSION=<正式必要资格说明版本>
APP_AUTH_TERMS_URL=<正式条款 HTTPS URL>
APP_AUTH_PRIVACY_URL=<正式隐私政策 HTTPS URL>
APP_AUTH_PLATFORM_NOTICE_URL=<正式平台运营说明 HTTPS URL>
APP_AUTH_ELIGIBILITY_URL=<正式必要资格说明 HTTPS URL>
APP_AUTH_TURNSTILE_SITE_KEY=<App 人机验证公开 Site Key>
TURNSTILE_SECRET_KEY=<对应 Secret>
```

任一必要值缺失或非法时 bootstrap 必须保持 `auth=false`。production 文档入口只接受无账号密码、无 fragment 的 HTTPS URL；本地调试才允许 localhost、127.0.0.1 和 Android 模拟器 `10.0.2.2` 的 HTTP URL。production 继续显式设置 `APP_AUTH_ENABLED=false` 和 `APP_AUTH_REGISTRATION_ENABLED=false`；不得仅为联调修改 production 值。`0069_app_account_access.sql` 在正式身份数据接入前仍需生产备份、隐私/保留期评审和独立 migration 授权。

Account/Settings-2 预留三个非敏感运行开关：`APP_ACCOUNT_PROFILE_ENABLED`、`APP_INITIAL_PREFERENCES_ENABLED`、`APP_CONVERSATION_SETTINGS_ENABLED`。它们当前不写入 Wrangler，未配置即按 `false` 处理；只有 `0095_app_account_profile_and_conversation_settings.sql` 在目标环境完成迁移、依赖的 Auth/Taxonomy/Recommendation/Messaging 能力可用，并通过专项验收后，才在配置阶段逐项加入。bootstrap 与对应私有路由会再次检查依赖，不能通过只设置单一开关绕过底层能力门禁。

dev 当前只为 Safety-2 联调开放已有测试会话所需的 Auth、举报与申诉能力；注册、会员、消息以及全部 production-ready 门禁继续关闭。四类开发文档暂统一指向 dev Web `/rules`，版本为 `dev-rules-2026-08-07`，不得复制到 production。部署后执行：

```bash
corepack pnpm verify:safety2:dev
```

脚本会创建随机且隔离的观看者与两名审核员测试数据，验证“举报 → 原审核员无违规结论 → 原审核员领取申诉被拒 → 独立审核员改判 → 举报重新调查”，并检查敏感读取和结论审计；无论成功或失败都尝试删除测试数据。执行前必须显式确认目标为 `meigallery-db-dev`。

本地自动化或模拟器联调可临时使用 Cloudflare 官方 always-pass 测试 Site Key/Secret。其 Siteverify 响应的 `action` 可能为 `test` 或缺失，因此服务端只在 `APP_ENV=local` 且 Secret 精确匹配官方公开测试 Secret 时兼容；`dev`、`production` 和真实密钥继续严格校验业务 action，production 额外校验 hostname。官方测试密钥不得写入仓库配置或部署到远端环境。

仅主密钥轮换窗口配置：

```text
AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS
```

平台 Pixel ID、Dataset ID、Tag ID 和加密凭证通过管理后台“归因 > 平台连接”保存，不作为 Worker 明文环境变量分散配置。

设置 secret 示例：

```bash
corepack pnpm --filter @meigallery/api exec wrangler secret put SESSION_SECRET --env=""
corepack pnpm --filter @meigallery/api exec wrangler secret put AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT --env=""
```

## 回滚

Worker 代码回滚使用 Cloudflare Worker version rollback。D1 migration 不执行逆向 SQL；需要数据恢复时使用部署前备份或 D1 Time Travel。

回滚原则：

1. Web 故障只回滚 Web。
2. API 故障只回滚 API。
3. 不因 API/Web commit 不同而强制双端回滚。
4. 归因平台故障不删除事实，只暂停对应连接或 Server 通道。
5. 凭证轮换失败时恢复上一份有效凭证，不修改事实和来源。

## 上线检查

- PR CI 全部通过。
- production 从干净 `main` 发布。
- 部署范围与实际改动一致。
- migration 前备份成功。
- 受影响服务生产验证通过。
- 管理后台凭证不回显，日志无 token。
- Meta、TikTok、Google 来源隔离测试持续通过。
