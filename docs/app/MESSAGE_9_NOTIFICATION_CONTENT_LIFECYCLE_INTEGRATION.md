# Message-9 站内通知内容生命周期开发基线

App 版本：1.0

交付时累计 App API：v2 / `1.25.0`（本切片无契约版本增量）；仓库当前累计为 `1.26.0`

日期：2026-08-20

状态：Cloud 后端与 D1 测试源码已完成；策略配置、migration 执行、构建、测试和环境 QA 统一后置

## 1. 目标与边界

Message-9 补齐 Message-3 已预留但未执行的通知正文生命周期：新投递在已批准策略下获得确定到期时间，过期正文由每日维护有界删除。它不关闭 OQ-020，不设置真实保留天数，也不自动开放通知能力。

本阶段不增加 App API、KMP、Nuxt、Page ID 或 Figma 状态。页面事实保持 99 个 Page ID / 408 个正式状态，Mobile 50/208，Admin 49/200。

## 2. 投递边界

- 通知策略仍是唯一保留决策来源。只有 `decision_status=approved` 且 `retention_days` 为 1～3650 天整数时，新投递才写入 `expires_at`。
- `expires_at` 固定为原始业务事件 `created_at + retention_days`，不是消费者实际处理时间；重试不会延长保留期。
- 已经晚于到期边界的延迟 Outbox 会收敛为 `suppressed`，不再创建通知正文或未读项。
- 未批准的 development 策略仍可保持既有开发行为并写 `expires_at=NULL`；production 继续受 Message-3 的批准保留期门禁约束。
- 到期边界一旦随通知投影写入便不可修改，避免通过重试、补发或后台写操作延长正文寿命。

## 3. 物理清理

每日维护调用 `purgeExpiredAppNotifications`，并同时要求：

1. 环境显式配置 `APP_NOTIFICATIONS_POLICY_VERSION`；代码内 development 默认 ID 只用于展示和安全降级，不构成删除授权。
2. 对应 D1 策略存在、`decision_status=approved`、保留天数有效且 `purge_enabled=1`。
3. 调度时间有效；非法时间直接失败，不扩大删除范围。

清理规则：

- 新记录按 `expires_at <= now` 删除。
- 升级前的 legacy `expires_at=NULL` 记录按 `created_at <= now - retention_days` 删除，不需要危险回填。
- 每批默认 1,000 条、最大 5,000 条；显式到期记录优先，再按到期时间、创建时间和通知 ID 稳定排序，并返回 `hasMore`。
- 物理删除不依赖 `APP_NOTIFICATIONS_ENABLED`、后台开关或 `generation_enabled` 继续开启；能力关闭后仍履行已经批准的到期义务。
- 单条已读事件因既有外键与 CHECK 约束必须先删除；分类全部已读聚合事件不指向具体通知，继续保留。通知 Outbox 也继续作为最小去重墓碑保留，不保存通知正文。
- 失败日志只写固定错误码，不记录账号、通知文案、eventRef、targetId 或策略内容。

## 4. Migration

`0115_app_notification_content_lifecycle.sql` 仅增加：

- `expires_at IS NOT NULL` 的到期索引；
- `expires_at IS NULL` 的 legacy 创建时间索引；
- 新写入到期时间的严格 UTC、可解析及晚于创建时间约束；
- `created_at/expires_at` 的不可变约束。

Migration 不回填、不删除数据，不修改策略、模板、Outbox、偏好、运行开关或 Wrangler 配置。`0115` 只能在全部开发完成后的统一 migration 阶段执行。

## 5. 隐私与数据权利

- 被清理的是账号私有通知标题、摘要、正文、目标快照和单条已读事件；业务权威事实仍由会员、钱包、安全、消息或数据权利领域各自管理。
- Outbox 只保留最小投递/去重元数据，不能用于恢复已删除正文；其独立保留期仍由 OQ-020 决定。
- Privacy-2B 的不可逆账号注销继续执行账号级级联与零残留核验；本清理器不是注销流程的替代品。
- 不新增用户手工删除通知、管理员任意删除、归档恢复或通知正文导出接口。

## 6. 测试源码与后置验证

已编写但尚未运行的覆盖包括：

- 未显式配置策略、未批准决策或 purge 关闭时安全跳过；
- 批准后按原始事件时间写入到期边界，过期延迟事件只抑制 Outbox；
- capability 关闭后仍按稳定顺序有界删除 explicit/legacy 通知；
- 删除单条已读事件、保留分类事件和 Outbox 去重墓碑；
- migration 拒绝非法到期时间并阻止改写保留边界；
- 非法调度时间不删除数据。

统一验证阶段还必须执行 `0076/0097/0115` 连续 migration、D1 定向测试、API 类型检查与构建、真实策略副本演练、批次积压恢复和回滚验证。上述工作完成前不得把 Message-9 标记为 production-ready。

## 7. 启用门禁

- OQ-020 已由合规、隐私与运营 Owner 明确通知正文、Outbox、已读事件、偏好和审计的分别保留期。
- 形成新的 published、production-ready 通知策略；不得原地把 development seed 当作生产批准记录。
- 环境显式选择该策略并先验证 `purge_enabled=0` 的只读演练，再经独立审批开启物理清理。
- 建立积压、失败、误删与恢复 Runbook；监控只使用聚合计数和固定错误码。
- 完成 migration、构建、专项测试和目标环境 QA 后，再按 Message-3 的双门禁顺序开放通知生成与用户 capability。

Message-3 的事件、模板、HTTP 与 KMP 基线见 [Message-3 站内通知与可靠到达跨仓交付基线](./MESSAGE_3_NOTIFICATION_INTEGRATION.md)。
