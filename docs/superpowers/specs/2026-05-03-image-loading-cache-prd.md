# 图片加载与缓存体验优化 PRD

### 1. Executive Summary

**Problem Statement**: 当前公开缩略图在免费方案下会直接返回原图，列表、首页和详情页可能重复传输过大的图片资源，导致移动端流量消耗高、首屏图片加载慢。Cloudflare Images Transformations 已支持对 R2 等外部来源图片进行边缘转换，按当前站点图片量估算成本较低，继续只依赖原图回退会错过明显的性能收益。

**Proposed Solution**: MVP 接入 Cloudflare Images Transformations + R2：图片继续存储在 R2，通过 API Worker 统一输出 480px、800px、1280px 三档转换规格，并配合 Worker/CDN/浏览器缓存、前端懒加载与首屏预加载。受保护图片仍必须经过服务端鉴权，不迁移到 Cloudflare Images 存储模式。

**Success Criteria**:

- 首页和发现页首屏图片可见时间 P75 较优化前降低 30% 以上，基于 Lighthouse 或 WebPageTest 移动端模拟网络统计。
- 首页、发现页、搜索页列表首屏图片总传输体积 P75 较优化前降低 35% 以上，基于浏览器 Network 记录统计。
- 重复访问同一公开图库详情页时，公开图片 80% 以上命中浏览器缓存或 Cloudflare 边缘缓存，图片请求不重新下载完整内容。
- 以当前约 2,821 张图片、3 个转换规格估算，Images Transformations 月成本控制在 2 美元以内；图片增长到 10,000 张以内时月成本目标控制在 15 美元以内。
- 受保护图片不得被匿名用户访问，且不得通过公开缓存泄露会员资源；鉴权失败场景保持 401/403。
- 全站图片加载失败率 P95 低于 1%，失败口径为图片请求 4xx/5xx 或前端 `error` 事件。

### 2. User Experience & Functionality

**User Personas**:

- 访客用户：未登录浏览首页、发现页、搜索页和公开图库，希望页面快速出现可浏览内容，且不消耗过多移动流量。
- 登录会员：浏览公开图和会员图，希望详情页大图切换顺畅，已看过的图片不重复加载。
- 管理员：在后台管理图库、封面和媒体，希望图片预览稳定，不因缓存导致刚上传或替换的图片长期显示旧图。

**User Stories**:

- As a 访客用户, I want 首页和列表页优先加载适合卡片尺寸的封面 so that 我可以快速浏览内容并减少移动流量消耗。
- As a 访客用户, I want 页面滚动到图片附近时再加载非首屏图片 so that 初始页面不会一次性下载全部图片。
- As a 登录会员, I want 图库详情页打开大图时优先复用已加载资源并预取相邻图片 so that 左右切换更顺滑。
- As a 登录会员, I want 受保护图片只在我有权限时加载 so that 会员资源不会被未授权访问或公开缓存。
- As a 管理员, I want 替换封面或媒体后前台能在可控时间内刷新 so that 内容更新不会被旧缓存长期影响。

**Acceptance Criteria**:

- 首页、发现页、搜索页、相关图库、热门推荐、视频专区和后台图库列表中所有封面图片必须使用统一图片组件或等价加载策略。
- 首屏关键图片必须支持 `fetchpriority="high"` 或等价预加载策略；非首屏图片必须使用 `loading="lazy"` 和 `decoding="async"`。
- 列表封面必须请求 480px 规格资源；详情页网格图必须请求 800px 规格资源；Lightbox 大图必须请求 1280px 规格资源，且只在用户点击后触发。
- 公开图片转换必须使用 `format=auto` 和质量参数，默认质量范围为 75-82，具体默认值在技术方案中通过实测确定。
- 公开图片响应必须带 `Cache-Control`、`ETag`，并支持浏览器条件请求；公开稳定资源缓存 TTL 不低于 7 天。
- 封面图替换后必须通过版本化 URL、更新时间参数或短期缓存策略确保 24 小时内可见新图。
- 受保护图片响应必须保持 `private` 缓存语义，不允许写入公共 CDN 缓存，不允许匿名访问。
- 图片加载失败时必须展示占位 UI，不得造成页面布局跳动或空白卡片。
- 后台图片预览可以使用较短缓存或版本化 URL，确保管理员保存后能确认新资源。

