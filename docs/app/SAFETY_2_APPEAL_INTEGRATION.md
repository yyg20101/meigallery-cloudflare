# Safety-2 举报结论申诉跨端集成边界

App 版本：1.0

App API 契约版本：1.7.0

更新日期：2026-08-07

状态：默认关闭的开发基线；未经策略发布、数据保留决策、验证和人工开启，不得用于生产

## 1. 阶段目标

Safety-2 在 Message-2 举报闭环之上增加 `APP-SET-08`、`ADM-SAF-03` 与 `ADM-SAF-04` 的最小可落地纵向切片：观看者可对本人举报的“未发现违规”结论申请一次独立复核，管理员可在与原审核人隔离的条件下领取、查看和形成复核结论。

本阶段只处理 `report_no_violation_review`。账号限制、金币分录、会员、数据权利或其他争议仍属于各自领域，后续必须以独立来源类型、状态机和权限规则接入，不能复用本阶段接口伪造已支持能力。

## 2. 产品规则

### 2.1 用户资格

- 仅登录账号可以对自己提交的举报发起申诉。
- 原举报必须处于 `no_violation`，且客户端提交的 `expectedReportVersion` 必须等于服务端当前举报版本。
- 同一举报的同一结论版本只允许一个申诉；幂等重放返回原结果，不重复创建案件。
- 开发策略暂定申诉窗口为结论后 30 个自然日、说明最多 500 个字符。30 天只是开发参数，不是生产承诺。
- 用户只能填写文字说明，不上传图片、视频、证件或其他新媒体证据。
- 申诉不自动改变原结论，不自动触发封禁、下架、扣币、解封或其他处置。

### 2.2 用户可见状态

| 状态 | 用户文案含义 | 可执行操作 |
|---|---|---|
| `submitted` | 已收到复核申请 | 查看进度 |
| `processing` | 独立复核中 | 查看进度 |
| `upheld` | 复核后维持原结论 | 查看结论 |
| `changed` | 复核后已重新进入审核 | 返回举报详情 |
| `closed` | 复核已结束 | 查看结论 |

用户端不显示管理员身份、内部备注、优先级、风控规则、证据摘要、审核分配或其他账号信息。

### 2.3 独立复核

- 原举报最后一次形成 `no_violation` 结论的管理员不得领取或处理对应申诉。
- 未领取申诉不得读取用户申诉说明或原举报最小证据。
- 读取详情必须声明 `accessReason=appeal_review`，并写入审计日志。
- 管理员可选择 `upheld`（维持原结论）或 `changed`（重新审核），且必须填写 1–300 字用户可见说明。
- `changed` 只把原举报原子地恢复为 `investigating`、转交当前独立复核人并写入举报时间线；后续仍由既有举报审核流程形成实际结论和安全动作。
- 申诉结论和原举报后续结论分别留痕，不覆盖或删除历史事件。

## 3. API 契约

### 3.1 Bootstrap

- `capabilities.safety.appeals`：用户申诉能力是否可见、可执行。
- `safety.appealPolicyVersion`：当前策略稳定标识；能力关闭时仍可用于兼容诊断。
- `safety.maxAppealStatementLength`：当前客户端可接受的最大说明长度。

能力只有在 Auth、Message-2 安全能力和 Safety-2 用户开关全部满足时才返回 `true`。生产环境还必须同时通过申诉策略、保留策略与 production-ready 门禁。

### 3.2 观看者接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v2/appeals` | 创建本人举报结论申诉；要求 `Idempotency-Key` |
| `GET` | `/api/v2/me/appeals` | 游标分页读取本人申诉摘要 |
| `GET` | `/api/v2/me/appeals/{appealId}` | 读取本人申诉详情和用户可见时间线 |
| `GET` | `/api/v2/me/reports/{reportId}` | 增加服务端权威 `appeal` 资格与关联状态 |

创建请求：

```json
{
  "reportId": "rpt_xxx",
  "expectedReportVersion": 3,
  "statement": "请复核该举报结论。"
}
```

客户端不得只根据本地举报状态显示可提交按钮，必须使用举报详情返回的 `appeal.canAppeal`。提交冲突后应刷新举报详情和申诉列表。

### 3.3 管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/app/safety/appeals` | 读取不含申诉正文的队列摘要 |
| `POST` | `/api/admin/app/safety/appeals/{appealId}/claim` | 独立复核人领取案件 |
| `GET` | `/api/admin/app/safety/appeals/{appealId}?accessReason=appeal_review` | 领取后读取详情并审计 |
| `POST` | `/api/admin/app/safety/appeals/{appealId}/decision` | 提交 `upheld` 或 `changed` 结论 |

领取和结论写入都要求 `Idempotency-Key`；结论还要求 `expectedVersion`，避免并发覆盖。

## 4. 数据与审计

- `app_safety_appeal_policies`：版本化申诉窗口、说明长度、次数和保留策略依赖。
- `app_safety_appeals`：案件当前投影；唯一键约束举报、原结论版本和申诉类型。
- `app_safety_appeal_events`：仅追加状态时间线。
- `app_safety_appeal_idempotency`：创建、领取和结论的幂等结果。
- 后台领取、详情读取和结论必须写入 `admin_audit_logs`；审计只保存 ID、状态、版本、说明长度和摘要，不复制申诉正文或举报证据。
- 当前申诉策略关联 `srp_message_2_unresolved_dev_1`。保留期限仍未决，因此开发策略必须保持 `development + production_ready=0`。

## 5. 开发联调与生产门禁

新增四个显式变量。production 根环境全部保持关闭：

