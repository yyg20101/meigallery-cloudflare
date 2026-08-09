# Audit-2 受控审计导出开发基线

更新时间：2026-08-10

## 1. 本阶段结论

Audit-2 已完成 `ADM-AUD-04 /admin/app/audit/exports` 的开发闭环：管理员只能在 Audit-1 当前授权范围内申请导出，由不同的有效 Owner 独立复核；通过后由 API Worker 生成逐行水印、字段级脱敏的 CSV 并写入私有 R2；原申请人再次验证密码后取得五分钟内有效的一次性票据，再由 Worker 代理下载。

浏览器端始终走 Web 同源 `/api` 代理；代理请求头白名单只额外放行 `Idempotency-Key`、`X-Audit-Step-Up` 和 `X-Audit-Download-Ticket` 三类受控命令头，响应仅转发下载所需的 `Content-Type`、`Content-Disposition`、`ETag` 与禁缓存信息。强认证令牌和下载票据不进入 URL、页面路由或持久化浏览器存储。

本阶段遵守“先完成全部开发，后统一配置与测试”：已提交 migration 定义、API、Nuxt 页面和开发契约，但不执行 `0091_app_audit_controlled_exports.sql`，不创建真实导出，不调整 production 配置，不运行专项 D1/API/R2/UI/安全测试，也不把页面存在解释为生产授权。

## 2. 不可突破的边界

- `admin_audit_logs` 继续是唯一管理审计事实源；Audit-2 表族只拥有导出申请、复核、文件和票据工作流事实。
- 申请范围必须复用 Audit-1 的用途、时间和对象筛选，admin 强制只包含本人事件，Owner 才可申请跨管理员范围。
- 申请人不能复核自己的申请；复核人必须是不同的有效 Owner。
- 申请、复核和下载票据签发是三个独立的高风险动作，每次都重新验证当前账户密码；一个凭证不能跨动作或重复使用。
- 密码、强认证凭证明文、下载票据明文、R2 key、R2 ETag 和私有对象地址不写入通用响应、工作流摘要或审计载荷。
- R2 bucket 保持私有；API 不返回公开 URL、长期 URL或可复用下载地址。
- CSV 不包含管理员邮箱、消息正文、备注正文、证据正文、Token、Cookie、凭据、私有媒体 key、精确联系方式或原始受保护 URL。
- 过期、撤销、范围变化、授权变化、对象摘要不符或票据已消费时，服务端拒绝文件读取；不能依赖前端隐藏按钮。
- 当前不实现导出邮件发送、外部分享、定时导出、批量审批、公开链接、跨申请复用文件或客户端直连 R2。

## 3. 角色与授权

| 操作 | admin | owner |
|---|---|---|
| 提交导出申请 | 允许，仅本人审计事件 | 允许，可使用 Audit-1 跨域范围 |
| 查看申请列表/详情 | 仅本人申请 | 全部申请 |
| 复核申请 | 禁止 | 允许，但不得复核本人申请 |
| 生成文件 | 禁止直接调用 | 只能由复核通过状态触发 |
| 申请下载票据 | 仅本人创建且已就绪的申请 | 同样仅本人创建的申请 |
| 下载文件 | 仅本人未消费票据 | 同样仅本人未消费票据 |
| 修改历史或重放导出 | 禁止 | 禁止 |

普通管理员即使知道其他申请 ID，也只能得到“不存在或不在授权范围”。Owner 查看全部申请不自动取得下载权，避免“可复核”被扩大成“可获取文件”。

## 4. 状态机

```text
pending_review ── reject ───────────────→ rejected
       │
       ├─ approve + 范围/授权变化 ─────→ scope_changed
       │
       └─ approve + 精确范围一致 ──────→ generating
                                            │
                                            ├─ 生成并完成完整性核对 → ready
                                            └─ 生成/R2/终态写入失败 → failed

ready ── 下载前范围变化 ───────────────→ scope_changed
ready ── R2 对象摘要不符 ──────────────→ failed
ready ── 有效期到达（读取时强制生效） ─→ expired
ready ── 后续受控撤销能力 ─────────────→ revoked
```

请求使用单调 `version` 做乐观并发控制，状态只能沿 migration 允许的前向边迁移。申请范围、申请人、用途、事件摘要、案件号和申请时间创建后不可修改。工作流事件、复核事实和幂等命令只追加，禁止更新或删除。

## 5. 强认证与幂等

### 5.1 密码重新验证

`POST /api/admin/app/audit/exports/step-up`

```json
{
  "password": "当前账户密码",
  "actionScope": "request | review | download_ticket"
}
```

