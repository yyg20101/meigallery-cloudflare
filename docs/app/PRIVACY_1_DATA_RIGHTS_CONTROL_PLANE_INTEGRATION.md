# Privacy-1 数据权利控制面跨仓开发基线

更新时间：2026-08-10

App 版本：1.0

状态：开发闭环完成；配置、migration 执行与专项测试后置

## 1. 本阶段结论

Privacy-1 已完成 App、API、D1、Nuxt 管理后台和运营告警之间的“可登记、可追踪、可取消”控制面：

- App API v2 累计契约提升至 `1.17.0`，新增数据权利 capability、策略快照、二次验证、导出/注销申请、本人记录、详情、取消和申请级状态访问。
- `0094_app_data_rights_control_plane.sql` 新增默认关闭的策略、申请、事件、验证、短期 step-up token、申请级状态 token 和幂等命令表。
- 注销申请会立即撤销普通 App/Web 会话，并在数据库层阻止新增互动、收藏、历史、话题、会员申请/发放和钱包调整。
- `/admin/app/data-rights` 与详情页提供 Owner 队列、领取、开始处理、失败、重试和经证据核验的平台取消动作。
- Operations-1 新增逾期数据权利申请检测，复用既有 `oprb_privacy_response_v1` Runbook 和统一 Incident 状态机。
- 独立 KMP 仓库已提交 `25d4397`、`498030d`，接入严格 `1.17.0` transport、系统安全存储、手机/宽屏页面、注销后请求级状态访问和成功响应丢失恢复。

Privacy-1 不生成导出文件、不签发下载地址、不执行不可逆删除，也不把未批准的保留、地区或 SLA 数字写入产品。上述处理属于 Privacy-2。

## 2. 默认关闭与生产门禁

运行时只读取以下可选环境变量，当前没有修改 Wrangler 或任何环境值：

| 变量 | 含义 | 当前要求 |
|------|------|----------|
| `APP_DATA_RIGHTS_ENABLED` | App 新申请与本人控制面总开关 | 默认关闭 |
| `APP_DATA_RIGHTS_ADMIN_ENABLED` | 后台领取与动作总开关 | 默认关闭 |
| `APP_DATA_RIGHTS_POLICY_VERSION` | 绑定不可变策略 ID | 未配置时不可开放 |
| `APP_DATA_RIGHTS_PRODUCTION_READY` | 非生产也按生产门禁校验 | 默认不放行 |

生产环境无论变量值如何，都要求策略同时满足：

- `state=published` 且 `production_ready=1`；
- 请求、导出、注销、处理与取消分别显式启用；
- retention、Owner/SLA 与 region 三类决策均由治理流程确认；
- 注销等待期和申请 SLA 只能来自已批准策略，不允许 API 或 App 常量兜底；
- Privacy-2 处理器、证据、恢复和事故预案就绪后，才允许打开 processing capability。

`0094` 只 seed development 策略 `drp_app_1_0_privacy_1_dev_1`，全部请求/处理开关关闭，三类治理决策保持 `unresolved`，不构成上线批准。

## 3. 数据模型与状态机

### 3.1 表职责

| 表 | 责任 |
|----|------|
| `app_data_rights_policies` | 不可变策略版本、独立能力开关、治理决策、TTL、等待期和 SLA |
| `app_data_rights_requests` | 账号绑定申请、策略快照、状态、版本、分配、截止/计划时间和账号恢复快照 |
| `app_data_rights_request_events` | 用户可见与内部事件；只追加 |
| `app_data_rights_verification_attempts` | 二次验证成功/失败与限流证据，不保存密码 |
| `app_data_rights_step_up_tokens` | SHA-256 摘要形式的短期、单用途、单次消费 token |
| `app_data_rights_status_tokens` | SHA-256 摘要形式的请求级状态凭证，只绑定单一申请与账号 |
| `app_data_rights_commands` | 账号与管理员写命令的幂等事实 |

申请、事件和幂等命令禁止删除；申请更新 trigger 约束单调版本、稳定账号/类型/策略快照、终态不可重开和合法状态迁移。

### 3.2 导出申请

```text
requested → collecting → ready → expired
     │           │
     ├───────────┴→ cancelled
     └────────────→ failed → collecting
```

Privacy-1 只创建 `requested` 并允许管理员进入 `collecting`、标记失败或重试。`ready/expired/completed` 必须由 Privacy-2 的真实制品处理器根据 R2 事实推进；本阶段没有伪造“已准备完成”的管理动作。

