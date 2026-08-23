# Message-4 账号级实时刷新跨仓交付基线

更新时间：2026-08-20

状态：Cloudflare 与 KMP 源码开发完成；默认关闭；配置、migration、构建、测试与设备 QA 后置

## 1. 交付结论

Message-4 把 App API v2 累计契约以兼容新增方式提升到 `1.25.0`，实现账号级、只携带刷新提示的 WebSocket 通道。D1 和现有已鉴权 HTTP API 继续是消息、通知、会员、钱包与账号状态的唯一业务权威；实时通道不承载正文、不授予写权限，也不替代 Message-3 Outbox。

本切片不关闭 OQ-028。`0105_app_realtime_refresh_channel.sql` 的 development 策略固定为 `unresolved + disabled + production_ready=0`，仓库不在本阶段增加 Durable Object binding 或环境开关。源码存在不表示 dev/production 已开放。

## 2. 产品与隐私边界

- 用户仍通过 HTTP 创建话题、发送消息、读取通知、查看会员和金币；WebSocket 只要求客户端重新拉取相关 HTTP 资源。
- 服务端帧只允许 `account|conversations|messages|notifications|membership|wallet` 六个范围、事件游标和发生时间。
- 帧不得包含消息/通知正文、人物资料、账号公开 ID、内部账号 ID、管理员身份、会员申请说明、金币调币备注、安全证据、Token 或内部备注。
- 不发送真人在线、正在输入、已读、实时位置或等待用户等推断状态；平台运营接收披露保持不变。
- 不接入 APNs、FCM 或系统通知权限；App 退到后台即停止连接，恢复前台后按游标补偿并以 HTTP 对账。
- 连接失败不得回滚已经提交到 D1 的业务写操作，也不得把缓存内容宣称为最新。

## 3. Cloudflare 实现

### 3.1 D1 控制面与短票据

`0105_app_realtime_refresh_channel.sql` 新增：

- `app_realtime_policies`：版本化策略、治理引用、一次性票据 TTL、账号连接上限、重放/保留上限和重连区间；启用必须同时满足 `published`、容量批准和治理引用。
- `app_realtime_tickets`：只保存短票据 SHA-256，绑定账号、当前 session、设备和请求 ID；票据短期有效、只能消费一次，可在退出、设备撤销或账号注销时取消。
- active principal trigger：签发时重新确认账号、session、设备和策略仍有效；身份字段和终态均不可逆修改。

明文 `mrt_` 票据只出现在当前签发响应和随后的 `Authorization: Realtime <ticket>` 握手 Header，不写入 URL、D1、日志或客户端持久化状态。

