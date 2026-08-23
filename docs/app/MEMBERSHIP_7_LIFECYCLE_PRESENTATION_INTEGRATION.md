# Membership-7 会员生命周期呈现跨仓开发基线

更新时间：2026-08-23

App 版本：1.0

App API：v2 / `1.26.0`

状态：源码与契约开发完成；环境配置、构建、测试和设备验收统一后置

## 1. 目标

Membership-7 补齐 `APP-MBR-02` 已存在但此前无法由服务端权威区分的“即将到期”“到期”“撤销”正式状态。该增量只增加用户可见生命周期信息，不改变有效会员授权规则：

- 顶层 `status=active + tier + grant` 仍是当前有效会员的唯一快照表达。
- 已到期或已撤销的 grant 只进入 `lifecycle.endedGrant`，绝不能恢复 entitlement、消息、筛选、历史或其他权限。
- KMP 不根据本地时间、等级名称或历史 grant 猜测当前权限；所有可执行能力仍以服务端接口的当前校验为准。

## 2. 兼容新增契约

`GET /api/v2/me/entitlements` 在原响应上新增必填 `lifecycle`：

| 字段 | 语义 |
|---|---|
| `state` | `free \| active \| expiring_soon \| expired \| revoked` |
| `expiringSoonWindowDays` | 服务端本次使用的即将到期窗口，范围 1–365 天 |
| `remainingDays` | 有效会员按服务端时间向上取整的剩余自然天数；非有效状态为 `null` |
| `endedGrant` | 最近一次已结束 grant 的只读展示摘要；当前有效或普通状态为 `null` |

`endedGrant` 同时包含当时的 tier/grant 快照、实际结束时间和撤销时的用户可见说明。它与顶层 `tier/grant` 严格隔离；所有服务端授权消费者继续只接受顶层当前 grant。

KMP DTO 将 `lifecycle` 设为可缺省，仅用于兼容仍返回 `1.x` 旧响应的开发环境；缺省时只能安全降级为原有 `active/free` 呈现，不能推导“即将到期”“到期”或“撤销”。`1.26.0` 服务端响应必须提供完整生命周期并通过状态一致性校验。

## 3. 服务端解析

- 先按原查询选择当前时间范围内、未撤销、最高 rank 的有效 grant。
- 有效 grant 距到期时间不超过配置窗口时返回 `expiring_soon`，否则返回 `active`。
- 没有有效 grant 时，查询最近一次实际结束的 grant；提前撤销优先使用撤销时间和用户可见说明，自然结束使用到期时间。
- 没有任何已开始的历史 grant 时返回 `free`。
- 已结束 grant 不参与 entitlement 合并；响应中的 entitlement 使用安全默认值且 `sourceTierId=null`。

源码新增可选绑定 `APP_MEMBERSHIP_EXPIRING_SOON_DAYS`，非法、空白或超出范围时安全使用 30 天。按当前工作顺序，本阶段只完成 Binding 类型与解析代码，不修改或启用 Wrangler 环境值。

## 4. Figma 与 KMP

`APP-MBR-02` 继续使用现有 5 个正式节点：

| 状态 | Node ID | 客户端来源 |
|---|---|---|
| 正常 | `159:70388` | `active` 或普通安全呈现 |
| 即将到期 | `159:70455` | `lifecycle.state=expiring_soon` |
| 到期 | `159:70533` | `lifecycle.state=expired`；旧响应的非有效状态安全降级到此页 |
| 撤销 | `159:70611` | `lifecycle.state=revoked` |
| 受限 | `159:70689` | 快照同步失败或当前账号不可读取 |

即将到期卡片显示服务端到期时间和剩余天数，并按 Figma 展示“当前状态：即将到期”处理卡。到期、撤销只说明服务端当前状态和安全返回路径，不把历史 tier 显示成当前等级，也不开放任何历史 entitlement。

## 5. 后置验证

本阶段不运行 TypeScript、OpenAPI、Gradle、Host Test、Nuxt 构建、模拟器或真机验收。开发全部收口后统一验证：

- 有效、窗口边界、自然到期、提前撤销和从未发放五类快照；
- 多 grant 下当前最高 rank 与最近结束记录的确定性选择；
- 已到期/撤销响应顶层 `tier/grant` 必须为 `null`，全部 entitlement 不可执行；
- KMP 对完整 `1.26.0`、旧 `1.x` 缺省字段和矛盾响应的安全处理；
- `APP-MBR-02` 五态同视口 Figma 回归。
