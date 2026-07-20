# 真人发现与互动平台产品需求文档

App 版本：1.0

日期：2026-07-20

状态：需求讨论中

## 1. 产品概述

### 1.1 定位

“心动遇见你”（工作名）是一款独立的真人发现与互动 App。平台展示由管理员认证并发布的真人资料，帮助观看者按地区、热度、标签和个人偏好发现感兴趣的真人，并进行喜欢、关注、收藏和会员私信。礼物和个性装扮属于后续商业化方向，不是 App 1.0 上线范围。

平台当前由管理员维护真人资料，并接收未认领真人的私信。未来真人本人可通过认领流程运营本人资料并接收新会话。产品不建立普通用户间的公开资料、双方匹配或用户间聊天。

### 1.2 产品原则

1. 供给可信：只有已认证且已发布的真人进入公开列表。
2. 身份真实：明确区分真人、资料、观看者账号和实际消息接收主体。
3. 权益透明：会员获得明确功能与额度，不承诺本人回复或关系结果。
4. 安全可控：对象级权限、频控、举报、拉黑和后台审计由服务端执行。
5. 配置演进：等级、权益、商品和文案配置化，新增客户端能力显式版本控制。
6. 渐进迁移：复用 MeiGallery 数据与能力，但不把 legacy 表变成永久耦合点。

### 1.3 产品目标

- 建立从真人内容供给、发现、单向互动到会员私信的完整闭环。
- 将 MeiGallery 的人物和媒体资产转为有来源、有授权、有状态的真人资料。
- 建立可解释的管理员代运营消息服务和未来本人认领路径。
- App 1.0 建立五级心享会员手动发放、管理员金币账本和用户明细；在线商业化以后独立立项。
- 以 KMP 支持 Android/iOS 首发；普通用户桌面客户端是否立项以后独立决策。

### 1.4 非目标

- 不做普通用户公开交友资料、双向喜欢、招呼、配对或解除匹配。
- 不做普通用户之间的私信、群聊、匿名聊天或随机聊天。
- 不允许平台人员未披露地冒充真人本人。
- 不做礼物提现、金币转账、法币兑换、盲盒、抽奖或博彩。
- App 1.0 不做在线支付、金币充值、系统推送、礼物/装扮交易、图片消息、直播、公开评论、音视频通话和用户上传公开媒体。

## 2. 用户与角色

| 角色 | 定义 | 核心能力 |
|------|------|----------|
| 访客 | 未登录访问者 | 查看品牌、条款和有限公开预览 |
| 普通观看者 | 已注册但无有效付费等级 | 发现、搜索、喜欢、关注、收藏、举报和账号管理 |
| 心享会员 | 持有有效会员 entitlement | 普通能力 + 私信、等级额度和高级筛选 |
| 内容管理员 | 管理真人资料和媒体 | 上传、导入、认证、发布、暂停、归档 |
| 代运营管理员 | 处理未认领真人私信 | 会话分配、平台身份回复、升级审核和审计 |
| 商业运营/财务 | 管理权益和账务 | 1.0 手动会员发放、调币、复核和账本；未来管理商品、订单和退款 |
| 审核/客服 | 处理风险和争议 | 举报、申诉、必要证据和安全处置 |
| 入驻真人（未来） | 已认领本人资料的主体 | 管理获准字段并接收认领后的新会话 |

普通账号不会因为注册、上传头像、购买会员或被管理员标记而自动成为真人资料。真人主体与登录账号之间只能通过审核通过的认领关系绑定。

## 3. 范围和版本

### 3.1 M0：数据与产品地基

- `Account`、`Person`、`PersonProfile`、`Gallery` 分离建模。
- MeiGallery 人物与媒体映射、授权证据和迁移任务。
- 真人认证/发布状态、运营归属、审计、标签和地区体系。
- 五级心享会员、entitlement、商品目录、订单和金币账本设计。

### 3.2 M1：真人发现闭环

- Android/iOS 注册登录、推荐、地区、热门、最新、搜索和筛选。
- 真人详情、图库媒体、喜欢、关注、收藏和浏览历史。
- 管理后台真人导入、认证、发布、暂停、标签和推荐位。
- 通知中心、举报拉黑、隐私和账号数据权利。

### 3.3 M2A：App 1.0 私信与手动运营

- 心享会员五级全部展示，由管理员手动发放并设置有效期。
- 会员直接创建私信、管理员代运营工作台和实时文本消息。
- 站内通知，不接入 APNs、FCM 或其他系统推送。
- 金币余额与明细，管理员加币、扣币、补偿、冲正和复核；不开放充值或消费。

### 3.4 M2B：后续在线商业化（版本未定）

