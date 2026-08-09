# Operations-1 运营总览、事件处置与跨域安全控制开发基线

更新时间：2026-08-10

App 版本：1.0

状态：开发闭环完成；配置、migration 执行与专项测试后置

## 1. 本阶段结论

Operations-1 已完成 `ADM-OV-01/02/03` 的 Cloudflare 与 Nuxt 开发闭环：

- `/admin/app`：App 全局运营总览、指标质量、事件摘要和安全控制状态。
- `/admin/app/incidents`：按状态、严重级别、业务域、事件类型和负责人筛选的事件中心。
- `/admin/app/incidents/{incidentId}`：领取、追加记录、状态迁移、Runbook 关联、关闭证据和安全控制影响确认。
- `/api/admin/app/operations/*`：总览、快照、检测、事件、Runbook 与安全控制管理 API。
- `0092_app_operations_and_incidents.sql`：版本化指标、不可变快照、检测运行、事件工作流、Runbook、五类安全控制和管理员幂等命令。

本阶段没有扩展 App API v2，也没有向 KMP 暴露运营数据。`admin_audit_logs` 继续是唯一管理员审计事实源；运营表只保存指标快照、检测结果、事件工作流与安全控制业务事实。

## 2. 产品与数据边界

### 2.1 当前只支持全局运营范围

首个实现只允许 `scope_key=global`，不开放地区、用户、操作员或任意交叉维度。这样可以先验证指标来源和异常处置，不提前产生小样本识别风险。

### 2.2 未知绝不显示为零

每项指标必须携带以下质量状态之一：

| 状态 | 含义 | 数值展示 |
|------|------|----------|
| `known` | 来源查询成功，且快照仍在新鲜度范围内 | 显示数值 |
| `unknown` | 未运行、来源查询失败或缺少采集器 | `—` |
| `delayed` | 原值存在，但快照已超过新鲜度 SLO | `—` |
| `partial` | 来源只覆盖部分范围 | `—` |
| `invalid` | 来源返回不符合口径的结果 | `—` |
| `unconfigured` | Cloudflare 可观测来源尚未连接 | `—` |

页面和 API 都不会把 `unknown`、`delayed`、`partial`、`invalid` 或 `unconfigured` 转为 `0`。总览没有快照时显示“尚未生成”，检测器尚未运行也不等于不存在异常。

### 2.3 未来能力不占位

当前总览不包含支付、礼物、装扮、系统推送或真人认领指标。只有对应 Feature 正式实现、登记口径、确定保留策略并通过生产门禁后，才能以新指标定义版本加入。

### 2.4 不提供个人排行

总览不返回个人消息量、金币余额、消费、偏好、举报次数或操作员刷量排行。钱包异常只暴露内部稳定钱包 ID 和聚合事实，不返回账号识别信息或分录正文。

## 3. 数据结构

### 3.1 指标定义与快照

| 表 / View | 责任 |
|-----------|------|
| `app_operational_metric_definitions` | 追加式指标定义，`metric_key + schema_version` 唯一 |
| `app_operational_current_metric_definitions` | 每个指标最高 active 版本 |
| `app_operational_metric_runs` | 一次人工快照运行及质量摘要 |
| `app_operational_metric_snapshots` | 每个运行、定义和范围的不可变值与质量状态 |

`0092` 登记 18 项首批指标，覆盖人物供给、发现推荐、平台话题、会员、钱包、通知、安全、审计和平台健康。所有定义的保留决策仍为 `unresolved`、`production_ready=0`；界面会显式显示“生产口径未就绪”。Cloudflare Worker、D1 和 R2 技术指标当前为 `unconfigured`，不伪造数据。

### 3.2 Runbook 与事件

| 表 / View | 责任 |
|-----------|------|
| `app_operational_runbook_versions` | 不可变 Runbook 版本与文档引用 |
| `app_operational_current_runbooks` | 每个 Runbook 的最高 active 版本 |
| `app_operational_detection_runs` | 一次检测运行、可用/未接入检测器统计和证据摘要 |
| `app_operational_detection_findings` | 检测运行与事件的不可变关联 |
| `app_operational_incidents` | 事件当前状态、负责人、影响、版本与关闭结论 |
| `app_operational_incident_events` | 只追加的处置时间线 |

事件状态机：

```text
open → acknowledged → investigating → mitigated → resolved
  ├───────────────→ false_positive
  └───────────────→ resolved

mitigated → investigating
resolved / false_positive → open（新检测信号重新打开）
```

