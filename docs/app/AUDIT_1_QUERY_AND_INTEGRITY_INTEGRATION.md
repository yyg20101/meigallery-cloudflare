# Audit-1 App 审计查询与完整性开发基线

更新时间：2026-08-10

## 1. 本阶段目标

Audit-1 落地 `ADM-AUD-01/02/03` 的开发闭环：让管理员在明确业务用途和服务端授权范围内查询 App 管理审计、查看字段级脱敏详情与关联时间线，并让 Owner 对稳定序号、事实索引、载荷、敏感字段、Action 登记、关键业务事实的反向审计覆盖和同范围摘要变化形成不可变检查清单。

本阶段继续遵守“先完成全部开发，后统一配置与测试”：只提交代码、migration 文件和文档，不执行 `0090`，不写生产 Action 口径、保留期或自动运行计划，也不运行专项测试。

## 2. 唯一事实与边界

- `admin_audit_logs` 继续是唯一审计事实源；Audit-1 不创建第二套可写审计日志。
- `app_audit_event_index` 是由事实自动生成的稳定序号与最小责任索引，不拥有业务 before/after。
- `app_audit_event_contexts` 是可选的追加式 request、trace、业务单号、审批、策略、capability、显式结果和错误码引用；既有事件没有上下文时保持“未登记”，不得猜测。
- `app_audit_action_registry` 使用 `(action_key, schema_version)` 追加版本，当前定义由最高版本决定；最高版本为 `retired` 时该 action 不再属于 active 生产口径。
- `app_audit_integrity_checks/findings` 只保存清单和发现，不自动修复、补写、删除或重排审计事实。
- migration 使用触发器禁止更新或删除审计事实、索引、上下文、Action 版本、检查、finding 和幂等命令。

## 3. 权限与最小披露

| 能力 | admin | owner |
|---|---|---|
| 审计列表 | 仅本人操作 | 当前时间范围内跨域只读 |
| 审计详情 | 仅本人操作 | 跨域只读 |
| 关联时间线 | 仅本人可见事件 | 跨域只读 |
| 完整性概览/清单 | 禁止 | 允许 |
| 运行完整性检查 | 禁止 | 允许，幂等追加 |
| 修改/删除/重放业务 | 禁止 | 禁止 |

列表必须选择 `operational_investigation`、`security_review`、`financial_reconciliation` 或 `compliance_audit`。详情读取再次要求用途；查询与详情读取自身会在同一 D1 批次中写入新的审计事实和结构化上下文。审计页没有回滚、重放、纠正原值或业务写入口。

## 4. 查询契约

`GET /api/admin/app/audit/events`：

- 默认最近 7 天，单次范围最多 31 天；
- 支持 action、domain、risk、result、target、actor、request、trace 和业务单号精确筛选；
- 使用绑定筛选指纹与管理员范围的稳定 sequence 游标；跨用途、跨筛选或跨管理员复用会被拒绝，改变页内 sequence 最多只影响既有授权范围内的翻页位置，不能扩大权限；
- 列表只返回载荷状态，不返回 before/after；
- admin 强制追加本人 `admin_id` 条件，不能通过 actor 参数枚举其他管理员。

`GET /api/admin/app/audit/events/:eventId`：

- 服务端重新执行对象范围校验；无权访问统一返回不存在；
- before/after 只返回 JSON 解析后的脱敏结构、SHA-256、状态和脱敏字段数；
- 密码、Token、凭据、Cookie、消息/备注/证据、私有对象 key、邮箱、电话、精确地址等字段不返回原值；
- 疑似邮箱、Bearer、JWT、私钥、带签名查询参数的 URL 和超长文本也不会显示；
- 关联时间线只按相同目标、request、trace 或业务单号建立，不因同一管理员而扩大关联。

## 5. 完整性检查

Owner 可调用：

- `GET /api/admin/app/audit/integrity/overview`
- `GET /api/admin/app/audit/integrity/checks`
- `GET /api/admin/app/audit/integrity/checks/:checkId`
- `POST /api/admin/app/audit/integrity/checks`

单次检查最多覆盖 5,000 个连续序号，默认检查最近 1,000 个。检查内容：

