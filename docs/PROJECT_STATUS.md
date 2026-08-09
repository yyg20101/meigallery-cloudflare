# 项目状态

更新时间：2026-08-10。

本文件只记录当前状态。历史变更以 Git、PR、tag 和 `docs/releases/` 为准。

## 仓库

- GitHub 仓库已迁移至 `wj20101/meigallery-cloudflare`，本地 `origin` 已同步更新并验证可访问。
- 生产分支仍为 `main`，日常开发主线仍为 `dev`。

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
- 四个共享模块的 Android Host Test、Android Debug APK 和 iOS Simulator Kotlin/Native 编译均已通过；iOS Framework 本地链接仍被尚未接受的 Xcode 许可拦截，正式链接继续由 macOS CI 门禁验证。
- 已进入逐域纵向切片：`contracts/app-api-v2.openapi.yaml` 的 M0 公共发现四个只读路径保持冻结，累计契约版本已以兼容新增方式提升到 `1.16.0`，包含 production 默认关闭的 Auth-1、Interaction-1/2/3、Search-1/2、Taxonomy-1、Recommendation-1、Membership-1/2、Message-1/2/3、Safety-2 独立复核与 Wallet-1 契约；Membership-3/4 只扩展管理员 API，不改变 App API v2。Recommendation-1、Search-1/2、Taxonomy-1 与 Interaction-2/3 已完成 Cloudflare 与 KMP 开发，全部新增配置与验证统一在开发阶段结束后执行，媒体访问继续按域冻结。
- 已新增 `0067_app_public_profile_projection.sql` 空读投影和 App API v2 查询实现，强制 `verified + published + authorization active/unexpired + visible + source gallery published`；migration 不含 seed、回填或 legacy 自动映射，尚未执行生产 migration 或部署生产路由。
- KMP 客户端 M0 公共发现纵向切片已完成：capability、地区目录、推荐/热门/最新、地区筛选、游标分页、公开人物卡和基础详情均已接通；点击卡片会按稳定公开 ID 重新请求详情并复核最新公开资格，不直接信任列表快照。Android 模拟器已回归筛选、排序、详情错误/重试/成功和长列表，未发现崩溃、文字溢出或底部导航遮挡。正式应用 ID、会员、消息、钱包和媒体访问继续受各自门禁约束。
- 已完成 M1 人物供给最小开发闭环：`0068_app_person_supply_workflow.sql` 创建空的 Person、资料、用途授权、认证和发布复核权威表；内容版本与并发锁版本分离，审批绑定具体内容版本，发布动作单向生成公开投影，暂停或撤销会立即使投影不可见。
- Nuxt 后台已新增 `/admin/app/persons` 人物供给队列、新建候选页和单人物工作台，覆盖草稿编辑、用途授权登记/撤销、认证提交/四项复核/撤销、发布提交/通过/退回/暂停、双轴版本提示、全门禁说明和审批历史；页面使用可换行操作区、最小宽度约束与表格横向容器避免窄屏按钮和文字越界。
- M1 D1 定向测试已覆盖未认证不公开、完整审批后公开、线上/草稿隔离、暂停立即下线、过期授权、并发冲突和审计完整性；0001–0068 已在全新临时本地 D1 连续升级通过。当前仍未执行 production migration、未导入真实人物或证据，也未把未关闭的认证声明、证据保留期和人员分离规则固化为生产政策。
- 已完成 Auth-1 服务端账号访问开发基线：`0069_app_account_access.sql` 创建空的账号安全、邮箱身份映射、版本化同意、设备、App 会话、续期历史和安全事件表；现有 `users` 仍是唯一账号主体，注册不会创建 Person 或公开投影，旧 Web 账号只有在密码验证通过后才建立 App 身份映射。
- App API v2 已实现邮箱验证码申请、注册、登录、访问/续期凭证轮换、当前设备退出、本人摘要、设备列表和远程退出。访问与续期 Token 只保存 SHA-256 摘要；刷新后旧访问 Token 立即失效，旧续期 Token 重放会撤销会话；账号、设备、session version 和当前文档同意在服务端持续校验。
- Auth-1 由 `APP_AUTH_ENABLED`、`APP_AUTH_REGISTRATION_ENABLED`、四类文档版本、四个安全正文 URL 和生产 Turnstile 配置共同控制。production Wrangler 继续关闭且 production 尚未发布 App API v2；dev 为 Safety-2 内部联调开启 Auth，但注册仍关闭，临时正文统一指向 dev Web `/rules`。服务端已提供 CSP nonce 保护的受控挑战页，并对三类 action 执行 Siteverify 强校验；当前没有写死法定年龄、首发地区、手机号或第三方登录，不代表 G-01/G-03 已关闭，也未执行 production migration 或发布注册能力。
- Auth-1 的 D1/HTTP 测试已覆盖默认关闭、注册边界、旧账号映射、Token 旋转与重放撤权、设备归属和远程退出；账号新表确认无隐式回填。
- Auth-1 跨仓本地联调已完成 Android 模拟器登录闭环：原生 WebView 获取一次性 Turnstile token，首次登录命中 `CONSENT_REQUIRED`，确认四份当前正文版本后重新挑战，随后登录、本人摘要和设备列表均返回 200。Cloudflare 官方测试密钥的 `test`/缺失 action 兼容只允许 `APP_ENV=local`，production/dev 仍严格校验 action，production 额外校验 hostname。dev 已应用账号表族 migration 并部署内部联调开关，但没有开放注册、导入真实账号同意数据或改变 production。
- 已完成 Interaction-1 喜欢/关注跨仓纵向切片：`0070_app_viewer_interactions.sql` 只建立空的私有关系表和本人列表索引；App API v2 支持详情权威状态、幂等喜欢/关注写入及本人分页列表。新增关系必须重新校验资料当前公开资格，已失效资料只返回最小占位并仍允许本人取消。
- KMP 客户端已实现详情喜欢/关注即时反馈与失败回滚、“关注”一级页、已关注/喜欢切换、空态、错误、分页和不可用占位；客户端不呈现匹配、对方已收到或互动者名单。
- Interaction-1 测试覆盖重复 PUT、关系独立、账号隔离、不可用资料拒绝新增/允许取消、稳定分页、游标作用域、401 会话失效和客户端安全降级；`0001–0070` 已在全新临时本地 D1 连续升级通过。production 仍关闭 Auth；dev 因 Safety-2 内部联调开启 Auth，既有喜欢/关注 capability 会随 Auth 可用，但没有导入真实 App 互动数据。
- API 36.1 Android 模拟器已使用临时本地 Worker/D1 完成 Interaction-1 真实闭环：协议更新登录、详情状态、喜欢/关注 PUT、本人列表 GET 与取消 DELETE 均成功，取消后回到对应空态。capability 关闭、未登录、真实卡片和底部导航经语义布局树与截图检查，未发现文字、按钮、间距、对齐或边界越界。
- 已完成 Interaction-2 服务端开发基线：`0078_app_favorites_and_view_history.sql` 建立默认关闭的策略、多文件夹收藏、历史偏好与按人物聚合历史表；App API v2 `1.11.0` 提供收藏状态、全部收藏、收藏夹管理、历史显式开关、有效浏览记录、逐条删除与版本化全部清除。收藏保持独立于喜欢/关注，屏蔽人物会同步清理收藏与当前可见历史，解除后不恢复。
- Interaction-2 KMP 已在 `meigallery-client` 提交 `9ea4d1d`：新增独立收藏/历史领域和严格 transport，“我的”收藏夹总览、文件夹详情、人物归属调整、浏览记录设置/分页/删除/版本化清空，以及详情成功展示后使用稳定 `viewId` 的安全记录闭环。会员降级保留旧收藏夹和记录设置，账号切换不复用历史版本；收藏与浏览记录不进入喜欢/关注、推荐、分析、匹配或目标侧通知。Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。
- Interaction-2 当前未修改 Wrangler 配置、未执行 `0078` migration、未把 planned entitlement 改为 available，也未新增或运行专项测试、Framework 链接、模拟器/真机或远端联调；所有现有环境继续返回 `favorite=false`、`history=false`。配置和测试统一在开发阶段结束后补齐。完整边界见 `docs/app/INTERACTION_2_FAVORITES_HISTORY_INTEGRATION.md`。
- 已完成 Interaction-3 服务端开发基线：`0079_app_follow_updates.sql` 新增默认关闭的版本化策略、关注者反查与发布事件索引，并为 Message-3 预留事件加入固定 development 模板；App API v2 `1.12.0` 新增 `/me/follow-updates`、独立 capability 和 bootstrap 配置。更新只读取关注建立后、策略生效后的 `person_publication_reviews` 已发布事实，不复制动态正文或媒体快照。
- 关注通知在用户拉取站内通知时按账号惰性投影，依赖既有 Outbox 唯一约束去重；投递前再次校验当前关注、屏蔽、发布、认证、授权、有效期和来源图库状态。取消关注或资料失效后的待投递项会被抑制，目标真人及运营端不会收到关注者身份。
- Interaction-3 KMP 已在 `meigallery-client` 提交 `5d3cae7`：新增独立 capability、严格事件/分页 transport 和“更新 / 已关注 / 喜欢”三段式关注页；覆盖首次无关注、暂无更新、事件卡、分页、取消关注、详情返回刷新，并明确当前封面/简介不是事件历史快照。Message-3 互动通知继续进入当前人物权威详情。Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。
- Interaction-3 当前未修改 Wrangler、未执行 `0079`，也未新增或运行专项测试、Framework 链接、模拟器/真机或远端联调；所有现有环境继续返回 `followUpdates=false`。配置和测试统一在开发阶段结束后补齐；完整边界见 `docs/app/INTERACTION_3_FOLLOW_UPDATES_INTEGRATION.md`。
- 已完成 Search-1 服务端开发基线：`0080_app_person_search_and_history.sql` 新增人物搜索策略、默认关闭的账号私有历史设置和到期历史表；App API v2 `1.13.0` 新增 `POST /person-profiles/search`、搜索历史设置/记录/分页/逐条删除/全部清除、独立 capability 与 bootstrap 配置，并接入与 capability 解耦、受策略控制的到期分批清理。搜索只读取审核公开昵称、地区和标签，排除本人已屏蔽人物；搜索词通过请求正文传输，游标只保存哈希，不进入审计或分析事件。
- Search-1 KMP 已在 `meigallery-client` 提交 `5ea8dd8`：人物搜索严格使用 POST 正文，支持三种排序、不透明游标分页、命中说明、默认关闭且显式开启的账号搜索历史、逐条删除和版本化清空；搜索词不进入本地持久化、分析事件或推荐画像。Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。当前仍未修改 Wrangler、未执行 `0080`、未运行专项测试、模拟器/真机或远端联调，所有现有环境继续返回 `search.profiles=false`、`search.history=false`。完整边界见 `docs/app/SEARCH_1_PERSON_SEARCH_HISTORY_INTEGRATION.md`。
- 已完成 Taxonomy-1 服务端开发基线：`0081_app_taxonomy_catalog.sql` 新增稳定词条、不可变修订与目录快照、合并重定向、legacy 待复核映射、人物内容版本关联和公开分类投影；App API v2 `1.14.0` 新增默认关闭的 `GET /taxonomy/catalog`、独立 capability、ETag 与人物 `taxonomyTerms`，后台新增词条审核/生命周期/合并、目录生成发布、兼容映射及人物结构化标注 API。人物发布会原子刷新公开资料与分类投影，未设置分类当前仍可发布。
- Taxonomy-1 KMP 已在 `meigallery-client` 提交 `5ea8dd8`：Recommendation 与 Search 共用通用稳定目录领域和 transport，公共目录执行 capability 校验、进程内缓存、ETag 条件重验证、父级/重定向/类型完整性检查。Nuxt 已新增 `ADM-TAX-01/02/03` 三页后台工作区，覆盖 11 类词条树与筛选、草稿创建/编辑、审核和生命周期、合并、不可变修订/目录引用、legacy 映射、目录快照生成、结构与客户端影响检查以及显式发布确认；人物工作台同时接通不可变目录选择、最多 30 个稳定词条标注、失效项显式移除、草稿/线上分类对比和新内容版本保存。所有写操作复用管理员认证、乐观版本和服务端审计契约。当前仍未修改 Wrangler、未执行 `0081`、未导入 legacy 标签，也未运行专项测试、模拟器/真机或远端联调，所有现有环境继续返回 `taxonomy.catalog=false`。细粒度分类权限、敏感词升级审批、跨域完整引用计数、多语言、灰度/显式回滚和迁移批次后置；完整边界见 `docs/app/TAXONOMY_1_CATALOG_AND_PROFILE_INTEGRATION.md`。
- 已完成 Search-2 服务端开发基线：`0082_app_search_filters_and_saved_filters.sql` 扩展版本化搜索策略，新增 taxonomy 父子/合并闭包、账号私有保存条件和不可变 Search-2 会员开发目录；App API v2 `1.15.0` 为人物搜索增加稳定 taxonomy 条件，新增结果预估、本人筛选能力和保存条件 CRUD。地区条件同组 OR、跨组 AND，父级包含后代；高级条件分别由 canonical `discovery.filter.advanced` 与 `discovery.saved_filter.max` 控制，越权或失效条件不会被忽略后返回扩大结果。
- Search-2 KMP 已在 `meigallery-client` 提交 `5ea8dd8`：支持关键词与结构化条件组合、400ms 预估防抖、目录重定向/失效保留、服务端 entitlement 锁定、结果数与可应用状态，以及保存条件列表、创建、修改、删除、版本冲突和使用前完整来源条件重验。Nuxt 已新增 `/admin/app/search` 只读运营核查工作区，展示四条端到端门禁、不可变策略、taxonomy/会员目录依赖、Search-2 entitlement 执行值，以及不含搜索词和条件内容的历史/保存条件聚合健康与迁移诊断；页面不能直接切换配置或启用能力。当前仍未修改 Wrangler、未执行 `0082`、未切换搜索/taxonomy/会员目录、未迁移 grant，也未运行 migration、专项测试、模拟器/真机或远端联调；所有现有环境继续返回 `search.filters=false`、`search.savedFilters=false`。完整边界见 `docs/app/SEARCH_2_FILTERS_AND_SAVED_FILTERS_INTEGRATION.md`。
- 已完成 Recommendation-1 Cloudflare 平台开发基线：`0083_app_recommendation_rules_and_editorial.sql` 新增默认关闭策略、版本化热度/规则、本人显式偏好、运营精选、受保留门禁的最小化会话证据和后台幂等事实；App API v2 `1.16.0` 新增 `POST /discovery/recommendations`、本人偏好 GET/PUT、独立 capability 与可解释推荐响应。排序只允许登记信号；当前个性化只允许主动 taxonomy 偏好且 OQ-023 未批准时拒绝启用；小于 100% 的规则必须绑定同模式安全回退版本，个性化目录保持一致，并通过服务端签名短期游标稳定分桶。
- Nuxt 已新增 `/admin/app/recommendation/rules`、规则详情、Dry-run 预览和 `/admin/app/recommendation/placements` 四页运营工作台，覆盖草稿、职责分离复核、计划生效、暂停、回滚、固定“平台精选”披露和不可变事件时间线。KMP 已在 `meigallery-client` 提交 `0c308c3` 接入严格 `1.16.0` transport、版本化推荐、推荐理由/实际模式、签名游标分页约束和“我的 → 推荐与隐私”显式 taxonomy 偏好页面；Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。当前未修改 Wrangler、未执行 `0083`、未运行专项测试或远端联调，所有环境继续返回 `recommendation.*=false`；热度公式、证据保留、跨会话频控、指标反指标和自动停止仍待后续开发/决策。完整边界见 `docs/app/RECOMMENDATION_1_RULES_AND_EDITORIAL_INTEGRATION.md`。
- 已完成 Membership-1 跨仓开发闭环：`0071_app_membership_catalog_and_grants.sql` 建立版本化五级目录、typed entitlement、不可变 App grant、追加式撤销和管理员幂等请求；开发目录包含心遇、心悦、心知、心契、心耀及 `rank=10/20/30/40/50`，七项权益全部标记为 `planned`，不产生消息、筛选、历史或收藏夹的可执行权限。
- App API v2 `1.4.0` 已新增公共 `/membership/catalog` 和本人 `/me/entitlements`；本人等级只解析 App grant，不把旧 Web `vip/svip` 隐式映射。production/dev 的目录和后台开关均保持关闭，production 还必须同时满足运行时放行与目录 `published + production_ready` 双门禁。
- Nuxt 用户工作台已加入独立 App 会员面板，并新增客户设计路由 `/admin/app/membership/grants/new`：支持搜索并确认账号、配置五级稳定 tier、立即/预约发放、同级续期、权益 availability、变更预览、策略风险说明、幂等复核申请、grant 时间线和追加式撤销，与旧 Web 会员明确隔离；会员申请队列可直接进入该工作台。KMP “我的”页已接入独立五级会员页，支持公开目录、本人权威快照、规划中标签及明确的平台运营/无支付边界；站内申请由 Membership-2 独立能力控制。
- Membership-1 既有测试覆盖五级目录完整性、无 legacy 映射、预览/发放/续期、幂等与业务单冲突、审计隐私、最高有效 rank、到期、追加式撤销、production 双门禁和 KMP 非法响应安全拒绝；全新本地 D1 已连续应用 `0001–0071`，Android API 36.1 模拟器已完成公共目录、五级切换、长列表和服务边界验收。dev 已随连续升级应用 `0071` schema，但目录与后台开关仍关闭且没有真实 grant。完整交付边界见 `docs/app/MEMBERSHIP_1_CROSS_REPO_INTEGRATION.md`。批量发放、额度消耗和旧会员迁移仍未实现。
- 已完成 Membership-2 站内会员申请代码闭环：`0075_app_membership_applications.sql` 新增申请、用户可见事件和幂等请求表；同一账号只允许一条进行中申请，联系方式只引用已验证邮箱，申请说明不进入分析或通用审计。App API v2 `1.8.0` 支持本人提交、列表、详情、待补充后重新入队和取消，申请期间 rank、grant 与 entitlement 保持不变。
- Nuxt 新增 `/admin/app/membership/applications` 队列与详情工作台，支持筛选、领取、要求补充、拒绝、过期、平台取消和正式发放。批准路径使用独占发放锁与 Membership-1 幂等 grant；只有 grant 成功并关联后用户才看到“已发放”，重复响应恢复不会产生第二个 grant。
- KMP 新增独立申请页，覆盖五级选择、已验证邮箱说明、联系偏好、300 字最小化说明、当前披露确认、取消二次确认、状态事实和时间线；capability、策略或响应矛盾时只关闭申请，不影响公开目录。服务端 D1 与 App API 定向测试 18 项、客户端 Host Test 已通过。production/dev 的 `APP_MEMBERSHIP_APPLICATIONS_ENABLED` 均保持 `false`，尚未执行 `0075` dev/production migration、远程联调或真机 UI 验收；OQ-010/OQ-020 未关闭前不承诺 SLA、不创建自动清理、不保存真实申请。完整边界见 `docs/app/MEMBERSHIP_2_APPLICATION_INTEGRATION.md`。
- 已完成 Membership-3 管理员会员变更独立复核开发闭环：`0088_app_membership_change_reviews.sql` 建立空的版本化风险策略、发放/续期/撤销申请、不可变事件和幂等复核决定；不 seed 策略，缺少正式策略时服务端保守要求全部复核。`/admin/app/membership/reviews` 与逐单详情覆盖脱敏队列、受控内部依据、基线/当前权益对比、自审冲突、批准、拒绝和账号变化失效。
- 用户会员申请的“批准”现在只锁定申请并提交发放复核，另一位管理员批准时才在同一 D1 条件批次内写正式 grant、复核终态、申请 `approved`、用户可见事件和审计；当前会员、账号或业务单号变化会使旧申请进入 `stale` 且不产生权限。`0088` migration、真实风险策略、环境配置和专项测试按当前顺序统一后置；完整边界见 `docs/app/MEMBERSHIP_3_CHANGE_REVIEW_INTEGRATION.md`。
- 已完成 Membership-4 会员目录与 Entitlement 管理开发闭环：`0089_app_membership_catalog_management.sql` 为既有目录补齐基线、乐观锁、命令幂等、固化内容哈希、发布申请、不可变事件和 Owner 独立决定；运行引用、已发布、待复核以及被 grant、申请或后继版本引用的目录均不可原地编辑。
- Nuxt 已交付 `ADM-MBR-01/02`：目录完整复制、设置与五级原子编辑、Schema/安全默认值/客户端 capability 校验、基线比较、服务与 grant 影响查询、发布申请和独立复核。批准只形成不可变版本，不切换 Wrangler 目录、不迁移 grant、不开放 capability；`0089`、真实五级数值、生产决策、环境配置和专项测试继续后置。完整边界见 `docs/app/MEMBERSHIP_4_CATALOG_MANAGEMENT_INTEGRATION.md`。
- 已完成 Message-1 默认关闭的跨仓 HTTP 纵向切片：`0072_app_managed_conversations.sql` 新增会话、消息、日额度消耗和幂等事实表，并建立独立 `development` 目录 `amc_app_1_0_message_1_dev_1`；只有该目录中的 `direct_message.create`、`direct_message.send` 与 `direct_message.new_threads_per_day` 标记为 `available`，其余权益继续保持 `planned`。
- App API v2 `1.5.0` 已实现话题创建/复用、列表、详情、按 sequence 补拉、观看者文本发送和已读；所有受限操作均重新校验 App 会话、有效 grant、entitlement、人物公开资格和对象归属，创建及发送使用幂等键，上海自然日新话题额度在 D1 事务中原子消耗。
- Nuxt 后台已新增 `/admin/app/conversations` 平台话题队列与正文工作台。正文读取必须声明受控业务目的并写审计；运营回复固定落盘为 `platform_operator`，审计只记录消息引用、正文 SHA-256 和长度，不复制正文，并拒绝冒充真人或承诺结果的高风险表达。
- KMP 客户端已加入人物详情二次披露/确认、消息一级页、话题详情、文本发送、手动刷新、已读和会员到期只读状态；接收主体、披露版本和最大文本长度由 bootstrap 安全配置驱动，未知或矛盾配置直接关闭能力。实时通道、系统推送、媒体消息、撤回、举报/拉黑、会话设置、本人运营和多操作员分配均未纳入 Message-1。
- Message-1 production/dev 开关、管理后台开关和 production-ready 门禁均保持关闭；Wrangler 当前仍指向原 Membership-1 开发目录，因此没有环境会意外执行消息 entitlement。全新本地 D1 已连续应用 `0001–0072`，dev 也已应用对应 schema，但没有开放消息 capability 或导入真实消息数据。完整边界见 `docs/app/MESSAGE_1_CROSS_REPO_INTEGRATION.md`。
- 已完成 Message-2 默认关闭的跨仓安全与运营纵向切片：`0073_app_messaging_safety_operations.sql` 新增版本化举报原因目录、未决保留策略、人物屏蔽状态/事件、举报/最小证据/时间线、会话限时分配、全局运行控制和独立安全幂等结果；并发写通过版本条件与 mutation token 收敛，冲突请求不能留下未绑定的清理、处置或审计副作用。
- App API v2 `1.6.0` 已实现人物屏蔽/解除、本人屏蔽分页、人物/媒体/本人话题/本人消息举报、本人举报列表与详情、观看者关闭话题，以及登录发现页服务端排除已屏蔽人物。屏蔽会原子清理喜欢/关注并关闭关联话题；解除屏蔽不恢复旧关系或旧话题。
- Nuxt 已把平台话题工作台升级为“先领取限时租约，再读取正文/已读/回复/关闭”，并新增 `/admin/app/safety` 待处理举报队列、领取后最小证据窗口、结论处置和 Owner 全局暂停/容量控制。列表不返回消息正文或举报说明，敏感读取与全部写操作均审计，通用审计只保存引用、摘要、长度和目的。
- 已补齐 `ADM-MSG-02` 内部协作开发切片：`0084_app_conversation_collaboration.sql` 新增追加式内部备注、显式转派事实和独立管理员幂等表；后台工作台可记录运营/质量备注并按稳定原因、交接说明、当前租约版本和目标容量原子转派。转派成功后原操作员立即失去正文和写权限，通用审计只保存备注哈希、长度和引用。`0084` 尚未执行；质量抽检由独立 `0087` 表族承载，不复用内部备注。
- 已完成平台话题内部安全升级闭环：`0085_app_conversation_safety_escalations.sql` 建立与用户举报严格隔离的内部案件、最小消息证据、不可变时间线和独立幂等事实。当前租约持有人可按稳定原因、P0–P3 和可选目标消息升级；发起人不能领取本人案件，独立审核员领取后才可读取说明与前后各一条证据，并形成“无需动作 / 转只读 / 关闭”结论。内部说明不返回用户，实际话题动作使用用户可见系统消息；`0085`、配置和专项测试统一后置。
- 已完成 `ADM-MSG-03` 运营组、班次与自动分配开发闭环：`0086_app_conversation_routing_and_shifts.sql` 建立空的运营组、成员容量、上海时区跨日班次、真人/地区/默认路由规则、全局策略、路由分配事实和管理员幂等表。后台 `/admin/app/conversation-groups` 覆盖正常、无值班、过载和配置冲突；自动分配使用最具体规则、当前班次、个人/组双容量、服务日首次响应额度和最低负载最久未分配算法。人工领取复用同一路由范围并在条件批次内重验，不能绕过组或班次；无候选时保持未分配且不生成回复。`0086`、真实组/班次/规则配置和专项测试统一后置。
- 已完成 `ADM-MSG-04` 会话质量与抽检开发闭环：`0087_app_conversation_quality_reviews.sql` 建立实际回复操作员事实、确定性抽样批次、无正文样本队列、固定最小证据、限时质检租约、不可变事件、改进任务和独立幂等表。后台 `/admin/app/conversation-quality` 覆盖按运营组抽样、领取隔离、披露完整性、三维评分、通过/改进/安全转介、任务流转及已完成正文关闭；安全转介只创建独立案件，不自动处罚。运营回复与操作员事实在同一 D1 批次写入，抽检人不得是实际回复人，通用审计只保存 ID、哈希、长度和稳定原因。`0087` migration、真实质检范围配置和专项测试统一后置。
- KMP 客户端已接入严格 safety capability、鉴权发现页、人物详情举报/屏蔽、话题/单条消息举报、观看者关闭话题，以及“我的 → 安全中心”的屏蔽和举报分页/详情；非法目标、原因目录、ID、时间、游标或自相矛盾响应均安全拒绝。
- Message-2 的用户与后台安全开关在 production 保持 `false`；dev 只为 Safety-2 内部联调开启，`APP_SAFETY_PRODUCTION_READY=false`。保留策略 OQ-020 仍为 `unresolved`，保留天数为空且 `purge_enabled=0`；dev 已应用 `0073` schema，但不切换会员目录、不开放消息、不导入真实举报数据，也不允许生产发布。完整边界见 `docs/app/MESSAGE_2_CROSS_REPO_INTEGRATION.md`。
- 已完成 production 默认关闭、dev 受控联调的 Safety-2 独立复核纵向切片：`0074_app_safety_appeals.sql` 新增版本化申诉策略、申诉/用户可见事件/独立幂等表和索引，不创建业务 seed；App API v2 `1.7.0` 新增本人举报版本与申诉资格、幂等创建申诉、本人申诉分页与详情。
- Safety-2 只接受本人 `no_violation` 举报结论的 `report_no_violation_review`，同一结论版本只允许一次申请；原举报审核人不能领取复核。`upheld` 维持原结论，`changed` 只会原子重开举报为 `investigating` 并转交复核人，不自动执行违规处置。
- Nuxt 新增 `/admin/app/appeals` 队列与复核工作台；管理员必须先领取才能以 `appeal_review` 目的读取详情，领取、敏感读取与结论均审计。KMP 客户端已接入严格 capability、举报详情申请入口、复核列表/详情/时间线与版本冲突刷新。
- Safety-2 已于 2026-08-07 在独立 dev 资源完成受控联调：提交 `5cf79df` 部署为 API `810987bc-6942-4eb3-b555-412a84c4ca8a` 与 Web `462b215d-3c5e-4cc4-ac4a-f0252ba3d02c`，dev D1 连续应用 `0063–0074` 后无待执行 migration。自动 smoke 验证举报、原审核人隔离、独立复核改判、举报重开和 7 类审计动作，结束后测试用户、图库、人物、举报与申诉残留计数均为 0。
- migration 前 dev D1 SQL 备份文件为 `meigallery-db-dev-before-safety2-20260807-5cf79df.sql`，大小 464,296 bytes，SHA-256 为 `34a939814eb8e6a0f88509969b819cae5f623cefc7877c7db2053a4e437f3e5c`；迁移前 Time Travel bookmark 为 `00000041-00000000-000050c0-d2ceb922bd36080310b032df43b1d10f`。部署前 API/Web 回滚版本分别为 `2159eea3-cea7-4ed5-bbd7-208ff6f471c5` 与 `035612a1-7b95-44c3-912e-02b4c58d664f`。
- production 的 Auth、举报、申诉及全部 production-ready 开关继续关闭，且 production `/api/v2/app/bootstrap` 仍返回 404，确认本阶段未发布 App API v2。开发策略的 30 天窗口不是生产承诺，仍依赖未关闭的 OQ-020；完整边界见 `docs/app/SAFETY_2_APPEAL_INTEGRATION.md`。
- 已完成 Message-3 站内通知与可靠到达代码闭环：`0076_app_in_app_notifications.sql` 建立默认关闭的策略、事件定义、固定安全模板、账号偏好、可恢复 Outbox、通知投影和已读审计；不包含 seed、历史回填、系统推送或自动清理。
- App API v2 `1.9.0` 新增五类通知列表、安全详情、服务端未读数、单条/分类已读和版本化偏好。业务 trigger 只在 D1 策略开启时原子写 Outbox，消费者支持稳定通知 ID、偏好抑制、处理租约、指数退避和 dead letter；受控目标在每次响应时重验账号归属、对象状态与 capability。
- Nuxt 新增 `/admin/app/notifications` 只读运行台，展示运行时/D1 双门禁、事件、模板和投递状态，不返回平台话题正文、申请说明、安全证据、内部备注或 Token。KMP “消息”页新增平台话题/站内通知切换、五类列表、详情、未读、分类全部已读和通知偏好；当前只使用 HTTP 手动拉取，不申请系统通知权限或声称实时到达。
- Message-3 D1 定向测试覆盖默认关闭、Outbox 投影、固定安全文案、可选抑制/必要通知、未读与原子已读审计、目标失效和游标隔离；API/Web 全量测试、TypeScript/Nuxt 类型检查、Android Host Test/Debug APK 与 iOS Simulator Kotlin/Native 编译通过。本机 iOS Framework 链接仍被未接受的 Xcode 许可拦截，继续由 macOS CI 执行正式门禁。
- production/dev 的四个通知开关保持关闭，`0076` 尚未执行远端 migration，也没有真实通知数据。OQ-020 未关闭，开发策略 `generation_enabled=0`、`retention_days=NULL`、`purge_enabled=0`；完整边界见 `docs/app/MESSAGE_3_NOTIFICATION_INTEGRATION.md`。
- 已完成 Wallet-1 默认关闭的跨仓代码闭环：`0077_app_wallet_ledger.sql` 建立 development 策略、钱包快照、管理员调币申请、不可变分录、申请事件和独立复核记录；migration 不创建账号钱包、不导入旧余额、不写业务调币数据，也不开放批量或迁移入口。
- App API v2 `1.10.0` 新增本人余额、方向筛选的游标明细和分录安全详情；空钱包只返回虚拟零余额，不因读取创建数据库记录。分录只展示固定原因、用户安全业务单号、前后余额和完整冲正关系，不返回内部备注或管理员身份。
- Nuxt 新增 `/admin/app/wallets` 单笔调币工作台，支持账号确认、加币/扣币/补偿/完整冲正预览、幂等申请、另一管理员批准或拒绝。OQ-018 未关闭前所有申请强制独立复核、发起人不能自批、余额变化必须由新分录驱动，任何扣币均不得形成负余额。
- KMP “我的”页新增只读金币入口、余额卡、全部/增加/扣减筛选、明细分页与冲正详情；capability、策略或稳定枚举矛盾时安全关闭。客户端没有充值、支付、消费、礼物、装扮购买、转赠、兑换、转账、提现或申诉动作。
- Wallet-1 D1 定向测试已覆盖默认关闭、虚拟零钱包、负余额拒绝、独立复核、请求幂等、旧预览冲突、完整冲正、分录不可变、账号/游标隔离和必要通知目标。当前阶段 API 125 个测试文件/989 项、脚本 64 项、ESLint、API TypeScript、Nuxt production build 与本地空库 `0001`～`0077` 全量 migration 均通过；既有 Web 60 个文件/301 项、KMP Android Host Test/Debug APK 与 iOS Simulator Kotlin/Native 编译保持通过记录。本机 Framework 链接仍因未接受 Xcode 许可被 `xcrun` 69 拦截，继续由 macOS CI 执行正式门禁。production/dev 的四个钱包开关保持关闭，`0077` 尚未执行远端 migration，也没有真实余额或调币记录；完整边界见 `docs/app/WALLET_1_LEDGER_INTEGRATION.md`。
- 已完成 Wallet-1 dev 迁移准备工具与部署门禁：生成仓库外 SQL、SHA-256、Time Travel bookmark 和 30 分钟 manifest，并绑定 `dev` commit、独立 D1、关闭开关和严格 `0075`→`0076`→`0077` 队列。`deploy.sh` 在 `0077` 待执行时无条件阻断 production；dev 必须显式放行并复验 manifest，迁移和 Worker 完成后自动执行只读 schema/策略/空账本验收。
- 已完成 Wallet-1 一次性 D1 + 临时 Worker 功能 smoke：机器 gate、短期授权、明确数据位置、`HEAD==origin/dev` 和显式确认全部为硬前置；临时 Worker 只绑定当次 D1，不含共享 route、R2、Queue、Email 或 secret。自动验收覆盖 16 类真实 HTTP/D1 场景，成功或失败均先删 Worker、再删 D1，只在仓库外保存聚合证据；销毁失败有严格、幂等的恢复 manifest。实现过程中修正 Wallet 管理查询把真实 `app_account_security.account_id` 误写成测试专用 `user_id` 的空库联调缺陷，并让测试 fixture 与 `0069` migration 对齐。
- 2026-08-09 补齐一次性 smoke 的局部决策与证据生命周期：推荐全部独立复核、禁止负余额/批量、固定 30 天聚合证据和 `location=apac`，同时明确不关闭全局 production OQ。恢复销毁成功后生成最小证据并删除运行目录；显式清理器只删除到期且格式严格匹配的 evidence JSON。局部决策仍待项目 Owner 确认，Gate 保持关闭。
- 2026-08-08 只读远端检查确认 dev 当前待执行 migration 恰为 `0075`～`0077`；实际一次性 gate 仍为 `remoteSmokeAuthorized=false`，未创建远程 D1/Worker，未执行共享 dev migration 或任何远端写入。下一步先确认合成 smoke 局部决策，再分别取得短期 Gate 与当次执行批准；通过也不关闭全局 OQ 或自动放行共享 dev。操作边界见 `docs/app/WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md`、`docs/app/WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md` 与 `docs/app/WALLET_1_DEV_VALIDATION_RUNBOOK.md`。
- 已完成移动端 49 页和管理后台 43 页的页面级产品设计。
- Figma 最终文件已完成移动端 49 页/186 状态、管理后台 43 页/163 状态，共 92 个 Page ID/349 个状态；`30｜Prototype Flows` 覆盖 92 个流程预览。
- Figma 页面内与流程动作合计 2,284 个，缺失目标为 0；移动端关键点击热区不足为 0；正式页未绑定文字样式、原始填充/描边、缺失字体和文字溢出均为 0。
- Figma 最终版本 ID 为 `2381987656588552168`；`40｜Delivery Index` 与 `50｜QA & Handoff` 已完成，最终事实源为 `docs/app/figma-final-delivery-state.json`。
- 已按客户确认的原始暖粉视觉方向完成同视口对照，并修正文字排版、Icon 对齐、后台头部按钮重叠、会员选中卡对比度、运营总览 KPI 与表格溢出。
- 客户文档继续保留 92 张默认状态、54 张 P0 关键状态和通知/金币 23 张逐状态导出图，共 169 个 Page ID/状态/图片确定性映射；Figma 的 349 个状态是像素级视觉与交互权威来源。
- 已同步 `docs/app/MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md`，作为研发、测试与验收的 App 1.0 唯一开发需求基线；文档覆盖当前范围、未来兼容方向、非功能要求、技术基线、92 页逐页规格、349 个 Figma 状态、169 个客户文档图片映射、需求追踪、DoR 与 DoD。
- 已生成 `docs/app/APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md`，逐页覆盖角色、前置、入口、结构、交互、业务规则、数据权限、状态和验收。
- 客户产品需求确认书和逐页交互设计确认册已按 Figma 最终口径重新生成；每个 Page ID 的功能说明、需求追踪和原型图保持同页映射。产品需求确认书内嵌 199 张图，逐页交互设计确认册内嵌 169 张图。
- 已新增需求冻结准备清单与 15 页客户短版确认单，集中列出 8 项客户决策和 7 组专业门禁，并明确“功能交互冻结”与“像素级视觉冻结”必须分别记录；整体仍是冻结准备中，当前完成的 M0、M1、Auth-1、Interaction-1/2/3、Membership-1/2/3/4、Message-1/2/3、Safety-2 与 Wallet-1 均只是 production 默认关闭的分阶段开发验证，dev 联调或服务端代码存在不等于授权生产发布。
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
