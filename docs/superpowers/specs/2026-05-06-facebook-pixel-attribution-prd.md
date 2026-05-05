# Facebook 像素广告归因 PRD

### 1. Executive Summary

**Problem Statement**: 站点后续需要投放 Facebook/Instagram 广告，但当前缺少 Meta Pixel 事件采集，无法在 Meta Ads Manager 中评估广告带来的图库浏览、搜索意图、注册登录和联系站长转化。

**Proposed Solution**: 首期仅补充需求文档，后续实现时通过前端 Meta Pixel 接入基础广告归因事件，并以站点设置开关控制 Pixel ID、启用状态和环境隔离。MVP 不接 Conversions API，不新增 Cookie 同意弹窗，但必须避免采集 PII，并保留后续隐私同意和服务端事件上报扩展空间。

**Success Criteria**:

- 生产启用 Pixel 后，Meta Pixel Helper 在首页、发现页、图库详情页、搜索页和注册页均能检测到且仅检测到 1 次有效 `PageView`，不得重复触发。
- 首期至少覆盖 5 类事件：`PageView`、`ViewContent`、`Search`、`Lead`、`CompleteRegistration`，并为登录补充自定义事件 `login_completed`。
- 联系站长入口点击或展开后，Meta Events Manager 在 5 分钟内可看到 `Lead` 测试事件，事件不包含邮箱、昵称、联系方式值、会员备注等 PII。
- Pixel ID 为空或 Pixel 开关关闭时，生产和 dev 均不得加载 `fbevents.js`，不得向 Meta 发送请求。
- dev 环境默认不向正式 Pixel 上报事件；如需测试，必须通过独立测试 Pixel ID 或显式调试配置启用。

### 2. User Experience & Functionality

**User Personas**:

- 站长/Owner：希望知道 Facebook 广告是否带来真实访问、注册和咨询，辅助广告预算决策。
- 广告投放人员：需要在 Meta Ads Manager 中看到标准转化事件，并用事件数据优化广告组和素材。
- 访客用户：正常浏览站点，不应因为 Pixel 接入看到额外弹窗、卡顿或隐私泄露。
- 开发/测试人员：需要在 dev 子域验证事件触发，不影响生产 Pixel 数据质量。

**User Stories**:

- As a 站长, I want to configure Meta Pixel ID from admin settings so that I can enable or disable ad attribution without redeploying code.
- As an 广告投放人员, I want key user actions to map to Meta standard events so that Meta Ads can optimize for real conversion signals.
- As a 访客用户, I want the site to remain visually unchanged so that tracking does not interrupt browsing or contact flows.
- As a 开发/测试人员, I want dev tracking separated from production Pixel so that testing does not pollute ad attribution data.

**Acceptance Criteria**:

- 后台站点设置必须支持配置 `facebook_pixel_enabled`、`facebook_pixel_id`、`facebook_pixel_debug_enabled`，仅 Owner 可修改，修改后写入审计日志。
- 前台只在 `facebook_pixel_enabled=true` 且 `facebook_pixel_id` 非空时加载 Pixel；Pixel ID 必须按公开配置处理，不作为 Worker secret 存储。
- Nuxt 首屏加载时触发 1 次 `PageView`；客户端路由切换时每次页面路径变化触发 1 次新的 `PageView`，同一路由重复渲染不得重复触发。
- 图库详情页成功加载发布状态图库时触发 `ViewContent`，事件属性只允许包含 `content_type='gallery'`、`content_ids=[galleryId]`、`content_name`、`required_rank`、`tags` 的非敏感摘要。
- 搜索页执行搜索时触发 `Search`，事件属性包含 `search_string` 和 `result_count`；不得记录邮箱、联系方式、密码、会话 token 或完整 Cookie。
- 标签导航、发现页筛选和首页标签点击可触发自定义事件 `filter_selected`，事件属性包含 `tag_slug`、`tag_type` 和 `location`。
- 联系站长入口首次展开或点击具体联系方式时触发 `Lead`，事件属性包含 `location`、`method_type`，不得包含具体联系值、二维码 URL 或用户身份信息。
- 注册成功后触发 `CompleteRegistration`，事件属性包含 `method='email'`；登录成功后触发自定义事件 `login_completed`，事件属性包含 `method='email'`。
- 未登录浏览、会员到期、受保护媒体解锁失败等状态不得向 Meta 发送用户邮箱、会员备注或权限明细。
- `/admin/**` 后台路由不得触发 Facebook Pixel 事件，避免管理员操作污染广告数据。
- dev 子域默认不加载生产 Pixel；如启用调试 Pixel，页面必须保留 `DEV 测试环境` 标识。
- 首期不弹出 Cookie 同意窗口，但 PRD 和后续技术方案必须标注隐私合规风险，并预留 Consent Mode 或手动同意开关接入点。

**Non-Goals**:

- 本轮不实现 Meta Conversions API 服务端事件上报。
- 本轮不直接对接 Meta Marketing API、广告账户、广告组、素材或报表。
- 本轮不实现 Cookie 同意弹窗、CMP 平台或地区化隐私策略。
- 本轮不做用户级归因、跨设备身份合并、会员 LTV 回传或高级匹配。
- 本轮不追踪受保护媒体真实 URL、R2 key、Stream token 或任何私有资源地址。