关闭为 `resolved` 或 `false_positive` 时必须同时写入稳定原因码、结论摘要和证据引用。原时间线不能编辑或删除；后续检测再次命中同一 `incident_key` 时追加新信号，已关闭事件会重新打开。

### 3.3 安全控制与幂等

| 表 | 责任 |
|----|------|
| `app_operational_safety_controls` | 五个安全控制的当前状态和乐观版本 |
| `app_operational_safety_control_events` | 暂停/恢复的不可变事件 |
| `app_operational_admin_commands` | 绑定管理员、操作和请求哈希的幂等结果 |

安全控制使用 `available / paused`，其中 `available` 只代表“未因运营事件暂停”，不代表底层 Feature 已配置或获准生产启用。所有事件与控制更新都使用 `expectedVersion` 和 D1 条件写入；并发失败不生成假事件、假审计或孤立命令。

## 4. 指标与检测器范围

### 4.1 首批指标

| 业务域 | 当前指标 |
|--------|----------|
| 人物供给 | 可公开人物、待发布复核 |
| 发现推荐 | 生效推荐规则、生效平台精选 |
| 平台话题 | 待领取话题、待处理安全升级 |
| 会员 | 有效会员发放、待复核会员变更 |
| 钱包 | 待复核金币调整、钱包快照不一致 |
| 通知 | 待投递站内通知、通知死信 |
| 安全 | 待处理举报、待处理申诉 |
| 审计 | 最近一次审计完整性检查发现 |
| 平台 | Worker 错误率、D1 P95 延迟、R2 错误率（均未配置） |

### 4.2 已接入检测器

| 检测 | 事件级别 | 当前动作 |
|------|----------|----------|
| 仍可见人物不满足授权/认证/发布/来源资格 | P0 | 创建/刷新事件 |
| 平台运营消息缺少实际操作员事实 | P1 | 创建/刷新事件 |
| 完全重复的有效会员 grant 区间 | P1 | 创建/刷新事件 |
| 钱包快照与不可变账本末条不一致 | P1 | 创建独立钱包事件并冻结对应 active 钱包 |
| 已生效金币调整缺少独立复核 | P1 | 创建/刷新事件 |
| 最近审计完整性检查存在发现 | P1 | 创建按检查 ID 区分的事件 |
| 审计载荷发现敏感字段 | P1 | 创建按检查 ID 区分的事件 |
| 通知 dead letter 或超出恢复窗口 | P2 | 创建/刷新事件 |

钱包检测只执行保护性冻结，不自动补账、不改写分录、不推测正确余额。恢复和修复必须回到钱包受控流程。

### 4.3 明确未接入的检测器

当前运行固定报告 3 类未接入检测器：

- 会员到期未撤权。
- 数据权利请求逾期。
- Cloudflare 平台健康异常。

这些范围不会显示为零；检测运行状态保持 `partial`，直到后续阶段接入稳定来源。

## 5. 五类跨域安全控制

| 控制 key | 暂停后阻断 | 保持允许 |
|----------|------------|----------|
| `person_publication` | 提交人物发布复核、批准人物公开发布 | 暂停/下线、授权或认证撤销、发布退回 |
| `recommendation_delivery` | 激活推荐规则、激活精选、推荐 Feed 投放 | 暂停规则/排期、Dry-run、回滚与调查 |
| `operator_messaging` | 平台运营发送新消息 | 领取、转派、查看历史、内部备注、安全升级、关闭话题 |
| `membership_grants` | 直接会员发放、批准发放型会员变更 | 拒绝、撤销会员、查看历史和申请 |
| `wallet_adjustments` | 创建金币调整、批准金币调整 | 拒绝申请、查看账本和对账 |

所有控制同时具备两层保护：服务入口先 fail-closed 读取控制，实际写 SQL 再以 `EXISTS ... state='available'` 原子重验，避免检查与提交之间被暂停。控制表缺失、记录缺失或状态非法时，同样按不可用阻断高风险写操作。

暂停只允许未关闭的 P0/P1 事件，且仅 Owner 可执行。恢复只能从最初暂停该控制的事件执行，并强制填写验证证据引用。暂停与恢复都会同时推进控制版本、事件版本、追加控制事件、追加事件时间线并写入 `admin_audit_logs`。

## 6. 管理 API

所有响应使用 `Cache-Control: private, no-store`。写操作要求 16–128 位 `Idempotency-Key`；事件和控制变更要求对应的 `expectedVersion`。

