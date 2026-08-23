# Message-7 数据导出失败必要通知开发基线

更新时间：2026-08-20

App 版本：1.0

交付时累计 App API 契约：`1.25.0`（响应形状不变）；仓库当前累计为 `1.26.0`

当前状态：Cloudflare 源码、D1 migration 与定向测试用例已完成；migration、构建、测试、配置和设备 QA 按当前开发顺序统一后置。

## 1. 问题与目标

Privacy-2A 已把不可恢复的导出生成错误收敛为申请 `failed`、制品 `failed`、任务 `failed` 和用户可见 `processing_failed` 事件。Message-5 只通知导出就绪与注销取消，失败账号必须主动轮询才能得知结果，与“数据权利结果属于必要站内通知”的产品边界不完整。

Message-7 复用 Message-3 的必要通知、Message-4 的刷新信号和既有 `data_task + open_data_task` 目标，补齐导出失败通知。通知只提示回到数据权利页面查看权威状态和可用下一步，不包含内部错误、R2 对象、查询细节或其他账号信息。

## 2. 失败事实收敛顺序

`failExportJob` 的同一 D1 batch 调整为：

```text
申请 collecting → failed
→ 制品 queued/collecting/finalizing → failed
→ 执行任务 pending/processing/finalizing → failed
→ 插入用户可见 processing_failed 事件
→ D1 trigger 写入通知 Outbox
```

事件插入再次核验申请 mutation token/version、失败制品 version/failure code 和失败任务 version/error code。任一条件未收敛时不创建用户事件，自然也不会生成通知。请求已经离开 `collecting` 时制品只进入 `superseded`，不伪造一次新的用户失败结果。

## 3. 0110 migration

`0110_app_data_export_failure_notifications.sql`：

- 新增 active development 事件定义 `data.export_failed`；category 固定 `system_security`，necessity 固定 `required`。
- 新增无动态变量的 development 模板 `data-export-failed-v1`。
- trigger 只接受 `visibility=user + actor_type=system + event_type=processing_failed + status_snapshot=failed`。
- 写 Outbox 前再次核验申请属于 export、当前仍为相同版本的 failed、申请和制品都有 failure code、失败制品属于同一账号，且 `artifact.request_version + 1 = event.request_version`。
- 通知策略 `generation_enabled=0` 时只保留权威失败事实，不生成 Outbox；migration 不启用策略、不回填历史。

## 4. 契约、KMP 与 Figma

- 复用既有 `AppNotificationSummary.eventType: string`，无公共枚举、字段或版本增量。
- 目标仍是 `targetType=data_task`、`targetId=requestId`、`action=open_data_task`；响应时继续重验 capability 和账号归属。
- KMP 已能从通知进入 `APP-SET-09`，该页已有正式“失败”状态；无需客户端代码、新 Page ID 或新 Figma Frame。
- Nuxt `ADM-NTF-01/02/03` 使用通用事件/模板/投递表格展示新增行，不增加管理页面或视觉状态。
- 总量保持 99 个 Page ID / 408 个正式状态，Mobile 保持 50 / 208。

## 5. 隐私与恢复边界

- 模板和 Outbox 不保存 `failure_code`、artifact ID、R2 key、SQL/查询错误、内部堆栈或用户导出内容。
- 点击通知只读取当前申请。如果申请已重试、ready、expired 或取消，页面展示当前权威状态，不把历史失败通知当作当前事实。
- 注销 scheduled/processing/failed/completed 的普通通知抑制保持不变；Message-7 只处理 export。
- 通知投递失败不改变申请、制品或任务状态；Message-3 按既有租约、退避和 dead letter 恢复。

## 6. 后置验证

全部开发结束后的统一验证至少覆盖：

1. `0076 → 0094 → 0097 → 0102 → 0103 → 0109 → 0110` 的隔离迁移顺序。
2. 策略关闭、事件非用户可见、非系统 actor、版本不一致、制品未失败和 failure code 缺失均不写 Outbox。
3. 同一失败事件只生成一条 `data.export_failed`，且属于必要通知，不受营销/消息/互动偏好关闭影响。
4. `failExportJob` 的四段事实顺序、条件写并发和 Queue 重投不会产生假失败或重复通知。
5. KMP 从失败通知进入 `APP-SET-09` 后读取当前状态；对象失效或 capability 关闭时使用既有安全不可用态。

本阶段只编写测试用例，未按当前顺序提前运行。
