# Interaction-4 浏览历史到期生命周期开发基线

日期：2026-08-20

状态：Cloudflare 源码与文档开发完成；保留决策、配置、migration 执行、构建与专项测试统一后置

## 1. 结论

Interaction-4 补齐 Interaction-2 已建模但尚未执行的浏览历史物理生命周期：只有显式配置策略 ID、D1 策略将浏览历史保留决策标记为 `approved`，且 `purge_enabled=1` 时，每日维护任务才按行级 `expires_at` 有界删除到期记录。浏览历史 capability、记录开关或会员权益后来关闭，不撤销对已经存在且到期记录的删除义务。

本增量不改变 App API、DTO、KMP、Nuxt、会员 entitlement、Page ID 或 Figma 状态，交付时累计 App API v2 为 `1.25.0`；Membership-7 后仓库当前累计为 `1.26.0`。页面事实保持 99 个 Page ID / 408 个正式状态，Mobile 50/208、Admin 49/200。

## 2. 删除授权与运行边界

清理器按以下顺序 fail closed：

1. `APP_INTERACTION_COLLECTIONS_POLICY_VERSION` 必须显式提供合法策略 ID；源码中的 development 默认 ID 不能被解释为删除授权；
2. 策略行必须存在；
3. `history_retention_decision_status=approved`；
4. `purge_enabled=1`；
5. 调度时间必须是可转换为严格 UTC ISO 的有效时间。

清理不要求 `APP_INTERACTION_COLLECTIONS_ENABLED=true`、`history_enabled=1` 或当前会员 entitlement 可执行。产品读取/写入开关只决定是否继续产生和展示记录；批准后的保留义务必须在能力关闭、会员到期或目录切换后继续执行。策略未配置、不存在或保留链未批准时返回明确 skipped reason，不猜测默认策略或保留期限。

## 3. 有界清理

每批默认最多删除 1,000 行，调用方上限为 5,000 行，稳定顺序固定为：

```text
expires_at ASC, account_id ASC, profile_id ASC
```

删除条件使用严格 UTC 文本比较 `expires_at <= now`，与 `0078_app_favorites_and_view_history.sql` 已有 `(expires_at, account_id)` 索引一致。执行后额外查询 `hasMore`，供调度日志识别积压；当前每日任务只执行一个有界批次，不在单次 Worker 内循环清空大表。错误日志只输出固定 `app_view_history_purge_failed`，不记录账号、人物、时间线或 D1 原始错误。

清理只删除 `app_profile_view_history` 到期行，不修改：

- `app_view_history_preferences` 的本人开关、版本或 mutation token；
- 收藏夹、喜欢、关注或搜索历史；
- 会员 grant、目录或 `history.retention_days` entitlement；
- 推荐证据、通用分析或管理员审计。

## 4. 快照与并发语义

- 正常记录命令继续以账号、人物和设置版本 upsert 单行，并写入当次权益计算得到的 `expires_at`。
- 清理与记录并发时以 D1 当前行和明确截止时间为准；新记录若尚未到期不会被批次选择。
- 同一行在批次选择后被延长时，DELETE 子查询在同一 SQL 语句内读取当前值，不使用客户端预取 ID 列表。
- 重复调度与空集合幂等；已经删除的行不会生成事件、通知或分析事实。
- 物理删除不提升历史设置版本，因为它不代表用户修改记录开关，也不应使仍有效的并发记录命令无故冲突。

## 5. 代码与验证源

- `packages/api/src/services/app-interaction-collections.ts`：运行配置显式区分“策略 ID 已配置”和 development 默认展示 ID；
- `packages/api/src/services/app-view-history.ts`：新增门禁化、有界、稳定排序的到期清理器；
- `packages/api/src/index.ts`：每日维护接入独立 try/catch，不影响搜索历史、数据副本、认证或会员任务；
- `packages/api/src/services/app-view-history-retention.d1.test.ts`：覆盖未配置、未批准、有界顺序、能力关闭后继续履约和非法时间 fail closed。

本增量不需要新 migration；`0078` 已包含行级到期字段与清理索引。测试源码已编写但未运行。

## 6. Figma 与后置事项

Interaction-4 没有新增可见状态：`APP-INT-05` 继续只读取未到期记录，物理清理不会生成新的加载、成功或失败页面；现有 Figma 节点和 Compose 行为无需改变。任何“保留策略编辑”“清理积压”或用户级删除证明页面仍须先取得正式 Figma Node ID。

本阶段没有修改 Wrangler、cron 表达式、环境变量或 capability，没有执行 `0078/0096`，也没有运行构建、测试、模拟器/真机、`android-cli` 截图、Figma 像素验收或远端联调。OQ-020 未关闭时 development 策略继续 `unresolved + purge_enabled=0`，源码存在不构成真实删除授权。