- 商店购买、恢复、续订、升级、退款和订单对账。
- 金币充值、礼物、头像框、主页皮肤和聊天皮肤。
- 系统推送和经审核的图片消息。

### 3.5 M3：真人本人入驻

- 真人认领申请、身份核验、授权复核、账号绑定和交接。
- 本人管理获准资料字段、接收新私信和运营状态切换。
- 历史代运营会话按观看者同意与合规审批选择性移交。

### 3.6 可选扩展（版本未定）

- 多语言、多地区和平台级实验能力。
- 普通用户 Windows/macOS 客户端仅在独立立项后进入范围；桌面运营继续使用 Nuxt 管理后台。
- 视频资料、更加丰富的消息媒体和经过评审的新互动形态。

## 4. 信息架构

移动端一级导航为“推荐、关注、消息、我的”。

```text
推荐
├── 为你推荐
├── 地区 / 热门 / 最新 / 分类
├── 搜索与筛选
└── 真人详情

关注
├── 关注更新
├── 喜欢记录
├── 收藏与收藏夹
└── 浏览历史

消息
├── 私信会话
├── 互动通知
├── 会员与金币通知
└── 系统与安全通知

我的
├── 心享会员
├── 金币与明细
├── 账号与设备
├── 隐私与推荐设置
└── 数据导出 / 注销 / 帮助
```

App 1.0 不包含普通用户桌面客户端。Nuxt 管理后台在桌面端采用左侧主导航与“列表 + 详情”布局；未来普通用户桌面客户端需独立立项。

## 5. 功能需求

### 5.1 注册、登录与账号

- **PRD-FR-001**：支持由首发地区、渠道和服务端 capability 启用的邮箱、手机号或经评审第三方登录；不要求所有方式同时启用。账号激活前展示条款、隐私和目标地区必要资格要求。
- **PRD-FR-002**：用户可管理设备、远程退出、修改绑定、安全验证、数据导出和注销。
- **PRD-FR-003**：注册只创建 `Account`，不得自动创建 `Person` 或 `PersonProfile`。
- **PRD-FR-004**：服务端基于角色、账号状态、会员 entitlement 和对象关系授权。

详细要求见 [观看者注册、登录与设备安全 PRD](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)。

### 5.2 真人资料供给

- **PRD-FR-010**：资料来源只允许管理员上传、MeiGallery 导入或外部提交后审核。
- **PRD-FR-011**：只有 `verified + published` 的资料进入推荐、列表、搜索和分享页。
- **PRD-FR-012**：资料记录来源、授权、认证、媒体、标签、地区、运营主体和发布历史。
- **PRD-FR-013**：暂停、撤销认证或归档后必须立即停止新曝光和新私信。

详细要求见 [真人资料来源、上传与 MeiGallery 导入 PRD](../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md) 和 [真人认证与发布审核 PRD](../ways-of-work/plan/real-person-discovery-platform/person-verification-and-publication/prd.md)。

### 5.3 发现、搜索与推荐

- **PRD-FR-020**：提供推荐、地区、热门、最新、分类、搜索和筛选入口。
- **PRD-FR-021**：推荐可使用地区、标签、职业、风格、热度、时效和观看者行为，不使用精确位置轨迹。
- **PRD-FR-022**：用户可切换非个性化排序、关闭个性化推荐并清除相关记录。
- **PRD-FR-023**：推荐返回可解释理由；付费等级不影响真人认证真实性。

### 5.4 真人详情与媒体

- **PRD-FR-030**：详情展示认证标识、展示名、模糊地区、标签、简介、图库、运营说明和可执行操作。
- **PRD-FR-031**：受保护媒体由服务端校验后发放短期访问凭证。
- **PRD-FR-032**：页面始终提供举报、拉黑和分享入口；分享页遵循资料当前状态。

详细要求见 [真人发现、搜索与资料浏览体验 PRD](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)、[标签、地区与分类目录管理 PRD](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md) 和 [推荐位、排序规则与热度运营 PRD](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)。

### 5.5 单向互动

- **PRD-FR-040**：喜欢、关注、收藏相互独立、幂等并支持撤销，不产生匹配。
- **PRD-FR-041**：关注用于更新订阅，收藏支持文件夹，喜欢作为轻量偏好信号。
- **PRD-FR-042**：浏览历史仅本人可见，可逐条或全部清理。

详细要求见 [喜欢、关注、收藏与浏览历史 PRD](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md)。

### 5.6 会员私信与代运营

