# Search-1 人物搜索与搜索历史开发基线

App 版本：1.0

App API：v2 / `1.13.0`

日期：2026-08-09

状态：服务端开发完成；默认关闭；高级筛选、配置、migration、客户端与测试后置

## 1. 本阶段目标

完成 App 1.0 搜索页的第一段可落地服务端闭环：

- 已登录观看者可按审核昵称、公开地区和公开标签搜索当前仍可见的人物。
- 支持相关度、热度、最新三种稳定排序及账号绑定游标分页。
- 搜索结果与发现页复用同一公开资格校验，并排除当前账号已屏蔽人物。
- 搜索读取不产生隐式写入；用户主动开启搜索历史后，客户端才显式提交记录命令。
- 搜索历史独立于浏览历史，默认关闭、账号私有，可逐条删除或原子全部清除。
- bootstrap 独立声明 `search.profiles` 和 `search.history`，客户端不得从发现页、登录或浏览历史能力自行推导。

## 2. 本阶段不包含

- 不实现职业、地区层级、风格、身份等结构化组合筛选。
- 不实现高级筛选 entitlement、筛选冲突预估、保存条件或筛选结果数预览。
- 不实现热门搜索词、联想词、拼音分词、模糊纠错、同义词和运营置顶。
- 不把搜索词、点击结果或搜索次数写入分析事件、推荐信号、管理员审计或通用业务日志。
- 不接入外部搜索服务，也不建立需要第二条同步链路的 FTS 人物事实副本。
- 不执行 `0080`，不修改 Wrangler，不启用 development/production capability，不补 KMP 页面和专项测试。

上述高级筛选与保存条件由 Search-2 独立冻结；不得在 Search-1 的自由文本参数中临时塞入未版本化筛选语义。

## 3. 搜索公开边界

### 3.1 可检索字段

| 字段 | Search-1 行为 |
|------|---------------|
| 审核展示昵称 `display_name` | 支持精确、前缀和包含匹配 |
| 公开地区 `region_label / region_code` | 支持地区名称包含和稳定 code 精确匹配 |
| 公开标签 `tags_json` | 只检索公开投影前 8 个、1–40 字的字符串标签 |

绝不检索或返回法定姓名、证件、精确地址、认证证据、用途授权证据、内部备注、草稿字段、审核中字段和受保护媒体。

### 3.2 当前公开资格

搜索结果必须同时满足：

- `verification_status='verified'`；
- `publication_status='published'`；
- `authorization_status='active'`；
- `visibility_status='visible'`；
- 授权已生效且未到期，认证未到期；
- `published_at` 有效且来源图库仍为 `published`；
- 当前观看者没有处于 `blocked` 状态的人物屏蔽关系。

条件在每次分页请求时重新校验。人物下线、授权/认证过期或被当前用户屏蔽后，不依赖客户端缓存隐藏。

### 3.3 排序

| sort | 顺序 |
|------|------|
| `relevance` | 昵称精确 → 昵称前缀 → 昵称包含 → 地区精确 → 标签精确 → 地区包含 → 标签包含，再按热度、发布时间、人物 ID 稳定收敛 |
| `popular` | 当前公开投影 `heat_score DESC`，再按发布时间、人物 ID |
| `latest` | `published_at DESC`，再按人物 ID |

游标只保存账号范围、搜索词 SHA-256、排序、分页分数、发布时间和人物 ID，不保存原始搜索词。跨账号、换词或换排序复用游标返回 `PERSON_SEARCH_CURSOR_INVALID`。

## 4. 隐私传输设计

人物搜索使用：

```http
POST /api/v2/person-profiles/search
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "query": "北京 摄影",
  "sort": "relevance",
  "limit": 20,
  "cursor": null
}
```

使用 POST 是明确的隐私选择：搜索词不进入 URL、代理访问日志或分页游标。服务端仍按只读操作处理，不在该请求内写搜索历史；响应继续 `Cache-Control: no-store`。

搜索词执行 NFKC 规范化、首尾去空白和连续空白折叠，允许 1–50 个 Unicode 字符，拒绝控制字符、零宽格式字符和双向文本控制字符。响应项包含公开人物卡和命中字段：`display_name / region / tag`，不返回内部评分。

## 5. 搜索历史

### 5.1 独立设置

```http
GET /api/v2/me/search-history/settings
PUT /api/v2/me/search-history/settings
```

首次读取返回虚拟设置：

```json
{
  "recordingEnabled": false,
  "version": 1,
  "retentionDays": 90,
  "maxItems": 50,
  "updatedAt": null
}
```

`90` 天只是 development 策略中的防御性技术值，不构成生产保留期承诺。production 搜索可以与搜索历史分开开放；历史还必须满足独立的保留期审批、purge 和 `history_production_ready` 门禁。

设置更新必须携带 `expectedVersion`。关闭记录只阻止未来写入，不暗中删除已有记录；用户可随后选择逐条或全部清除。

### 5.2 显式记录

搜索成功呈现后，且客户端读取到 `recordingEnabled=true` 时，客户端使用独立写命令：

```http
POST /api/v2/me/search-history

{
  "searchId": "srch_<客户端本次搜索随机稳定ID>",
  "query": "北京 摄影",
  "expectedHistoryVersion": 2
}
```

