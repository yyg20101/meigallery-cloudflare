# 通用广告归因架构

## 目标

归因系统只解决三件事：

1. 记录一次可信业务事实。
2. 判断该事实唯一属于哪个广告平台。
3. 通过该平台的 Browser、Server 或两种通道投递。

Meta、TikTok、Google 共用事实、隐私、投递和诊断模型，但凭证、事件目标、Queue 和平台请求完全隔离。

```text
Contact / CompleteRegistration
              |
              v
attribution_conversion_facts
              |
              v
唯一 provider: meta | tiktok | google | none
              |
              v
connection + consent + event binding
              |
              v
Browser delivery / 加密 Outbox -> provider Queue -> Server API
```

## 唯一运行时

- `packages/api` 是唯一归因运行时。
- 不存在独立 Attribution Worker、运行时 owner、epoch、bridge、shadow 或 cutover。
- D1 是唯一事实和投递状态来源。
- production 使用 Meta、TikTok、Google 三组独立 Queue/DLQ。
- dev/local 不绑定真实广告 Queue，也不请求真实平台。

`0060_attribution_control_plane_cleanup.sql` 删除旧 Worker 的业务 Outbox、owner/cutover、写入冻结 trigger 和验证工作流表。核心事实、投递、加密 Outbox、回执、故障和质量数据不受影响。

## 核心表

- `attribution_platform_connections`：平台开关和公开目标 ID。
- `attribution_event_bindings`：`Contact`、`CompleteRegistration` 的平台目标。
- `attribution_credentials`：加密凭证，每个平台连接只保留一份当前凭证。
- `attribution_conversion_facts`：不可变业务事实。
- `attribution_deliveries`：Browser/Server 投递账本。
- `attribution_outbox`：Server 投递的加密敏感上下文。
- `attribution_provider_receipts`：脱敏平台与 Browser 回执。
- `attribution_incidents`：运行故障。
- `attribution_quality_snapshots`：平台质量指标。
- `attribution_usage_daily`：资源使用估算。

历史 migration 必须保留连续编号，但历史表和历史流程不属于当前运行架构。

## 业务事实

- 广告转化事实仅有 `Contact` 和 `CompleteRegistration`。
- `Contact` 只在原生联系跳转或复制联系方式成功后由服务端创建。
- `CompleteRegistration` 只在注册成功后由服务端创建。
- 浏览、按钮展开和普通点击属于站内分析，不作为广告转化。
- 事实即使不满足平台投递条件也必须保留，避免广告平台故障污染业务数据。

## 来源隔离

- click ID 或签名投放链接是可信广告来源；普通 UTM 不能声明 provider。
- 一条事实最多有一个 `attribution_provider`。
- Meta 来源只规划 Meta delivery，TikTok 和 Google 同理。
- 多平台信号冲突时保留站内事实，不向任何平台投递。
- Browser 与 Server 使用同一 external event ID，供同平台去重。

## 连接模型

后台只管理：

- 是否启用连接。
- 是否启用 Browser。
- 是否启用 Server。
- 平台公开目标 ID。
- 两个标准事件的目标映射。
- 一份加密凭证。

保存配置不会触发发布流程、不会改变投递比例、不会要求重新确认，也不会使已入队事件失效。连接创建时生成的内部 Outbox 作用域保持稳定；凭证只有在 Owner 显式提交新凭证时才轮换。

“测试连接”是同步、幂等的诊断操作：

- 读取当前连接和凭证。
- 使用确定性测试事件 ID 请求平台测试接口。
- 立即返回结果。
- 不写验证状态、不创建 Workflow、不参与正式发布门禁。
- Test Event Code 只存在于本次请求，不持久化，正式事件不携带测试码。

## 故障边界

- 平台请求失败只更新对应 delivery，不回滚业务事实。
- retryable 失败由对应 Queue 重试，最终失败进入对应 DLQ。
- Queue 消息必须同时匹配事实 provider、连接 provider 和 Queue provider。
- 凭证、Outbox 和来源上下文使用独立加密用途，明文不写日志、审计或 API 响应。
- 后台配置变化不能改变已创建事实的 provider。

## 发布与修复

- 完整 lint、单测、覆盖率、E2E、类型和构建验证由 PR CI 执行一次。
- 正式部署只做受影响 Worker 的类型/构建检查、必要 migration、部署和生产烟测。
- API 先上传不接流量的 Worker Version，再执行 migration 并激活，避免上传耗时扩大旧代码与新结构并存窗口。
- `./scripts/deploy.sh production api` 只部署 API，不触碰 Web。
- `./scripts/deploy.sh production web` 只部署 Web，不触碰 API、D1 或归因。
- `./scripts/deploy.sh production all` 用于两端确实同时变化的发布。
- 生产验证只检查服务可用性和结构完整性，不要求 API/Web commit 相同。
- 连接配置、隐私策略、dead letter、过期 Outbox 等运行状态会产生警告，但不得阻止无关功能或修复版本发布。

## 新平台接入

新增平台只需：

1. 在 shared type 和 registry 注册 provider。
2. 实现 Browser 描述、Server adapter 和连接测试 adapter。
3. 配置独立 Queue/DLQ 和凭证类型。
4. 定义两个标准事件的目标映射。
5. 增加来源解析、平台隔离和 adapter 测试。

不得修改业务事实口径，不得创建第二套 Planner、Outbox、连接状态机或发布门禁。
