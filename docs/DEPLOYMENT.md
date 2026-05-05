# Cloudflare 部署说明

## 1. 架构概览

本项目完全基于 Cloudflare Workers 部署，不使用 Cloudflare Pages。

| 组件 | 服务 | 说明 |
|------|------|------|
| 前端 | `meigallery-web` Worker | Nuxt 3 + Workers Assets 静态资源托管 |
| API | `meigallery-api` Worker | Hono 框架，独立 Worker |
| 数据库 | D1（`meigallery-db`） | 结构化数据存储 |
| 存储 | R2（`meigallery-media`） | 图片、导入包、缩略图 |
| 视频 | Cloudflare Stream | 视频上传、编码、播放、访问控制 |
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

```bash
# 首次初始化
./scripts/setup.sh

# 部署
./scripts/deploy.sh

# 或手动步骤：
# 1. D1 迁移
cd packages/api && wrangler d1 migrations apply meigallery-db --remote

# 2. 构建前端
pnpm --filter @meigallery/web exec nuxt build

# 3. 部署 API Worker
pnpm --filter @meigallery/api exec wrangler deploy

# 4. 部署 Web Worker
pnpm --filter @meigallery/web exec wrangler deploy
```

## 4. CI/CD

**手动部署**：生产部署通过本地手动执行 wrangler deploy。GitHub Actions 不负责生产部署，避免合入分支后自动影响线上用户。

```bash
pnpm --filter @meigallery/api exec wrangler deploy
pnpm --filter @meigallery/web exec wrangler deploy
```

## 5. 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `SESSION_SECRET` | API Worker secret | 会话签名密钥 |
| `TURNSTILE_SECRET_KEY` | API Worker secret | Turnstile 验证密钥 |
| `STREAM_ACCOUNT_ID` | API Worker secret | Cloudflare Stream 账户 ID |
| `STREAM_API_TOKEN` | API Worker secret | Stream API 令牌 |
| `CORS_ORIGIN` | API Worker vars | 前端域名（如 `https://616618.xyz`） |
| `NUXT_PUBLIC_API_BASE_URL` | Web Worker vars | API 地址（如 `https://api.616618.xyz`） |

设置 secret：

```bash
cd packages/api
wrangler secret put SESSION_SECRET
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put STREAM_ACCOUNT_ID
wrangler secret put STREAM_API_TOKEN
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

- Cloudflare Email Service 需要 Workers Paid 计划（$5/月），`email_verification_enabled` 默认为 `false`。

## 7. 全球 CDN 加速

- 静态资源由 Workers Assets 自动分发到全球边缘节点。
- 公共缩略图使用长缓存，文件名带 hash。
- API 默认不做长缓存，只缓存公开且稳定的数据。
- 受保护媒体不放入公共缓存。

## 8. 套餐建议

| 产品 | 免费/包含量 | 主要超额计费 | 对本项目的影响 |
|------|-------------|--------------|----------------|
| Workers | Free 计划每日 10 万请求 | Paid 计划按请求量计费 | 内测后建议升级 Workers Paid |
| D1 | Free 下有每日读写限制和 5 GB 总存储 | Workers Paid 包含更高月度读写量 | 正式运营建议 Paid |
| R2 Standard | 每月 10 GB-month 免费，公网 egress 免费 | 存储、写请求、读请求按量计费 | 缩略图读请求需要监控 |
| Stream | Starter bundle 从 $5/月起 | 按视频存储分钟、分发分钟扩展 | 视频是成本重点，MVP 应限制体量 |

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

## 11. 参考资料

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Workers Assets: https://developers.cloudflare.com/workers/frameworks/
- Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- D1: https://developers.cloudflare.com/d1/
- R2: https://developers.cloudflare.com/r2/
- Stream: https://developers.cloudflare.com/stream/
- Turnstile: https://developers.cloudflare.com/turnstile/
- Cloudflare pricing: https://www.cloudflare.com/plans/
