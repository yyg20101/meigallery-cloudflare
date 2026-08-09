# Audit-3 Action 口径治理与独立发布开发基线

更新时间：2026-08-10

App 版本：1.0

状态：开发闭环完成；配置、migration 执行与专项测试后置

## 1. 本阶段结论

Audit-3 已完成 Action Registry 的受控治理闭环，补齐 Audit-1 只定义数据结构但没有正式管理入口的问题：

- `/admin/app/audit/registry`：发现真实审计 Action、识别未登记或冲突口径、创建候选版本、预览历史影响并提交独立复核。
- `/admin/app/audit/registry/requests/{requestId}`：查看提交基线、当前权威状态、职责分离、复核结论和不可变时间线。
- `/api/admin/app/audit/registry/*`：Owner-only 总览、Action 发现、预览、申请、详情和独立复核 API。
- `0093_app_audit_action_registry_governance.sql`：版本化治理策略目录、生产可见 Registry、口径变更申请、不可变事件和幂等命令。
- Audit-1 查询、详情、关联时间线和 Audit-2 受控导出已统一接入 `app_audit_production_action_registry`。

本阶段不新增第二套审计事实，不自动登记任何 Action，不 seed 保留或质量策略，不执行 migration，不修改 production 配置，也不运行专项测试。

## 2. 唯一事实与治理边界

- `admin_audit_logs` 继续是唯一管理员审计事实源；Registry 只是对 Action 的版本化语义和访问治理覆盖层。
- 发布口径可以让既有事实按新定义显示展示名、业务域、风险和责任引用，但不能更新、删除或复制既有审计事实。
- Action 定义、治理策略、申请事件和幂等命令均采用追加式或不可变模型；发布新版本和退休都不能原地编辑旧版本。
- 只有当前有效 Owner 可以预览、提交和复核；申请人不能复核本人申请。
- 页面按钮、前端角色和客户端预览都不构成授权，所有权限、版本、策略和观察事实由 API 在写入时重新校验。
- 保留策略引用只证明“该稳定引用已由独立治理过程批准并标记为 production-ready”；Audit-3 不设置保留天数、不删除数据、不运行清理。
- 质量规则引用只证明 Action 来源、字段、风险和完整性规则已批准；Audit-3 不自动修复历史事实或业务写路径。

## 3. 三层 Registry 语义

| 层级 | 数据来源 | 含义 |
|------|----------|------|
| 全部历史定义 | `app_audit_action_registry` | 每个 `action_key + schema_version` 的不可变版本，包含 active 与 retired |
| 当前 active 定义 | `app_audit_current_action_registry` | 每个 Action 最高版本且状态为 active |
| 当前生产可见定义 | `app_audit_production_action_registry` | 当前 active 定义同时具有已批准、production-ready 的保留与质量策略，并包含 Owner 可见角色 |

“已有 active 版本”不等于“已允许生产查询”。普通 admin 和受控导出只使用第三层；Owner 为了治理缺口，仍可查看未登记、退休或治理引用未就绪的事实。

## 4. 数据模型

### 4.1 治理策略目录

`app_audit_governance_policy_registry` 保存稳定策略引用的不可变版本：

- `policy_type` 仅允许 `retention / quality`；
- `reference_key + policy_type + schema_version` 唯一；
- `decision_status=approved` 必须具有不同的创建人与批准人、批准时间和证据引用；
- 只有 active 且 `production_ready=1` 的最新批准版本可以被生产 Registry 使用；
- retired 版本强制 `production_ready=0`；
- 当前 migration 不 seed 任何策略，也不提供绕过审批的默认引用。

`app_audit_current_governance_policies` 只返回每个稳定引用的最高 active 版本。后续统一配置必须通过单独审批记录导入真实策略版本，不能直接把任意字符串当作已批准事实。

### 4.2 Action 口径申请

