# Interaction-1 跨仓纵向切片

App 版本：1.0

App API：v2 / 契约 `1.3.0`

状态：喜欢与关注保守开发基线

## 1. 目标

在不启用生产注册、不引入匹配、私信、会员、收藏额度或推荐计数的前提下，完成 Cloudflare API 与 KMP App 的喜欢/关注闭环。服务端始终是关系事实源，客户端仅做可回滚的即时反馈。

## 2. 本阶段范围

- 资料详情读取本人喜欢/关注状态。
- 喜欢、取消喜欢、关注、取消关注；同一目标状态重复请求幂等。
- 本人喜欢列表和已关注列表，均采用不透明游标分页。
- 已失效资料在本人列表中只显示最小不可用占位，并允许取消关系。
- Android/iOS 共用领域、网络与 Compose Multiplatform 页面逻辑。
- bootstrap 明确返回 `interactions.like`、`interactions.follow`、`interactions.favorite` 和 `interactions.history` 能力。

## 3. 明确不做

- 收藏及收藏夹、浏览历史、关注更新事件、站内互动通知。
- 双向喜欢、匹配、相互关系、目标侧通知或互动者名单。
- 会话创建、会员额度、金币、礼物、支付、系统推送。
- 聚合互动计数和推荐信号接入。
- 离线写队列；离线只保留当前页面，写入失败必须回滚。

## 4. API 冻结

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/person-profiles/:profileId/interactions` | 获取本人对当前可用资料的权威状态 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/like` | 幂等喜欢/取消喜欢 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/follow` | 幂等关注/取消关注 |
| GET | `/api/v2/me/likes` | 本人喜欢列表 |
| GET | `/api/v2/me/follows` | 本人已关注列表 |

写入响应和详情状态使用同一 DTO：

```json
{
  "profileId": "pp_example",
  "liked": true,
  "followed": false,
  "likedAt": "2026-08-06T08:00:00.000Z",
  "followedAt": null
}
```

列表项包含关系类型、创建时间、可用资料或最小占位：

```json
{
  "profileId": "pp_example",
  "interactionType": "like",
  "createdAt": "2026-08-06T08:00:00.000Z",
  "profile": null,
  "unavailableReason": "PROFILE_NOT_AVAILABLE"
}
```

`profile` 非空时复用公开人物 DTO，并重新通过当前公开资格校验；为空时不得附带历史封面、标签、地区或简介。

## 5. 数据与安全边界

- D1 表只保存 `account_id`、稳定 `profile_id`、`interaction_type` 和 `created_at`。
- 主键为 `(account_id, profile_id, interaction_type)`，从数据库层阻止重复关系。
- 不建立按 `profile_id` 查询观看者名单的产品接口，也不写目标侧通知。
- PUT 使用当前公开资格条件完成受控插入；DELETE 不要求资料仍公开。
- 列表只按当前 Access Token 的 `account_id` 查询，禁止调用方提交账号 ID。
- 私有响应统一 `Cache-Control: no-store`；未知/跨类型游标返回 `INVALID_CURSOR`。
- 生产 Auth capability 仍默认关闭；Interaction-1 不绕过账号、设备、会话、同意和账号状态校验。

## 6. 客户端交互

- 详情加载完成后再读取本人关系；关系读取失败不隐藏公开资料，但按钮进入可重试状态。
- 已登录用户点击按钮可先切换视觉状态；写失败必须恢复旧状态并显示安全文案。
- 在途操作合并，禁止连点形成并发的相反写入。
- 未登录点击喜欢/关注时进入“我的”登录入口，不伪造成功状态。
- 一级导航文案使用“关注”；页面内提供“已关注 / 喜欢”切换、空态、错误、分页和不可用占位。
- 所有文案只表达本人记录，例如“已喜欢”“已关注”，禁止“配对成功”“对方已收到”。

## 7. 验收门禁

- 服务端覆盖重复 PUT/DELETE、关系独立、账号隔离、不可用资料拒绝新增/允许取消、稳定分页和非法游标。
- KMP 覆盖 DTO 未知字段、契约主版本、401 单航班续期、乐观失败回滚和不可用占位。
- Android Host Test、Debug APK、API TypeScript、API 测试和 Nuxt Worker 构建全部通过。
- iOS 共用源码需要完成 Kotlin/Native 编译；完整 Xcode/SDK 缺失时必须保留为已知环境阻塞，不宣称真机验收完成。
