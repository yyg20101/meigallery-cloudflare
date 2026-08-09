# Membership-4 会员目录与 Entitlement 管理开发基线

更新时间：2026-08-10

状态：Cloudflare API、D1 migration 与 Nuxt 管理后台开发完成；migration、产品数值、环境配置、专项测试和联调统一后置

## 1. 目标与边界

Membership-4 补齐 `ADM-MBR-01` 与 `ADM-MBR-02`，把 Membership-1 已有的五级目录和 typed entitlement 从 migration 固化数据提升为可审计、可比较、可独立复核的版本化管理平面。

- 管理员从已发布或已有运行/业务引用的稳定目录完整复制新草稿，不在原目录上做破坏性升级；可编辑草稿不能被提前分叉。
- 草稿一次保存完整五级 tier，稳定 `tierId` 不变；名称、文案、颜色 token 与 rank 分离。
- Entitlement 使用稳定 key、Schema 版本、值类型、安全默认值、客户端 capability 和每级显式值。
- 发布必须由另一位有效 Owner 独立复核；目录创建人和发布申请人都不能作出决定。
- 发布只形成不可变目录版本，不修改 Wrangler、不切换运行目录、不迁移 grant，也不开放 App capability。
- 不实现在线支付、商品、订单、批量会员迁移、目录自动灰度或客户端远程代码执行。

本阶段只完成开发。`0089` 不写真实等级数值、不批准 production-ready、不修改既有 grant/申请，也不执行任何环境 migration。

## 2. 版本演进原则

目录使用“复制—编辑—校验—独立复核—不可变发布”流程：

```text
稳定基线
  └─ 完整复制新草稿
       ├─ 编辑设置、完整五级和 Entitlement
       ├─ 比较基线与影响分析
       └─ 提交固化内容哈希
            ├─ Owner 拒绝 → rejected
            ├─ 内容或版本变化 → stale
            └─ Owner 批准 → published（仍未切换环境）
```

以下目录只读，必须从该版本继续复制新草稿：

- 已发布或已退役；
- 当前环境正在引用；
- 已有待复核发布申请；
- 已被 grant、会员申请或后继目录引用。

创建后继目录后基线立即冻结，避免基线内容漂移导致比较和发布校验被静默重解释。运行目录引用由部署配置控制，目录发布与环境切换是两个独立变更。

## 3. 数据模型

`0089_app_membership_catalog_management.sql` 新增：

| 表 | 用途 | 关键约束 |
|---|---|---|
| `app_membership_catalog_metadata` | 目录基线、乐观锁、变更摘要、生产决策和创建/发布责任 | 基线和创建身份不可变；创建人与发布人分离 |
| `app_membership_catalog_commands` | 创建、编辑、提交和决定的管理员幂等事实 | 管理员 + 幂等键唯一；记录请求哈希和结果版本；不可更新/删除 |
| `app_membership_catalog_publish_requests` | 固化目录 lock、内容哈希、校验报告和独立复核状态 | 同一目录最多一个待复核申请；复核人不得是申请人 |
| `app_membership_catalog_publish_events` | 提交、批准、拒绝和内容失效事件 | 目录申请内序号唯一；不可更新/删除 |
| `app_membership_catalog_publish_decisions` | Owner 决定的幂等结果 | reviewer + 幂等键唯一；不可更新/删除 |

migration 为既有目录补齐 metadata，但不更改目录内容、状态、production-ready 或运行引用。已发布目录的设置、tier、定义和值由 trigger 禁止原地修改；仍为 development 但已存在事实依赖的目录同样被冻结。

## 4. Entitlement 契约与校验

App 1.0 目录必须恰好包含五个 tier，并完整提供以下 canonical key：

- `direct_message.create`
- `direct_message.send`
- `direct_message.new_threads_per_day`
- `discovery.filter.advanced`
- `discovery.saved_filter.max`
- `history.retention_days`
- `favorite.folder_count`

服务端执行以下规则：

- 值类型只允许 `boolean | integer | enum`，合并策略固定为 `highest_rank`。
- 布尔安全默认值必须为 `false`，整数安全默认值必须为 `0`；枚举默认值在生产决策批准前保持警告。未知或旧客户端不能因此扩大权限。
- 每个定义必须为全部五级提供显式值与 `planned | available`。
- 值类型变化必须递增 `schemaVersion`。
- 未登记客户端 capability 只能保持全部 `planned`；任一等级标记 `available` 即阻断发布。
- 结构错误阻断全部发布；警告允许形成非生产不可变版本，但阻断 production-ready。
- 当前 `production_decision_status=unresolved`，因此代码不会把临时产品数值标记为 production-ready。

