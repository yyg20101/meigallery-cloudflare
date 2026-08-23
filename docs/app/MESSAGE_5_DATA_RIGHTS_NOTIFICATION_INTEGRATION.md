# Message-5 数据权利结果通知跨仓交付基线

更新时间：2026-08-20

App 版本：1.0

状态：Cloudflare 源码接线完成；不新增页面或 API 形状；migration、配置、构建、测试与设备 QA 统一后置

## 1. 本阶段结论

Message-5 补齐 Message-3 已冻结、Privacy-2 已具备业务事实、KMP 已具备 `open_data_task` 跳转，但 Cloud 端尚未生成通知的断点：

- `0109_app_data_rights_notifications.sql` 激活既有 `data.export_ready` 与 `account.deletion_updated` 定义，并增加两份固定 development 中文模板。
- 私有导出只有在 R2 归档完整性、申请 `ready`、制品 `ready`、任务 `completed` 和用户可见 `export_ready` 事件在同一 D1 batch 收敛后，才由 trigger 原子写入 Outbox。
- 注销申请创建后账号立即进入 `deletion_pending`，不可逆处理期间不能使用普通通知中心。只有经密码或平台证据核验的取消动作恢复账号安全状态后，才为同一申请版本生成一条“注销已取消”必要通知。
- 通知目标继续使用既有 `data_task + requestId + open_data_task` 契约；服务端每次返回时重验申请归属与当前数据权利 capability，不把通知正文当作申请、制品或下载权限。
- KMP 既有通知动作已进入数据权利页面并重新读取权威申请，无需新增 Figma Frame、页面状态或客户端 transport。

本切片不新增系统推送，不通知不可逆注销完成，不回填历史数据权利事件，也不改变通知或数据权利保留政策。后续 Message-7 已在不改变本切片注销边界的前提下补齐导出失败必要通知。

## 2. 事件与隐私边界

| eventType | 触发事实 | 通知目标 | 可投递条件 |
|-----------|----------|----------|------------|
| `data.export_ready` | 用户可见 `export_ready` 事件，申请与制品均为 `ready` | 数据导出申请 | 通知策略 generation 已开启、定义 active |
| `account.deletion_updated` | 注销申请为 `cancelled`，账号安全状态已从 `deletion_pending` 恢复 | 注销申请 | 同上，且恢复后的账号不再被 0103 抑制 |

以下情况明确不生成通知：

- 用户刚提交导出或注销申请；同步响应和申请时间线已经给出结果。
- 导出开始、重试或过期；Message-5 当时不通知失败，后续 Message-7 已用独立 `data.export_failed` 定义、固定模板和严格失败事实 trigger 补齐，不能借 ready 模板扩权。
- 注销处于 scheduled、processing、failed 或 completed；账号仍为待注销或已经删除，只能通过申请级状态凭证读取进度。
- 通知策略未启用、定义非 active、事件不是用户可见事实，或目标申请版本不一致。

`0103` 的 `app_data_rights_deletion_suppress_notification_outbox_insert` 继续是不可绕过的隐私边界。Message-5 没有为了“送达”而恢复旧会话、放宽 `deletion_pending` 访问或保留已清理通知。

## 3. 固定安全模板

两份模板均不使用动态变量：

- 导出就绪只提示重新进入数据权利页面，不包含 R2 key、URL、下载票据、摘要、文件大小或导出内容。
- 注销取消只说明账号访问已恢复并要求重新登录，不声称旧 session、旧设备或凭证已恢复。

模板初始状态为 `development`。production 必须通过 Message-3 的独立复核与发布工作流形成新的 published 版本；migration 不原地批准模板。

## 4. 受控目标校验

`AppNotificationTargetCapabilities` 增加内部 `dataRights` 判定。通知列表与详情仅在以下条件同时满足时返回可执行目标：

1. App Auth 当前可用；
2. 数据权利运行时配置可解析；
3. 当前策略允许 overview，production 环境还必须通过 production-ready 门禁；
4. `app_data_rights_requests.id` 属于当前内部账号。

任一条件不满足时通知仍可作为安全历史说明读取，但 `available=false`，客户端不得执行跳转。该切片交付时复用既有公共枚举，不改变当时累计 App API `1.25.0` 的 JSON 形状或 OpenAPI 版本。

## 5. Figma 与客户端

本切片不创建页面：

- 通知列表与安全详情继续使用 `APP-MSG-05/06` 的正式 Figma 状态。
- 数据导出和注销继续使用 `APP-SET-09/10` 的正式 Figma 状态。
- KMP `NotificationAction.OpenDataTask` 已调用现有数据权利入口，页面打开后通过 HTTP 重新读取申请；未知 capability、对象失效和需要升级继续落入 `APP-MSG-06` 既有状态。
- 不可逆注销完成后仍按 Privacy-2B 返回未登录“我的”；`APP-SET-10` 没有 completed 正式 Frame，不得用通知创建自拟完成页。

因此正式页面总量保持 99 个 Page ID / 408 个状态，Mobile 保持 50 / 208。

## 6. 默认关闭与后置门禁

本阶段没有修改 Wrangler、环境变量、通知策略、数据权利策略或定时任务，也没有执行 migration。

统一验证阶段至少完成：

1. 执行 `0076`、`0094`、`0097`、`0102`、`0103`、`0109` 的隔离顺序与 schema 验证；
2. 验证通知策略关闭时不写 Outbox，开启后同一用户可见事件只生成一条；
3. 验证导出 ready 的申请/制品/事件任一失败都不产生通知；
4. 验证注销 pending/processing/failed/completed 均受抑制，只有取消并恢复账号后生成通知；
5. 验证其他账号、失效 capability、过期目标和重复消费均 fail closed；
6. 完成 OQ-020、模板独立审批、Android/iOS 真机、弱网、多设备和无障碍验收。

在这些门禁完成前，源码完成不构成 dev 或 production 开放授权。
