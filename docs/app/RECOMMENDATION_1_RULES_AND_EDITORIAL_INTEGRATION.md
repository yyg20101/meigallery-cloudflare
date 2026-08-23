# Recommendation-1 版本化推荐与运营精选开发基线

更新时间：2026-08-20
App 版本：1.0
App API v2 累计契约：`1.16.0`
状态：Cloudflare 与 KMP 开发代码完成；Recommendation-2/3/4/5/6 已补齐客户端版本、地区作用域、完整可执行门禁、默认关闭的自动停止控制面与证据生命周期；配置、migration、专项测试、远端联调和生产决策后置

## 1. 结论

Recommendation-1 已形成 Cloudflare 与 KMP 客户端的跨仓纵向开发基线：统一公开资格、版本化规则、非个性化/个性化模式隔离、显式偏好、会话级稳定灰度、计划生效、可解释原因、固定“平台精选”披露、Dry-run、职责分离、乐观锁、幂等创建、暂停与回滚。

2026-08-20 的 Recommendation-2 增量进一步把策略/规则 `minimumClientVersion`、KMP `X-Client-Version` 和灰度回退接成真实运行门禁；完整边界见 [Recommendation-2 客户端版本门禁与安全回退开发基线](./RECOMMENDATION_2_CLIENT_VERSION_GUARD_INTEGRATION.md)。

同日的 Recommendation-3 增量把 `targetRegionCodes` 前移到规则选择，并要求回退范围完整覆盖目标范围；完整边界见 [Recommendation-3 地区作用域选择与安全回退开发基线](./RECOMMENDATION_3_REGION_SCOPE_AND_FALLBACK_INTEGRATION.md)。

Recommendation-4 继续让有序候选逐条通过规则结构、taxonomy/heat 运行依赖和个性化目录兼容校验；完整边界见 [Recommendation-4 可执行规则选择与依赖降级开发基线](./RECOMMENDATION_4_EXECUTABLE_RULE_SELECTION_INTEGRATION.md)。

Recommendation-5 进一步为部分灰度增加独立复核的目标/反指标策略、仅聚合评估、不可变停止和完整回退；完整边界见 [Recommendation-5 灰度目标、反指标与自动停止开发基线](./RECOMMENDATION_5_GUARDRAIL_AND_AUTOMATIC_STOP_INTEGRATION.md)。

Recommendation-6 为批准后的最小化会话证据补齐有界到期清理、不可改写约束和 Privacy-2B 账号关联零残留删除；完整边界见 [Recommendation-6 推荐解释证据生命周期开发基线](./RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md)。

本次没有修改 Wrangler，没有执行 `0083/0113/0114` migration，没有创建真实规则、守护策略、阈值、偏好或曝光，没有启用任何 capability，也没有运行专项功能测试。既有 `GET /api/v2/discovery/feed` 保持兼容且行为不变。

## 2. 当前冻结边界

- 当前真人资料仍由平台上传或运营，只有通过管理员授权、认证和发布复核的公开投影可进入候选。
- OQ-023 未关闭前，普通用户只能执行 `non_personalized`；`personalized` 草稿和合成 Dry-run 可开发，但服务端拒绝启用。
- 当前个性化模型只允许观看者主动选择的稳定 taxonomy 词条。喜欢、关注、收藏、浏览、搜索、会员、金币、平台话题、私信、精确位置和管理员内部字段均不作为 Recommendation-1 运行信号。
- OQ-020 未关闭前，推荐证据不写入；会话/条目表只作为受门禁约束的未来结构。
- 热度公式 OQ-009 未关闭，migration 只创建未批准的空信号开发版本；默认规则热度权重为 `0`。
- 运营精选固定返回 `source=editorial`、`disclosure=平台精选`，不能改成自然热门、认证或未披露推荐。
- 统一公开资格由 `app-discovery.ts` 导出的同一 SQL 谓词复用；后台预检不能代替请求时的权威复核。

## 3. 能力与默认关闭

新增运行时变量类型，但本阶段不写入环境配置：

