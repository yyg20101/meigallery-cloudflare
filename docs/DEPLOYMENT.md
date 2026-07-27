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
- API 部署通过 TypeScript；只有 `0061_attribution_source_router_cleanup.sql` 待执行时才运行对应 migration 测试。
- Web 部署通过 Nuxt build。
- 只在部署 API 时检查和应用 D1 migration。
- 只在高风险 migration 待执行时导出 production D1 备份。
- API 与 Web 都先上传不接流量的 Worker Version，再执行 migration；成功后连续激活两个已就绪 Version，避免迁移后才上传 Web 造成新旧归因协议并存。上传本身完成 Worker 构建校验，migration 失败时线上继续使用旧 Version。
- 部署后仅验证受影响服务。

生产验证不要求 API 和 Web 的 Git commit 相同。commit 仍写入 Worker 供观察和排障，但不参与运行时或发布放行。

运行期 dead letter、过期 Outbox、critical incident 或连接配置异常会输出警告，不能阻止修复版本发布。服务不可用或本版本要求的 `0061_attribution_source_router_cleanup.sql` 未应用才视为阻断。

## Dev 部署

```bash
./scripts/deploy.sh dev api
./scripts/deploy.sh dev web
./scripts/deploy.sh dev all
```

dev 使用独立 Worker、D1 和 R2，不绑定真实广告 Queue，不执行 Cron，也不请求真实广告平台。Meta、TikTok、Google 的最终人工验证默认在 production 完成。

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
- `0061_attribution_source_router_cleanup.sql` 已应用。
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