| 表 | 责任 |
|----|------|
| `app_audit_registry_change_requests` | 不可变候选定义、提交时观察基线、当前状态、复核人与结果 Registry ID |
| `app_audit_registry_change_events` | 每个申请的提交、批准、驳回或失效事件；只追加 |
| `app_audit_registry_commands` | 申请/复核幂等键、规范请求摘要和结果引用；不可修改 |

同一 Action 同时最多只有一项 `pending_review` 申请。申请使用单调 `version + mutation_token`；状态只允许从 `pending_review` 一次性进入：

```text
pending_review ── 独立批准且基线不变 ──→ approved
pending_review ── 独立驳回 ───────────→ rejected
pending_review ── 版本、观察或策略变化 ─→ stale
```

终态不能重开或改写；需要再次变更时必须基于当前事实创建新申请。

## 5. Action 发现与影响预览

工作区把以下 key 合并为 Action 清单：

- `admin_audit_logs.action` 中真实出现过的 Action；
- `app_audit_action_registry` 中已做前置登记但尚无事实的 Action。

每项返回事件数量、缺稳定索引数量、首次/最近观察时间、观察到的业务域和风险等级、最新正式版本、治理引用就绪状态和待复核申请。

发布或重新激活前必须预览，以下任一条件会阻断提交：

- 同一 Action 已有待复核申请；
- 审计事实缺稳定索引，无法证明观察口径；
- 历史索引出现多个业务域或多个风险等级；
- 候选业务域或风险等级与唯一观察值不一致；
- 候选与当前 active 定义没有语义变化；
- 保留或质量引用不在当前已批准、production-ready 的治理目录。

尚无事实的前置登记允许提交，但必须向复核人显示额外警告。已有事实时预览会显示受影响数量，并明确“新口径只解释、不改写历史事实”。

退休只允许当前 active Action；候选版本完整复制当前定义并追加 `retired` 版本，不接受页面用空字段重写历史定义。

## 6. 审批与并发安全

申请与复核均要求 16～128 字符 `Idempotency-Key`，命令记录绑定有效 Owner、动作范围和规范请求 SHA-256。相同键相同请求返回原结果，相同键不同请求返回冲突。

批准前服务会重新构造候选并检查：

1. 申请仍为 `pending_review` 且 `expectedVersion` 一致；
2. 复核人与申请人不同，且复核时仍为有效 Owner；
3. 当前最新 Action 版本与提交时一致；
4. 观察业务域、风险和“是否缺索引”的摘要与提交时一致；
5. 同 Action 没有其他待处理申请；
6. 保留与质量引用仍是当前已批准、production-ready 版本。

最终 `INSERT ... SELECT` 在同一 D1 条件写入中再次检查 Action 最新版本和两类策略就绪状态。任一条件在预览与提交之间变化时不写 Registry，原申请安全进入 `stale`。成功时正式版本、申请终态、不可变事件、幂等结果和 `admin_audit_logs` 在同一受控 `batch()` 内形成；代码检查关键语句 `changes=1`，零行不能当作成功。

## 7. 查询与导出权限变化

| 场景 | Owner | 普通 admin |
|------|-------|------------|
| 审计列表与筛选项 | 可查看授权时间范围内全部事实，包括未登记项 | 只看本人产生、进入生产 Registry 且 `visibleRoles` 包含 `admin` 的 Action |
| 审计详情 | 可读取包括未登记项并用于治理 | 同时校验本人归属、生产 Registry 和 `admin` 可见角色 |
| 关联时间线 | 可跨关联事实但仍受查询用途审计 | 每条关联事实继续执行本人归属与 Action 可见性 |
| 受控导出 | 可申请当前 Owner 范围 | 只冻结与导出本人当前可见的生产 Action |
| Registry 治理 | 可发现、预览、申请、独立复核 | 不可访问 |

所有普通 admin 路径 fail-closed：治理策略表、引用或生产 View 缺失时不会退回旧 active Registry，也不会因为前端仍显示旧选项而扩大查询或导出范围。

