# MeiGallery 功能整体完善 PRD

### 1. Executive Summary

**Problem Statement**: MeiGallery 已完成上线基础能力，但首页转化链路、可信案例展示、轻量导入、广告归因、后台效率和 dev 验收流程仍分散在多个单项需求中，缺少一个统一的下一阶段范围基准。当前如果继续零散开发，容易出现模块优先级不清、验收口径不一致、生产与 dev 环境混用、广告数据和导入数据不可追踪等问题。

**Proposed Solution**: 建立“功能整体完善”阶段性 PRD，把首页改造、真实案例、Telegram `file_id` 异步导入、Facebook Pixel、后台管理效率和上线质量门槛纳入统一 roadmap。每个模块继续沿用独立技术方案和实施计划，但必须受本 PRD 的优先级、验收指标、合规边界和环境隔离规则约束。

**Success Criteria**:

- 下一阶段所有新功能必须先部署到 Workers dev 子域验收，dev 页面和 API 响应 100% 带测试环境标识或 `noindex` 防护，不得误绑定生产域名。
- 首页到关键转化路径的点击深度不超过 2 次，关键路径包括真实案例详情、规则说明、联系站长、标签筛选结果页。
- Telegram 导入完成后，单个图库从 Bot 提交到草稿创建完成 P95 <= 3 分钟，单个真实案例 P95 <= 2 分钟，50 条连续导入请求接收成功率 >= 99%。
- Facebook Pixel MVP 上线后，生产公开页面 `PageView` 不重复触发，`ViewContent`、`Search`、`Lead`、`CompleteRegistration`、`login_completed` 事件可在 Meta Events Manager 5 分钟内看到测试事件。
- API 单元测试、API 类型检查和 Web 构建必须在每个阶段提交前通过；受保护媒体、后台修改、导入 token 和审计日志相关路径必须有测试或手动验收记录。

### 2. User Experience & Functionality

**User Personas**:

- 访客用户：希望快速理解站点内容质量、规则边界和可浏览入口，在手机端也能清楚进入图库、真实案例和标签筛选。
- 潜在会员用户：希望通过真实案例、规则说明和联系入口判断站点可信度，并低摩擦联系站长。
- 会员用户：希望登录后稳定访问自己会员等级允许的内容，并清楚知道受保护内容的解锁条件。
- 管理员/Admin：希望用更少手工步骤创建草稿、审核媒体、维护真实案例、处理失败导入和管理用户会员。
- 站长/Owner：希望统一掌控下一阶段开发优先级、广告归因、导入凭证、系统设置、审计记录和生产上线节奏。
- Bot 开发者：希望通过轻量 JSON API 提交 Telegram `file_id`，避免在 Bot 侧下载图片或处理 multipart 文件上传。
- 广告投放人员：希望 Meta Ads 能看到关键转化事件，用于评估广告带来的访问、搜索、注册和咨询。

**User Stories**:

- As a 访客用户, I want 首页直接展示真实案例、标签导航、规则入口和联系入口 so that 我能在 2 次点击内判断站点是否可信并进入目标内容。
- As a 潜在会员用户, I want 查看公开真实案例列表和详情 so that 我能了解站点服务反馈和内容质量。
- As a 会员用户, I want 受保护媒体始终通过服务端校验 so that 我的会员权益不会被前端绕过或错误泄露。
- As an Admin, I want Telegram 消息可以异步导入为草稿 so that 我能把时间集中在授权、脱敏、标签和发布审核上。
- As an Owner, I want 管理 Import Token、Pixel 设置、规则内容和真实案例 so that 运营配置无需每次重新部署代码。
- As a Bot 开发者, I want duplicate 和 retry 语义明确 so that Bot 可以安全重试而不创建重复图库或真实案例。
- As an 广告投放人员, I want 关键公开页面和转化动作触发 Pixel 事件 so that 我能判断广告预算是否带来有效咨询和注册。
- As a 开发/测试人员, I want 所有未验收功能先在 dev Worker 上测试 so that 生产域名不会暴露半成品功能。