### 3.3 注销申请

```text
scheduled ──等待期结束且处理门禁开放──→ processing → completed
    │                                      │
    └──新鲜验证或管理员证据核验──────────→ cancelled
                                           └→ failed → processing
```

提交注销后，服务端原子执行：

- `users.status=deletion_pending`；
- `app_account_security.status=deletion_pending` 并递增 `session_version`；
- 撤销全部 `app_sessions`，删除旧 Web `sessions`；
- 写入安全事件和用户可见申请事件；
- 由 D1 triggers 阻止注销待处理账号新增受保护业务事实。

取消成功后恢复提交前的账号与安全状态快照，但再次递增 `session_version`，用户必须重新登录；旧状态 token 同时撤销。

## 4. 二次验证与请求级状态访问

- 导出申请、注销申请、取消和未来下载分别使用固定 purpose；purpose、账号、普通 session 和可选 request ID 必须完全匹配。
- 密码只在当前请求中进入 `verifyPassword`，数据库仅记录验证结果、目的、账号、请求追踪和时间。
- 同一账号 15 分钟内失败达到 5 次后返回 429；App 不把它误判为普通会话失效。
- step-up token 使用加密随机 32 字节，数据库只存 SHA-256，短期有效且成功写入后单次消费。
- 状态 token 由服务端 Secret、申请、账号和请求摘要确定性派生，数据库只存 SHA-256；它不是 Bearer token，不能访问任何普通 App API。
- 状态 token 有效期以申请截止时间或注销计划时间中较晚者为锚点，再叠加策略 TTL；等待期不会提前耗尽唯一的申请级访问窗口，客户端也不能自行续期。
- 注销使普通会话失效后，只开放以下三条请求级路径：查询绑定申请、为取消重新验证、取消绑定申请。
- App 通过 Android Keystore / iOS Keychain 支撑的安全存储保存最多 8 条状态凭证；损坏、撤销或过期凭证不降级为匿名访问。
- 为避免“服务端已注销退出、成功响应却在网络中丢失”导致用户失去申请凭证，App 会在发起前把随机幂等标识和当次 Access Token 作为单一待确认操作保存到系统安全区；step-up token 和密码仍不持久化。相同注销路由只允许原幂等键与被该次注销撤销的发起 session 重放既有结果，不创建新申请或恢复普通权限；恢复完成或确认未创建后立即清除待确认操作。

## 5. App API v2 `1.17.0`

所有账号路径使用 `Cache-Control: private, no-store`；写入需要合法 `Idempotency-Key`，取消还需要 `expectedVersion`。

| 方法与路径 | 凭证 | 说明 |
|------------|------|------|
| `GET /api/v2/me/data-rights` | App Bearer | 策略、治理决策、能力和最近 5 条申请 |
| `POST /api/v2/me/data-rights/step-up` | App Bearer | 按 purpose 进行密码二次验证 |
| `GET /api/v2/me/data-rights/requests` | App Bearer | 按类型游标分页读取本人申请 |
| `POST /api/v2/me/data-rights/export-requests` | Bearer + step-up | 幂等创建/合并导出申请 |
| `POST /api/v2/me/data-rights/deletion-requests` | Bearer + step-up | 三项确认后幂等创建注销申请并撤销会话；原幂等键可窄化恢复丢失响应 |
| `GET /api/v2/me/data-rights/requests/:requestId` | App Bearer | 本人申请详情与用户可见时间线 |
| `POST /api/v2/me/data-rights/requests/:requestId/cancel` | Bearer + step-up | 版本化取消本人申请 |
| `GET /api/v2/data-rights/requests/:requestId` | `X-Data-Rights-Token` | 只读取绑定申请 |
| `POST /api/v2/data-rights/requests/:requestId/step-up` | 状态 token | 只为绑定申请取消签发 step-up token |
| `POST /api/v2/data-rights/requests/:requestId/cancel` | 状态 + step-up | 注销退出登录后的版本化取消 |

账号 `restricted` 可以使用必要的 `/me` 与数据权利路径，其他产品 API 仍逐请求 fail-closed；`deletion_pending` 不能使用普通会话。

## 6. 管理 API 与 Nuxt 页面

### 6.1 管理 API

所有路由位于 `/api/admin/app/data-rights` 并返回 `private, no-store`：

