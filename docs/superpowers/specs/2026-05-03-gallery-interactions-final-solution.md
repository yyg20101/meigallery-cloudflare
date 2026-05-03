# 图库互动数据最终方案文档

## 1. Executive Summary

**Problem Statement**: 当前前台以内容展示为主，缺少访问量、点赞数和热度排序等互动信号，用户难以判断哪些图库更受欢迎，站长也缺少可直接用于首页推荐和后台运营的数据依据。

**Proposed Solution**: 新增图库级互动数据系统，支持详情页 PV、登录点赞/取消点赞、前台热度展示、后台互动排序，并将首页“精选专题”替换为基于热度公式的“热门推荐”。视觉上采用“珍珠杂志感 + 热榜徽章”的表达，在保持高级写真杂志风格的同时强化热门内容的冲击力。

**Success Criteria**:
- 图库详情页每次成功访问发布状态图库时，`view_count` 增加 1；管理员访问不排除，按 PV 口径同样计数。
- 登录用户可点赞和取消点赞，同一用户对同一图库最多保留 1 条点赞记录；重复操作不会导致 `like_count` 异常增加或小于 0。
- 首页“精选专题”替换为“热门推荐”，默认使用 `score = view_count + like_count * 5` 排序，同分按发布时间倒序。
- 前台图库卡片、详情页、热门推荐卡片和后台图库列表展示访问量与点赞数；后台支持按访问量、点赞数排序。
- `pnpm --filter @meigallery/api test`、`pnpm --filter @meigallery/api exec tsc --noEmit`、`pnpm --filter @meigallery/web exec nuxt build` 必须通过。

## 2. User Experience & Functionality

**User Personas**:
- 访客：通过热度徽章、访问量和点赞数快速判断值得打开的图库。
- 登录用户：用点赞表达偏好，发现已点赞状态，并能随时取消。
- 会员用户：希望首页优先看到站内高热度图库，同时不失去地区和标签浏览路径。
- 管理员/Owner：在后台查看访问量、点赞数，按互动表现排序，辅助内容运营和人工推荐。

**User Stories**:
- As a 访客, I want to see view and like counts so that I can quickly identify popular galleries.
- As a 访客, I want the homepage recommendation area to show hot galleries so that I can start from high-engagement content.
- As a 登录用户, I want to like or unlike a gallery so that I can express preference without comments.
- As a 未登录用户, I want a login prompt when clicking like so that I understand login is required without losing my browsing context.
- As an 管理员, I want to sort galleries by views or likes so that I can identify high-performing content.

**Acceptance Criteria**:
- 首页原“精选专题”标题和逻辑调整为“热门推荐”，展示 3 个按 `hot` 排序返回的图库；不新增额外首页区块，避免首页冗长。
- 热门推荐主卡展示热榜编号、热度值、访问量、点赞数；右侧小卡同样展示访问量和点赞数。
- 图库卡片底部展示访问量与点赞数，移动端不造成横向溢出，375px 宽度下卡片内容不换出容器。
- 图库详情页首屏信息区展示访问量、点赞数和点赞按钮；按钮状态包括未点赞、已点赞、提交中、未登录引导。
- 未登录用户点击点赞时打开登录引导弹层，弹层提供“登录 / 注册”和“稍后再说”，关闭后留在当前详情页。
- 详情页 PV 只在 `GET /api/galleries/:slug` 成功返回发布状态图库时计数；后台预览、草稿、下架、404 和错误响应不计数。
- 管理员访问详情页不排除，照常计入 PV。
- 后台图库列表新增“访问量”“点赞数”列，并提供排序选项：默认创建时间倒序、访问量倒序、点赞数倒序。
- 所有排序参数在服务端使用白名单映射，不允许任意 SQL 字段拼接。
- 互动功能不改变会员权限、媒体授权、R2 私有资源和 Stream 访问控制。

**Non-Goals**:
- 不做评论、弹幕、私信、关注、动态流。
- 不做 UV、IP 地理分析、设备指纹或用户访问轨迹明细。
- 不做收藏夹、公开用户点赞列表或“谁点赞了”。
- 不做 AI 推荐、协同过滤或个性化推荐。
- 不引入非 Cloudflare 基础设施，不改变现有手动会员发放流程。

## 3. AI System Requirements (If Applicable)

**Tool Requirements**: 本需求不包含 AI 功能，不需要 LLM、向量检索、模型推理或 AI 工具调用。

**Evaluation Strategy**: 不适用 AI 输出质量评估。质量验证以 API 单元测试、前端交互验收、响应式检查、后台排序验收、权限回归和构建验证为准。

## 4. Technical Specifications

**Architecture Overview**:
- 数据层：复用 `galleries.view_count`；新增 `galleries.like_count` 和 `gallery_likes` 表。`gallery_likes` 使用 `(gallery_id, user_id)` 唯一索引防止重复点赞。
- API 层：扩展公开图库列表和详情返回互动字段；新增点赞/取消点赞接口；扩展后台图库列表排序。
- 前端层：新增互动展示组件和登录引导弹层；更新首页热门推荐、图库卡片、详情页和后台列表。
- 热度排序：首期在 SQL 中用 `COALESCE(g.view_count, 0) + COALESCE(g.like_count, 0) * 5` 计算，避免新增复杂推荐服务。
- 写入策略：详情页 PV 使用现有 `executionCtx.waitUntil` 异步累加；点赞写入使用 D1 事务语义可接受的顺序操作和唯一约束兜底。

