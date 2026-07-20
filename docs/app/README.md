# 独立 App 与共享业务平台文档总览

更新时间：2026-07-21

App 版本：1.0

状态：需求讨论中

文档版本与 App 版本一致。需求讨论期间直接修订当前文档，不因每次讨论递增版本；变更历史由 Git 记录。

## 客户确认交付

- [App 1.0 产品需求确认书（Markdown）](./MEIGALLERY_APP_1_0_CLIENT_PRD.md)：面向客户的单一需求基线，覆盖范围、角色、会员、移动端与后台交互、异常状态、迁移、验收和 17 项待确认参数。
- [App 1.0 产品需求确认书（DOCX）](./deliverables/MeiGallery_App_1.0_产品需求确认书.docx)：可直接提供客户评审、填写结论和签字确认的 32 页版本。
- [客户确认原型图](./assets/client-prd/)：7 组低保真原型，覆盖登录发现、真人详情与会员、会话、通知/钱包/我的、后台内容审核、后台运营及端到端流程。

## 1. 产品定位

独立 App 是“经管理员认证的真人发现与互动平台”，文档工作名为“心动遇见你”。它不是普通用户互相配对的交友 App，也不是 MeiGallery 的换皮客户端。

- 真人供给：管理员上传、MeiGallery 合规导入，或外部提交后由管理员认证。
- 普通注册账号：只作为观看者，不创建公开真人资料，不进入发现列表。
- 核心行为：按地区、热度和偏好发现真人，喜欢、关注、收藏、浏览媒体。
- 私信：只有有效心享会员可以创建和发送；不要求双方同意或匹配，到期后既有会话只读。
- 当前接收方：未认领真人的私信由管理员代运营，前台必须披露平台运营身份。
- 未来方向：真人本人完成认领后，可以运营资料并接收认领后的新会话。
- App 1.0：五级心享会员由管理员手动发放，所有有效等级可私信；支持管理员加扣币与用户明细，不接入支付和系统推送。
- 后续商业化：金币充值、礼物、头像框、主页皮肤和聊天皮肤；需要新增客户端能力时正常升级 App，金币始终不可提现。

## 2. 顶层架构决策

- App 与现有 Web 最终共用账号、真人、权益、授权媒体、标签、商品和管理员核心能力。
- 采用“共享核心平台 + 渐进式迁移”，不让 App 直接读取 legacy 表，也不一次性重写 Web。
- 用户客户端采用 KMP + Compose Multiplatform，App 1.0 只发布 Android/iOS；普通用户 Windows/macOS 客户端未承诺立项，桌面运营使用 Nuxt 管理后台。
- Nuxt Web 和管理后台继续保留；Kotlin 与 TypeScript 通过 OpenAPI、JSON Schema 和实时事件 schema 共享契约。
- 权限以数值 `rank` 和 entitlement 判断，不硬编码会员名称。
- 当前阶段只产出文档，不创建 KMP 工程、不新增 API 或数据库 migration。

## 3. 六卷文档体系

| 卷 | 内容 | 主要文档 |
|----|------|----------|
| 一、产品战略与方向 | 定位、用户、边界、指标、阶段路线 | [产品需求](./PRODUCT_REQUIREMENTS.md)、[产品蓝图](../superpowers/specs/2026-07-20-real-person-discovery-product-blueprint-design.md) |
| 二、角色、领域与技术基础 | Account、Person、Profile、Gallery、运营归属、认领、客户端/后端模块和契约冻结 | [Epic 架构](../ways-of-work/plan/real-person-discovery-platform/arch.md)、[数据与迁移](./DATA_AND_MIGRATION.md)、[技术架构](./TECHNICAL_ARCHITECTURE.md)、[KMP 客户端技术栈](./KMP_CLIENT_TECH_STACK.md)、[模块级技术设计](./KMP_CLIENT_MODULE_DESIGN.md) |
| 三、体验与交互基础 | 信息架构、导航、移动端/后台页面、状态、文案、埋点和无障碍 | [UI/UX 设计](./UI_UX_DESIGN.md)、[移动端交互](./MOBILE_APP_INTERACTION_SPEC.md)、[后台交互](./ADMIN_CONSOLE_INTERACTION_SPEC.md)、[状态文案与埋点](./UI_STATE_COPY_AND_ANALYTICS_CATALOG.md) |
| 四、前台功能 PRD | 发现、互动、会员私信、会员、金币、礼物和装扮 | [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) |
| 五、后台与运营 PRD | 导入、认证、发布、代运营、商品、调币、退款、认领和审计 | [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) |
| 六、运营、指标与交付 | 路线图、质量、安全、指标、发布门禁和开放决策 | [质量与路线图](./QUALITY_OPERATIONS_ROADMAP.md)、[决策登记](./DECISIONS_AND_OPEN_QUESTIONS.md) |

