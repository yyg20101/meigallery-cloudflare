# Privacy-2B 账号不可逆注销跨仓交付基线

更新时间：2026-08-20

App 版本：1.0

状态：源码与 Wrangler Queue 契约完成；dev Queue 已创建但未绑定；治理审批、production 资源、migration、密钥和生产启用受门禁后置

## 1. 本阶段结论

Privacy-2B 在 Privacy-1 的申请、冷静期、请求级状态凭证和写入阻断之上，补齐可恢复、可核验且只能前向推进的不可逆注销执行链：

- `0103_app_data_rights_irreversible_deletion.sql` 新增不可变 deletion profile、九步执行快照、逐步证据、七类保留隔离摘要、可选身份封存和账号墓碑。
- Recommendation-6 的 `0114_app_recommendation_evidence_lifecycle.sql` 与生命周期服务把账号关联推荐会话/条目纳入第四步的初始计数、物理删除和最终零残留核验。
- 管理员只能在 `ADM-PRI-02` 开始或重试。只有 Queue 执行器逐步核验完成证据后才能把申请写为 `completed`；后台没有人工“完成”按钮。
- 执行器按 D1 租约和步骤检查点恢复。每条消息只推进当前一步；重复消息、旧租约、已完成步骤和响应丢失不会建立第二条注销事实链。
- 开始不可逆处理后，失败进入 `failed` 并要求前向修复；不会恢复会话、登录身份、互动写入、钱包或其他账号能力。
- `users` 行继续作为审计、钱包、安全和数据权利事实的 FK 锚点，但邮箱、用户名、昵称、密码、头像和外部转换标识会被清除或墓碑化，账号状态固定为 `deleted`。
- KMP 在请求级状态通道读到 deletion `completed` 后，清除状态凭证、普通会话和账号域内存，并轮换安装标识，然后退出到未登录“我的”。
- `APP-SET-10` 没有正式完成页；客户端不得自行创造完成态 UI。正式节点仍只有 normal `159:74370`、blocked `159:74454`、processing `159:74511`、failed `159:74568`。

OQ-020、OQ-024、OQ-025 当前仍未关闭。源码完成不代表允许接入真实数据、执行 `0103` 或打开注销处理能力。

## 2. 默认关闭与启用边界

Privacy-2B 初始切片当时没有修改 Wrangler、Queue binding、Secret、环境 capability 或任何 dev/production 值，也没有执行 migration。统一配置阶段随后补齐了保持关闭的 Queue 源码契约并只创建隔离 dev 主 Queue/DLQ；这不表示 Worker 已绑定、Secret 已配置或不可逆处理已获授权。

`0103` 只 seed development profile `drdp_app_1_0_privacy_2b_dev_1`：

| 项目 | development 值 | 约束 |
|------|-----------------|------|
| `state` | `development` | production 必须是 `published` |
| `production_ready` | `0` | 默认禁止不可逆处理 |
| `executor_version` | `privacy-2b-v1` | 执行时冻结到 execution |
| `expected_step_count` | `9` | 与代码和 profile steps 必须精确一致 |
| 五项治理决策 | `unresolved` | retention、backup、third party、identity reuse、evidence 均须批准 |
| `identity_reuse_mode` | `unresolved` | 正式 profile 只能批准 `release` 或 `seal` |

开始或重试必须同时满足：

1. Privacy-1 policy 为 `published + production_ready`，且 deletion request 与 processing 均显式启用；
2. policy 的 retention、Owner/SLA、region 决策均为 `approved`；
3. 与 policy 绑定的 deletion profile 为 `published + production_ready`；
4. profile 的 retention、backup、third party、identity reuse、evidence 五项决策和每个步骤治理引用均已批准；
5. 九步顺序、handler 和 disposition 与当前执行器完全一致；
6. `DATA_RIGHTS_DELETION_QUEUE` 已绑定到 `meigallery-app-data-rights-deletion`；
7. identity reuse 采用 `seal` 时，`DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT` 是有效密钥；轮换期可同时提供 `DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS`；
8. 申请处于服务端允许的 `scheduled` 或可恢复 `failed` 状态，版本、账号和授权快照未变化。
9. 既有 `SESSION_SECRET` 至少 16 字符，并在任何推荐证据存续期间保持与写入时一致，使注销执行器能够复算分用途账号 HMAC。

任一条件缺失、未知或矛盾时 fail closed。

## 3. D1 权威事实

| 表 | 责任 |
|----|------|
| `app_data_rights_deletion_profiles` | 不可变执行版本、九步数量、五项治理结论及身份复用策略 |
| `app_data_rights_deletion_profile_steps` | 固定顺序、handler、disposition 和步骤治理引用 |
| `app_data_rights_deletion_executions` | 单申请唯一执行、租约、当前步骤、尝试次数和终态 |
| `app_data_rights_deletion_steps` | 执行时冻结的九步合同与逐步检查点 |
| `app_data_rights_deletion_evidence` | 每步初始/最终/影响数量、安全摘要和不可变 digest |
| `app_data_rights_retained_domains` | 七类合规保留域的数量、访问范围和治理引用 |
| `app_data_rights_identity_seals` | 可选邮箱 HMAC、密钥版本外的治理绑定和释放时间；不保存原邮箱 |
| `app_data_rights_account_tombstones` | 完成后的证据根摘要、profile/executor 版本和七域计数 |

