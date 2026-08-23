# 项目状态

更新时间：2026-08-23。

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

## ADM-PER-04 ZIP 导入开发状态

- 已按正式 Figma `ADM-PER-04` 的正常、校验中、部分失败、已暂停、已完成五态重做 `/admin/app/imports` 列表和任务详情；页面只呈现服务端权威任务/逐项结果，不在浏览器解析 ZIP。
- `0101_zip_import_packages.sql`、`admin-zip-package.ts`、`admin-zip-import.ts` 已完成 256 MiB 私有 ZIP 原包的 8 MiB R2 multipart、一次性会话隔离、服务端 ETag 清单、range 流式解压硬上限、ZIP 安全边界、图片元数据净化、Queue 逐项处理、部分失败、带轮次/会话 guard 的暂停恢复、公式安全错误 CSV 与后台审计。
- Cloudflare 官方当前单请求上限按账户方案为 Free/Pro 100 MB、Business 200 MB；因此没有让 256 MiB 原包穿过单个 Worker 请求，而是使用现有私有 R2 binding multipart。无需新增 S3 密钥或浏览器直传 CORS 配置。
- ZIP schema 是 Gallery 内容包。成功项只创建 Gallery/媒体/标签，不自动创建 Person/Profile，也不自动进入推荐；任何真人候选仍需独立来源、授权、认证和发布工作流。
- 当前只完成开发：`0101` 尚未执行，`IMPORT_QUEUE` consumer/producer 与 Stream 仍未配置，测试源码已补但未运行，构建、测试、模拟器/浏览器 QA 和部署均按当前要求统一后置。

## WordPress 旧站迁移运行完整性

- 后台 `/admin/legacy-import` 已改用专用 legacy 任务列表，并接通实际存在的任务级媒体下载 API；列表不再混入 ZIP 任务或暴露 ZIP package 字段。
- API 已按 Owner 全部、Admin 本人限制任务、条目、执行、审核与媒体操作；同一来源一次只能有一个 processing 任务，重复文章同时按来源 post ID 与 Gallery slug 跳过。
- 单篇 Gallery、标签、媒体、legacy 条目、redirect 和 `import_legacy_gallery_item` 审计已收敛到同一 D1 batch；单篇回滚后另以原子 batch 持久化结构化失败条目、安全快照与最小审计，失败事实无法提交时终止任务。媒体补齐 `storage` 必填事实，并按 D1 每条 100 个绑定参数的当前上限分块。
- 远程链接入库前执行安全 HTTPS 校验，Gallery 正文移除源站媒体嵌入；私有来源快照冻结旧分类/标签 ID、媒体描述和原 HTML。审核保存结论、备注、审核人和时间，不覆盖风险标记，也绝不直接发布 Gallery。
- 全局下载、状态、失败重置和封面设置已限定到 legacy Gallery，普通 Admin 进一步只处理本人任务，避免误改 ZIP 或手工上传内容。
- 执行已增加 30 分钟 D1 权威租约：WordPress 每个 REST 请求有 60 秒截止时间，每页校验后与逐篇落库期间续租，完成/失败按当前 token 条件收敛；过期或历史缺失租约的 processing 任务可被原子收敛为失败，有效租约不能提前回收。
- `0116_legacy_import_operational_integrity.sql` 与 `0117_legacy_import_processing_lease_guards.sql` 已编写但未执行，后续按 `0116 → 兼容代码 → 0117` 发布；REST API 是当前唯一可执行来源，XML 上传/解析和 Stream 视频仍后置。测试源码已补但未运行，构建、浏览器 QA、部署、提交与推送继续统一后置。完整边界见 `docs/app/LEGACY_IMPORT_2_OPERATIONAL_INTEGRITY.md`。

## Telegram 外部导入运行完整性

- 接收记录、全部文件行和 accepted 审计现以单个 D1 batch 原子落库，每日 token 限额在 INSERT 条件内复核，并发唯一键冲突返回既有记录；不再并发超额或产生只有主记录/文件数不完整的 pending 任务。payload 从 `unknown` 逐字段校验并只保留白名单字段。
- 媒体处理已从 HTTP `waitUntil` 改为专用 `TELEGRAM_IMPORT_QUEUE`。pending 派发、failed 清理和 fetching 处理均使用一次性 token 与可过期 30 分钟租约；fetching 有效租约下的重复投递只延迟重试，租约为空或过期后才条件接管，避免并行处理同一文件。每个文件预先持久化目标文件 ID 与确定性 R2 key，Queue 重投可以续跑且不会生成新的不可定位对象。
- Telegram 两段请求均增加 60 秒超时和有界流读取；图片执行 10 MiB、魔数、容器、尺寸、像素、元数据净化和声明 MIME 一致性校验。底层网络、D1、R2 异常原文不再进入状态、文件错误、审计或结构化日志。
- failed 重试会再次清理持久化 R2/D1 资源；没有有效派发租约的 pending 或租约为空/过期的 fetching 可由 Import Token 或后台显式恢复。旧执行器在失败清理前重新证明 token 所有权，有效租约和旧 token 均不能覆盖新尝试。
- `0118_external_import_queue_integrity.sql`、Queue 消费者、Bot/后台恢复端点与测试源码已完成；Wrangler Queue 配置、migration 执行、构建、测试和环境 QA 按要求统一后置。当前无 App API v2、KMP、Nuxt 页面、Page ID 或 Figma 增量，页面事实保持 99/408、Mobile 50/208、Admin 49/200。完整边界见 `docs/app/EXTERNAL_IMPORT_2_QUEUE_INTEGRITY.md`。

## 独立 App 产品设计