## 4. 文档地图

| 文档 | 解决的问题 |
|------|------------|
| [客户产品需求确认书](./MEIGALLERY_APP_1_0_CLIENT_PRD.md) | 将分散的产品、交互、原型、验收与客户待确认参数合并为单一可签字需求基线 |
| [客户确认版 DOCX](./deliverables/MeiGallery_App_1.0_产品需求确认书.docx) | 供客户阅读、勾选确认结论、填写意见并签字盖章 |
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
| [会员私信、实时会话与平台代运营](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md) | F-07、A-06 直接建会话、持续披露、消息状态、实时恢复和运营队列 |
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
| [UI/UX 设计文档](./UI_UX_DESIGN.md) | 移动/桌面信息架构、关键页面、状态、文案和组件 |
| [移动端页面与交互规格](./MOBILE_APP_INTERACTION_SPEC.md) | Android/iOS Screen ID、设计路由、页面目录、关键旅程和低保真结构 |
| [Nuxt 管理后台交互与低保真规格](./ADMIN_CONSOLE_INTERACTION_SPEC.md) | 后台 Page ID、角色、工作台、审批状态、并发和低保真结构 |
| [统一 UI 状态、文案与埋点目录](./UI_STATE_COPY_AND_ANALYTICS_CATALOG.md) | 状态/文案/事件 key、错误映射、危险操作、组件矩阵和验收 |
| [信任、安全、隐私与合规](./TRUST_SAFETY_PRIVACY_COMPLIANCE.md) | 真人授权、运营披露、消息治理、数据权利和发布门禁 |
| [会员、金币与虚拟商品](./MONETIZATION_AND_LEDGER.md) | 心享会员、商品目录、订单、账本、调币和退款 |
| [质量、运营与路线图](./QUALITY_OPERATIONS_ROADMAP.md) | App 1.0、后续可选阶段、测试、SLO、运营准备和阶段出口 |
| [方向基线与开放问题](./DECISIONS_AND_OPEN_QUESTIONS.md) | 已确认方向、参数决策和最晚关闭点 |
| [ADR-0001：KMP/CMP 客户端选型](../adr/adr-0001-kmp-compose-multiplatform-client.md) | 客户端技术选择及后果 |
| [AI 可执行架构规格](../../spec/spec-architecture-real-person-discovery-platform.md) | 编号要求、边界和验收基线 |

## 5. 评审顺序

1. 客户先评审产品需求确认书第 17 章的 17 项参数，并在第 18 章选择确认结论、填写意见和签字。
2. Owner、产品和运营根据客户结论冻结发布范围、详细 Feature PRD、五级会员定位与路线优先级。
3. 内容、法务与安全负责人关闭首批 PRD 中的真人来源、授权、认证声明、审核复核和推荐合规门禁。
4. 设计负责人基于已确认需求和现有 7 组低保真原型产出高保真与可点击原型。
5. 架构、后端、KMP 和 Web 负责人评审模块级总体架构、KMP 模块、Cloudflare 后端、后台 RBAC 和契约冻结计划，并按 Gate 关闭实现前问题。
6. 运营与财务确认五级会员额度、有效期、手动发放、调币阈值和用户说明；价格、支付和退款在未来商业化立项时确认。
7. 所有上线门禁有责任人和验收证据后，才进入实现排期。

## 6. 不可误读的边界

- `Account` 是登录和付费主体，`Person` 是真人事实，`PersonProfile` 是公开展示，`Gallery` 是内容集合；四者不能合并。
- 喜欢、关注和收藏是单向关系，不创建双方匹配。
- 会员获得的是明确的功能和额度，不是“真人一定回复”或关系结果。
- 平台运营回复不得伪装为真人本人回复，也不得伪造本人在线、正在输入或已读。
- 热度、付费等级和运营推荐不等于真人认证。
- 管理员上传也必须保留来源、授权、认证、发布和变更审计。
- 管理员加币、扣币和冲正只能追加账本分录，不能直接改余额或删除历史。
- 远程配置可以调整已支持字段；新增页面、原生 SDK 或交互能力仍需要 App 发版。