profile、profile steps、证据、保留域、身份封存和墓碑均禁止更新或删除。执行表只通过条件状态迁移和租约推进，不能覆盖已经完成的步骤。

## 4. 九步不可逆执行

| 顺序 | step | 处理 |
|------|------|------|
| 1 | `revoke_access` | 撤销 App/Web 会话、设备、step-up 和未消费实时短票据，清理账号全部实时票据元数据，关闭账号当前实时连接，保持 `deletion_pending` |
| 2 | `purge_private_exports` | 使导出任务/票据失效并删除已登记私有 R2 制品 |
| 3 | `purge_notifications` | 删除本人通知、偏好、已读和 outbox 事实 |
| 4 | `purge_discovery_activity` | 删除喜欢、关注、收藏、历史、搜索、保存条件、屏蔽，以及同一 HMAC 账号摘要命中的推荐会话和级联条目 |
| 5 | `purge_account_preferences` | 删除推荐、历史、搜索、资料和话题偏好 |
| 6 | `anonymize_analytics` | 解除命名分析、邀请与账号的可识别关联 |
| 7 | `close_managed_conversations` | 先取消未完成文本审核案件并清除正文租约/命令重放，再写系统释放事件、释放有效 assignment 并关闭平台话题 |
| 8 | `isolate_regulated_records` | 冻结钱包并为七类必须保留的根事实写合规隔离证据 |
| 9 | `tombstone_account` | 删除身份方式与验证码、清头像 R2，墓碑化 `users` 锚点 |

除 `retain_isolated` 外，每步 handler 完成后都会重新计数；剩余数量不为零即以 `deletion_step_incomplete` 失败，不能用“已调用 handler”代替实际完成。最后还必须核验九份证据、九个完成检查点、七个保留域、账号墓碑与证据根摘要，才能原子推进申请和 execution 到 `completed`。

## 5. 七类保留隔离域

| domain | 根事实范围 |
|--------|------------|
| `consent` | 账号同意与确认记录 |
| `membership` | 会员 grant、申请及其用户可见事件、管理员批量发放逐行证据 |
| `wallet` | 钱包、不可变分录和管理员调币申请；钱包先冻结 |
| `messaging_evidence` | 已关闭平台话题、消息证据及只读的文本审核评估/案件事件；未完成案件已收敛为 `cancelled`，隔离数量同时纳入三类审核子事实 |
| `safety` | 举报、举报申诉和服务申诉根事实 |
| `data_rights` | 数据权利申请及其用户可见事件 |
| `security_audit` | 账号安全事件和二次验证尝试 |

这些记录不是普通产品能力，也不会恢复给已删除账号。`access_scope` 固定为 `compliance_only`；子表依据各自父事实和既有访问控制继承隔离边界。正式保留期限、合法基础、备份删除、第三方处理与证据访问仍须由 OQ-020/OQ-024/OQ-025 的批准材料冻结。

## 6. 并发、恢复与写入阻断

- Queue 消息只携带 schema、kind 和稳定 execution ID，不携带邮箱、密码、token 或业务正文。
- 两分钟短租约和 D1 条件更新保证同一 execution 只有当前 lease holder 推进；租约失效由定时恢复重新派发。
- 步骤开始先写初始计数，handler 完成后写不可变 evidence，再条件提交 step/checkpoint；中断后从权威步骤恢复。
- 可重试基础设施失败由 Queue 重试；治理变化、步骤合同不符、证据不完整或实际残留属于 fatal failure，管理员修复原因后才能显式重试。
- `0103` 在 Privacy-1 既有 triggers 上继续阻止待注销账号重建身份、会话、设备、偏好、互动、通知、导出和命名分析关联；通知/分析的合规异步生产者按定义抑制写入，避免无关任务回滚自身事务。
- Message-8 审核取消只改变案件租约与状态，不把保留消息伪装成审核通过/拒绝，也不在第 3 步清空通知之后重新创建结果 Outbox。
- 后续 Message-5 不放宽这条边界：scheduled、processing、failed、completed 均不生成普通站内通知；只有已验证取消先恢复账号安全状态后，`0109` 才为同版本申请生成一条取消结果通知。
- 注销完成后的身份复用遵循已批准 profile。`seal` 只以独立 Secret HMAC 比较，支持 current/previous 两把密钥轮换；Secret 缺失时注册 fail closed。
- 推荐证据使用与游标签名分用途隔离、但由既有 `SESSION_SECRET` 派生的账号 HMAC。密钥在证据存续期间不得无计划轮换；推荐能力或记录开关关闭也不能跳过已存在账号关联证据的注销删除。