| 方法与路径 | 权限 | 说明 |
|------------|------|------|
| `GET /api/admin/app/operations/overview` | admin / Owner | 读取全局总览 |
| `POST /api/admin/app/operations/overview/refresh` | Owner | 生成不可变指标快照 |
| `POST /api/admin/app/operations/detections` | Owner | 人工运行异常检测 |
| `GET /api/admin/app/operations/runbooks` | admin / Owner | 读取当前 Runbook 版本 |
| `GET /api/admin/app/operations/incidents` | admin / Owner | 筛选与游标分页事件 |
| `GET /api/admin/app/operations/incidents/:incidentId` | admin / Owner | 读取详情并记录调查用途审计 |
| `POST .../:incidentId/claim` | admin / Owner | 领取未关闭、未分配事件 |
| `POST .../:incidentId/notes` | 负责人 / Owner | 追加处置记录 |
| `POST .../:incidentId/status` | 负责人 / Owner | 按状态机迁移；关闭需证据 |
| `POST .../:incidentId/runbook` | 负责人 / Owner | 关联固定 Runbook 版本 |
| `GET .../safety-controls/:controlKey/preview` | admin / Owner | 只读影响与阻断原因预览 |
| `POST .../safety-controls/change` | Owner | 暂停或带证据恢复安全控制 |

当前仓库只有 `admin / owner` 两级管理员角色，因此首个实现采用保守映射：所有管理员可读全局摘要与事件；普通管理员需领取后才能写当前事件；Owner 可跨事件处置，并独占快照、检测和安全控制。未来细分角色只能通过服务端 capability + scope 收紧或授权，不得依赖前端隐藏按钮。

## 7. 页面交互

### 7.1 `ADM-OV-01` 运营总览

- 展示总状态、快照时间、未知指标数量、P0/P1/未分配事件和已暂停控制。
- 每个专题显示指标质量与治理状态；非 `known` 数值显示 `—`。
- Owner 可在显式确认后人工生成快照或运行检测。
- 事件摘要和安全控制可以直接进入关联事件。
- 首个实现固定全局范围，不伪装尚未实现的时间/地区切换。

### 7.2 `ADM-OV-02` 事件中心

- 支持状态、P0–P3、九个业务域、十一类事件类型和负责人范围筛选。
- 使用绑定筛选的服务端游标分页，筛选变化必须重新应用。
- 桌面为结构化行，窄屏自动线性排列；长标题、摘要和稳定 ID 均换行或截断，不撑破容器。
- 空态明确提示“检测尚未运行不等于没有异常”。

### 7.3 `ADM-OV-03` 事件详情

- 展示事件事实、影响、负责人、Runbook、关闭结论和倒序不可变时间线。
- 普通管理员未领取时只读；领取后可追加处置记录和更新状态。
- 关闭表单动态要求结论摘要和证据；并发版本冲突要求刷新后重试。
- 安全控制必须先打开影响对话框，分别列出“将被阻断”和“保持可用”，再提交原因和证据。
- 对话框、表单和按钮在窄屏单列，避免按钮、长引用和说明越界。

## 8. 审计、安全与隐私

- `admin_audit_logs` 仍是唯一管理员审计事实源；Operations-1 不创建第二套审计事件。
- 快照、检测、详情读取、领取、记录、状态、Runbook、安全控制和钱包保护性冻结均写审计。
- 审计 before/after 只保存状态、版本、稳定原因、内容摘要和引用，不复制处置正文或个人数据。
- 事件详情读取固定标记 `operational_investigation`，并写 request/trace 和业务引用上下文。
- 事件时间线中的处置说明是运营业务事实，不进入总览、列表、技术日志或客户端。
- 所有运营管理 API 禁止缓存；公开 API 与管理员 API 严格分离。

## 9. Runbook

以下 Runbook 是 `0092` 初始版本的文档目标。版本升级必须新增数据库版本并指向新文档锚点，不能原地改变历史事件依据。

<a id="runbook-publication-safety"></a>
### 9.1 人物发布异常处置

1. 固定事件 ID、检测运行 ID、影响数量和当前可见投影清单引用。
2. 核对人物投影的认证、发布状态、用途授权及有效期、来源图库状态。
3. P0/P1 且影响仍持续时，Owner 预览并暂停 `person_publication`；必要时通过既有人物工作台下线异常投影。
4. 不在事件中心补造授权或认证事实，也不把无资格人物自动改为合格。
5. 修复后重新验证公开查询、投影与来源图库；保存稳定验证引用。
6. 有证据后恢复控制；关闭事件并记录结论。若推荐已暴露异常人物，单独评估 `recommendation_delivery`。

<a id="runbook-operator-identity"></a>
### 9.2 运营身份异常处置

