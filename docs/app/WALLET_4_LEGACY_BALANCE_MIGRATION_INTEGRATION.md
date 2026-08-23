# Wallet-4 旧余额显式迁移交付基线

App 版本：1.0

状态：Cloudflare API 开发完成；migration、执行决策、配置、构建、测试和真实迁移统一后置

## 1. 目标与事实边界

Wallet-4 补齐 `WAL-FR-002` 与 `WAL-FR-033` 的旧余额治理出口。当前仓库的 legacy `users`、会员和图库表中没有任何可作为权威来源的金币余额字段，因此实现不会从会员等级、VIP/SVIP、账号名称或其他业务事实猜测余额，也不会在 migration 中回填任何账号。

正式输入只能是业务负责人提供的显式外部快照。每条记录必须同时给出来源系统、来源记录 ID、`opaque:` 前缀且不含邮箱/手机号正文的来源账号引用、提取时间、映射规则、目标稳定 App 账号 ID 和整数余额。Dry-run 冻结规范化行与 SHA-256；来源不存在时没有可执行任务。

## 2. UI 与 Figma 边界

当前 99 个 Page ID 中没有 Wallet 旧余额迁移专页。Wallet-4 因此只增加受保护的管理员 API 和 D1 治理结构，不新增 Nuxt 页面、导航、占位按钮、Page ID 或 Figma 状态，也不复用 `ADM-MBR-06` 冒充钱包迁移页。

用户仍只在既有 `APP-WAL-01/02/03` 看到最终已生效的余额、不可变分录、用户说明和安全业务单号。公开 App DTO 不增加未知枚举；迁移来源由服务端不可变侧表、保留业务引用和审计事实区分。

## 3. 权威模型

Migration：`0111_app_wallet_legacy_migrations.sql`。

- `app_wallet_legacy_migration_controls`：正式执行门禁，默认 `execution_enabled=0`；开启必须同时具备 Owner、时间和决策引用。
- `app_wallet_legacy_migration_jobs`：冻结策略、来源文件名、来源系统、提取时间、映射规则、源快照 SHA-256、乐观版本和 10 分钟执行租约。
- `app_wallet_legacy_migration_items`：逐行来源记录、来源账号引用、目标账号、余额、证据 SHA-256、独立复核与逐项结果。
- `app_wallet_legacy_migration_links`：在普通调币申请与迁移条目之间建立不可修改的一对一分类；迁移结果仍写入既有 `app_wallet_entries`，不建立第二套余额事实。
- `app_wallet_legacy_migration_item_events`、`app_wallet_legacy_migration_requests`：只追加状态事件和幂等命令结果。

同一来源身份与同一目标账号最多各成功迁移一次。目标已有正式分录、账号受限、映射重复、来源已迁移、快照或账号事实变化时均 fail closed。当前既有账本硬上限要求单条来源余额为 `1–1,000,000` 整数，超过范围不得拆分、截断或绕过策略写入。

## 4. 执行与职责分离

流程固定为：

```text
显式外部快照
→ Dry-run 冻结来源/映射/目标证据
→ 创建人提交
→ 另一位 Owner 逐项批准或拒绝
→ 正式执行门禁与钱包写门禁再次校验
→ 为每个批准项创建普通 pending_review 调币申请
→ 使用该条目的独立复核 Owner 批准
→ 原子追加分录与更新钱包快照
→ 写迁移结果、审计、必要通知与 Message-4 钱包刷新
```

迁移执行器复用 Wallet-1 的账号状态、余额/sequence、独立复核、运营安全控制、通知和不可变分录。数据库中的账务动作仍是 `admin_credit + correction`，但 `legacy:<itemId>` 保留业务引用和不可变 link 共同定义迁移分类；普通调币 API 不能创建该引用，也不能复核已链接的迁移申请。

执行中断不会重做已形成的分录：任务可在租约过期后恢复，创建、批准与安全拒绝分别使用确定性幂等键；若分录已存在但条目终态尚未收敛，恢复只补写同一条目的 `migrated` 结果。若迁移申请已冻结但目标账号、账本、来源唯一性或证据随后变化，执行器先拒绝该 `pending_review` 申请，再把迁移条目标记为 `stale`，不会留下可被误批准的悬空申请；若拒绝前发现分录实际已经形成，则保留任务租约恢复，不把成功入账误记为失败。

已完成执行请求的同键重放先读取不可变请求结果，再检查正式执行门禁。因此门禁后来关闭时仍可读取原结果，但不会触发第二次入账或再次发布实时刷新。

## 5. 管理员 API

- `GET /api/admin/app/wallets/migrations`
- `POST /api/admin/app/wallets/migrations/dry-run`
- `GET /api/admin/app/wallets/migrations/:jobId`
- `POST /api/admin/app/wallets/migrations/:jobId/submit`
- `POST /api/admin/app/wallets/migrations/:jobId/items/:itemId/review`
- `POST /api/admin/app/wallets/migrations/:jobId/execute`

创建、提交、复核和执行写命令均要求 `Idempotency-Key`；提交、复核和执行要求 `expectedVersion`。复核和执行仅限 Owner，创建人不能复核自己的条目。任务列表与含余额/来源证据的详情读取写用途化管理员审计；所有命令同样写通用管理员审计，实际入账还保留 Wallet-1 原申请和批准审计。

## 6. 后置事项

- 不执行 `0111`，不修改 dev/production 控制，不导入任何真实来源或余额。
- 配置阶段必须先确认来源所有权、提取方法、映射规则、抽样、超限余额处置、数据位置和保留政策，再由受审计流程开启执行门禁。
- 测试阶段运行新增 D1 用例，覆盖默认关闭、职责分离、普通入口绕过、一次入账、门禁关闭后的幂等重放、重复来源/目标、非空账本、冻结申请安全拒绝、账号漂移、租约恢复和逐项失败。
- 若产品需要可视化迁移工作台，必须先在 Figma 增加正式 Wallet Page ID 与状态，再实现 Nuxt；本切片不提前发明 UI。
