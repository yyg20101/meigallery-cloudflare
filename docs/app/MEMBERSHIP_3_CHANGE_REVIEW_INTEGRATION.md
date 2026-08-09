# Membership-3 会员变更独立复核开发基线

更新时间：2026-08-09
状态：Cloudflare API、D1 migration 与 Nuxt 管理后台开发完成；migration、策略配置、专项测试和环境联调后置

## 1. 目标与边界

Membership-3 在 Membership-1 不可变 grant、追加式撤销和 Membership-2 站内申请之上，补齐 `ADM-MBR-05` 的“申请—独立复核—原子执行”闭环。

- 覆盖单账号新发放、同级续期和追加式撤销。
- 用户会员申请的运营批准只提交内部发放复核，不再直接创建 grant。
- 发起人不得复核本人申请；Owner 也不能绕过人员分离。
- 复核申请不产生任何会员权限。只有复核批准、账号事实重验通过且正式 grant 或 revocation 写入成功后才显示生效。
- 不实现批量发放、旧会员迁移、在线支付、自动续费或客户端复核入口。
- 本阶段不写真实风险阈值、不写策略 seed、不改运行开关，也不执行 `0088`。

## 2. 风险策略与前瞻兼容

`app_membership_review_policies` 支持两个策略模式：

| 模式 | 行为 |
|---|---|
| `review_all` | 所有发放、续期和撤销进入独立复核 |
| `risk_based` | 按目标 rank、有效天数、降级发放和撤销开关判断 |

只有 `state=published` 且 `risk_decision_status=approved` 的策略可参与判定。`0088` 不插入策略行，因此当前代码采用 `conservative_review_all` 虚拟策略，并返回风险码 `POLICY_UNRESOLVED_ALL_REVIEW`。这使未决业务政策不会被代码中的临时阈值替代。

未来发布正式策略只改变服务端策略数据和管理端呈现：App 仍只消费最终会员快照与 entitlement，无需因复核阈值变化升级客户端。已提交申请固化策略版本和风险码，后续策略发布不会静默重解释旧申请。

## 3. 数据模型

`0088_app_membership_change_reviews.sql` 新增：

| 表 | 用途 |
|---|---|
| `app_membership_review_policies` | 版本化风险策略；本 migration 保持空表 |
| `app_membership_change_requests` | 变更内容、来源、当前会员基线、策略快照、双人职责和执行结果 |
| `app_membership_change_request_events` | 追加式状态事件：提交、批准、拒绝、账号变化失效 |
| `app_membership_change_review_decisions` | 复核请求幂等结果；同一复核幂等键只对应一个决定 |

变更状态：

```text
pending_review
  ├─ reject  ───────────────→ rejected
  └─ approve
       ├─ 事实一致且写入成功 → approved
       └─ 账号/会员/申请已变化 → stale
```

`executing` 只作为 D1 条件批次中的短暂内部状态。事件和复核决定表通过 trigger 禁止更新或删除。被拒绝或失效的会员申请会释放发放锁，运营人员可修正有效期、说明或依据后使用新幂等键重新提交；已批准申请不能重复创建 grant。

## 4. 原子执行规则

批准时服务端不信任页面加载时的状态，并在同一 D1 条件批次中重新检查：

1. 复核申请仍为 `pending_review` 且 `expectedVersion` 一致。
2. 复核人与发起人不同，且复核人仍是有效 `admin|owner`。
3. 发放目标账号仍为 `active`；撤销允许对受限账号执行，避免“账号受限”反而阻断会员撤权。
4. 当前最高有效 grant ID 与提交时基线一致；自然到期、新 grant 或撤销都会使旧申请失效。
5. 发放业务单号未被正式 grant 使用；撤销目标尚未撤销。
6. 来源为会员申请时，申请仍为原版本、原处理人、`processing` 且发放锁一致。

全部条件成立后，以下事实一起收敛：

