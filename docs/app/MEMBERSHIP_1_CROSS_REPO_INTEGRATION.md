# Membership-1 跨仓交付与联调基线

App 版本：1.0

App API：v2 / `1.4.0`

状态：开发闭环已完成，production 未开放

## 1. 本阶段目标

Membership-1 建立一条可回滚、可审计且不依赖旧 Web 会员名称的最小纵向切片：

```text
开发期五级目录
  → 公共目录 API
  → KMP 五级目录与本人权益页
  → 管理员预览
  → 单账号手动发放或续期
  → 本人权威权益快照
  → 追加式撤销
```

本阶段只证明目录、typed entitlement、grant 和客户端展示能够端到端协作。它不代表五级额度已成为正式销售承诺，也不代表消息、收藏夹、历史等规划能力已经可执行。

## 2. 已交付范围

### 服务端与 D1

- `0071_app_membership_catalog_and_grants.sql` 创建版本化目录、五级等级、entitlement 定义、等级权益、不可变 grant、追加式撤销和管理员幂等请求表。
- 开发目录固定包含心遇、心悦、心知、心契、心耀，对应稳定 `rank=10/20/30/40/50`；中文名称不参与授权判断。
- entitlement 定义按目录版本完整快照，当前支持 `boolean`、`integer`、`enum` 三种值类型。七项开发值全部标记为 `planned`，因此只能展示，不能驱动消息、筛选、历史或收藏夹操作；未来目录不会覆盖旧版本的定义和文案。
- 当前等级只从未撤销且处于有效区间的 App grant 中取最高 `rank`；没有 App grant 时返回免费状态 `rank=0`。
- migration 不读取或回填 `user_memberships`，不把 `vip/svip` 静默映射为五级会员，也不向任何现有账号发放会员。

### App API

| 鉴权 | 方法与路径 | 当前行为 |
|---|---|---|
| 公开 | `GET /api/v2/membership/catalog` | 返回当前配置的五级目录、定义和值；关闭时返回稳定不可用错误 |
| App Bearer | `GET /api/v2/me/entitlements` | 返回本人当前 App grant、等级与已解析权益；账号由会话确定 |
| App Bearer | `GET /api/v2/me` | 会员能力启用时返回同一 App 会员摘要；不读取旧 Web `vip/svip` |

bootstrap 在 App API `1.4.0` 增加 `membership` capability：

- `catalog`：客户端是否可以请求公共目录。
- `entitlements`：客户端是否可以请求本人权益快照；只有 Auth 和会员能力均安全可用时才为 `true`。
- `applications`：当前固定为 `false`，客户端不得显示可提交的站内申请动作。

### Nuxt 管理后台

现有 `/admin/users/:id` 用户工作台增加独立的“App 五级会员”面板，并新增 `/admin/app/membership/grants/new` 对应 `ADM-MBR-04` 的独立工作台；两处复用同一组件和 API，明确与“旧 Web 会员（兼容）”隔离。独立工作台先搜索并确认正常账号，再展示当前会员、五级目录和 grant 时间线，支持立即或最多提前 90 天预约生效、同级续期、逐项 `available/planned` entitlement、预览、二次确认和追加式撤销。后台接口为：

| 方法与路径 | 用途 |
|---|---|
| `GET /api/admin/app/memberships/catalog` | 读取开发目录 |
| `GET /api/admin/app/memberships/users/:userId` | 读取目标账号当前状态与 grant 时间线 |
| `POST /api/admin/app/memberships/grants/preview` | 预览等级、有效区间、当前等级和风险提示，不产生写入 |
| `POST /api/admin/app/memberships/change-requests` | 使用 `Idempotency-Key` 创建发放或续期独立复核申请 |
| `POST /api/admin/app/memberships/grants/:grantId/revoke-request` | 使用 `Idempotency-Key` 创建撤销独立复核申请 |
| `GET /api/admin/app/memberships/reviews` | 读取不含内部备注的复核队列 |
| `GET /api/admin/app/memberships/reviews/:requestId` | 受控读取复核详情并写访问审计 |
| `POST /api/admin/app/memberships/reviews/:requestId/decision` | 独立管理员批准/拒绝并原子执行 |

发放时要求标准原因、用户可见说明、业务单号和可选内部备注。同一账号不能重复使用正在处理或已经生效的业务单号；持续时间为 1–366 天，预约生效最多提前 90 天；续期从同目录同等级的较晚有效到期时间延展。预览后仍需显式二次确认，提交沿用预览开始时间，避免人工确认耗时导致展示与结果漂移。Membership-3 已把发放、续期和撤销接入独立复核；没有正式策略时全部复核，发起人不能自审。通用审计不复制内部备注或复核意见正文。详细状态机见 [Membership-3 会员变更独立复核开发基线](./MEMBERSHIP_3_CHANGE_REVIEW_INTEGRATION.md)。

