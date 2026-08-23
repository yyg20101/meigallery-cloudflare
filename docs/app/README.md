# 独立 App 与共享业务平台文档总览

更新时间：2026-08-23

App 版本：1.0

状态：需求讨论中

文档版本与 App 版本一致。需求讨论期间直接修订当前文档，不因每次讨论递增版本；变更历史由 Git 记录。

## 开发交付

- [App 1.0 开发需求规格（Markdown）](./MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md)：研发、测试、接口设计和任务拆分的单一入口，完整包含产品/发布需求、技术边界、99 个 Page ID、408 个 Figma 最终状态、179 个客户文档图片映射、权限、需求追踪和完成定义。
- [Safety-2 独立复核跨仓集成边界](./SAFETY_2_APPEAL_INTEGRATION.md)：冻结举报未发现违规结论的一次性申请、独立管理员复核、KMP 交互、D1 状态机、API、默认关闭开关与生产门禁。
- [Message-3 站内通知与可靠到达跨仓交付基线](./MESSAGE_3_NOTIFICATION_INTEGRATION.md)：冻结五类通知、D1 Outbox、固定安全模板、HTTP 拉取、未读/已读、偏好、受控目标、后台运行台与生产门禁。
- [Message-4 账号级实时刷新跨仓交付基线](./MESSAGE_4_REALTIME_REFRESH_INTEGRATION.md)：记录 App API `1.25.0`、一次性短票据、无正文刷新事件、Hibernation WebSocket、KMP 前后台恢复与默认关闭门禁。
- [Message-5 数据权利结果通知跨仓交付基线](./MESSAGE_5_DATA_RIGHTS_NOTIFICATION_INTEGRATION.md)：记录数据导出就绪、注销取消恢复、可靠 Outbox、数据任务目标复核和待注销通知抑制。
- [Message-6 通知偏好策略换绑开发基线](./MESSAGE_6_NOTIFICATION_POLICY_REBIND_INTEGRATION.md)：记录账号唯一偏好在策略版本切换时保留选择、单调增版、追加审计和并发收敛的运行时修复。
- [Message-7 数据导出失败必要通知开发基线](./MESSAGE_7_DATA_EXPORT_FAILURE_NOTIFICATION_INTEGRATION.md)：记录失败申请/制品/任务/事件的原子顺序、必要通知 Outbox、隐私最小化和既有数据任务跳转复用。
- [Message-9 站内通知内容生命周期开发基线](./MESSAGE_9_NOTIFICATION_CONTENT_LIFECYCLE_INTEGRATION.md)：记录批准策略下的不可变到期边界、过期投递抑制、explicit/legacy 有界清理、已读约束和 Outbox 去重墓碑保留。
- [Membership-5 旧会员显式迁移交付基线](./MEMBERSHIP_5_LEGACY_MIGRATION_INTEGRATION.md)：冻结 legacy 证据、显式映射、独立复核、执行门禁与租约恢复。
- [Membership-7 会员生命周期呈现跨仓开发基线](./MEMBERSHIP_7_LIFECYCLE_PRESENTATION_INTEGRATION.md)：记录 App API `1.26.0` 的有效、即将到期、自然到期与撤销呈现，历史 grant 与当前授权隔离，以及 KMP `APP-MBR-02` 五态映射。
- [Wallet-4 旧余额显式迁移交付基线](./WALLET_4_LEGACY_BALANCE_MIGRATION_INTEGRATION.md)：外部快照证据、逐项 Owner 复核、默认关闭执行、不可变迁移分类与账本复用。
- [Wallet-3 钱包快照重建与受控解冻交付基线](./WALLET_3_SNAPSHOT_RECOVERY_INTEGRATION.md)：不可变分录末态重建、案件集合摘要、Owner 证据、原子解冻和实时刷新。
- [Wallet-2 批量调币与钱包对账交付基线](./WALLET_2_BATCH_AND_RECONCILIATION_INTEGRATION.md)：CSV 逐行预览、总额硬阻断、可恢复提交、不可变账本对账与 forward-fix。
- [Wallet-1 金币账本跨仓交付基线](./WALLET_1_LEDGER_INTEGRATION.md)：冻结追加式账本、管理员单笔调币与独立复核、用户只读余额/明细、KMP/Nuxt/API 边界和生产门禁。
- [Wallet-1 dev 迁移与验收 Runbook](./WALLET_1_DEV_VALIDATION_RUNBOOK.md)：定义仓库外备份、短期 manifest、部署硬门禁、迁移后只读验收、一次性写入 smoke 和事故恢复边界。
- [Wallet-1 一次性功能验收 Runbook](./WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md)：定义一次性 D1 + 临时 Worker、机器 gate、16 类 HTTP/D1 断言、Worker → D1 自动销毁、聚合证据与恢复命令。
- [Wallet-1 一次性 Smoke 局部决策包](./WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md)：收敛仅限合成验收的调币内控、30 天聚合证据、APAC 位置提示和两步授权文本，不关闭 production 全局决策。
- [Interaction-2 收藏夹与浏览历史开发基线](./INTERACTION_2_FAVORITES_HISTORY_INTEGRATION.md)：记录 App API `1.11.0` 多文件夹收藏、显式浏览历史、拉黑联动、默认关闭门禁，以及配置和专项测试后置边界。
- [Interaction-3 关注更新流与站内通知开发基线](./INTERACTION_3_FOLLOW_UPDATES_INTEGRATION.md)：记录 App API `1.12.0` 发布事实复用、账号私有更新流、惰性去重通知、投递前资格复核和默认关闭门禁。
- [Interaction-4 浏览历史到期生命周期开发基线](./INTERACTION_4_VIEW_HISTORY_LIFECYCLE_INTEGRATION.md)：记录显式策略授权、批准后有界物理清理、能力关闭后继续履约、固定安全日志和无 API/UI 增量。
- [Search-1 人物搜索与搜索历史开发基线](./SEARCH_1_PERSON_SEARCH_HISTORY_INTEGRATION.md)：记录隐私 POST 搜索、公开字段边界、账号绑定游标、默认关闭的私有搜索历史和 Search-2 前向兼容点。
- [Taxonomy-1 稳定分类目录与人物关联开发基线](./TAXONOMY_1_CATALOG_AND_PROFILE_INTEGRATION.md)：记录 App API `1.14.0` 稳定词条、不可变目录快照、合并重定向、legacy 待复核映射、人物内容版本关联及发布投影边界。
- [Search-2 结构化筛选、结果预估与保存条件开发基线](./SEARCH_2_FILTERS_AND_SAVED_FILTERS_INTEGRATION.md)：记录 App API `1.15.0` taxonomy 组合语义、会员分层、结果数安全预估、账号私有保存条件和默认关闭边界。
- [Recommendation-1 版本化推荐与运营精选开发基线](./RECOMMENDATION_1_RULES_AND_EDITORIAL_INTEGRATION.md)：记录 App API `1.16.0` 统一资格、显式偏好、可解释排序、稳定灰度、计划生效、固定精选披露、后台状态机和默认关闭边界。
- [Recommendation-2 客户端版本门禁与安全回退开发基线](./RECOMMENDATION_2_CLIENT_VERSION_GUARD_INTEGRATION.md)：记录 `X-Client-Version` 数字比较、策略/规则 capability 门禁、高版本排期兼容选择、显式回退约束和统一后置验证。
- [Recommendation-3 地区作用域选择与安全回退开发基线](./RECOMMENDATION_3_REGION_SCOPE_AND_FALLBACK_INTEGRATION.md)：记录目标地区在规则选择前执行、全局/地区作用域语义、排期兼容选择、回退范围覆盖和无安全规则时的显式维护边界。
- [Recommendation-4 可执行规则选择与依赖降级开发基线](./RECOMMENDATION_4_EXECUTABLE_RULE_SELECTION_INTEGRATION.md)：记录 scheduled/active/历史回退的完整结构与 taxonomy/heat 依赖校验、个性化目录兼容和 bootstrap capability 真值。
- [Recommendation-5 灰度目标、反指标与自动停止开发基线](./RECOMMENDATION_5_GUARDRAIL_AND_AUTOMATIC_STOP_INTEGRATION.md)：记录默认关闭的来源/保留控制、独立复核策略、聚合整数评估、不可变停止、完整回退和无新增 Figma 页面边界。
- [Recommendation-6 推荐解释证据生命周期开发基线](./RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md)：记录批准后有界到期清理、不可改写会话证据、账号 HMAC 定位、Privacy-2B 零残留删除和无新增公共/UI 契约边界。
- [Operations-1 运营总览、事件处置与跨域安全控制开发基线](./OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md)：记录 18 项质量化指标、事件状态机、当前 8 份 Runbook、五类真实写路径安全控制，以及 10 类 D1 + 1 类官方平台状态检测的当前口径。
- [Operations-2 会员到期权限完整性检测开发基线](./OPERATIONS_2_MEMBERSHIP_EXPIRY_INTEGRITY.md)：区分正常自然到期与到期后权限泄漏，反查新话题和观看者消息事实，记录 `operations-detectors-v2`、`0106` 只读索引、聚合隐私边界与统一后置验证。
- [Operations-3 Cloudflare 官方平台状态检测开发基线](./OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md)：记录 `operations-detectors-v3`、9 个相关公共组件、严格失败边界、第八份 Runbook，以及公共状态与账户级遥测的隔离。
- [Operations-4 Cloudflare 账户级可观测指标开发基线](./OPERATIONS_4_CLOUDFLARE_ANALYTICS_INTEGRATION.md)：记录 `operations-metrics-v2`、Workers/D1/R2 GraphQL 口径、最小只读认证、采样与空样本语义，以及配置和 schema 验证边界。
- [Audit-3 Action 口径治理与独立发布开发基线](./AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md)：记录真实 Action 发现、版本化治理策略、发布/退休预览、Owner 职责分离、生产 Registry 可见性和统一后置门禁。
- [Privacy-1 数据权利控制面跨仓开发基线](./PRIVACY_1_DATA_RIGHTS_CONTROL_PLANE_INTEGRATION.md)：记录 App API `1.17.0`、默认关闭策略、二次验证、导出/注销申请、请求级状态凭证、后台队列、逾期检测、KMP 页面和 Privacy-2 边界。
- [Privacy-2A 私有数据导出制品跨仓交付基线](./PRIVACY_2A_PRIVATE_EXPORT_INTEGRATION.md)：记录 App API `1.24.0`、`0102`、当前 41 类白名单快照、旧 35-scope 兼容、可恢复 Queue、私有 R2 TAR、一次性下载票据和 KMP 流式保存边界。
- [Privacy-2B 账号不可逆注销跨仓交付基线](./PRIVACY_2B_IRREVERSIBLE_DELETION_INTEGRATION.md)：记录 `0103`、九步可恢复执行、七类合规保留隔离、完成证据、失败前向修复、KMP 本地终态清理和默认关闭门禁。
- [Privacy-2C 个人数据副本覆盖补全开发基线](./PRIVACY_2C_DATA_COPY_COVERAGE_INTEGRATION.md)：记录 6 类追加白名单、前 35 类 ordinal 兼容、artifact scope 数完成边界、推荐证据账号 HMAC 定位和无公共/UI 契约增量。
- [Media-1 人物图片与认证说明跨仓开发基线](./MEDIA_1_PERSON_MEDIA_AND_VERIFICATION_INTEGRATION.md)：记录 App API `1.18.0`、现有图库复用、逐次公开资格检查、5 分钟会员图片凭证、公开认证范围和 KMP 仅内存媒体交互。
- [App Core-1 运行策略、帮助与系统状态跨仓开发基线](./APP_CORE_1_RUNTIME_SUPPORT_SYSTEM_INTEGRATION.md)：记录 App API `1.19.0`、全局升级/维护/地区门禁、帮助与法律内容、受限账号安全入口和 KMP 自适应页面。
- [Account/Settings-2 账号资料、初始偏好与会话设置跨仓开发基线](./ACCOUNT_SETTINGS_2_FIGMA_CROSS_REPO_INTEGRATION.md)：记录 App API `1.20.0`、`0095`、三个默认关闭能力、Figma Node ID、私有账号资料、初始偏好、会话免打扰及举报/屏蔽/关闭交互。
- [Account/Settings-3 跨域账号申诉交付基线](./ACCOUNT_SETTINGS_3_CROSS_DOMAIN_APPEAL_INTEGRATION.md)：记录 APP-SET-08 九个正式状态、举报与服务上下文精确选取、幂等创建恢复、三个终态结果页和跨仓验收边界。
- [Person-4 ZIP 批量导入交付基线](./PERSON_4_ZIP_IMPORT_DELIVERY.md)：记录 ADM-PER-04 五个 Figma 状态、Worker 到私有 R2 的分片上传、ZIP 安全校验、Queue 逐项处理、部分失败恢复和 Gallery 与 Person 的显式边界。
- [Legacy Import-2 旧站迁移运行完整性开发基线](./LEGACY_IMPORT_2_OPERATIONAL_INTEGRITY.md)：记录专用 legacy 任务可见性、任务级媒体作用域、单篇成功/失败原子事实、私有来源快照、不可改写审核/失败证据、处理租约与 `0116/0119` 分阶段门禁。
- [External Import-2 Telegram 队列与运行完整性开发基线](./EXTERNAL_IMPORT_2_QUEUE_INTEGRITY.md)：记录原子接收、专用 Queue、30 分钟处理租约、确定性 R2 key、过期恢复、有界图片校验和安全错误证据，以及 `0118`/Queue 配置后置边界。
- [App 1.0 需求追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md)：把产品总需求、发布范围、Feature PRD、99 个 Page ID、408 个 Figma 最终状态和 179 个客户文档图片映射建立确定性关系，并明确未来能力或非 UI 门禁。
- [产品总需求](./PRODUCT_REQUIREMENTS.md)：开发需求规格的产品层上游；业务规则变化先在此处和对应 Feature PRD 修订，再重新生成开发规格。
- [Figma 最终交付审计与实施计划](./FIGMA_FINAL_DELIVERY_AUDIT_AND_PLAN.md)：记录最终文件、99 页/408 状态覆盖、增量前 3,571 个历史交互动作、排版与 Icon 修正、QA 结果和交付门禁。
- [Figma Design System Phase 1](./FIGMA_DESIGN_SYSTEM_PHASE1.md)：记录已落入 Figma 的 5 个变量集合、103 个变量、三端 Code Syntax、13 个文字样式、4 个效果样式、回滚点和校验结果。
- [Figma 文件结构 Phase 2](./FIGMA_FILE_STRUCTURE_PHASE2.md)：记录正式交付页、历史无损归档、Delivery Index、命名与 Spec Card 规则及原型目标校验；其数量是阶段快照，当前实时口径以最终交付审计为准。