## 8. 管理 API

所有路由位于 `/api/admin/app/audit/registry`，响应使用 `Cache-Control: private, no-store`。

| 方法与路径 | 权限 | 说明 |
|------------|------|------|
| `GET /overview` | Owner | 读取 Action、未登记、退休、冲突、待复核和治理就绪阻断 |
| `GET /actions` | Owner | 按治理状态、业务域和关键词发现 Action |
| `POST /preview` | Owner | 规范化候选并只读计算版本、阻断和历史影响 |
| `GET /requests` | Owner | 按状态/动作读取最近申请 |
| `POST /requests` | Owner | 幂等提交发布或退休申请 |
| `GET /requests/:requestId` | Owner | 读取候选、基线、当前状态和不可变事件 |
| `POST /requests/:requestId/review` | 不同 Owner | 幂等批准、驳回或因基线变化自动失效 |

API 只返回脱敏后的管理员标签，不返回密码、Session、完整邮箱或治理证据正文。申请原因和复核说明保存在受限工作流表；通用审计只保存原因摘要、稳定引用和是否存在说明。治理请求与决定统一使用 `app.audit.integrity.registry.*` Action，因此沿用 Audit-1 的 `audit / critical` 稳定索引分类。

## 9. 页面交互

### 9.1 `/admin/app/audit/registry`

- 首屏展示观察 Action、未登记、待复核和生产就绪状态；阻断项不折叠成单一布尔值。
- 支持按治理状态、业务域、Action key 和展示名筛选。
- 每行同时展示真实事实、当前版本和治理引用就绪状态，避免把“已登记”误读为“已生产放行”。
- 新建、更新、重新激活与退休均先打开编辑区；预览不会写数据库。
- 提交前再次确认版本和影响；成功后关闭编辑区并刷新权威列表。
- 桌面使用结构化行，窄屏自动单列；Action、Owner 引用、策略引用和摘要可换行，不允许按钮或长文本越界。

### 9.2 `/admin/app/audit/registry/requests/{requestId}`

- 展示候选定义、申请原因、申请人与复核人、提交时基线和当前权威状态。
- 当前版本或观察摘要变化时显示醒目的失效预警；页面不假定旧预览仍有效。
- 申请人只看到“等待另一位 Owner”，不能出现可执行复核按钮。
- 复核人必须选择结构化原因并填写至少 10 个字符的说明；批准和驳回使用不同确认文案。
- 时间线显示提交与唯一终态，不提供编辑、删除或重开入口。

## 10. 当前安全状态与后续统一工作

- `0093_app_audit_action_registry_governance.sql` 尚未在 local/dev/production 执行。
- 治理策略目录没有 seed；当前没有任何引用会被隐式视为已批准或 production-ready。
- 没有创建真实口径申请、正式 Action 新版本或治理策略版本。
- 没有修改 Wrangler、WAF、速率限制、调度或 production 开关。
- migration 执行前不能访问新 Registry API；策略配置完成前普通 admin 的生产 Registry 范围会按设计保持关闭。
- API TypeScript 检查和 Nuxt production build 是本阶段唯一工程验证；D1 migration 链、触发器、并发、幂等、权限矩阵、脱敏、导出范围和响应式 UI 专项验收统一后置。

## 11. 后续阶段

- 全部功能开发完成后，由独立配置阶段导入经批准的 retention/quality 策略版本，再按 Action 逐项预览和双人发布；禁止批量自动批准。
- 统一执行 `0090/0091/0092/0093` 及完整 migration 链验证，并覆盖无策略、策略退休、Action 并发、申请人自审、基线变化、重复幂等键和 admin 可见性回归。
- 正式启用前完成 Action 全量清单、owner 引用、保留决策、质量规则、告警、备份恢复和受控清理演练。
- 更细的审计岗位与业务域权限只能在服务端 capability + scope 模型完成后追加，不得仅靠页面隐藏。