服务端读取当前有效管理员的密码摘要并通过既有 `verifyPassword` 校验。成功后返回五分钟内有效的单动作凭证；D1 只保存凭证 SHA-256，后续消费必须同时满足管理员、动作、未消费和未过期条件。15 分钟内已有 5 次密码失败审计时保守限流。失败审计只记录动作范围和错误代码，不记录密码。

### 5.2 幂等

申请、复核和下载票据签发都要求 16～128 字符的 `Idempotency-Key`。命令表保存管理员、操作、幂等键、规范请求 SHA-256 和结果引用：

- 同一键、同一请求返回原结果；
- 同一键、不同请求返回冲突；
- 强认证凭证在第一次成功命令中一次性消费；
- 下载票据正文不落库，但通过票据 ID、申请 ID、申请人和到期时间加 `SESSION_SECRET` HMAC 确定性重建，因此响应丢失后的同键重试仍能得到同一未消费票据。

## 6. 申请范围快照与再校验

申请正文包含用途、案件/工单号、10～500 字必要性说明，以及 Audit-1 查询条件：

- `from/to`；
- `action/domain/riskLevel/result`；
- `targetType/targetId`；
- Owner 可用的 `actorId`；
- `requestId/traceId/businessReference`。

单次范围最多 31 天、5,000 个事件。服务端以稳定 sequence 升序冻结：

- 规范化查询 JSON；
- 权限绑定的 `scope_fingerprint`；
- 事件总数与首末 sequence；
- `scope_digest = SHA-256(scope fingerprint + sequence/event ID 列表)`。

结束时间不会超过本次申请处理开始前的截止点，因此申请和强认证自身产生的新审计不会污染已冻结范围。Owner 通过复核时，服务端以申请人的当前有效角色和当前授权重新执行同一查询；fingerprint、数量、首末 sequence 或 digest 任一不同，申请进入 `scope_changed`，不创建 R2 文件。生成开始前与写入 `ready` 终态时还会分别确认申请人角色未变化、复核人仍是有效 Owner；中途撤权会停止交付并删除已写入的临时对象。下载票据签发前再次执行同样校验。

## 7. CSV 脱敏与水印

复核通过后，API Worker 按稳定 sequence 读取最多 5,000 行，并对 before/after 复用 Audit-1 服务端脱敏器：

- 合法 JSON：递归移除敏感键与疑似凭据值，返回脱敏后 JSON、原始摘要和脱敏字段数；
- 空载荷：明确标记 `empty`；
- 非法 JSON：只输出 `invalid` 与摘要，不输出原始文本。

每一行都重复写入不可省略的水印：申请 ID、生成时间、申请人 ID、复核人 ID、用途、案件号和范围摘要。固定列还包括 sequence、事件 ID、时间、操作者数字 ID/角色、业务域、action、登记版本、风险、结果、目标和经过安全处理的 request/trace/审批引用。

所有 CSV 单元格统一引用并转义双引号；以 `= + - @ Tab CR` 起始的内容增加前导单引号，防止表格公式注入。文件带 UTF-8 BOM，最大 25,000,000 字节；超过上限进入 `failed`，不会生成部分可下载文件。

## 8. 私有 R2 与一次性下载

固定对象 key：

```text
audit/exports/{requestId}/events.csv
```

Worker 先生成确定长度的 `Uint8Array`，计算 SHA-256，再以 `sha256` checksum、`no-store` HTTP metadata 和以下自定义 metadata 写入既有私有 R2：

- `requestid`
- `filesha256`
- `scopedigest`

数据库只在 R2 写入成功并核对大小/ETag 后把申请推进到 `ready`。最终 D1 写入失败时只删除本次固定 key，不执行前缀或 bucket 级删除。

当前开发安全默认值：文件逻辑有效期 24 小时，下载票据 5 分钟。正式保留期仍需后续配置决策；即使尚未接入物理清理调度，Worker 在有效期后也不会发票或读取对象。

下载流程：

1. 原申请人重新验证密码；
2. `POST /exports/{requestId}/download-tickets` 重算范围并对 R2 执行 `head` 完整性校验；
3. 返回五分钟内有效的明文票据，D1 只保存其 SHA-256；
4. 浏览器 `POST /exports/download`，通过 header 提交票据；
5. Worker 校验当前管理员、申请版本、文件有效期、文件/范围摘要和 R2 metadata；
6. D1 条件消费票据并追加下载审计成功后，Worker 才流式返回私有对象；
7. 同一票据再次使用返回冲突。

响应强制 `Cache-Control: private, no-store`、`nosniff` 和固定安全文件名，不返回对象 key。