1. 范围内 sequence 是否连续；
2. 是否存在 `admin_audit_logs` 事实没有自动索引；
3. before/after 是否为合法 JSON；
4. payload 是否包含禁止的敏感字段或疑似凭据值；
5. action 是否具有 active 的当前登记版本；
6. 同一事件时间窗口内的会员发放、钱包入账、运营回复和人物发布复核事实，是否具有可核对的业务审计；
7. 与上一份完全相同范围、相同 manifest 算法版本的 SHA-256 链式摘要是否变化；摘要覆盖原事实、稳定索引和完整结构化上下文。

反向覆盖检查读取既有权威事实，不创建第二份业务数据：会员以 `app_membership_grants` 为准，钱包以 `app_wallet_entries` 为准，运营回复以 `app_conversation_operator_message_facts` 为准，人物发布以 `person_publication_reviews(status=published)` 为准。每类最多保存 12 条脱敏证据摘要，四类准确总数仍完整写入清单；发现缺失时生成 `business_without_audit`，不猜测操作者、不自动补写审计。

检查以 `Idempotency-Key + 范围哈希` 去重。清单显式保存 `manifest_version`，算法升级只和同版本旧清单比较，避免把正常算法演进误报为历史篡改。结果、最多前 50 条 finding、幂等命令和检查审计在同一 D1 batch 中追加；分类总数不因 finding 展示上限而截断。检查发现问题时只标记 `findings`，不修改源事件。

## 6. Nuxt 页面

### `ADM-AUD-01 /admin/app/audit`

- 明确用途、时间范围和基础/精确筛选；
- 展示范围内总量、关键/高风险和未登记 Action 事件；
- 响应式卡片与桌面表格共享同一事件结构，窄屏不依赖横向按钮排列；
- 手动查询，不因输入变化自动产生大量查询审计；
- 使用追加式“加载更多”，游标绑定当前筛选。

### `ADM-AUD-02 /admin/app/audit/{eventId}`

- 直达页面必须先选择用途；从列表进入沿用已选择用途；
- 按“谁、何时、做了什么、对什么、为什么、结果、审批”展示责任事实；
- 上下文、before/after 摘要和关联时间线分区显示；
- JSON 使用可换行、可滚动容器，不让长 ID、摘要或文本撑破页面。

### `ADM-AUD-03 /admin/app/audit/integrity`

- 仅 Owner 可访问；
- 展示源事实/索引、序号边界、Action 登记、关键业务缺审计计数与生产就绪阻断项；
- 可选择连续范围追加检查，查看历史清单和 finding；
- 明确“检查不等于修复、配置、migration 或生产授权”。

## 7. 当前安全状态

- `0090_app_audit_query_and_integrity.sql` 尚未执行。
- Audit-3 已补齐 Action 口径治理代码与生产可见 View，但不 seed 任何真实治理策略或 Action，因此统一配置前 `productionReady=false` 仍是预期状态。
- 未配置保留期、自动调度、告警渠道或备份恢复演练。
- Audit-1 自身不创建审计导出、R2 文件或下载凭证；Audit-2 已独立实现受控导出代码，Audit-3 已把查询、详情、关联与导出统一接入生产 Registry，但 `0091/0093`、真实文件、治理策略和配置仍未执行。
- 本阶段 API TypeScript 检查和 Nuxt production build 已通过；受限网络下字体元数据 provider 告警未阻断产物。专项 D1/API/UI/安全测试统一后置。

## 8. 后续开发

- Audit-2 已完成：`ADM-AUD-04` 受控导出申请、独立复核、水印、私有 R2、短期一次性下载和下载审计；边界见 [Audit-2 受控审计导出开发基线](./AUDIT_2_CONTROLLED_EXPORT_INTEGRATION.md)。
- Operations-1：`ADM-OV-01/02/03` 聚合总览、异常状态机、Runbook 与受控安全开关。
- Audit-3 已完成：Action 发现、口径预览、Owner 独立发布/退休、治理引用验证和普通 admin 的生产 Registry 可见性；边界见 [Audit-3 Action 口径治理与独立发布开发基线](./AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md)。
- 全部功能开发结束后，再统一执行 `0090/0091/0092/0093`、Action/治理策略/保留/清理/调度配置和专项测试。
