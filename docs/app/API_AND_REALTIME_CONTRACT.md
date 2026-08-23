# App API 与实时通信契约

App 版本：1.0

日期：2026-08-23

状态：整体需求讨论中；M0 公共发现已冻结，M1、Auth-1、Interaction-1/2/3、Search-1/2、Taxonomy-1、Recommendation-1、Privacy-1/2A/2B、Media-1、Membership-1/2/3/4/5/6/7、Message-1/2/3/4/5/6/7/8、Safety-2/3、Wallet-1/2/3/4、Audit-1/2/3 与 Operations-1/2/3/4 进入默认关闭或未配置的保守开发验证

## 1. 契约原则

- HTTP 基础路径使用 `/api/v2`，旧 Web API 保持兼容直至迁移完成。
- OpenAPI、JSON Schema 和实时事件 schema 是 Kotlin/TypeScript 契约源。
- 对外 ID 为不可枚举字符串；不暴露 D1 自增 ID。
- 所有对象权限在服务端校验，客户端隐藏按钮不构成授权。
- 消息、订单、礼物、调币和关键互动强制幂等。
- 未知字段向前兼容，未知枚举使用 `unknown`/安全降级，不扩大权限。

### 1.1 App 1.0 启用范围

- 1.0 必须实现：账号、真人发现、单向互动、五级会员目录、entitlement、会话/文本消息、站内通知、钱包余额/明细、管理员会员发放和管理员调币。
- 仅保留未来契约：订单/商店验证、金币包、礼物、装扮、真人认领和系统推送。未立项前不部署生产路由，也不向 1.0 客户端下发可执行 capability。
- 路由表中的“未来”表示长期兼容设计，不属于 App 1.0 上线验收。详细边界见 [App 1.0 发布范围](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)。

### 1.2 M0 局部冻结记录

本轮只冻结并实现以下开发联调边界，唯一 HTTP 事实源为 [`contracts/app-api-v2.openapi.yaml`](../../contracts/app-api-v2.openapi.yaml)：

- `GET /api/v2/app/bootstrap`：返回真实可用 capability；未启用的登录以及未实现的消息、支付和系统推送必须为 `false`。
- `GET /api/v2/discovery/feed`：支持 `recommended`、`popular`、`latest` 三种稳定排序、地区筛选和不透明游标。
- `GET /api/v2/discovery/regions`：只统计当前具有公开资格的人物。
- `GET /api/v2/person-profiles/:profileId`：返回同一公开资格边界下的基础详情投影。
- 四个 M0 响应统一返回 `Cache-Control: no-store`，避免资格撤回、授权到期或源图库下线后被中间缓存继续展示；后续只有在完成可撤销缓存设计后才能调整。

账号体系不属于 M0 冻结范围；Auth-1 只以默认关闭的开发基线独立推进。通知、Message-4 最小实时刷新与 Wallet-1 已形成默认关闭的开发契约和代码闭环，真人认领、媒体访问及其生产启用仍按开放问题与专业门禁逐项冻结。M0 migration 只创建空的可重建读投影，不自动迁移或公开任何现有图库，也不代表允许直接部署生产。

### 1.3 M1 人物供给开发边界

M1 在现有 Web 管理员会话域内使用 `/api/admin/app/persons`，先验证候选、用途授权、认证、发布和暂停的完整后台闭环。该前缀是当前 Nuxt 后台的受保护管理接口，不是 KMP 客户端公开契约；未来若统一为 `/api/v2/admin`，必须通过服务层复用或兼容适配迁移，不能形成第二套人物事实表或第二条投影链路。

M1 管理命令全部要求 `expectedVersion`，认证和授权绑定具体 `contentVersion`。发布决定再次校验全门禁后才写入公开投影；授权/认证撤销与人工暂停立即下线。当前不导入真实人物或证据，不执行 production migration，认证正式声明和职责分离仍是生产门禁。

### 1.4 Membership-1 局部冻结记录

Membership-1 以兼容新增方式把契约提升为 `1.4.0`，只冻结并实现以下最小边界：

- `GET /api/v2/membership/catalog`：公开读取当前明确配置的五级目录和 typed entitlement。
- `GET /api/v2/me/entitlements`：使用 App Bearer 会话读取本人最高有效 App grant 与权威快照。
- bootstrap 增加 `membership.catalog`、`membership.entitlements` 和 `membership.applications`；本阶段申请能力固定为 `false`。
- 管理后台复用受保护的 `/api/admin/app/memberships`，覆盖目录、账号状态、发放/续期/撤销预览、独立复核申请、队列、逐单批准/拒绝，以及默认关闭的批量预览、逐行复核提交、恢复和 draft 取消。

当前五级数值全部是 `development + planned`，不构成正式额度承诺或可执行业务权限。`user_memberships` 的旧 `vip/svip` 不进入 App 权益解析。Membership-2 已冻结用户申请，Membership-3 已实现管理员单账号独立复核；没有正式策略时全部复核。Membership-4 已实现目录与 typed entitlement 管理平面，不改变 App API v2 响应结构或运行目录。Membership-5 已实现但尚未执行旧会员显式迁移；Membership-6 已实现默认关闭的管理员批量服务端契约，每行仍进入 Membership-3 普通复核，不新增公共 App API 或 transport 版本。Message-1 已独立实现 `direct_message.new_threads_per_day` 的上海自然日原子消耗。

#### Membership-4 管理平面开发补充

`/api/admin/app/memberships` 已新增目录列表/详情、完整复制、设置与完整五级编辑、Entitlement upsert、基线比较、影响分析、发布申请、复核队列和 Owner 决定。所有写命令要求管理员会话、`Idempotency-Key`，修改与决定同时要求 `expectedVersion`；发布申请固化目录 lock、校验报告与内容哈希。

目录管理接口不依赖当前 App 会员能力开关，以便在功能关闭时准备下一版本，但它不能切换 Wrangler 的目录 ID。当前环境引用、已发布、待复核以及存在 grant、会员申请或后继版本引用的目录都只读。发布决定只把新目录变为不可变 `published`；只有后续独立配置变更和既有 production 双门禁同时通过，App 才可能读取或执行该目录。

Entitlement 校验要求五级显式值、typed 安全默认值和稳定 capability。未登记 capability 可以作为全量 `planned` 保存，但任何 `available` 都会阻断发布；这为未来能力预留 Schema，不允许旧客户端因未知字段扩大权限。完整接口和状态边界见 [Membership-4 会员目录与 Entitlement 管理开发基线](./MEMBERSHIP_4_CATALOG_MANAGEMENT_INTEGRATION.md)。

#### Audit-1 管理平面开发补充

`/api/admin/app/audit` 新增用途必填的受限审计查询、字段级脱敏详情、非敏感关联时间线和 Owner 完整性检查。该前缀是 Nuxt 管理契约，不修改 App API v2 或 KMP capability。普通 admin 的 SQL 查询固定绑定本人 actor；Owner 才可跨域。每次查询/详情读取都追加新审计事件，审计页面没有业务重放、回滚或修改接口。

完整性检查通过稳定 sequence 和 SHA-256 链式 manifest 检测缺口、索引、载荷、敏感字段、Action 登记和相同范围摘要变化，并反向核对会员发放、钱包入账、运营回复和人物发布四类权威业务事实是否有对应审计；检查只追加清单和摘要 finding，不补写审计。`0090`、正式 Action/治理策略配置、保留与调度配置和专项测试继续后置。完整边界见 [Audit-1 App 审计查询与完整性开发基线](./AUDIT_1_QUERY_AND_INTEGRITY_INTEGRATION.md)。

#### Audit-2 管理平面开发补充

Audit-2 只新增 `/api/admin/app/audit/exports*` 管理接口，不扩展 App API v2，也不向 KMP 暴露审计数据。申请、不同 Owner 复核、原申请人发票分别要求密码 step-up；凭证与票据只存 SHA-256 并一次性消费。申请保存 Audit-1 规范范围、权限指纹、事件数量、首末 sequence 和摘要；复核与发票前重新计算，任一变化进入 `scope_changed`，生成完成前也必须确认申请人与复核人角色仍有效。CSV 逐行水印、字段级脱敏并防公式注入，固定写私有 R2；客户端只能用 header 中的短时一次性票据经 Worker 下载，API 不返回 R2 地址。Web 同源代理仅为该流程放行 `Idempotency-Key`、`X-Audit-Step-Up`、`X-Audit-Download-Ticket`，所有审计响应强制 `private, no-store`。`0091`、正式保留/物理清理配置和专项测试统一后置。完整边界见 [Audit-2 受控审计导出开发基线](./AUDIT_2_CONTROLLED_EXPORT_INTEGRATION.md)。

#### Audit-3 管理平面开发补充

Audit-3 新增 `/api/admin/app/audit/registry/*` Owner-only 管理接口，不修改 App API v2 或 KMP capability。总览和 Action 发现合并真实审计事实与前置登记定义；预览核对历史业务域、风险、缺索引、最新版本和 retention/quality 稳定引用；发布与退休必须由另一位有效 Owner 复核。申请与复核要求 `Idempotency-Key`，批准在服务判断和最终条件 SQL 中双重重验，版本、观察摘要或策略就绪状态变化时安全进入 `stale`。

普通 admin 的审计查询、详情、关联时间线和 Audit-2 范围冻结已统一使用 `app_audit_production_action_registry`，必须同时满足本人归属、Action 当前 active、两类治理引用已批准且 production-ready，以及 `visibleRoles` 包含 `admin`。Owner 保留全部事实的治理可见性。缺表、缺策略或未登记时 fail-closed，不回退旧 active View。`0093`、真实治理策略/Action、配置和专项测试统一后置。完整边界见 [Audit-3 Action 口径治理与独立发布开发基线](./AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md)。

#### Operations-1 管理平面开发补充

Operations-1 只新增 `/api/admin/app/operations/*` 管理接口，不修改 App API v2 和 KMP capability。读取接口提供全局总览、Runbook、事件列表/详情和安全控制影响预览；Owner 写接口生成人工指标快照、运行检测以及暂停/恢复控制；负责人或 Owner 可领取、追加记录、关联 Runbook 和迁移事件状态。所有响应 `private, no-store`，写命令要求 `Idempotency-Key`，事件与控制更新要求服务端乐观版本。

