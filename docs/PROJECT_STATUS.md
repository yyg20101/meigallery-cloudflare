# 项目状态

更新时间：2026-08-02。

本文件只记录当前状态。历史变更以 Git、PR、tag 和 `docs/releases/` 为准。

## 技术栈

- pnpm monorepo。
- Web：Nuxt 4、Tailwind CSS v4、Nuxt UI v4，部署为 Cloudflare Worker。
- API：Hono，部署为独立 Cloudflare Worker。
- 数据与运行资源：Cloudflare D1、R2、Queues、Turnstile。
- 不使用 Cloudflare Pages。

## 已有能力

- 公开图库、标签、搜索、案例、首页广告和联系方式。
- 注册、登录、邮箱验证、用户中心、会员状态和后台手动会员管理。
- 图库、媒体、标签、用户、会员、设置、联系方式、广告、案例、导入任务和审计后台。
- Telegram 只提供外部导入 API，不内置 Bot。
- 一方数据分析、来源、邀请码、有效联系、转化趋势和后台看板。
- SEO 设置、sitemap、robots、结构化数据和 production 校验。

## 独立 App 产品设计

- 已在同级独立仓库 `meigallery-client` 创建 KMP + Compose Multiplatform 最小技术脚手架；客户端与本仓库继续通过版本化契约协作，不放入当前 pnpm monorepo。
- 客户端当前锁定 Kotlin 2.4.10、Compose Multiplatform 1.11.1、AGP 9.0.1、Gradle 9.6.1、JDK 21，Android `minSdk = 26`、`compileSdk/targetSdk = 36`。
- 四个共享模块的 Android Host Test、Android Debug APK 和 iOS Simulator Kotlin/Native 编译均已通过；iOS Framework 链接因本机未安装完整 Xcode/iOS SDK 暂未完成。
- 已进入 M0 首条业务纵向切片：`contracts/app-api-v2.openapi.yaml` 局部冻结 bootstrap、发现 feed、地区目录和公开人物基础详情四个只读路径；完整 App 契约仍处于逐域冻结中。
- 已新增 `0067_app_public_profile_projection.sql` 空读投影和 App API v2 查询实现，强制 `verified + published + authorization active/unexpired + visible + source gallery published`；migration 不含 seed、回填或 legacy 自动映射，尚未执行生产 migration 或部署生产路由。
- KMP 客户端 M0 公共发现纵向切片已完成：capability、地区目录、推荐/热门/最新、地区筛选、游标分页、公开人物卡和基础详情均已接通；点击卡片会按稳定公开 ID 重新请求详情并复核最新公开资格，不直接信任列表快照。Android 模拟器已回归筛选、排序、详情错误/重试/成功和长列表，未发现崩溃、文字溢出或底部导航遮挡。登录、正式应用 ID、管理员投影写流程、互动、会员、消息、钱包和媒体访问继续受各自门禁约束。
- 已完成 M1 人物供给最小开发闭环：`0068_app_person_supply_workflow.sql` 创建空的 Person、资料、用途授权、认证和发布复核权威表；内容版本与并发锁版本分离，审批绑定具体内容版本，发布动作单向生成公开投影，暂停或撤销会立即使投影不可见。
- Nuxt 后台已新增 `/admin/app/persons` 人物供给队列、新建候选页和单人物工作台，覆盖草稿编辑、用途授权登记/撤销、认证提交/四项复核/撤销、发布提交/通过/退回/暂停、双轴版本提示、全门禁说明和审批历史；页面使用可换行操作区、最小宽度约束与表格横向容器避免窄屏按钮和文字越界。
- M1 D1 定向测试已覆盖未认证不公开、完整审批后公开、线上/草稿隔离、暂停立即下线、过期授权、并发冲突和审计完整性；0001–0068 已在全新临时本地 D1 连续升级通过。当前仍未执行 production migration、未导入真实人物或证据，也未把未关闭的认证声明、证据保留期和人员分离规则固化为生产政策。
- 已完成移动端 49 页和管理后台 43 页的页面级产品设计。
- Figma 最终文件已完成移动端 49 页/186 状态、管理后台 43 页/163 状态，共 92 个 Page ID/349 个状态；`30｜Prototype Flows` 覆盖 92 个流程预览。
- Figma 页面内与流程动作合计 2,284 个，缺失目标为 0；移动端关键点击热区不足为 0；正式页未绑定文字样式、原始填充/描边、缺失字体和文字溢出均为 0。
- Figma 最终版本 ID 为 `2381987656588552168`；`40｜Delivery Index` 与 `50｜QA & Handoff` 已完成，最终事实源为 `docs/app/figma-final-delivery-state.json`。
- 已按客户确认的原始暖粉视觉方向完成同视口对照，并修正文字排版、Icon 对齐、后台头部按钮重叠、会员选中卡对比度、运营总览 KPI 与表格溢出。
- 客户文档继续保留 92 张默认状态、54 张 P0 关键状态和通知/金币 23 张逐状态导出图，共 169 个 Page ID/状态/图片确定性映射；Figma 的 349 个状态是像素级视觉与交互权威来源。
- 已同步 `docs/app/MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md`，作为研发、测试与验收的 App 1.0 唯一开发需求基线；文档覆盖当前范围、未来兼容方向、非功能要求、技术基线、92 页逐页规格、349 个 Figma 状态、169 个客户文档图片映射、需求追踪、DoR 与 DoD。
- 已生成 `docs/app/APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md`，逐页覆盖角色、前置、入口、结构、交互、业务规则、数据权限、状态和验收。
- 客户产品需求确认书和逐页交互设计确认册已按 Figma 最终口径重新生成；每个 Page ID 的功能说明、需求追踪和原型图保持同页映射。产品需求确认书内嵌 199 张图，逐页交互设计确认册内嵌 169 张图。
- 已新增需求冻结准备清单与 15 页客户短版确认单，集中列出 8 项客户决策和 7 组专业门禁，并明确“功能交互冻结”与“像素级视觉冻结”必须分别记录；整体仍是冻结准备中，当前仅授权不依赖未决参数的 M0 公共发现开发验证，不等于授权生产发布。
- Figma Phase 0 审计、Phase 1 Design System、Phase 2 文件结构、最终页面/流程/QA 的完成记录分别见 `FIGMA_FINAL_DELIVERY_AUDIT_AND_PLAN.md`、`FIGMA_DESIGN_SYSTEM_PHASE1.md` 和 `FIGMA_FILE_STRUCTURE_PHASE2.md`。
- 最终 MD、两份完整客户 DOCX 与冻结确认资料已通过 92 个 Page ID、349 个 Figma 最终状态、2,284 个有效交互动作、169 个客户文档原型映射、41 个 App 1.0 产品需求编号、92 个逐页追踪键和冻结基线 SHA-256 的一致性校验。
- 三份客户 DOCX 已通过压缩包完整性、图片替代文本、表格表头、无障碍审计和中文字体环境下的全页渲染目检；LibreOffice 基准渲染分别为 197 页、165 页和 15 页，未发现异常空白页、图片缺失、内容错位、溢出或裁切。
- 逐页原型清单、SHA-256、15 组功能联系表和设计 QA 证据位于 `docs/app/assets/page-prototypes/` 与 `docs/app/interactive-prototype/design-qa.md`。
- 详细实施规格见 `docs/superpowers/specs/2026-07-28-app-detailed-prd-prototype-docx-design.md`。