- `searchId` 只用于本次逻辑写入的幂等重试，不跨搜索复用。
- 相同账号下，相同规范化搜索词合并为一条并增加 `searchCount`。
- 相同 `searchId` 重放返回 `duplicate=true`，不重复计数。
- 设置已关闭或版本落后时拒绝写入，防止“清除后在途请求重新写回”。
- 超过 `maxItems` 时在同一 D1 batch 中删除最旧记录，并优先保留当前写入项。

### 5.3 查询和删除

```http
GET    /api/v2/me/search-history?limit=20&cursor=<opaque>
DELETE /api/v2/me/search-history/:historyId
POST   /api/v2/me/search-history/clear
```

列表只返回本人未到期记录。逐条删除和全部清除都会提升设置版本；全部清除可同时设置 `disableRecording=true`。外部 `historyId` 由账号范围和规范化搜索词确定性哈希生成，不暴露 D1 自增 ID，也不允许跨账号读取或删除。

## 6. 数据模型

`0080_app_person_search_and_history.sql` 新增：

| 表 | 作用 |
|----|------|
| `app_person_search_policies` | 搜索与历史的版本化运行、生产和隐私门禁 |
| `app_search_history_preferences` | 账号私有开关、乐观版本和 mutation token |
| `app_person_search_history` | 规范化搜索词、幂等哈希、次数和到期时间 |

development 策略 ID 为 `sqp_app_1_0_search_1_dev_1`。migration 只插入策略目录，不创建账号偏好或历史，不回填旧 Web 搜索数据。

当前人物检索直接读取 `profile_public_projections` 与来源图库，避免第二套人物事实。新增索引只优化公开状态与昵称访问，不改变投影生成逻辑。

每日维护任务已接入受策略控制的分批物理清理：只有显式配置策略版本且该策略 `purge_enabled=1` 时，才按 `expires_at` 删除到期行；搜索 capability 关闭不会中止既有删除义务。当前 development 策略 `purge_enabled=0`，因此不会在配置与保留期审批前执行清理。

## 7. Bootstrap 与运行门禁

```json
{
  "capabilities": {
    "search": {
      "profiles": false,
      "history": false
    }
  },
  "search": {
    "policyVersion": "sqp_app_1_0_search_1_dev_1",
    "transport": "http_post",
    "defaultSort": "relevance",
    "allowedSorts": ["relevance", "popular", "latest"],
    "defaultPageSize": 20,
    "maxPageSize": 40,
    "maxQueryLength": 50,
    "historyRecordingDefault": false,
    "maxHistoryItems": 50
  }
}
```

代码声明但当前未写入环境的参数：

```text
APP_PERSON_SEARCH_ENABLED
APP_PERSON_SEARCH_POLICY_VERSION
APP_PERSON_SEARCH_PRODUCTION_READY
```

`search.profiles=true` 要求 Auth、运行参数、有效策略、搜索开关和 production 门禁全部通过。`search.history=true` 还要求历史开关；production 额外要求明确的保留期审批、purge 和历史生产门禁。任何缺失或异常都安全降级为 `false`。

## 8. 客户端交互约束

- 初始页只展示本机 UI 建议与账号历史；服务端目前不提供热门词或联想词接口。
- 输入提交后展示加载状态；结果返回后使用 `match.field/label` 解释命中来源。
- 空结果显示“没有找到符合条件的已认证人物”，可建议修改关键词，不得用未认证人物补位。
- history capability 关闭时隐藏历史开关和服务端历史，不把本地输入误称为账号同步历史。
- 清空必须二次确认；可选择“仅清空”或“清空并关闭记录”。
- 所有分页请求复用原 query/sort；编辑输入后丢弃旧 cursor。
- `401` 进入统一会话失效流程；`403 FEATURE_DISABLED` 关闭入口；`409` 刷新设置后由用户重新决定是否记录。

## 9. Search-2 前向兼容实现状态

Search-2 已使用同一 `POST /person-profiles/search` 请求体兼容新增结构化 `filters`，并完成：

1. 地区、职业、风格等 taxonomy 稳定 ID 与 catalog version 契约（Taxonomy-1 已完成服务端开发基线）；
2. `discovery.filter.advanced` 和 `discovery.saved_filter.max` 的可执行 entitlement；
3. 条件冲突、结果数预估和受限条件说明；
4. 保存条件的独立表、版本、删除和升级降级语义；
搜索/筛选是否可用于个性化推荐的独立同意与退出机制仍未实现，不能从 Search-2 查询能力推导。

Search-2 不得改变 Search-1 的公开资格、账号屏蔽、默认不记录和敏感词不入日志原则。

## 10. 当前交付与后置工作

本阶段已完成：

- `0080_app_person_search_and_history.sql`；
- 搜索策略、capability、隐私请求规范化、相关度排序和账号绑定游标；
- 人物搜索与搜索历史六组服务端路由；
- 与 capability 解耦、受策略门禁的到期历史分批清理任务；
- Search-1 引入版本为 `1.13.0`；当前 App API/OpenAPI/共享类型累计版本已由 Search-2 提升到 `1.15.0`；
- 产品、技术、契约与项目状态文档同步。

统一后置到“全部开发完成”之后：

1. 在 `meigallery-client` 按当前累计 `1.15.0` 契约接入 DTO、Repository、搜索页、历史设置和清除交互。
2. 选择隔离环境策略并配置运行门禁。
3. 执行 migration、D1 专项用例、SQL/契约兼容检查、KMP UI 回归和端到端联调。
4. 单独完成搜索历史生产保留期、purge、隐私文案和上线审批；development 的 90 天不得直接转为生产承诺。
