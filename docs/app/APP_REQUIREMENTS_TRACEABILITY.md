# MeiGallery App 1.0 需求追踪矩阵

App 版本：1.0

更新时间：2026-07-30

状态：需求讨论中，待客户确认

## 1. 文档目的

本文把产品总需求、App 1.0 发布范围、Feature PRD、92 个 Page ID、146 张基础逐页原型与 23 张 Figma 最终状态原型建立确定性映射，并作为开发需求规格的追踪索引。任何页面或原型不得脱离需求编号单独成为实现依据；任何 App 1.0 用户可见需求也不得在没有 Page ID、明确非 UI 验收或未来范围说明的情况下进入开发。

## 2. 基线与冲突处理

1. 客户确认前，以产品总需求、App 1.0 发布范围和开放问题清单的当前结论共同约束下游设计。
2. 客户签署产品需求确认书后，以签署结论作为业务范围基线，再同步产品总需求、发布范围、Feature PRD、页面设计和原型。
3. Feature PRD 细化业务规则；Page ID 细化用户任务、状态和交互；原型图只证明视觉与状态表达，不自行增加功能。
4. 发生冲突时必须先修订上游需求并重新生成本矩阵，不允许开发、设计或测试自行选择较旧口径。

## 3. 覆盖统计

| 指标 | 数量 |
|---|---:|
| 产品页面 | 92 |
| 移动端页面 | 49 |
| 管理后台页面 | 43 |
| P0 / P1 / P2 | 54 / 31 / 7 |
| 默认状态原型 | 92 |
| P0 关键状态原型 | 54 |
| 基础逐页原型 | 146 |
| Figma 最终细化页面 | 5 |
| Figma 最终状态原型 | 23 |
| 清单原型映射总数 | 169 |
| 已建立需求追踪的页面 | 92 |

## 4. App 1.0 无页面范围

| 需求 | 处理方式 |
|---|---|
| PRD-FR-072、PRD-FR-073、PRD-FR-075 | 礼物、装扮和未来订单能力只保留长期需求，不创建 App 1.0 页面或可点击入口。 |
| SCP-FR-020～SCP-FR-024 | 在线商业化、系统推送、媒体消息、真人认领和普通用户桌面端属于未来阶段，不纳入 1.0 页面验收。 |
| SCP-FR-014 | 限量 Beta 供给门禁属于数据与运营验收，通过后台总览、供给清单和发布检查联合验证，不创建独立移动端页面。 |

## 5. 逐页需求追踪