### 3.2 HTTP 与 WebSocket 入口

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/api/v2/realtime/tickets` | 使用当前 Bearer 会话签发一次性短票据 |
| `GET` | `/api/v2/realtime/connect` | 使用 Realtime 票据完成 WebSocket Upgrade |

bootstrap 新增：

- `capabilities.realtime`；
- `realtime.policyVersion|transport|protocol|ticketPath|connectPath`；
- `eventSchemaVersion|ticketTtlSeconds|reconnectMinDelayMs|reconnectMaxDelayMs|maxConnectionsPerAccount`。

以下任一条件不满足时 capability 必须为 `false`：运行时开关、Durable Object binding、账号鉴权、消息/通知业务资格、策略形状、发布状态、容量决定、治理引用或 production-ready 门禁。

### 3.3 Durable Object

`AppRealtimeHub` 使用一个内部账号一个实例，并采用 Hibernation WebSocket API：

- SQLite 只保存账号实例配置、无正文刷新事件、稳定去重哈希和单调游标；
- 连接 attachment 只保存内部 connection/session/device/ticket 标识，用于退出和撤权时定向关闭；
- 每账号连接、重放事件和保留事件均由 D1 已批准策略设上限；
- 服务端发出 `server.ready` 后要求客户端在 15 秒内且只能发送一次 `client.hello`；超时、重复或字段不精确均以协议错误关闭连接；
- 事件超出可重放窗口、客户端游标为零或游标领先服务端时，发送全范围 `refresh.required`，要求 HTTP 全量对账；
- D1 业务成功后以 `waitUntil` 尽力发布，DO 失败不改变权威业务结果。

### 3.4 协议 `meigallery.realtime.v1`

连接建立后服务端先发送：

```json
{"type":"server.ready","schemaVersion":1,"protocol":"meigallery.realtime.v1","serverTime":"2026-08-20T00:00:00.000Z"}
```

客户端只允许回复：

```json
{"type":"client.hello","schemaVersion":1,"lastCursor":42}
```

刷新帧：

```json
{
  "type": "refresh.required",
  "schemaVersion": 1,
  "eventId": "rte_xxx",
  "cursor": 43,
  "occurredAt": "2026-08-20T00:00:01.000Z",
  "scopes": ["conversations", "messages"]
}
```

重放结束后发送：

```json
{"type":"server.synced","schemaVersion":1,"cursor":43,"serverTime":"2026-08-20T00:00:01.100Z"}
```

客户端命令字段、服务端帧字段、枚举、帧大小和游标上限均严格校验；未知命令或非法帧关闭连接，不尝试宽松解释。

### 3.5 当前刷新触发点

| 权威变化 | 刷新范围 |
|----------|----------|
| 话题创建、观看者/运营消息、已读、关闭 | `conversations + messages` |
| 通知投递、单条/分类已读 | `notifications` |
| 会员申请用户可见状态、会员复核生效、直接发放/撤销 | `membership` |
| 管理员调币独立复核并实际入账 | `wallet` |
| 设备撤销、退出、凭证重放、不可逆注销 | 取消票据并关闭对应 device/session/account 连接；不可逆执行清理全部账号票据元数据 |

幂等重放不重复发布。管理员路由只把公共账号 ID 解析为内部账号后调用统一发布器，事件和通用日志不暴露该内部映射。

## 4. KMP 实现

- `RealtimeCapability` 对 bootstrap 的协议、路径、schema 和全部数值边界做严格验证；未知或矛盾配置安全关闭。
- `KtorRealtimeRepository` 先通过现有自动续期的 Bearer 执行器取票据，再用独立 WebSocket 客户端连接；票据不进入 Compose state、日志或安全存储。
- 客户端仅接受三个服务端帧，要求字段集合精确匹配；重复/旧游标按连接内幂等忽略，非连续游标或服务端 full sync 扩大为六范围 HTTP 对账，`server.synced` 必须与已观察游标一致。
- Android 使用 `Application.ActivityLifecycleCallbacks`，iOS 使用前后台系统通知；后台取消连接，前台恢复。
- 断线使用 bootstrap 下发区间内的指数退避和抖动；账号切换清零进程内游标，session/device/account 撤权关闭码会清除本地会话并回到登录态。
- 消息或通知页已有缓存时，断线复用 Figma `APP-MSG-05`“实时离线”状态；恢复同步后先 HTTP 补拉，再清除离线提示。

本切片没有新增或改动可见 UI，也没有新增 Figma 状态。消息、通知、会员和钱包页面继续使用现有正式节点与状态映射。

## 5. 数据权利与撤权

- Privacy-2A 导出新增 `realtime_connection_tickets` 白名单类别，只包含策略版本、用户可见设备 ID、签发/到期/消费/取消时间和取消原因；不导出票据记录 ID、token hash、内部账号/session ID 或 connection ID。
- Privacy-2B 的 `revoke_access` 步骤先取消未消费票据，再清理该账号全部实时票据元数据，并在 D1 成功后尽力关闭账号所有连接。
- 当前 session 退出取消该 session 未消费票据并关闭其连接；远程设备撤销同理按设备执行。Refresh Token 重放撤销同一 session 的票据并关闭连接。
- 这些连接动作只用于缩短刷新通道存活时间；所有 HTTP API 仍独立重验 session、设备、账号和业务权限。

## 6. 后置启用与验证门禁

按当前开发顺序，本阶段不执行下列动作：

1. 不执行 `0105` migration，不写 dev/production 数据。
2. 不增加 Wrangler Durable Object binding、SQLite migration tag 或运行时环境值。
3. 不把 OQ-028、容量预算、保留治理或生产排班标记为已关闭。
4. 不运行 TypeScript/KMP 构建、测试、模拟器/真机、浏览器或 `android-cli` 截图验收。
5. 不部署、不提交、不推送。

全部开发结束后的专项验收至少覆盖：默认关闭、一次性票据并发消费、票据过期/撤销、每账号连接上限、DO 休眠恢复、断线重放/全量补偿、事件去重、多设备已读、前后台停连、账号切换游标隔离、非法帧、正文/内部字段泄漏扫描，以及 session/device/account 撤权关闭。

## 7. 验收标准

- `MSG4-AC-001`：任何实时帧都不能返回业务正文、个人资料、内部 ID、管理员信息或 Token。
- `MSG4-AC-002`：客户端只因刷新提示重新读取 HTTP；WebSocket 数据不能直接改写权威业务对象。
- `MSG4-AC-003`：票据绑定账号、session 和设备，短期一次性消费，退出、设备撤销和注销均能使其失效。
- `MSG4-AC-004`：断线保留可见缓存并明确离线；恢复后先补拉再恢复“最新”状态。
- `MSG4-AC-005`：OQ-028 或任一运行/治理/生产门禁未满足时 bootstrap 必须返回 `realtime=false`。