当前指标只返回全局聚合及显式质量状态，不返回个人排行、消息正文、证件、内部备注或未来商业化指标。事件详情读取本身留审计；关闭必须提供结论和证据。Operations-2/3 不增加管理路由：同一个检测命令并行核对 10 类 D1 事实和 Cloudflare 官方 Status API，外部来源不可用时保留 D1 发现并把运行标记为 `partial`，相关公共组件异常才形成 `platform_health_anomaly`。Operations-4 同样不增加路由或响应字段；Owner 刷新既有总览时，`operations-metrics-v2` 一次读取账户级 Cloudflare GraphQL，把 Workers/D1/R2 指标写入既有 18 项快照。配置缺失为 `unconfigured`，来源/空样本为 `unknown`，结构违约为 `invalid`，只有 `known` 返回数值；公共 Status 与账户级指标互不替代。五类安全控制同时接入管理预览与真实业务写路径，表缺失或状态非法时 fail-closed；`available` 不会开启底层已关闭 capability，平台来源也不会自动暂停控制。完整路由、状态机和影响矩阵见 [Operations-1](./OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md)、[Operations-3](./OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md)与 [Operations-4](./OPERATIONS_4_CLOUDFLARE_ANALYTICS_INTEGRATION.md)。`0092/0108`、Cloudflare Analytics 配置、调度和专项测试统一后置。

### 1.5 Message-1 局部冻结记录

Message-1 以兼容新增方式把累计契约提升为 `1.5.0`，只冻结并实现默认关闭的最小平台话题边界：

- 用户侧实现创建/复用、会话列表、详情、sequence 补拉、文本发送和已读；传输固定为 `http_pull`，不包含实时通道或系统推送。
- bootstrap 增加 `capabilities.messaging` 以及受校验的 `receiverLabel`、`disclosureVersion`、`disclosureText`、`transport` 和 `maxTextLength`。字段缺失、矛盾或未知时客户端必须关闭入口。
- 只有精确配置到 Message-1 开发目录且三项消息 entitlement 为 `available` 时才能通过服务端校验；等级名称不参与授权，日额度按上海自然日原子消耗。
- 未认领真人仅允许 `platform_managed`。平台接收披露必须出现在人物详情确认、会话列表、会话顶部和系统消息中；运营回复只能标记为 `platform_operator`。
- Nuxt 暂时使用 `/api/admin/app/conversations` 队列处理消息；正文访问声明 `service_operation` 并审计，审计和通用日志不得复制正文。
- 实时消息、媒体、撤回、静音、关闭、举报/拉黑、多操作员分配、本人运营及历史交接均保留在完整产品需求中，不属于 Message-1 已实现契约。

Message-1 的 production/dev 用户与后台开关、production-ready 门禁均保持关闭，现有环境目录也未切换到新开发目录。migration 和代码存在不表示可以部署或开放生产能力。

### 1.6 Message-2 局部冻结记录

Message-2 以兼容新增方式把累计契约提升为 `1.6.0`，冻结并实现以下默认关闭边界：

- bootstrap 增加分项 `capabilities.safety.reports|blocks|conversationClose`、版本化原因目录、最大说明长度和四种预声明目标；非法或矛盾配置必须使客户端安全关闭对应入口。
- 登录发现请求可以携带 Bearer token，由服务端排除当前账号已屏蔽人物；匿名发现保持可用，无效 token 返回 401，不能静默降级为匿名结果。
- 用户可读取/变更人物屏蔽状态，分页读取当前屏蔽列表，举报人物、媒体、本人话题或本人消息，读取本人举报列表/必要时间线，并主动关闭本人话题。
- 屏蔽、举报与关闭写操作均要求独立幂等键；屏蔽联动清理喜欢/关注并关闭旧话题，解除不恢复历史关系或话题。
- 管理后台为过渡实现：会话正文要求限时 assignment；举报领取后才允许读取最小证据；运行控制可暂停新建、观看者发送或运营发送，并设置容量和租约。
- `0073` 保留策略仍为 `unresolved`，自动清理关闭；production safety 与 production-ready 开关保持 false。dev 只为 Safety-2 内部端到端联调开启用户端和后台安全开关，production-ready 仍为 false；用户上传证据、系统通知和实时通道不属于本切片。

完整实现与生产门禁见 [Message-2 跨仓集成边界](./MESSAGE_2_CROSS_REPO_INTEGRATION.md)。

### 1.7 Safety-2 局部冻结记录

Safety-2 以兼容新增方式把累计契约提升为 `1.7.0`，只冻结举报“未发现违规”结论的独立复核：

- bootstrap 增加 `capabilities.safety.appeals`、`appealPolicyVersion` 与 `maxAppealStatementLength`；用户端、后台端和 production-ready 开关相互独立且当前全部关闭。
- 举报摘要增加单调 `version`，详情增加服务端权威申诉资格、不可用原因、既有申诉 ID 与状态。客户端不得本地推导申请窗口。
- `POST /api/v2/appeals` 只接受 `report_no_violation_review` 的举报 ID、预期举报版本和 1–500 字说明；同一举报结论版本只允许一个申诉，不接受文件证据。
- `GET /api/v2/me/appeals` 与 `GET /api/v2/me/appeals/:appealId` 只返回本人记录和用户可见时间线。
- 复核必须由不同于原审核人的管理员领取。`upheld` 维持原结论；`changed` 只把原举报重开为调查中，不自动认定违规或执行处置。

完整实现与生产门禁见 [Safety-2 跨仓集成边界](./SAFETY_2_APPEAL_INTEGRATION.md)。

### 1.8 Wallet-1 局部冻结记录

Wallet-1 以兼容新增方式把累计契约提升为 `1.10.0`，只冻结并实现默认关闭的最小金币账本边界：

- 用户侧只实现本人余额、按方向游标明细和分录详情；空钱包返回虚拟零余额，不因读取创建业务记录。
- bootstrap 增加严格 wallet capability、development policy、整数金币格式和明确为 `false` 的支付、充值、消费、转账与提现能力。
- 管理员过渡路由 `/api/admin/app/wallets` 只提供账号确认、单笔加币/扣币/补偿/完整冲正的预览、幂等申请和另一管理员批准/拒绝。
- OQ-018 未关闭前所有申请强制独立复核，发起人不能自批；批准时重新校验账号、余额和 sequence，任何扣币不得产生负余额。
- 已生效分录不可编辑或删除，余额变化必须匹配新分录；用户申诉、批量、迁移、自动对账、部分冲正和全部商业交易能力未进入本切片。

production/dev 的用户、管理员和 production-ready 开关均保持关闭，`0077` 未执行远端 migration，也没有真实余额或调币数据。完整边界见 [Wallet-1 金币账本跨仓交付基线](./WALLET_1_LEDGER_INTEGRATION.md)。

### 1.9 Interaction-2 局部冻结记录

Interaction-2 在 `1.11.0` 首次冻结默认关闭的服务端收藏夹与浏览历史边界；该切片在累计 `1.21.0` 且不改变 capability 默认关闭前提下补齐 Figma-first 列表契约，仓库当前累计为 `1.26.0`：

- 收藏独立于喜欢和关注，使用默认收藏夹、多自定义收藏夹和 API 去重聚合能力；同一人物可进入多个文件夹，全局取消收藏才移除全部关系。移动端 Figma 不提供独立“全部收藏”卡片。
- 自定义收藏夹以客户端随机稳定 ID 幂等创建，编辑和删除使用 `expectedVersion`，名称最多 20 字；当前数量额度来自可执行 `favorite.folder_count` entitlement，降级保留已有数据并拒绝继续超额创建。
- 收藏夹集合返回去重总数和每夹最多四张当前公开封面；收藏列表支持最多 40 字搜索、单地区 code 与单风格 term ID，游标绑定完整筛选上下文。
- `0096` 保证删除自定义收藏夹时把条目保留到默认收藏；兼容字段 `removedGlobalFavoriteCount` 固定为 `0`，删除操作不取消喜欢。
- 浏览历史默认关闭；详情成功呈现后才提交 `viewId + expectedHistoryVersion`。逐条删除和清空都会原子提升版本并删除记录，防止操作前的在途写请求重新写回。
- bootstrap 增加 `interactionCollections` 配置，并由 Auth、独立运行开关、策略版本和 production-ready 共同控制 `interactions.favorite|history`。当前未配置任何环境，因此两项继续为 `false`。
- OQ-014、OQ-020、OQ-023 保持未决；当前不执行 `0078`/`0096` migration、不生成 purge、不接推荐信号、搜索历史或关注更新。KMP 构建、专项测试、`android-cli` 截图和远端联调按开发顺序后置。

完整边界见 [Interaction-2 收藏夹与浏览历史开发基线](./INTERACTION_2_FAVORITES_HISTORY_INTEGRATION.md)。

### 1.10 Interaction-3 局部冻结记录

Interaction-3 以兼容新增方式把累计契约提升为 `1.12.0`，并完成默认关闭的 Cloudflare 与 KMP 关注更新边界：

- `GET /api/v2/me/follow-updates` 只读取当前账号关注建立后、策略生效后审核通过的 `person_publication_reviews`，不新增第二套发布事件或内容快照。
- 响应使用账号绑定不透明游标，携带稳定更新 ID、发布/投影版本、发布时间和当前仍满足公开资格的人物卡片；不返回内部审核信息和受保护媒体。
- bootstrap 增加独立 `interactions.followUpdates` 与 `followUpdates` 配置；能力必须通过 Auth、运行时、版本化策略和 production-ready 门禁，不能由 `follow=true` 推导。
- Message-3 在 HTTP pull 前按账号惰性投影关注更新 Outbox，以 `(account,event type,publication)` 去重；投递前重验当前关注、屏蔽与公开资格，取消关注或失效后抑制且不补发。
- KMP 已实现独立 capability/transport；底部“关注”页按 Figma 使用“全部 / 有更新 / 最近关注”筛选，喜欢由独立 `APP-INT-02` 承载，并保留取消关注回收、详情返回刷新和现有 Message-3 通知目标跳转。当前仍不执行 `0079`、不配置环境、不接系统推送，也不运行专项测试、模拟器/真机或远端联调。所有现有环境继续返回 `followUpdates=false`。

完整边界见 [Interaction-3 关注更新流与站内通知开发基线](./INTERACTION_3_FOLLOW_UPDATES_INTEGRATION.md)。

### 1.11 Search-1 局部冻结记录

Search-1 以兼容新增方式把累计契约提升为 `1.13.0`，冻结并实现默认关闭的服务端人物搜索与搜索历史边界：

