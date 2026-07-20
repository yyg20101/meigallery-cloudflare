# 独立 App 与共享业务平台文档总览

更新时间：2026-07-20

App 版本：1.0

状态：需求讨论中

文档版本与 App 版本一致。需求讨论期间直接修订当前文档，不因每次讨论递增版本；变更历史由 Git 记录。

## 1. 产品定位

独立 App 是“经管理员认证的真人发现与互动平台”，文档工作名为“心动遇见你”。它不是普通用户互相配对的交友 App，也不是 MeiGallery 的换皮客户端。

- 真人供给：管理员上传、MeiGallery 合规导入，或外部提交后由管理员认证。
- 普通注册账号：只作为观看者，不创建公开真人资料，不进入发现列表。
- 核心行为：按地区、热度和偏好发现真人，喜欢、关注、收藏、浏览媒体。
- 私信：只有有效心享会员可以创建；不要求双方同意或匹配。
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
| 二、角色、领域与技术基础 | Account、Person、Profile、Gallery、运营归属、认领和客户端技术栈 | [数据与迁移](./DATA_AND_MIGRATION.md)、[技术架构](./TECHNICAL_ARCHITECTURE.md)、[KMP 客户端技术栈](./KMP_CLIENT_TECH_STACK.md) |
| 三、体验与交互基础 | 信息架构、导航、页面状态、权限提示、文案和无障碍 | [UI/UX 设计](./UI_UX_DESIGN.md) |
| 四、前台功能 PRD | 发现、互动、会员私信、会员、金币、礼物和装扮 | [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) |
| 五、后台与运营 PRD | 导入、认证、发布、代运营、商品、调币、退款、认领和审计 | [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) |
| 六、运营、指标与交付 | 路线图、质量、安全、指标、发布门禁和开放决策 | [质量与路线图](./QUALITY_OPERATIONS_ROADMAP.md)、[决策登记](./DECISIONS_AND_OPEN_QUESTIONS.md) |

## 4. 文档地图

| 文档 | 解决的问题 |
|------|------------|
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
| [产品需求文档](./PRODUCT_REQUIREMENTS.md) | 产品做什么、不做什么、模块、流程、指标和验收 |
| [技术架构方案](./TECHNICAL_ARCHITECTURE.md) | 共享平台、Cloudflare 服务、KMP 分层和演进边界 |
| [KMP 客户端技术栈与库选型](./KMP_CLIENT_TECH_STACK.md) | Jetpack KMP、Ktor、Coil、Room、视频播放和平台适配基线 |
| [数据模型与迁移方案](./DATA_AND_MIGRATION.md) | 真人主体建模、MeiGallery 映射、影子迁移和回滚 |
| [API 与实时通信契约](./API_AND_REALTIME_CONTRACT.md) | API 资源、鉴权、幂等、消息事件和错误模型 |
| [UI/UX 设计文档](./UI_UX_DESIGN.md) | 移动/桌面信息架构、关键页面、状态、文案和组件 |
| [信任、安全、隐私与合规](./TRUST_SAFETY_PRIVACY_COMPLIANCE.md) | 真人授权、运营披露、消息治理、数据权利和发布门禁 |
| [会员、金币与虚拟商品](./MONETIZATION_AND_LEDGER.md) | 心享会员、商品目录、订单、账本、调币和退款 |
| [质量、运营与路线图](./QUALITY_OPERATIONS_ROADMAP.md) | App 1.0、后续可选阶段、测试、SLO、运营准备和阶段出口 |
| [方向基线与开放问题](./DECISIONS_AND_OPEN_QUESTIONS.md) | 已确认方向、参数决策和最晚关闭点 |
| [ADR-0001：KMP/CMP 客户端选型](../adr/adr-0001-kmp-compose-multiplatform-client.md) | 客户端技术选择及后果 |
| [AI 可执行架构规格](../../spec/spec-architecture-real-person-discovery-platform.md) | 编号要求、边界和验收基线 |

## 5. 评审顺序

1. Owner、产品和运营确认发布范围、详细 Feature PRD、五级会员定位与路线优先级。
2. 内容、法务与安全负责人关闭首批 PRD 中的真人来源、授权、认证声明、审核复核和推荐合规门禁。
3. 设计负责人基于详细 Feature PRD 和 UI/UX 文档产出线框、高保真和可点击原型。
4. 架构、后端、KMP 和 Web 负责人基于详细 PRD 编写模块技术方案并评审数据和契约。
5. 运营与财务确认五级会员额度、有效期、手动发放、调币阈值和用户说明；价格、支付和退款在未来商业化立项时确认。
6. 所有上线门禁有责任人和验收证据后，才进入实现排期。

## 6. 不可误读的边界

- `Account` 是登录和付费主体，`Person` 是真人事实，`PersonProfile` 是公开展示，`Gallery` 是内容集合；四者不能合并。
- 喜欢、关注和收藏是单向关系，不创建双方匹配。
- 会员获得的是明确的功能和额度，不是“真人一定回复”或关系结果。
- 平台运营回复不得伪装为真人本人回复，也不得伪造本人在线、正在输入或已读。
- 热度、付费等级和运营推荐不等于真人认证。
- 管理员上传也必须保留来源、授权、认证、发布和变更审计。
- 管理员加币、扣币和冲正只能追加账本分录，不能直接改余额或删除历史。
- 远程配置可以调整已支持字段；新增页面、原生 SDK 或交互能力仍需要 App 发版。