| 变量 | 作用 | 当前状态 |
|------|------|----------|
| `APP_RECOMMENDATION_ENABLED` | 公共推荐流与本人偏好总开关 | 未配置，关闭 |
| `APP_RECOMMENDATION_ADMIN_ENABLED` | 推荐运营后台总开关 | 未配置，关闭 |
| `APP_RECOMMENDATION_POLICY_VERSION` | 显式策略 ID | 未配置 |
| `APP_RECOMMENDATION_PRODUCTION_READY` | production 外部门禁 | 未配置，关闭 |
| `SESSION_SECRET` | 分用途 HMAC 签名推荐游标和账号证据摘要；复用既有服务端密钥，不新增客户端配置 | 运行推荐时要求至少 16 字符 |

bootstrap 新增：

```json
{
  "capabilities": {
    "recommendation": {
      "feed": false,
      "preferences": false,
      "personalization": false,
      "editorial": false
    }
  },
  "recommendation": {
    "policyVersion": "rcp_app_1_0_recommendation_1_dev_1",
    "transport": "http_post",
    "defaultMode": "auto",
    "allowedModes": ["auto", "non_personalized", "personalized"],
    "defaultPageSize": 20,
    "maxPageSize": 40,
    "personalizationDecisionStatus": "unresolved",
    "evidenceRecording": false,
    "editorialDisclosureLabel": "平台精选"
  }
}
```

production 还要求策略本身为 `published + production_ready`、规则版本通过生产门禁，并满足现有认证、授权、发布和来源图库条件。任何一层缺失都 fail closed。

## 4. App API v2 `1.16.0`

### 4.1 公共/观看者接口

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `POST` | `/api/v2/discovery/recommendations` | 可选 | 版本化推荐；匿名只能非个性化；有效 token 启用屏蔽过滤和已批准的显式偏好 |
| `GET` | `/api/v2/me/recommendation-preference` | 必须 | 读取本人请求态、有效态、稳定目录和词条 |
| `PUT` | `/api/v2/me/recommendation-preference` | 必须 | 使用 `expectedVersion` 更新本人显式偏好 |

推荐请求只接受：

```json
{
  "mode": "auto",
  "regionCode": "cn-bj",
  "limit": 20,
  "cursor": null
}
```

- `auto`：只有政策、本人开关、稳定词条和个性化生效规则全部可用才执行个性化，否则返回非个性化；本人曾请求但当前不可用时返回 `PERSONALIZATION_NOT_READY`。
- `personalized`：显式请求不可用时返回 `403`，不会静默放宽为其他模式。
- `non_personalized`：不读取账号互动、历史、会员、金币或消息事实；登录身份只用于排除本人已屏蔽资料。
- 推荐项返回 `ruleVersionId`、可本地化 `reason.code`、安全中文 `reason.label`、来源和精选披露。
- 游标由服务端使用 `SESSION_SECRET` 分用途 HMAC 签名，短期有效并绑定会话、实际执行规则、模式、地区和偏好摘要；客户端改写、游标到期、规则或条件变化均返回游标无效，不跨版本混排，也不能通过伪造会话 ID 选择灰度分桶。

偏好更新：

- 首次写入使用 `expectedVersion=0`，后续使用当前正整数版本。
- 开启时必须提交当前可用不可变 taxonomy 目录和 1–20 个允许用于资料的稳定词条；只有本人目录与实际个性化规则目录一致时才标记为有效并参与排序。
- 关闭时服务端原子清空目录和词条，不保留暗中待生效画像。
- OQ-023 未批准时服务端拒绝 `personalizationEnabled=true`。

### 4.2 推荐运营 API

根路径：`/api/admin/app/recommendations`。外层继续使用后台 session 与 `admin|owner` 认证。