- `POST /api/v2/person-profiles/search` 只搜索审核展示昵称、公开地区和公开标签；使用 POST 正文避免自由搜索词进入 URL 与访问日志。
- 搜索结果重用公开人物资格并排除本人已屏蔽人物；支持 `relevance / popular / latest`，游标绑定账号、搜索词哈希与排序，不包含原始搜索词。
- 搜索读取不隐式记录历史。搜索历史必须由用户独立开启，并在成功呈现后提交 `searchId + query + expectedHistoryVersion` 的幂等写命令。
- 搜索历史与浏览历史分表、分开关、分版本；支持本人分页、逐条删除和版本化全部清除，清除可同时关闭未来记录。
- bootstrap 增加 `capabilities.search.profiles|history` 与 `search` 配置。production 可单独开放人物搜索；历史还必须通过保留期审批、purge 与独立生产门禁。
- 当前不执行 `0080`、不配置环境、不实现 KMP 页面，不运行专项测试；高级筛选与保存条件由 Search-2 独立切片实现，热门词、联想词和推荐信号继续后置。

完整边界见 [Search-1 人物搜索与搜索历史开发基线](./SEARCH_1_PERSON_SEARCH_HISTORY_INTEGRATION.md)。

### 1.12 Taxonomy-1 局部冻结记录

Taxonomy-1 以兼容新增方式把累计契约提升为 `1.14.0`，冻结并实现默认关闭的稳定分类目录与人物关联服务端边界：

- `GET /api/v2/taxonomy/catalog` 只返回配置的不可变目录快照，词条使用稳定 `termId`、固定类型和 `termVersion`；合并源保留 `redirectTargetTermId`。
- bootstrap 新增独立 `capabilities.taxonomy.catalog` 和完整 11 类型声明。目录必须同时通过运行时开关、显式 catalog ID、有效时间与 production-ready 门禁。
- 目录响应支持 ETag 条件请求和 300 秒公共短缓存；失败不回退到 legacy 标签，不返回跨目录版本混合结果。
- `AppPersonProfile` 兼容新增 `taxonomyTerms`。人物结构化标注绑定内容版本、目录和词条版本；发布时与人物公开投影在同一 D1 batch 中刷新。
- legacy 值只允许 exact/alias/split_required/unsupported/pending_review 显式映射；未知值默认待复核，不能自动公开。
- 当前不执行 `0081`、不配置环境、不导入旧标签、不实现 Nuxt/KMP 页面，不运行专项测试；Search-2 已在此稳定 ID 基线上实现权益筛选和保存条件，但仍保持独立默认关闭。

完整边界见 [Taxonomy-1 稳定分类目录与人物关联开发基线](./TAXONOMY_1_CATALOG_AND_PROFILE_INTEGRATION.md)。

### 1.13 Search-2 局部冻结记录

Search-2 以兼容新增方式把累计契约提升为 `1.15.0`，冻结并实现 production 默认关闭的结构化筛选、结果预估与保存条件边界：

- `POST /api/v2/person-profiles/search` 兼容 `filters: {catalogVersionId, termIds}`；地区三类同组 OR、跨组 AND，父级包含后代，游标绑定账号、搜索词哈希、筛选哈希与排序。
- 基础筛选向登录观看者开放；风格/职业/场景由 `discovery.filter.advanced=basic|full` 控制，其余高级类型要求 `full`。越权条件 fail closed，不得忽略后返回扩大结果。
- `POST /api/v2/person-profiles/search/preview` 返回目录重定向、失效、冗余和权限状态；只有 `canApply=true` 时计算与正式搜索同资格口径的结果快照数。
- `/api/v2/me/search-filter-capabilities` 返回本人当前筛选档位和保存额度；`/api/v2/me/saved-filters` 提供账号私有 CRUD、创建幂等和修改/删除乐观版本。
- 保存条件只持久化 stable taxonomy ID、目录、名称和热门/最新排序，不保存自由搜索词。会员降级保留数据，删除清空词条并保留最小 tombstone。
- `0082` 创建 Search-2 策略、目录 closure、保存条件表和新的不可变会员开发目录，但不执行 migration、不切换配置、不迁移 grant。

完整边界见 [Search-2 结构化筛选、结果预估与保存条件开发基线](./SEARCH_2_FILTERS_AND_SAVED_FILTERS_INTEGRATION.md)。

### 1.14 Recommendation-1 局部冻结记录

Recommendation-1 以兼容新增方式把累计契约提升为 `1.16.0`，冻结并实现 production 默认关闭的版本化推荐平台边界：

- 新增 `POST /api/v2/discovery/recommendations`，响应绑定推荐会话、实际规则版本、模式、解释原因和精选披露；现有 `GET /discovery/feed` 保持不变。
- 新增本人显式推荐偏好 GET/PUT。当前只允许 stable taxonomy 主动选择；OQ-023 未批准时个性化规则不能启用。
- 小于 100% 的灰度必须绑定已生效过的同模式回退版本；个性化目标与回退目录一致，并按服务端生成的会话稳定分桶。推荐游标使用短期 HMAC 签名，客户端不能改写会话 ID 选择灰度桶；未来生效规则不会提前暂停当前 active 版本。
- 运营精选固定披露“平台精选”，并与规则候选复用统一公开资格和账号屏蔽过滤。
- 过渡管理路由 `/api/admin/app/recommendations` 和 Nuxt 四页工作台覆盖规则版本、Dry-run、复核、排期、启用、暂停、回滚和精选。
- 当前不配置环境、不执行 `0083/0113/0114`、不写真实推荐证据、不运行专项测试；KMP 已接入版本化推荐、实际模式、理由和显式偏好。Recommendation-5 已补齐默认关闭的守护策略、聚合评估与自动停止执行器，Recommendation-6 已补齐批准后到期清理和 Privacy-2B 账号关联删除，但真实热度公式、来源、阈值、保留决策和生产启用仍未冻结。

完整边界见 [Recommendation-1 版本化推荐与运营精选开发基线](./RECOMMENDATION_1_RULES_AND_EDITORIAL_INTEGRATION.md)。

### 1.15 Privacy-1 局部冻结记录

Privacy-1 以兼容新增方式把累计契约提升为 `1.17.0`，冻结并实现 production 默认关闭的数据权利登记、跟踪与取消控制面：

- bootstrap 新增数据权利 capability 和策略快照；策略、治理决策、申请、处理与取消均独立门禁，缺配置、未发布或未通过 production-ready 时 fail-closed。
- 用户可读取本人数据权利总览、申请列表和详情，并在密码二次验证后创建导出或注销申请；关键写入要求 `Idempotency-Key`，取消还要求 `expectedVersion`。
- 注销申请要求三项明确确认，创建后立即撤销 App/Web 会话、将账号置为 `deletion_pending`，并由数据库约束阻止新互动、收藏、历史、平台话题、会员申请/发放和钱包调整。
- 普通会话失效后只保留绑定单一申请的状态凭证访问：查询状态、为取消重新验证、取消申请；状态凭证不能访问其他申请或普通 App API。
- 管理后台 `/api/admin/app/data-rights` 提供最小化队列、详情、领取、开始处理、失败、重试和经证据核验的取消；本阶段故意不提供完成动作。
- Privacy-1 不生成导出制品、不签发下载凭证、不执行不可逆删除；真实处理、依法保留和对外 SLA 属于 Privacy-2，必须在地区、Owner、保留及恢复门禁冻结后实施。

完整边界见 [Privacy-1 数据权利控制面跨仓开发基线](./PRIVACY_1_DATA_RIGHTS_CONTROL_PLANE_INTEGRATION.md)。

### 1.16 Media-1 局部冻结记录

Media-1 以兼容新增方式把累计契约提升为 `1.18.0`，冻结并实现 production 默认关闭的人物图片与认证说明边界：

- 图片清单复用当前人物来源图库，游标绑定人物公开投影版本；只返回相对访问路径和要求的会员 rank，不返回 R2 key。
- 公开图与会员图取图前都重新验证人物认证、发布、授权、有效期、可见性和来源图库状态。
- 会员图短期凭证绑定账号、当前 App session、人物和单图，固定 5 分钟；实际取图再次检查会话与当前会员 rank。
- 图片由 Worker 代理且 `no-store`，只允许 JPEG/PNG/WebP/AVIF 和 24 MiB 以内对象；KMP token 只存在于网络局部变量，受保护字节只保留内存。
- 认证说明固定为四项公开范围，不披露证件、证据引用、审核人或内部备注；运营主体继续明确平台代运营或本人运营。
- `APP_MEDIA_ENABLED`、`APP_PROTECTED_MEDIA_ENABLED` 与 production-ready 门禁当前均未配置；视频继续为 `false`。

完整边界见 [Media-1 人物图片与认证说明跨仓开发基线](./MEDIA_1_PERSON_MEDIA_AND_VERIFICATION_INTEGRATION.md)。

### 1.17 App Core-1 局部冻结记录

App Core-1 以兼容新增方式把累计契约提升为 `1.19.0`：

- bootstrap 新增版本化 `runtime`，强制升级、维护/部分恢复、地区不可用按固定优先级阻止业务入口；
- bootstrap 新增 `support` 能力，`GET /api/v2/app/support` 返回版本化帮助、公开联系方式和四类法律文档目录；
- `/me` 新增可空 `restriction`，内部原因只映射为稳定用户类别，受限账号不放宽任何业务 API；
- 未启用运行策略配置时保持 `normal + App 1.0` 兼容基线；显式启用但配置非法时安全进入维护状态；
- 系统页不依赖系统推送或实时通道，用户重试时重新拉取 bootstrap 权威状态。

完整边界见 [App Core-1 运行策略、帮助与系统状态跨仓开发基线](./APP_CORE_1_RUNTIME_SUPPORT_SYSTEM_INTEGRATION.md)。

### 1.18 Account/Settings-2 局部冻结记录

Account/Settings-2 以兼容新增方式把累计契约提升为 `1.20.0`：

- bootstrap `auth` 新增 `accountProfileEnabled`、`initialPreferencesEnabled`，`messaging` 新增 `conversationSettingsEnabled`；三者由独立环境开关与底层能力共同决定，默认均为 `false`。
- `GET/PUT /api/v2/me/account-profile` 提供观看者私有昵称、受控头像样式、脱敏登录标识和乐观版本；修改要求当前密码二次验证。
- `GET/PUT /api/v2/conversations/{conversationId}/settings` 提供本人单会话免打扰、关闭锁定原因与乐观版本。
- 免打扰只影响之后尚未投递的消息类站内通知；不改变消息事实、已读状态、接收主体或历史通知。
- API 不返回公开真人 ID、真人认证状态、上传头像 URL、完整邮箱、密码、内部账号主键或运营处理信息。