**Acceptance Criteria**:

- 首页必须保留已确认的“珍珠杂志感 + 黑金点缀”方向，不新增低俗、露骨、夸大或虚假承诺文案。
- 首页必须展示明确标签导航，城市/地区入口优先，风格/身份/场景作为辅助筛选；从首页进入任一重点标签筛选结果页的点击次数不超过 2 次。
- 首页真实案例区必须读取真实后台数据；无数据时显示整理中空状态，不允许使用假评价、假用户、外部未授权图片或样板案例伪装成真实反馈。
- 真实案例公开列表页和详情页必须公开访问；详情只展示已发布案例，草稿、未发布或不存在 slug 必须返回 404 与用户可理解文案。
- 真实案例发布前必须保持 2-9 张已授权、已脱敏图片；图片不得包含可识别个人隐私、联系方式、付款凭证或未授权聊天内容。
- 规则入口和联系站长入口必须在移动端可点击目标不小于 44px，且不得遮挡登录、注册、图片查看器关闭、会员解锁等关键操作。
- Telegram 导入 API 必须支持 `type=gallery` 和 `type=testimonial_case`，只接受 `application/json`，认证使用 `Authorization: Bearer <import_token>`。
- Import Token 必须只保存 SHA-256 hash，后台创建时明文 token 只显示一次；后台列表、导入记录、审计日志和 worker logs 不得输出明文 token。
- Telegram Bot Token 必须通过 Worker secret 或 Cloudflare Secrets Store 管理，不得保存到 D1、R2、站点设置、前端配置、API 响应或审计日志。
- Telegram 导入必须先创建外部导入记录并返回 `pending_media_fetch`；异步处理状态必须能进入 `fetching_media`、`draft_created` 或 `failed`。
- Telegram 导入内容必须 100% 创建为 `draft`，不得允许 Bot 请求直接发布图库或真实案例。
- duplicate 响应必须返回原 `importId`，不得创建新的目标草稿；Bot 可继续用原 `importId` 查询状态。
- `failed` 必须表示没有可用目标草稿：`targetId=null`，不得残留目标草稿、目标媒体记录或可访问 R2 对象。
- retry 只允许同一 Import Token 重试 `failed` 导入；非 `failed` 状态必须返回 `409 IMPORT_RETRY_NOT_ALLOWED`，清理未完成必须返回 `409 IMPORT_RETRY_CLEANUP_REQUIRED`。
- Facebook Pixel 仅在生产公开页面且后台配置启用时加载；`/admin/**` 不得触发任何 Pixel 事件。
- Pixel ID 为空或开关关闭时，前端不得加载 `fbevents.js`，不得向 Meta 发送请求。
- Pixel 事件不得包含邮箱、昵称、联系方式值、会员备注、session token、Cookie、R2 key、Stream token、受保护媒体 URL 或 Telegram 下载 URL。
- 联系站长入口首次展开或点击联系方式时必须触发 `Lead`，但事件属性只能包含 `location`、`method_type` 等非敏感字段。
- 注册成功触发 `CompleteRegistration`，登录成功触发 `login_completed`，搜索行为触发 `Search`，图库详情成功加载触发 `ViewContent`。
- 后台真实案例、Import Token、外部导入记录、Pixel 设置、规则设置等修改操作必须写入审计日志。
- 所有后台路由必须要求管理员或 Owner 角色；Owner 专属设置不得开放给普通 Admin。
- 所有 dev 验收必须使用 dev Worker 名称和 workers.dev 子域，保留 `workers_dev = true` 和 `routes = []`，不得继承生产 custom domain。
- 生产上线只能通过本地 Wrangler 手动部署或明确批准的流程，不依赖 GitHub Actions 自动部署。
- 每个实施阶段完成后必须运行 API 类型检查和 Web 构建；涉及 API 行为的阶段必须补充 Vitest 测试或 curl 验收记录。