## 9. API 契约

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/admin/app/audit/exports` | admin 本人 / Owner 全部申请列表 |
| `GET` | `/api/admin/app/audit/exports/{requestId}` | 申请、文件摘要和不可变时间线 |
| `POST` | `/api/admin/app/audit/exports/step-up` | 按动作重新验证密码 |
| `POST` | `/api/admin/app/audit/exports` | 冻结范围并提交申请 |
| `POST` | `/api/admin/app/audit/exports/{requestId}/review` | 不同 Owner 通过或驳回 |
| `POST` | `/api/admin/app/audit/exports/{requestId}/download-tickets` | 原申请人取得短期一次性票据 |
| `POST` | `/api/admin/app/audit/exports/download` | Worker 代理私有 CSV 下载 |

所有写操作和下载都追加 `admin_audit_logs` 与 `app_audit_event_contexts`，同时追加导出域时间线。API 响应只返回文件摘要、大小、行数和有效期，不返回 `r2_key`、`r2_etag`、密码摘要、Token 摘要或内部 generation token。

Audit-1 的未执行 `0090` migration 已同步把 `app.audit.export.*` 归为 `critical` 风险，避免受控导出在稳定索引中退化为普通高风险事件；Audit-3 已实现正式 Action 名称、展示文案、owner、可见角色与治理引用的受控发布流程，但真实口径仍须在统一配置阶段逐项确认和双人发布。

## 10. D1 数据模型

`0091_app_audit_controlled_exports.sql` 新增：

- `app_audit_export_requests`：不可变范围快照、版本状态、复核结果和文件摘要；
- `app_audit_export_request_events`：每申请单调 sequence 的追加式流程事实；
- `app_audit_export_review_decisions`：独立复核事实与复核时观察到的范围摘要；
- `app_audit_export_step_up_tokens`：强认证凭证 SHA-256 和一次性消费状态；
- `app_audit_export_download_tickets`：下载票据 SHA-256、申请/文件/范围快照和一次性消费状态；
- `app_audit_export_commands`：申请、复核、发票命令幂等结果。

触发器限制请求前向迁移，禁止修改范围和创建事实，并只允许强认证凭证、下载票据从“未消费”更新到“已消费”一次。

## 11. Nuxt 页面交互

`/admin/app/audit/exports` 已实现：

- 从 Audit-1 查询页进入，并可返回查询或完整性页；
- 新申请表单覆盖用途、案件号、必要性说明、时间、业务域、action、风险、结果和精确引用；
- 申请队列支持状态筛选，并按 admin 本人 / Owner 全部明确披露可见范围；
- 详情展示冻结条件、首末 sequence、范围摘要、独立复核、文件摘要、失败代码和不可变时间线；
- Owner 复核区支持“通过并生成 / 驳回”、结构化原因和说明；
- 原申请人只在 `ready` 且未过期时看到下载入口；
- 三类高风险动作均使用独立密码弹层，密码字段使用 `autocomplete=current-password`，失败保留业务表单但立即清空密码；
- 下载通过同源 API 原始响应，不将票据拼入 URL；浏览器 Blob URL 在触发保存后立即回收；
- 窄屏使用单列与可换行摘要，长 ID、SHA 和筛选值不会撑破容器。

## 12. 当前安全状态与后续统一工作

- `0091` 尚未在 local/dev/production 执行。
- 未创建真实申请、真实 CSV 或真实 R2 对象。
- 未修改 Wrangler、R2 bucket、WAF、速率限制或保留策略配置。
- 当前 24 小时逻辑有效期不是已批准的正式保留政策；物理过期对象清理、恢复演练和合规处置需在全部开发结束后统一配置。
- Audit-3 Registry 治理代码已完成，但正式治理策略和 Action 均未配置；Audit-2 新 Action 会保持未登记或非 production-ready，不得据此宣称审计生产就绪。
- API TypeScript 检查和 Nuxt production build 已通过；受限网络下字体元数据 provider 告警未阻断产物。
- 待统一执行：全新 D1 migration 链、状态/触发器/并发/幂等定向测试、密码失败限流、5,000 行脱敏与 CSV 注入、R2 checksum/metadata/失败补偿、票据重放、权限矩阵、浏览器下载和响应式 UI 验收。

## 13. 后续阶段

- Operations-1：`ADM-OV-01/02/03` 聚合总览、异常状态机、Runbook 和受控安全开关。
- Audit-3 已完成：Action 口径预览、独立发布/退休、retention/quality 引用与未登记 Action 治理；边界见 [Audit-3 Action 口径治理与独立发布开发基线](./AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md)。
- 全部开发结束后统一执行 `0090/0091/0092/0093`、配置、正式 Action/保留/清理策略和专项测试；通过前不启用 production 入口。