### 3. AI System Requirements (If Applicable)

**Tool Requirements**: 不适用。本需求不包含 AI 功能，不需要模型推理、向量检索或 AI 工具调用。后续实现可使用 `analytics-tracking` 和 `meta-ads` 技能辅助埋点命名、Meta 标准事件映射和验证清单。

**Evaluation Strategy**: 不适用 AI 输出质量评估。质量验证以 Meta Pixel Helper、Meta Events Manager 测试事件、浏览器 Network 请求、Nuxt 构建和隐私字段审查为准。

### 4. Technical Specifications

**Architecture Overview**:

- 配置层：Owner 在后台站点设置中配置 `facebook_pixel_enabled`、`facebook_pixel_id` 和调试开关，公开配置通过 `/api/settings/public` 下发给前台。
- 前端层：Nuxt composable 或 plugin 在客户端初始化 `fbq`，负责加载 `https://connect.facebook.net/en_US/fbevents.js`、发送 `PageView` 和业务事件。
- 路由层：监听 Nuxt 路由变化，在非后台页面发送 `PageView`，并对相同路径去重。
- 业务层：图库详情、搜索、标签点击、联系站长、注册成功和登录成功在对应交互处调用统一 tracking 方法。
- 环境层：生产域可启用正式 Pixel；Workers dev 子域默认禁用或使用单独测试 Pixel，避免污染广告数据。

**Integration Points**:

- `site_settings`：新增 `facebook_pixel_enabled`、`facebook_pixel_id`、`facebook_pixel_debug_enabled`。
- `GET /api/settings/public`：返回 Pixel 公开配置，Pixel ID 为空时前端不加载脚本。
- `PATCH /api/admin/settings`：Owner 更新 Pixel 配置，并写入 `admin_audit_logs`。
- `packages/web/app/plugins/` 或 `packages/web/app/composables/`：新增 Facebook Pixel 初始化和事件发送逻辑。
- `packages/web/app/pages/gallery/[slug].vue`：图库详情成功加载后发送 `ViewContent`。
- `packages/web/app/pages/search.vue`：搜索提交或搜索结果更新后发送 `Search`。
- `packages/web/app/components/ContactPanel.vue`：联系站长展开或点击联系方式时发送 `Lead`。
- `packages/web/app/pages/register.vue`：注册成功后发送 `CompleteRegistration`。
- `packages/web/app/pages/login.vue`：登录成功后发送 `login_completed` 自定义事件。
- `packages/web/app/layouts/default.vue` 或全局路由监听：公开页面路由切换发送 `PageView`，排除 `/admin/**`。

**Security & Privacy**:

- 不向 Meta 发送邮箱、昵称、联系方式值、会员备注、IP 自定义字段、Cookie、session token、R2 key、Stream token 或受保护媒体 URL。
- `content_name`、`search_string`、`tag_slug` 等字段需视为公开页面上下文，不得包含用户输入中的联系方式或敏感内容。
- Pixel 只在客户端加载；Pixel ID 是公开标识，不作为 secret；后续 Conversions API token 必须作为 API Worker secret 管理。
- 由于首期暂不做同意弹窗，需在技术方案中标注隐私合规风险；如后续面向 EU/UK/CA 等地区推广，必须接入同意管理后再默认加载 Pixel。
- 后台路由和管理员操作不触发 Pixel，避免把运营行为计入广告学习。
- dev 环境默认禁用正式 Pixel，所有测试事件应使用 Meta Events Manager Test Events 或独立测试 Pixel。

### 5. Risks & Roadmap

**Phased Rollout**:

- MVP：完成 PRD、技术方案和实施计划；实现前端 Pixel 配置开关、`PageView`、`ViewContent`、`Search`、`Lead`、`CompleteRegistration`、`login_completed`；用 Meta Pixel Helper 和 Events Manager 验证。
- v1.1：增加事件去重、事件节流、测试 Pixel 配置、后台 Pixel 状态提示和基础埋点调试面板。
- v2.0：评估接入 Meta Conversions API，通过 API Worker 服务端上报 `Lead`、`CompleteRegistration` 等关键事件，并使用 `event_id` 做浏览器端和服务端去重。

**Technical Risks**:

- 广告拦截器、浏览器隐私策略和 iOS 限制会降低前端 Pixel 归因完整性；后续可能需要 Conversions API 补强。
- SPA 路由切换容易导致 `PageView` 重复或漏报，必须做路径去重和后台路由排除。
- 搜索词和联系入口事件存在 PII 风险，实现时必须过滤联系方式、邮箱、手机号和 token 类字段。
- dev 测试如果误用生产 Pixel，会污染广告学习和转化数据，必须默认禁用或显式使用测试 Pixel。
- 首期不做 Cookie 同意弹窗，若未来面向强隐私合规地区投放广告，需要补充 Consent Mode 或同意管理方案。