## 客户确认交付

- [App 1.0 需求冻结确认单（DOCX）](./deliverables/MeiGallery_App_1.0_需求冻结确认单.docx)：冻结准备阶段的 15 页历史签署快照；其中 402/202 与 3,571 个动作均不是当前实时口径，全部开发完成后统一重生成。
- [App 1.0 需求冻结准备清单（Markdown）](./APP_1_0_REQUIREMENTS_FREEZE_CHECKLIST.md)：保留当时的客户决策、专业门禁、基线文件 SHA-256、冻结规则和签署顺序；当前实时设计事实以 408/208 为准。
- [App 1.0 产品需求确认书（DOCX）](./deliverables/MeiGallery_App_1.0_产品需求确认书.docx)：可直接提供客户评审、填写结论和签字确认的完整交付版。
- [App 1.0 逐页交互设计确认册（DOCX）](./deliverables/MeiGallery_App_1.0_逐页交互设计确认册.docx)：客户交付件；将在全部开发完成后按 50 个移动端页面与 49 个后台页面统一重新生成，汇总 Page ID、页面目标、主操作、必备状态、跨页旅程、验收清单和签字页。
- [客户确认书生成源（Markdown）](./MEIGALLERY_APP_1_0_CLIENT_PRD.md)：用于生成客户 DOCX，不作为研发直接实现依据，也不单独提供客户维护。
- [逐页确认册生成源（Markdown）](./APP_PAGE_LEVEL_PRODUCT_DESIGN.md)：用于生成逐页客户 DOCX；研发按开发需求规格和 Page ID 实现。
- [详细功能与原型中间规格（Markdown）](./APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md)：由页面目录生成，供文档与原型映射复核；最终开发入口仍是开发需求规格。
- [App 1.0 高保真关键旅程原型](./interactive-prototype/index.html)：可点击体验 8 个移动端与后台关键旅程，包含业务规则、建议操作、预期结果、响应式布局和状态反馈。
- [App 1.0 逐页交互设计库](./interactive-prototype/pages.html)：覆盖移动端 50 页和管理后台 49 页，共 99 个可独立访问、搜索、切换状态和操作的页面设计。
- [App 1.0 逐页产品与交互设计](./APP_PAGE_LEVEL_PRODUCT_DESIGN.md)：逐页列出页面目标、主操作、必备状态、跨页旅程和验收方法。
- [逐页客户确认原型图](./assets/page-prototypes/)：99 张页面默认状态 + 57 张 P0 关键状态，共 156 张基础原型；通知与金币 5 页另有 23 张 874 × 1792 Figma 逐状态导出图。`manifest.json` 共记录 179 个 Page ID/状态/图片确定性映射及 SHA-256，并同步 Figma 99 页/408 状态的当前交付事实；3,571 个交互源只保留为 `APP-SET-08` 增量前历史基线。
- [逐页原型 QA 联系表](./assets/page-prototypes/qa/contact-sheets/)：14 个基础功能组加 1 张 Figma 最终状态总览，共 15 组视觉与映射复核图。