| 能力 | 路径 |
|------|------|
| 概览 | `GET /overview` |
| 规则列表/创建 | `GET/POST /rules` |
| 规则详情/草稿编辑 | `GET/PATCH /rules/:ruleVersionId` |
| 复制新版本 | `POST /rules/:ruleVersionId/copy` |
| 无曝光 Dry-run | `POST /rules/:ruleVersionId/dry-run` |
| 提交、复核 | `POST /rules/:id/submit`、`POST /rules/:id/decision` |
| 计划/启用、暂停、回滚 | `POST /rules/:id/activate|pause|rollback` |
| 精选列表/创建 | `GET/POST /placements` |
| 精选详情/草稿编辑 | `GET/PATCH /placements/:placementId` |
| 精选提交、复核、启用、暂停 | `POST /placements/:id/submit|decision|activate|pause` |
| 守护概览、策略列表/创建 | `GET /guardrails/overview`、`GET/POST /guardrails` |
| 守护策略详情/编辑/复核/退休 | `GET/PATCH /guardrails/:id`、`POST /guardrails/:id/submit|decision|retire` |
| 聚合评估写入/详情 | `POST /rules/:id/guardrail-evaluations`、`GET /guardrail-evaluations/:id` |

创建和复制要求 16–128 字符 `Idempotency-Key`；草稿更新和所有状态操作要求 `expectedVersion`。创建人不能复核自己的规则或排期。管理员可创建、编辑和提交；Owner 负责批准、启用、暂停和回滚。

## 5. 数据结构

`0083_app_recommendation_rules_and_editorial.sql` 新增：

| 表 | 责任 |
|----|------|
| `app_recommendation_policies` | capability、生产门禁、个性化/证据决策和容量上限 |
| `app_recommendation_heat_versions` | 不可变热度公式版本 |
| `app_recommendation_heat_scores` | 按公式版本保存的整数化资料热度 |
| `app_recommendation_rule_versions` | 规则集内不可变业务版本、权重、范围、多样性、灰度和回滚引用 |
| `app_recommendation_rule_events` | 状态迁移、原因、操作者和请求 ID 时间线 |
| `app_recommendation_preferences` | 本人显式开关和稳定 taxonomy 选择 |
| `app_recommendation_editorial_placements` | 固定披露的运营精选时间窗 |
| `app_recommendation_sessions` | 受保留策略门禁的最小化会话证据 |
| `app_recommendation_session_items` | 受门禁的资料、原因和精选引用 |
| `app_recommendation_admin_requests` | 创建/复制幂等结果 |

migration 只 seed development 策略和空信号热度草稿；仅在已有 Owner 时创建一条 `rollout=0` 的非个性化开发草稿，不创建生效规则。

`0113_app_recommendation_guardrails.sql` 另增加默认关闭的守护 control、版本化策略/事件、规则策略引用、聚合评估/逐指标结果、每规则唯一阻断和管理员幂等结果。它不 seed 真实来源决定、保留期、阈值、评估或阻断。

`0114_app_recommendation_evidence_lifecycle.sql` 只增加账号摘要定位索引与会话/条目 UPDATE 不可变约束；到期和已验证注销仍允许物理删除。它不启用证据记录，也不 seed 保留期、账号摘要或真实会话。

## 6. 排序、灰度和计划生效

### 6.1 排序

当前执行器只允许五个登记信号，权重之和必须为 `100`：

```text
score = quality × Wq
      + heat × Wh
      + freshness × Wf
      + selectedRegion × Wr
      + explicitTaxonomyPreference × Wp
```

各信号先归一为 `0..1,000,000` 的整数，再按整数权重计算。非个性化要求 `Wp=0`；热度权重大于 0 时必须绑定 `heatVersionId`；个性化要求稳定目录且 `Wp>0`。候选按得分、发布时间、稳定资料 ID 排序，并应用同地区/同首要分类连续上限。

当前 `repeatExposureCap` 只保存为未来会话频控策略参数。OQ-020 未批准且证据记录关闭时，不声称执行跨会话频控；同一游标会话依靠稳定排序和游标边界避免分页重复。

### 6.2 会话级稳定灰度