完整边界与 Figma 节点映射见 [Account/Settings-2 账号资料、初始偏好与会话设置跨仓开发基线](./ACCOUNT_SETTINGS_2_FIGMA_CROSS_REPO_INTEGRATION.md)。

### 1.19 Privacy-2A 局部冻结记录

Privacy-2A 以兼容新增方式把累计契约提升为 `1.24.0`，在 Privacy-1 申请控制面上冻结默认关闭的私有导出执行边界：

- bootstrap `dataRights` 新增固定 `downloadTicketHeader=X-Data-Rights-Download-Ticket` 与 `exportFormat=tar`；未知、缺失或矛盾时客户端不得开放下载。
- 申请详情新增可空 `exportArtifact`，只返回制品状态、固定格式/文件名、schema、记录数、长度、manifest SHA-256、生成/到期时间和下载资格，不返回 R2 key、ETag 或内部任务信息。
- `POST /api/v2/me/data-rights/requests/:requestId/download-tickets` 需要当前 Bearer、`export_download` step-up 和 `Idempotency-Key`，签发短期一次性 `drdl_` 票据；明文票据只出现在当前响应。
- `GET /api/v2/me/data-rights/requests/:requestId/download` 通过专用 Header 提交票据，原子消费后流式返回 `application/x-tar`，并固定 `no-store`、Content-Length、附件文件名和 manifest 摘要 Header。
- 服务端下载前重新核验当前 session、账号、申请/制品版本、R2 ETag、长度、manifest/aggregate SHA-256 和到期时间；并发重放、过期、对象不一致或状态变化均 fail closed。
- `0102`、Queue/R2 配置、构建、测试和设备 QA 后置；不可逆注销处理器不在本契约内，继续保持关闭。

完整边界见 [Privacy-2A 私有数据导出制品跨仓交付基线](./PRIVACY_2A_PRIVATE_EXPORT_INTEGRATION.md)。

### 1.20 Message-4 局部冻结记录

Message-4 以兼容新增方式把累计契约提升到 `1.25.0`，实现默认关闭的账号级无正文实时刷新：

- `POST /api/v2/realtime/tickets` 使用当前 Bearer session 签发绑定账号、session、设备的一次性短票据；明文只出现在当前响应。
- `GET /api/v2/realtime/connect` 使用 `Authorization: Realtime <ticket>` 升级 WebSocket；协议固定为 `meigallery.realtime.v1`。
- 事件只包含单调游标、发生时间和六类刷新范围，不含消息/通知正文、账号资料、内部 ID、管理员信息或 Token。
- 一个内部账号对应一个 Hibernation Durable Object；SQLite 只保留有限无正文事件以支持断线重放，D1/HTTP 始终是业务权威。
- KMP 在前台连接、后台停连，按服务端有界区间指数退避；恢复后先按游标补偿并重新读取当前可见 HTTP 资源。
- OQ-028 未关闭，`0105` seed 保持 `unresolved + disabled + production_ready=0`，本阶段不增加 Wrangler binding 或环境配置。

完整边界见 [Message-4 账号级实时刷新跨仓交付基线](./MESSAGE_4_REALTIME_REFRESH_INTEGRATION.md)。

### 1.21 Message-5 数据权利通知行为增量

Message-5 交付时不改变当时累计 App API `1.25.0` 的响应形状，只启用既有受控目标契约：

- `data.export_ready` 仅由 Privacy-2A 用户可见 ready 事实原子写 Outbox；`account.deletion_updated` 仅表示已验证取消且账号访问已经恢复。
- 两者均使用 `targetType=data_task`、`targetId=requestId`、`action=open_data_task`；返回前重验当前数据权利 overview capability 和申请账号归属。
- 注销待处理、执行、失败和完成后的账号不能使用普通通知中心，继续由 Privacy-2B 申请级状态访问承载；通知不得绕过 `deletion_pending` 抑制。
- 固定模板不包含导出内容、R2 引用、下载票据、旧 session 或设备凭证。

完整边界见 [Message-5 数据权利结果通知跨仓交付基线](./MESSAGE_5_DATA_RIGHTS_NOTIFICATION_INTEGRATION.md)。

### 1.21A Message-6 通知偏好策略换绑行为增量

Message-6 交付时不改变当时累计 App API `1.25.0` 的路径或响应 DTO，只保证既有 `policyId + version` 契约在策略切换后仍可执行：

- 账号偏好仍是唯一当前记录；发现其策略落后时保留三个可选布尔值，换绑当前已就绪策略并把版本加一。
- 换绑追加旧策略基线（缺失时）和新策略生效事件，内部事件不伪装成某台设备的用户修改。
- GET、PUT 与通知投递前的可选类别判断复用同一收敛逻辑；重复读取不会继续增加版本。
- 并发旧版本 PUT 继续收到 `VERSION_CONFLICT`，刷新后使用新 `policyId/version` 重试；无法安全收敛时返回可重试不可用，不恢复默认偏好。

完整边界见 [Message-6 通知偏好策略换绑开发基线](./MESSAGE_6_NOTIFICATION_POLICY_REBIND_INTEGRATION.md)。

### 1.21B Message-7 数据导出失败通知行为增量

Message-7 交付时不改变当时累计 App API `1.25.0` 的响应形状，只增加一个由权威失败事实生成的 eventType：

- `data.export_failed` 只有在 export 申请、失败制品、失败任务和系统用户可见 `processing_failed` 事件按版本收敛后写 Outbox。
- 该事件是 `system_security` 必要通知，不受三个可选偏好关闭影响；目标继续为 `data_task + requestId + open_data_task`。
- 固定模板只提示查看权威状态和下一步，不携带 failure code、artifact/R2 引用、查询细节或导出内容。
- 申请已经重试或状态改变时，点击历史通知只展示当前权威页面；目标归属或 capability 失效时动作不可用。

完整边界见 [Message-7 数据导出失败必要通知开发基线](./MESSAGE_7_DATA_EXPORT_FAILURE_NOTIFICATION_INTEGRATION.md)。

### 1.21C Message-8 文本审核行为增量

Message-8 交付时不改变当时累计 App API `1.25.0` 的路径、请求或响应 DTO，只开始执行既有消息状态：

- 未配置审核策略时发送行为保持 `accepted`；显式选中且通过环境/数据库门禁的规则可返回 `review_pending` 或 `rejected`。
- 观看者消息列表保留本人三种审核状态；平台运营与系统消息只有 `accepted/recalled` 才对观看者可见。普通运营工作台同样只读取 `accepted/recalled`，待审正文只能从独立审核案件领取后访问。
- `review_pending/rejected` 只保留内部 sequence，不推进业务活跃时间，也不产生接收方未读、正常 queue flip 或自动分配；最终通过时重排到当前末尾，再按发送方形成接收方交付与队列方向。
- 管理内部接口 `/api/admin/app/message-moderation/cases*` 提供无正文列表、租约、用途化正文访问与独立裁决；不属于 KMP 公共 transport。
- 审核案件可按内部 `cancelled` 终态查询，但该状态只由 Privacy-2B 账号注销执行器写入；它不改变公开消息 DTO，也不产生审核结果通知。
- 召回路径仍是 OQ-033/Figma 阻断的后续契约，本次没有实现或下发 capability。

完整边界见 [Message-8 文本消息审核与结果通知开发基线](./MESSAGE_8_TEXT_MODERATION_INTEGRATION.md)。

### 1.22 Recommendation-2 客户端版本门禁行为增量

Recommendation-2 交付时不改变当时累计 App API `1.25.0` 的响应 DTO，只把既有版本字段收敛为真实服务端门禁：

- `GET /api/v2/app/bootstrap` 使用可选 `X-Client-Version` 计算推荐 capability；缺失或非法时只安全关闭推荐域，不影响其他独立能力。
- `POST /api/v2/discovery/recommendations` 与本人推荐偏好 GET/PUT 要求两段或三段数字 `X-Client-Version`。
- 策略、实际规则和灰度回退均执行最低版本比较；高版本排期不会覆盖旧客户端仍可执行的 active 版本。
- 规则无兼容版本时不放宽公开资格，也不执行不兼容配置；直接请求返回稳定错误，bootstrap capability 保持关闭。

完整边界见 [Recommendation-2 客户端版本门禁与安全回退开发基线](./RECOMMENDATION_2_CLIENT_VERSION_GUARD_INTEGRATION.md)。

### 1.23 Recommendation-3 地区作用域行为增量

Recommendation-3 交付时不改变当时累计 App API `1.25.0` 的请求或响应 DTO，只收敛既有 `regionCode` 与规则 `targetRegionCodes` 的服务端执行语义：

- `targetRegionCodes=[]` 表示全局规则；非空数组只匹配明确地区，请求不带 `regionCode` 时只允许全局规则。
- scheduled、active 和显式历史回退均在选中前同时校验地区和客户端版本；非目标地区不会执行错误规则。
- 到点排期不覆盖当前地区时可继续使用兼容 active；灰度或版本降级命中回退时会再次校验地区范围。
- 地区规则启用时必须登记覆盖目标范围的回退；全局目标不能使用地区子集作为回退。非法范围或无安全规则时返回明确未就绪/维护错误，不放宽公开资格。

完整边界见 [Recommendation-3 地区作用域选择与安全回退开发基线](./RECOMMENDATION_3_REGION_SCOPE_AND_FALLBACK_INTEGRATION.md)。

### 1.24 Recommendation-4 可执行规则选择行为增量

Recommendation-4 交付时不改变当时累计 App API `1.25.0` 的 DTO，只让既有 capability、模式和 fallback 字段反映完整运行真值：

- scheduled、active 与显式历史回退按优先级逐条校验权重、理由、App 渠道、taxonomy/heatVersion 和 production-ready 依赖。
- 高优先候选不可执行时继续尝试下一条完整版本；全部不可用时返回明确未就绪/维护状态。
- 个性化规则选择绑定账号当前偏好的不可变 taxonomy 目录；`auto` 没有同目录安全规则时返回既有 `PERSONALIZATION_NOT_READY` 并执行非个性化。
- bootstrap 的推荐 capability 和 `activeRuleVersionId` 会再次执行完整规则校验，不能只凭数据库状态宣称可用。

完整边界见 [Recommendation-4 可执行规则选择与依赖降级开发基线](./RECOMMENDATION_4_EXECUTABLE_RULE_SELECTION_INTEGRATION.md)。

### 1.25 Recommendation-5 灰度守护与自动停止行为增量

Recommendation-5 交付时不改变当时累计 App API `1.25.0` 的公开 DTO，只增加过渡管理员控制面和推荐规则内部执行门禁：

