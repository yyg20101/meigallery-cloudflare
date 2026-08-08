# 独立 App 与共享业务平台文档总览

更新时间：2026-08-08

App 版本：1.0

状态：需求讨论中

文档版本与 App 版本一致。需求讨论期间直接修订当前文档，不因每次讨论递增版本；变更历史由 Git 记录。

## 开发交付

- [App 1.0 开发需求规格（Markdown）](./MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md)：研发、测试、接口设计和任务拆分的单一入口，完整包含产品/发布需求、技术边界、92 个 Page ID、349 个 Figma 最终状态、169 个客户文档图片映射、权限、需求追踪和完成定义。
- [Safety-2 独立复核跨仓集成边界](./SAFETY_2_APPEAL_INTEGRATION.md)：冻结举报未发现违规结论的一次性申请、独立管理员复核、KMP 交互、D1 状态机、API、默认关闭开关与生产门禁。
- [Message-3 站内通知与可靠到达跨仓交付基线](./MESSAGE_3_NOTIFICATION_INTEGRATION.md)：冻结五类通知、D1 Outbox、固定安全模板、HTTP 拉取、未读/已读、偏好、受控目标、后台运行台与生产门禁。
- [Wallet-1 金币账本跨仓交付基线](./WALLET_1_LEDGER_INTEGRATION.md)：冻结追加式账本、管理员单笔调币与独立复核、用户只读余额/明细、KMP/Nuxt/API 边界和生产门禁。
- [Wallet-1 dev 迁移与验收 Runbook](./WALLET_1_DEV_VALIDATION_RUNBOOK.md)：定义仓库外备份、短期 manifest、部署硬门禁、迁移后只读验收、一次性写入 smoke 和事故恢复边界。
- [Wallet-1 一次性功能验收 Runbook](./WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md)：定义一次性 D1 + 临时 Worker、机器 gate、16 类 HTTP/D1 断言、Worker → D1 自动销毁、聚合证据与恢复命令。
- [App 1.0 需求追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md)：把产品总需求、发布范围、Feature PRD、92 个 Page ID、349 个 Figma 最终状态和 169 个客户文档图片映射建立确定性关系，并明确未来能力或非 UI 门禁。
- [产品总需求](./PRODUCT_REQUIREMENTS.md)：开发需求规格的产品层上游；业务规则变化先在此处和对应 Feature PRD 修订，再重新生成开发规格。
- [Figma 最终交付审计与实施计划](./FIGMA_FINAL_DELIVERY_AUDIT_AND_PLAN.md)：记录最终文件、92 页/349 状态覆盖、2,284 个有效交互动作、排版与 Icon 修正、QA 结果和交付门禁。
- [Figma Design System Phase 1](./FIGMA_DESIGN_SYSTEM_PHASE1.md)：记录已落入 Figma 的 5 个变量集合、103 个变量、三端 Code Syntax、13 个文字样式、4 个效果样式、回滚点和校验结果。
- [Figma 文件结构 Phase 2](./FIGMA_FILE_STRUCTURE_PHASE2.md)：记录正式交付页、历史无损归档、92 Page ID Delivery Index、命名与 Spec Card 规则及原型目标校验。

## 客户确认交付

