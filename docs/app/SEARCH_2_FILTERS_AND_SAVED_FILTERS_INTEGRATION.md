# Search-2 结构化筛选、结果预估与保存条件开发基线

日期：2026-08-09

状态：服务端开发完成，所有现有环境默认关闭；配置、migration 执行、专项测试、KMP 页面与远端联调统一后置

## 1. 本阶段目标

Search-2 在 Search-1 隐私搜索和 Taxonomy-1 稳定目录之上完成以下闭环：

1. 使用稳定 `termId + catalogVersionId` 表达人物结构化筛选，不依赖会变化的中文名称或 legacy slug。
2. 按会员 entitlement 控制高级筛选类型；服务端拒绝越权条件，不能静默忽略后返回扩大后的结果。
3. 在用户应用条件前解析目录变化并返回当前结果数；条件失效或会员不足时不计算结果。
4. 提供账号私有保存条件的创建、列表、详情、修改和删除；只保存结构化条件，不保存自由搜索词。
5. 保留 App 1.0 前向兼容能力：新 taxonomy 类型、目录版本和 entitlement 通过服务端 capability/目录驱动，不要求把展示名称硬编码进客户端。

本阶段不实现热门词、联想词、个性化推荐信号、在线支付、系统推送、实时搜索、KMP 页面或后台可视化策略编辑。

## 2. 已冻结产品规则

### 2.1 筛选类型与会员档位

| 筛选范围 | taxonomy 类型 | 使用条件 |
|---|---|---|
| 基础筛选 | `region_scope`、`region_group`、`city_country`、`content_type` | 所有已登录观看者 |
| 基础高级筛选 | `style`、`occupation`、`scene` | `discovery.filter.advanced >= basic`，当前从心悦开放 |
| 完整高级筛选 | `identity`、`personality`、`hair`、`clothing` | `discovery.filter.advanced = full`，当前从心知开放 |

当前五级开发目录的 Search-2 权益值：

| 会员 | 高级筛选值 | 保存条件上限 |
|---|---:|---:|
| 心遇 | `none` | 1 |
| 心悦 | `basic` | 3 |
| 心知 | `full` | 6 |
| 心契 | `full` | 12 |
| 心耀 | `full` | 20 |

权限只读取稳定 entitlement：

- `discovery.filter.advanced`：`none | basic | full`
- `discovery.saved_filter.max`：非负整数

等级名称、颜色、文案和 rank 不直接参与筛选授权。`0082` 创建新的不可变开发目录 `amc_app_1_0_search_2_dev_1`，不会修改既有目录，也不会自动切换运行时目录或迁移 grant。

### 2.2 组合语义

- 地区范围、地区组、城市/国家共同组成 `region` 逻辑组。
- 同一逻辑组内多个条件使用 OR。
- 不同逻辑组之间使用 AND。
- 选择父级词条时包含目录中的全部后代。
- 同时选择同组父级和后代时，后代属于冗余条件；服务端返回 `redundantTermIds` 并以父级条件执行。
- merged 旧词条按当前目录重定向到目标稳定 ID；服务端返回 `redirected`，客户端应刷新本地条件显示。
- deprecated、下线、内部、敏感或无法解析的词条为 `invalid`，不能执行搜索。

### 2.3 权限失败原则

- 高级筛选名称和价值说明可以显示。
- 用户可选择受限条件进入权益说明，但服务端返回 `restrictedTermIds`，`canApply=false`。
- 正式搜索遇到受限条件返回 `403 SEARCH_FILTER_ENTITLEMENT_REQUIRED`。
- 结果预估遇到受限或失效条件返回 `resultCount=null`，不能忽略这些条件后计算一个更宽结果集。
- 会员降级不删除保存条件；既有条件仍可查看、重命名和删除。只有当前仍有权使用其中全部条件时才可执行或改写条件。

## 3. API 契约

Search-2 引入契约版本为 `1.15.0`；当前累计 App API v2 契约已由 Recommendation-1 兼容提升为 `1.16.0`。

### 3.1 Bootstrap

`GET /api/v2/app/bootstrap` 新增：

```json
{
  "capabilities": {
    "search": {
      "profiles": false,
      "history": false,
      "filters": false,
      "savedFilters": false
    }
  },
  "search": {
    "maxFilterTerms": 12,
    "maxSavedFilterNameLength": 40,
    "advancedFilterEntitlement": "discovery.filter.advanced",
    "savedFilterMaxEntitlement": "discovery.saved_filter.max"
  }
}
```

`filters` 必须同时满足 Auth、Search-2 策略和当前 taxonomy 目录就绪；`savedFilters` 使用独立策略位。当前未配置 Search-2 策略和目录，因此现有环境继续返回 `false`。

### 3.2 获取本人筛选能力

```http
GET /api/v2/me/search-filter-capabilities
Authorization: Bearer <access-token>
```

返回当前搜索策略、目录版本、类型分层、本人 `advancedTier`、保存条件上限和已用数量。客户端不得从会员展示名或 rank 自行推导这些值。

### 3.3 搜索