- `rolloutPercent=100`：全部新推荐会话使用目标版本。
- `1..99`：必须绑定另一个同入口、同模式、已生效过、未过期且满足当前环境门禁的回退版本；个性化目标与回退版本必须使用同一 taxonomy 目录。
- 服务端以 `activeRuleVersionId + sessionId` 的 SHA-256 结果稳定分桶；后续页只能从签名游标恢复同一会话和实际规则。
- 灰度未命中时返回完整回退版本结果，不混合两版排序；公开资格不变。
- `rolloutPercent=0` 不允许启用。
- bootstrap、推荐流和本人偏好按 `X-Client-Version` 执行策略与规则最低版本门禁；新排期要求更高版本时，旧客户端继续使用兼容 active 版本。
- active 规则高于当前客户端版本时只允许使用显式登记且兼容的历史回退版本；规则最低版本高于策略基线时，即使 `rolloutPercent=100` 也必须登记回退版本。
- `targetRegionCodes=[]` 表示全局规则；非空数组只服务明确目标地区。规则选择会先同时校验地区与客户端版本，新排期不覆盖当前地区时继续使用兼容 active，而不是先选中后失败。
- 地区规则即使全量启用也必须登记回退；全局目标只能回退到全局规则，地区目标的回退必须为全局或覆盖目标全部地区。运行期回退仍会再次校验当前请求地区。
- scheduled、active 与显式历史回退还会依次校验完整权重/理由/渠道和 taxonomy、heatVersion 运行依赖；高优先候选失效时继续使用下一条完整规则，bootstrap 也只公布实际可执行版本。
- 个性化选择绑定账号偏好的不可变 taxonomy 目录；新目录排期不会覆盖仍使用旧目录的账号，`auto` 无同目录安全规则时回落到非个性化。
- 部分灰度必须绑定 approved 守护策略，且来源、保留、purge 与环境门禁完整；blocked 或守护链不完整的目标不进入新会话选择。
- 灰度回退必须为 `rolloutPercent=100` 的完整版本。来源缺项或停止级反指标达到连续越线条件时写不可变 block，不伪造 paused 状态；被阻断版本不能复活，只能复制新版本重新复核。

### 6.3 计划生效

- `effectiveAt` 在未来时，启用动作把规则置为 `scheduled`，不会提前暂停当前 active 版本。
- 同一入口和模式最多一个 scheduled 版本；新排期会以审计事件暂停旧排期。
- 到点后新会话优先选择 scheduled 版本；暂停或回滚 scheduled 版本会继续保留既有且重新通过运行依赖校验的 active 安全版本，不尝试激活另一个与当前运行状态冲突的旧版本。
- 立即启用会原子暂停同模式的 active/scheduled 冲突版本后切换目标版本。

## 7. 状态机与一致性

规则：

```text
draft → validating → approved → active
                         └────→ scheduled → active（逻辑到点选择）
active/scheduled → paused
active/scheduled → rolled_back → rollback target
reject → draft
```

精选：

```text
draft → pending_review → approved → active/scheduled
reject → draft
active/scheduled → paused
到期后运行查询自动停止返回
```

- 草稿修改会清空旧 Dry-run，避免用过期预览提交。
- 提交和启用均要求非空候选 Dry-run。
- 状态 UPDATE、事件和审计通过 mutation token 绑定；乐观锁失败不会留下伪事件或伪审计。
- 立即替换和回滚通过条件更新与 D1 batch 收敛；目标版本、冲突版本和回退引用都重新校验。
- 精选在提交、批准、启用和每次用户请求时复核公开资格；资料失效后自动从响应移除。同一真人命中多个适用排期时按优先级只返回一次。
- 已结束排期不能提交、批准或启用；已暂停排期保持只读，重复投放必须创建并重新复核新排期，不能原地复活历史配置。
- 个性化 active/灰度回退版本必须引用同一有效 taxonomy 目录；热度权重大于 `0` 时必须引用 `approved|active` 的热度版本，production 还要求依赖本身通过 production-ready 门禁。
- 推荐证据启用后，账号引用使用分用途 HMAC 摘要；签名游标到期后不能重建已被保留策略清理的旧会话。
- 证据到期清理只有在显式策略、批准保留天数和 purge 门禁完整时才运行，每 15 分钟有界删除到期会话并级联条目；Privacy-2B 注销以同一 HMAC 定位账号关联会话并将会话/条目纳入零残留核验。
- 守护评估只接受固定聚合指标与 SHA-256 快照引用；低样本保持 observing，批准来源缺少必需指标立即停止，评估序号和阻断由数据库唯一约束防止并发重复。

