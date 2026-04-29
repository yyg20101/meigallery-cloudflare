# Cloudflare 部署说明

## 1. 部署目标

- 使用 GitHub 私有仓库作为代码源。
- 使用 Cloudflare Pages 自动部署前端和全栈函数。
- 使用 Cloudflare DNS 和全球 CDN 加速访问。
- 使用自定义域名提供正式访问入口。
- 使用 D1、R2、Stream、Turnstile 支撑数据、媒体和安全能力。

## 2. GitHub 关联自动部署

推荐流程：

1. 在 Cloudflare Dashboard 创建 Pages 项目。
2. 选择连接 GitHub。
3. 授权仓库 `yyg20101/meigallery-cloudflare`。
4. 设置生产分支为 `main`。
5. 设置构建命令和输出目录，具体取决于后续选择的前端框架。
6. 配置环境变量和 bindings。
7. 推送到 `main` 自动触发生产部署。
8. Pull Request 自动创建预览部署，用于验收 UI 和功能。

Cloudflare Pages 支持 Git integration，会在连接的 GitHub/GitLab 仓库发生代码变更时自动部署；预览部署可用于非生产分支和 PR 验收。

## 3. 自定义域名

推荐域名结构：

- `example.com`：前台正式站点。
- `www.example.com`：前台别名，跳转到根域名或反向。
- `admin.example.com`：后台管理入口。
- `media.example.com`：可选，未来用于公共缩略图或媒体域名。

配置步骤：

1. 将域名接入 Cloudflare DNS。
2. 在 Pages 项目中添加 Custom domains。
3. 绑定根域名和 `www`。
4. 后台可单独使用 Pages 路由或独立项目绑定 `admin` 子域名。
5. 开启 HTTPS，使用 Cloudflare 自动证书。
6. 配置从 `www` 到根域名的重定向策略。

如果根域名不在 Cloudflare nameserver 下，Pages 自定义域名能力会受限；正式部署建议把 DNS 托管到 Cloudflare。

## 4. 全球 CDN 加速

Cloudflare 会通过全球网络缓存和分发静态资源。建议：

- 静态构建产物由 Pages 自动分发。
- 公共缩略图使用长缓存，文件名带 hash。
- API 默认不做长缓存，只缓存公开且稳定的数据。
- 受保护媒体不放入公共缓存。
- 图片列表页可短 TTL 缓存，后台发布后刷新或等待自动过期。

## 5. Cloudflare 产品绑定

Pages:

- 承载前台和后台页面。
- 关联 GitHub 自动部署。
- 使用预览部署验收 PR。

Workers / Pages Functions:

- 提供 API。
- 校验登录、会员等级、媒体权限。
- 生成 R2 或 Stream 的短期访问能力。

D1:

- 存储结构化数据。
- 使用 migrations 管理 schema。

R2:

- 存储导入包、图片原图、缩略图、错误报告。
- 私有 bucket 存储受保护图片。

Stream:

- 存储和分发视频。
- 区分试看视频和完整视频。
- 完整视频使用签名访问或服务端授权播放。

Turnstile:

- 登录、注册、后台登录、导入操作保护。

## 6. 套餐建议

当前建议采用分阶段套餐，不在 MVP 一开始过度购买。

截至 2026-04-29 官方文档可参考的核心计费点：

| 产品 | 免费/包含量 | 主要超额计费 | 对本项目的影响 |
| --- | --- | --- | --- |
| Pages 静态资源 | 静态资源请求免费且不限量 | Pages Functions 按 Workers 请求计费 | 前台静态页面成本低，API 请求才是主要计算成本 |
| Pages Functions / Workers | Free 计划共享 Workers 免费请求额度 | Paid 计划按 Workers 规则计费 | 内测后建议升级 Workers Paid，避免 API 和 D1 使用受限 |
| D1 | Free 下有每日读写限制和 5 GB 总存储 | Workers Paid 包含更高月度读写量，超出后按 rows 计费 | 图库、标签、会员数据适合 D1，正式运营建议 Paid |
| R2 Standard | 每月 10 GB-month、100 万 Class A、1000 万 Class B 免费 | 存储、写请求、读请求按量计费，公网 egress 免费 | 图片和导入包适合 R2，缩略图读请求需要监控 |
| Stream + Images | Starter bundle 从 $5/月起，Creator bundle 从 $50/月起 | 按套餐包含的图片数量、视频存储分钟、视频分发分钟扩展 | 视频是成本重点，MVP 应限制完整视频体量和监控播放量 |

开发期:

- Cloudflare Free 计划用于 DNS、基础 CDN、Pages 原型部署。
- GitHub 私有仓库继续使用当前仓库。
- 少量 D1、R2、Stream 测试数据。

MVP 内测期:

- Workers Paid 计划用于更稳定的 Workers/D1 使用场景。
- R2 按存储和请求量计费。
- Stream 按视频存储分钟数和播放分发计费。
- 如果需要更高安全、分析、WAF 能力，再评估 Pro 或 Business。

正式运营期:

- 根据实际访问量、R2 存储量、Stream 视频分钟数、播放量估算月成本。
- 重点监控视频，因为视频通常是成本增长最快的部分。
- 如果域名、WAF、缓存规则、分析能力要求提高，评估 Cloudflare Pro/Business。

注意：Cloudflare 套餐、限制和价格会变化。每次上线或采购前都要以 Cloudflare 官方 pricing 和 docs 为准。

## 7. 环境规划

- `production`：绑定正式域名，连接 `main` 分支。
- `preview`：PR 和非 main 分支自动生成预览地址。
- `local`：本地开发，使用 Wrangler 或框架 dev server。

建议环境变量：

- `APP_ENV`
- `APP_BASE_URL`
- `ADMIN_BASE_URL`
- `SESSION_SECRET`
- `TURNSTILE_SECRET_KEY`
- `R2_BUCKET_NAME`
- `STREAM_ACCOUNT_ID`
- `STREAM_API_TOKEN`

## 8. 上线检查清单

- 域名 DNS 已接入 Cloudflare。
- Pages 项目已连接 GitHub 仓库。
- `main` 分支自动部署成功。
- D1 migrations 已执行。
- R2 bucket 已创建并设置私有访问策略。
- Stream 上传和播放流程验证通过。
- Turnstile site key 和 secret 已配置。
- 后台管理员账号已创建。
- WAF 和基本 rate limiting 已启用。
- 登录、搜索、详情、媒体权限、导入流程通过验收。

## 9. 参考资料

- Cloudflare Pages: https://developers.cloudflare.com/pages/
- Pages Git integration: https://developers.cloudflare.com/pages/configuration/git-integration/
- Pages custom domains: https://developers.cloudflare.com/pages/configuration/custom-domains/
- D1: https://developers.cloudflare.com/d1/
- R2: https://developers.cloudflare.com/r2/
- Stream: https://developers.cloudflare.com/stream/
- Turnstile: https://developers.cloudflare.com/turnstile/
- Cloudflare pricing: https://www.cloudflare.com/plans/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Stream pricing: https://www.cloudflare.com/products/cloudflare-stream/
- Pages Functions pricing: https://developers.cloudflare.com/pages/functions/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
