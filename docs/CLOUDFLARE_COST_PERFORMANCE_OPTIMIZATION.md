# Cloudflare 成本与性能优化记录

> 核对日期：2026-06-16  
> 范围：`meigallery-api`、`meigallery-web`、D1、R2、Images Transformations、Stream、Workers Logs。

## 官方费用口径

以下仅记录当前优化决策用到的关键计费项，具体金额以后续 Cloudflare 官方文档为准。

| 产品 | 官方计费点 | 对本项目的影响 | 官方文档 |
|------|------------|----------------|----------|
| Workers | Standard 计划包含 1000 万 Worker 请求/月和 3000 万 CPU ms/月，超出后按请求数和 CPU 计费；静态资源请求免费且不限量。 | SSR 页面和 API 是主要 Worker 请求来源；`/_nuxt/*` 必须继续走 Workers Assets 静态资源。 | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers Logs | Paid 计划包含 2000 万 log events/月，超出按事件数计费；可用 `head_sampling_rate` 控制采样。 | 逐请求日志会放大日志事件和 CPU，生产不应 100% 记录访问日志。 | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| D1 | 按 rows read、rows written 和存储计费；未查询时不收计算资源费用。 | 首页、列表、搜索、公开设置和分析报表必须避免不必要扫描。 | https://developers.cloudflare.com/d1/platform/pricing/ |
| R2 | 按存储、Class A 写操作、Class B 读操作计费；标准存储含免费额度且无公网 egress 费用。 | 图片读取和导出文件下载会产生 Class B；上传和导出写入会产生 Class A。 | https://developers.cloudflare.com/r2/pricing/ |
| Images Transformations | 按每月 unique transformation 计费，免费额度后按每 1000 次计费。 | 缩略图必须控制规格数量，避免同一原图产生多组宽度、质量和格式组合。 | https://developers.cloudflare.com/images/pricing/ |
| Stream | 视频按存储分钟数和交付分钟数计费；带宽包含在交付分钟里；编码免费。 | 当前 `video_enabled=false` 是成本安全默认值；接入前必须先做容量测算和播放策略。 | https://developers.cloudflare.com/stream/pricing/ |

## 已落地优化

| 优化项 | 改动 | 成本/性能收益 | 风险控制 |
|--------|------|---------------|----------|
| 降低 Workers Logs 采样 | 生产 `head_sampling_rate=0.05`，开发 `0.1`。 | 生产日志采样从 100% 降到 5%，直接降低 log events 写入量。 | 保留 5% 请求样本；错误仍通过 `console.error` 暴露在被采样请求上下文中。 |
| 关闭生产逐请求 logger | `hono/logger` 仅在非生产环境启用。 | 减少每个 API 请求的日志事件和 CPU 开销。 | 生产仍保留结构化错误日志和 Cloudflare Observability 采样。 |
| 公开设置短缓存 | `/api/settings/public` 生产返回 `public, max-age=60, stale-while-revalidate=300`。 | 减少浏览器重复请求，降低公开设置读取造成的 D1 rows read。 | 后台保存后使用 `_fresh` 查询参数强制刷新，避免 SEO 同步状态读取旧缓存。 |
| 静态资源长期缓存 | 构建产物 `_headers` 已对 `/_nuxt/*` 和字体设置一年 immutable。 | 静态资源请求由 Workers Assets 免费缓存服务，不额外触发 SSR Worker。 | 保持 hash 文件名；不要为 `/_nuxt/*` 配置 `run_worker_first`。 |
| 图片转换单规格 | 公开缩略图固定 `w=480`、`webp`、`quality=80`。 | 控制 Images Transformations unique 组合数量。 | 详情页暂复用同规格，后续新增规格前必须测算 unique transformations。 |
| 分析默认关闭和采样 | `analytics_enabled=false`、`analytics_sample_rate=0.01`。 | 避免未上线运营分析前写入 D1 明细和聚合。 | Owner 显式开启；后台健康页监控 D1 预算。 |
| Stream 暂不启用 | `video_enabled=false`，Stream secrets 缺失时返回 503。 | 避免 729 个待处理视频直接产生 Stream 存储和交付成本。 | 接入前按分钟数而非文件大小测算。 |

## 后续监控阈值

| 指标 | 观察入口 | 建议阈值 | 处理动作 |
|------|----------|----------|----------|
| Workers Logs events | Cloudflare Workers Observability / Billing | 月度趋势超过 2000 万前预警 | 将生产采样从 5% 下调到 1%，并增加错误专用日志字段。 |
| D1 rows read | D1 Metrics > Row Metrics | 公开接口 rows read 突增 | 检查列表、搜索、公开设置和 sitemap 是否发生全表扫描。 |
| D1 rows written | D1 Metrics > Row Metrics | 分析开启后接近每日写入预算 | 降低 `analytics_sample_rate`，优先保留转化事件。 |
| R2 Class B | R2 Metrics / Billing | 图片读操作持续上升 | 对公开媒体路径增加更长浏览器缓存或 Cache API；避免私有媒体 CDN 化。 |
| Images unique transformations | Images Usage / Billing | 接近免费额度前 | 继续单规格；不要新增 320/768/1024 等多规格，除非运营收益明确。 |
| Stream delivered minutes | Stream Analytics / Billing | 视频功能上线后每日检查 | 禁止自动预加载完整视频，优先使用预览图和点击播放。 |

## 不建议当前引入的优化

| 方案 | 暂缓原因 |
|------|----------|
| Cloudflare Queues / Workflows | 当前 zip 导入未真正异步处理大文件；引入会增加复杂度，等完整 zip 流程启动再评估。 |
| R2 Infrequent Access | 素材图库图片会被持续访问；IA 读取和取回有额外费用，当前不适合作为默认存储类。 |
| 多尺寸响应式图片 | 会提升视觉性能，但会放大 unique transformations；当前先维持单规格。 |
| Stream 批量启用 | Stream 按视频分钟存储和播放分钟交付计费；没有视频运营策略前不应打开。 |
| 为公开设置接入 KV | 目前 60 秒短缓存足够；若公开设置成为高频瓶颈，再用 KV 做跨 isolate 缓存。 |
