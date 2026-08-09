# Taxonomy-1 稳定分类目录与人物关联开发基线

状态：Cloudflare、KMP 与 Nuxt 后台开发完成，production 默认关闭

App 版本：1.0

App API：v2 / `1.14.0`

数据库：`0081_app_taxonomy_catalog.sql`

## 1. 本阶段目标

Taxonomy-1 先解决 Search-2 的数据前提：人物筛选、保存条件和推荐规则不得引用会随运营修改的中文名称或 legacy slug，必须引用稳定 `termId` 与不可变 `catalogVersionId`。

本阶段只形成开发代码和契约，不修改 Wrangler 配置、不执行 migration、不导入旧标签、不运行专项测试，也不启用任何现有环境能力。

## 2. 已冻结的核心边界

### 2.1 编辑事实与公开快照分离

- `app_taxonomy_terms` 保存管理员正在维护的词条事实。展示名、别名、父级、公开性或状态发生变化时，词条稳定 ID 不变，但 `version` 递增。
- `app_taxonomy_term_revisions` 保存每次变化后的不可变修订，包含原因、操作者和时间。
- `app_taxonomy_catalogs` 与 `app_taxonomy_catalog_items` 保存不可变目录快照。目录一经发布不可原地修改；后续变化必须创建新目录版本。
- 客户端以 `catalogVersionId + termId + termVersion` 解释条件，不把中文名称、slug 或排序当业务键。

### 2.2 支持的稳定类型

```text
region_scope
region_group
city_country
identity
personality
style
occupation
hair
clothing
scene
content_type
```

新增类型必须先升级 API/schema 和客户端兼容逻辑，不能由后台自由创建。

### 2.3 生命周期

```text
draft → pending_review → active
              └───────→ draft（退回）

active → hidden → deprecated
active/deprecated/hidden → merged → redirectTargetTermId
draft/hidden/deprecated → archived（无任何有效引用时）
hidden/deprecated → draft（恢复后重新审核）
```

- 只有 `active + public + standard + allowedForProfile=true` 的目录项可用于新人物标注。
- `merged` 在下一目录快照中成为 `redirect`，源 `termId` 永久保留，不复用、不物理删除。
- `restricted` 词条当前保持关闭；在隐私/法务升级审批能力完成前，服务端拒绝把它审核为 `active`。
- 已被人物、公开投影、目录、子级或重定向引用的词条不能归档。

### 2.4 legacy 标签迁移

`app_taxonomy_legacy_mappings` 使用以下显式映射类型：

| 类型 | 是否需要目标 stable ID | 含义 |
|------|------------------------|------|
| `exact` | 是 | 旧值与稳定词条语义完全一致 |
| `alias` | 是 | 旧值是稳定词条的兼容名称 |
| `split_required` | 否 | 一个旧值需要人工拆分 |
| `unsupported` | 否 | 不允许迁移或公开 |
| `pending_review` | 否 | 未知值，等待人工判断 |

未知值不自动创建 active 词条，不直接进入人物公开投影，也不参与搜索、筛选或推荐。