**Non-Goals**:

- 本阶段不接入在线支付、订阅计费、自动续费或第三方支付网关。
- 本阶段不开放普通用户上传、投稿、评论、评分、私信、关注或动态流。
- 本阶段不实现官方 Telegram Bot，只接收外部 Bot 或 Ops Hub 提交的结构化 JSON。
- 本阶段不把 multipart 上传作为 Telegram 导入主路径。
- 本阶段不接入 Meta Conversions API、Meta Marketing API 或广告账户管理。
- 本阶段不新增 Cookie 同意弹窗、CMP 平台或地区化隐私策略，但必须记录隐私合规风险和扩展点。
- 本阶段不做 AI 自动解析 caption、AI 自动发布、AI 自动下架或未经人工审核的内容决策。
- 本阶段不处理 Cloudflare Stream 视频入库；Telegram 视频文件引用首期拒绝或标记为不支持。
- 本阶段不引入非 Cloudflare 基础设施，除非未来单独 PRD 明确批准。

### 3. AI System Requirements (If Applicable)

**Tool Requirements**: MVP 不包含 AI 功能，不需要模型推理、向量数据库或 AI 服务 API。后续如果引入 AI 标签建议、caption 解析、内容风险辅助检查或自动摘要，必须使用独立 PRD 定义输入范围、人工复核流程、误报处理、评估数据集和权限边界。

**Evaluation Strategy**: MVP 的质量评估以产品指标、接口测试、构建验证、Meta 事件验证、导入状态机验证和人工审核流程为准。未来 AI 能力的最低评估门槛为：标签建议 Precision@10 >= 85%，内容风险辅助检查必须 100% 由管理员复核，AI 输出不得自动发布或自动下架内容。

### 4. Technical Specifications

**Architecture Overview**:

```text
访客 / 会员 / 广告流量
  -> Nuxt Web Worker
  -> 首页、发现页、图库详情、真实案例、规则页、登录注册
  -> 公开 API 获取图库、标签、真实案例、站点设置
  -> Pixel 客户端事件只在公开页面触发

管理员 / Owner
  -> Nuxt Admin SPA
  -> Hono API Worker 后台路由
  -> 管理图库、真实案例、规则、Pixel 设置、Import Token、外部导入记录、会员和审计日志

Telegram Bot / Ops Hub
  -> POST /api/imports/telegram-file-id
  -> API 校验 Import Token、sourceBotKey、权限和 payload
  -> D1 写 external import record
  -> Queue 或 waitUntil 异步拉取 Telegram 文件
  -> R2 保存图片
  -> D1 创建图库或真实案例草稿
```

**Integration Points**:

- Web Worker：`packages/web`，Nuxt 4/Vue 3/Tailwind CSS v4，承载公开页面和后台 SPA。
- API Worker：`packages/api`，Hono，承载公开 API、后台 API、导入 API、媒体代理和权限校验。
- D1：存储用户、会员、图库、标签、媒体、真实案例、站点设置、Import Token hash、外部导入记录、审计日志。
- R2：存储图库原图、真实案例图片、导入包和导入错误报告；私有对象不得直接暴露给前端。
- Cloudflare Stream：保留视频访问目标，但本阶段不新增 Telegram 视频入库。
- Cloudflare Turnstile：继续保护登录、注册和后台敏感表单。
- Cloudflare Workers dev 子域：承载 dev API 和 dev Web 验收，必须 `noindex`，不得出现在生产导航或 sitemap。
- `GET /api/settings/public`：公开站点设置、规则入口和 Pixel 公共配置。
- `PATCH /api/admin/settings`：Owner 修改站点设置、规则内容、Pixel 配置并写审计日志。
- `GET /api/testimonial-cases`、`GET /api/testimonial-cases/:slug`、`GET /api/testimonial-cases/images/:imageId`：公开真实案例和图片代理。
- `/api/admin/testimonial-cases/**`：后台真实案例创建、编辑、图片上传、排序、删除和发布校验。
- `POST /api/imports/telegram-file-id`、`GET /api/imports/:importId`、`POST /api/imports/:importId/retry`：Bot 导入 API。
- `/api/admin/import-api-tokens/**`：Owner 管理 Import Token。
- `/api/admin/external-import-records/**`：Admin/Owner 查看导入记录、失败原因和目标资源链接。
- Meta Pixel：前端客户端加载 `fbevents.js`，由统一 tracking composable 或 plugin 发送公开事件。