## 1. 产品定位

独立 App 是“经管理员认证的真人发现与互动平台”，文档工作名为“心动遇见你”。它不是普通用户互相配对的交友 App，也不是 MeiGallery 的换皮客户端。

- 真人供给：管理员上传、MeiGallery 合规导入，或外部提交后由管理员认证。
- 普通注册账号：只作为观看者，不创建公开真人资料，不进入发现列表。
- 核心行为：按地区、热度和偏好发现真人，喜欢、关注、收藏、浏览媒体。
- 平台话题：只有有效心享会员可以创建和发送；不要求双方同意或匹配，到期后既有会话只读。
- 当前接收方：未认领真人的话题由平台运营接收与处理，前台必须持续披露平台身份，不使用“给 TA 私信”等暗示本人接收的文案。
- 未来方向：真人本人完成认领后，可以运营资料并接收认领后的新会话。
- App 1.0：用户可提交会员申请，五级心享会员最终由管理员手动发放；所有有效等级可发起平台话题。支持管理员加扣币与用户明细，不接入支付和系统推送。
- 后续商业化：金币充值、礼物、头像框、主页皮肤和聊天皮肤；需要新增客户端能力时正常升级 App，金币始终不可提现。

## 2. 顶层架构决策

- App 与现有 Web 最终共用账号、真人、权益、授权媒体、标签、商品和管理员核心能力。
- 采用“共享核心平台 + 渐进式迁移”，不让 App 直接读取 legacy 表，也不一次性重写 Web。
- 用户客户端采用 KMP + Compose Multiplatform，App 1.0 只发布 Android/iOS；普通用户 Windows/macOS 客户端未承诺立项，桌面运营使用 Nuxt 管理后台。
- Nuxt Web 和管理后台继续保留；Kotlin 与 TypeScript 通过 OpenAPI、JSON Schema 和实时事件 schema 共享契约。
- 权限以数值 `rank` 和 entitlement 判断，不硬编码会员名称。
- KMP 最小技术脚手架已在同级独立仓库 `meigallery-client` 创建并通过 Android 构建、共享模块测试和 iOS Kotlin/Native 编译；M0 公共发现纵向切片已获开发验证授权，App API v2 四个只读路径、空公开投影 migration 与客户端发现链路进入实现，仍不代表允许生产迁移或发布。