## 通用广告归因

- 唯一业务事实：`Contact`、`CompleteRegistration`。
- 唯一事实表：`attribution_conversion_facts`。
- 一条事实最多属于 Meta、TikTok、Google 中的一个 provider。
- `fbclid`、`ttclid`、Google click ID 或后台受管投放链接决定唯一平台；普通 UTM 不决定平台。
- 没有新来源时继承 30 天内最近一次有效广告来源；自然流量没有历史来源时不加载 Pixel。
- 跨平台信号冲突或来源不可信时只记录站内事实，不向任何广告平台发送。
- Browser 与 Server 共用 external event ID，支持同平台去重。
- SSR 在页面可交互前通过一次来源解析响应初始化当前来源 Pixel；Contact 外链在原生导航前只进入一次 Browser 队列，API 使用 `keepalive` 保存同一编号的事实与 Server 投递；不存在独立联系 Beacon、响应后补发或第二条事实链路。
- Meta、TikTok、Google 使用独立凭证、目标映射、Queue 和 DLQ。
- 平台凭证由 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 加密，管理端不回显明文。
- Test Event Code 只用于单次同步连接测试，不持久化，也不进入正式事件。
- 平台连接只保留连接、Browser、Server 三个开关，不存在 rollout、验证 Workflow 或发布门禁。
- 后台分析、Session 明细和 CSV 中的有效联系与注册只读取 `attribution_conversion_facts`；有效联系使用 `contact_conversion` 只读投影，点击表只表示非转化行为点击。
- `0065_analytics_conversion_truth.sql` 清除历史重复转化计数并补齐事实时间索引；`0066_contact_fact_analytics_cleanup.sql` 删除旧 Contact 行为副本、旧派生聚合并建立防回写约束。两者均不修改现有 Pixel、Token、Delivery 或平台回执。
- `0066` 及对应运行时收口已在 `dev` 通过定向测试、类型检查和全新 D1 升级验证，并于 2026-07-29 通过 PR #97 合入 `main`、发布为 `v0.5.7`（production commit `f34f2b94c5464ca17d22ed22c1e8671ea30ef664`）。生产 D1 migration、API/Web smoke、旧 Contact 副本归零及唯一转化事实核验均已通过。