**Security & Privacy**:

- 受保护媒体绝不信任前端检查，必须由服务端按会员 rank 和有效期验证后发放短期访问凭证或代理响应。
- 会员等级比较必须使用数字 `rank`，不得在业务逻辑硬编码 free/vip/svip 名称判断权限。
- 后台路由必须要求已认证管理员角色；Owner 专属配置必须额外校验 `owner`。
- 后台修改操作必须写入 `admin_audit_logs`，包括真实案例、会员、站点设置、Import Token 和导入重试。
- Import Token 明文只显示一次，数据库只保存 hash；泄露后必须支持禁用和重新创建。
- Telegram Bot Token 不得进入 D1、R2、前端运行时配置、日志、API 响应或审计日志。
- Pixel 事件只采集公开页面上下文和非敏感行为，不采集 PII、不采集受保护资源地址、不采集后台行为。
- 真实案例必须经过授权和脱敏；不得公开个人隐私、联系方式、付款凭证、账号 ID 或未授权聊天内容。
- dev 环境如读取正式 D1/R2，必须保留权限校验、审计日志、测试环境标识和 noindex 防护。
- 生产部署前必须确认 wrangler dev env 不继承生产 routes，避免 dev Worker 误绑定 `616618.xyz` 或 `api.616618.xyz`。

### 5. Risks & Roadmap

**Phased Rollout**:

- MVP：完成阶段性总 PRD；保留已完成首页真实案例和规则入口能力；继续实现 Telegram 导入 API 的 payload 校验、Telegram fetcher、导入状态机、Bot 路由、后台 Import Token 和导入记录；补齐 Facebook Pixel 前端事件；所有功能先部署 dev 验收。
- v1.1：增加后台导入记录筛选和失败诊断体验；增加真实案例曝光/点击统计；增加 Pixel 调试状态面板；补充导入失败清理工具；完善 dev smoke test 清单。
- v2.0：评估接入 Cloudflare Queues 生产化高频导入、Meta Conversions API、Cloudflare Stream 视频入库、AI 标签建议和内容风险辅助检查。

**Technical Risks**:

- Telegram `file_id` 依赖 Bot 上下文，`sourceBotKey` 与 Bot Token 配错会导致拉取失败；必须让失败状态可查询、可重试、可审计。
- `waitUntil()` 可靠性弱于 Cloudflare Queues，高频导入或长耗时下载可能丢任务；实现必须保持处理函数独立，便于切换 Queue。
- D1/R2 部分成功可能产生脏数据；失败清理必须优先保证没有可用目标草稿和可访问 R2 对象残留。
- Pixel 前端归因受广告拦截器、浏览器隐私策略和 iOS 限制影响，数据不能等同于真实全量转化；后续可能需要 CAPI 补强。
- dev Worker 如果继承生产 routes，会误影响生产域名；部署前必须检查 `workers_dev` 和 `routes`。
- 真实案例如果缺少授权和脱敏，会带来隐私、版权和信任风险；后台流程必须持续提示并保留审计记录。
- 首页转化入口过多可能造成视觉噪音；实现时必须控制动效、入口密度和移动端遮挡。
- 后台能力扩展会增加权限和审计复杂度；所有 Owner/Admin 边界必须在 API 层测试，而不是只靠前端隐藏入口。