### 移动端 · 启动与认证

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-AUTH-01 | 启动与会话恢复 | P0 | PRD-FR-001、PRD-FR-002、PRD-FR-003、PRD-FR-004 | SCP-FR-001、SCP-FR-013 | [F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-AUTH-02 | 登录 | P0 | PRD-FR-001、PRD-FR-002、PRD-FR-003、PRD-FR-004 | SCP-FR-001、SCP-FR-013 | [F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-AUTH-03 | 注册 | P0 | PRD-FR-001、PRD-FR-002、PRD-FR-003、PRD-FR-004 | SCP-FR-001、SCP-FR-013 | [F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-AUTH-04 | 风险验证 | P1 | PRD-FR-001、PRD-FR-002、PRD-FR-003、PRD-FR-004 | SCP-FR-001、SCP-FR-013 | [F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-AUTH-05 | 初始偏好 | P1 | PRD-FR-001、PRD-FR-002、PRD-FR-003、PRD-FR-004 | SCP-FR-001、SCP-FR-013 | [F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-AUTH-06 | 条款与隐私文档 | P0 | PRD-FR-001、PRD-FR-002、PRD-FR-003、PRD-FR-004 | SCP-FR-001、SCP-FR-013 | [F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |

### 移动端 · 发现与真人

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-DSC-01 | 推荐首页 | P0 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-05 推荐位、排序规则与热度运营](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)（ROP-FR-*） |
| APP-DSC-02 | 地区选择 | P0 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| APP-DSC-03 | 分类 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| APP-DSC-04 | 搜索 | P0 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| APP-DSC-05 | 筛选 | P0 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| APP-DSC-06 | 已保存条件 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| APP-DSC-07 | 真人详情 | P0 | PRD-FR-030、PRD-FR-031、PRD-FR-032 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*） |
| APP-DSC-08 | 媒体浏览 | P0 | PRD-FR-030、PRD-FR-031、PRD-FR-032 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*） |
| APP-DSC-09 | 认证说明 | P0 | PRD-FR-030、PRD-FR-031、PRD-FR-032 | SCP-FR-002、SCP-FR-003 | [F-02–F-05 真人发现、搜索与资料浏览](../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md)（DSP-FR-*）；[A-03 真人认证与发布审核](../ways-of-work/plan/real-person-discovery-platform/person-verification-and-publication/prd.md)（VER-FR-*） |

### 移动端 · 互动与历史

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-INT-01 | 关注更新 | P0 | PRD-FR-040、PRD-FR-041、PRD-FR-042 | SCP-FR-003 | [F-06 喜欢、关注、收藏与浏览历史](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md)（VIR-FR-*） |
| APP-INT-02 | 喜欢 | P0 | PRD-FR-040、PRD-FR-041、PRD-FR-042 | SCP-FR-003 | [F-06 喜欢、关注、收藏与浏览历史](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md)（VIR-FR-*） |
| APP-INT-03 | 收藏夹 | P1 | PRD-FR-040、PRD-FR-041、PRD-FR-042 | SCP-FR-003 | [F-06 喜欢、关注、收藏与浏览历史](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md)（VIR-FR-*） |
| APP-INT-04 | 收藏夹详情 | P1 | PRD-FR-040、PRD-FR-041、PRD-FR-042 | SCP-FR-003 | [F-06 喜欢、关注、收藏与浏览历史](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md)（VIR-FR-*） |
| APP-INT-05 | 浏览历史 | P1 | PRD-FR-040、PRD-FR-041、PRD-FR-042 | SCP-FR-003 | [F-06 喜欢、关注、收藏与浏览历史](../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md)（VIR-FR-*） |

### 移动端 · 平台话题与通知

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-MSG-01 | 平台话题 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056 | SCP-FR-005、SCP-FR-006、SCP-FR-007、SCP-FR-008、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| APP-MSG-02 | 发起话题确认 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056 | SCP-FR-005、SCP-FR-006、SCP-FR-007、SCP-FR-008、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| APP-MSG-03 | 话题会话 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056 | SCP-FR-005、SCP-FR-006、SCP-FR-007、SCP-FR-008、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| APP-MSG-04 | 会话设置 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056 | SCP-FR-005、SCP-FR-006、SCP-FR-007、SCP-FR-008、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| APP-MSG-05 | 通知列表 | P0 | PRD-FR-080、PRD-FR-081 | SCP-FR-009 | [F-12 站内通知中心与通知偏好](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md)（NTF-FR-*） |
| APP-MSG-06 | 通知详情 | P1 | PRD-FR-080、PRD-FR-081 | SCP-FR-009 | [F-12 站内通知中心与通知偏好](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md)（NTF-FR-*） |

### 移动端 · 会员与金币

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-MBR-01 | 五级会员目录 | P0 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066 | SCP-FR-004、SCP-FR-005、SCP-FR-005A、SCP-FR-005B | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| APP-MBR-02 | 当前权益 | P0 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066 | SCP-FR-004、SCP-FR-005、SCP-FR-005A、SCP-FR-005B | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| APP-MBR-03 | 会员申请与状态 | P0 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066 | SCP-FR-004、SCP-FR-005、SCP-FR-005A、SCP-FR-005B | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| APP-WAL-01 | 金币钱包 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074 | SCP-FR-010、SCP-FR-011 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| APP-WAL-02 | 金币明细 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074 | SCP-FR-010、SCP-FR-011 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| APP-WAL-03 | 金币分录详情 | P1 | PRD-FR-070、PRD-FR-071、PRD-FR-074 | SCP-FR-010、SCP-FR-011 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |

### 移动端 · 我的与设置

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-SET-01 | 我的 | P0 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |
| APP-SET-02 | 账号资料 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082、PRD-FR-001、PRD-FR-002 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*）；[F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-SET-03 | 设备管理 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082、PRD-FR-001、PRD-FR-002 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*）；[F-01 观看者注册、登录与设备安全](../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md)（ACC-FR-*） |
| APP-SET-04 | 隐私与推荐 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |
| APP-SET-05 | 站内通知偏好 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |
| APP-SET-06 | 拉黑名单 | P0 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*）；[A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |
| APP-SET-07 | 举报记录 | P0 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*）；[A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |
| APP-SET-08 | 申诉 | P0 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*）；[A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |
| APP-SET-09 | 数据导出 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |
| APP-SET-10 | 注销账号 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |
| APP-SET-11 | 帮助中心 | P0 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |
| APP-SET-12 | 关于与法律 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-082 | SCP-FR-013 | [F-13 我的、隐私设置与数据权利](../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md)（PDR-FR-*） |

### 移动端 · 系统状态

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| APP-SYS-01 | 强制升级 | P1 | PRD-FR-080 | SCP-FR-031、SCP-FR-032、SCP-FR-033 | [App 1.0 范围 发布范围与能力启用策略](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)（SCP-FR-*） |
| APP-SYS-02 | 服务维护 | P1 | PRD-FR-080 | SCP-FR-031、SCP-FR-032、SCP-FR-033 | [App 1.0 范围 发布范围与能力启用策略](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)（SCP-FR-*） |
| APP-SYS-03 | 账号受限 | P0 | PRD-FR-001、PRD-FR-002、PRD-FR-082 | SCP-FR-031、SCP-FR-032、SCP-FR-033 | [App 1.0 范围 发布范围与能力启用策略](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)（SCP-FR-*） |
| APP-SYS-04 | 对象不可用 | P0 | PRD-FR-013、PRD-FR-032 | SCP-FR-031、SCP-FR-032、SCP-FR-033 | [App 1.0 范围 发布范围与能力启用策略](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)（SCP-FR-*） |
| APP-SYS-05 | 地区不可用 | P1 | PRD-FR-020、PRD-FR-022 | SCP-FR-031、SCP-FR-032、SCP-FR-033 | [App 1.0 范围 发布范围与能力启用策略](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)（SCP-FR-*） |

### 管理后台 · 总览与异常

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-OV-01 | 运营总览 | P1 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014、SCP-FR-015 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |
| ADM-OV-02 | 异常中心 | P2 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014、SCP-FR-015 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |
| ADM-OV-03 | 异常详情 | P2 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014、SCP-FR-015 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |

### 管理后台 · 真人与内容

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-PER-01 | 真人列表 | P0 | PRD-FR-010、PRD-FR-011、PRD-FR-012、PRD-FR-013、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014 | [A-01–A-02 真人来源、上传与 MeiGallery 导入](../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md)（SRC-FR-*） |
| ADM-PER-02 | 手动新建真人 | P0 | PRD-FR-010、PRD-FR-011、PRD-FR-012、PRD-FR-013、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014 | [A-01–A-02 真人来源、上传与 MeiGallery 导入](../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md)（SRC-FR-*） |
| ADM-PER-03 | 真人工作台 | P0 | PRD-FR-010、PRD-FR-011、PRD-FR-012、PRD-FR-013、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014 | [A-01–A-02 真人来源、上传与 MeiGallery 导入](../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md)（SRC-FR-*） |
| ADM-PER-04 | 导入任务 | P0 | PRD-FR-010、PRD-FR-011、PRD-FR-012、PRD-FR-013、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014 | [A-01–A-02 真人来源、上传与 MeiGallery 导入](../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md)（SRC-FR-*） |
| ADM-PER-05 | 认证审核 | P0 | PRD-FR-010、PRD-FR-011、PRD-FR-012、PRD-FR-013、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014 | [A-03 真人认证与发布审核](../ways-of-work/plan/real-person-discovery-platform/person-verification-and-publication/prd.md)（VER-FR-*） |
| ADM-PER-06 | 发布审核 | P0 | PRD-FR-010、PRD-FR-011、PRD-FR-012、PRD-FR-013、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-014 | [A-03 真人认证与发布审核](../ways-of-work/plan/real-person-discovery-platform/person-verification-and-publication/prd.md)（VER-FR-*） |

### 管理后台 · 发现运营

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-TAX-01 | Taxonomy 目录树 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| ADM-TAX-02 | 词条详情 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| ADM-TAX-03 | 目录发布 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-04 标签、地区与分类目录管理](../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md)（TAX-FR-*） |
| ADM-REC-01 | 推荐规则版本 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-05 推荐位、排序规则与热度运营](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)（ROP-FR-*） |
| ADM-REC-02 | 推荐规则编辑 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-05 推荐位、排序规则与热度运营](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)（ROP-FR-*） |
| ADM-REC-03 | 推荐 Dry-run | P2 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-05 推荐位、排序规则与热度运营](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)（ROP-FR-*） |
| ADM-REC-04 | 运营精选 | P1 | PRD-FR-020、PRD-FR-021、PRD-FR-022、PRD-FR-023、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-030 | [A-05 推荐位、排序规则与热度运营](../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md)（ROP-FR-*） |

### 管理后台 · 平台话题运营

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-MSG-01 | 会话队列 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-007、SCP-FR-008、SCP-FR-012、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| ADM-MSG-02 | 会话工作台 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-007、SCP-FR-008、SCP-FR-012、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| ADM-MSG-03 | 分组与班次 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-007、SCP-FR-008、SCP-FR-012、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |
| ADM-MSG-04 | 会话质量与抽检 | P0 | PRD-FR-050、PRD-FR-051、PRD-FR-052、PRD-FR-053、PRD-FR-054、PRD-FR-055、PRD-FR-056、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-007、SCP-FR-008、SCP-FR-012、SCP-FR-015 | [F-07、A-06 会员平台话题、实时会话与运营工作台](../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md)（MOP-FR-*） |

### 管理后台 · 安全与申诉

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-SAF-01 | 安全审核队列 | P0 | PRD-FR-032、PRD-FR-080、PRD-FR-081、PRD-FR-082、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-015 | [A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |
| ADM-SAF-02 | 安全案件详情 | P0 | PRD-FR-032、PRD-FR-080、PRD-FR-081、PRD-FR-082、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-015 | [A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |
| ADM-SAF-03 | 申诉队列 | P0 | PRD-FR-032、PRD-FR-080、PRD-FR-081、PRD-FR-082、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-015 | [A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |
| ADM-SAF-04 | 申诉详情 | P0 | PRD-FR-032、PRD-FR-080、PRD-FR-081、PRD-FR-082、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012、SCP-FR-015 | [A-07 举报、拉黑与安全审核](../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md)（MOD-FR-*） |

### 管理后台 · 会员与金币

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-MBR-01 | 五级会员目录 | P1 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-004、SCP-FR-005、SCP-FR-005B、SCP-FR-012、SCP-FR-030 | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| ADM-MBR-02 | Entitlement 定义 | P1 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-004、SCP-FR-005、SCP-FR-005B、SCP-FR-012、SCP-FR-030 | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| ADM-MBR-03 | 会员申请与发放队列 | P0 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-004、SCP-FR-005、SCP-FR-005B、SCP-FR-012、SCP-FR-030 | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| ADM-MBR-04 | 会员发放申请 | P0 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-004、SCP-FR-005、SCP-FR-005B、SCP-FR-012、SCP-FR-030 | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| ADM-MBR-05 | 会员发放复核 | P0 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-004、SCP-FR-005、SCP-FR-005B、SCP-FR-012、SCP-FR-030 | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| ADM-MBR-06 | 旧会员映射 | P1 | PRD-FR-060、PRD-FR-061、PRD-FR-062、PRD-FR-063、PRD-FR-064、PRD-FR-065、PRD-FR-066、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-004、SCP-FR-005、SCP-FR-005B、SCP-FR-012、SCP-FR-030 | [F-09、A-08 心享会员、Entitlement 与管理员手动发放](../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md)（MBR-FR-*） |
| ADM-WAL-01 | 钱包查询 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-010、SCP-FR-012 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| ADM-WAL-02 | 钱包详情 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-010、SCP-FR-012 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| ADM-WAL-03 | 调币申请 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-010、SCP-FR-012 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| ADM-WAL-04 | 调币复核 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-010、SCP-FR-012 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| ADM-WAL-05 | 批量调币任务 | P2 | PRD-FR-070、PRD-FR-071、PRD-FR-074、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-010、SCP-FR-012 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |
| ADM-WAL-06 | 钱包对账差异 | P0 | PRD-FR-070、PRD-FR-071、PRD-FR-074、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-010、SCP-FR-012 | [F-10、A-10 金币钱包与管理员调币](../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md)（WAL-FR-*） |

### 管理后台 · 通知与审计

| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |
|---|---|---|---|---|---|
| ADM-NTF-01 | 通知事件定义 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-009、SCP-FR-012 | [F-12 站内通知中心与通知偏好](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md)（NTF-FR-*） |
| ADM-NTF-02 | 通知模板版本 | P1 | PRD-FR-080、PRD-FR-081、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-009、SCP-FR-012 | [F-12 站内通知中心与通知偏好](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md)（NTF-FR-*） |
| ADM-NTF-03 | 通知生成结果 | P2 | PRD-FR-080、PRD-FR-081、PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-009、SCP-FR-012 | [F-12 站内通知中心与通知偏好](../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md)（NTF-FR-*） |
| ADM-AUD-01 | 审计查询 | P0 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |
| ADM-AUD-02 | 审计详情 | P0 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |
| ADM-AUD-03 | 审计完整性状态 | P2 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |
| ADM-AUD-04 | 受控导出 | P2 | PRD-FR-090、PRD-FR-091、PRD-FR-092 | SCP-FR-012 | [A-13 运营看板、审计日志与异常追踪](../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md)（OAU-FR-*） |

## 6. 逐页同步验收

- 每个 Page ID 必须同时存在页面目录、详细功能说明、默认状态原型和需求追踪键。
- 54 个 P0 页面必须额外存在一张关键异常、受限、冲突或处理中状态原型。
- `APP-MSG-05`、`APP-MSG-06`、`APP-WAL-01`、`APP-WAL-02`、`APP-WAL-03` 必须完整包含 23 个 Figma 最终状态；每个状态都具备唯一 Frame ID、触发条件、关键交互、预期结果、权威边界和本地导出图。
- Page ID、页面名称、优先级、默认状态、关键状态、图片文件名和需求追踪键由同一清单生成并自动校验。
- `ADM-AUD-03` 的完整可视化页面属于 P2；审计完整性的最小自动校验与告警属于 P0 后端门禁，两者不得混为同一页面优先级。
- 客户意见、设计修改、研发任务和测试用例必须引用 Page ID；涉及业务规则变化时还必须引用对应 PRD/SCP 需求编号。
- 最终开发入口为 `MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md`；其 Page ID、需求追踪和原型引用必须与本矩阵及 `manifest.json` 完全一致。
