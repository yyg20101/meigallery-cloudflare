# 前台整体视觉升级 PRD

## 1. Executive Summary

**Problem Statement**: 当前前台页面虽然已具备基础浏览能力，但整体排版仍偏普通内容列表，缺少围绕女性写真内容的高级视觉叙事，地区和标签入口的信息层级也不够清晰。

**Proposed Solution**: 将前台整体升级为“杂志封面型 + 地区图鉴入口”的视觉系统，以美女写真展示为主线、地区浏览为副主线、标签筛选为辅助线索，并允许后台配置首页关键文案和主推地区。

**Success Criteria**:
- 首页首屏在桌面端和移动端都必须展示一组强封面视觉、主标题、地区入口和至少一个行动入口，首屏不再以普通网格作为唯一主体。
- 首页、发现页、搜索页、图库详情页、用户中心、关于页全部完成统一视觉升级，页面内主要卡片、标题、筛选区、空状态和会员提示均符合“珍珠杂志感”。
- 地区入口在首页首屏下方或首屏内可见，至少展示 4 个地区/城市入口，并支持点击进入对应筛选结果。
- 前台核心页面在 375px、768px、1440px 三档宽度下无横向溢出、底部 Tab 不遮挡核心操作、联系浮层不遮挡主要内容。
- Web 构建命令 `pnpm --filter @meigallery/web exec nuxt build` 必须通过；不引入新的 API 权限绕过或受保护媒体直链暴露。

## 2. User Experience & Functionality

**User Personas**:
- 访客：未登录用户，希望快速感受站点内容质量，并按地区或标签找到感兴趣的公开图库。
- 普通注册用户：已登录但非会员，希望明确理解哪些内容可看、哪些内容需要会员，以及如何联系站长。
- 会员用户：VIP/SVIP 用户，希望更高效浏览精选写真、地区内容和相关推荐。
- Owner/管理员：希望通过后台轻量配置首页主文案、主推地区和展示文案，而不是每次改代码。

**User Stories**:
- As a 访客, I want to enter a visually striking homepage so that I can immediately understand this is a curated portrait gallery rather than a generic image list.
- As a 访客, I want to browse by region so that I can quickly find content from Canada, domestic cities, or other location groups.
- As a 访客, I want tags to remain available but secondary so that I can refine style, identity, scene, and content type without losing visual browsing momentum.
- As a 会员用户, I want gallery detail pages to emphasize cover, region, tags, public images, locked media, and related galleries in a clear rhythm so that I can decide what to continue viewing.
- As an Owner, I want to configure homepage hero copy and promoted regions in the admin settings so that the site can adjust editorial focus without redeployment.

**Acceptance Criteria**:
- 首页首屏采用杂志封面布局：左侧或上方展示标题/说明/行动入口，右侧或下方展示大封面视觉；移动端为单张强封面优先。
- 首页新增地区图鉴区：展示国家/地区组/城市入口；每个入口包含地区名称、简短说明或数量信息，并跳转到发现页筛选结果。
- 首页图库流保留无限加载能力，但视觉从普通列表升级为带标题节奏、精选/最新/地区分区的画报式网格。
- 发现页升级为地区优先筛选：地区类标签拥有更高视觉权重，其他标签类型用于辅助筛选；已选条件清晰可移除。
- 搜索页升级为沉浸式搜索：搜索框、相关标签、当前筛选、排序和空状态统一为珍珠暖白/黑金风格。
- 图库详情页升级为大封面叙事：封面、标题、地区、标签、摘要、公开媒体、锁定媒体、会员 CTA、相关推荐形成清晰层级。
- 用户中心和关于页统一视觉语言：背景、卡片、标题和联系入口与前台整体一致。
- 后台站点设置新增或复用配置项：首页主标题、首页副标题、首页 CTA 文案、主推地区 slugs、首页标签展示数量；未配置时使用安全默认值。
- 所有新增前台文案使用中文，避免露骨、擦边或暗示性表达。

**Non-Goals**:
- 不开放用户上传内容。
- 不接入在线支付。
- 不在本轮接入 Cloudflare Stream 视频完整能力。
- 不新增非 Cloudflare 基础设施。
- 不改动受保护媒体的服务端权限模型。
- 不引入大体积前端动画库；首期动效以 CSS/Tailwind 过渡为主。
- 不重做后台整体框架，仅新增或调整必要的站点设置项。

