# 图库互动数据 PRD

## 1. Executive Summary

**Problem Statement**: 当前图库只能展示内容本身，缺少点赞、访问量等基础互动信号，用户无法感知内容热度，站长也缺少可用于首页推荐和后台运营判断的数据依据。

**Proposed Solution**: 新增图库级互动数据能力，首期支持登录用户点赞/取消点赞、图库详情页 PV 统计、前台热度展示、后台互动数据查看，并用互动数据驱动首页推荐内容。

**Success Criteria**:
- 图库详情页每次成功访问发布状态图库时，`view_count` 必须增加 1；同一用户重复打开按 PV 口径重复计数。
- 登录用户可以对任一发布状态图库点赞和取消点赞，同一用户对同一图库最多保留 1 条有效点赞记录。
- 图库卡片、图库详情页、后台图库列表必须展示访问量和点赞数；后台图库列表支持按访问量或点赞数排序。
- 首页精选专题由互动热度推荐替代，默认优先展示高热度图库，不影响无限加载列表的基础浏览能力。
- API 类型检查、Web 构建和核心互动 API 单元测试必须通过，不引入受保护媒体权限绕过或私有资源直链暴露。

## 2. User Experience & Functionality

**User Personas**:
- 访客：未登录用户，希望通过访问量和点赞数判断哪些图库更受欢迎。
- 注册用户：已登录用户，希望用点赞收藏式表达偏好，并可再次点击取消点赞。
- 会员用户：VIP/SVIP 用户，希望首页优先看到高热度、高质量的图库内容。
- 管理员/Owner：希望在后台看到访问量和点赞数，用于判断内容表现、调整推荐和后续运营策略。

**User Stories**:
- As a 访客, I want to see gallery view and like counts so that I can quickly identify popular content.
- As a 登录用户, I want to like or unlike a gallery so that I can express preference without needing comments.
- As a 登录用户, I want the detail page to show whether I have liked the gallery so that I can avoid duplicate actions.
- As an 管理员, I want to see interaction metrics in the admin gallery list so that I can compare content performance.
- As an Owner, I want homepage recommendations to use interaction data so that high-engagement galleries get more exposure.

**Acceptance Criteria**:
- 前台图库卡片展示访问量和点赞数，数值为 0 时仍保持版式稳定，可显示 `0` 或弱化展示。
- 图库详情页展示访问量、点赞数和点赞按钮；未登录用户点击点赞时打开登录引导弹层。
- 登录用户点击点赞后，按钮状态在 500 ms 内完成本地反馈；服务端成功后同步最新点赞数。
- 登录用户再次点击已点赞按钮会取消点赞，点赞数不得小于 0。
- 服务端必须通过 session 确认用户身份后才允许写入点赞；前端传入的用户 ID 一律不可信。
- 图库详情 PV 只统计发布状态图库的正式详情访问，不统计后台预览、草稿、下架、404 或 API 错误响应。
- 后台图库列表展示 `view_count`、`like_count`，并支持按 `view_count desc`、`like_count desc` 排序。
- 首页热门推荐替代现有精选专题，使用互动数据排序；首期推荐公式为 `score = view_count + like_count * 5`，同分时按发布时间倒序。
- 管理员访问图库详情页同样计入 PV，本期不排除管理员登录态访问。
- 互动数据不改变会员访问控制；用户点赞或访问受保护图库时仍不能获得任何受保护媒体真实地址。
- 所有前台新增文案使用中文，符合“珍珠杂志感”视觉语气，不引入评论、私信、关注、动态流。

**Non-Goals**:
- 本期不做评论、弹幕、私信、关注、收藏夹或用户动态流。
- 本期不做访问 UV、独立访客识别、IP 地理分析或设备指纹。
- 本期不做复杂推荐算法、协同过滤、AI 推荐或个性化排序。
- 本期不开放用户上传内容，不改变会员购买和手动发放流程。
- 本期不向普通用户展示谁点赞了某个图库，也不展示用户点赞列表。

## 3. AI System Requirements (If Applicable)

**Tool Requirements**: 本需求不包含 AI 功能，不需要 LLM、向量检索、模型推理或 AI 工具调用。

