# 数据分析推广来源设计

## 1. 背景

当前数据分析已经能按 `source_channel`、`source_name`、`invite_code_id` 聚合来源表现，也已经支持邀请码创建和邀请注册转化。但后台缺少“推广来源”的创建入口，运营无法在投放前生成标准追踪链接，只能手工拼 UTM 或复用邀请码。

这会带来两个问题：

- “用户从哪里进入站点”与“用户是否通过邀请码注册”被混在一起。
- 来源名称、渠道、落地页和 UTM 参数没有统一管理，后续报表难以稳定对齐。

用户已确认采用推荐方案 C：推广来源和邀请码分开建模，访问归因看推广来源，注册邀请看邀请码，两者可以在报表中关联。

## 2. 目标

- 后台可以创建、启用、停用推广来源。
- 每个推广来源生成一个可复制的追踪链接。
- 前端完整上报 UTM、referrer 和推广来源 ID。
- API 继续按低成本聚合表统计来源，不在后台首页扫描原始事件。
- 来源分析页既显示自动归因来源，也显示后台创建的推广来源配置和表现。
- 邀请码仍独立存在，用于邀请注册和会员发放归因。

## 3. 非目标

- 不接入第三方广告平台 API。
- 不建设实时投放系统。
- 不保存外部 URL 的完整 query 或 hash。
- 不把推广来源作为权限或会员判断依据。
- 不允许普通用户创建推广来源。

## 4. 数据模型

新增 D1 表 `analytics_tracking_sources`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 推广来源 ID，前缀 `ats` |
| `name` | TEXT | 后台显示名称 |
| `channel` | TEXT | 渠道：`social`、`search`、`ad`、`partner`、`referral`、`manual`、`other` |
| `slug` | TEXT UNIQUE | 追踪链接短标识 |
| `target_path` | TEXT | 站内落地路径，使用现有 URL 清洗规则 |
| `utm_source` | TEXT | UTM source |
| `utm_medium` | TEXT | UTM medium |
| `utm_campaign` | TEXT | UTM campaign |
| `status` | TEXT | `active` 或 `disabled` |
| `note` | TEXT | 内部备注 |
| `created_by` | INTEGER | 创建管理员 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 更新时间 |

不在首期给聚合表新增 `tracking_source_id` 维度，避免扩大 D1 rows written。事件 props 会保存 `tracking_source_id`，日报仍按 `source_channel + source_name + invite_code_id` 聚合；来源管理接口用 UTM/source name 和配置表做轻量关联。

## 5. 归因规则

来源归因继续遵守现有优先级：

1. 邀请码：URL 或事件 props 中包含有效 `invite_code_id`。
2. 推广来源：URL 中包含 `mg_source` 或标准 UTM。
3. 站内广告：事件 props 中包含 `ad_id`。
4. 外部 referrer：只保留安全域名。
5. 直接访问。

推广来源链接格式：

```text
{target_path}?mg_source={slug}&utm_source={utm_source}&utm_medium={utm_medium}&utm_campaign={utm_campaign}
```

如果目标路径已有 query，仅追加允许的追踪参数。前端上报时同时带：

- `utmSource`
- `utmMedium`
- `utmCampaign`
- `trackingSourceSlug`
- `trackingSourceId`（仅当本地已从配置或 props 识别到）
- `referrer`
- `referrerHost`

API 侧仍以服务端清洗和白名单为准。

## 6. API 设计

新增管理员接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/tracking-sources` | 列出推广来源，包含追踪链接字段 |
| POST | `/api/admin/tracking-sources` | 创建推广来源 |
| PATCH | `/api/admin/tracking-sources/:id` | 更新名称、渠道、落地页、UTM、状态和备注 |

写操作必须写入 `admin_audit_logs`：

- `tracking_source.create`
- `tracking_source.update`
- `tracking_source.disable`

来源分析接口 `/api/admin/analytics/sources` 增加 `trackingSources` 字段，返回创建过的推广来源及其在当前日期范围内的聚合表现。原 `data` 字段保持兼容。

## 7. 前端设计

后台 `/admin/analytics/sources` 重做为双区块：

- 上方：来源表现排行，继续展示自动归因结果。
- 右侧或下方：推广来源管理，支持新建、复制链接、启用/停用。

表单字段：

- 来源名称
- 渠道
- 短标识
- 落地页
- UTM source
- UTM medium
- UTM campaign
- 备注

邀请码管理继续保留在 `/admin/analytics/invites` 和 `/admin/invite-codes`，不迁移、不合并。

## 8. 前端采集

`analytics.client.ts` 初始化 session 时从当前 URL 和 `document.referrer` 读取安全来源信息。`useAnalytics.track()` 默认把当前 session 的来源上下文附加到每个事件，避免每个页面手工传参。

需要采集的新增字段：

- URL 中的 `mg_source`、`utm_source`、`utm_medium`、`utm_campaign`
- `document.referrer` 清洗后的完整 referrer 和 host
- 当前来源渠道推断值

敏感参数继续由本地 sanitizer 和 API 双重过滤；遇到敏感 URL 时丢弃事件，不上报。

## 9. 测试

- API unit：推广来源创建、重复 slug、更新、停用、审计日志。
- API unit：来源归因识别 `mg_source`、UTM、referrer。
- Web unit：前端 SDK 提取 UTM/referrer，并自动附加到事件 payload。
- Web unit：来源页展示、创建表单、复制链接状态。
- 构建验证：`corepack pnpm --filter @meigallery/api exec tsc --noEmit` 和 `corepack pnpm --filter @meigallery/web exec nuxt build`。

## 10. 验收标准

- 管理员能创建“Telegram 互推”等推广来源，并复制标准追踪链接。
- 用户通过追踪链接进入站点后，后台来源分析能按来源名称统计 session、PV、联系、注册和会员发放。
- 用户通过追踪链接并带邀请码注册时，来源报表显示推广来源，邀请报表显示邀请码，两者不互相覆盖。
- 停用推广来源后，后台不再建议复制该链接，但历史报表仍可查看。
- 所有后台配置写操作都有审计日志。

## 11. 自审记录

- 无 TBD/TODO 占位。
- 数据模型和 API 路径与现有独立邀请码模型不冲突。
- 首期不扩大聚合表维度，符合低成本要求。
- 来源和邀请的边界已明确：来源看入口，邀请码看注册邀请。