## 3. AI System Requirements (If Applicable)

**Tool Requirements**: 本需求不包含 AI 功能，不需要 LLM、向量检索、模型推理或 AI 工具调用。

**Evaluation Strategy**: 不适用 AI 输出质量评估。质量评估以 UI 验收、构建验证、响应式检查、权限回归检查为准。

## 4. Technical Specifications

**Architecture Overview**:
- 前端仍使用 `packages/web` Nuxt 3 + Vue 3 + Tailwind CSS v4，部署为 Cloudflare Worker。
- API 仍使用 `packages/api` Hono Worker，站点设置通过现有 `site_settings` 读写链路扩展。
- 首页、发现、搜索、详情、用户中心和关于页共用一套视觉 token、卡片样式、区块标题和标签展示组件。
- 地区入口优先复用现有标签数据，使用 `region`、地区组、城市/国家等已有标签类型映射，不新增独立地区表。

**Integration Points**:
- `GET /api/settings/public`：新增公开首页配置字段，供前台读取默认标题、说明、CTA 和展示数量。
- `GET /api/tags`：继续作为地区和标签入口的数据源，前端按类型提取地区类标签。
- `GET /api/galleries`：继续作为首页、发现页、地区筛选和无限加载的数据源。
- `GET /api/search`：继续作为搜索结果数据源，前端只升级输入、筛选、排序和结果布局。
- 后台设置页：复用现有 Owner 设置写入机制，新增配置项必须加入 admin/public settings 白名单，并写入审计日志。

**Security & Privacy**:
- 受保护图片和视频不得从前端生成真实私有资源地址，仍必须通过服务端校验会员 rank 后发放访问凭证。
- 前台新增地区入口、标签入口和 CTA 不得绕过登录、会员或管理员权限。
- 后台设置修改仍要求 Owner 权限，并写入审计日志。
- 首页配置内容仅允许纯文本和安全 slug 列表，不允许后台注入原始 HTML。
- 所有外链联系方式继续使用 `rel="noopener noreferrer"`，无跳转链接时仅复制联系值。

## 5. Risks & Roadmap

**Phased Rollout**:
- MVP：完成首页杂志首屏、地区图鉴入口、图库卡片/区块统一视觉、后台首页配置项、构建验证和部署。
- v1.1：完成发现页、搜索页、图库详情页的地区优先筛选和画报式布局统一。
- v2.0：完成用户中心、关于页、登录注册页的整体视觉统一，并补充 Histoire 组件预览或视觉验收样例。

**Technical Risks**:
- 首页首屏过度依赖封面图质量，低质量或缺失封面可能破坏视觉效果；需要保留暖白渐变占位和安全默认图形。
- 地区标签命名来自历史迁移数据，可能存在“加拿大”“多伦多”“#多伦多”等不一致值；首期需做前端归类和后台配置兜底。
- 全前台一次性升级范围较大，容易引入样式不一致；实施时应按页面分阶段提交和验证。
- Tailwind 任意值和复杂渐变过多可能增加维护成本；应沉淀为少量 CSS 变量和可复用组件类。
- 移动端固定底部 Tab、联系浮层和详情页 CTA 可能互相遮挡；每个核心页面必须检查安全区和底部留白。

## 设计决策记录

**确认方向**: 采用“A. 杂志封面型”为主，融合“B. 地区图鉴型”的地区入口。

**信息层级**:
- 一级：美女写真封面、精选内容、人物气质和图库标题。
- 二级：国家/地区组/城市入口，用于承接浏览路径。
- 三级：风格、身份、场景、内容类型等标签，用于辅助筛选。

**视觉原则**:
- 保持珍珠暖白、奶油肤色系、黑金强调。
- 使用大图、留白、非对称网格、横向地区卡片提升杂志感。
- 避免低俗化文案，统一使用“写真、精选、地区、风格、会员权益、联系站长”等表达。

**实施边界**:
- 允许新增后台配置项和轻量 API 白名单扩展。
- 不重构认证、会员、媒体授权、导入和部署架构。
- 不引入新基础设施，不依赖 Cloudflare Pages。