失败后只能继续前向删除、匿名化或补证。绝不把账号从 `deletion_pending/deleted` 恢复为 active，也不撤销已经执行的清理。

## 7. 管理后台与用户终态

`ADM-PRI-02` 复用 Figma `944:16747` 的现有详情布局，展示：

- deletion profile readiness 与拒绝原因；
- execution 状态、版本、当前/已完成步骤和尝试次数；
- 九步初始/最终/影响数量、完成时间和证据摘要；
- 七类保留域数量、合规访问范围、治理引用和 tombstone 证据根；
- 开始/重试 Queue 派发结果。

管理员只可开始或重试，不能人工完成、撤销处理中的注销或恢复账号。失败态明确标记“前向修复”。

KMP 严格使用 `APP-SET-10` 四个正式节点：

| 状态 | Node ID | 客户端行为 |
|------|---------|------------|
| normal | `159:74370` | 展示影响与逐项确认 |
| blocked | `159:74454` | 展示服务端权威阻断原因 |
| processing | `159:74511` | scheduled 可取消时显示撤回；越过截止或 processing 后禁用撤回 |
| failed | `159:74568` | 展示安全失败原因并允许刷新状态 |

`APP-SET-10` 没有 completed 正式节点。请求级状态读取到 `completed` 后，客户端清理本地账号态、状态凭证和安装标识，直接返回未登录 `APP-SET-01`/“我的”；不会渲染自拟成功页。取消成功同样退出注销页并要求重新登录，以读取服务端恢复后的账号事实。

用户明确下载到设备的 Privacy-2A TAR 属于用户控制文件，不由账号注销在本机自动删除。

## 8. 配置契约

源码配置已显式声明下列 Queue；Secret 仍必须在远端能力启用前由获授权操作员建立：

| 名称 | 用途 |
|------|------|
| Queue `meigallery-app-data-rights-deletion` | 九步执行和租约恢复消息 |
| `DATA_RIGHTS_DELETION_QUEUE` | API producer/consumer binding |
| `DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT` | identity seal 当前 HMAC Secret |
| `DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS` | Secret 轮换期只读兼容 |

`wrangler.toml` 已声明 production `meigallery-app-data-rights-deletion` 与隔离 dev `meigallery-app-data-rights-deletion-dev` 的 producer/consumer、有界单并发和诊断 DLQ，初始化脚本同步覆盖幂等创建；dev 主 Queue/DLQ 已创建但尚无 producer/consumer，能力开关保持关闭，production Queue、Secret、cron 和 migration 均未执行。若正式策略选择 `identity_reuse_mode=release`，仍须保留代码与配置对既有 seal 的安全判断，不能直接删除 previous-key 轮换能力。

Recommendation-6 不新增 Secret 或 binding；它复用推荐证据写入既有的 `SESSION_SECRET`。Privacy-2C 的 41 类个人数据副本也用同一分用途 HMAC 定位本人推荐会话/条目。正式配置阶段必须把“在途推荐 scope 完成、证据清空并零残留核验”纳入该密钥任何轮换或撤销的前置条件。

## 9. 契约版本与 Figma 边界

Privacy-2B 复用其交付时 App API v2 `1.24.0` 已存在的 deletion `scheduled | processing | completed | failed`、请求级状态路径和管理员内部详情扩展，没有新增公共响应形状，因此当时不提升 OpenAPI transport 版本。Membership-7 后仓库当前累计版本为 `1.26.0`；`revoke_access` 同步失效短票据、清理实时票据元数据并尽力关闭连接，但不改变 deletion 的公共响应形状。

Figma 是可见状态唯一事实源：

- 移动端不新增 completed 页面；终态行为是退出到未登录“我的”。
- 后台复用 `ADM-PRI-02` 既有页面和 amber executor 区，不增加新 Page ID 或正式状态。
- 任何未来“删除完成证明下载”、批量注销、恢复或额外阻断态，必须先在 Figma 建立正式 Frame 和 Prototype 行为。

## 10. 明确后置事项

以下列表是最初切片交付时的历史后置记录；2026-08-24 已完成 Cloud/KMP 源码级构建测试与 KMP 真机 Mock QA，尚未完成的仍是 migration、Worker binding、Secret、治理审批和不可逆处理环境专项 QA：

- `0103/0114` 或完整 D1 migration 链；
- 远端 Queue、Secret、cron、migration 与 dev/production capability 启用；Wrangler 源码契约已完成但不等于远端已配置；
- TypeScript/Kotlin 构建、单元/集成/E2E、并发与失败注入测试；
- Android/iOS 模拟器、真机、`android-cli` 截图和 Figma 像素验收；
- 大账号吞吐、R2 局部删除失败、租约中断、死信、备份/第三方删除与事故恢复演练；
- OQ-020 保留矩阵、OQ-024 地区/跨境结论、OQ-025 隐私 Owner/SLA/事件流程审批。

上述门禁完成前，deletion processing 必须保持关闭，development profile 不得改写为 production-ready。