- `rolloutPercent=1..99` 必须绑定 approved 守护策略；来源、保留、purge 或 production-ready 任一门禁缺失时目标规则不可执行。
- 评估只接受 `aggregate:recommendation:` 内部快照引用、SHA-256、时间窗、样本量和登记指标的整数聚合值，不接收账号、会话、真人资料或逐用户样本。
- 低样本保持 observing；批准来源缺少必需指标立即 `source_incomplete`，停止级反指标达到连续次数后为 `breached`。
- 停止结果追加不可变 block，不伪造规则 paused 状态；运行时排除 blocked 版本并只使用已登记、完整投放且仍兼容的回退。
- `/api/admin/app/recommendations/guardrails*` 提供策略创建/复核/退休、聚合评估与详情；创建/评估幂等、策略复核职责分离、所有写操作审计。

完整边界见 [Recommendation-5 灰度目标、反指标与自动停止开发基线](./RECOMMENDATION_5_GUARDRAIL_AND_AUTOMATIC_STOP_INTEGRATION.md)。

### 1.26 Recommendation-6 推荐解释证据生命周期增量

Recommendation-6 交付时不改变当时累计 App API `1.25.0` 的公开或管理员 DTO，只补齐内部物理生命周期：

- 已批准保留期和 purge 门禁完整时，既有 15 分钟调度按 `expires_at` 有界删除推荐会话并级联条目；
- 会话与条目在删除前不可原地更新，分页仍可追加唯一条目；
- Privacy-2B 使用与写入一致的账号 HMAC 删除关联会话/条目，并把两类事实纳入注销步骤零残留计数；
- 不新增证据列表、反查、手工删除或保留策略编辑 API，也不把生命周期内部字段暴露给 KMP/Nuxt。

完整边界见 [Recommendation-6 推荐解释证据生命周期开发基线](./RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md)。

### 1.27 Privacy-2C 个人数据副本覆盖增量

Privacy-2C 交付时不改变当时累计 App API `1.25.0`、公开/管理员 DTO、TAR schema、下载 Header 或客户端行为，只扩充服务端私有制品内容：

- 新 artifact 的显式白名单由 35 类追加为 41 类，新增推荐偏好、人物拉黑状态/事件、旧版图库点赞和推荐会话/条目；
- 前 35 类 code 与 ordinal 保持不变，执行器按 artifact 自身 scope 数完成，升级前的 35-scope 任务可继续恢复；
- 推荐证据以与写入一致的账号 HMAC 定位，但 `account_hash`、`context_hash`、密钥与内部映射绝不进入下载内容或 API；
- executor readiness 与开始/分页阶段对稳定签名密钥 fail closed；分类增加不创建新 capability、路由、错误展示状态或 Figma 节点。

完整边界见 [Privacy-2C 个人数据副本覆盖补全开发基线](./PRIVACY_2C_DATA_COPY_COVERAGE_INTEGRATION.md)。

### 1.28 Interaction-4 浏览历史生命周期增量

Interaction-4 交付时不改变当时累计 App API `1.25.0`、浏览历史 DTO、KMP 或可见页面，只补齐内部物理保留义务：

- 环境必须显式配置 Interaction-2 策略 ID，development 默认 ID 不构成删除授权；
- D1 保留决策批准且 purge 开启后，每日任务按行级 `expires_at` 稳定、有界删除并报告积压；
- 收藏/历史 capability、本人记录开关或会员权益后来关闭，不阻止已经批准的到期删除；
- 清理不改变偏好版本、收藏、会员 entitlement，也不产生通知、分析或公共错误状态。

完整边界见 [Interaction-4 浏览历史到期生命周期开发基线](./INTERACTION_4_VIEW_HISTORY_LIFECYCLE_INTEGRATION.md)。

### 1.29 Message-9 站内通知内容生命周期增量

Message-9 交付时不改变当时累计 App API `1.25.0`、通知 DTO、游标、未读计算、KMP 或管理员响应，只补齐内部正文保留义务：

- 策略已批准且保留天数有效时，新通知以原始业务事件 `createdAt` 计算并保存不可变到期边界；公开 DTO 继续使用既有 `expiresAt` 字段。
- 消费时已经超过到期边界的延迟 Outbox 收敛为 `suppressed`，不创建通知正文、不增加未读数，也不发送实时刷新。
- 环境显式选择策略且 `approved + purge_enabled=1` 后，每日任务有界删除到期 explicit 行，并以当前批准窗口兼容清理旧 `expiresAt=null` 行。
- 单条已读事件随对应通知删除；分类全部已读聚合和 Outbox 去重墓碑保留。清理不产生新的用户 API 状态、通知、分析事件或任意管理员删除入口。

完整边界见 [Message-9 站内通知内容生命周期开发基线](./MESSAGE_9_NOTIFICATION_CONTENT_LIFECYCLE_INTEGRATION.md)。

### 1.30 Membership-7 会员生命周期呈现增量

Membership-7 以兼容新增方式把累计 App API 提升到 `1.26.0`，只扩展本人会员快照的用户可见生命周期：

- `lifecycle.state` 固定为 `free|active|expiring_soon|expired|revoked`，并返回服务端使用的即将到期窗口与剩余天数；
- 自然到期或提前撤销时，最近结束记录只进入 `lifecycle.endedGrant`；顶层 `status=free`、`tier=null`、`grant=null`，全部 entitlement 使用安全默认值；
- 有效会员的顶层授权语义不变，KMP 不得根据历史摘要、等级名称或本地时间放行；
- KMP 使用现有 `APP-MBR-02` 正式节点呈现五态，不增加 Page ID 或 Figma 状态。

完整边界见 [Membership-7 会员生命周期呈现跨仓开发基线](./MEMBERSHIP_7_LIFECYCLE_PRESENTATION_INTEGRATION.md)。

## 2. 通用请求

建议请求头：

```text
Authorization: Bearer <session-token>
X-Client-Platform: android | ios | windows | macos | web
X-Client-Version: <semver>
X-Client-Build: <build-number>
X-Contract-Version: <contract-version>
X-Request-Id: <uuid>
Idempotency-Key: <unique-key>（关键写接口）
Accept-Language: zh-CN
```

会话 Token 只代表身份。服务端仍需读取账号状态、设备、角色、资格、会员和风险状态。

## 3. 通用响应与错误

成功：

```json
{
  "data": {},
  "meta": {
    "requestId": "req_xxx",
    "serverTime": "2026-08-02T00:00:00.000Z",
    "apiVersion": "2",
    "contractVersion": "1.26.0"
  }
}
```

失败：

```json
{
  "error": {
    "code": "ENTITLEMENT_REQUIRED",
    "message": "开通心享会员后可创建真人私信",
    "details": {
      "requiredEntitlement": "direct_message.create",
      "operationMode": "platform_managed"
    },
    "retryable": false
  },
  "meta": {
    "requestId": "req_xxx"
  }
}
```

稳定错误码至少包括：

| 错误码 | HTTP | 说明 |
|--------|------|------|
| `AUTH_REQUIRED` | 401 | 未登录或会话失效 |
| `ACCOUNT_RESTRICTED` | 403 | 账号/资格/安全受限 |
| `ENTITLEMENT_REQUIRED` | 403 | 缺少会员权限 |
| `ENTITLEMENT_QUOTA_EXCEEDED` | 429 | 周期额度不足 |
| `PROFILE_NOT_AVAILABLE` | 404/410 | 真人资料未发布、暂停或归档 |
| `INVALID_DISCOVERY_SORT` | 400 | 发现页排序值不受支持 |
| `INVALID_REGION` | 400 | 地区 code 格式不合法 |
| `INVALID_CURSOR` | 400 | 游标损坏或与当前排序、地区、规则版本不匹配 |
| `CONVERSATION_FORBIDDEN` | 403 | 非参与方或已拉黑/关闭 |
| `FEATURE_DISABLED` | 403 | 对应开发能力未由服务端开放 |
| `REPORT_TARGET_NOT_FOUND` | 404 | 举报目标不存在或不属于当前账号范围 |
| `REPORT_RATE_LIMITED` | 429 | 举报提交超过服务端频控 |
| `BLOCK_STATE_CONFLICT` | 409 | 屏蔽状态发生并发变化 |
| `CONVERSATION_CLOSE_CONFLICT` | 409 | 话题关闭发生并发变化 |
| `CONTENT_REVIEW_PENDING` | 202/409 | 内容需审核 |
| `INSUFFICIENT_COINS` | 409 | 金币不足 |
| `PRODUCT_NOT_AVAILABLE` | 409 | 商品下架/地区/版本不可用 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一键对应不同请求 |
| `APP_UPGRADE_REQUIRED` | 426 | 能力需要更高客户端版本 |
| `RATE_LIMITED` | 429 | 频控，返回安全的重试时间 |
| `DATA_RIGHTS_NOT_CONFIGURED` | 503 | 数据权利策略尚未配置 |
| `DATA_RIGHTS_POLICY_NOT_READY` | 503 | 策略未通过生产门禁 |
| `STEP_UP_FAILED` | 401 | 当前密码二次验证失败 |
| `STEP_UP_RATE_LIMITED` | 429 | 二次验证失败次数达到服务端限制 |
| `STEP_UP_REQUIRED` / `STEP_UP_EXPIRED` | 401 | 缺少有效、匹配用途的一次性二次验证凭证 |
| `DATA_RIGHTS_ACCESS_INVALID` | 401 | 申请级状态凭证无效、过期或不匹配 |
| `DELETION_RECOVERY_INVALID` | 401 | 注销成功响应恢复所需的旧会话或原幂等键不匹配 |
| `DELETION_ACKNOWLEDGEMENTS_REQUIRED` | 422 | 注销三项影响确认不完整 |
| `DELETION_SCHEDULE_NOT_CONFIGURED` | 503 | 注销等待规则尚未配置 |
| `VERSION_CONFLICT` | 409 | 数据权利申请版本已变化 |
| `REQUEST_NOT_CANCELLABLE` | 409 | 当前申请状态不允许取消 |
| `DATA_RIGHTS_REQUEST_CONFLICT` | 409 | 已有在途申请或账号状态并发变化 |
| `ACCOUNT_DELETION_ALREADY_PENDING` | 409 | 账号已有注销申请，应使用申请级状态访问 |
| `TAXONOMY_VERSION_CONFLICT` | 409 | 目录或引用版本已变化 |
| `RECOMMENDATION_PERSONALIZATION_UNAVAILABLE` | 403 | 当前政策、本人选择或生效规则不允许个性化 |
| `RECOMMENDATION_PREFERENCE_VERSION_CONFLICT` | 409 | 本人推荐偏好发生并发变化 |
| `RECOMMENDATION_CURSOR_EXPIRED` | 409 | 推荐签名游标到期、被改写或与当前规则/条件不一致 |
| `RECOMMENDATION_RULE_NOT_READY` | 503 | 当前模式没有通过运行门禁的安全规则 |
| `MODERATION_RESTRICTED` | 403 | 账号、内容或会话受安全限制 |
| `MESSAGE_MODERATION_POLICY_UNAVAILABLE` | 503 | 显式文本审核策略不存在、未生效或未通过生产门禁 |
| `MODERATION_CASE_VERSION_CONFLICT` | 409 | 管理员文本审核案件版本或租约已变化 |