```http
POST /api/v2/person-profiles/search
Authorization: Bearer <access-token>
Content-Type: application/json
```

请求至少包含 `query` 或 `filters`：

```json
{
  "query": "杭州",
  "filters": {
    "catalogVersionId": "txc_app_1_0_taxonomy_1_dev_1",
    "termIds": ["txt_region_hangzhou", "txt_style_natural"]
  },
  "sort": "relevance",
  "limit": 20,
  "cursor": null
}
```

规则：

- 只有 `query` 时保持 Search-1 行为，默认 `relevance`。
- 只有 `filters` 时默认 `popular`，不允许显式使用 `relevance`。
- 同时提供时先执行公开文本命中，再执行全部结构化逻辑组。
- 游标内部版本提升为 v2，绑定账号公开作用域、搜索词哈希、筛选哈希和排序；不包含原始搜索词或展示名称。
- Search-1 的认证、发布、用途授权、有效期、可见性、来源图库发布和本人屏蔽过滤全部继续生效。

### 3.4 条件解析与结果预估

```http
POST /api/v2/person-profiles/search/preview
Authorization: Bearer <access-token>
Content-Type: application/json
```

请求必须包含 `filters`，可以附带 `query` 和 `sort`，不接受分页字段。响应包含：

- 来源目录与当前目录；
- 每个来源词条的 `active | redirected | invalid` 状态；
- 当前 canonical `termIds` 和逻辑分组；
- `invalidTermIds`、`restrictedTermIds`、`redundantTermIds`；
- 当前高级筛选 entitlement；
- `canApply`；
- 可执行时的 `resultCount` 和 `snapshot_exact`，不可执行时为 `null / not_calculated`。

结果数是请求时刻公开投影的精确快照，不是库存承诺；人物资格或发布状态变化后，正式搜索结果可以不同。

### 3.5 保存条件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/me/saved-filters` | 获取本人全部有效保存条件和当前额度 |
| POST | `/api/v2/me/saved-filters` | 幂等创建，要求 `Idempotency-Key` |
| GET | `/api/v2/me/saved-filters/:filterId` | 获取本人单个条件 |
| PATCH | `/api/v2/me/saved-filters/:filterId` | 使用 `expectedVersion` 修改名称、条件或默认排序 |
| DELETE | `/api/v2/me/saved-filters/:filterId?expectedVersion=...` | 乐观并发软删除并清除词条内容 |

创建正文：

```json
{
  "name": "杭州 · 自然生活",
  "filters": {
    "catalogVersionId": "txc_app_1_0_taxonomy_1_dev_1",
    "termIds": ["txt_region_hangzhou", "txt_style_natural"]
  },
  "defaultSort": "popular"
}
```

保存条件不接受 `query`，避免把可能敏感的自由文本长期持久化。名称执行 NFKC、空白折叠、控制字符过滤和账号内不区分大小写去重。

## 4. 数据模型

`0082_app_search_filters_and_saved_filters.sql` 新增或扩展：

| 对象 | 责任 | 关键约束 |
|---|---|---|
| `app_person_search_policies` 新列 | Search-2 版本化运行门禁与上限 | 结构化筛选、预估、保存条件独立开关；最多 12 个条件、名称最多 40 字 |
| `app_taxonomy_catalog_closure` | 当前目录父子与 merged 重定向闭包 | `catalog + ancestor + descendant` 唯一；父级筛选匹配后代和仍引用合并源 ID 的公开投影 |
| `app_saved_person_filters` | 账号私有保存条件 | 账号作用域稳定 ID、幂等键摘要、请求摘要、乐观 version、同名唯一、软删除清空词条 |
| `amc_app_1_0_search_2_dev_1` | Search-2 不可变会员目录 | 复制既有五级展示和非搜索权益，只用 canonical key 提供可执行筛选权益；不自动启用 |

`filter_id` 由账号公开作用域和客户端幂等键的 SHA-256 确定生成；D1 不保存幂等键原文。创建使用条件 INSERT 原子检查保存数量，避免并发请求突破 entitlement 上限。

删除后保留最小 tombstone 以阻止同一幂等键复活旧逻辑请求，同时把名称替换为固定删除文案、`term_ids_json` 清空为 `[]`。

## 5. 客户端交互规范

### 5.1 筛选页

1. 进入时并行读取 bootstrap、taxonomy catalog 和本人筛选能力。
2. 基础条件正常显示；受限高级条件显示锁定态与所需会员说明，不显示价格或购买按钮。
3. 用户修改条件后做 300–500ms 防抖，再调用 preview；请求期间保留原条件并在主按钮显示“正在计算”。
4. `redirected`：自动替换为目标显示值，并用轻提示说明“分类已更新”。
5. `invalid`：保留可移除错误胶囊，不得自动扩大查询；主按钮禁用。
6. `restricted`：主按钮改为“查看会员权益”，不发正式搜索请求。
7. `redundant`：合并重复范围并提示一次，不作为错误阻断。
8. `resultCount=0`：显示“暂无符合条件的人”，提供放宽条件、清空和查看热门；不得填入未认证资料。
9. 点击应用后才替换搜索页当前条件；preview 失败不改变既有结果。