**Non-Goals**:

- 本期不迁移到 Cloudflare Images 存储模式，图片原始文件继续存放在 R2。
- 本期不建设自研媒体转码管线，不在 Worker 中自行实现图片缩放、裁剪、压缩或格式编码。
- 本期不一次性提供超过 3 个公共转换规格，避免唯一转换量失控。
- 本期不改变受保护媒体的权限模型，不放宽任何会员访问控制。
- 本期不引入非 Cloudflare 基础设施、第三方图片 CDN 或外部对象存储。
- 本期不处理视频 Stream 接入和视频转码优化。

### 3. AI System Requirements (If Applicable)

**Tool Requirements**: 不适用。本功能不包含 AI 生成、AI 推荐或 AI 判断链路。

**Evaluation Strategy**: 不适用。质量评估通过 Web 性能指标、缓存命中率、网络传输体积和权限回归测试完成。

### 4. Technical Specifications

**Architecture Overview**:

- 图片源数据保留在 Cloudflare R2，API Worker 继续作为唯一媒体访问入口。
- Web Worker SSR 返回页面 HTML 和图片 URL；浏览器按图片组件策略请求 API Worker 的图片端点。
- API Worker 根据资源类型返回不同缓存头：公开封面、公开缩略图、公开头像允许公共缓存；受保护图片只允许私有短缓存。
- API Worker 对公开 R2 图片生成 Cloudflare Images Transformations URL 或通过 Workers Images binding 调用转换能力，输出 480px、800px、1280px 三档资源。
- 公开转换资源使用 `format=auto`，由 Cloudflare 根据浏览器能力输出 WebP/AVIF 等合适格式；相同源图和相同参数的转换结果由 Cloudflare 边缘缓存复用。
- 公开图片优先利用 Cloudflare 转换缓存、Cloudflare 边缘缓存、浏览器 HTTP 缓存和 `ETag` 条件请求减少重复传输。

**Cost Model**:

- 官方计费口径：Cloudflare Images Transformations 前 5,000 个唯一转换/月免费，超出后按 `$0.50 / 1,000` 个唯一转换/月计费。
- 唯一转换按“原图 + 参数组合”计算；同一张图同一规格当月被重复访问，不重复计算 Images Transformations 费用。
- 当前站点约 2,821 张图片，MVP 采用 3 个规格时约 8,463 个唯一转换/月，扣除 5,000 免费额度后预计约 `$1.73/月`。
- 若未来增长到 10,000 张图片且仍保持 3 个规格，则约 30,000 个唯一转换/月，扣除免费额度后预计约 `$12.50/月`。
- 不使用 Cloudflare Images 存储模式，因此不产生 `Images Stored` 和 `Images Delivered` 费用；R2 原有存储与请求费用另按 R2 计费。

**Integration Points**:

- API Worker：`GET /api/media/cover/:galleryId`、`GET /api/media/:assetId/thumbnail?w=480|800|1280`、`GET /api/media/:assetId/access`、`GET /api/media/public/*`。
- R2：继续存储 `covers/*`、`originals/*`、`avatars/*`，本期不新增必需 bucket。
- D1：读取 `galleries.cover_key`、`media_assets.r2_key`、`media_assets.required_rank`、`galleries.updated_at` 等字段用于 URL 版本化和权限判断。
- Web 前端：统一或扩展 `FadeImage`，覆盖 `GalleryCard`、`HomeEditorialHero`、`HomeFeatured`、`RelatedGalleries`、`ImageViewer`、图库详情页图片网格、后台媒体预览。
- Auth：受保护图片继续依赖 `requireAuth`、`checkMediaAccess` 和会员 rank 判断。
- Cloudflare Images Transformations：仅用于公开图片转换；需在 Cloudflare Dashboard 对 `616618.xyz` 启用 Transformations，并在技术方案中确认 URL 格式或 Workers binding 接入方式。