已登记 capability 表示已有客户端契约，不代表环境已启用对应能力。受限业务 API 仍必须按当前 grant、目录、稳定 key、有效期和 availability 在服务端重新授权。

## 5. API 契约

所有接口位于 `/api/admin/app/memberships`，要求有效 `admin|owner` Web 管理员会话。目录管理不依赖当前 App 会员功能开关，便于先准备新版本；这不影响 App 公共目录和受限业务 API 的既有 fail-closed 门禁。

| 方法与路径 | 用途 |
|---|---|
| `GET /catalogs` | 目录列表、运行引用、事实依赖和最近复核摘要 |
| `POST /catalogs` | 使用 `Idempotency-Key` 从稳定基线完整复制草稿；待复核或仍可编辑草稿不可作为基线 |
| `GET /catalogs/{catalogId}` | 读取五级、定义、值、内容哈希和校验结果 |
| `PATCH /catalogs/{catalogId}` | 乐观锁更新版本号、生效时间、时区、最低客户端和摘要 |
| `PUT /catalogs/{catalogId}/tiers` | 原子替换完整五级展示与 rank，稳定 `tierId` 不变 |
| `GET /catalogs/{catalogId}/compare` | 与指定或默认基线比较 tier/Schema/等级值变化 |
| `PUT /catalogs/{catalogId}/entitlements/{key}` | 原子保存定义和全部五级显式值 |
| `GET /catalogs/{catalogId}/entitlements/{key}/impact` | 查询 capability、服务依赖、grant 数和基线差异 |
| `POST /catalogs/{catalogId}/publish-requests` | 固化 lock、内容哈希和校验报告，提交独立复核 |
| `GET /catalog-publish-reviews` | 发布复核队列；不返回复核意见正文 |
| `GET /catalog-publish-reviews/{requestId}` | 读取单个复核申请完整事实 |
| `POST /catalog-publish-reviews/{requestId}/decision` | 有效 Owner 使用乐观版本与幂等键批准或拒绝 |

所有写操作保存请求哈希。同一幂等键重复提交相同请求返回原结果；复用同键提交不同内容返回冲突。页面看到的可编辑状态不是权限边界，服务端和 D1 条件写会再次检查目录状态、lock、事实依赖、人员分离和内容哈希。

## 6. Nuxt 页面与交互

| Page ID / 路径 | 已完成交互 |
|---|---|
| `ADM-MBR-01` `/admin/app/membership/catalogs` | 版本列表、完整复制、设置编辑、五级原子编辑、校验、基线比较、发布申请、复核队列与 Owner 决定 |
| `ADM-MBR-02` `/admin/app/entitlements` | 目录选择、搜索筛选、定义新建/编辑、安全默认值、五级显式值、capability 状态、服务依赖和 grant 影响 |

页面明确区分“当前环境引用”“草稿”“已发布”“production-ready”和“待独立复核”。运行引用、已发布、待复核或已有事实依赖时进入只读模式，但仍可查看比较、影响和审计事实，并可从该版本创建新草稿。

操作区使用可换行按钮、`min-width: 0`、响应式网格和横向滚动表格，避免窄屏下文字或按钮越界。未知 capability、Schema 冲突、基线变化和服务依赖都有文字状态，不只依赖颜色表达。

## 7. 权限、隐私与审计

- admin 和 Owner 可以创建、编辑草稿并提交发布申请；只有有效 Owner 可以作出发布决定。
- Owner 不能复核自己创建的目录，也不能复核自己提交的发布申请。
- 复核决定前重新读取目录，校验 state、lock、内容哈希、Schema、production-ready 门禁和人员身份。
- 队列不返回 `reviewNote`；详情按管理权限读取。通用审计只保存稳定 ID、状态、内容哈希、意见哈希和字符长度，不复制意见正文。
- 所有目录修改、Entitlement 修改、发布申请和决定都写管理员审计；发布事件、决定和命令事实不可修改或删除。

## 8. 当前未执行项

按“先完成全部开发、后统一配置与测试”的当前顺序，以下事项明确后置：

- 不执行 `0089_app_membership_catalog_management.sql`；
- 不修改 production/dev Wrangler、目录 ID、会员开关或 production-ready 开关；
- 不录入或批准真实五级名称、额度、获取方式、服务说明和 capability 上线状态；
- 不迁移 grant、会员申请、legacy `vip/svip` 或真实账号；
- 不运行 Membership-4 D1/API/UI 专项测试、migration 全链校验、远端联调或真实管理员验收；
- 不发布或部署任何 Worker。

因此本阶段代表管理平面代码、数据契约和交互开发完成，不代表任一环境已开放目录编辑、会员权益或生产发布。