## 3. 六卷文档体系

| 卷 | 内容 | 主要文档 |
|----|------|----------|
| 一、产品战略与方向 | 定位、用户、边界、指标、阶段路线 | [产品需求](./PRODUCT_REQUIREMENTS.md)、[产品蓝图](../superpowers/specs/2026-07-20-real-person-discovery-product-blueprint-design.md) |
| 二、角色、领域与技术基础 | Account、Person、Profile、Gallery、运营归属、认领、客户端/后端模块和契约冻结 | [Epic 架构](../ways-of-work/plan/real-person-discovery-platform/arch.md)、[数据与迁移](./DATA_AND_MIGRATION.md)、[技术架构](./TECHNICAL_ARCHITECTURE.md)、[KMP 客户端技术栈](./KMP_CLIENT_TECH_STACK.md)、[模块级技术设计](./KMP_CLIENT_MODULE_DESIGN.md) |
| 三、体验与交互基础 | 信息架构、导航、移动端/后台页面、状态、文案、埋点和无障碍 | [UI/UX 设计](./UI_UX_DESIGN.md)、[移动端交互](./MOBILE_APP_INTERACTION_SPEC.md)、[后台交互](./ADMIN_CONSOLE_INTERACTION_SPEC.md)、[状态文案与埋点](./UI_STATE_COPY_AND_ANALYTICS_CATALOG.md) |
| 四、前台功能 PRD | 发现、互动、平台话题、会员申请、会员、金币及未来商业化边界 | [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) |
| 五、后台与运营 PRD | 导入、认证、发布、代运营、商品、调币、退款、认领和审计 | [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) |
| 六、运营、指标与交付 | 路线图、质量、安全、指标、发布门禁和开放决策 | [质量与路线图](./QUALITY_OPERATIONS_ROADMAP.md)、[决策登记](./DECISIONS_AND_OPEN_QUESTIONS.md) |

