# Message-6 通知偏好策略换绑开发基线

更新时间：2026-08-20

App 版本：1.0

交付时累计 App API 契约：`1.25.0`（响应形状不变）；仓库当前累计为 `1.26.0`

当前状态：Cloudflare 源码与定向测试用例已补齐；按当前开发顺序未运行 migration、构建、测试或环境验证。

## 1. 问题与目标

`app_notification_preferences` 以账号为主键，确保同一账号只有一份当前偏好。此前初始化使用 `INSERT OR IGNORE`：账号第一次读取时能绑定当前策略，但当 `APP_NOTIFICATIONS_POLICY_VERSION` 切换到新策略后，既有行仍保留旧 `policy_id`。GET 会返回旧策略，PUT 又按新策略做条件更新，最终持续返回 `VERSION_CONFLICT`。

Message-6 在不增加第二份偏好、不重置用户选择、不改变公共 DTO 的前提下，补齐当前策略换绑：账号第一次访问新策略时保留消息、互动和营销三个可选值，单调提升偏好版本，并追加可追溯事件。

## 2. 权威规则

1. 当前通知策略必须先通过既有运行门禁；换绑不能让未启用或不满足 production-ready 的策略生效。
2. 偏好仍以账号唯一，策略升级不会创建并行偏好，也不会把消息/互动恢复为开启或把营销改为开启。
3. `policy_id` 变化必须同时令 `version + 1`，客户端继续使用既有乐观并发规则。
4. 如果旧版本尚无偏好事件，先追加旧策略基线事件；随后追加新策略生效事件。已有同版本事件通过唯一约束保持不重复。
5. 两个策略边界事件均不保存设备信息；内部 `request_id` 使用 `policy-rebind-baseline-*` / `policy-rebind-applied-*`，与用户主动修改事件明确区分。
6. 换绑使用旧 `policy_id + version` 条件更新，并对并发最多重读三次。另一个请求已完成换绑时直接复用结果；仍无法收敛时返回可重试的 `NOTIFICATION_PREFERENCES_UNAVAILABLE`，不得重置偏好。

## 3. 实现范围

- `packages/api/src/services/app-notifications.ts`
  - `ensurePreferenceRow` 在默认行初始化后验证当前策略。
  - 发现旧策略时原子追加必要基线、条件换绑、提升版本并追加生效事件。
  - 通知拉取时的可选类别抑制与偏好 GET/PUT 共用同一换绑逻辑。
- `packages/api/src/services/app-notifications.d1.test.ts`
  - 增加“用户先关闭消息提醒，再切换策略”的定向场景。
  - 断言选择不变、版本只提升一次、重复 GET 不再提升，以及新策略事件不伪装成设备操作。

## 4. 契约与页面影响

- `AppNotificationPreferences` 已包含 `policyId` 与 `version`，无字段、错误形状或 API 版本增量。
- KMP 收到换绑后的连续版本即可沿用现有通知偏好状态机，无客户端代码改动。
- 无新增用户操作、页面、Page ID 或视觉状态，不调用 Figma；总量保持 99 个 Page ID / 408 个正式状态，Mobile 保持 50 / 208。
- 无新增 migration；继续复用 `0076` 的账号唯一偏好与不可变偏好事件表。

## 5. 后置验证

按用户指定顺序，本阶段不执行构建或测试。全部开发结束后的统一验证至少覆盖：

1. 无历史事件与已有用户修改事件两种账号的策略换绑。
2. 多请求并发换绑只产生一个新版本。
3. 换绑与用户 PUT 并发时，旧请求收到冲突并可在刷新后恢复。
4. 拉取通知触发换绑后，可选类别仍按原选择抑制，必要通知不受影响。
5. production-ready 门禁失败时不修改偏好绑定。
