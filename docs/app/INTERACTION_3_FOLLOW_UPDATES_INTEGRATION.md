# Interaction-3 关注更新流与站内通知开发基线

App 版本：1.0

App API：v2 / `1.12.0`

日期：2026-08-09

状态：服务端开发完成；默认关闭；配置、migration、客户端与测试后置

## 1. 本阶段目标

在不接入系统推送、不复制人物发布事实、不向目标真人或运营人员披露关注者身份的前提下，完成 App 1.0 关注更新服务端闭环：

- 关注者可分页读取“建立关注之后”的已审核公开发布事件。
- 同一发布事件对同一账号只产生一条站内通知 Outbox 记录。
- 取消关注、拉黑、资料暂停/归档、授权或认证失效后停止新增与待投递提醒。
- 恢复公开资格不会补造暂停期间不存在的公开事件；只有新的有效发布记录可再次进入更新流。
- bootstrap 独立声明 `interactions.followUpdates`，客户端不得因 `follow=true` 自行推导更新流已开放。

## 2. 明确不包含

- 不接入 APNs、FCM、WebSocket、短信、邮件或桌面系统通知。
- 不新增第二套 publication event、动态正文、媒体摘要或关注更新快照表。
- 不返回草稿、审核中、已拒绝、暂停记录、内部备注、证据引用或受保护媒体。
- 不向人物资料、真人本人或平台运营侧生成“谁关注了我”的名单或通知。
- 不把关注、更新打开或通知点击自动写入热度与推荐信号。
- 不执行 `0079`，不修改 Wrangler，不启用 development/production capability，不补 KMP 页面和专项测试。

## 3. 唯一事实与数据模型

### 3.1 发布事实

`person_publication_reviews` 继续是关注更新的唯一事件事实。只有同时满足以下条件的记录才是候选：

- `status='published'`；
- `reviewed_at` 与 `projection_version` 均存在；
- `reviewed_at` 晚于当前关注关系的 `created_at`；
- `reviewed_at` 不早于关注更新策略 `effective_at`；
- 人物当前公开投影仍通过认证、发布、用途授权、有效期、可见性和来源图库发布校验；
- 当前账号未屏蔽该人物。

更新流返回事件版本号和“当前仍公开”的人物卡片，不保存历史人物快照。若事件读取和人物映射之间发生并发下线，本次响应安全丢弃该项。

### 3.2 策略

`0079_app_follow_updates.sql` 新增 `app_follow_update_policies`，只保存版本化门禁：

| 字段 | 含义 |
|------|------|
| `state` | `development / published / retired` |
| `production_ready` | production 独立门禁 |
| `feed_enabled` | 是否允许更新流读取 |
| `notification_projection_enabled` | 是否允许投影站内通知 |
| `effective_at` | 禁止历史回填的事件下界 |

development 策略为 `fupol_app_1_0_interaction_3_dev_1`。migration 不创建用户关系、更新、通知或真实业务 seed。

### 3.3 索引与通知模板

`0079` 增加“人物 → 当前关注者”和“人物 → 已发布审核记录”的反向索引；同时激活 Message-3 已预留的 `interaction.followed_profile_updated` 定义，并加入固定中文 development 模板。

模板只说明“关注的资料有已审核公开更新”，目标为 `person_profile/open_person_profile`。通知总策略的 `generation_enabled` 和运行时开关不由 migration 修改，因此单独执行 migration 也不会产生通知。

## 4. App API `1.12.0`

### 4.1 Bootstrap

新增：

```json
{
  "capabilities": {
    "interactions": {
      "followUpdates": false
    }
  },
  "followUpdates": {
    "policyVersion": "fupol_app_1_0_interaction_3_dev_1",
    "transport": "http_pull",
    "maxPageSize": 40,
    "notificationMode": "in_app_only"
  }
}
```

`followUpdates=true` 必须同时满足 Auth 可用、三个关注更新运行参数完整、非 production 或 production-ready 明确打开，以及 D1 策略可用且 `feed_enabled=1`。任何缺失或异常都安全降级为 `false`。