错误文案由客户端本地化或服务端文案键渲染，不能暴露内部表名、策略阈值或操作员隐私。

## 4. 分页与缓存

- 列表采用游标分页：`cursor`、`limit`，服务端返回 `nextCursor`。
- Recommendation-1 游标由服务端短期 HMAC 签名并绑定实际规则、模式、地区和偏好摘要；到期、改写或规则切换时返回 `RECOMMENDATION_CURSOR_EXPIRED`，客户端开启新会话。
- 公共投影支持 `ETag`；账号、会员、消息、余额和订单响应禁止共享缓存。
- 时间为 UTC ISO 8601，客户端按地区展示。

## 5. 身份与账号 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/auth/email-challenges` | Auth-1 已实现：统一响应的注册邮箱验证码申请 |
| POST | `/api/v2/auth/register` | Auth-1 已实现：创建观看者账号、同意、设备和 App 会话 |
| POST | `/api/v2/auth/login` | Auth-1 已实现：邮箱密码登录、风险挑战与当前同意校验 |
| POST | `/api/v2/auth/refresh` | Auth-1 已实现：旋转 Access/Refresh Token，检测旧 Refresh Token 重放 |
| POST | `/api/v2/auth/logout` | Auth-1 已实现：撤销当前 App 会话 |
| GET | `/api/v2/me` | Auth-1 已实现：账号、角色、会员摘要和当前设备 |
| PATCH | `/api/v2/me` | 修改仅用于账号识别的昵称、头像等允许字段 |
| GET | `/api/v2/me/devices` | Auth-1 已实现：本人设备和登录状态列表 |
| DELETE | `/api/v2/me/devices/:deviceId` | Auth-1 已实现：幂等远程退出其他设备 |
| GET/PUT | `/api/v2/me/preferences` | 地区、偏好、推荐和隐私设置 |
| GET | `/api/v2/me/blocks` | 本人拉黑名单 |
| GET | `/api/v2/me/data-rights` | Privacy-1：本人策略、治理决策、能力和最近申请 |
| GET | `/api/v2/person-profiles/:profileId/media` | Media-1：当前公开人物图片清单与版本绑定游标 |
| GET | `/api/v2/person-profiles/:profileId/verification` | Media-1：最小公开认证范围与运营主体说明 |
| POST | `/api/v2/person-profiles/:profileId/media/:mediaId/access` | Media-1：签发 5 分钟会话/人物/单图绑定会员凭证 |
| GET | `/api/v2/person-profiles/:profileId/media/:mediaId/content` | Media-1：逐次资格核验后代理 R2 图片字节 |
| GET | `/api/v2/me/account-profile` | Account/Settings-2：本人私有账号资料、受控头像样式和脱敏登录标识 |
| PUT | `/api/v2/me/account-profile` | Account/Settings-2：密码二次验证与乐观版本更新 |
| GET | `/api/v2/conversations/:conversationId/settings` | Account/Settings-2：本人单会话免打扰和关闭锁定状态 |
| PUT | `/api/v2/conversations/:conversationId/settings` | Account/Settings-2：乐观版本更新本人单会话免打扰 |
| POST | `/api/v2/me/data-rights/step-up` | Privacy-1：按固定 purpose 进行密码二次验证 |
| GET | `/api/v2/me/data-rights/requests` | Privacy-1：本人申请游标列表 |
| POST | `/api/v2/me/data-rights/export-requests` | Privacy-1：二次验证后幂等创建导出申请 |
| POST | `/api/v2/me/data-rights/deletion-requests` | Privacy-1：三项确认和二次验证后创建注销申请；原幂等键可窄化恢复丢失响应 |
| GET | `/api/v2/me/data-rights/requests/:requestId` | Privacy-1：本人申请详情和用户可见时间线 |
| POST | `/api/v2/me/data-rights/requests/:requestId/download-tickets` | Privacy-2A：重新验证后幂等签发短期一次性下载票据 |
| GET | `/api/v2/me/data-rights/requests/:requestId/download` | Privacy-2A：专用 Header 原子消费票据并流式返回私有 TAR |
| POST | `/api/v2/me/data-rights/requests/:requestId/cancel` | Privacy-1：二次验证并按版本取消本人申请 |
| GET | `/api/v2/data-rights/requests/:requestId` | Privacy-1：使用 `X-Data-Rights-Token` 读取绑定申请 |
| POST | `/api/v2/data-rights/requests/:requestId/step-up` | Privacy-1：用状态凭证为取消申请重新验证 |
| POST | `/api/v2/data-rights/requests/:requestId/cancel` | Privacy-1：注销退出后以状态凭证取消绑定申请 |

注册响应不得返回 `personId` 或 `profileId`，除非该账号以后通过独立认领流程绑定真人。

Auth-1 当前是默认关闭的开发基线：`APP_AUTH_ENABLED`、注册开关、四类文档版本、四个可阅读正文 URL 和 production Turnstile 必须同时满足，bootstrap 才返回 `auth=true`。`challenge.type=turnstile` 时同时返回固定 `pagePath`/`resultPath`，三类业务动作使用不同 action 且 token 单次使用。本阶段只启用邮箱身份，不写死年龄或地区，不开放手机号/第三方登录。现有 `users` 是唯一账号主体；旧 Web 账号只有在密码校验成功后才生成 App 身份映射，不按邮箱静默合并。

Access Token 为短期不透明凭证，Refresh Token 旋转使用；两者在 D1 只保存 SHA-256 摘要。每次授权校验账号、设备、App session version、状态、有效期和当前文档同意。成功刷新会替换当前 Access/Refresh Token，使旧 Access Token 立即失效；旧 Refresh Token 重放将撤销该会话并写安全事件。客户端必须串行刷新并把两种 Token 仅存入 Keystore/Keychain。

数据权利 JSON 账号路径和申请级路径均强制 `Cache-Control: private, no-store`。`restricted` 账号仍可访问必要 `/me` 与数据权利路径；`deletion_pending` 账号不能继续使用普通会话，只能凭服务端签发且绑定单一申请的 `X-Data-Rights-Token` 使用上表三条申请级路径。该凭证不是身份 Bearer token，不能换取或恢复普通会话。Privacy-2A 下载只接受仍有效的普通 Bearer 与专用 `X-Data-Rights-Download-Ticket`；状态 token 不能下载，下载票据也不能访问 JSON 或其他申请。

Privacy-2A 下载响应固定为 `application/x-tar`、`Cache-Control: private, no-store, max-age=0`、权威 `Content-Length`、安全 `Content-Disposition` 和 `X-Data-Rights-Manifest-SHA256`。票据在 body 流开始前原子消费，网络中断后必须重新验证并签发新票据；客户端不得把票据写入 URL、日志、分析或持久化状态。

请求级状态凭证的有效期从申请截止时间或注销计划执行时间中较晚者起计算策略 TTL，确保等待期不会先耗尽注销后的唯一自助状态窗口；过期后仍 fail-closed，不能由客户端延长。

注销创建响应可能与会话撤销同时发生，客户端必须在发起前把随机幂等标识和当次 Access Token 作为单一待确认操作保存到系统安全区。若响应丢失，只允许携带原 `Idempotency-Key` 和被该注销动作撤销的发起 Access Token 重放既有结果；服务端还会重验发起 session、账号 `deletion_pending` 状态、创建命令和未过期状态凭证。该分支不消费新 step-up、不创建第二个申请，也不能恢复或换取普通会话。成功恢复或确定未创建后，客户端立即清理待确认操作。

## 6. 真人发现 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/app/bootstrap` | M0 已实现：能力与发现配置 |
| GET | `/api/v2/app/support` | App Core-1 已实现：版本化帮助、公开联系方式与法律文档目录 |
| GET | `/api/v2/discovery/feed` | M0 已实现：规则推荐、热门、最新、地区筛选和游标分页；Message-2 登录请求排除本人已屏蔽人物 |
| GET | `/api/v2/discovery/regions` | M0 已实现：当前可用地区目录 |
| GET | `/api/v2/taxonomy/catalog` | Taxonomy-1：默认关闭的不可变稳定分类目录，支持 ETag |
| GET | `/api/v2/discovery/popular` | 后续兼容别名；M0 使用 `feed?sort=popular` |
| GET | `/api/v2/discovery/latest` | 后续兼容别名；M0 使用 `feed?sort=latest` |
| GET | `/api/v2/discovery/categories` | 不再单独实现；客户端统一读取 `/taxonomy/catalog` |
| POST | `/api/v2/person-profiles/search` | Search-1/2：登录后按公开文本和可选稳定 taxonomy 条件搜索，正文传输并使用条件绑定游标 |
| POST | `/api/v2/person-profiles/search/preview` | Search-2：解析目录/权限并仅在可执行时返回结果数快照 |
| GET | `/api/v2/person-profiles/:profileId` | M0 已实现：公开基础详情投影 |
| POST | `/api/v2/person-profiles/:profileId/media-access` | 待媒体授权契约冻结后实现 |

推荐项关键字段：

```json
{
  "profileId": "pp_xxx",
  "personId": "per_xxx",
  "displayName": "示例展示名",
  "verification": {
    "status": "verified",
    "label": "真人资料已认证"
  },
  "operation": {
    "mode": "platform_managed",
    "label": "消息由平台运营接收"
  },
  "region": { "code": "cn-bj", "label": "北京市", "precision": "city" },
  "tags": [],
  "taxonomyTerms": [
    {
      "termId": "txt_style_fresh",
      "type": "style",
      "displayName": "清新",
      "catalogVersionId": "txc_catalog_1_0_1",
      "termVersion": 2
    }
  ],
  "recommendation": {
    "mode": "rule_based",
    "reasonCode": "PREFERRED_STYLE",
    "ruleVersion": "discovery_v1"
  }
}
```

