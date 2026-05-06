# Telegram 导入 API 技术方案

## 1. 方案摘要

本方案新增一条面向自定义 Telegram Bot 的受保护导入通道。Bot 负责读取 Telegram 指定消息、下载媒体、解析文案并提交结构化字段；MeiGallery API 负责鉴权、幂等、字段校验、R2 上传、D1 入库、审计日志和导入记录。首期只创建图库和真实案例草稿，不自动发布，不保存 Telegram Bot Token，不拉取 Telegram `file_id`，不使用 AI 解析 caption。

核心原则：
- 导入 API 是服务端能力，不走管理员网页登录态，使用专用 Import Token。
- Import Token 只显示一次，数据库只保存 hash，可禁用、过期和按权限限制。
- Bot 传结构化 `metadata` 和 multipart 文件；API 不解析 Telegram 原始消息。
- 所有导入内容强制 `draft`，后台人工审核授权、脱敏、标签和会员等级后再发布。
- 幂等键由 `token_id + source + external_message_id` 组成，同一 Telegram 消息重复提交不得创建重复内容。
- 业务文件数上限与 Cloudflare 请求体上限分开校验，避免大图批量上传触发 413。

## 2. 数据模型

新增 migration：`packages/api/migrations/0015_telegram_import_api.sql`。如果并行功能已经占用 `0015`，实现时按当前仓库最大 migration 序号顺延，并保持文件内容一致。

### 2.1 import_api_tokens

```sql
CREATE TABLE IF NOT EXISTS import_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_import_api_tokens_status
  ON import_api_tokens(status, expires_at);
```

字段说明：
- `token_hash`：保存 `SHA-256(token)` 的十六进制字符串，不保存明文 token。
- `permissions`：JSON 数组字符串，例如 `["gallery:create","testimonial:create"]`。
- `created_by`：创建 token 的 Owner 用户 ID；导入审计日志使用该用户作为责任主体。
- `last_used_at`：每次鉴权成功后更新，用于后台判断 token 是否仍被使用。

Token 明文格式：`mgi_<32字节随机值的base64url>`。返回给后台时只显示一次，刷新页面后不可再查看。

### 2.2 external_import_records

```sql
CREATE TABLE IF NOT EXISTS external_import_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES import_api_tokens(id),
  target_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  metadata_json TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  uploaded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (source IN ('telegram')),
  CHECK (target_type IN ('gallery', 'testimonial_case')),
  CHECK (status IN ('processing', 'completed', 'failed')),
  UNIQUE (token_id, source, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_external_import_records_token
  ON external_import_records(token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_target
  ON external_import_records(target_type, target_id);
```

字段说明：
- `metadata_json`：保存 API 接收并通过基础校验后的 metadata 快照，便于追溯。
- `error_json`：保存结构化错误数组，不记录 token 明文和文件二进制内容。
- `status='processing'` 用于请求处理中途失败后的清理判断。
- 唯一约束保证 Bot 重试同一消息时不会重复创建内容。

## 3. API 设计

### 3.1 Bot 导入接口

`POST /api/imports/telegram`

认证：
- Header：`Authorization: Bearer <import_token>`。
- 不接受管理员 session cookie 作为导入凭证。

请求：`multipart/form-data`

字段：
- `metadata`：必填，JSON 字符串。
- `files`：必填，图片文件数组，字段名可重复。

图库 metadata：

```json
{
  "type": "gallery",
  "source": "telegram",
  "externalMessageId": "-1001234567890:456",
  "title": "加拿大-多伦多 172D Lina",
  "slug": "toronto-lina-001",
  "summary": "一句话摘要",
  "bodyMd": "正文 Markdown",
  "requiredLevelRank": 10,
  "tags": ["加拿大", "多伦多", "留学生", "旅拍"],
  "coverFileName": "001.jpg"
}
```

真实案例 metadata：

```json
{
  "type": "testimonial_case",
  "source": "telegram",
  "externalMessageId": "-1001234567890:789",
  "title": "会员反馈 2026-05-06",
  "slug": "member-feedback-2026-05-06",
  "summary": "已授权、已脱敏的反馈摘要。",
  "bodyMd": "## 反馈说明\n\n正文已脱敏。",
  "featured": true,
  "sortOrder": 0,
  "seoTitle": "会员反馈 2026-05-06",
  "seoDescription": "已授权、已脱敏的反馈摘要。"
}
```

成功响应：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "targetId": "gal_xxx",
  "status": "draft",
  "uploadedCount": 6,
  "failedCount": 0,
  "files": [
    { "filename": "001.jpg", "id": "ma_xxx", "sortOrder": 0 }
  ]
}
```

幂等重复响应：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "targetId": "gal_xxx",
  "status": "duplicate",
  "message": "该 Telegram 消息已导入"
}
```