### 4.2 更新流

```http
GET /api/v2/me/follow-updates?limit=20&cursor=<opaque>
Authorization: Bearer <access-token>
```

响应项：

| 字段 | 说明 |
|------|------|
| `updateId` | 由不可变 `ppub_*` 发布记录确定性映射的 `fup_*` 外部 ID |
| `updateType` | 当前固定为 `profile_published` |
| `profileId` | 公开人物资料 ID |
| `profileVersion` | 当次审核通过的内容版本 |
| `projectionVersion` | 当次写入公开投影后的版本 |
| `publishedAt` | 当次发布审核完成时间，也是更新流排序时间 |
| `profile` | 请求时仍满足公开资格的当前人物卡片 |

排序固定为 `publishedAt DESC, publicationId DESC`；游标绑定账号，跨账号复用或篡改返回 `INVALID_CURSOR`。单页默认 20，最大 40。

## 5. 站内通知投影

用户读取通知列表、未读数、通知详情或执行已读操作前，通知服务按当前账号惰性扫描最多 40 条候选发布记录：

1. 先校验 Message-3 通知策略和 Interaction-3 关注更新策略。
2. 只选择晚于当前关注时间、关注策略生效时间和通知策略生效时间的有效发布事实。
3. 以 `(account_id, event_type, event_ref)` 唯一约束写入 Outbox；重复拉取不会重复提醒。
4. 投递前再次校验当前关注关系、发布状态、人物公开资格和屏蔽状态。
5. 若用户已取消关注、拉黑、资料失效或功能门禁关闭，待投递 Outbox 标记为 `suppressed`，不会在未来恢复时补发。
6. `interaction` 是可选通知分类；用户关闭该偏好后，候选事件同样被抑制而不是延期补发。

该设计避免人物发布时同步枚举全部关注者，也避免把通知 Outbox 误当作发布事实源。已投递的历史通知保留 Message-3 的既有状态语义；打开目标时仍重新读取当前人物资格。

## 6. 权限与隐私边界

- 更新流和通知只读取当前 Access Token 对应账号的关注关系。
- API 不提供按 `profileId` 反查关注者的产品能力。
- 更新事件不包含关注时间、账号 ID、邮箱、昵称、会话、精确地区或任何关注者信息。
- 人物暂停、图库下线、授权到期、认证到期和拉黑均由服务端过滤；客户端隐藏卡片不构成权限控制。
- 关注关系取消后再关注，旧发布事件因早于新的 `created_at` 不会重新进入更新流或重新投影通知。

## 7. 运行门禁

代码声明但当前未写入环境的参数：

```text
APP_FOLLOW_UPDATES_ENABLED
APP_FOLLOW_UPDATES_POLICY_VERSION
APP_FOLLOW_UPDATES_PRODUCTION_READY
```

站内通知投影还要求既有 Message-3 开关、通知策略、事件定义和模板同时可用。production 只接受 `published + production_ready=1` 的关注策略与已发布通知模板。

## 8. 当前交付与后置工作

本阶段已完成：

- `0079_app_follow_updates.sql` schema 与 development 目录；
- 关注更新策略解析、capability、账号绑定游标和公开资格过滤；
- `GET /api/v2/me/follow-updates`；
- App API/OpenAPI/共享类型累计版本 `1.12.0`；
- Message-3 惰性 Outbox 投影、事件去重和投递前资格复核；
- 产品、技术、契约与项目状态文档同步。

统一后置到“全部开发完成”之后：

1. 在 `meigallery-client` 按当前累计 `1.15.0` 契约接入 DTO、Repository、关注更新页面和站内通知跳转。
2. 选择隔离环境策略版本并配置运行门禁。
3. 执行本地/远端 migration、D1 专项用例、契约兼容检查、KMP UI 回归和端到端联调。
4. 独立评审 production 策略、模板审批、通知保留期与上线授权；不得由 development 策略直接推导生产启用。