- 已在同级独立仓库 `meigallery-client` 创建 KMP + Compose Multiplatform 最小技术脚手架；客户端与本仓库继续通过版本化契约协作，不放入当前 pnpm monorepo。
- 客户端当前锁定 Kotlin 2.4.10、Compose Multiplatform 1.11.1、AGP 9.0.1、Gradle 9.6.1、JDK 21，Android `minSdk = 26`、`compileSdk/targetSdk = 36`。
- 四个共享模块的 Android Host Test、Android Debug APK 和 iOS Simulator Kotlin/Native 编译均已通过；iOS Framework 本地链接仍被尚未接受的 Xcode 许可拦截，正式链接继续由 macOS CI 门禁验证。
- 已进入逐域纵向切片：`contracts/app-api-v2.openapi.yaml` 的 M0 公共发现四个只读路径保持冻结，累计契约版本已以兼容新增方式提升到 `1.26.0`，包含此前默认关闭的账号、互动、搜索、分类、推荐、会员、消息、安全、钱包、Privacy-1、媒体、App Core、Account/Settings-2/3、Privacy-2A 私有导出、Message-4 账号级无正文实时刷新，以及 Membership-7 会员生命周期呈现契约；Membership-3/4/5/6、Wallet-2/3/4 与 Audit-1/2/3 只扩展管理员 API。当前全部新增配置与验证统一在开发阶段结束后执行。
- 页面实现静态收口已完成：源 manifest 为 99 页/408 个正式状态（Mobile 50/208、Admin 49/200），`APP-SET-08` 为九态；KMP 50 个 Page ID 的页面专属源码均包含各自正式状态映射，Nuxt 49 个后台 Page ID 亦覆盖全部 200 个状态。最后四个移动端缺口“保留到期、已有话题、即将到期、撤销”已接入权威运行状态；该结论只代表源码覆盖，不替代后置的构建、测试和设备/浏览器 QA。
- 已新增 `0067_app_public_profile_projection.sql` 空读投影和 App API v2 查询实现，强制 `verified + published + authorization active/unexpired + visible + source gallery published`；migration 不含 seed、回填或 legacy 自动映射，尚未执行生产 migration 或部署生产路由。
- KMP 客户端公共发现已接通 capability、地区目录、排序筛选、游标分页、公开人物卡和基础详情；Media-1 进一步接通人物图片、会员短期取图、缩放翻页、媒体举报和认证说明。正式应用 ID、会员、消息、钱包与媒体能力继续受各自门禁约束。
- 已完成 M1 人物供给最小开发闭环：`0068_app_person_supply_workflow.sql` 创建空的 Person、资料、用途授权、认证和发布复核权威表；内容版本与并发锁版本分离，审批绑定具体内容版本，发布动作单向生成公开投影，暂停或撤销会立即使投影不可见。
- Nuxt 后台已新增 `/admin/app/persons` 人物供给队列、新建候选页和单人物工作台，覆盖草稿编辑、用途授权登记/撤销、认证提交/四项复核/撤销、发布提交/通过/退回/暂停、双轴版本提示、全门禁说明和审批历史；页面使用可换行操作区、最小宽度约束与表格横向容器避免窄屏按钮和文字越界。
- M1 D1 定向测试已覆盖未认证不公开、完整审批后公开、线上/草稿隔离、暂停立即下线、过期授权、并发冲突和审计完整性；0001–0068 已在全新临时本地 D1 连续升级通过。当前仍未执行 production migration、未导入真实人物或证据，也未把未关闭的认证声明、证据保留期和人员分离规则固化为生产政策。
- 已完成 Auth-1 服务端账号访问开发基线：`0069_app_account_access.sql` 创建空的账号安全、邮箱身份映射、版本化同意、设备、App 会话、续期历史和安全事件表；现有 `users` 仍是唯一账号主体，注册不会创建 Person 或公开投影，旧 Web 账号只有在密码验证通过后才建立 App 身份映射。
- App API v2 已实现邮箱验证码申请、注册、登录、访问/续期凭证轮换、当前设备退出、本人摘要、设备列表和远程退出。访问与续期 Token 只保存 SHA-256 摘要；刷新后旧访问 Token 立即失效，旧续期 Token 重放会撤销会话；账号、设备、session version 和当前文档同意在服务端持续校验。
- Auth-1 由 `APP_AUTH_ENABLED`、`APP_AUTH_REGISTRATION_ENABLED`、四类文档版本、四个安全正文 URL 和生产 Turnstile 配置共同控制。production Wrangler 继续关闭且 production 尚未发布 App API v2；dev 为 Safety-2 内部联调开启 Auth，但注册仍关闭，临时正文统一指向 dev Web `/rules`。服务端已提供 CSP nonce 保护的受控挑战页，并对三类 action 执行 Siteverify 强校验；当前没有写死法定年龄、首发地区、手机号或第三方登录，不代表 G-01/G-03 已关闭，也未执行 production migration 或发布注册能力。
- Auth-1 的 D1/HTTP 测试已覆盖默认关闭、注册边界、旧账号映射、Token 旋转与重放撤权、设备归属和远程退出；账号新表确认无隐式回填。
- Auth-1 跨仓本地联调已完成 Android 模拟器登录闭环：原生 WebView 获取一次性 Turnstile token，首次登录命中 `CONSENT_REQUIRED`，确认四份当前正文版本后重新挑战，随后登录、本人摘要和设备列表均返回 200。Cloudflare 官方测试密钥的 `test`/缺失 action 兼容只允许 `APP_ENV=local`，production/dev 仍严格校验 action，production 额外校验 hostname。dev 已应用账号表族 migration 并部署内部联调开关，但没有开放注册、导入真实账号同意数据或改变 production。
- 已完成 Interaction-1 喜欢/关注跨仓纵向切片：`0070_app_viewer_interactions.sql` 只建立空的私有关系表和本人列表索引；App API v2 支持详情权威状态、幂等喜欢/关注写入及本人分页列表。新增关系必须重新校验资料当前公开资格，已失效资料只返回最小占位并仍允许本人取消。
- KMP 客户端已实现详情喜欢/关注即时反馈与失败回滚；“关注”一级页只承载关注动态与已关注筛选，“喜欢”从“我的”进入独立页面，覆盖空态、错误、筛选、分页和不可用占位。客户端不呈现匹配、对方已收到或互动者名单。
- Interaction-1 测试覆盖重复 PUT、关系独立、账号隔离、不可用资料拒绝新增/允许取消、稳定分页、游标作用域、401 会话失效和客户端安全降级；`0001–0070` 已在全新临时本地 D1 连续升级通过。production 仍关闭 Auth；dev 因 Safety-2 内部联调开启 Auth，既有喜欢/关注 capability 会随 Auth 可用，但没有导入真实 App 互动数据。
- API 36.1 Android 模拟器已使用临时本地 Worker/D1 完成 Interaction-1 真实闭环：协议更新登录、详情状态、喜欢/关注 PUT、本人列表 GET 与取消 DELETE 均成功，取消后回到对应空态。capability 关闭、未登录、真实卡片和底部导航经语义布局树与截图检查，未发现文字、按钮、间距、对齐或边界越界。
- `APP-INT-02` 已按 Figma 重构为从“我的”进入的独立喜欢页：3 张正式状态节点与支持 Section `824:3614` 的 16 张交互稿已完成全量视觉/交互 QA；KMP 已接入搜索、地区/风格目录筛选、两列 API 真人卡、空态/失效占位、分页、游标整表刷新及服务端确认取消喜欢。API 列表新增可选 `query`、`region`、`styleTerm`，游标绑定账号、关系类型与完整筛选上下文；按当前安排尚未执行 Gradle、构建、测试或设备验证。
- 已完成 Interaction-2 服务端开发基线：`0078_app_favorites_and_view_history.sql` 建立默认关闭的策略、多文件夹收藏、历史偏好与按人物聚合历史表；能力引入于 App API v2 `1.11.0`，该切片在累计 `1.21.0` 新增收藏夹去重总数、每夹四图预览、账号私有搜索/地区/风格筛选和筛选绑定游标，并把名称上限统一为 20 字；仓库当前累计契约为 `1.26.0`。
- 新增 `0096_app_favorite_folder_preserve_default.sql`：删除自定义收藏夹前把条目保留到固定默认收藏，删除不会取消喜欢；兼容字段 `removedGlobalFavoriteCount` 固定为 `0`。触发器同时检查账号和默认收藏夹存在性，不干扰账号级联清理。
- Interaction-2 KMP 已按正式 Figma `APP-INT-03/04/05/06` 节点接入收藏夹总览/详情、创建/失败/管理/重命名/删除、地区/风格筛选、人物收藏归属调整，以及浏览历史正常/空/清空确认/清空失败状态。`APP-INT-06` 的 10 个正式节点覆盖加载、读取失败、更新、失败、成功、资料不可用、最后一项确认/处理中和已取消收藏；Figma 审计未发现越界、缺失字体、无效原型目标或低于 44px 的点击热区。不存在独立“全部收藏”卡片。历史基线曾通过 Android Debug APK 与 iOS Simulator Kotlin/Native 编译，本次重构尚未重新构建或执行设备截图。
- Interaction-2 当前未修改 Wrangler 配置、未执行 `0078`/`0096` migration、未把 planned entitlement 改为 available，也不运行 Gradle、专项测试、Framework 链接、模拟器/真机、`android-cli` 截图或远端联调；所有现有环境继续返回 `favorite=false`、`history=false`。配置和测试统一在开发阶段结束后补齐。完整边界见 `docs/app/INTERACTION_2_FAVORITES_HISTORY_INTEGRATION.md`。
- 已完成 Interaction-4 浏览历史到期生命周期后端增量：运行配置区分显式策略 ID 与 development 默认展示 ID；每日维护只有在 `history_retention_decision_status=approved + purge_enabled=1` 时，才按 `expires_at/account/profile` 稳定顺序有界删除到期行并报告 `hasMore`。删除不依赖收藏/历史 capability 继续开启，不改偏好版本、收藏或会员 entitlement；错误日志只写固定码。无 migration、API、KMP、Nuxt、Page ID 或 Figma 增量，页面保持 99/408、Mobile 50/208、Admin 49/200；D1 测试源码已编写但未运行。详见 `docs/app/INTERACTION_4_VIEW_HISTORY_LIFECYCLE_INTEGRATION.md`。
- 已完成 Interaction-3 服务端开发基线：`0079_app_follow_updates.sql` 新增默认关闭的版本化策略、关注者反查与发布事件索引，并为 Message-3 预留事件加入固定 development 模板；App API v2 `1.12.0` 新增 `/me/follow-updates`、独立 capability 和 bootstrap 配置。更新只读取关注建立后、策略生效后的 `person_publication_reviews` 已发布事实，不复制动态正文或媒体快照。
- 关注通知在用户拉取站内通知时按账号惰性投影，依赖既有 Outbox 唯一约束去重；投递前再次校验当前关注、屏蔽、发布、认证、授权、有效期和来源图库状态。取消关注或资料失效后的待投递项会被抑制，目标真人及运营端不会收到关注者身份。
- Interaction-3 KMP 的历史提交 `5d3cae7` 完成独立 capability、严格事件/分页 transport 和关注更新基线；当前 Figma 基线已把旧“更新 / 已关注 / 喜欢”三段结构收敛为“全部 / 有更新 / 最近关注”筛选，喜欢迁移到独立 `APP-INT-02`。首次无关注、暂无更新、事件卡、分页、取消关注和详情返回刷新继续保留，Message-3 互动通知仍进入当前人物权威详情。
- Interaction-3 当前未修改 Wrangler、未执行 `0079`，也未新增或运行专项测试、Framework 链接、模拟器/真机或远端联调；所有现有环境继续返回 `followUpdates=false`。配置和测试统一在开发阶段结束后补齐；完整边界见 `docs/app/INTERACTION_3_FOLLOW_UPDATES_INTEGRATION.md`。
- 已完成 Search-1 服务端开发基线：`0080_app_person_search_and_history.sql` 新增人物搜索策略、默认关闭的账号私有历史设置和到期历史表；App API v2 `1.13.0` 新增 `POST /person-profiles/search`、搜索历史设置/记录/分页/逐条删除/全部清除、独立 capability 与 bootstrap 配置，并接入与 capability 解耦、受策略控制的到期分批清理。搜索只读取审核公开昵称、地区和标签，排除本人已屏蔽人物；搜索词通过请求正文传输，游标只保存哈希，不进入审计或分析事件。
- Search-1 KMP 已在 `meigallery-client` 提交 `5ea8dd8`：人物搜索严格使用 POST 正文，支持三种排序、不透明游标分页、命中说明、默认关闭且显式开启的账号搜索历史、逐条删除和版本化清空；搜索词不进入本地持久化、分析事件或推荐画像。Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。当前仍未修改 Wrangler、未执行 `0080`、未运行专项测试、模拟器/真机或远端联调，所有现有环境继续返回 `search.profiles=false`、`search.history=false`。完整边界见 `docs/app/SEARCH_1_PERSON_SEARCH_HISTORY_INTEGRATION.md`。
- 已完成 Taxonomy-1 服务端开发基线：`0081_app_taxonomy_catalog.sql` 新增稳定词条、不可变修订与目录快照、合并重定向、legacy 待复核映射、人物内容版本关联和公开分类投影；App API v2 `1.14.0` 新增默认关闭的 `GET /taxonomy/catalog`、独立 capability、ETag 与人物 `taxonomyTerms`，后台新增词条审核/生命周期/合并、目录生成发布、兼容映射及人物结构化标注 API。人物发布会原子刷新公开资料与分类投影，未设置分类当前仍可发布。
- Taxonomy-1 KMP 已在 `meigallery-client` 提交 `5ea8dd8`：Recommendation 与 Search 共用通用稳定目录领域和 transport，公共目录执行 capability 校验、进程内缓存、ETag 条件重验证、父级/重定向/类型完整性检查。Nuxt 已新增 `ADM-TAX-01/02/03` 三页后台工作区，覆盖 11 类词条树与筛选、草稿创建/编辑、审核和生命周期、合并、不可变修订/目录引用、legacy 映射、目录快照生成、结构与客户端影响检查以及显式发布确认；人物工作台同时接通不可变目录选择、最多 30 个稳定词条标注、失效项显式移除、草稿/线上分类对比和新内容版本保存。所有写操作复用管理员认证、乐观版本和服务端审计契约。当前仍未修改 Wrangler、未执行 `0081`、未导入 legacy 标签，也未运行专项测试、模拟器/真机或远端联调，所有现有环境继续返回 `taxonomy.catalog=false`。细粒度分类权限、敏感词升级审批、跨域完整引用计数、多语言、灰度/显式回滚和迁移批次后置；完整边界见 `docs/app/TAXONOMY_1_CATALOG_AND_PROFILE_INTEGRATION.md`。
- 已完成 Search-2 服务端开发基线：`0082_app_search_filters_and_saved_filters.sql` 扩展版本化搜索策略，新增 taxonomy 父子/合并闭包、账号私有保存条件和不可变 Search-2 会员开发目录；App API v2 `1.15.0` 为人物搜索增加稳定 taxonomy 条件，新增结果预估、本人筛选能力和保存条件 CRUD。地区条件同组 OR、跨组 AND，父级包含后代；高级条件分别由 canonical `discovery.filter.advanced` 与 `discovery.saved_filter.max` 控制，越权或失效条件不会被忽略后返回扩大结果。
- Search-2 KMP 已在 `meigallery-client` 提交 `5ea8dd8`：支持关键词与结构化条件组合、400ms 预估防抖、目录重定向/失效保留、服务端 entitlement 锁定、结果数与可应用状态，以及保存条件列表、创建、修改、删除、版本冲突和使用前完整来源条件重验。Nuxt 已新增 `/admin/app/search` 只读运营核查工作区，展示四条端到端门禁、不可变策略、taxonomy/会员目录依赖、Search-2 entitlement 执行值，以及不含搜索词和条件内容的历史/保存条件聚合健康与迁移诊断；页面不能直接切换配置或启用能力。当前仍未修改 Wrangler、未执行 `0082`、未切换搜索/taxonomy/会员目录、未迁移 grant，也未运行 migration、专项测试、模拟器/真机或远端联调；所有现有环境继续返回 `search.filters=false`、`search.savedFilters=false`。完整边界见 `docs/app/SEARCH_2_FILTERS_AND_SAVED_FILTERS_INTEGRATION.md`。
- 已完成 Recommendation-1 Cloudflare 平台开发基线：`0083_app_recommendation_rules_and_editorial.sql` 新增默认关闭策略、版本化热度/规则、本人显式偏好、运营精选、受保留门禁的最小化会话证据和后台幂等事实；App API v2 `1.16.0` 新增 `POST /discovery/recommendations`、本人偏好 GET/PUT、独立 capability 与可解释推荐响应。排序只允许登记信号；当前个性化只允许主动 taxonomy 偏好且 OQ-023 未批准时拒绝启用；小于 100% 的规则必须绑定同模式安全回退版本，个性化目录保持一致，并通过服务端签名短期游标稳定分桶。
- Nuxt 已新增 `/admin/app/recommendation/rules`、规则详情、Dry-run 预览和 `/admin/app/recommendation/placements` 四页运营工作台，覆盖草稿、职责分离复核、计划生效、暂停、回滚、固定“平台精选”披露和不可变事件时间线。KMP 已在 `meigallery-client` 提交 `0c308c3` 接入严格 `1.16.0` transport、版本化推荐、推荐理由/实际模式、签名游标分页约束和“我的 → 推荐与隐私”显式 taxonomy 偏好页面；Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。当前未修改 Wrangler、未执行 `0083`、未运行专项测试或远端联调，所有环境继续返回 `recommendation.*=false`；热度公式、真实证据来源/保留、跨会话频控与生产阈值仍待决策。物理到期与注销删除源码已由 Recommendation-6 补齐，但不代表保留决策已批准。完整边界见 `docs/app/RECOMMENDATION_1_RULES_AND_EDITORIAL_INTEGRATION.md`。
- 已完成 Recommendation-2 客户端版本门禁增量：bootstrap 按 KMP 固定发送的 `X-Client-Version` 计算推荐 capability，推荐/偏好接口和实际规则选择执行策略、规则与回退最低版本；高版本排期不会覆盖旧客户端仍兼容的 active 版本，高版本 active 只能使用显式登记且兼容的历史回退。后台只接受可比较的两段/三段数字版本，规则最低版本高于策略基线时即使 100% 启用也必须登记回退。无公共 DTO、migration、Page ID 或 Figma 状态增量，总量保持 99/408、Mobile 50/208；构建、测试和环境验证后置。完整边界见 `docs/app/RECOMMENDATION_2_CLIENT_VERSION_GUARD_INTEGRATION.md`。
- 已完成 Recommendation-3 地区作用域增量：`targetRegionCodes` 现在在 scheduled/active/历史回退选择前执行；全局规则、明确地区规则、未选地区和 capability 探测具有不同且固定的安全语义。新排期不覆盖请求地区时可继续使用兼容 active，灰度回退会再次校验地区；后台要求地区规则即使 100% 启用也登记回退，并阻断全局目标回退到地区子集或地区目标回退范围不完整。无公共 DTO、migration、KMP、Page ID 或 Figma 状态增量，总量保持 99/408、Mobile 50/208；构建、测试和环境验证后置。完整边界见 `docs/app/RECOMMENDATION_3_REGION_SCOPE_AND_FALLBACK_INTEGRATION.md`。
- 已完成 Recommendation-4 可执行规则选择增量：scheduled、active 与显式历史回退现在按优先级逐条校验完整权重/理由/渠道及 taxonomy、heatVersion、production-ready 运行依赖；失效高优先候选不再覆盖仍可执行版本。个性化选择绑定账号当前偏好目录，`auto` 的实际灰度回退若失效会重建非个性化执行上下文，bootstrap capability 也复用完整校验而不只看状态。当前规则只对同一组“公开资格 + 请求地区”候选评分，不定义规则专属过滤器；因此该候选集合为空时切换旧规则不会产生内容，服务端安全返回显式空结果，Dry-run 则阻断一开始就无候选的规则启用。未来只有在引入规则专属过滤器时才需新增跨规则结果降级。无公共 DTO、migration、KMP、Page ID 或 Figma 状态增量，总量保持 99/408、Mobile 50/208；构建、测试和环境验证后置。完整边界见 `docs/app/RECOMMENDATION_4_EXECUTABLE_RULE_SELECTION_INTEGRATION.md`。
- 已完成 Recommendation-5 灰度守护与自动停止服务端增量：`0113_app_recommendation_guardrails.sql` 新增默认关闭的来源/保留控制、独立复核策略、固定目标/反指标目录、聚合整数评估、不可变停止阻断和幂等事实；部分灰度启用与运行选择均要求守护链完整，来源缺项或 stop 指标连续越线后排除目标并只使用登记的 100% 回退。停止不伪造规则状态或管理员动作，被阻断版本不能复活，只能复制后重新 Dry-run/复核。该切片未改变公开 DTO；仓库当前累计 App API 为 `1.26.0`，无 KMP、Nuxt 页面、Page ID 或 Figma 状态增量，总量保持 99/408、Mobile 50/208、Admin 49/200；`0113`、真实来源/阈值/保留决策、配置、构建、测试与环境验证后置。完整边界见 `docs/app/RECOMMENDATION_5_GUARDRAIL_AND_AUTOMATIC_STOP_INTEGRATION.md`。
- 已完成 Recommendation-6 推荐解释证据生命周期服务端增量：`0114_app_recommendation_evidence_lifecycle.sql` 增加账号摘要索引和会话/条目 UPDATE 不可变约束；既有 15 分钟调度只在保留决策与 purge 门禁完整时有界删除到期会话并级联条目。Privacy-2B 现以与写入相同的分用途 HMAC 删除账号关联会话，将会话/条目纳入第四步前后零残留计数，并在开始/重试前检查稳定密钥可用。无公开 DTO、KMP、Nuxt、Page ID 或 Figma 增量，总量保持 99/408、Mobile 50/208、Admin 49/200；`0114`、真实保留期/密钥生命周期、配置、构建、测试与环境验证后置。完整边界见 `docs/app/RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md`。
- 已完成 Privacy-2C 个人数据副本覆盖补全：新制品白名单从 35 类追加到 41 类，新增推荐偏好、人物拉黑状态/时间线、旧版图库点赞和推荐解释会话/条目；前 35 类 ordinal 不变，执行器按 artifact 实际 scope 数完成，升级前 35-scope 任务不会误跑新增分类。推荐证据沿用集中账号 HMAC 定位，导出内容排除 `account_hash`、`context_hash` 与内部账号映射，密钥缺失时 readiness/开始/分页均 fail closed。无 migration、公共 DTO、KMP、Nuxt、Page ID 或 Figma 增量；仓库当前 App API 为 `1.26.0`，页面保持 99/408、Mobile 50/208、Admin 49/200。源码测试已编写但未运行，详见 `docs/app/PRIVACY_2C_DATA_COPY_COVERAGE_INTEGRATION.md`。
- 已完成 Privacy-1 数据权利控制面开发基线：`0094_app_data_rights_control_plane.sql` 新增默认关闭策略、导出/注销申请、不可变事件、密码二次验证证据、短期 step-up token、请求级状态 token 和幂等命令；App API v2 `1.17.0` 新增本人概览、记录/详情、导出/注销申请、取消和注销后请求级状态访问。注销提交会撤销普通 App/Web 会话，并由 D1 triggers 阻止待处理账号新增互动、收藏、历史、话题、会员和金币事实。
- 已完成 Privacy-2A 私有导出制品跨仓开发：`0102_app_data_rights_private_exports.sql` 新增默认关闭且不可变的执行配置、rowid 纳入边界、NDJSON 分片、可恢复 Queue 任务、私有 R2 README/manifest/TAR、一次性下载票据和两阶段到期清理；原第 35 类是 Message-4 增加且不含哈希/内部账号 ID 的实时票据摘要，Privacy-2C 后新制品当前为 41 类。App API v2 `1.24.0` 在申请详情暴露最小制品摘要，并新增 `export_download` 二次验证、票据签发与 `X-Data-Rights-Download-Ticket` 流式下载；KMP 以 64 KiB 块写入 Android/iOS 文件存储，失败清理部分文件，不缓存明文票据。`APP-SET-09` ready 态严格复用 Figma `159:74172`，`ADM-PRI-02` 仍以 `944:16747` 为视觉基线。不可逆注销处理继续关闭；`0102`、Queue/R2 配置、构建、测试和设备 QA 后置。详见 `docs/app/PRIVACY_2A_PRIVATE_EXPORT_INTEGRATION.md` 与 `docs/app/PRIVACY_2C_DATA_COPY_COVERAGE_INTEGRATION.md`。
- 已完成 Privacy-2B 不可逆注销跨仓源码开发：`0103_app_data_rights_irreversible_deletion.sql` 新增默认关闭且不可变的 deletion profile、九步执行检查点、逐步证据、七类 `compliance_only` 保留隔离、可选身份 HMAC 封存和账号墓碑；Queue 执行器以 D1 租约恢复，管理员只能开始/重试，只有证据完整才能完成，任何失败只能前向修复。Recommendation-6 已把账号关联推荐会话及级联条目纳入第四步零残留删除。KMP 在请求级状态读到 completed 后清理状态凭证、普通会话和账号域内存并轮换安装标识，直接返回未登录“我的”；`APP-SET-10` 没有自拟完成页。OQ-020/OQ-024/OQ-025 仍未关闭，`0103/0114`、Queue/Secret/Wrangler 配置、构建、测试和设备 QA 均后置，详见 `docs/app/PRIVACY_2B_IRREVERSIBLE_DELETION_INTEGRATION.md`。
- 已完成 Media-1 人物图片与认证说明开发基线：App API v2 `1.18.0` 复用 `galleries + media_assets + profile_public_projections`，新增公开图片列表、5 分钟会话/人物/单图绑定会员凭证、Worker 代理 R2 取图和最小公开认证说明；KMP 已完成严格 transport、仅内存受保护图片、自适应媒体页、认证页和媒体举报。Cloud API 类型检查、OpenAPI YAML 解析和 Nuxt Worker 构建已通过；没有新增 migration，视频继续关闭，Wrangler 配置、专项测试、Gradle、模拟器/真机和联调后置。
- 已完成 App Core-1 跨仓开发基线：App API v2 `1.19.0` 新增运行策略、帮助中心和受限账号摘要；KMP 已完成强制升级、维护/部分恢复、地区不可用、账号受限、对象不可用、帮助中心和关于/法律页面，并在运行门禁通过前停止业务请求。未新增 migration，未写 Wrangler 值；按当前开发顺序，Cloudflare/KMP 构建、专项测试、截图和联调统一后置。
- 已完成 Account/Settings-2 开发接线：App API v2 `1.20.0` 与 `0095` 新增观看者私有账号资料、初始偏好 capability 和单会话免打扰；三个独立环境开关默认关闭。Figma 已补齐 APP-MSG-03/04 的消息操作、举报、屏蔽与关闭确认状态并连接原型，KMP 已按 APP-AUTH-05、APP-SET-02、APP-MSG-03/04 节点接入。当前只完成开发和静态差异检查，migration、配置、构建、测试、`android-cli` 截图和联调统一后置。
- 已完成 Message-3 模板治理扩展：`0097` 增加权威变量目录/允许列表、不可变模板版本、草稿提交、创建人隔离复核和发布唯一性；后台按 `ADM-NTF-02` Figma 状态显示正常、变量缺失和自审阻断。补发、撤回与营销群发仍未开放。
- 已完成 Membership-5 旧会员显式迁移开发：`0098` 冻结 legacy 等级、发放人、原始/标准化时间和目标目录证据；逐项要求另一位 Owner 复核，正式执行另有默认关闭的批准门禁和 10 分钟恢复租约。`ADM-MBR-06` 严格对应 Figma 正常、证据不足和映射冲突三态，不自动猜测 `vip/svip` 映射。
- 已完成 Membership-6 会员批量发放服务端源码：`0104` 固定九列 CSV、最多 200 行，冻结批次/逐行证据并按 10 分钟租约恢复；有效行只创建 Membership-3 普通复核申请，另一管理员逐项批准前不产生 grant，部分失败与响应丢失不会重复成功项。创建人可幂等取消尚未提交的 draft；敏感详情读取和全部命令均审计。OQ-018 未关闭，D1 控制默认 `enabled=0`，`0104` 尚未执行；Figma 没有正式批量页面，因此没有新增 Nuxt 页面、导航或状态，当前注册表保持 408/208/200。详见 `docs/app/MEMBERSHIP_6_BATCH_GRANTS_INTEGRATION.md`。
- Message-1 已独立实现 `direct_message.new_threads_per_day` 上海自然日额度原子消耗，既有会话和幂等重试不重复消耗。
- 已完成 Wallet-2 批量调币与对账开发：`0099` 的 CSV 预览按行隔离重复/非法项，总额异常硬阻断，提交按租约恢复且每行只创建普通独立复核申请；对账扫描比较快照、sequence 与不可变分录链，只允许符合条件的追加式 forward-fix。`ADM-WAL-05/06` 已映射全部 7 个 Figma 正式状态。`0097–0099` 均未执行，配置、功能测试、构建、`android-cli` 和远端联调继续统一后置。
- 已完成 Wallet-3 钱包快照重建与受控解冻开发：`0107` 新增不可变恢复命令和案件关联，只有 Owner 可在全部未终结案件由本人认领、案件集合摘要未变化且分录链完整时，将钱包快照重建为分录末态、原子关闭覆盖案件并执行 `frozen -> active`。直接解冻、链断点掩盖、部分案件关闭和同键异请求均被服务端或 D1 trigger 阻断；Nuxt 复用 `ADM-WAL-06` 既有三态并在成功后发布 Message-4 `wallet` 刷新。未新增 Page ID/状态，总量保持 99/408、Mobile 50/208；`0107`、构建、测试、迁移和恢复演练继续统一后置。
- 已完成 Wallet-4 旧余额显式迁移后端：`0111` 不读取或猜测仓库内不存在的 legacy 金币字段，只接受带来源系统、提取时间、映射规则、目标稳定账号和 SHA-256 的显式外部快照；来源账号引用必须使用不含邮箱/手机号正文的 `opaque:` 令牌。Dry-run 后由另一位 Owner 逐项复核，正式执行另有默认关闭门禁和 10 分钟恢复租约；每项复用 Wallet-1 普通双人复核与不可变分录，并以 `legacy:<itemId>` 和不可变 link 区分日常调币。普通调币入口不能伪装或复核迁移申请，同一来源/目标最多成功一次；目标事实漂移时会先安全拒绝已冻结但尚未入账的迁移申请，再把条目标记为 `stale`。任务列表与含余额证据的详情读取也写用途化审计；执行完成后的同键重放即使门禁后来关闭，仍只返回原结果而不重复入账。当前无 Wallet 迁移 Page ID，因此未新增 UI/Figma/公共 DTO，总量保持 99/408、Mobile 50/208；`0111`、真实来源决策、配置、构建与新增 D1 用例执行统一后置。详见 `docs/app/WALLET_4_LEGACY_BALANCE_MIGRATION_INTEGRATION.md`。
- 已完成 Account/Settings-3 跨领域申诉开发：累计 App API v2 为 `1.23.0`，`0100_app_cross_domain_appeals.sql` 为账号限制与金币分录建立独立不可变申诉事实，并为举报申诉补齐补充、升级和统一复核状态；用户创建/列表/详情/补充与管理员统一队列/详情/领取/请求补充/升级/结论均已接入，原业务对象不会被申诉工作流直接改写。KMP 使用进程内幂等重试、冲突案件恢复和入口上下文隔离；`APP-SET-08` 已在 Figma 扩展为九态，新增终态节点 `1130:3617`、`1132:3618`、`1132:3670` 并完成定向排版检查。`0100`、配置、构建、测试、`android-cli`、真机和远端联调继续统一后置，详见 `docs/app/ACCOUNT_SETTINGS_3_CROSS_DOMAIN_APPEAL_INTEGRATION.md`。
- Nuxt `ADM-PRI-01/02` 数据权利队列与详情已从 Privacy-1 控制面扩展到 Privacy-2A/2B：Owner 开始/重试导出时原子建立制品任务并派发 Queue，详情显示导出 profile、分类/分片、manifest 与到期事实；注销 executor 区显示 profile 门禁、九步检查点、七类保留隔离和 tombstone 证据。导出 ready 与注销 completed 均只能由执行器核验事实推进，没有人工“完成”按钮。Operations-1 保留逾期申请聚合检测；Recommendation-6 不新增后台状态，只扩充第四步的服务端残留计数。所有环境继续默认关闭，`0094/0102/0103/0114` 均未执行；完整边界见 Privacy-1、`docs/app/PRIVACY_2A_PRIVATE_EXPORT_INTEGRATION.md`、`docs/app/PRIVACY_2B_IRREVERSIBLE_DELETION_INTEGRATION.md` 与 `docs/app/RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md`。
- 已完成 Membership-1 跨仓开发闭环：`0071_app_membership_catalog_and_grants.sql` 建立版本化五级目录、typed entitlement、不可变 App grant、追加式撤销和管理员幂等请求；开发目录包含心遇、心悦、心知、心契、心耀及 `rank=10/20/30/40/50`，七项权益全部标记为 `planned`，不产生消息、筛选、历史或收藏夹的可执行权限。
- App API v2 `1.4.0` 已新增公共 `/membership/catalog` 和本人 `/me/entitlements`；本人等级只解析 App grant，不把旧 Web `vip/svip` 隐式映射。production/dev 的目录和后台开关均保持关闭，production 还必须同时满足运行时放行与目录 `published + production_ready` 双门禁。
- Membership-7 以兼容新增方式把累计契约提升到 `1.26.0`：本人快照新增 `lifecycle`，精确区分有效、即将到期、自然到期和撤销；已结束 grant 只进入历史呈现字段，顶层 `tier/grant` 与 entitlement 授权语义不变。KMP 已映射 `APP-MBR-02` 的五个正式节点，并只允许旧于 `1.26.0` 的兼容响应缺省该字段，当前或未来契约缺失/矛盾时安全拒绝；可选到期窗口 Binding 只完成源码解析，Wrangler 配置、构建、测试和设备验收继续后置。详见 `docs/app/MEMBERSHIP_7_LIFECYCLE_PRESENTATION_INTEGRATION.md`。
- Nuxt 用户工作台已加入独立 App 会员面板，并新增客户设计路由 `/admin/app/membership/grants/new`：支持搜索并确认账号、配置五级稳定 tier、立即/预约发放、同级续期、权益 availability、变更预览、策略风险说明、幂等复核申请、grant 时间线和追加式撤销，与旧 Web 会员明确隔离；会员申请队列可直接进入该工作台。KMP “我的”页已接入独立五级会员页，支持公开目录、本人权威快照、规划中标签及明确的平台运营/无支付边界；站内申请由 Membership-2 独立能力控制。
- Membership-1 既有测试覆盖五级目录完整性、无 legacy 自动映射、预览/发放/续期、幂等与业务单冲突、审计隐私、最高有效 rank、到期、追加式撤销、production 双门禁和 KMP 非法响应安全拒绝；全新本地 D1 已连续应用 `0001–0071`，Android API 36.1 模拟器已完成公共目录、五级切换、长列表和服务边界验收。dev 已随连续升级应用 `0071` schema，但目录与后台开关仍关闭且没有真实 grant。旧会员显式迁移代码已由 Membership-5 提供、会员批量编排后端已由 Membership-6 提供，二者 migration、配置与新增验证均尚未执行；Message-1 的新话题日额度原子消耗已独立实现。完整边界见 `docs/app/MEMBERSHIP_1_CROSS_REPO_INTEGRATION.md`、`docs/app/MEMBERSHIP_5_LEGACY_MIGRATION_INTEGRATION.md` 与 `docs/app/MEMBERSHIP_6_BATCH_GRANTS_INTEGRATION.md`。
- 已完成 Membership-2 站内会员申请代码闭环：`0075_app_membership_applications.sql` 新增申请、用户可见事件和幂等请求表；同一账号只允许一条进行中申请，联系方式只引用已验证邮箱，申请说明不进入分析或通用审计。App API v2 `1.8.0` 支持本人提交、列表、详情、待补充后重新入队和取消，申请期间 rank、grant 与 entitlement 保持不变。
- Nuxt 新增 `/admin/app/membership/applications` 队列与详情工作台，支持筛选、领取、要求补充、拒绝、过期、平台取消和正式发放。批准路径使用独占发放锁与 Membership-1 幂等 grant；只有 grant 成功并关联后用户才看到“已发放”，重复响应恢复不会产生第二个 grant。
- KMP 新增独立申请页，覆盖五级选择、已验证邮箱说明、联系偏好、300 字最小化说明、当前披露确认、取消二次确认、状态事实和时间线；capability、策略或响应矛盾时只关闭申请，不影响公开目录。服务端 D1 与 App API 定向测试 18 项、客户端 Host Test 已通过。production/dev 的 `APP_MEMBERSHIP_APPLICATIONS_ENABLED` 均保持 `false`，尚未执行 `0075` dev/production migration、远程联调或真机 UI 验收；OQ-010/OQ-020 未关闭前不承诺 SLA、不创建自动清理、不保存真实申请。完整边界见 `docs/app/MEMBERSHIP_2_APPLICATION_INTEGRATION.md`。
- 已完成 Membership-3 管理员会员变更独立复核开发闭环：`0088_app_membership_change_reviews.sql` 建立空的版本化风险策略、发放/续期/撤销申请、不可变事件和幂等复核决定；不 seed 策略，缺少正式策略时服务端保守要求全部复核。`/admin/app/membership/reviews` 与逐单详情覆盖脱敏队列、受控内部依据、基线/当前权益对比、自审冲突、批准、拒绝和账号变化失效。
- 用户会员申请的“批准”现在只锁定申请并提交发放复核，另一位管理员批准时才在同一 D1 条件批次内写正式 grant、复核终态、申请 `approved`、用户可见事件和审计；当前会员、账号或业务单号变化会使旧申请进入 `stale` 且不产生权限。`0088` migration、真实风险策略、环境配置和专项测试按当前顺序统一后置；完整边界见 `docs/app/MEMBERSHIP_3_CHANGE_REVIEW_INTEGRATION.md`。
- 已完成 Membership-4 会员目录与 Entitlement 管理开发闭环：`0089_app_membership_catalog_management.sql` 为既有目录补齐基线、乐观锁、命令幂等、固化内容哈希、发布申请、不可变事件和 Owner 独立决定；运行引用、已发布、待复核以及被 grant、申请或后继版本引用的目录均不可原地编辑。
- Nuxt 已交付 `ADM-MBR-01/02`：目录完整复制、设置与五级原子编辑、Schema/安全默认值/客户端 capability 校验、基线比较、服务与 grant 影响查询、发布申请和独立复核。批准只形成不可变版本，不切换 Wrangler 目录、不迁移 grant、不开放 capability；`0089`、真实五级数值、生产决策、环境配置和专项测试继续后置。完整边界见 `docs/app/MEMBERSHIP_4_CATALOG_MANAGEMENT_INTEGRATION.md`。
- 已完成 Audit-1 App 审计查询与完整性开发闭环：`0090_app_audit_query_and_integrity.sql` 保留 `admin_audit_logs` 唯一事实源，为全部既有/新增事实自动建立稳定 sequence，增加追加式 request/trace/业务引用、版本化 Action 登记、不可变检查清单，并在 D1 层禁止历史事件、索引、上下文和清单修改或删除。
- Nuxt 已交付 `ADM-AUD-01/02/03`：31 天受限范围与稳定游标查询、admin 本人/Owner 跨域权限、读取用途审计、字段级脱敏详情、目标/request/trace/业务单关联时间线，以及 Owner 序号/索引/载荷/敏感键/Action/同范围摘要检查；完整性服务还会反向核对会员发放、钱包入账、运营回复和人物发布四类关键业务事实，不自动补写缺失审计。Audit-3 已补齐 Action 口径治理代码，`0090/0093` 执行、正式治理策略/Action、保留期、自动运行、配置和专项测试继续后置。完整边界见 `docs/app/AUDIT_1_QUERY_AND_INTEGRITY_INTEGRATION.md`。
- 已完成 Audit-2 `ADM-AUD-04` 受控导出开发闭环：`0091_app_audit_controlled_exports.sql` 定义不可变申请/复核/时间线、强认证摘要、一次性票据和命令幂等；admin 只能申请本人范围，Owner 可申请跨域但只能由不同 Owner 复核。复核、生成终态和发票前均重算或核对当前角色与 Audit-1 精确范围，变化即失效；CSV 逐行水印、字段级脱敏并防公式注入，只写私有 R2 固定 key，API 不返回对象地址。原申请人重新验证密码后取得五分钟一次性票据，由 Worker 代理 no-store 下载；Web 同源代理已显式放行幂等、强认证和下载票据 header，同时保留 `nosniff`。当前 24 小时逻辑有效期不代表正式保留政策；`0091`、真实对象、配置、物理清理和专项测试统一后置。完整边界见 `docs/app/AUDIT_2_CONTROLLED_EXPORT_INTEGRATION.md`。
- 已完成 Operations-1 `ADM-OV-01/02/03` 运营总览、事件中心与处置详情开发闭环：`0092_app_operations_and_incidents.sql` 定义 18 项版本化指标、不可变快照、7 份 Runbook、检测运行、事件状态机、5 个跨域安全控制和命令幂等；总览坚持未知/延迟/未配置不显示为 0，且不包含未来支付、礼物、装扮、系统推送或真人认领指标。人物发布、推荐投放、运营消息、会员发放和金币调整已在服务入口与最终 SQL 两次重验控制；暂停仅限未关闭 P0/P1，恢复必须由原事件提供证据。普通 admin 领取后处置本人事件，Owner 可跨事件并独占快照、检测及控制。完整基线见 `docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md`。
- 已完成 Operations-2 会员到期权限完整性检测增量：`operations-detectors-v2` 以新话题额度事实和观看者消息发生时刻反向核对有效 grant 与 `direct_message.send`，只在自然到期后仍产生受限事实且当时没有替代有效授权时生成聚合 `membership_expiry_not_revoked / membership / P1` Incident；正常到期无需补造 revocation。`0106_app_operations_membership_expiry_detector.sql` 只增加观看者消息局部覆盖索引，不写业务数据；页面继续复用 Figma `ADM-OV-01/02/03`，不增加 408 状态。Operations-2 的“平台健康未接入”属于当时阶段快照，已由 Operations-3 续接。完整边界见 `docs/app/OPERATIONS_2_MEMBERSHIP_EXPIRY_INTEGRITY.md`。
- 已完成 Operations-3 Cloudflare 官方平台状态检测：`operations-detectors-v3` 在 10 类 D1 检测之外并行读取无需鉴权的 Status API Summary，只匹配 9 个当前相关正式组件；相关异常映射到既有 `platform_health_anomaly`，无关产品/地区事件不触发，来源超时、非 2xx、超限或畸形时仅令运行 `partial / unavailableDetectorCount=1`，不制造事故。`0108` 追加第八份不可变 Runbook，不新增 secret、binding、Page ID 或 Figma 状态，总量保持 99/408、Mobile 50/208；公共状态不替代账户级 Worker/D1/R2 指标。在 Operations-3 阶段这三项继续 `unconfigured`，该历史缺口现已由下一条 Operations-4 补齐采集器。`0092/0106/0108` 执行、调度、构建、专项测试和环境异常演练统一后置。完整边界见 `docs/app/OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md`。
- 已完成 Operations-4 Cloudflare 账户级可观测指标采集器：`operations-metrics-v2` 在 Owner 人工刷新时以一次 5 秒、1 MB 上限的 GraphQL 请求读取指定 Workers 最近 5 分钟错误率、D1 当日 UTC `queryBatchTimeMsP95` 与指定 R2 最近 5 分钟内部错误率；未配置、空样本、HTTP/GraphQL 失败与非法载荷均显式保留非 `known` 状态，不把缺失当 0，R2 `userError` 不冒充平台故障。采集器只写既有 18 项不可变快照，不新增 migration、Page ID 或 Figma 状态；Operations-3 中“三项继续 unconfigured”是其阶段快照。最小只读 Account Analytics Token、精确资源、GraphQL introspection、构建、测试和环境验证统一后置。完整边界见 `docs/app/OPERATIONS_4_CLOUDFLARE_ANALYTICS_INTEGRATION.md`。
- 已完成 Message-5 数据权利结果通知 Cloud 端接线：`0109_app_data_rights_notifications.sql` 激活 Message-3 既有 `data.export_ready` 与 `account.deletion_updated` 定义并增加固定 development 模板；私有导出只在 ready 权威事实原子完成后写 Outbox，注销只在已验证取消并恢复账号访问后写通知，pending/processing/failed/completed 继续受 `0103` 抑制。通知目标现在重验数据权利 capability 与申请归属，KMP 复用已有 `open_data_task` 跳转；不新增 DTO、Page ID 或 Figma 状态，总量保持 99/408、Mobile 50/208。`0109`、模板审批、配置、构建、测试与设备 QA 后置。完整边界见 `docs/app/MESSAGE_5_DATA_RIGHTS_NOTIFICATION_INTEGRATION.md`。
- 已完成 Message-6 通知偏好策略换绑修复：账号唯一偏好不再因 `APP_NOTIFICATIONS_POLICY_VERSION` 切换而永久停留在旧 `policy_id`。服务端在当前策略通过既有门禁后保留消息/互动/营销选择，以旧策略和版本做条件换绑、单调提升版本，并为缺失的旧基线及新策略生效追加不可变偏好事件；并发请求复用已完成结果或可重试失败，绝不重置用户选择。无 migration、公共 DTO、KMP、Page ID 或 Figma 状态增量，总量保持 99/408、Mobile 50/208；已增加定向 D1 用例但按当前顺序未运行，构建与环境验证后置。完整边界见 `docs/app/MESSAGE_6_NOTIFICATION_POLICY_REBIND_INTEGRATION.md`。
- 已完成 Message-7 数据导出失败必要通知：Privacy-2A 的失败批次现按申请、制品、任务、用户事件顺序在同一 D1 batch 收敛，事件写入再次核验三者版本、mutation token 和 failure code；`0110_app_data_export_failure_notifications.sql` 新增 `data.export_failed` 必要定义、固定 development 模板和严格 Outbox trigger。通知不携带内部错误、R2 引用或导出内容，复用 `data_task + open_data_task` 与 `APP-SET-09` 失败态；无公共 DTO、KMP、Page ID 或 Figma 状态增量，总量保持 99/408、Mobile 50/208。定向 D1 用例已编写但未运行，`0110`、模板审批、配置、构建、测试与设备 QA 后置。完整边界见 `docs/app/MESSAGE_7_DATA_EXPORT_FAILURE_NOTIFICATION_INTEGRATION.md`。
- 已完成 Message-8 文本消息审核后端闭环：`0112_app_message_moderation.sql` 新增默认关闭的版本化策略、空规则集、无正文评估事实、10 分钟人工复核租约、作者隔离、追加事件和幂等裁决；观看者与运营发送共用既有 `accepted/review_pending/rejected` DTO。待审/拒绝只保留内部 sequence，不污染正常工作台、业务活跃时间、未读、质检、队列或自动分配；人工通过时重排到当前末尾，避免迟到交付落在接收方已读/分页水位之前。观看者/运营摘要使用各自可见投影，本人导出不泄露未交付运营正文；裁决重放可恢复幂等派单/实时刷新。Privacy-2B 会在关闭账号话题前把未完成案件系统取消、清租约和命令重放但保留合规证据。审核结果、待审运营回复通过及管理员限制与后续关闭接入 Message-3 安全摘要 Outbox；正文只在领取后按 `message_moderation_review` 读取并审计。没有正式后台审核页面与召回 Figma 动作，因此不新增 Nuxt/KMP UI，OQ-021/OQ-033 继续未关闭；总量保持 99/408、Mobile 50/208、Admin 49/200。`0112`、真实规则/策略、配置、构建与 D1 用例执行统一后置。详见 `docs/app/MESSAGE_8_TEXT_MODERATION_INTEGRATION.md`。
- 已完成 Message-9 站内通知内容生命周期后端增量：批准策略下的新投递按原始事件时间写入不可变 `expires_at`，已经晚于窗口的延迟 Outbox 只收敛为 `suppressed`；每日维护只认环境显式策略 ID、approved 保留天数和 `purge_enabled=1`，按 explicit/legacy 稳定顺序有界删除通知正文及单条已读事件，能力或 generation 关闭后仍履约，并保留不含正文的 Outbox 去重墓碑。`0115_app_notification_content_lifecycle.sql` 只增加索引与时间/不可变约束，不回填、不删除、不配置策略。无 API、KMP、Nuxt、Page ID 或 Figma 增量，总量保持 99/408、Mobile 50/208、Admin 49/200；测试源码已编写但未运行，OQ-020、`0115` 执行、配置、构建和专项验证统一后置。详见 `docs/app/MESSAGE_9_NOTIFICATION_CONTENT_LIFECYCLE_INTEGRATION.md`。
- 已完成 Audit-3 Action 口径治理开发闭环：`0093_app_audit_action_registry_governance.sql` 新增不可变 retention/quality 治理策略目录、生产可见 Registry、发布/退休申请、独立复核、事件和命令幂等；不 seed 策略或自动登记 Action。Owner 工作区可从真实 `admin_audit_logs.action` 发现未登记/冲突口径，预览历史影响并追加版本；申请人不得自审，批准前及最终 SQL 都会重验最新版本、观察摘要和两类策略就绪状态，变化即进入 `stale`。Audit-1 查询、详情、关联时间线与 Audit-2 导出已统一使用生产 Registry：普通 admin 只看本人且 `visibleRoles` 允许的 production-ready Action，Owner 保留治理缺口可见性。`0093`、真实治理策略/Action、配置和专项测试统一后置。完整边界见 `docs/app/AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md`。
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
- 已完成 Message-3 站内通知与可靠到达代码闭环：`0076_app_in_app_notifications.sql` 建立默认关闭的策略、事件定义、固定安全模板、账号偏好、可恢复 Outbox、通知投影和已读审计；不包含 seed、历史回填或系统推送。其当时没有自动清理的阶段缺口现已由默认关闭的 Message-9 源码补齐。
- App API v2 `1.9.0` 新增五类通知列表、安全详情、服务端未读数、单条/分类已读和版本化偏好。业务 trigger 只在 D1 策略开启时原子写 Outbox，消费者支持稳定通知 ID、偏好抑制、处理租约、指数退避和 dead letter；受控目标在每次响应时重验账号归属、对象状态与 capability。
- Nuxt 新增 `/admin/app/notifications` 只读运行台，展示运行时/D1 双门禁、事件、模板和投递状态，不返回平台话题正文、申请说明、安全证据、内部备注或 Token。KMP “消息”页新增平台话题/站内通知切换、五类列表、详情、未读、分类全部已读和通知偏好；Message-3 的历史交付只使用 HTTP 手动拉取，不申请系统通知权限。
- Message-3 D1 定向测试覆盖默认关闭、Outbox 投影、固定安全文案、可选抑制/必要通知、未读与原子已读审计、目标失效和游标隔离；API/Web 全量测试、TypeScript/Nuxt 类型检查、Android Host Test/Debug APK 与 iOS Simulator Kotlin/Native 编译通过。本机 iOS Framework 链接仍被未接受的 Xcode 许可拦截，继续由 macOS CI 执行正式门禁。
- production/dev 的四个通知开关保持关闭，`0076/0097/0115` 尚未统一执行，也没有真实通知数据。OQ-020 未关闭，开发策略 `generation_enabled=0`、`retention_days=NULL`、`purge_enabled=0`；完整边界见 `docs/app/MESSAGE_3_NOTIFICATION_INTEGRATION.md` 与 `docs/app/MESSAGE_9_NOTIFICATION_CONTENT_LIFECYCLE_INTEGRATION.md`。
- 已完成 Message-4 账号级实时刷新跨仓源码：App API v2 `1.25.0` 新增严格 bootstrap capability、一次性短票据和 WebSocket Upgrade；`AppRealtimeHub` 使用 Hibernation WebSocket 与有限 SQLite 游标事件，只发送 `account|conversations|messages|notifications|membership|wallet` 刷新范围，不发送业务正文、账号资料、内部 ID、管理员信息或 Token。
- `0105_app_realtime_refresh_channel.sql` 新增默认关闭的版本化策略和 SHA-256 短票据表；development seed 固定 `unresolved + disabled + production_ready=0`。退出、设备撤销、Refresh Token 重放和注销申请会取消未消费票据并关闭对应连接；Privacy-2B 不可逆执行进一步清理全部账号票据元数据。D1/HTTP 始终是业务与权限权威。
- KMP 已接入 Ktor WebSocket、严格帧解析、进程内账号游标、有界指数退避、Android/iOS 前后台停连和当前可见页面 HTTP 补拉；断线复用 Figma `APP-MSG-05` 已有“实时离线”状态，没有新增页面或视觉状态。
- OQ-028、Durable Object binding/SQLite migration tag、运行时配置、`0105` 执行、Cloud/KMP 构建测试与设备 QA 全部后置；现有环境继续返回 `realtime=false`。完整边界见 `docs/app/MESSAGE_4_REALTIME_REFRESH_INTEGRATION.md`。
- 已完成 Wallet-1 默认关闭的跨仓代码闭环：`0077_app_wallet_ledger.sql` 建立 development 策略、钱包快照、管理员调币申请、不可变分录、申请事件和独立复核记录；migration 不创建账号钱包、不导入旧余额、不写业务调币数据，也不开放批量或迁移入口。
- App API v2 `1.10.0` 新增本人余额、方向筛选的游标明细和分录安全详情；空钱包只返回虚拟零余额，不因读取创建数据库记录。分录只展示固定原因、用户安全业务单号、前后余额和完整冲正关系，不返回内部备注或管理员身份。
- Nuxt 新增 `/admin/app/wallets` 单笔调币工作台，支持账号确认、加币/扣币/补偿/完整冲正预览、幂等申请、另一管理员批准或拒绝。OQ-018 未关闭前所有申请强制独立复核、发起人不能自批、余额变化必须由新分录驱动，任何扣币均不得形成负余额。
- KMP “我的”页新增只读金币入口、余额卡、全部/增加/扣减筛选、明细分页与冲正详情；capability、策略或稳定枚举矛盾时安全关闭。客户端没有充值、支付、消费、礼物、装扮购买、转赠、兑换、转账、提现或申诉动作。
- Wallet-1 D1 定向测试已覆盖默认关闭、虚拟零钱包、负余额拒绝、独立复核、请求幂等、旧预览冲突、完整冲正、分录不可变、账号/游标隔离和必要通知目标。当前阶段 API 125 个测试文件/989 项、脚本 64 项、ESLint、API TypeScript、Nuxt production build 与本地空库 `0001`～`0077` 全量 migration 均通过；既有 Web 60 个文件/301 项、KMP Android Host Test/Debug APK 与 iOS Simulator Kotlin/Native 编译保持通过记录。本机 Framework 链接仍因未接受 Xcode 许可被 `xcrun` 69 拦截，继续由 macOS CI 执行正式门禁。production/dev 的四个钱包开关保持关闭，`0077` 尚未执行远端 migration，也没有真实余额或调币记录；完整边界见 `docs/app/WALLET_1_LEDGER_INTEGRATION.md`。
- 已完成 Wallet-1 dev 迁移准备工具与部署门禁：生成仓库外 SQL、SHA-256、Time Travel bookmark 和 30 分钟 manifest，并绑定 `dev` commit、独立 D1、关闭开关和严格 `0075`→`0076`→`0077` 队列。`deploy.sh` 在 `0077` 待执行时无条件阻断 production；dev 必须显式放行并复验 manifest，迁移和 Worker 完成后自动执行只读 schema/策略/空账本验收。
- 已完成 Wallet-1 一次性 D1 + 临时 Worker 功能 smoke：机器 gate、短期授权、明确数据位置、`HEAD==origin/dev` 和显式确认全部为硬前置；临时 Worker 只绑定当次 D1，不含共享 route、R2、Queue、Email 或 secret。自动验收覆盖 16 类真实 HTTP/D1 场景，成功或失败均先删 Worker、再删 D1，只在仓库外保存聚合证据；销毁失败有严格、幂等的恢复 manifest。实现过程中修正 Wallet 管理查询把真实 `app_account_security.account_id` 误写成测试专用 `user_id` 的空库联调缺陷，并让测试 fixture 与 `0069` migration 对齐。
- 2026-08-09 补齐一次性 smoke 的局部决策与证据生命周期：推荐全部独立复核、禁止负余额/批量、固定 30 天聚合证据和 `location=apac`，同时明确不关闭全局 production OQ。恢复销毁成功后生成最小证据并删除运行目录；显式清理器只删除到期且格式严格匹配的 evidence JSON。局部决策仍待项目 Owner 确认，Gate 保持关闭。
- 2026-08-08 只读远端检查确认 dev 当前待执行 migration 恰为 `0075`～`0077`；实际一次性 gate 仍为 `remoteSmokeAuthorized=false`，未创建远程 D1/Worker，未执行共享 dev migration 或任何远端写入。下一步先确认合成 smoke 局部决策，再分别取得短期 Gate 与当次执行批准；通过也不关闭全局 OQ 或自动放行共享 dev。操作边界见 `docs/app/WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md`、`docs/app/WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md` 与 `docs/app/WALLET_1_DEV_VALIDATION_RUNBOOK.md`。
- 已完成移动端 50 页和管理后台 49 页的页面级产品设计。
- Figma 最终文件当前已完成移动端 50 页/208 状态、管理后台 49 页/200 状态，共 99 个 Page ID/408 个正式状态；`30｜Prototype Flows` 覆盖 99 个流程预览。
- 3,571 个正式页面与流程交互源是 `APP-SET-08` 增量六态前的历史基线，当时缺失目标为 0；当前动作总数与全量 408 状态 QA 统计留到全部开发完成后统一重算。移动端另有 14 个交互支持 Section、171 张 393 × 852 支持稿。原先游离在 Page 顶层的 49 张发现支持稿已归回既有 Section，8 张收藏夹支持稿已归档到新 Section `1078:3614`，并新增重命名失败节点 `1088:3705`；页面顶层 APP 游离稿为 0。数据权利支持稿 5 张分别覆盖创建导出、注销、导出取消 `1059:3643`、注销取消 `1099:3614` 与 Privacy-1 下载能力未开放态。原 402 个正式状态的全量设计 QA 中，移动端断链、缺失字体、未绑定 Text Style、横向/裁切文字溢出和不足 44dp 的点击热区均为 0；新增六态已完成 393 × 852 定向检查，后台 49 页/200 状态的既有 QA 结论不变。
- Nuxt 管理后台 49 个 Page ID/200 个状态已与实时 Figma 以 `pageId|stateName|nodeId` 生成稳定签名，设计与代码签名均为 `a89d0c59`。41 个实际 Vue 页面壳（动态路由覆盖 49 个 Page ID）全部显式传入正式 `figma-state`；`AdminAppPageHeader` 已改为严格解析，拼写错误、跨页状态或遗漏映射会直接失败，不再静默回退“正常”主稿。Page ID、设计路由、Figma Node ID 与状态 key 仅以不可见 DOM 属性保留给实现和测试追踪，公共页头不再把 `ADM-* · /admin/...` 渲染成管理员可见文案。
- 管理后台注册 Page ID 与实际 Vue/动态路由声明已做静态覆盖求差，覆盖结果 49/49、缺失 0；41/41 个页面壳缺失 `figma-state` 为 0。当前只完成开发与静态门禁，不提前执行 Nuxt 构建、浏览器视觉回归或生产配置。
- 已将 Figma 固化为全部用户可见页面与状态的开发前置门禁：新增路由或新状态必须先取得唯一 Page ID、正式 Frame、Prototype Flow、Delivery Index 和 QA 证据，再进入 KMP 或 Nuxt 实现；不得以代码页面、临时截图或文字说明替代 Figma。上述 Page ID、设计路由、Node ID 和状态 key 是交付标注而非产品 UI，生成器已把 99 页验收统一改为“真实 UI 不渲染交付标注”。
- `APP-AUTH-01` 五个状态已重新逐节点审计：修正“继续进入”误跳登录的问题，并补齐已有账号、取消恢复、离线重试、升级、维护和帮助入口；移动端页面动作由 492 增至 497。KMP 已使用 Figma 原始授权图片和精确图标完成启动页五态接线，Gradle、模拟器与截图验收按当前开发顺序后置。
- `APP-AUTH-04` 已在 Figma 删除手机号、短信验证码和“确认本人”旧流程，重构为 Cloudflare Turnstile 等待、失败、次数限制三态；移动端页面动作由 497 增至 500，全部目标有效。KMP 已同步 Figma 原生外壳、失败重载、频控禁用和 Android/iOS 受信任 WebView 导航；三张需求图已直接替换为对应 Figma 状态导出。
- `APP-AUTH-06` 已在 Figma 将服务条款、隐私政策、平台运营说明、必要资格说明统一为同页四文档切换，正式稿覆盖正常、加载失败和版本更新；支持 Section `556:1825` 现含 9 张切换稿和 4 张加载中稿。多入口主按钮已从写死“返回登录”改为“返回原页面”与真实 `BACK`。KMP 已按这些 Node ID 新增原生外壳和 Android/iOS 受控正文视图，正文未完整加载时不使用设计示例、缓存片段或旧版内容替代；该支持稿单独统计，不增加正式 Page ID 或需求状态。
- `APP-DSC-01` 已按 Figma 完成正常、首次空、骨架、分页、离线缓存和规则刷新六态，补齐推荐/地区/热门/最新频道、喜欢切换、分页失败与无缓存失败等交互；正式稿 67 个动作和支持 Section `581:2` 的 11 张稿/75 个动作均无失效目标或不足 44dp 热区。KMP 已同步顶部入口、频道、横向真人卡、双列卡片、喜欢乐观更新、离线缓存、规则刷新和分页反馈。
- `APP-DSC-02` 已按 Figma 完成 460dp 地区底部弹层、8 个 44dp 选项热区、遮罩/关闭/应用动作，以及定位未使用、目录更新、无结果四态；支持 Section `603:2326` 的 6 张选中稿/60 个动作已修正范围与城市联动，无结果提示卡与弹层保持 24dp 间距。KMP 只使用服务端返回的稳定地区 code，展示名称不参与查询或授权。
- `APP-DSC-03` 已按 Figma 完成正常、空分类、目录失效三态，以及加载中、加载失败和目录变化说明支持稿；KMP 通过统一 Taxonomy stable ID 与目录版本驱动分类入口，不按展示名推断已合并或下线分类。
- `APP-DSC-04` 已按 Figma 完成初始、输入中、有结果、无结果、历史关闭五态和 12 张搜索/分页/历史支持稿；KMP 已覆盖过期响应隔离、账号私有历史、逐条删除、三路径清空和平台认证规则。
- `APP-DSC-05` 已按 Figma 完成正常、权益门槛、目录冲突、无结果四态和 9 张目录加载、结果预估、清空、应用、保存支持稿；正式稿 67 个动作、支持稿 48 个动作均无失效目标或不足 44dp 热区。KMP 已接入 11 类稳定目录、400ms 权威预估、服务端权益门槛、目录重载保留 stable ID、0 结果、空条件应用及保存命名/保存中/失败状态。
- `APP-DSC-06` 已按 Figma 完成正常、空、额度满、标签已合并四态和 15 张加载、使用前复核、会员降级、条件失效、编辑、更新、删除及版本冲突支持稿；正式稿 44 个动作、支持稿 47 个动作均无失效目标、不足 44dp 热区、缺失字体或文字溢出。KMP 已接入账号私有保存条件、使用前权威复核、默认排序、完整编辑、删除二次确认、失败保留和乐观版本冲突，不保存自由搜索词或旧结果数。
- `APP-DSC-07` 已按 Figma 完成正常、下架、受限、离线摘要、媒体不可用五态和 25 张资料加载、单向互动、分享、平台披露、举报、屏蔽、离线限制及媒体重试支持稿；正式稿 33 个动作、支持稿 144 个动作均无失效目标、不足 44dp 热区、缺失字体或文字溢出。KMP 已按对应 Figma 节点接入真人资料、真实互动状态、媒体状态、运营接收说明、举报与屏蔽闭环；分享因服务端尚无权威公开 URL 而明确显示不可用，不伪造链接。
- `APP-DSC-08` 已按 Figma 完成正常、访问凭证刷新、图片加载失败、内容隐藏四态和 19 张首载、空态、缩放、翻页/分页、访问门槛、媒体说明、举报及失效支持稿；正式稿 14 个动作、支持稿 69 个动作均无失效目标、不足 44dp 热区、缺失字体或文字溢出。KMP 已按对应 Figma 节点接入全屏媒体、内存缩放、翻页/分页、短期凭证重核验、登录/会员门槛、单图与人物失效、媒体说明和举报闭环；分页失败保留当前图片，不持久化受保护媒体 URL 或字节。
- `APP-DSC-09` 已按 Figma 完成正常、认证失效、资料变化三态和 13 张首载/失败、规则、举报、刷新支持稿；正式稿 12 个动作、支持稿 50 个动作均无失效目标、不足 44dp 热区、缺失字体、边界溢出或文字截断。KMP 已接入 `FigmaPersonVerificationScreen`、四项核验、平台运营边界、会话内 `profileVersion` 变化检测、刷新/失败、认证失效安全收敛和 `SafetyReportTarget.PersonProfile` 举报闭环；认证说明不持久化，也不展示证据、审核员或内部撤回原因。
- `APP-INT-01` 已按 Figma 完成 4 张正式稿和 15 张支持稿，覆盖关注更新、全部/有更新/最近关注筛选、分页、服务端取消关注及游标整表刷新；KMP 已移除旧“喜欢”顶部分段。
- `APP-INT-02` 已按 Figma 完成 3 张正式稿和 16 张支持稿，覆盖账号私有搜索、地区/风格筛选、分页、服务端确认取消喜欢及游标整表刷新；19 张画板共 220 个动作全部可达，关键热区、文字、Icon、间距、对齐与溢出审计均通过。
- `APP-SET-01｜我的｜正常` 已新增正式“我的喜欢”入口 `852:3613` 并导航至 `APP-INT-02｜喜欢｜正常` `159:66943`；入口复用现有设置行、颜色变量、Noto Sans SC 样式与心形矢量，文字、Icon、边界、分组间距和底部导航避让审计问题数为 0。该批次完成时移动端正式稿为 4,327 个文字节点、745 个页面动作；随后仅按 202 张正式画板内部节点统计得到 4,552 个文字节点、914 个页面动作，该数据是 `APP-SET-08` 增量前的历史基线，不代表当前 208 状态总量。
- `ADM-PRI-01/02` 数据权利队列与处置页已进入 Figma 正式 Admin Pages：共 13 个需求状态、125 个页面动作和 17 个流程动作，覆盖加载、失败、空态、逾期、未领取、Privacy-1/2 门禁、操作失败与终态只读；页面、流程、交付索引和 QA 均已补齐。
- Figma 最终版本 ID 为 `2381987656588552168`；`40｜Delivery Index` 与 `50｜QA & Handoff` 已完成，最终事实源为 `docs/app/figma-final-delivery-state.json`。
- 已按客户确认的原始暖粉视觉方向完成同视口对照，并修正文字排版、Icon 对齐、后台头部按钮重叠、会员选中卡对比度、运营总览 KPI 与表格溢出。
- 客户文档下一次生成的映射基线包含 99 张默认状态、57 张 P0 关键状态和通知/金币 23 张逐状态导出图，共 179 个 Page ID/状态/图片确定性映射；Figma 的 408 个正式状态是像素级视觉与交互权威来源。客户 DOCX 按开发顺序留到全部开发完成后统一重新生成。
- 已同步 `docs/app/MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md`，作为研发、测试与验收的 App 1.0 唯一开发需求基线；文档覆盖当前范围、未来兼容方向、非功能要求、技术基线、99 页逐页规格、408 个 Figma 状态、179 个客户文档图片映射、Operations-1 实现状态、需求追踪、DoR 与 DoD。
- 已生成 `docs/app/APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md`，逐页覆盖角色、前置、入口、结构、交互、业务规则、数据权限、状态和验收。
- 现有客户产品需求确认书和逐页交互设计确认册是上一轮交付快照；当前 MD、manifest 与 Figma 已更新为 99 页/408 状态/179 个映射。两份 DOCX 将按“全部开发完成后统一处理”的顺序重新生成并做同页映射复核，现阶段不作为开发需求源。
- 已新增需求冻结准备清单与 15 页客户短版确认单，集中列出 8 项客户决策和 7 组专业门禁，并明确“功能交互冻结”与“像素级视觉冻结”必须分别记录；整体仍是冻结准备中，当前完成的 M0、M1、Auth-1、Interaction-1/2/3、Membership-1/2/3/4、Message-1/2/3、Safety-2、Wallet-1 与 Audit-1/2/3 均只是 production 默认关闭或未配置的分阶段开发验证，dev 联调或服务端代码存在不等于授权生产发布。
- Figma Phase 0 审计、Phase 1 Design System、Phase 2 文件结构、最终页面/流程/QA 的完成记录分别见 `FIGMA_FINAL_DELIVERY_AUDIT_AND_PLAN.md`、`FIGMA_DESIGN_SYSTEM_PHASE1.md` 和 `FIGMA_FILE_STRUCTURE_PHASE2.md`。
- 最终 MD 已同步 99 个 Page ID、408 个 Figma 最终状态、179 个客户文档原型映射、41 个 App 1.0 产品需求编号和 99 个逐页追踪键；3,571 个有效交互动作只保留为 `APP-SET-08` 增量前历史基线，当前总数在全部开发完成后统一重算。两份客户 DOCX 的新口径将在文档交付阶段统一重新生成并复核。
- 三份客户 DOCX 已通过压缩包完整性、图片替代文本、表格表头、无障碍审计和中文字体环境下的全页渲染目检；LibreOffice 基准渲染分别为 197 页、165 页和 15 页，未发现异常空白页、图片缺失、内容错位、溢出或裁切。
- 逐页原型清单、SHA-256、15 组功能联系表规划和设计 QA 证据位于 `docs/app/assets/page-prototypes/` 与 `docs/app/interactive-prototype/design-qa.md`；联系表与 DOCX 的最终重生成仍按约定后置。
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
- Cloudflare Stream 仍待配置；ZIP 导入源码已完成，待统一执行 migration、Queue 配置、构建、测试和环境 QA 后启用。

## 文档入口

- `AGENTS.md`：开发和分支规范。
- `docs/TECHNICAL_SPEC.md`：API、Schema、权限和安全契约。
- `docs/AD_PLATFORM_ARCHITECTURE.md`：归因架构。
- `docs/DEPLOYMENT.md`：Cloudflare 资源和发布流程。
- `docs/GIT_WORKFLOW.md`：分支、PR、tag 和 commit。
- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`：数据分析口径。
- `docs/TELEGRAM_IMPORT_API.md`：外部导入 API。
- `docs/SEO_CONFIGURATION.md`：SEO 配置。