### 5.2 保存条件页

- 顶部显示“已保存 X / Y”；额度满时隐藏新增主动作，既有卡片仍可管理。
- 卡片显示名称、当前有效条件摘要、默认排序和目录变化状态，不持久化结果数。
- 使用前以卡片返回的当前 canonical 条件再次调用 preview；只有 `canApply=true` 才进入搜索。
- 会员降级导致高级条件受限时，卡片保留并显示“当前等级不可使用”，提供查看权益、编辑为基础条件和删除。
- 重命名、改条件和删除都携带当前 `version`；`409` 时刷新单项并要求用户确认，不覆盖另一设备修改。
- 删除成功立即移除；`deleted=false` 也收敛到已删除终态。

### 5.3 页面状态

每个页面至少实现：加载、正常、空、无结果、离线/可重试、能力关闭、目录更新、条件失效、权益不足、额度满、版本冲突和账号会话失效。

## 6. 主要错误码

| 错误码 | HTTP | 客户端处理 |
|---|---:|---|
| `SEARCH_FILTERS_DISABLED` | 403 | 隐藏筛选入口并刷新 bootstrap |
| `SEARCH_FILTER_CATALOG_CHANGED` | 409 | 刷新目录，保留可解析条件并标记失效项 |
| `SEARCH_FILTER_ENTITLEMENT_REQUIRED` | 403 | 显示会员权益说明，不展示结果 |
| `SEARCH_FILTERS_CONFLICT` | 422 | 保留条件并提示调整 |
| `SAVED_FILTER_ENTITLEMENT_REQUIRED` | 403 | 不创建，显示当前保存权益 |
| `SAVED_FILTER_LIMIT_REACHED` | 403 | 显示额度已满，允许删除既有项 |
| `SAVED_FILTER_NAME_CONFLICT` | 409 | 聚焦名称输入并要求改名 |
| `SAVED_FILTER_VERSION_CONFLICT` | 409 | 刷新单项，禁止静默覆盖 |
| `IDEMPOTENCY_CONFLICT` | 409 | 生成新幂等键前先确认这不是同一请求重试 |
| `IDEMPOTENCY_KEY_RETIRED` | 409 | 已删除逻辑请求不能复活，用户新建时使用新键 |

## 7. 安全与隐私边界

- 正式结果和 preview count 使用相同公开资格、屏蔽和 taxonomy 条件构造器，避免预估泄露已下架人物。
- 高级权限每次请求从服务端会员快照解析；不信任客户端传入等级、rank 或 capability。
- 自由搜索词继续只通过 POST 正文传输，不写入保存条件、游标、审计日志或分析事件。
- 保存条件只能由当前 Bearer 账号访问，请求体不接收账号 ID。
- 列表和详情可以展示条件已失效，但不返回历史人物结果、历史结果数或已删除条件内容。
- taxonomy 展示名只用于 UI；查询和持久化始终使用 stable ID。

## 8. 当前未执行事项

按照当前“完成全部开发后再统一配置与测试”的顺序，本阶段没有执行：

- `0082` migration；
- Wrangler 或环境变量调整；
- Search-2 策略、taxonomy 目录或会员目录切换；
- 既有 grant 迁移或真实保存条件 seed；
- KMP/Nuxt 页面开发；
- migration、D1、API、并发、性能、模拟器或远端专项测试；
- dev/production 部署和远端推送。

因此所有现有环境仍应返回 `search.filters=false`、`search.savedFilters=false`，不能因代码和 OpenAPI 已存在而推断功能已经开放。

## 9. 后续统一配置与验证顺序

1. 先执行 `0081`，导入和审核真实 taxonomy，生成非空目录快照。
2. 执行 `0082`，静态核对 closure、Search-2 策略和新会员目录。
3. 决定 grant/目录迁移策略；不得只切换会员目录导致既有有效 grant 静默失效。
4. 配置 dev Search-2 策略、taxonomy 与会员目录，保持 production 关闭。
5. 完成 D1 migration、权限矩阵、目录重定向、组合语义、并发额度、幂等重放、删除隐私和查询性能专项测试。
6. 完成 KMP 筛选页、保存条件页和端到端交互回归。
7. 关闭真实目录、会员数值、隐私/保留和生产门禁评审后，才允许发布 production 目录并启用 capability。

## 10. 开发验收口径

- 结构化筛选严格执行“组内 OR、组间 AND、父含后代”。
- 受限条件在搜索、预估和保存写入三条路径全部 fail closed。
- 目录合并可重定向，失效项可诊断且不会扩大结果。
- 搜索和预估共享同一公开资格/屏蔽/筛选 SQL 条件。
- 保存条件创建原子受 quota 限制，支持幂等重放和账号内同名保护。
- 修改和删除使用乐观版本；降级保留数据，不恢复已删除 tombstone。
- 共享 TypeScript DTO、OpenAPI、累计产品/技术文档与实现保持一致。
