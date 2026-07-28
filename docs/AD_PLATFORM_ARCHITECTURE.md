# 通用广告归因架构

## 目标

归因运行时只负责四件事：

1. 识别一次访问的唯一付费广告来源。
2. 记录 `Contact`、`CompleteRegistration` 业务事实。
3. 为来源平台生成 Browser 与 Server 投递。
4. 隔离平台故障，保证浏览、联系和注册不受影响。

Meta、TikTok、Google 共用来源路由、事实和投递模型；平台脚本、凭证、Queue、事件目标与外部请求完全隔离。

```text
click ID / 后台受管投放链接
              |
              v
       唯一来源路由器
              |
              v
HttpOnly 加密来源上下文（30 天最后一次付费来源）
              |
              v
Contact / CompleteRegistration
              |
              v
attribution_conversion_facts（唯一 provider）
              |
              v
Browser adapter / 加密 Outbox -> provider Queue -> Server adapter
```

## 来源路由

来源判定只有 `packages/api/src/services/ad-attribution-routing.ts` 一处实现，固定优先级如下：

1. `fbclid` 选择 Meta。
2. `ttclid` 选择 TikTok。
3. `gclid`、`gbraid`、`wbraid` 选择 Google。
4. 数据库校验通过的受管 `mg_source` 选择后台绑定平台。
5. 没有新信号时继承 30 天内最近一次有效广告来源。

约束：

- 新的明确来源覆盖旧来源。
- 同时出现多个平台信号时返回 `conflict`，清除来源上下文，不加载任何 Pixel。
- 普通 UTM、referrer 和前端 `provider` 声明不能决定平台。
- 自然流量且没有历史来源时返回 `none`。
- 来源上下文由 API 加密签名并写入 `HttpOnly` Cookie；Contact 和注册 API 优先验证该上下文，Cookie 偶发缺失时只允许同一服务端路由器按当前官方 click ID 或 active 受管 `mg_source` 恢复唯一平台，不接受客户端 `provider`。

## 浏览器投递

- 浏览器 adapter registry 同一时刻只允许一个 active provider。
- Meta 来源只加载 Meta Pixel；TikTok 来源只加载 TikTok Pixel；Google 来源只加载 Google Tag。
- `PageView`、`ViewContent`、`Search` 只发往 active provider。
- SPA 解析出的 provider 与当前 provider 不同时执行整页刷新；下一结果为冲突或空来源时同样刷新，避免旧脚本残留。
- Pixel 初始化或事件调用失败只关闭本次平台投递，不阻断页面、联系或注册。

## 服务端投递

- `attribution_conversion_facts` 是唯一业务事实源。
- 广告转化事实仅有 `Contact` 和 `CompleteRegistration`。
- 一条事实最多属于 Meta、TikTok、Google 中的一个 provider。
- Browser 与 Server delivery 共用同一 `external_event_id`，用于同平台去重。
- Server Planner 只为事实所属 provider 建立 delivery，禁止 fan-out、广播或枚举所有已启用平台。
- 每个平台仅有一个 Server adapter，并使用独立 Queue/DLQ。
- Queue 消费使用 D1 状态 CAS；同一 delivery 只有一次有效执行，不使用额外 lease、revision 或发布状态。
- Queue、Pixel 或外部平台失败只更新对应 delivery，不回滚业务事实。

## 核心存储

- `attribution_platform_connections`：平台、连接开关、公开目标和稳定 `outbox_scope`。
- `attribution_event_bindings`：两个标准事件的 Browser/Server 目标。
- `attribution_credentials`：每个连接一份当前加密凭证及 `encryption_context`。
- `attribution_conversion_facts`：不可变业务事实和唯一来源平台。
- `attribution_deliveries`：Browser/Server 投递状态。
- `attribution_outbox`：Server 投递的 24 小时加密敏感上下文。
- `attribution_provider_receipts`：平台响应和质量诊断证据。
- `attribution_incidents`、`attribution_quality_snapshots`：故障与质量观察。

`0061_attribution_source_router_cleanup.sql` 会：

- 删除地区策略、授权快照、rollout、mode、revision 和冗余 provider 字段。
- 保留现有连接、公开目标、最新加密凭证、事实、delivery、Outbox、平台回执、事故和质量数据。
- 保留原有 `outbox_scope` 与凭证加密上下文，避免有效 Token 失效。
- 重建数据库层的平台隔离和来源组合约束。

历史 migration 保留连续编号，只用于升级路径；应用运行时不得访问被后续 migration 删除的字段和表。

## 连接管理

后台只管理：

- 是否启用连接。
- 是否启用 Browser。
- 是否启用 Server。
- 平台公开目标 ID。
- `Contact`、`CompleteRegistration` 目标映射。
- 一份加密凭证。

保存配置不会触发发布流程、改变投递比例或取消已排队事件。只有 Owner 显式提交新 Token 时才轮换凭证。

Test Event Code 只用于一次同步连接测试，不持久化、不写审计、不进入正式事件。连接测试幂等，不创建 Workflow 或发布门禁。

## 合规边界

当前归因运行时不包含地区判断、自建营销授权页、Banner、Consent Cookie 或地区策略表。若后续必须增加合规控制，只允许在来源路由完成后接入一个集中式 `allow/deny` 结果；不得在各平台 adapter 中复制地区代码或重新建立多套状态。

## 发布与回滚

- 精简改造在隔离分支一次完成，不发布关闭全部 Pixel 的中间版本。
- 发布前必须通过三平台来源隔离、同事件 ID、迁移保留、类型检查和 Web/API 构建。
- production 发布前核对三平台连接目标与凭证指纹，不修改有效凭证。
- 发布后分别访问 Meta、TikTok、Google 测试链接，网络面板只能出现来源平台。
- 异常时恢复上一生产 Worker Version；不在新架构中加入临时兼容分支。

## 新平台接入

新增平台只需：

1. 在 shared type 和 registry 注册 provider。
2. 增加该平台来源信号。
3. 实现一个 Browser adapter、一个 Server adapter 和一个连接测试 adapter。
4. 配置独立 Queue/DLQ、凭证类型和两个事件目标。
5. 增加来源隔离、同 event ID 与失败不阻断测试。

不得创建第二套事实、Planner、Outbox、连接状态机或发布门禁。