## 4. 文档地图

| 文档 | 解决的问题 |
|------|------------|
| [App 1.0 开发需求规格](./MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md) | 将产品/发布需求、技术边界、Feature PRD、99 个 Page ID、408 个 Figma 最终状态、179 个客户图片映射和开发验收合并为研发单一入口 |
| [需求冻结准备清单](./APP_1_0_REQUIREMENTS_FREEZE_CHECKLIST.md) | 历史快照：汇总当时的 8 项客户决策、7 组专业门禁、冻结基线指纹、变更规则和签署后执行顺序 |
| [需求冻结确认单 DOCX](./deliverables/MeiGallery_App_1.0_需求冻结确认单.docx) | 历史快照：保留冻结准备阶段的 15 页短版，全部开发完成后统一重生成 |
| [客户确认书生成源](./MEIGALLERY_APP_1_0_CLIENT_PRD.md) | 将分散的产品、交互、原型、验收与客户待确认参数合并为 DOCX 生成源 |
| [客户确认版 DOCX](./deliverables/MeiGallery_App_1.0_产品需求确认书.docx) | 供客户阅读、勾选确认结论、填写意见并签字盖章 |
| [逐页交互设计确认册 DOCX](./deliverables/MeiGallery_App_1.0_逐页交互设计确认册.docx) | 全部开发完成后重新生成，供客户按 Page ID 逐页确认 99 个页面的目标、主操作、必备状态和修改意见 |
| [App 1.0 需求追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md) | 将产品总需求、发布范围、Feature PRD、99 个 Page ID、优先级与原型映射为同一套可校验口径 |
| [详细功能与原型规格](./APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md) | 以 99 个 Page ID 串联详细需求、默认状态、P0 关键状态、截图文件和验收标准 |
| [高保真关键旅程原型](./interactive-prototype/index.html) | 通过 8 个可点击旅程演示移动端、管理后台、业务规则和关键状态 |
| [逐页交互设计库](./interactive-prototype/pages.html) | 为 99 个移动端和后台 Page ID 提供可独立访问、状态切换和交互评审的高保真页面 |
| [逐页产品与交互设计](./APP_PAGE_LEVEL_PRODUCT_DESIGN.md) | 汇总 99 页的页面目标、主操作、必备状态、全局交互和验收清单 |
| [App 1.0 发布范围](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md) | 1.0 必须交付、仅预留、未来升级和不承诺能力的边界 |
| [观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md) | F-01 登录适配、账号边界、会话、设备与撤权 |
| [真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md) | F-02–F-05 推荐、列表、筛选、详情与媒体权限 |
| [真人来源、上传与 MeiGallery 导入](../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md) | A-01–A-02 合规来源、授权、去重、批量任务与草稿生成 |
| [真人认证与发布审核](../ways-of-work/plan/real-person-discovery-platform/person-verification-and-publication/prd.md) | A-03 双状态审核、公开投影、暂停撤权与审计 |
| [喜欢、关注、收藏与浏览历史](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md) | F-06 单向关系、收藏整理、历史和拉黑联动 |
| [我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md) | F-13 设置、数据导出、注销、帮助和申诉 |
| [标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md) | A-04 taxonomy、地区层级、映射和目录版本 |
| [推荐位、排序规则与热度运营](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md) | A-05 资格、排序、热度、精选、灰度和回滚 |
| [举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md) | A-07 举报证据、拉黑联动、审核处置和申诉 |
| [心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md) | F-09、A-08 五级目录、typed entitlement、grant、到期、复核与迁移 |
| [会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md) | F-07、A-06 发起话题、持续披露、消息状态、实时恢复、容量降级和运营队列 |
| [站内通知中心与通知偏好](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md) | F-12 分类、模板、未读、偏好、深链和 HTTP/实时刷新 |
| [金币钱包、追加式账本与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md) | F-10、A-10 余额、明细、加扣币、双人复核、冲正和对账 |
| [运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md) | A-13 指标口径、最小化看板、追加审计、异常和受控导出 |
| [产品需求文档](./PRODUCT_REQUIREMENTS.md) | 产品做什么、不做什么、模块、流程、指标和验收 |
| [技术架构方案](./TECHNICAL_ARCHITECTURE.md) | 共享平台、Cloudflare 服务、KMP 分层和演进边界 |
| [Epic 模块级总体架构](../ways-of-work/plan/real-person-discovery-platform/arch.md) | 系统边界、领域所有权、同步/异步执行模型、技术价值、规模和实现出口 |
| [KMP 客户端技术栈与库选型](./KMP_CLIENT_TECH_STACK.md) | Jetpack KMP、Ktor、Coil、Room、视频播放和平台适配基线 |
| [KMP 客户端模块与状态导航设计](./KMP_CLIENT_MODULE_DESIGN.md) | commonMain/平台边界、Feature 依赖、UDF、四 Tab 导航、本地同步和实时恢复 |
| [Cloudflare 后端模块与实时链路设计](./CLOUDFLARE_BACKEND_MODULE_DESIGN.md) | Hono 领域模块、D1 所有权、Outbox、DO/Queue/Workflow 提交点和故障恢复 |
| [管理后台 RBAC、审批与审计设计](./ADMIN_RBAC_AND_WORKFLOW_DESIGN.md) | capability + scope、职责分离、强认证、审批、调币和敏感读取 |
| [API、DTO 与数据契约冻结计划](./API_DATA_CONTRACT_FREEZE_PLAN.md) | OpenAPI/JSON Schema、DTO、状态机、D1 migration、兼容与冻结门禁 |
| [数据模型与迁移方案](./DATA_AND_MIGRATION.md) | 真人主体建模、MeiGallery 映射、影子迁移和回滚 |
| [API 与实时通信契约](./API_AND_REALTIME_CONTRACT.md) | API 资源、鉴权、幂等、消息事件和错误模型 |
| [Safety-2 独立复核跨仓集成边界](./SAFETY_2_APPEAL_INTEGRATION.md) | 举报结论复核的产品边界、服务端状态机、管理员职责分离、KMP 交互和上线门禁 |
| [Message-3 站内通知与可靠到达跨仓交付基线](./MESSAGE_3_NOTIFICATION_INTEGRATION.md) | 站内通知事件、Outbox、模板、未读/已读、偏好、受控目标、KMP 页面、后台运行台和启用门禁 |
| [Message-4 账号级实时刷新跨仓交付基线](./MESSAGE_4_REALTIME_REFRESH_INTEGRATION.md) | 一次性短票据、账号级有限刷新范围、Hibernation WebSocket、KMP 前后台恢复、HTTP 权威补拉和启用门禁 |
| [Message-5 数据权利结果通知跨仓交付基线](./MESSAGE_5_DATA_RIGHTS_NOTIFICATION_INTEGRATION.md) | 数据导出就绪、注销取消恢复、可靠 Outbox、数据任务目标复核和待注销通知抑制 |
| [Message-6 通知偏好策略换绑开发基线](./MESSAGE_6_NOTIFICATION_POLICY_REBIND_INTEGRATION.md) | 策略切换时保留账号偏好、版本单调、旧/新策略事件审计与并发收敛 |
| [Message-7 数据导出失败必要通知开发基线](./MESSAGE_7_DATA_EXPORT_FAILURE_NOTIFICATION_INTEGRATION.md) | 导出失败事实顺序、必要通知 Outbox、隐私最小化、幂等与既有数据任务目标复用 |
| [Message-8 文本消息审核与结果通知开发基线](./MESSAGE_8_TEXT_MODERATION_INTEGRATION.md) | 默认关闭的文本规则、无正文评估、人工复核租约、消息状态隔离、结果/会话限制通知与 Figma 后置边界 |
| [Message-9 站内通知内容生命周期开发基线](./MESSAGE_9_NOTIFICATION_CONTENT_LIFECYCLE_INTEGRATION.md) | 原始事件时间到期、延迟事件抑制、批准后有界清理、legacy 兼容、不可变边界与无 UI/API 增量 |
| [Recommendation-5 灰度目标、反指标与自动停止开发基线](./RECOMMENDATION_5_GUARDRAIL_AND_AUTOMATIC_STOP_INTEGRATION.md) | 默认关闭守护控制、目标/反指标策略、聚合评估、不可变阻断、完整回退与 Figma 门禁 |
| [Recommendation-6 推荐解释证据生命周期开发基线](./RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md) | 批准后有界到期清理、会话/条目不可改写、账号注销 HMAC 定位与零残留核验 |
| [Membership-5 旧会员显式迁移交付基线](./MEMBERSHIP_5_LEGACY_MIGRATION_INTEGRATION.md) | 旧会员显式映射、证据冻结、逐项复核、受控执行和恢复边界 |
| [Membership-6 会员批量发放服务端交付基线](./MEMBERSHIP_6_BATCH_GRANTS_INTEGRATION.md) | 固定 CSV 预览、逐行普通复核申请、部分失败恢复、draft 取消和 Figma/UI 后置边界 |
| [Membership-7 会员生命周期呈现跨仓开发基线](./MEMBERSHIP_7_LIFECYCLE_PRESENTATION_INTEGRATION.md) | 当前/即将到期/自然到期/撤销快照、历史 grant 授权隔离、KMP 五态映射和配置后置边界 |
| [Wallet-4 旧余额显式迁移交付基线](./WALLET_4_LEGACY_BALANCE_MIGRATION_INTEGRATION.md) | 显式外部快照、证据哈希、逐项 Owner 复核、受控执行、不可变 link 与重复迁移阻断 |
| [Wallet-3 钱包快照重建与受控解冻交付基线](./WALLET_3_SNAPSHOT_RECOVERY_INTEGRATION.md) | 分录末态重建、全案件重验、幂等恢复命令、快照/案件/解冻原子写和审计 |
| [Wallet-2 批量调币与钱包对账交付基线](./WALLET_2_BATCH_AND_RECONCILIATION_INTEGRATION.md) | 批量调币 CSV、总额门禁、逐行幂等、钱包对账、差异案件和 forward-fix |
| [Wallet-1 金币账本跨仓交付基线](./WALLET_1_LEDGER_INTEGRATION.md) | 本人余额/明细、追加式分录、管理员单笔调币、独立复核、完整冲正、KMP 页面和启用门禁 |
| [Membership-4 会员目录与 Entitlement 管理开发基线](./MEMBERSHIP_4_CATALOG_MANAGEMENT_INTEGRATION.md) | 目录完整复制、五级与 typed entitlement 编辑、影响分析、内容哈希、独立发布复核和环境切换隔离 |
| [Audit-1 App 审计查询与完整性开发基线](./AUDIT_1_QUERY_AND_INTEGRITY_INTEGRATION.md) | 唯一审计事实、稳定 sequence、用途与对象范围、字段级脱敏、关联时间线、关键业务反向覆盖和不可变完整性清单 |
| [Audit-2 受控审计导出开发基线](./AUDIT_2_CONTROLLED_EXPORT_INTEGRATION.md) | 三段强认证、独立复核、范围再校验、逐行水印脱敏 CSV、私有 R2 与短时一次性下载 |
| [Audit-3 Action 口径治理与独立发布开发基线](./AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md) | 真实 Action 发现、retention/quality 治理引用、候选影响预览、Owner 独立复核、追加式版本与生产可见 Registry |
| [Operations-3 Cloudflare 官方平台状态检测开发基线](./OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md) | 官方 Status API、相关组件过滤、来源不可用降级、平台事件映射和公共/账户级可观测边界 |
| [Operations-4 Cloudflare 账户级可观测指标开发基线](./OPERATIONS_4_CLOUDFLARE_ANALYTICS_INTEGRATION.md) | 账户级 GraphQL Analytics、三项平台指标、严格质量状态、凭据最小化和后置配置验证 |
| [Wallet-1 一次性功能验收 Runbook](./WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md) | 合成数据隔离环境、短期授权、完整 HTTP/D1 验收、自动销毁、聚合证据和失败恢复 |
| [Wallet-1 一次性 Smoke 局部决策包](./WALLET_1_DISPOSABLE_SMOKE_DECISION_PACKET.md) | 合成验收专用 OQ-018/020/024 局部结论、APAC 推荐、证据保留期和确认/执行分离 |
| [Interaction-2 收藏夹与浏览历史开发基线](./INTERACTION_2_FAVORITES_HISTORY_INTEGRATION.md) | 多文件夹收藏、历史显式记录、版本化清除、拉黑联动和默认关闭门禁 |
| [Interaction-3 关注更新流与站内通知开发基线](./INTERACTION_3_FOLLOW_UPDATES_INTEGRATION.md) | 已审核公开发布更新流、惰性去重站内通知、失效抑制和独立 capability |
| [UI/UX 设计文档](./UI_UX_DESIGN.md) | 移动/桌面信息架构、关键页面、状态、文案和组件 |
| [Figma 最终交付审计与实施计划](./FIGMA_FINAL_DELIVERY_AUDIT_AND_PLAN.md) | 固化 Figma 最终文件、排版与 Icon 一致性、99 页/408 状态覆盖、原型连线、QA 和交付门禁 |
| [Figma Design System Phase 1](./FIGMA_DESIGN_SYSTEM_PHASE1.md) | Figma 变量、跨端代码映射、Noto Sans SC 排版、基础效果与校验证据 |
| [Figma 文件结构 Phase 2](./FIGMA_FILE_STRUCTURE_PHASE2.md) | Figma 正式交付区、历史归档、Delivery Index、命名和 Spec Card 规范 |
| [移动端页面与交互规格](./MOBILE_APP_INTERACTION_SPEC.md) | Android/iOS Screen ID、设计路由、页面目录、关键旅程和关键页面结构 |
| [Nuxt 管理后台页面与交互规格](./ADMIN_CONSOLE_INTERACTION_SPEC.md) | 后台 Page ID、角色、工作台、审批状态、并发和页面结构 |
| [统一 UI 状态、文案与埋点目录](./UI_STATE_COPY_AND_ANALYTICS_CATALOG.md) | 状态/文案/事件 key、错误映射、危险操作、组件矩阵和验收 |
| [信任、安全、隐私与合规](./TRUST_SAFETY_PRIVACY_COMPLIANCE.md) | 真人授权、运营披露、消息治理、数据权利和发布门禁 |
| [会员、金币与虚拟商品](./MONETIZATION_AND_LEDGER.md) | 心享会员、商品目录、订单、账本、调币和退款 |
| [质量、运营与路线图](./QUALITY_OPERATIONS_ROADMAP.md) | App 1.0、后续可选阶段、测试、SLO、运营准备和阶段出口 |
| [方向基线与开放问题](./DECISIONS_AND_OPEN_QUESTIONS.md) | 已确认方向、参数决策和最晚关闭点 |
| [ADR-0001：KMP/CMP 客户端选型](../adr/adr-0001-kmp-compose-multiplatform-client.md) | 客户端技术选择及后果 |
| [AI 可执行架构规格](../../spec/spec-architecture-real-person-discovery-platform.md) | 编号要求、边界和验收基线 |