1. 固定缺失事实的消息引用、话题引用和检查摘要，不复制消息正文。
2. 核对实际操作员、有效 assignment、披露版本和 `platform_operator` sender 类型。
3. 影响持续时暂停 `operator_messaging`；查看、转派、安全升级和关闭仍保持可用。
4. 不创建伪造操作员事实，不把平台消息改写为真人发送。
5. 验证新回复能在同一 D1 批次写消息与操作员事实后，保存证据并恢复控制。

<a id="runbook-membership-integrity"></a>
### 9.3 会员发放完整性处置

1. 固定账号内部引用、目录、tier、起止区间、grant 和复核申请引用，不在事件中复制联系方式。
2. 区分重复发放、到期解析、复核缺失和业务单号重放。
3. P0/P1 时暂停 `membership_grants`；拒绝、撤销和查看仍保持可用。
4. 不直接编辑 grant；需要失效时使用追加式撤销。
5. 重新计算本人最高有效 rank 和 entitlement，确认无重复执行后再恢复控制并关闭事件。

<a id="runbook-wallet-reconciliation"></a>
### 9.4 钱包账本对账处置

1. 保留事件、钱包 ID、当前 balance/sequence 和末条 posted 分录引用。
2. 检测器已冻结不一致的 active 钱包；不得手工解冻后继续调币。
3. 暂停 `wallet_adjustments` 时只阻断创建与批准，拒绝和只读对账仍可用。
4. 不直接改余额，不删除或改写分录，不用自动补账掩盖差异。
5. 通过新的受控冲正/补偿流程恢复事实一致，独立复核后再次核对余额、sequence 与末条分录。
6. 保存对账证据后恢复控制并关闭事件；钱包解冻必须由后续正式恢复流程明确实现。

<a id="runbook-audit-integrity"></a>
### 9.5 审计完整性缺口处置

1. 固定完整性检查 ID、sequence 范围、manifest 版本与 SHA-256。
2. 区分序号缺口、索引缺失、载荷异常、敏感字段、未登记 Action 和业务事实缺审计。
3. 保护原始 D1 与备份，不自动补写或重排 `admin_audit_logs`。
4. 只通过后续追加事件记录调查和纠正；需要业务修复时回到原业务工作流。
5. 同范围重新检查并验证 manifest 后，保存证据并关闭事件。

<a id="runbook-notification-recovery"></a>
### 9.6 通知积压恢复

1. 固定 Outbox 状态、租约、重试次数、`next_attempt_at` 和 dead letter 聚合，不读取业务正文。
2. 核对策略、事件定义、模板、账号偏好和受控目标资格。
3. 清理失效租约或恢复消费者前，确认不会重复创建同一稳定通知。
4. dead letter 重试必须重新验证必要性、偏好、对象状态和 capability，不能盲目重放。
5. 积压恢复并验证未读/详情目标后记录证据和关闭事件。

<a id="runbook-privacy-response"></a>
### 9.7 数据权利与隐私事件处置

1. 只保存案件引用、法务/隐私负责人、截止时间和最小范围，不把请求正文或身份材料复制进事件。
2. 按首发地区规则核对访问、导出、注销、限制处理或纠正请求的正式时限。
3. 证据访问使用案件级授权；运营总览只展示聚合与逾期状态。
4. 暂停或删除数据前确认权威事实、法定保留和关联业务完整性，不从看板直接执行不可逆动作。
5. 完成响应、交付或合法拒绝后保存受控证据引用并关闭事件。

## 10. 开发结束后统一完成

当前明确后置，不在本阶段执行：

- 在目标环境执行 `0092_app_operations_and_incidents.sql` 与 Audit-3 `0093_app_audit_action_registry_governance.sql`，并核对 `0090/0091/0092/0093` 顺序。
- 通过 Audit-3 受控工作区由不同 Owner 逐项批准正式 Action；另行批准治理策略、指标、可见角色、保留和物理清理政策，不做自动批量发布。
- 接入 Cloudflare Workers、D1、R2 可观测数据，并消除对应 `unconfigured`。
- 为快照、检测和恢复验证配置受控调度；运行期事件不得成为紧急修复部署门禁。
- 设计钱包解冻、会员到期、数据权利逾期和平台健康检测器。
- 执行 migration 验证、D1 状态机/并发/幂等测试、五个真实写路径的暂停/恢复测试、HTTP 权限测试、Nuxt 响应式与无障碍验收。
- 完成 dev 远端联调、恢复演练和 production 发布决策。

在以上事项完成前，代码存在不等于目标环境已可用，更不代表允许生产启用或对外扩量。