错误响应：

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "metadata.title 为必填项",
  "details": [
    { "field": "metadata.title", "message": "标题为必填项" }
  ]
}
```

### 3.2 Import Token 后台接口

挂载位置：`/api/admin/import-api-tokens`，仅 Owner 可访问。

接口：
- `GET /api/admin/import-api-tokens`：列出 token，不返回 `token_hash` 和明文 token。
- `POST /api/admin/import-api-tokens`：创建 token 并一次性返回明文。
- `PATCH /api/admin/import-api-tokens/:id`：更新名称、权限、过期时间或禁用状态。
- `DELETE /api/admin/import-api-tokens/:id`：软删除，实际设置 `status='disabled'`。

创建请求：

```json
{
  "name": "Telegram 导入 Bot",
  "permissions": ["gallery:create", "testimonial:create"],
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

创建响应：

```json
{
  "id": "iat_xxx",
  "token": "mgi_xxx",
  "name": "Telegram 导入 Bot",
  "permissions": ["gallery:create", "testimonial:create"],
  "status": "active",
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

### 3.3 外部导入记录后台接口

挂载位置：`/api/admin/external-import-records`，Admin 可查看，Owner 可查看全部。

接口：
- `GET /api/admin/external-import-records`：支持 `source`、`targetType`、`status`、`page`、`pageSize`。
- `GET /api/admin/external-import-records/:id`：查看 metadata 快照、错误详情和目标资源链接。

首期不提供“重新执行”按钮。Bot 端可用相同 `externalMessageId` 查询幂等结果；如需重新导入，应换新的 `externalMessageId` 或先在后台删除失败记录。

## 4. 校验规则

### 4.1 通用 metadata 校验

- `type` 必须是 `gallery` 或 `testimonial_case`。
- `source` 必须是 `telegram`。
- `externalMessageId` 必填，长度 1-160 字符，只允许可打印 ASCII 和常见分隔符 `:`、`-`、`_`。
- `title` 必填，1-80 字。
- `slug` 必填，只允许小写字母、数字和短横线，长度 3-120 字符。
- `summary` 最多 160 字。
- `bodyMd` 最多 5000 字。
- `tags` 最多 30 个，每个标签名 1-30 字。
- `requiredLevelRank` 只允许 `0`、`10`、`20`，默认 `0`。
- `status` 字段即使传入也会被忽略，服务端固定写入 `draft`。

### 4.2 文件校验

- MIME 只允许 `image/jpeg`、`image/png`、`image/webp`。
- 单张文件最大 10MB。
- 图库单次最多 30 张图片。
- 真实案例单次必须 2-9 张图片。
- API 增加应用层总文件大小上限，默认 80MB，低于 Cloudflare Free/Pro 100MB 请求体上限，避免接近平台边界。
- 如果账户升级到 Business 或 Enterprise，可通过环境变量提高应用层总大小上限，但不能超过当前 Cloudflare 账户请求体限制。

Cloudflare Workers 官方限制显示，请求体大小取决于 Cloudflare 账户计划：Free/Pro 为 100MB，Business 为 200MB，Enterprise 默认为 500MB。实现时不要把平台限制硬编码到业务逻辑中，应使用 `IMPORT_MAX_REQUEST_BYTES` 环境变量控制应用层限制，并在部署文档中记录当前值。

### 4.3 图库导入规则

- 权限要求：token 包含 `gallery:create`。
- slug 不得与现有 `galleries.slug` 冲突。
- 创建 `galleries.status='draft'`。
- 图片按 multipart 中的文件顺序写入 `media_assets.sort_order`，从 `0` 开始。
- R2 key：`originals/{galleryId}/{assetId}.{ext}`。
- `coverFileName` 命中某个上传文件名时，图库 `cover_key` 使用该文件 R2 key。
- 未传 `coverFileName` 时，默认第一张图片为封面。
- 标签按名称或 slug 查找；不存在时自动创建，默认类型为 `personality`，后续管理员可在后台修正。

### 4.4 真实案例导入规则

- 权限要求：token 包含 `testimonial:create`。
- slug 不得与现有 `testimonial_cases.slug` 冲突。
- 创建 `testimonial_cases.status='draft'`。
- 图片按 multipart 中的文件顺序写入 `testimonial_case_images.sort_order`，从 `0` 开始。
- R2 key：`testimonials/{caseId}/{imageId}.{ext}`。
- `featured` 默认 `true`，但草稿不会进入公开 API。
- 发布仍走后台真实案例发布校验，必须保持 2-9 张图片。

## 5. 服务端模块划分

新增文件建议：
- `packages/api/src/routes/imports.ts`：公开服务端导入接口，挂载 `/api/imports`。
- `packages/api/src/routes/admin/import-api-tokens.ts`：后台 token 管理。
- `packages/api/src/routes/admin/external-import-records.ts`：后台导入记录查询。
- `packages/api/src/services/telegram-import.ts`：导入编排逻辑。
- `packages/api/src/utils/import-token.ts`：token 生成、hash、权限判断、过期判断。
- `packages/api/src/utils/import-validation.ts`：metadata 和文件校验。
- `packages/api/src/utils/import-errors.ts`：统一错误 code 和响应格式。

模块边界：
- 路由层只负责读取请求、调用 service、返回响应。
- `telegram-import` service 负责编排事务式流程和清理。
- token 工具不依赖 Hono context，便于单测。
- validation 工具不访问 D1/R2，只做纯校验。

## 6. 导入流程

### 6.1 正常流程

```text
1. 读取 Authorization Bearer token。
2. 计算 SHA-256(token)，查询 import_api_tokens。
3. 校验 status、expires_at、permissions。
4. 读取 multipart metadata 和 files。
5. 校验 metadata、文件类型、数量、大小和总大小。
6. 尝试插入 external_import_records(status='processing')。
7. 如果唯一约束冲突，读取原记录并返回 duplicate 响应。
8. 按 type 创建 galleries 或 testimonial_cases 草稿。
9. 上传每个文件到 R2，并创建 media_assets 或 testimonial_case_images。
10. 更新 external_import_records 为 completed，写 target_id、uploaded_count。
11. 更新 import_api_tokens.last_used_at。
12. 写 admin_audit_logs。
13. 返回导入结果。
```

### 6.2 失败流程

- metadata 或权限校验失败：不创建目标内容，写失败审计日志；如果已创建 import record，则更新为 `failed`。
- slug 冲突：返回 `409 SLUG_CONFLICT`，不创建目标内容。
- 文件部分失败：首期采用全量失败策略，任一文件上传失败则删除已上传 R2 对象、删除已创建目标记录，更新 import record 为 `failed`。
- D1 入库失败：删除本请求已上传 R2 对象，返回 `500 IMPORT_WRITE_FAILED`。
- R2 清理失败：记录到 `error_json` 和 Worker log，不阻塞失败响应。

首期使用全量失败策略，避免草稿内容缺图或媒体顺序不完整。后续如需“部分成功”，需要在后台导入记录页提供明确修复入口。

## 7. 安全与速率限制

- `/api/imports/telegram` 不经过普通 `authMiddleware` 的 session 判定，但必须经过 Import Token middleware。
- Import Token middleware 不应把 token 明文写入日志。
- 对导入接口增加速率限制：默认每 token 每分钟 20 次，每 IP 每分钟 60 次。
- 每个 token 每天导入数量默认 500 条，超过后返回 `429 DAILY_IMPORT_LIMIT_EXCEEDED`。
- `metadata_json` 写库前限制长度，最大 20KB。
- 错误日志只记录文件名、MIME、大小和错误原因，不记录文件内容。
- `request_ip` 从 Cloudflare `CF-Connecting-IP` 获取；没有则使用 `c.req.header('x-forwarded-for')` 的第一个 IP。

## 8. 测试策略

### 8.1 单元测试

- `import-token.test.ts`：token 生成格式、hash 一致性、权限判断、过期判断。
- `import-validation.test.ts`：metadata 校验、slug 校验、图片数量、MIME、大小、总大小。
- `telegram-import.test.ts`：图库导入、真实案例导入、slug 冲突、重复 externalMessageId、失败清理。

### 8.2 路由测试

- 无 token 返回 `401`。
- 无权限 token 返回 `403`。
- disabled/expired token 返回 `403`。
- 图库 multipart 成功创建草稿和媒体记录。
- 真实案例 multipart 成功创建草稿和图片记录。
- 重复 `externalMessageId` 返回 duplicate，不新增目标记录。
- 超过应用层总大小返回 `413`。

### 8.3 手动验收

- 在 dev Worker 创建 Import Token。
- 用 curl 提交图库样例，后台确认草稿、封面、图片顺序和标签。
- 用 curl 提交真实案例样例，后台确认草稿和 2-9 张图片。
- 重复提交同一 `externalMessageId`，确认没有重复草稿。
- 禁用 token 后再次提交，确认返回 `403`。

## 9. 部署与配置

新增环境变量：
- `IMPORT_MAX_REQUEST_BYTES`：默认 `83886080`，即 80MB。
- `IMPORT_TOKEN_DAILY_LIMIT`：默认 `500`。

部署步骤：
- 应用 D1 migration。
- 部署 API Worker dev 环境。
- 在 dev 后台创建 Import Token。
- 使用 API 文档样例完成导入验收。
- 验收通过后再部署生产 API。

生产注意事项：
- 不在文档、日志、Issue、PR 或聊天中粘贴真实 Import Token。
- 如果 token 泄露，Owner 需立即禁用该 token 并创建新 token。
- 首期不需要 Web Worker 改动，除非新增后台 Token/导入记录页面。