## 8. Nuxt 推荐运营工作台

已新增四个独立页面并加入后台导航：

| 页面 | 实现 |
|------|------|
| `/admin/app/recommendation/rules` | 策略门禁、统计、筛选、规则创建和版本列表 |
| `/admin/app/recommendation/rules/:ruleVersionId` | 草稿编辑、权重校验、灰度/排期、提交/复核/启用/暂停/回滚和事件时间线 |
| `/admin/app/recommendation/rules/:ruleVersionId/preview` | 合成地区、无真实偏好的 Dry-run、空候选/理由/重复/地区覆盖和 Top 结果 |
| `/admin/app/recommendation/placements` | 排期创建、详情编辑、当前公开资格、职责分离和状态操作 |

页面统一使用 `min-w-0`、可换行操作区、响应式栅格和横向表格容器，避免窄屏文字、按钮和表格越界。状态均有文字标签，不只依赖颜色。

Recommendation-5 当前没有正式后台守护/监控 Figma，因此只增加管理员 API，不新增第五个 Nuxt 页面或导航；任何策略编辑、自动停止详情、告警或图表页面必须先取得正式 Figma Node ID。

## 9. KMP 推荐与隐私页面

同级 `meigallery-client` 仓库已在提交 `0c308c3` 完成 Recommendation-1：

- transport 累计同步至 App API v2 `1.16.0`，严格解析推荐、偏好和 taxonomy capability；
- 公共请求构造器固定发送两段数字 `X-Client-Version`，并由现有推荐请求发送规范化 `regionCode`；Recommendation-2/3/4/5/6 不需要新增 KMP DTO 或页面；
- `KtorRecommendationRepository` 覆盖版本化推荐、公开不可变分类目录、本人偏好读取与乐观版本更新；
- 发现页支持智能/通用推荐、实际执行模式、fallback、逐卡推荐理由和固定“平台精选”披露；
- 推荐分页要求 session、规则、实际模式和热度版本一致，游标过期后重新开始会话，不跨版本混排；
- “我的 → 推荐与隐私”按 11 类稳定 taxonomy 展示最多 20 个主动偏好，关闭时提交空目录和空词条；
- capability 关闭时继续使用既有发现 Feed，不显示偏好入口，不提前创建本地画像。

Android Debug APK 与 iOS Simulator Kotlin/Native 编译已通过。专项 MockEngine/Host Test、Framework 链接、模拟器/真机和远端联调按统一验证阶段后置。

## 10. 本阶段后置项

按当前“先完成所有开发，再统一配置与测试”的顺序，以下内容未执行：

1. Wrangler 开关、策略 ID 与 production-ready 配置。
2. 本地/dev/production 的 `0083/0113/0114` migration 执行和任何真实数据创建。
3. API/D1 状态机、资格、游标、灰度、守护评估、自动停止、证据到期/注销删除、回滚、幂等、并发和 UI 专项测试。
4. OQ-009 热度公式、反刷样本和聚合任务；OQ-020 证据保留期与 purge；OQ-023 个性化法律决策。
5. 跨会话频控、真实聚合来源、生产目标/反指标阈值、告警和运营监控看板；Recommendation-5 已完成默认关闭的策略、评估、不可变停止和运行回退源码，Recommendation-6 已完成批准后到期清理和账号注销联动，但二者都不能被解释为来源、阈值或保留期已经获批。客户端版本、地区作用域、依赖可执行性与安全回退源码已由 Recommendation-2/3/4 完成，真实版本/地区分布和扩量参数仍待统一验证及生产决策。当前所有规则共享“公开资格 + 请求地区”候选集合，运行期集合为空时旧规则同样无内容，故安全语义是显式空结果而不是无效的跨规则重排；若未来增加规则专属候选过滤器，再单独设计跨规则结果降级。
6. 远端推送、dev 联调和 production 发布。

这些后置项不改变当前默认关闭结论，也不能通过直接改数据库状态绕过运行时和 production 双门禁。