- [App 1.0 需求冻结确认单（DOCX）](./deliverables/MeiGallery_App_1.0_需求冻结确认单.docx)：15 页短版签署入口，集中确认 8 项客户决策、7 组上线前专业门禁、视觉成熟度与冻结生效条件；当前结论为“冻结准备中”，不替代两份完整客户文档。
- [App 1.0 需求冻结准备清单（Markdown）](./APP_1_0_REQUIREMENTS_FREEZE_CHECKLIST.md)：记录客户决策、专业门禁、基线文件 SHA-256、冻结规则和签署后执行顺序，供产品、设计、技术、测试与交付共同维护。
- [App 1.0 产品需求确认书（DOCX）](./deliverables/MeiGallery_App_1.0_产品需求确认书.docx)：可直接提供客户评审、填写结论和签字确认的完整交付版。
- [App 1.0 逐页交互设计确认册（DOCX）](./deliverables/MeiGallery_App_1.0_逐页交互设计确认册.docx)：按 49 个移动端页面与 43 个后台页面汇总 Page ID、页面目标、主操作、必备状态、跨页旅程、验收清单和签字页。
- [客户确认书生成源（Markdown）](./MEIGALLERY_APP_1_0_CLIENT_PRD.md)：用于生成客户 DOCX，不作为研发直接实现依据，也不单独提供客户维护。
- [逐页确认册生成源（Markdown）](./APP_PAGE_LEVEL_PRODUCT_DESIGN.md)：用于生成逐页客户 DOCX；研发按开发需求规格和 Page ID 实现。
- [详细功能与原型中间规格（Markdown）](./APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md)：由页面目录生成，供文档与原型映射复核；最终开发入口仍是开发需求规格。
- [App 1.0 高保真关键旅程原型](./interactive-prototype/index.html)：可点击体验 8 个移动端与后台关键旅程，包含业务规则、建议操作、预期结果、响应式布局和状态反馈。
- [App 1.0 逐页交互设计库](./interactive-prototype/pages.html)：覆盖移动端 49 页和管理后台 43 页，共 92 个可独立访问、搜索、切换状态和操作的页面设计。
- [App 1.0 逐页产品与交互设计](./APP_PAGE_LEVEL_PRODUCT_DESIGN.md)：逐页列出页面目标、主操作、必备状态、跨页旅程和验收方法。
- [逐页客户确认原型图](./assets/page-prototypes/)：92 张页面默认状态 + 54 张 P0 关键状态，共 146 张基础原型；通知与金币 5 页另有 23 张 874 × 1792 Figma 逐状态导出图。`manifest.json` 共记录 169 个 Page ID/状态/图片确定性映射及 SHA-256，并同步 Figma 92 页/349 状态/2,284 动作的最终交付事实。
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
| [App 1.0 开发需求规格](./MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md) | 将产品/发布需求、技术边界、Feature PRD、92 个 Page ID、349 个 Figma 最终状态、169 个客户图片映射和开发验收合并为研发单一入口 |
| [需求冻结准备清单](./APP_1_0_REQUIREMENTS_FREEZE_CHECKLIST.md) | 汇总 8 项客户决策、7 组专业门禁、冻结基线指纹、变更规则和签署后执行顺序 |
| [需求冻结确认单 DOCX](./deliverables/MeiGallery_App_1.0_需求冻结确认单.docx) | 供客户和项目负责人先用 15 页短版集中选择结论、填写调整意见并签署 |
| [客户确认书生成源](./MEIGALLERY_APP_1_0_CLIENT_PRD.md) | 将分散的产品、交互、原型、验收与客户待确认参数合并为 DOCX 生成源 |
| [客户确认版 DOCX](./deliverables/MeiGallery_App_1.0_产品需求确认书.docx) | 供客户阅读、勾选确认结论、填写意见并签字盖章 |
| [逐页交互设计确认册 DOCX](./deliverables/MeiGallery_App_1.0_逐页交互设计确认册.docx) | 供客户按 Page ID 逐页确认 92 个页面的目标、主操作、必备状态和修改意见 |
| [App 1.0 需求追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md) | 将产品总需求、发布范围、Feature PRD、92 个 Page ID、优先级与原型映射为同一套可校验口径 |
| [详细功能与原型规格](./APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md) | 以 92 个 Page ID 串联详细需求、默认状态、P0 关键状态、截图文件和验收标准 |
| [高保真关键旅程原型](./interactive-prototype/index.html) | 通过 8 个可点击旅程演示移动端、管理后台、业务规则和关键状态 |
| [逐页交互设计库](./interactive-prototype/pages.html) | 为 92 个移动端和后台 Page ID 提供可独立访问、状态切换和交互评审的高保真页面 |
| [逐页产品与交互设计](./APP_PAGE_LEVEL_PRODUCT_DESIGN.md) | 汇总 92 页的页面目标、主操作、必备状态、全局交互和验收清单 |
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
| [Wallet-1 金币账本跨仓交付基线](./WALLET_1_LEDGER_INTEGRATION.md) | 本人余额/明细、追加式分录、管理员单笔调币、独立复核、完整冲正、KMP 页面和启用门禁 |
| [Wallet-1 一次性功能验收 Runbook](./WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md) | 合成数据隔离环境、短期授权、完整 HTTP/D1 验收、自动销毁、聚合证据和失败恢复 |
| [UI/UX 设计文档](./UI_UX_DESIGN.md) | 移动/桌面信息架构、关键页面、状态、文案和组件 |
| [Figma 最终交付审计与实施计划](./FIGMA_FINAL_DELIVERY_AUDIT_AND_PLAN.md) | 固化 Figma 最终文件、排版与 Icon 一致性、92 页/349 状态覆盖、原型连线、QA 和交付门禁 |
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
2. 客户和设计负责人按 `40｜Delivery Index` 的 Page ID 逐页评审 92 页/349 状态；Figma 最终文件作为像素级视觉和交互依据，DOCX 的 169 张图片用于离线签署与需求映射。
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
- `scripts/generate_app_page_spec.mjs`：从产品总需求、发布范围和页面目录生成开发需求规格、92 页详细规格、需求追踪矩阵、146 张基础截图任务、23 张逐状态导出图和 169 个确定性图片映射，并同步 Figma 92 页/349 状态/2,284 动作的最终交付事实。
- `scripts/verify_app_page_prototypes.py`：校验截图数量、尺寸、真实 PNG、哈希重复、Frame 映射和清单引用，并生成 15 组联系表。
- `scripts/generate_app_product_docs.py`：根据当前 Markdown 和已验证原型清单生成两份 DOCX，避免手工副本与需求基线分叉。
- `scripts/verify_app_product_docs.py`：校验两份 DOCX 是否完整包含 92 个 Page ID、逐页需求追踪键、146 个基础映射、23 个逐状态导出映射、349/2,284 最终交付事实和图片替代文本。
- `scripts/generate_app_freeze_confirmation.py`：根据两份完整客户 DOCX、开发规格、追踪矩阵和原型清单生成需求冻结准备清单与 15 页客户确认单，并记录组合基线指纹。
- `scripts/verify_app_freeze_confirmation.py`：校验 C-01～C-08、G-01～G-07、92/146/23/169 数量、基线哈希、DOCX 表头、图片替代文本和页面几何。
- `scripts/create_docx_contact_sheets.py`：将 DOCX 全页渲染结果整理为可配置的视觉复核联系表。
- 每次客户确认导致需求变化后，应先修改上游 Markdown 和原型，再重新生成开发需求规格与 DOCX；开发只以同步后的 Markdown 为实现入口，DOCX 不作为独立需求源维护。
- 当前交付仍标记为“需求讨论中”。客户完成 C-01～C-08 和签字页确认后，才可将范围状态改为“已确认并冻结”。
