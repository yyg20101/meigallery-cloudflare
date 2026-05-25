# Cloudflare 部署说明

## 1. 架构概览

本项目完全基于 Cloudflare Workers 部署，不使用 Cloudflare Pages。

| 组件 | 服务 | 说明 |
|------|------|------|
| 前端 | `meigallery-web` Worker | Nuxt 4 + Nitro `cloudflare-module` + Workers Assets 静态资源托管 |
| API | `meigallery-api` Worker | Hono 框架，独立 Worker |
| 数据库 | D1（`meigallery-db`） | 结构化数据存储 |
| 存储 | R2（`meigallery-media`） | 图片、导入包、缩略图 |
| 视频 | Cloudflare Stream | 当前未接入；作为后续视频上传、编码、播放和访问控制目标 |
| 人机验证 | Turnstile | 登录、注册等关键操作保护 |

## 2. 域名结构

- `616618.xyz` → Web Worker（前台 + 后台管理）
- `api.616618.xyz` → API Worker
- Dev 测试入口使用 Workers dev 子域，例如 `meigallery-web-dev.<workers-subdomain>.workers.dev` 和 `meigallery-api-dev.<workers-subdomain>.workers.dev`，不绑定生产主域。

配置步骤：

1. 将域名接入 Cloudflare DNS。
2. 在 Workers 设置中绑定自定义域名（Custom Domains）。
3. 开启 HTTPS，使用 Cloudflare 自动证书。

## 3. 部署命令

本项目使用 pnpm workspace，推荐通过 `corepack pnpm` 调用仓库锁定的 pnpm 版本；`scripts/deploy.sh` 会自动检测裸 `pnpm`，不存在时回退到 `corepack pnpm`。

```bash
# 首次初始化
./scripts/setup.sh

# 部署
# 重要警告：生产环境中，当待发布包含 0017_cases_cleanup.sql 时，禁止直接运行一键部署。
# 必须先完成本地或 CI 构建预检，再按“R2 Cases 对象迁移”专项顺序完成
# dry-run、复制和目标对象验证，然后才执行 D1 remote migration 和部署。
./scripts/deploy.sh

# 或手动步骤：
# 1. API Worker 构建预检，不部署
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist

# 2. 构建前端
corepack pnpm --filter @meigallery/web exec nuxt build

# 3. D1 迁移
# 重要警告：如果待执行 migrations 包含 0017_cases_cleanup.sql，必须先完成：
# 构建预检 -> R2 Cases dry-run -> R2 复制和目标对象验证，再执行此 D1 remote migration。
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --env="" --remote

# 4. 部署 API Worker
corepack pnpm --filter @meigallery/api exec wrangler deploy --env=""

# 5. 部署 Web Worker
corepack pnpm --filter @meigallery/web exec wrangler deploy --env=""
```

## 4. CI/CD

**手动部署**：生产部署通过本地手动执行 wrangler deploy，且显式传入 `--env=""` 选择 wrangler 顶层生产配置。GitHub Actions 不负责生产部署，避免合入分支后自动影响线上用户。

```bash
corepack pnpm --filter @meigallery/api exec wrangler deploy --env=""
corepack pnpm --filter @meigallery/web exec wrangler deploy --env=""
```

## 5. 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `SESSION_SECRET` | API Worker secret | 会话签名密钥 |
| `TURNSTILE_SECRET_KEY` | API Worker secret | Turnstile 验证密钥 |
| `STREAM_ACCOUNT_ID` | API Worker secret | Cloudflare Stream 账户 ID |
| `STREAM_API_TOKEN` | API Worker secret | Stream API 令牌 |
| `CORS_ORIGIN` | API Worker vars | 前端域名（如 `https://616618.xyz`） |
| `IMAGE_RESIZING_ENABLED` | API Worker vars | 是否启用 Cloudflare Images Transformations；启用前需在 Dashboard 打开 Images > Transformations |
| `NUXT_PUBLIC_API_BASE_URL` | Web Worker vars | API 地址（如 `https://api.616618.xyz`） |

设置 secret：

```bash
corepack pnpm --filter @meigallery/api exec wrangler secret put SESSION_SECRET
corepack pnpm --filter @meigallery/api exec wrangler secret put TURNSTILE_SECRET_KEY
corepack pnpm --filter @meigallery/api exec wrangler secret put STREAM_ACCOUNT_ID
corepack pnpm --filter @meigallery/api exec wrangler secret put STREAM_API_TOKEN
```

## 6. Cloudflare 产品绑定

### Zone/Account 信息