## 5. 评审顺序

1. 客户先使用需求冻结确认单评审 C-01～C-08；需要查看完整业务依据时，再回到产品需求确认书对应章节。
2. 客户和设计负责人按 `40｜Delivery Index` 的 Page ID 逐页评审 99 页/408 状态；Figma 最终文件作为像素级视觉和交互依据，DOCX 下一次生成将使用 179 张图片完成离线签署与需求映射。
3. Owner、产品和运营根据客户结论同步发布范围、详细 Feature PRD、五级会员定位与路线优先级。
4. 内容、法务、安全、隐私、财务、运营和技术负责人按 G-01～G-07 补齐责任人、结论日期与证据链接。
5. 架构、后端、KMP 和 Web 负责人评审模块级总体架构、KMP 模块、Cloudflare 后端、后台 RBAC 和契约冻结计划，并按最晚关闭点关闭实现前问题。
6. 全部调整同步回 Markdown、原型、追踪矩阵和两份完整客户 DOCX，通过一致性、无障碍与全页渲染校验后，再由 Owner 记录冻结指纹和签署结果。
7. 只有冻结确认单生效且阻塞下一阶段的专业门禁已关闭，才进入实现排期。

## 6. 不可误读的边界

- `Account` 是登录和付费主体，`Person` 是真人事实，`PersonProfile` 是公开展示，`Gallery` 是内容集合；四者不能合并。
- 喜欢、关注和收藏是单向关系，不创建双方匹配。
- 会员获得的是明确的功能和额度，不是“真人一定回复”或关系结果；提交会员申请本身不产生权限。
- 平台运营回复不得伪装为真人本人回复，也不得伪造本人在线、正在输入或已读。
- 热度、付费等级和运营推荐不等于真人认证。
- 管理员上传也必须保留来源、授权、认证、发布和变更审计。
- 管理员加币、扣币和冲正只能追加账本分录，不能直接改余额或删除历史。
- 远程配置可以调整已支持字段；新增页面、原生 SDK 或交互能力仍需要 App 发版。