**Integration Points**:
- D1 migration：新增 `0013_gallery_interactions.sql`，包含 `like_count`、`gallery_likes`、相关索引和历史默认值。
- `GET /api/galleries`：返回 `viewCount`、`likeCount`；支持 `sort=hot` 按热度公式排序。
- `GET /api/galleries/:slug`：返回 `viewCount`、`likeCount`、`likedByMe`；成功响应发布图库时累加 PV。
- `POST /api/galleries/:id/like`：要求登录；创建点赞记录并更新计数；返回 `{ likeCount, likedByMe: true }`。
- `DELETE /api/galleries/:id/like`：要求登录；删除当前用户点赞记录并更新计数；返回 `{ likeCount, likedByMe: false }`。
- `GET /api/admin/galleries`：返回 `view_count`、`like_count`；支持 `sort=created_desc | view_desc | like_desc`。
- `packages/web/app/components/HomeFeatured.vue`：继续复用布局，但改名义和展示为热门推荐，不强制新建区块。
- `packages/web/app/components/GalleryCard.vue`：新增底部互动元信息展示。
- `packages/web/app/pages/gallery/[slug].vue`：新增点赞按钮、互动数据和登录引导弹层。
- `packages/web/app/pages/admin/galleries/index.vue`：新增排序选择和互动列。

**Security & Privacy**:
- 点赞接口必须使用服务端 session 中的 `userId`，不接受请求体传入用户 ID。
- 未登录点赞返回 401，前端负责打开登录引导弹层。
- 取消点赞只能作用于当前登录用户自己的记录。
- PV 只保存聚合计数，不保存 IP、User-Agent、设备指纹或访问明细。
- 后台只展示聚合互动数据，不展示点赞用户明细。
- 点赞/取消点赞接口需要速率限制，建议每 IP 每分钟 60 次；唯一约束负责抵御重复点赞造成的数据膨胀。
- 所有新增 API 不返回受保护媒体真实地址，不改变会员 rank 校验。

## 5. Risks & Roadmap

**Phased Rollout**:
- MVP：D1 migration、互动字段、热度排序、登录点赞/取消点赞、前台互动展示、首页热门推荐替代精选专题、后台排序、核心测试。
- v1.1：后台增加热门内容概览卡，支持人工置顶与互动热度混合推荐，补充最近 7 天/30 天趋势。
- v2.0：评估 UV、收藏夹、用户个人点赞列表和更细粒度推荐解释，但评论仍作为独立需求后置。

**Technical Risks**:
- PV 异步计数在极端并发下可能产生写入压力；首期图库规模可接受，后续可评估 Queues 或 Durable Objects 聚合。
- SSR、客户端导航和相关请求可能导致计数比真实阅读次数更高；首期明确采用详情 API PV，不追求 UV 精准性。
- 热门推荐可能产生马太效应，新图库曝光不足；v1.1 需要混入发布时间或人工置顶。
- 点赞计数可能因部分写入失败产生偏差；实现需通过唯一约束和重新统计兜底修正。
- 热榜视觉过强可能破坏“珍珠杂志感”；视觉上使用黑金热榜徽章、细线刻度和暖白底，而不是廉价红榜样式。

## 前端设计方案

**设计方向**: “珍珠杂志感 + 黑金热榜”。整体延续暖白、奶油、珍珠光泽和高级写真杂志排版，在热门推荐和互动按钮上增加更强的榜单编号、热度徽章和微动效。

**视觉原则**:
- 热榜编号使用 `No.01`、`No.02` 形式，搭配黑底金字或半透明玻璃徽章。
- 互动数据用“眼睛/爱心”文本符号或极简线性图标表达，避免低质 emoji 堆叠。
- 点赞按钮使用白底黑字常态、黑底金字已点赞态、细微按压反馈；提交中禁用并显示“处理中”。
- 登录引导弹层采用珍珠白卡片、黑金标题、柔和遮罩，不打断用户对图库封面的视觉焦点。
- 移动端优先保证数据短句不换行溢出，使用 `tabular-nums` 保持计数稳定。

**关键界面变更**:
- 首页：`精选专题` 改为 `热门推荐`，eyebrow 改为 `Hot Ranking`，描述改为“按访问与点赞热度生成的本周人气内容”。
- 图库卡片：标题下方增加 `浏览 1234 · 点赞 56`，移动端使用小号灰金文本。
- 图库详情：标题信息区增加热度条，左侧显示浏览和点赞，右侧显示点赞按钮。
- 后台列表：在标题列后增加访问量/点赞数，排序选择放在状态筛选旁边。

## 任务排期

本方案不绑定固定日期，按可独立验证的任务批次推进，每个批次完成后单独提交。

| 批次 | 目标 | 主要产出 | 验证方式 |
|------|------|----------|----------|
| Task 1 | 数据模型与热度排序 | migration、互动字段、列表/详情返回字段、hot 排序 | API 单元测试 + API 类型检查 |
| Task 2 | 点赞 API | 登录点赞/取消点赞、唯一约束、防重复计数、401 处理 | API 单元测试 + 手动 HTTP 验证 |
| Task 3 | 前台互动组件 | 热度元信息、点赞按钮、登录引导弹层 | Web 构建 + 375/768/1440 响应式检查 |
| Task 4 | 首页热门推荐 | 用 `sort=hot` 替代精选专题数据源和视觉文案 | 首页视觉检查 + API 请求检查 |
| Task 5 | 后台运营数据 | 后台列表互动列、排序选择、API 白名单排序 | 后台页面检查 + API 排序测试 |
| Task 6 | 回归与发布 | 全量验证、D1 migration、Workers 部署、生产冒烟 | CI/本地验证 + 生产 HTTP 200 |

## 实施确认记录

- 点赞必须登录。
- 未登录点击点赞打开登录引导弹层。
- 访问量统计口径为图库详情 PV。
- 管理员访问不排除，照常计入 PV。
- 首页热门推荐替代现有精选专题，不新增独立区块。
- 视觉方向采用更强热榜感，但必须保留当前珍珠杂志感基调。