| 方法与路径 | 权限 | 说明 |
|------------|------|------|
| `GET /overview` | admin | 读取默认关闭门禁、治理决策、状态聚合和最近申请 |
| `GET /requests` | admin | 按类型、状态、分配筛选最小化队列 |
| `GET /requests/:requestId` | admin | 脱敏账号、策略快照、状态与可见时间线 |
| `POST /requests/:requestId/claim` | Owner | 幂等领取；重新校验当前分配与版本 |
| `POST /requests/:requestId/actions` | Owner | `begin_processing / fail / retry / cancel_verified` |

开始或重试处理必须同时满足后台开关、策略 production-ready 和对应 processing capability。Privacy-1 故意不提供 `complete`：没有真实导出制品或不可逆删除处理证据时，管理员不能把申请手工点成完成。

平台取消必须提供证据引用；所有后台写入记录稳定 Action、请求 ID、原因码、用户文案摘要和最小安全上下文，不把密码、状态 token、完整邮箱或内部敏感正文写入通用审计。

### 6.2 页面

- `ADM-PRI-01` `/admin/app/data-rights`：治理门禁、状态指标、类型/状态/分配筛选和响应式队列。
- `ADM-PRI-02` `/admin/app/data-rights/{requestId}`：账号脱敏摘要、策略快照、时间线、领取和受门禁动作。

桌面使用结构化行，窄屏自动单列；长申请 ID、策略、Owner、状态文案和动作按钮允许换行且不越界。页面只反映服务端 `availableActions`，前端隐藏按钮不构成授权。

## 7. KMP App 页面与交互

- “我的”按 capability 显示“隐私与数据权利”；存在本机状态凭证时，即使未登录或 bootstrap 恢复失败也保留申请进度入口。
- 手机使用单列，宽屏使用治理/操作与申请记录双栏；详情独立展示权威状态和用户可见时间线。
- 导出、注销和取消弹层要求 8–128 位当前密码；注销还要求逐项确认会员金币、消息/依法保留和全设备退出影响。
- 注销成功后立刻清理普通会话及受保护页面，切换到明确的“申请级安全访问”；该状态不显示其他产品入口。
- App 重启或普通会话恢复失败时，先恢复系统安全区中的待确认注销操作；只有服务端证明原命令已创建，才换回申请级状态凭证。旧 Access Token 在此分支仅作原 session 证明，不能访问其他产品 API。
- 当 processing capability 关闭时，页面明确说明“当前只登记申请”，不显示虚假的下载或删除完成状态。
- `open_data_task` 站内通知目标进入数据权利页面后重新读取权威申请，不直接信任通知正文。

## 8. Operations-1 接入

`admin-app-operations` 新增 `privacy.data_rights_deadline` 检测：只统计超过 `deadline_at` 且仍非终态的申请，生成 `data_rights_overdue / safety / p1` Incident，并绑定 `oprb_privacy_response_v1`。

检测只上报聚合数量和稳定分类，不复制邮箱、申请正文、密码、token 或内部说明。Incident 用于诊断和升级，不能替代申请状态机，也不得阻断紧急修复部署。

## 9. 当前验证与后置工作

本阶段已完成：

- API TypeScript `tsc --noEmit`；
- Nuxt production build；
- KMP 静态差异检查与独立本地提交。

按当前“全部开发完成后再统一配置与测试”的顺序，本阶段未执行：

- `0094` 或完整 migration 链；
- local/dev/production 环境变量与 capability；
- D1 trigger、状态迁移、幂等、并发和权限专项测试；
- Ktor MockEngine、Android/iOS 构建、模拟器/真机与跨仓 E2E；
- WAF、速率限制、Owner 排班、告警和生产 Runbook 演练。

## 10. Privacy-2 进入条件

Privacy-2 只能在以下内容冻结后开始真实处理：

- 数据分类与导出范围、依法保留矩阵、地区适用性和删除/匿名化规则；
- 责任人、处理 SLA、客服升级、事故处理和完成证明；
- R2 导出制品加密、短期下载凭证、到期清理与下载审计；
- 不可逆删除处理器、依赖顺序、失败补偿、恢复边界和账务/安全证据排除；
- 完整威胁模型、migration 演练、生产 smoke 和回滚点。

没有上述门禁时只能保留 Privacy-1 的默认关闭控制面，禁止用管理员按钮、临时脚本或客户端文案假装已完成数据权利处理。