- Account ID: `32b73e607476d0224c7ca40d28be1120`
- Zone ID: `2f7f49183fa463345e09432719af2c7d`（616618.xyz，Free 计划）
- D1 Database ID: `714929cb-003b-4cb1-bd9f-545fa1895e8c`
- R2 Bucket: `meigallery-media`

### Dev 环境

- `meigallery-api-dev` / `meigallery-web-dev`：用于正式上线后的开发测试环境。
- Dev Worker 使用 Workers dev 子域访问，不接入 `616618.xyz` 主域，不进入 sitemap、导航或公开链接。
- Dev 环境可以连接正式 D1/R2 数据以使用真实内容验证 UI，但后台写操作必须限定管理员账号、保留审计日志并显式标记为测试操作。
- Dev 页面必须带测试环境标识，并建议设置 `X-Robots-Tag: noindex, nofollow` 或等价 meta，避免搜索引擎收录。

Workers：

- `meigallery-web`：承载前台页面和后台管理界面，静态资源通过 Workers Assets 分发。
- `meigallery-api`：提供 API，校验登录、会员等级、媒体权限，生成 R2 或 Stream 的短期访问凭证。

D1：

- 存储结构化数据（图库、标签、用户、会员等级、审计日志）。
- 使用 migrations 管理 schema。

R2：

- 存储导入包、图片原图、缩略图、错误报告。
- 私有 bucket 存储受保护图片。

Stream（**当前状态：未接入**，secrets 为占位符）：

- 存储和分发视频。
- 区分试看视频和完整视频。
- 完整视频使用签名访问或服务端授权播放。

Turnstile：

- 登录、注册、后台登录、导入操作保护。

Email：

- Cloudflare Email Service 使用前需按 Cloudflare 官方文档和 Dashboard 当前状态确认可用计划、发信额度和费用；当前 `email_verification_enabled` 默认为 `false`。

### 生产速率限制

API Worker 已内置应用内兜底限流，但该实现使用 Worker isolate 内存计数，不保证跨边缘节点、跨 isolate 或重启后的全局一致性。生产环境必须额外配置 Cloudflare WAF / Rate Limiting Rules 作为边缘强防护。

建议生产规则：

| 规则 | 匹配表达式示例 | 计数特征 | 阈值 | 动作 |
|------|----------------|----------|------|------|
| 登录/注册 | `http.host eq "api.616618.xyz" and http.request.uri.path matches "^/api/auth/(login|register)$"` | IP | 5 次 / 60 秒 | Managed Challenge 或 Block |
| 公开 JSON API | `http.host eq "api.616618.xyz" and http.request.uri.path matches "^/api/(galleries|tags|search|cases|contact-methods)(/.*)?$"` | IP | 60 次 / 60 秒 | Managed Challenge 或 Block |
| 管理员 API | `http.host eq "api.616618.xyz" and http.request.uri.path starts_with "/api/admin/"` | session cookie 或 IP | 120 次 / 60 秒 | Managed Challenge 或 Block |
| 媒体访问签名 | `http.host eq "api.616618.xyz" and http.request.uri.path matches "^/api/media/[^/]+/access$"` | session cookie 或 IP | 30 次 / 60 秒 | Managed Challenge 或 Block |
| 外部导入 API | `http.host eq "api.616618.xyz" and http.request.uri.path starts_with "/api/imports/"` | IP | 120 次 / 60 秒 | Block |

配置要求：

- 先使用 Log 或 Managed Challenge 验证阈值，再切换到 Block。
- 规则的 Period、Requests、Characteristics、Mitigation timeout 和 Action 必须按 Dashboard 当前可用选项配置；不同 Cloudflare WAF 计划可用规则数和周期不同。
- 当前 Zone 为 Free 计划时，若规则数量不足以完整覆盖上表，至少启用登录/注册规则，并保留代码内兜底限流；媒体访问签名和管理员 API 需在上线风险清单中标注。
- 如果后续需要强一致的用户级或 session 级应用限流，可评估 Cloudflare Workers Rate Limiting binding、Durable Objects 或 D1 计数表；Workers Rate Limiting binding 仍按 Cloudflare location 本地生效，不应被描述为全球强一致。

### Workers Logs 与兼容日期

`packages/api/wrangler.toml` 和 `packages/web/wrangler.toml` 已显式启用 Workers Logs：

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

`env.dev` 使用 `[env.dev.observability]` 单独配置，避免环境覆盖后丢失日志采集。`head_sampling_rate = 1` 表示当前阶段保留 100% 请求日志；生产流量升高后可按 Cloudflare Workers Logs 当前额度、保留期和费用调整采样率。