### KMP 客户端

- “我的”页提供会员入口；会员页是独立页面，不增加第五个底部导航项。
- 未登录可查看公共五级目录；登录后再请求本人权威快照。
- 页面覆盖加载、不可用、未登录、免费、有效会员和本人快照失败状态。
- 可横向切换五级并查看七项具体权益、获取方式、平台运营接收说明和“不保证回复、固定时效或关系结果”边界。
- `planned` 权益逐项显示“规划中”，页面不提供在线支付、自动续费、站内申请或虚假可执行入口。
- DTO 映射校验稳定 ID、ISO 时间、恰好五级且 rank 唯一递增、entitlement 定义和值类型、每级定义完整性以及 `planned` 不可执行；异常响应按最小权限拒绝。

## 3. 数据权威与安全约束

- 客户端目录和快照只用于展示；未来任何受限业务 API 仍必须逐次在服务端解析和校验 entitlement。
- 账号 ID 不由客户端提交，本人快照以 Bearer 会话确定账号。
- grant 本体不可更新和删除；纠错通过撤销记录或新的补偿 grant 完成。
- 相同幂等键和相同请求返回原结果；相同键对应不同请求返回 `IDEMPOTENCY_CONFLICT`。
- production 同时要求运行时生产门禁和目录行 `state=published + production_ready=1`。开发草案无法仅靠修改一个开关进入生产。
- `internal_note` 只允许最小权限后台读取，不进入 App API、普通日志或审计正文。

## 4. 运行时开关

| 变量 | 作用 | 当前 production/dev 默认值 |
|---|---|---|
| `APP_MEMBERSHIP_ENABLED` | 公共目录及 App 会员能力总开关 | `false` |
| `APP_MEMBERSHIP_ADMIN_ENABLED` | App 会员后台操作开关 | `false` |
| `APP_MEMBERSHIP_CATALOG_VERSION` | 明确选择目录版本 | `amc_app_1_0_draft_1` |
| `APP_MEMBERSHIP_PRODUCTION_READY` | production 人工放行门禁 | `false` |

不得把 production 开关打开作为联调手段。本地或隔离 dev 验证时也必须明确记录使用的目录版本。

## 5. 本阶段未交付

- 用户会员申请、申请状态与后台申请队列。
- 高风险/批量发放和双人复核。
- 账号级 entitlement 例外、额度消耗、周期重置和实时撤权事件。
- 旧 Web `vip/svip` 迁移、dry-run 和迁移对账。
- 消息、收藏夹、历史等 entitlement 的业务执行。
- 站内通知、支付、自动续费、退款、礼物、头像框和皮肤。
- 生产目录发布工具、production migration、production 开关变更和生产部署；dev 已随 Safety-2 连续升级应用空 schema，但目录与后台能力仍关闭。

上述能力仍保留在产品目标 PRD 中，必须以新的纵向切片分别实现和验收，不能通过远程配置提前开放。

## 6. 验证基线

服务端仓库：

```bash
corepack pnpm --filter @meigallery/api test
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/api build
corepack pnpm --filter @meigallery/web exec nuxt build
```

客户端仓库：

```bash
./gradlew testAndroidHostTest
./gradlew :apps:androidApp:assembleDebug
./gradlew :apps:shared:app:compileKotlinIosSimulatorArm64
```

本地 D1 必须从空目录连续应用 `0001–0071`。测试至少覆盖五级目录完整性、无旧会员隐式映射、预览/发放/续期、幂等冲突、审计隐私、最高有效 rank、到期、追加式撤销和 production 双门禁。

2026-08-06 开发验收已完成：全新临时 D1 的 71 条 migration 全部成功，结果为 5 个等级、35 项 `planned` 等级权益和 0 个账号 grant；Android API 36.1 模拟器通过公共目录入口、五级横向访问、心遇/心知/心耀切换、长列表滚动和服务边界检查，未发现可见越界或崩溃。该结果不替代未来 Auth 登录后的本人 grant 联调和 Android/iOS 真机验收。

## 7. 进入下一阶段前的产品决策

1. 确认 OQ-014：五级额度、历史保留天数和筛选档位是否可以作为生产承诺。
2. 决定先做 Membership-2 用户申请，还是先做 Message-1 仅文本平台话题；两者均不能把本阶段 `planned` 值直接当作已上线权限。
3. 关闭 OQ-016 后再设计旧会员迁移；默认选择仍是不迁移、不映射。
4. 为批量或高风险发放确定阈值、角色和双人复核规则后，再扩展后台写流程。