公开 API 只读取 `verified + published + authorization active/started/unexpired + verification unexpired + visible` 且来源图库仍发布的投影。客户端不得依赖字段缺失自行判断状态；现有图库没有管理员明确创建的合格投影时，列表必须为空。

## 7. 单向互动 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/person-profiles/:profileId/interactions` | Interaction-1：本人喜欢/关注权威状态 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/like` | 喜欢/取消喜欢 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/follow` | 关注/取消关注 |
| GET/PUT/DELETE | `/api/v2/person-profiles/:profileId/favorite` | Interaction-2：收藏状态、加入默认收藏、取消全部收藏 |
| POST | `/api/v2/person-profiles/:profileId/view-history` | Interaction-2：详情成功呈现后的版本化有效浏览记录 |
| GET | `/api/v2/me/likes` | 喜欢列表 |
| GET | `/api/v2/me/follows` | Interaction-1：本人已关注关系列表 |
| GET | `/api/v2/me/follow-updates` | Interaction-3：关注建立后的已审核公开发布更新流 |
| GET | `/api/v2/me/favorites` | Interaction-2：收藏去重聚合列表；支持 `query/region/styleTerm` |
| GET | `/api/v2/me/favorite-folders` | Interaction-2：收藏夹、去重总数、四图预览与当前额度 |
| PUT/PATCH/DELETE | `/api/v2/me/favorite-folders/:folderId` | Interaction-2：幂等创建、条件编辑或删除自定义收藏夹 |
| GET | `/api/v2/me/favorite-folders/:folderId/items` | Interaction-2：指定收藏夹分页与账号私有单选筛选 |
| PUT/DELETE | `/api/v2/me/favorite-folders/:folderId/items/:profileId` | Interaction-2：加入或移出指定收藏夹 |
| GET/PUT | `/api/v2/me/view-history/settings` | Interaction-2：记录开关、版本与当前保留权益 |
| GET | `/api/v2/me/view-history` | Interaction-2：未到期历史分页 |
| POST | `/api/v2/me/view-history/clear` | Interaction-2：版本化全部清除，可同时关闭记录 |
| DELETE | `/api/v2/me/view-history/:profileId` | Interaction-2：幂等删除单条历史并返回新设置版本 |
| GET/PUT | `/api/v2/me/search-history/settings` | Search-1：默认关闭的独立记录开关与乐观版本 |
| GET/POST | `/api/v2/me/search-history` | Search-1：本人未到期历史分页/显式幂等记录 |
| POST | `/api/v2/me/search-history/clear` | Search-1：版本化全部清除，可同时关闭记录 |
| DELETE | `/api/v2/me/search-history/:historyId` | Search-1：幂等删除单条并提升设置版本 |
| GET | `/api/v2/me/search-filter-capabilities` | Search-2：本人筛选档位、保存额度和 taxonomy 类型分层 |
| GET/POST | `/api/v2/me/saved-filters` | Search-2：本人保存条件列表与幂等创建 |
| GET/PATCH/DELETE | `/api/v2/me/saved-filters/:filterId` | Search-2：本人单项读取、乐观修改和内容清理式删除 |

Interaction-1 契约版本为 `1.3.0`，只实现状态查询、喜欢/关注写入和本人喜欢/关注列表。新增关系必须重新校验资料当前公开资格；取消关系不依赖资料仍公开。列表中失效资料只返回 `profileId`、关系时间和 `PROFILE_NOT_AVAILABLE`，不返回历史公开内容。

Interaction-2 能力引入版本为 `1.11.0`，已实现独立多文件夹收藏和默认关闭、版本化清除的浏览历史服务端契约。Interaction-3 契约版本为 `1.12.0`，已实现复用发布审核事实的关注更新流与去重站内通知投影；它不创建目标侧关注者通知。Search-1 契约版本为 `1.13.0`，已实现公开字段人物搜索和独立私有搜索历史。Taxonomy-1 把累计契约提升为 `1.14.0`；Search-2 提升为 `1.15.0`；Recommendation-1 提升到 `1.16.0`；Privacy-1 提升到 `1.17.0`；Media-1 提升到 `1.18.0`；App Core-1 提升到 `1.19.0`；Account/Settings-2 提升到 `1.20.0`；`1.21.0` 补齐收藏夹 Figma-first 列表语义，Account/Settings-3 到 `1.23.0`，Privacy-2A 到 `1.24.0`，Message-4 到 `1.25.0`，Membership-7 后仓库当前累计为 `1.26.0`。其他互动推荐信号仍后置。所有互动接口不返回 reciprocal/matched 等字段，也不创建匹配或普通用户会话。

## 8. 会员和目录 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/membership/catalog` | Membership-1 已实现：五级开发目录、获取方式与 typed entitlement |
| GET | `/api/v2/me/entitlements` | Membership-1/7 已实现：当前 App grant、等级、有效区间、已解析权益与不参与授权的生命周期呈现 |
| GET | `/api/v2/me/membership` | 后续：独立会员时间线；当前 `/me/entitlements` 已返回当前 grant 摘要 |
| POST | `/api/v2/orders` | 未来：创建购买意图 |
| POST | `/api/v2/orders/verify` | 未来：提交商店交易供服务端验证 |
| POST | `/api/v2/orders/restore` | 未来：恢复购买 |
| GET | `/api/v2/me/orders` | 未来：订单列表 |
| GET | `/api/v2/me/orders/:orderId` | 未来：订单详情 |

Membership-1 原始目录 `amc_app_1_0_draft_1` 的七项权益全部为 `planned` 且 `executable=false`。Message-1 新建独立 `development` 目录，只把创建、发送和每日新话题额度三项改为 `available`，其余权益继续为 `planned`；Message-2 再复制为独立开发目录以冻结安全运营切片，但当前环境仍不切换目录。客户端目录快照只用于展示，受限 API 每次仍由服务端重验当前 grant、稳定 entitlement key、有效期和额度。等级中文名不参与授权，App 1.0 当前不部署订单写路由或购买 capability。

## 9. 会话与消息 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/conversations` | Message-1 已实现：按真人资料幂等创建/复用平台话题并原子消耗额度 |
| GET | `/api/v2/conversations` | Message-1 已实现：当前账号会话列表 |
| GET | `/api/v2/conversations/:id` | Message-1 已实现：会话、接收主体和当前可发送状态 |
| GET | `/api/v2/conversations/:id/messages` | Message-1 已实现：按 sequence 正序补拉消息 |
| POST | `/api/v2/conversations/:id/messages` | Message-1 已实现：幂等发送观看者文本并校验 `direct_message.send` |
| POST | `/api/v2/conversations/:id/read` | Message-1 已实现：单调推进观看者已读 sequence |
| POST | `/api/v2/conversations/:id/messages/:sequence/recall` | 后续：在服务端返回窗口内撤回本人消息；幂等 |
| POST | `/api/v2/conversations/:id/mute` | 后续：静音/取消静音 |
| POST | `/api/v2/conversations/:id/close` | Message-2 已实现：幂等关闭本人话题，历史只读且不可重开 |
| POST | `/api/v2/conversations/:id/handover-consent` | 未来：历史交接选择 |

Message-8 复用 `POST .../messages` 的既有成功响应表达 `review_pending/rejected`，不新增公开路径。审核中或拒绝消息仍占用内部 sequence，客户端按服务端状态渲染；人工通过时服务端会把消息重排到当前末尾，以保证接收方分页和已读水位能够观察到迟到交付。发送者刷新后以稳定 `messageId` 合并最终 sequence/status。客户端不能因为补拉出现 sequence 间隙而把隐藏的运营待审消息推断为存在或已送达；会话摘要和游标也只使用当前主体可见消息投影。召回接口仍未实现。

创建请求：

```json
{
  "profileId": "pp_xxx",
  "disclosureVersion": "managed_message_1"
}
```

Message-1 的用户消息只接受 `contentType=text`，普通 Unicode 表情可作为文本内容；`system` 只能由服务端生成。图片、语音、视频、文件和位置消息没有可执行入口，未来必须同时满足独立产品评审、服务端 capability 与最低客户端版本后才能接收。

创建响应必须包含：

```json
{
  "conversationId": "cv_xxx",
  "operationMode": "platform_managed",
  "receiverLabel": "平台运营接收",
  "disclosureVersion": "managed_message_1",
  "quota": { "remaining": 2, "resetsAt": "2026-07-21T00:00:00Z" }
}
```

## 10. 实时通道

连接过程：`POST /api/v2/realtime/tickets` 获取绑定账号、session 和设备的一次性短票据 → 使用 `Authorization: Realtime <ticket>` 连接账号级 Durable Object → `client.hello` 携带最后确认游标 → 服务端补发缺失刷新提示或要求 HTTP 全量同步。

Message-4 冻结的刷新事件：

```json
{
  "type": "refresh.required",
  "schemaVersion": 1,
  "eventId": "rte_xxx",
  "cursor": 42,
  "occurredAt": "2026-08-20T12:00:00.000Z",
  "scopes": ["conversations", "messages"]
}
```

当前只允许 `account|conversations|messages|notifications|membership|wallet`。服务端不通过 WebSocket发送业务对象或写命令；客户端收到提示后必须调用既有 Bearer HTTP API。`server.ready`、`refresh.required`、`server.synced` 和唯一客户端命令 `client.hello` 均要求精确字段集合与 `schemaVersion=1`。

不发送 `message.created` 正文事件，不为平台代运营会话发送 `person.typing`、`person.online` 或 `person.read`，也不发送真人位置或推断状态。未来完整消息事件传输仍受 OQ-028、保留治理、审核链路和独立契约版本约束，不能从当前刷新通道扩权。

## 11. 站内通知 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/notifications` | 按消息、互动、会员/金币、系统/安全分类分页查询 |
| GET | `/api/v2/notifications/:id` | 通知安全详情和当前目标可用状态 |
| GET | `/api/v2/notifications/unread-counts` | 各分类未读数 |
| POST | `/api/v2/notifications/:id/read` | 标记单条已读，幂等 |
| POST | `/api/v2/notifications/read-all` | 按分类标记全部已读，幂等 |
| GET/PUT | `/api/v2/me/notification-preferences` | 站内通知偏好；账号/安全/会员/金币/数据权利必要通知不可关闭 |