- **PRD-FR-050**：只有有效 `direct_message.create` entitlement 才能创建私信，不要求双方同意。
- **PRD-FR-051**：服务端校验目标状态、会员有效期、等级额度、频控、拉黑和安全状态。
- **PRD-FR-052**：未认领真人的会话进入管理员工作台；入口、会话和运营主体变化必须持续披露。
- **PRD-FR-053**：管理员消息显示为平台运营回复，并记录实际操作员；不得伪造真人本人在线、输入、已读或回复。
- **PRD-FR-054**：App 1.0 消息支持文本、表情、系统消息，以及发送、失败、审核中、送达、已读、撤回规则、举报、拉黑、静音和关闭状态；图片等媒体消息以后独立启用。
- **PRD-FR-055**：会员权益不保证任何回复时效或关系结果。
- **PRD-FR-056**：只有有效 `direct_message.send` entitlement 才能在会话中发送私信；会员到期后历史会话保留为只读。

总纲见 [真人发现、单向互动与代运营私信 PRD](../ways-of-work/plan/real-person-discovery-platform/managed-person-discovery-and-messaging/prd.md)；App 1.0 可验收细节见 [会员私信、实时会话与平台代运营工作台 PRD](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)。

### 5.7 心享会员

- **PRD-FR-060**：App 1.0 同时展示心遇、心悦、心知、心契、心耀五级，并允许管理员手动发放；不提供在线购买。
- **PRD-FR-061**：授权使用 rank 与 entitlement，名称、颜色、文案和价格不参与权限判断。
- **PRD-FR-062**：App 1.0 会员页展示获取方式、有效期、具体额度、接收主体、限制和条款；价格、续订和退款仅在未来在线购买启用后展示。
- **PRD-FR-063**：高等级默认继承低等级；到期后自动回落免费权限。
- **PRD-FR-064**：现有通用字段可远程配置；未知能力在旧客户端安全忽略。
- **PRD-FR-065**：心遇至心耀五级有效会员均具备 `direct_message.create` 和 `direct_message.send` 基础 entitlement；差异由额度和其他 entitlement 表达。

详细要求见 [心享会员、Entitlement 与管理员手动发放 PRD](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)。

### 5.8 金币与后续虚拟商品

- **PRD-FR-070**：金币不可提现、转账、兑换法币或用于概率商品。
- **PRD-FR-071**：App 1.0 仅展示余额和明细，不提供充值、赠礼或装扮消费入口。
- **PRD-FR-072**：后续礼物为固定价格的非提现互动商品，不向真人产生可提现收入。
- **PRD-FR-073**：后续头像框、主页皮肤和聊天皮肤支持预览、购买、装备、卸下、期限和下架处理。
- **PRD-FR-074**：管理员调币使用追加式账本、标准原因、用户说明、审计和高风险双人复核。
- **PRD-FR-075**：未来订单、扣币、赠礼和发货必须幂等；余额不足或失败时不产生部分扣款。

长期商业边界见 [心享会员、金币、礼物与个性装扮 PRD](../ways-of-work/plan/real-person-discovery-platform/heart-membership-and-virtual-commerce/prd.md)；App 1.0 可验收细节见 [金币钱包、追加式账本与管理员调币 PRD](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)。

### 5.9 通知、帮助和数据权利

- **PRD-FR-080**：App 1.0 通知中心按消息、互动、会员/金币、系统/安全和营销分类控制，使用站内拉取/实时刷新，不依赖系统推送。
- **PRD-FR-081**：交易、安全和账号通知不得因关闭营销通知而丢失。
- **PRD-FR-082**：用户可访问帮助、举报进度、申诉、隐私设置、数据导出和注销。

通知细节见 [站内通知中心与通知偏好 PRD](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md)；数据权利和安全处置分别见 [我的、隐私设置与数据权利 PRD](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md) 和 [举报、拉黑与安全审核 PRD](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)。

### 5.10 后台

- **PRD-FR-090**：App 1.0 后台包括真人导入、认证发布、标签地区、推荐位、代运营消息、举报审核、会员发放、调币复核和审计；商品、订单退款和认领模块按后续阶段启用。
- **PRD-FR-091**：认证、发布、代运营、财务、复核和审计使用独立角色，所有写操作记录原因和前后状态。
- **PRD-FR-092**：批量任务逐项幂等，单项失败不得重复处理已成功项目。

后台 taxonomy、推荐运营、安全审核、代运营、会员发放、调币和审计分别以 [A-04 PRD](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)、[A-05 PRD](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)、[A-07 PRD](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)、[A-06 PRD](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)、[A-08 PRD](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)、[A-10 PRD](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md) 和 [A-13 PRD](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md) 为详细验收依据。

## 6. 核心状态

### 6.1 真人资料

认证与发布使用两个独立状态轴，不能以单一状态同时表达证据结论和公开可见性。

认证轴：

```text
unverified → pending → verified
                    ├→ rejected
                    └→ unverified（退回补充）
verified → expired / revoked
expired/revoked → pending（重新提交）
```