兼容日期更新流程：

1. 上线前查阅 Cloudflare Workers compatibility dates / flags 官方文档和当前 Wrangler config schema。
2. 将 API/Web 的 `wrangler.toml` `compatibility_date` 和 Web 的 `nuxt.config.ts` `compatibilityDate` 同步更新到本次验证日期。
3. 运行 `corepack pnpm --filter @meigallery/api exec wrangler deploy --dry-run --env=""` 和 `corepack pnpm --filter @meigallery/web exec wrangler deploy --dry-run --env=""` 验证生产配置。
4. 如改动会影响 dev，同时运行 `--env=dev` dry-run。
5. 完成 API 类型检查、Web 构建和核心测试后，再执行真实部署。
6. 部署后在 Cloudflare Dashboard 的 Workers Observability / Logs 中确认 API 与 Web 均有请求日志；日志内容不得包含 token、cookie、Telegram Bot Token、R2 私有 key 或用户密码。

## 7. 全球 CDN 加速

- 静态资源由 Workers Assets 自动分发到全球边缘节点。
- 公共缩略图使用长缓存，文件名带 hash。
- `IMAGE_RESIZING_ENABLED=true` 时公共缩略图优先使用 Cloudflare Images Transformations，首期固定只请求 `w=480` 单规格，避免 Free 每月 5,000 unique transformations 被多规格消耗。
- Transformations 未启用、失败或返回 Free 超限错误（例如 9422）时，API 会回退返回原图，并继续设置 `Cache-Control: public, max-age=604800` 保持业务可用。
- API 默认不做长缓存，只缓存公开且稳定的数据。
- 受保护媒体不放入公共缓存。

## 8. 套餐建议

| 产品 | 当前策略 | 对本项目的影响 |
|------|----------|----------------|
| Workers | 生产上线前按官方 pricing 确认当前计划、请求量和是否需要 Paid | 内测后需要监控请求量、CPU 时间和构建部署限制 |
| D1 | 按官方 D1 limits 和 pricing 确认读写量、存储和备份策略 | 图库搜索、会员校验和后台列表是重点监控项 |
| R2 Standard | 按官方 R2 pricing 确认存储、读写请求和对象生命周期策略 | 图片原图、缩略图和导入包会持续增加存储与请求量 |
| Stream | 接入前按官方 Stream pricing 确认存储分钟、分发分钟和 signed URL 能力 | 视频是成本重点，MVP 应限制体量 |

注意：Cloudflare 套餐、限制和价格会变化。每次上线或采购前都要以 Cloudflare 官方 pricing 和 docs 为准。

## 9. 上线检查清单

- [ ] 域名 DNS 已接入 Cloudflare
- [ ] `meigallery-web` Worker 已部署并绑定 `616618.xyz`
- [ ] `meigallery-api` Worker 已部署并绑定 `api.616618.xyz`
- [ ] D1 数据库 `meigallery-db` 已创建，migrations 已执行
- [ ] R2 bucket `meigallery-media` 已创建并设置私有访问策略
- [ ] Stream 上传和播放流程验证通过（当前未接入）
- [ ] 所有 Worker secrets 已配置（SESSION_SECRET、TURNSTILE_SECRET_KEY、STREAM_ACCOUNT_ID、STREAM_API_TOKEN）
- [ ] CORS_ORIGIN 和 NUXT_PUBLIC_API_BASE_URL 已设置
- [ ] Turnstile site key 已在前端配置
- [ ] 后台管理员账号已创建
- [ ] WAF 和基本 rate limiting 已启用
- [ ] 登录、搜索、详情、媒体权限、导入流程通过验收

## 10. 旧站迁移部署计划

迁移 `https://zuole.me/` 时建议分阶段进行：

1. 新系统先部署到临时域名验证。
2. 使用 WordPress REST API 读取公开文章、分类、标签和媒体 URL。
3. 将图片迁移到 R2，将视频迁移到 Stream。
4. 所有迁移内容先进入草稿或待审核。
5. 完成分类和标签清洗后再批量发布。
6. 为旧文章 URL 生成跳转映射。
7. 正式切换域名时，将 `zuole.me` DNS 指向 Cloudflare Workers 自定义域名。
8. 保留旧 WordPress 站点只读备份，至少覆盖一个完整审核周期。

## 11. R2 Cases 对象迁移

`0017_cases_cleanup.sql` 会将真实案例表从 `testimonial_*` 切换为 `cases` / `case_images`，并将数据库中的 R2 key 从 `testimonials/...` 改为 `cases/...`。生产执行时必须先迁移 R2 对象，再执行 D1 迁移，避免数据库切表后引用不存在的对象。