**Evaluation Strategy**: 不适用 AI 输出质量评估。质量评估以 API 单元测试、前端状态验收、后台排序验收、构建验证和权限回归检查为准。

## 4. Technical Specifications

**Architecture Overview**:
- 前端仍使用 `packages/web` Nuxt 3 + Vue 3 + Tailwind CSS v4，图库卡片、详情页、首页推荐区和后台图库列表读取 API 返回的互动字段。
- API 仍使用 `packages/api` Hono Worker，通过 Cloudflare D1 持久化互动数据。
- D1 新增图库计数字段或独立统计表，用于保存 `view_count`、`like_count`、`updated_at`。
- D1 新增 `gallery_likes` 表，使用 `(gallery_id, user_id)` 唯一约束保证同一用户对同一图库最多 1 条点赞。
- 访问量按图库详情 PV 统计，首期采用同步 D1 计数写入；若后续写入压力上升，再评估 Queues 或 Durable Objects 聚合。

**Integration Points**:
- `GET /api/galleries`：返回 `view_count`、`like_count`，并支持首页推荐所需的热门排序参数。
- `GET /api/galleries/:slug`：返回详情互动数据和当前登录用户的 `liked_by_me` 状态；成功返回发布图库详情时累计一次 PV。
- `POST /api/galleries/:id/like`：登录用户点赞；返回最新 `like_count` 和 `liked_by_me=true`。
- `DELETE /api/galleries/:id/like`：登录用户取消点赞；返回最新 `like_count` 和 `liked_by_me=false`。
- `GET /api/admin/galleries`：返回后台互动字段，支持 `sort=view_count_desc` 和 `sort=like_count_desc`。
- 首页数据读取：新增或复用 `GET /api/galleries?sort=hot&pageSize=...`，`hot` 排序按 `view_count + like_count * 5` 计算。

**Security & Privacy**:
- 点赞写入必须要求登录 session，服务端从 session 中读取用户 ID，不接受前端传入用户 ID。
- 取消点赞只能删除当前登录用户自己的点赞记录，管理员也不通过该接口代替用户点赞或取消。
- 访问量只保存聚合 PV 计数，不保存 IP、User-Agent、设备指纹或精确访问轨迹。
- 互动 API 必须复用现有速率限制策略；点赞/取消点赞建议限制为每用户每分钟 30 次，每 IP 每分钟 60 次。
- 后台查看互动数据要求 admin+ 权限；本期后台只展示聚合计数，不展示用户点赞明细。
- 受保护媒体访问仍按现有 `media_asset.required_rank` 和会员 rank 服务端校验；互动数据不得影响权限判断。
- 所有后台排序和筛选参数必须使用白名单，不允许任意 SQL 字段拼接。

## 5. Risks & Roadmap

**Phased Rollout**:
- MVP：新增 D1 migration、API 字段、详情页 PV、登录点赞/取消点赞、未登录点赞引导弹层、前台卡片/详情展示、后台列表展示与排序、首页热门推荐替代精选专题。
- v1.1：补充后台热门内容概览卡片、按时间窗口统计趋势、人工置顶与互动热度混合推荐。
- v2.0：评估 UV、收藏夹、用户点赞列表、推荐解释和更细粒度运营分析，但仍不默认开放评论。

**Technical Risks**:
- 图库详情页高频访问会增加 D1 写入量；首期数据规模可接受，后续如出现写入瓶颈需引入异步聚合。
- SSR、客户端导航和预取可能导致 PV 重复计数；实现时必须明确只在正式详情 API 成功响应时计数，并避免前端重复请求。
- 首页热门推荐可能形成马太效应；后续需要混入发布时间、人工精选或冷启动内容，避免新图库长期没有曝光。
- 点赞接口若缺少速率限制，可能被脚本刷数据；必须增加用户级和 IP 级限制，并保证唯一约束兜底。
- 后台排序如果使用动态 SQL 拼接，存在注入风险；必须使用枚举映射排序字段。

## 需求确认记录

**已确认**:
- 点赞必须登录。
- 访问量统计口径为图库详情 PV。
- 互动数据需要同时展示在前台和后台。
- 本期首页热门推荐替代现有精选专题，而不是新增独立区块。
- 访问量不排除管理员登录态访问。
- 未登录点击点赞时打开登录引导弹层，不直接跳转登录页。