**Security & Privacy**:

- 受保护图片不得通过 `/thumbnail` 公开端点返回；当前 `required_rank > 0` 返回 403 的行为必须保留。
- `/access` 返回图片时必须保留 `Cache-Control: private`，不得设置 `public` 或可被共享 CDN 缓存的头。
- 前端不得持有私有 R2 原始对象直链；所有受保护资源必须经 API Worker 校验。
- Cloudflare Images Transformations 只允许访问公开图片源，不得绕过 API Worker 权限校验直接转换私有 R2 对象。
- 外部迁移图片 URL 仍可直通，但需要在 PRD 后续技术方案中单独评估外部缓存可控性和隐私风险。
- 管理后台草稿、未发布图库和私有媒体不得出现在公开缓存路径。

**Testing Requirements**:

- API 单元测试覆盖公开图片缓存头、受保护缩略图 403、受保护 `/access` 私有缓存、`ETag` 返回。
- API 单元测试覆盖 480px、800px、1280px 三档转换参数白名单，非法宽度必须回退到安全默认值或返回 400。
- 前端组件测试或 E2E 检查封面图片是否带 `loading`、`decoding`、首屏优先级和占位布局。
- 使用浏览器 Network 或 Playwright 记录首页、发现页、图库详情页二次访问，验证图片请求命中缓存或返回 304。
- 使用 Cloudflare Images 用量面板或 API 每周记录唯一转换量，验证实际费用符合 2 美元/月 MVP 预算。
- 权限回归测试必须覆盖匿名用户访问 VIP/SVIP 图片失败、有效会员访问成功、会员过期后访问失败。
- 性能基准需记录优化前后移动端模拟网络下的图片总传输体积、LCP、首屏图片可见时间。

### 5. Risks & Roadmap

**Phased Rollout**:

- MVP：启用 Cloudflare Images Transformations；公开图片输出 480px、800px、1280px 三档；统一前端图片加载组件；补齐 `loading`、`decoding`、首屏优先级；调整公开图片缓存头；为封面 URL 加版本参数；补充缓存、费用和权限测试。
- v1.1：按真实访问数据决定是否增加 320px 或 1600px 规格；为热门图片加入预热策略；建立唯一转换量周报和异常告警。
- v2.0：当图片规模或成本增长超过预算时，评估 R2 持久化派生图、导入时离线生成缩略图，或迁移部分公开图到 Cloudflare Images 存储模式。

**Technical Risks**:

- 唯一转换数量与规格数量线性增长，若无白名单限制，任意 `w` 参数会造成成本失控。
- Cloudflare Images Transformations 超出免费额度后产生费用，需通过用量监控确保 MVP 月成本维持在 2 美元以内。
- Transformations 首次请求会触发源图读取和转换，冷启动图片仍可能比缓存命中慢，需要首屏关键图预加载和热门资源预热。
- 过长公共缓存可能导致封面替换后用户短期看到旧图，需要版本化 URL 或更新时间参数规避。
- 外部迁移图片不受 Cloudflare R2 缓存头完全控制，可能影响缓存命中和加载稳定性。
- 受保护图片缓存策略过宽会产生资源泄露风险，必须优先安全而非极限性能。
- 全站图片组件替换范围较广，可能影响首页视觉、Lightbox 交互和后台预览，需要分页面回归。

**Feedback Questions**:

- 是否确认 MVP 预算按当前图片量控制在 2 美元/月以内、10,000 张图片以内控制在 15 美元/月以内？
- 是否接受 MVP 仅开放 480px、800px、1280px 三档规格，暂不做更细的响应式 `srcset`？
- 封面更新可见性目标是否固定为 24 小时内，还是需要管理员保存后 5 分钟内可见？