- `APP_SAFETY_APPEALS_ENABLED=false`
- `APP_SAFETY_APPEALS_ADMIN_ENABLED=false`
- `APP_SAFETY_APPEAL_POLICY_VERSION=sap_app_1_0_safety_2_dev_1`
- `APP_SAFETY_APPEALS_PRODUCTION_READY=false`

dev 为内部端到端联调只把用户端与管理员端开关设为 `true`，策略版本仍为 `sap_app_1_0_safety_2_dev_1`，`APP_SAFETY_APPEALS_PRODUCTION_READY` 保持 `false`。联调使用随机隔离数据并在结束后清理，不导入真实用户、举报或申诉数据；该配置不得复制到 production。

生产开放前必须全部满足：

1. Message-2 用户端、后台端和 production-ready 安全门禁已通过。
2. 申诉策略为 `published + production_ready=1`。
3. 关联保留策略为 `published + approved + production_ready=1`，清理与法律保留流程已验收。
4. 至少两名具备安全审核权限的管理员可形成原审核人与独立复核人隔离。
5. API、Nuxt、KMP、D1 migration、权限、并发、幂等、审计和回滚验证全部通过。
6. 由 Owner 人工开启用户端与后台端开关；不得通过 migration 自动开启。

## 6. 页面交互

### 6.1 `APP-SET-08` 申诉

- 入口：本人举报详情中的服务端资格卡，以及“我的 → 举报与申诉”。
- 创建态：展示原举报安全引用、原结论、独立复核说明、500 字计数器和单一主按钮“申请复核”。
- 提交中：按钮锁定并显示进度；保留输入，不允许重复触发。
- 已有案件：展示状态、用户可见说明和时间线；不再显示可编辑输入框。
- 不可申诉：显示服务端原因和返回举报详情操作，不显示失效按钮伪装可用。
- 错误：网络错误保留输入并允许重试；版本冲突或已存在案件时刷新权威状态。

### 6.2 `ADM-SAF-03` 申诉队列

- 默认只显示待处理案件，列表不含用户申诉正文。
- 支持状态筛选；行内展示案件 ID、原举报 ID、提交时间、当前状态和是否由本人领取。
- 原审核人看到“职责隔离，不能领取”，且服务端必须再次拒绝。

### 6.3 `ADM-SAF-04` 申诉详情

- 未领取时只展示摘要和领取动作，不读取正文与证据。
- 本人领取后，以“原结论 → 用户说明 → 最小证据 → 复核结论”顺序展示。
- `upheld` 和 `changed` 均要求二次确认与用户可见说明；提交中禁用所有结论按钮。
- 并发冲突后刷新最新版本，不保留可再次误提交的旧确认状态。

## 7. 本阶段不实现

- 账号限制、金币、会员、数据导出或注销申诉。
- 用户补充媒体证据、管理员请求补充材料、内部备注、转派、撤回和升级队列。
- 自动改判为具体安全动作、自动解除限制或自动恢复内容。
- 系统推送、实时通道、对外 SLA 承诺、自动清理和生产数据回填。
- production migration、production 部署、production 开关修改或任何真实业务 seed。

## 8. 验收重点

- 非本人、非 `no_violation`、过期、版本冲突和重复结论版本均不能创建申诉。
- 原审核人不能领取；未领取人不能读正文、证据或形成结论。
- 幂等重放返回相同案件；不同请求体复用同一幂等键返回冲突。
- `changed` 在同一 D1 batch 中完成申诉结论、举报重开、两条事件和审计；任一失败不产生部分状态。
- 用户接口始终不泄露管理员、内部原因、证据摘要和其他账号信息。
- 所有开关关闭时，Bootstrap 不暴露入口，读写接口拒绝执行，既有 Message-2 能力不回退。

## 9. dev 联调记录

2026-08-07 已在独立 Cloudflare dev 资源完成首次远端闭环：

- 发布提交：`5cf79df`；API Version `810987bc-6942-4eb3-b555-412a84c4ca8a`，Web Version `462b215d-3c5e-4cc4-ac4a-f0252ba3d02c`。
- dev D1 因此前落后，按依赖顺序一次连续应用 `0063–0074`，完成后 `wrangler d1 migrations list` 返回无待执行项。
- migration 前 SQL 备份为 `meigallery-db-dev-before-safety2-20260807-5cf79df.sql`，大小 464,296 bytes，SHA-256 为 `34a939814eb8e6a0f88509969b819cae5f623cefc7877c7db2053a4e437f3e5c`；迁移前 Time Travel bookmark 为 `00000041-00000000-000050c0-d2ceb922bd36080310b032df43b1d10f`。
- 部署前 API/Web Worker Version 分别为 `2159eea3-cea7-4ed5-bbd7-208ff6f471c5` 与 `035612a1-7b95-44c3-912e-02b4c58d664f`，保留为应用层回滚点；D1 回退必须使用上述备份或 bookmark，不能只回滚 Worker。
- `corepack pnpm verify:safety2:dev` 已真实通过“观看者举报 → 原审核员结论 → 原审核员申诉领取被拒 → 独立审核员领取/读取 → 改判 → 举报重开”及 7 类审计验证；结束后隔离用户、图库、人物、举报、申诉残留均为 0。
- `changed` 会把举报推进到新的 `investigating` 版本。已完成申诉继续通过 `/api/v2/me/appeals/{appealId}` 展示 `changed`；新举报版本的 `appeal` 返回 `REPORT_NOT_ELIGIBLE`，不能把上一结论的申诉误绑定到新版本。
- production `/api/v2/app/bootstrap` 仍返回 404，production 配置中的 Auth、举报、申诉及 production-ready 开关均保持关闭。
