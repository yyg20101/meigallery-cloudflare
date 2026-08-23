# Recommendation-6 推荐解释证据生命周期开发基线

日期：2026-08-20

状态：Cloudflare 源码开发完成；保留决策、稳定密钥、配置、migration 执行、构建、专项测试与环境验证统一后置

## 1. 结论

Recommendation-6 为 Recommendation-1 已有的最小化推荐会话证据补齐物理生命周期：只有证据保留决策、保留天数和 purge 门禁全部有效时，既有 15 分钟调度才会有界删除已到期会话，并依靠外键级联清理条目；Privacy-2B 注销的 `purge_discovery_activity` 步骤同时使用与写入完全一致的分用途 HMAC 定位账号关联证据，删除未到期会话并以最终零残留计数收口。

本增量不批准 OQ-020，不启用证据记录，不写真实保留天数或密钥，不修改 Wrangler/cron，也不新增公共 API、DTO、KMP、Nuxt、Page ID 或 Figma 状态。交付时累计 App API v2 为 `1.25.0`；Membership-7 后仓库当前累计为 `1.26.0`。页面事实保持 99 个 Page ID / 408 个正式状态，Mobile 50/208、Admin 49/200。

## 2. 到期清理门禁

到期清理复用 `0083_app_recommendation_rules_and_editorial.sql` 已冻结的三个权威字段：

- `evidence_retention_decision_status=approved`；
- `evidence_retention_days` 是 `1..3650` 的整数；
- `purge_enabled=1`。

运行时还必须保留显式 `APP_RECOMMENDATION_POLICY_VERSION`，使调度器能定位对应策略。推荐 feed 或 `evidence_recording_enabled` 后续关闭，不会撤销已经批准且仍有效的删除义务；但策略 ID 被移除、策略不存在或保留链未批准时，清理器会明确跳过，绝不猜测策略或保留期。

每次最多按 `expires_at ASC, session_id ASC` 删除 1,000 个到期会话，并返回 `hasMore`。父会话删除通过既有 `ON DELETE CASCADE` 清理 `app_recommendation_session_items`；单次失败不改写到期时间，下一个 15 分钟周期可安全重试。调度日志只记录删除数量和是否仍有积压，不记录账号摘要、会话 ID、人物 ID 或推荐内容。

## 3. `0114` 数据约束

`0114_app_recommendation_evidence_lifecycle.sql` 只增加：

- `(account_hash, expires_at, session_id)` 定位索引；
- 新会话 UTC 毫秒时间格式、可解析性和严格先后关系写入门禁；
- 会话 `UPDATE` 禁止触发器；
- 会话条目 `UPDATE` 禁止触发器。

触发器不禁止 `DELETE`，因为到期清理和已验证账号注销都必须能履行删除义务；分页仍可向同一会话追加新的、唯一 rank 条目。migration 不 seed 会话、保留期、策略状态或真实账号摘要，也不启用推荐 capability。

## 4. 账号关联与注销

个性化证据写入继续只保存：

```text
HMAC-SHA-256(SESSION_SECRET, "recommendation-account-v1\0" + accountPublicId)
```

Recommendation-6 将该算法集中到同一服务，推荐写入、账号计数和注销删除不再各自实现。`SESSION_SECRET` 至少 16 字符；Privacy-2B 在允许开始或重试不可逆处理前会检查该门禁，避免队列推进到删除步骤后才发现无法定位证据。

Privacy-2C 个人数据副本同样复用该集中实现：创建推荐 scope 的最大 rowid 边界和 Queue 分页均用账号 HMAC 选择本人会话/条目，但只导出业务白名单字段，绝不导出 `account_hash` 或 `context_hash`。导出 readiness、开始和分页对密钥缺失 fail closed，旧 35-scope artifact 不会因为新增分类而要求推荐摘要。

Privacy-2B 第四步现在同时处理：

1. 既有喜欢、关注、收藏、浏览、搜索、保存条件、屏蔽和 Gallery 点赞；
2. 账号 HMAC 命中的推荐会话；
3. 被这些会话级联持有的推荐条目。

步骤开始计数和 handler 后最终计数都包含会话与条目。任一残留都会继续触发既有 `deletion_step_incomplete`，不能用“已调用删除”替代零残留证明。匿名或本来未关联账号的非个性化会话不属于该账号注销范围，仍按批准后的普通到期生命周期清理。

`SESSION_SECRET` 在任何推荐证据或引用该证据的在途 41-scope 导出仍存续期间必须保持稳定；轮换或撤销前必须先完成相应导出与证据清理并通过零残留核验。当前源码没有把密钥轮换解释为可以放弃旧账号摘要的删除义务。

## 5. 安全与隐私边界

- 证据记录仍受 Recommendation-1 的完整政策门禁；OQ-020 未关闭时不会因为清理器存在而开始写入。
- 到期清理不读取或返回账号原文，也不建立 HMAC 反查 API。
- 账号注销不依赖推荐 feed、个性化或证据记录当前是否开启；已经存在的账号关联证据仍须删除。
- `context_hash`、规则版本、原因码和条目在删除前不可改写，避免用原地修订破坏争议证据。
- 删除是物理生命周期动作，不写管理员业务审计，也不伪造规则状态、推荐曝光或用户操作；Privacy-2B 的步骤证据继续承担注销完成证明。
- 清理故障只输出固定错误码，不把 D1 错误、账号摘要或会话内容写入日志。

## 6. API、客户端与 Figma 边界

本增量只修复内部生命周期，不改变 Recommendation-1 `POST /api/v2/discovery/recommendations`、推荐游标、本人偏好、Privacy-1/2B 请求状态或管理员详情响应。KMP 会在注销完成后沿用既有行为清理本地账号态并退出到未登录“我的”。

正式 Figma 没有“推荐证据清理”页面或状态，本增量不创建客户端/后台 UI。任何保留策略编辑、清理积压监控、删除证明下载或用户级推荐证据页面必须先取得正式 Figma Node ID。

## 7. 统一后置验证

全部开发完成后的统一验证至少覆盖：

- 未配置策略、策略不存在、保留未批准、天数非法或 purge 关闭时均不删除；
- 只删除 `expires_at <= now` 的会话，有界批次、稳定顺序、`hasMore` 和级联条目正确；
- 会话与条目不能更新，但到期和账号注销删除可执行；
- 写入、计数和注销使用相同 HMAC 命名空间，错误账号与匿名证据不受影响；
- Privacy-2B 初始/最终计数包含推荐会话和条目，残留时不能完成步骤；
- 推荐或证据记录开关关闭后，已批准到期删除仍继续；
- 重复调度、重复 Queue 消息、中途失败和空集合均幂等；
- 日志与注销证据不泄露账号摘要、会话、人物或推荐内容。

当前没有修改 Wrangler 或 cron，没有执行 `0083/0114`，没有批准真实保留期、创建真实证据或轮换密钥，也没有运行构建、测试、模拟器/真机、截图 QA 或远端联调。