## 归因瘦身

当前归因运行时已收口到 `packages/api`：

- 删除独立 Attribution Worker。
- 删除 owner、epoch、cutover、bridge、shadow 和代理 API。
- 删除独立业务 Outbox 和验证工作流。
- 删除按比例 rollout。
- 删除 Git commit 与归因运行时绑定。
- 删除后台 verification/revision/rollout 交互。
- 删除地区判断、营销授权页、Banner、Consent Cookie、授权 API 和地区策略表。
- 删除前端 `adAttributionState` 放行字段；服务端优先信任加密来源上下文，Cookie 偶发缺失时只允许同一来源路由器根据当前官方 click ID 或 active 受管广告链接恢复平台，始终拒绝客户端直接声明 provider。
- 用户注册运行时已停止读写废弃的 `conversion_external_id`；生产运行时独立发布并通过 smoke 后，再以单独 contract migration 删除旧列与索引，避免把停写和删列混入同一发布。
- 浏览器由单一 adapter registry 保证同一时刻只激活一个平台；平台变化或变为空时整页刷新。
- 连接读取改为 connection、bindings、credential 三张表直接查询。
- 连接内部 Outbox 作用域创建后保持稳定，保存配置不会使排队事件失效。
- `0060_attribution_control_plane_cleanup.sql` 清理 production 中旧控制面表和写入冻结 trigger，同时保留事实、投递、加密 Outbox、回执、故障和质量数据。
- `0061_attribution_source_router_cleanup.sql` 物理删除 consent、region、rollout、mode、revision 和冗余 provider 字段，并原值保留现有连接、最新加密凭证、事实、投递与 Outbox。
- `0062_attribution_runtime_garbage_cleanup.sql` 删除旧连接配置产生的质量快照和无读取方的 usage 表，不触碰业务事实或有效平台配置。
- `0063_attribution_tracking_source_contract.sql` 物理删除推广来源的旧 `link_proof` 列，逐字段保留全部来源及其状态、UTM、平台绑定和审计信息。

详细契约见 `docs/AD_PLATFORM_ARCHITECTURE.md`。

## 来源路由精简发布状态

- 来源路由精简已发布到 production，不存在关闭全部 Pixel 的中间版本。
- Meta、TikTok、Google、UTM、自然流量、冲突来源和最近来源继承均由同一来源路由器处理。
- D1 migration 保留有效连接、最新凭证、业务事实、Delivery、Outbox 和平台隔离约束。
- 发布验收以来源隔离、同事件 ID、类型检查、受影响 Worker 构建和 production smoke 为准，不在文档固化易过期的测试数量。

## 环境

- production：`meigallery-web`、`meigallery-api`、`meigallery-db`。
- dev：独立 Worker、D1、R2，不绑定广告 Queue，不请求真实平台。
- production 平台连接和实时质量以后台“归因”页面为准；文档不记录易过期的开关、比例、测试码或 commit。

## 发布

- PR CI 执行完整 lint、测试、覆盖率、Playwright、类型检查和构建。
- production 只允许从干净 `main` 手动发布。
- API/Web 可以按影响范围独立部署：

```bash
./scripts/deploy.sh production api
./scripts/deploy.sh production web
./scripts/deploy.sh production all
```

- API/Web commit 只用于观察，不要求相同，也不参与归因放行。
- 运行数据异常会产生警告，但不能阻止修复版本发布。
- 紧急故障先用最小改动恢复受影响 Worker，再完成完整复盘和相邻风险检查。

## 验证入口

```bash
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/web exec nuxt build
node scripts/verify-production.mjs all
corepack pnpm verify:seo:production
```

## 规划

- 使用真实广告流量继续观察 Meta、TikTok、Google 的 Browser/Server 配对与平台质量。
- 广告花费、campaign、ad set 和 ad 维度导入不属于 Pixel/Server API 同步范围。
- Cloudflare Stream 和完整 zip 异步导入仍待实现。

## 文档入口

- `AGENTS.md`：开发和分支规范。
- `docs/TECHNICAL_SPEC.md`：API、Schema、权限和安全契约。
- `docs/AD_PLATFORM_ARCHITECTURE.md`：归因架构。
- `docs/DEPLOYMENT.md`：Cloudflare 资源和发布流程。
- `docs/GIT_WORKFLOW.md`：分支、PR、tag 和 commit。
- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`：数据分析口径。
- `docs/TELEGRAM_IMPORT_API.md`：外部导入 API。
- `docs/SEO_CONFIGURATION.md`：SEO 配置。