## 3. 数据模型

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_taxonomy_terms` | 当前编辑事实 | stable ID、固定类型、层级、别名、公开性、敏感级别、乐观版本 |
| `app_taxonomy_term_revisions` | 不可变修订历史 | `term_id + version` 唯一，记录原因和操作者 |
| `app_taxonomy_catalogs` | 目录版本头 | development/published/retired、有效时间、最低客户端版本、production 门禁 |
| `app_taxonomy_catalog_items` | 目录不可变条目 | 快照名称/别名/层级；active/deprecated/redirect |
| `app_taxonomy_legacy_mappings` | 旧值兼容治理 | 来源命名空间和规范值唯一，未知值默认待复核 |
| `person_profile_taxonomy_assignments` | 人物内容版本的结构化标注 | 绑定 profile version、catalog 和 term version |
| `profile_public_taxonomy_terms` | 已审核公开分类投影 | 只在人物发布成功时由服务端原子刷新 |

Migration 只 seed 空开发目录 `txc_app_1_0_taxonomy_1_dev_1`。它用于稳定默认契约，不代表可用业务目录；首个真实快照应使用新的 `versionCode` 和 catalog ID。

## 4. App 公共契约

### 4.1 Bootstrap

```json
{
  "capabilities": {
    "taxonomy": {
      "catalog": false
    }
  },
  "taxonomy": {
    "catalogVersionId": "txc_app_1_0_taxonomy_1_dev_1",
    "supportedTypes": ["region_scope", "region_group", "city_country"]
  }
}
```

`supportedTypes` 实际返回完整 11 项。未同时通过环境开关、配置目录、目录有效时间和 production 发布门禁时，`catalog=false`。

### 4.2 读取目录

```http
GET /api/v2/taxonomy/catalog
If-None-Match: "taxonomy-<catalogVersionId>-<versionCode>"
```

- 返回公开、标准敏感级别的目录快照；包含 active、deprecated 和 redirect 项。
- 响应提供 ETag，成功目录可公共短缓存 300 秒并条件重验证；其他 App API 仍保持 `no-store`。
- 配置目录未就绪时返回稳定 `403/503` 错误，不回退到 legacy 标签或跨版本混合结果。

### 4.3 人物公开资料

所有 `AppPersonProfile` 兼容新增：

```json
{
  "taxonomyTerms": [
    {
      "termId": "txt_example",
      "type": "style",
      "displayName": "清新",
      "catalogVersionId": "txc_example",
      "termVersion": 3
    }
  ]
}
```

旧 `tags` 继续作为迁移窗口的展示兼容字段，但 Search-2 的筛选、保存条件和推荐规则只能使用 `taxonomyTerms` 的稳定标识。

## 5. 管理 API

所有路径位于 `/api/admin/app/taxonomy`，先经过现有管理员认证，再要求 `APP_TAXONOMY_ADMIN_ENABLED=true`；所有修改写入 `admin_audit_logs`。

| 方法 | 路径 | 用途 |
|------|------|------|
| GET/POST | `/terms` | 分页查询、创建草稿 |
| GET/PATCH | `/terms/:termId` | 详情/修订历史/目录引用、乐观版本编辑 |
| POST | `/terms/:termId/submit` | 草稿提交复核 |
| POST | `/terms/:termId/decision` | 审核通过或退回 |
| POST | `/terms/:termId/lifecycle` | hide/deprecate/archive/restore |
| POST | `/terms/:termId/merge` | 同类型词条合并并保留重定向 |
| GET/POST | `/catalogs` | 查询目录历史、从当前有效词条生成快照 |
| GET | `/catalogs/:catalogId` | 查看完整快照 |
| POST | `/catalogs/:catalogId/publish` | 发布不可变目录，可独立声明 production ready |
| GET/PUT | `/legacy-mappings` | 查询和乐观版本维护旧标签映射 |

创建/编辑校验包括：固定类型、slug、父子类型、层级循环、同类型展示名/别名冲突、敏感级别、别名数量和排序范围。目录生成前校验父级与合并目标引用完整性。

## 6. 人物版本与发布边界

### 6.1 设置结构化分类

```http
PUT /api/admin/app/persons/:personId/taxonomy
```

请求包含 `expectedVersion`、`catalogVersionId` 和最多 30 个 `termIds`。服务端只接受同一有效目录中可用于人物的 active 词条。

成功后：

1. 人物 `content_version` 和 `lock_version` 同时递增；
2. 新版本认证状态回到 `unverified`，发布状态回到 `draft`；
3. 旧公开投影及其 taxonomy 保持不变，避免未审核内容静默上线；
4. 普通人物资料编辑生成新内容版本时，会继承上一版本的稳定 taxonomy 关联；
5. 所有变化记录审计事实。

### 6.2 发布投影

人物提交/批准发布时新增 `TAXONOMY_ASSIGNMENTS_VALID` 门禁。未设置结构化分类当前允许通过；一旦设置，必须满足：

- 当前内容版本只引用一个目录版本；
- 目录仍处于 development/published 且已到生效时间；
- 每个词条仍为 active、public、standard 且允许人物标注。

批准发布在同一 D1 batch 中刷新 `profile_public_projections` 与 `profile_public_taxonomy_terms`。任何门禁变化都会使整批失败，不产生一半新资料、一半旧分类的混合公开状态。

## 7. 默认关闭与后置事项

本阶段新增但未写入任何实际配置的变量：

```text
APP_TAXONOMY_ENABLED
APP_TAXONOMY_ADMIN_ENABLED
APP_TAXONOMY_CATALOG_VERSION
APP_TAXONOMY_PRODUCTION_READY
```

后置事项：

1. 完成细粒度 `taxonomy.edit/review/publish` 权限、敏感词隐私/法务升级和高风险双人复核。
2. 完成合并/归档影响预览、多语言名称、目录渠道/地区灰度、显式回滚和迁移批次对账。
3. KMP 已完成通用目录缓存、ETag 条件重验证和未知类型 fail closed；Nuxt 已完成 `ADM-TAX-01/02/03` 目录树、词条工作台和目录发布页。跨域完整引用计数、目录差异比较与显式回滚仍随后续服务端契约补齐，不在 UI 伪造能力。
4. Search-2 已完成 entitlement 定义、结构化筛选、结果数预估、保存条件及 KMP 客户端；后续按其独立文档完成配置与验证。
5. 全部开发结束后再统一执行 migration、环境配置、专项测试、远端联调和上线验收。

## 8. 本阶段完成定义

- D1 schema、稳定 ID、修订历史、目录快照、重定向和 legacy 映射契约已落地；
- 公共目录、bootstrap capability、ETag 和共享 DTO 已落地；
- 管理词条/目录/映射 API 与审计已落地；
- 人物内容版本关联、发布门禁和公开投影已落地；
- OpenAPI 累计版本提升到 `1.14.0`；
- KMP 通用 Taxonomy Repository 已由 Recommendation 与 Search 共用，Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过；
- Nuxt 后台已交付词条目录/筛选/创建、详情编辑/复核/生命周期/合并、legacy 映射，以及快照生成、结构检查、客户端兼容确认和不可变发布；
- 未配置、未执行 migration、未运行专项测试、未部署。