Message-3 的通知权威仍通过 HTTP 拉取，不依赖 APNs、FCM 或其他系统推送；Message-4 在全部门禁通过后只能发送刷新提示，不能替代 HTTP 权威列表。通知 action 使用受控 `targetType + targetId + action`，打开时重新校验目标和客户端 capability；Message-5 已让既有 `data_task + open_data_task` 对导出就绪与注销取消恢复结果可用，Message-7 以同一目标补齐导出失败必要通知，不可逆注销期间仍禁止普通通知访问。Message-6 保证策略版本切换时保留账号可选偏好并返回单调的新版本，不改变必要通知规则。Message-8 增加审核通过/拒绝的可选消息通知和管理员会话限制的必要安全通知；待审平台回复只有最终通过后才产生平台回复事件。任何通知或刷新提示都不得携带完整平台话题正文、导出内容或访问凭证。

## 12. 钱包、礼物与装扮 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/me/wallet` | 余额和最后同步时间 |
| GET | `/api/v2/me/wallet/entries` | 金币明细 |
| GET | `/api/v2/me/wallet/entries/:entryId` | 用户可见原因、业务单安全引用和关联冲正 |
| GET | `/api/v2/catalog/coin-packs` | 未来：金币包 |
| GET | `/api/v2/catalog/gifts` | 未来：礼物目录 |
| POST | `/api/v2/gifts` | 未来：赠礼并原子扣币；强制幂等 |
| GET | `/api/v2/me/gifts` | 未来：赠礼历史 |
| GET | `/api/v2/catalog/cosmetics` | 未来：装扮目录 |
| GET | `/api/v2/me/cosmetics` | 未来：库存和装备状态 |
| POST | `/api/v2/cosmetics/:productId/purchase` | 未来：金币购买 |
| PUT/DELETE | `/api/v2/me/cosmetics/:inventoryId/equip` | 未来：装备/卸下 |

Wallet-1 当前实现的用户路由只读，余额来自追加式分录/受控快照，客户端不得先行加减。读取空钱包只返回虚拟零余额，不创建业务记录；明细只使用固定原因和用户安全业务引用。赠礼等未来写路由只有独立 Feature 上线后才部署；启用时返回订单/业务记录、钱包分录和权威余额。

## 13. 举报、拉黑与支持 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/person-profiles/:profileId/safety` | Message-2：本人对人物的权威屏蔽状态 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/block` | Message-2：幂等屏蔽/解除屏蔽并执行服务端联动 |
| GET | `/api/v2/me/blocks` | Message-2：本人当前屏蔽人物游标分页 |
| POST | `/api/v2/reports` | Message-2：幂等举报真人、媒体、本人会话或本人消息 |
| GET | `/api/v2/me/reports` | Message-2：本人举报状态游标分页 |
| GET | `/api/v2/me/reports/:reportId` | Message-2：举报必要详情与用户可见时间线 |
| POST | `/api/v2/appeals` | Safety-2：幂等申请本人未发现违规举报结论的独立复核 |
| GET | `/api/v2/me/appeals` | Safety-2：本人复核申请游标分页 |
| GET | `/api/v2/me/appeals/:appealId` | Safety-2：本人复核详情与用户可见时间线 |
| GET | `/api/v2/help/topics` | 后续：帮助与政策 |

拉黑后由服务端清理喜欢/关注、关闭关联话题、禁止后续互动/建话题/发送，并在登录发现页停止推荐目标；解除拉黑不恢复旧关系或旧话题。举报说明最多 500 字，原因来自版本化目录；客户端不能提交证据正文，服务端只固定目标版本、目标消息摘要及相邻引用。申诉只接受文本说明，不开放证据上传，申请本身不自动改变原结论。所有入口要求有效 Auth-1，但举报和申诉不要求会员。

## 14. 管理 API

管理路由使用 `/api/v2/admin`，强认证、RBAC、对象范围和审计必需。

M1 过渡实现复用现有 Nuxt 后台 `/api/admin/app/persons`：列表/详情/创建/草稿更新，以及 `/authorization`、`/verification/submit`、`/verification/decision`、`/publication/submit`、`/publication/decision`、`/publication/pause` 和授权/认证撤销命令。Membership-1/2/3/4 同样暂时复用 `/api/admin/app/memberships`，提供版本化目录与 Entitlement 管理、账号状态、会员申请、单账号变更预览、独立复核申请/队列/决定，以及策略允许时的低风险直达发放或撤销。Message-2 暂时复用 `/api/admin/app/conversations` 的限时领取/续租/释放/正文/回复/关闭和 `/api/admin/app/safety` 的举报领取、最小证据、结论及 Owner 运行控制；Message-8 另以 `/api/admin/app/message-moderation` 提供无正文审核队列、领取、受控正文和独立裁决，但在正式后台 Figma 前不新增页面。Safety-2/3 在同一 safety 路由下增加统一申诉队列、领取、受控详情和结论。Wallet-1 暂时使用 `/api/admin/app/wallets` 提供账号确认、单笔预览/申请、独立批准/拒绝和完整冲正，不提供直接改余额或复核绕过；Wallet-2 另提供受控批量调币与对账，Wallet-3 增加 Owner 恢复预览和幂等快照重建/解冻，Wallet-4 在同一路由增加无 UI 的外部旧余额 Dry-run、逐项 Owner 复核与默认关闭执行。Wallet-4 只接受 `opaque:` 来源账号引用；冻结申请后目标事实变化时先拒绝申请再收敛 `stale`，已完成执行请求在门禁关闭后仍只读重放原结果。Recommendation-1/5 暂时使用 `/api/admin/app/recommendations` 提供规则、Dry-run、复核、排期、暂停/回滚、固定披露精选，以及无正式 UI 的守护策略与聚合评估接口。Privacy-1/2A 暂时使用 `/api/admin/app/data-rights` 提供最小化总览、申请队列/详情及 Owner 领取、开始处理、失败、重试和凭证据取消；导出 ready 只能由 Queue/R2 完整性事实推进，且不可逆删除仍不提供完成动作。过渡路由只供 admin+ Web 会话使用，全部写命令与敏感读取均审计；下表 `/api/v2/admin` 仍表示长期统一目标。

`ADM-PER-04` 当前开发实现复用 `/api/admin/import-jobs`：`POST /:id/package/init` 建立私有 R2 multipart，`PUT /:id/package/parts/:partNumber` 按一次性会话上传固定分片，`POST /:id/package/complete` 使用服务端 ETag 清单合并，`POST /:id/process|retry|resume` 驱动 Queue 状态机，`GET /:id/errors` 代理错误报告。Admin 只能操作本人任务，Owner 可跨任务；响应不返回 R2 key、R2 uploadId、分片 ETag 或 manifest 原始快照。该 ZIP 契约只创建 Gallery，不自动创建 Person/Profile 或公开推荐资格。

| 资源 | 主要能力 |
|------|----------|
| `/persons`, `/person-profiles` | 创建、编辑、来源、授权和状态 |
| `/verifications`, `/publications` | 认证、发布、暂停、归档 |
| `/imports` | MeiGallery/批量导入任务 |
| `/taxonomy`, `/taxonomy-catalogs` | 标签/地区/分类、alias、映射、合并和版本发布 |
| `/recommendation-rules`, `/editorial-placements` | 规则版本、dry-run、精选、灰度、暂停和回滚 |
| `/recommendation-guardrails` | 目标/反指标策略、独立复核、聚合评估和不可变停止事实 |
| `/operation-assignments` | 真人运营模式和管理员组 |
| `/managed-conversations`, `/conversation-assignments` | 队列、租约分配、平台回复、内部备注和安全升级 |
| `/reviews`, `/reports`, `/appeals` | 举报案件、最小证据、审核、安全处置和申诉 |
| `/membership-catalogs`, `/entitlement-definitions`, `/membership-grants` | 1.0 五级目录、typed entitlement、预览、手动发放/续期/替换/撤销、复核和有效期 |
| `/products` | 未来：价格和商品版本 |
| `/coin-adjustments`, `/coin-adjustment-batches` | 加币、扣币、补偿、批量逐项结果、复核和冲正 |
| `/orders`, `/reconciliation` | 未来：订单、退款和对账 |
| `/claims`, `/handovers` | 未来：真人认领和交接 |
| `/operation-dashboards`, `/operational-incidents` | 聚合指标、数据新鲜度、异常认领和受控安全开关 |
| `/audit-events`, `/audit-exports`, `/audit-registry` | 只读审计查询、完整性状态、受控短期导出和 Owner Action 口径治理 |
| `/data-rights` | 数据导出/注销申请队列、策略快照、领取、处理、失败重试、取消和未来完成证据 |

管理员消息接口必须由服务端写入 `senderType=platform_operator`；客户端不能传入 `person` 冒充真人。会员发放、调币和审计导出均使用独立申请/批准/执行状态，批准不等于已经生效；任何余额变化只能产生新钱包分录。

## 15. 幂等与并发

- `Idempotency-Key` 与账号、路由和规范化请求哈希绑定。
- 同键同请求返回首个权威结果；同键不同请求返回 `IDEMPOTENCY_CONFLICT`。
- 创建会话按观看者 + 真人建立唯一有效关系。
- 消息按会话 + clientMessageId 唯一。
- 外部交易 ID、钱包业务单号、礼物业务单号和调币申请唯一。
- 状态更新使用版本号/ETag 防止管理员并发覆盖。

## 16. 契约与安全测试

- OpenAPI lint、破坏性变更检测和 Kotlin/TypeScript 生成代码编译。
- 对象权限矩阵覆盖本人、其他观看者、未认领/已认领真人、代运营、审核、财务和越权 ID。
- 幂等、乱序、重复回调、断线补拉、DO 休眠和多设备已读测试。
- 资料暂停、会员到期、拉黑和运营模式切换的实时撤权测试。
- 个性化关闭、历史清除、taxonomy 合并、规则回滚和数据导出/注销的跨设备一致性测试。
- 举报证据最小化、审核越权、拉黑联动、申诉改判和高危 fail-closed 测试。
- 日志/分析事件扫描私信、证件、凭证和令牌泄漏。

## 17. 契约验收

- **API-AC-001**：公开接口无法返回未认证或未发布真人。
- **API-AC-002**：普通账号响应不包含自动生成的公开资料。
- **API-AC-003**：无 entitlement 创建私信返回明确错误且不消耗额度。
- **API-AC-004**：平台运营消息不能伪装为 `senderType=person`。
- **API-AC-005**：App 1.0 重复会员发放、消息和调币请求不产生重复结果；订单和礼物在未来启用时遵循同一规则。
- **API-AC-006**：实时连接从不授予业务写权限；资料暂停、会员到期或拉黑后，后续 HTTP 写请求仍必须立即被权威校验拒绝。
- **API-AC-007**：未知 schema 字段不会使旧客户端扩大权限或崩溃。
- **API-AC-008**：管理写接口均能关联完整审计事件。