- 正式 `app_membership_grants` 或 `app_membership_grant_revocations`；
- 既有 `app_membership_admin_requests` 幂等执行记录；
- 复核申请终态、事件、决定与管理员审计；
- 来源为会员申请时，同批更新为 `approved`、关联 `grant_id` 并追加用户可见时间线。

条件不一致时不创建 grant 或 revocation，申请进入 `stale` 并释放会员申请锁。调用方收到 `MEMBERSHIP_CHANGE_ACCOUNT_CHANGED`，必须重新读取权威状态并创建新预览。

## 5. API 契约

所有接口位于 `/api/admin/app/memberships`，继续要求有效管理员会话和既有 Membership 管理运行门禁。

| 方法与路径 | 用途 |
|---|---|
| `POST /grants/preview` | 返回发放结果预览以及 `review` 策略判定 |
| `POST /change-requests` | 使用 `Idempotency-Key` 创建发放/续期复核申请 |
| `POST /grants/{grantId}/revoke-preview` | 返回撤销目标、当前会员和复核判定 |
| `POST /grants/{grantId}/revoke-request` | 使用 `Idempotency-Key` 创建撤销复核申请 |
| `GET /reviews` | 按状态和操作筛选队列；不返回内部备注正文 |
| `GET /reviews/{requestId}` | 读取逐单详情和内部依据，并写受控读取审计 |
| `POST /reviews/{requestId}/decision` | 使用 `expectedVersion + Idempotency-Key` 批准或拒绝 |

既有 `POST /grants` 和 `POST /grants/{grantId}/revoke` 保留为未来低风险直达执行通道，但服务端会在策略要求复核时返回 `MEMBERSHIP_REVIEW_REQUIRED`，页面或旧调用方不能绕过。

会员申请 `POST /applications/{applicationId}/approve` 兼容保留路径，但语义调整为“提交发放独立复核”。申请在复核期间保持 `processing` 且 rank、grant、entitlement 不变；独立复核批准后才进入 `approved`。

## 6. Nuxt 页面与交互

| 页面 | 已完成交互 |
|---|---|
| `/admin/app/membership/grants/new` | 账号确认、发放预览、策略原因、提交复核、撤销预览与撤销复核、结果跳转 |
| `/admin/app/membership/applications` | 领取与常规处理、提交发放复核、复核中锁定、拒绝/失效后重新提交、复核详情跳转 |
| `/admin/app/membership/reviews` | 状态/操作筛选、可由我复核计数、自审冲突提示、响应式队列 |
| `/admin/app/membership/reviews/{requestId}` | 申请事实、内部依据、策略快照、基线/当前权益对比、批准/拒绝与终态结果 |

页面的批准按钮只在 `canReview=true` 且前端观察到账号基线未变化时可用；服务端仍会再次判断，前端禁用不是安全边界。所有按钮、筛选和事实块使用可换行布局与 `min-width: 0`，窄屏下不依赖固定宽表格。

## 7. 隐私与审计

- 队列只返回脱敏邮箱，不返回内部备注或复核意见正文。
- 逐单详情读取内部备注时写 `app.membership.change.view`，目的固定为 `service_operation`。
- 通用审计不复制内部备注或复核意见正文，只保存是否存在正文、SHA-256、字符长度、稳定 ID、状态和风险码。
- 用户只看到 Membership-2 申请时间线中的“已发放”终态，不看到管理员姓名、内部备注、策略阈值或拒绝复核意见。

## 8. 当前未执行项

按“先完成全部开发、后统一配置与测试”的当前顺序，以下事项明确后置：

- 不执行 `0088_app_membership_change_reviews.sql`；
- 不创建或发布真实 `app_membership_review_policies`；
- 不修改 production/dev Wrangler 开关或会员目录；
- 不运行 Membership-3 D1/API/UI 专项测试、远端联调或真实账号验收；
- 不导入真实 grant、会员申请或管理员复核数据。

因此本阶段代表可落地代码和契约完成，不代表任何环境已开放会员复核，更不代表 production 发布授权。