## 7. 交付物维护

- `scripts/generate_app_product_assets.py`：生成客户文档使用的流程总览和原始参考对照图。
- `scripts/generate_app_page_spec.mjs`：从产品总需求、发布范围和页面目录生成开发需求规格、99 页详细规格、需求追踪矩阵、156 张基础截图任务、23 张逐状态导出图和 179 个确定性图片映射，并同步 Figma 99 页/408 状态与增量前 3,571 动作历史基线。
- `scripts/verify_app_page_prototypes.py`：校验截图数量、尺寸、真实 PNG、哈希重复、Frame 映射和清单引用，并生成 15 组联系表。
- `scripts/generate_app_product_docs.py`：根据当前 Markdown 和已验证原型清单生成两份 DOCX，避免手工副本与需求基线分叉。
- `scripts/verify_app_product_docs.py`：在全部开发完成后校验两份 DOCX 是否完整包含 99 个 Page ID、逐页需求追踪键、156 个基础映射、23 个逐状态导出映射、408 个最终状态、当时重算的交互总数和图片替代文本。
- `scripts/generate_app_freeze_confirmation.py`：根据当前 408/208 manifest 校验结果重建历史冻结准备快照与 15 页客户确认单，并明确 402/202 与 3,571 动作为增量前历史数据。
- `scripts/verify_app_freeze_confirmation.py`：校验 C-01～C-08、G-01～G-07、99 页/408 状态、156/23/179 图片映射、基线哈希、DOCX 表头、图片替代文本和页面几何。
- `scripts/create_docx_contact_sheets.py`：将 DOCX 全页渲染结果整理为可配置的视觉复核联系表。
- 每次客户确认导致需求变化后，应先修改上游 Markdown 和原型，再重新生成开发需求规格与 DOCX；开发只以同步后的 Markdown 为实现入口，DOCX 不作为独立需求源维护。
- 当前交付仍标记为“需求讨论中”。客户完成 C-01～C-08 和签字页确认后，才可将范围状态改为“已确认并冻结”。