发布轴：

```text
draft → pending_review → published
                       ├→ draft（退回）
                       └→ archived
published → suspended → draft/pending_review → published
published/suspended/draft → archived
```

只有认证有效、发布生效、用途授权有效且未被安全隐藏的同一资料版本可以进入公开投影。

### 6.2 会话运营模式

```text
platform_managed → handover_pending → person_managed
platform_managed/person_managed → suspended → active
active/suspended → closed
```

### 6.3 真人认领

```text
unclaimed → claim_submitted → identity_review
→ authorization_review → approved → handover_pending → claimed
```

认领状态变化不自动改变历史会话可见性。

## 7. 非功能要求

- **PRD-NFR-001**：所有对象级授权和受保护媒体访问在服务端执行。
- **PRD-NFR-002**：消息、订单、账本、礼物和批量任务具备幂等键和可重试语义。
- **PRD-NFR-003**：管理员写操作、运营主体变化和安全处置全量审计。
- **PRD-NFR-004**：配置、推荐规则和 entitlement 版本化、可灰度、可回滚。
- **PRD-NFR-005**：日志不包含私信正文、完整证件、支付凭证、精确位置或访问令牌。
- **PRD-NFR-006**：客户端覆盖加载、空、错误、离线、无权限、已下架、安全受限和强制升级状态。
- **PRD-NFR-007**：Android/iOS 支持屏幕阅读器、动态字体、高对比度和减少动态效果；Nuxt 管理后台支持键盘导航和缩放。
- **PRD-NFR-008**：关键服务定义可测 SLO、告警、降级和灾难恢复方案。

## 8. 指标框架

### 8.1 北极星指标

每周产生“有效深度互动”的去重观看者数。有效深度互动指关注后持续访问、创建合规会话并形成有效往返，或完成其他经产品定义的非刷量行为；不以消费金额或单纯消息数替代。

### 8.2 核心指标

- 供给：已认证发布真人数、授权完整率、审核时长、暂停/争议率。
- 发现：推荐覆盖率、详情访问率、搜索成功率、关注/收藏率、非个性化使用率。
- 私信：会员门槛转化、会话创建率、首次响应时长、有效往返率、关闭率。
- 1.0 会员与金币：各级手动发放、到期、私信使用、管理员调币和账本差异。
- 后续商业：购买/续订/退款、金币充值和消费、礼物/装扮使用、对账差异。
- 安全：举报率、拉黑率、代运营披露投诉、违规复犯率、误判申诉改判率。
- 认领：申请、核验、批准、交接和本人新会话响应。

### 8.3 反指标

- 未披露代运营投诉、授权缺失上线、重复扣费、账本不一致和越权访问必须为零容忍事件。
- 不以提高骚扰消息量、诱导高消费或隐藏退款路径换取增长。

## 9. 产品级验收

- **PRD-AC-001**：普通账号注册或被管理员发放会员后仍不会成为公开真人资料。
- **PRD-AC-002**：未认证或未发布资料在所有公开入口均不可见。
- **PRD-AC-003**：喜欢、关注和收藏不创建匹配或用户间聊天。
- **PRD-AC-004**：无有效会员时点击私信不创建会话，并展示完整会员与接收主体说明。
- **PRD-AC-005**：向未认领真人发送私信时，用户持续看到平台运营接收/回复标识。
- **PRD-AC-006**：管理员调币只产生新账本分录，用户可查看原因，历史不可编辑删除。
- **PRD-AC-007**：五级会员都可在 App 1.0 目录中展示和由管理员发放，服务端按 rank/entitlement 授权；客户端不存在在线支付入口。
- **PRD-AC-008**：真人认领后新会话路由本人，历史代运营消息不自动开放。
- **PRD-AC-009**：旧客户端安全忽略未知 entitlement，不崩溃也不扩大权限。
- **PRD-AC-010**：任一公开发布候选版本通过安全、隐私、目标商店、管理员账本、无障碍和恢复门禁；支付和推送门禁仅在对应能力启用时加入。

## 10. 文档关系

本文件是产品层总需求。App 1.0 的启用边界以 [发布范围 PRD](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md) 为准；模块可验收细节以 [Feature PRD 目录](../ways-of-work/plan/real-person-discovery-platform/README.md) 为准；技术边界以 [技术架构](./TECHNICAL_ARCHITECTURE.md)、[数据与迁移](./DATA_AND_MIGRATION.md) 和 [API 契约](./API_AND_REALTIME_CONTRACT.md) 为准。发生冲突时，先更新发布范围、产品蓝图和决策登记，再同步所有下游文档，禁止在实现中自行选择旧规则。