执行前确认 Cloudflare Images Transformations 已按当前设计启用或已有等价降级策略，避免迁移后图片访问链路出现缩略图生成差异。

生产顺序：

```bash
# 1. 先完成本地或 CI 构建预检，不修改远程 D1 或 R2
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
corepack pnpm --filter @meigallery/web exec nuxt build

# 2. 查看将复制和将删除的映射，不修改 R2 或 D1
node scripts/migrate-cases-r2.mjs --dry-run --remote

# 3. 复制 testimonials/ 对象到 cases/，并通过 sha256 验证新旧对象内容一致
node scripts/migrate-cases-r2.mjs --remote

# 4. 再执行 D1 远程迁移；脚本不会自动执行 migration
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --env="" --remote

# 如需改用一键部署脚本在生产环境执行包含 0017 的迁移，必须先完成 R2 dry-run、复制和验证，
# 再显式设置以下环境变量解除 production-only 保护。
ALLOW_CASES_CLEANUP_MIGRATION=true ./scripts/deploy.sh

# 5. 部署 API 和 Web Worker，并完成 smoke 测试
corepack pnpm --filter @meigallery/api exec wrangler deploy --env=""
corepack pnpm --filter @meigallery/web exec wrangler deploy --env=""

# 6. smoke 通过后，显式删除旧 testimonials/ 对象
node scripts/migrate-cases-r2.mjs --remote --delete-old --confirm-delete-old=testimonials-to-cases
```

脚本说明：

- 默认 R2 bucket 为 `meigallery-media`，可用 `R2_BUCKET` 覆盖。
- 默认 D1 database 为 `meigallery-db`，可用 `D1_DATABASE` 覆盖。
- `--remote` 表示查询远程 D1，并对远程 R2 执行 `get` / `put` / `delete`；不带时使用本地 D1/R2。
- `--dry-run` 只打印 `testimonials/... -> cases/...` 映射和将删除的旧 key，不会写入 R2 或 D1。
- 正式复制时脚本会先 `r2 object get` 到临时文件，再带原始 MIME 类型 `r2 object put` 到新 key，并再次 `r2 object get` 目标 key；随后比较新旧临时文件 sha256，确保复制后内容一致。R2 操作会对临时网络错误自动重试。
- `--delete-old` 只删除旧 `testimonials/` 对象，必须同时带 `--remote` 和 `--confirm-delete-old=testimonials-to-cases`，并且必须在复制、验证、D1 migration、部署和 smoke 测试后执行；脚本不会自动执行 D1 migration。
- 删除阶段会先完整遍历所有映射，分别读取旧 `testimonials/...` 和新 `cases/...` 对象并比较 sha256；全部一致后才第二轮删除旧对象。如果旧对象不存在但新对象存在，会打印“跳过：旧对象不存在，可能是迁移后新增对象”，不失败也不删除；如果旧对象存在但新对象不存在或 hash 不一致，会中止并以非 0 状态退出，不删除任何旧对象。
- 映射清单合并 `testimonial_case_images.r2_key` 与 `external_import_files.r2_key` 两个来源，并按旧 `testimonials/...` key 去重。
- D1 已切表后，如果旧 `testimonial_case_images` 表已不存在，普通复制模式会合并 `case_images.r2_key` 与 `external_import_files.r2_key` 中的 `cases/...` key，并反推旧 `testimonials/...` key，用于补齐目标 R2 对象；删除阶段也使用同一映射来源。
- `scripts/deploy.sh` 会先完成 API dry-run 和 Web build，再进入 D1 migration 阶段；生产环境如果发现 `0017_cases_cleanup.sql` 仍在待执行迁移列表中，且未设置 `ALLOW_CASES_CLEANUP_MIGRATION=true`，会在 D1 migration 前中止，防止误跑一键部署导致 D1 先于 R2 迁移。0017 已应用或不在待执行列表时不会继续拦截后续生产部署。
- 如果本地 D1 已执行 `0017_cases_cleanup.sql`，旧表 `testimonial_case_images` 可能已不存在；此时本地 dry-run 提示旧表不存在属于预期，不代表脚本实现失败。

## 12. 参考资料

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Workers Assets: https://developers.cloudflare.com/workers/frameworks/
- Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- D1: https://developers.cloudflare.com/d1/
- R2: https://developers.cloudflare.com/r2/
- Stream: https://developers.cloudflare.com/stream/
- Turnstile: https://developers.cloudflare.com/turnstile/
- Cloudflare pricing: https://www.cloudflare.com/plans/
