# Privacy-2C 个人数据副本覆盖补全开发基线

日期：2026-08-20

状态：Cloudflare 源码与文档开发完成；migration、配置、构建、测试、设备 QA 与生产审批统一后置

## 1. 结论

Privacy-2C 在 Privacy-2A 的私有 R2 TAR、可恢复 Queue、一次性下载票据和客户端流式保存链路上，补齐已经属于本人、但此前未进入白名单的推荐偏好、人物拉黑、旧版图库点赞和推荐解释证据。新建制品的显式分类总数从 35 增至 41；前 35 个分类的 code、ordinal 和输出语义保持不变，6 个新分类只追加在末尾。

本增量不改变公开 App API、管理员 DTO、TAR schema version、KMP、Nuxt 或可见交互，交付时累计 App API v2 为 `1.25.0`；Membership-7 后仓库当前累计为 `1.26.0`。页面事实保持 99 个 Page ID / 408 个正式状态，Mobile 50/208、Admin 49/200。正式 Figma 的 `APP-SET-09` 和 `ADM-PRI-02` 已以动态分类总数展示服务端事实，不需要新增 Frame、Page ID 或状态。

## 2. 新增白名单分类

| ordinal | code | 用户可见内容 | 明确排除 |
|---------|------|--------------|----------|
| 35 | `recommendation_preferences` | 个性化开关、taxonomy 目录、主动选择词条、版本与时间 | 内部账号 ID、隐式画像 |
| 36 | `profile_blocks` | 人物引用、blocked/unblocked 状态、版本与时间 | mutation token、内部账号 ID |
| 37 | `profile_block_events` | 人物引用、版本、blocked/unblocked 事件与发生时间 | 内部账号 ID |
| 38 | `legacy_gallery_likes` | 点赞引用、图库引用与创建时间 | 内部 user ID、图库计数派生值 |
| 39 | `recommendation_sessions` | 会话引用、实际模式、规则/热度版本、创建与到期时间 | `account_hash`、`context_hash`、原始请求上下文 |
| 40 | `recommendation_session_items` | 会话引用、序位、人物引用、理由、来源与精选位引用 | 账号摘要、上下文摘要、运营内部备注 |

表中 ordinal 从 0 开始，与 `app_data_rights_export_scopes.category_ordinal` 一致。当前完整范围为 0–40，共 41 类；业务表未来继续增加时不会自动进入导出，必须经过字段级最小化审查后只在末尾追加。

## 3. 旧制品兼容

分类 ordinal 已持久化在 scope、job、part 和 manifest 中，不能通过插入或重排升级。Privacy-2C 保持以下兼容规则：

1. 前 35 类定义原样保留；
2. 新建 artifact 原子创建 41 个 scope；
3. 执行器从当前 artifact 的实际 scope 数量取得完成边界，不使用当前源码数组长度替代历史事实；
4. 升级前已创建的 35-scope artifact 在 ordinal 35 时直接进入 finalizing；
5. scope 缺失、数量非法或 ordinal 没有对应定义时仍 fail closed，不能跳过后宣称 ready。

该边界允许 35-scope 与 41-scope 在途制品共存，也避免部署升级把旧任务误判为尚欠 6 类。TAR schema version 继续为 `1`，因为目录、manifest、NDJSON 分片和字段编码方式没有变化；分类清单本来就是每个 artifact 的显式 manifest 事实。

## 4. 推荐证据账号定位

推荐解释证据没有保存内部账号 ID，只保存 Recommendation-1 已冻结的分用途摘要：

```text
HMAC-SHA-256(SESSION_SECRET, "recommendation-account-v1\0" + accountPublicId)
```

Privacy-2C 复用 `app-recommendation-evidence.ts` 的唯一实现，不另建命名空间或弱摘要。创建推荐 scope 的最大 rowid 边界和后续分页读取都复算同一摘要；NDJSON 只返回白名单业务字段，绝不写出 `account_hash`、`context_hash`、`SESSION_SECRET` 或可用于摘要反查的内部映射。

导出 executor readiness 现在同时要求 `SESSION_SECRET` 至少 16 字符。开始处理时仍会再次验证，Queue 分页阶段若密钥或账号映射缺失则以固定内部错误码失败，不降级为“无数据”并生成不完整 ready 制品。密钥必须在推荐证据和相关在途导出存续期间稳定；轮换前须先停止新证据、完成关联导出与删除、核验零残留，再按统一密钥生命周期执行。

## 5. 与删除和生命周期的关系

- Privacy-2A/2C 负责把本人可见数据复制到用户明确下载的私有 TAR，不删除服务端事实。
- Privacy-2B 继续以独立九步执行器删除账号关联偏好、拉黑、旧版点赞和推荐证据，并核验零残留。
- Recommendation-6 继续按批准后的 `expires_at` 有界清理自然到期推荐会话；导出不会延期或改写其保留期。
- 导出任务创建后的数据若在分页前已依法删除，现有 rowid 纳入边界语义不会伪造已经不存在的记录；manifest 是可恢复产品副本，不是法证级事务备份。
- 用户已经下载到设备的 TAR 由用户控制，账号注销不会远程删除本地文件。

## 6. 代码与验证源

Cloudflare 变更集中在：

- `packages/api/src/services/app-data-rights-exports.ts`：追加 6 类、账号选择器、artifact scope 数完成边界、密钥 readiness；
- `packages/api/src/services/admin-app-data-rights.ts`：向导出 readiness 与准备阶段传入完整内部环境；
- `packages/api/src/services/app-data-rights-export-categories.test.ts`：锁定前 35 类顺序、41 类唯一性、6 类追加顺序和仅两类使用账号 HMAC。

本增量不需要新 migration；推荐账号索引由 Recommendation-6 的 `0114_app_recommendation_evidence_lifecycle.sql` 提供。当前没有执行测试、构建或 migration。全部开发完成后的统一验证至少覆盖：

- 35-scope 旧 artifact 与 41-scope 新 artifact 分别在正确 ordinal 收尾；
- 六类有数据、空数据、分页、中断恢复和重复 Queue 消息；
- 推荐 scope 快照与分页使用同一摘要，其他账号、匿名证据和空摘要不进入本人副本；
- 密钥缺失、过短、轮换或账号映射缺失时 fail closed，不能生成部分 ready；
- `account_hash`、`context_hash`、mutation token、内部账号 ID 和其他敏感字段不进入 NDJSON、manifest、日志或管理员响应；
- 41 类 README/manifest/TAR 的分类、记录、分片、摘要和长度一致。

## 7. 继续后置事项

本阶段没有修改 Wrangler、Secret、Queue/R2 binding、cron 或 capability，没有执行 `0102/0114`，也没有运行 TypeScript/Kotlin 构建、单元/集成/E2E 测试、模拟器/真机、`android-cli` 截图、Figma 像素验收或远端联调。正式 retention、导出范围、地区与 Owner/SLA 审批仍须在生产开放前完成；源码存在不代表个人数据副本 processing 已获授权。
