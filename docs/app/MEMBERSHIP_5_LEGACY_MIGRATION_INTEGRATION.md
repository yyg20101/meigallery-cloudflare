# Membership-5 旧会员显式迁移交付基线

App 版本：1.0

状态：Cloudflare 与 Nuxt 开发完成；migration、配置、测试和真实迁移后置

## 1. 目标与边界

Membership-5 为旧 Web `user_memberships` 到独立 App 五级会员建立可追溯迁移工作台。系统不会根据 `vip/svip`、等级名称或 rank 自动猜测映射；Owner 必须选择一个确定的 App 会员目录版本，并显式配置每个 legacy code 对应的目标 tier。

- Dry-run 只冻结证据，不创建 `app_membership_grants`。
- 每条记录都必须由非任务创建人的 Owner 独立批准或拒绝。
- 缺失/非法时间、缺失发放人、未知等级、重复映射和目标目录冲突均保守阻断。
- 正式执行前再次核对 legacy 原记录、目标目录、账号状态、有效期、重复迁移和会员运营安全控制。
- 单条失败不回滚已成功条目；结果为逐项 `migrated|failed|stale|conflict|evidence_insufficient`。
- 不迁移付费事实，不推断支付来源，也不修改 App 运行目录引用。

## 2. Figma 页面

唯一页面为 `ADM-MBR-06`：

| 状态 | Figma 节点 | 触发条件 |
|---|---|---|
| 正常 | `159:107597` | 映射与证据完整 |
| 证据不足 | `159:107801` | legacy 时间/发放/账号证据缺失、非法或执行前已变化 |
| 映射冲突 | `159:108005` | code 重复、目标 tier 无效或现有 App grant 冲突 |

Nuxt 路由：`/admin/app/membership/migrations`。页面不得自行发明第四种可见状态；加载、处理中和 API 错误仍通过通用页面状态呈现。

## 3. 权威模型

Migration：`0098_app_membership_legacy_migrations.sql`。

- `app_membership_legacy_migration_controls`：正式执行门禁，默认 `execution_enabled=0`；开启时必须记录决策引用、批准人和批准时间。
- `app_membership_legacy_migration_jobs`：不可变目录/映射/请求哈希、乐观版本、提交状态和 10 分钟执行租约。
- `app_membership_legacy_migration_items`：原记录 ID、等级、发放人、原始/标准化时间、目标 tier 快照、证据 SHA-256 和独立复核结果。
- `app_membership_legacy_migration_events`、`app_membership_legacy_migration_requests`：不可变事件与幂等执行事实。

任务和条目使用数据库 transition guard；终态不可回退或删除。执行中断后仅允许过期租约恢复，并在每条写入前再次重验冻结证据。

## 4. 管理员 API

- `GET /api/admin/app/memberships/migrations`
- `POST /api/admin/app/memberships/migrations/dry-run`
- `GET /api/admin/app/memberships/migrations/:jobId`
- `POST /api/admin/app/memberships/migrations/:jobId/submit`
- `POST /api/admin/app/memberships/migrations/:jobId/items/:itemId/review`
- `POST /api/admin/app/memberships/migrations/:jobId/execute`

创建与执行要求 `Idempotency-Key`；提交、复核和执行要求 `expectedVersion`。正式执行仅限 Owner，且执行门禁未批准时返回明确阻断原因，不允许客户端绕过。

## 5. 后置事项

- 不执行 `0098`，不改变 dev/production 数据和目录引用。
- 配置阶段由业务负责人确定映射、抽样范围、回滚与数据保留决策，再通过受审计操作开启执行门禁。
- 测试阶段覆盖非法证据、同人复核、目录漂移、重复迁移、租约恢复、逐项失败、幂等重放和会员到期。
