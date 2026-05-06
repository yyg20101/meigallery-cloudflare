# Telegram file_id 异步导入 API 技术方案

## 1. 方案摘要

本方案将 Telegram 导入主路径从 multipart 文件上传调整为 `file_id` JSON 异步导入。自定义 Bot 只提交结构化 metadata、Telegram 文件引用和来源信息；MeiGallery 通过 `sourceBotKey` 找到对应 Telegram Bot Token，异步调用 Telegram API 下载图片，校验后保存到 R2，再创建图库或真实案例草稿。

核心原则：
- Bot 不处理大文件下载和 multipart 上传，降低 Cloudflare Worker/Queues 侧压力。
- MeiGallery 最终必须保存真实图片资产到 R2，不长期依赖 Telegram 文件引用。
- Telegram Bot Token 使用 Worker secret 或 Cloudflare Secrets Store 管理，不进入 D1 明文。
- 导入 API 返回接收状态，不保证请求返回时草稿已创建。
- 所有导入内容强制 `draft`，后台人工审核授权、脱敏、标签和会员等级后再发布。
- 幂等键由 `token_id + source + external_message_id` 组成，同一 Telegram 消息重复提交不得创建重复内容。

## 2. 数据模型

新增 migration：`packages/api/migrations/0015_telegram_import_api.sql`。如果并行功能已经占用 `0015`，实现时按当前仓库最大 migration 序号顺延，并保持文件内容一致。

### 2.1 import_api_tokens

```sql
CREATE TABLE IF NOT EXISTS import_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  allowed_source_bot_keys TEXT NOT NULL DEFAULT '[]',
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
- `allowed_source_bot_keys`：JSON 数组字符串，例如 `["ops_gallery_bot"]`；空数组表示不允许任何 Bot。
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
  source_bot_key TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  media_group_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_media_fetch',
  metadata_json TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (source IN ('telegram')),
  CHECK (target_type IN ('gallery', 'testimonial_case')),
  CHECK (status IN ('pending_media_fetch', 'fetching_media', 'draft_created', 'partial_failed', 'failed')),
  UNIQUE (token_id, source, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_external_import_records_token
  ON external_import_records(token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_status
  ON external_import_records(status, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_target
  ON external_import_records(target_type, target_id);
```

### 2.3 external_import_files

```sql
CREATE TABLE IF NOT EXISTS external_import_files (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES external_import_records(id) ON DELETE CASCADE,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  filename TEXT,
  declared_mime_type TEXT,
  actual_mime_type TEXT,
  file_size INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  target_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending', 'fetching', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_external_import_files_import
  ON external_import_files(import_id, sort_order);
```

说明：
- `telegram_file_id` 用于拉取文件，不公开给前端。
- `telegram_file_unique_id` 用于来源追踪和排查，不作为下载凭证。
- `target_file_id` 指向 `media_assets.id` 或 `testimonial_case_images.id`。

## 3. API 设计

### 3.1 file_id 导入接口

`POST /api/imports/telegram-file-id`

认证：
- Header：`Authorization: Bearer <import_token>`。
- 不接受管理员 session cookie 作为导入凭证。

请求：`application/json`

```json
{
  "metadata": {
    "type": "gallery",
    "source": "telegram",
    "externalMessageId": "-1001234567890:456",
    "title": "加拿大-多伦多 172D Lina",
    "slug": "toronto-lina-001",
    "summary": "一句话摘要",
    "bodyMd": "正文 Markdown",
    "requiredLevelRank": 10,
    "tags": ["加拿大", "多伦多"]
  },
  "telegram": {
    "sourceBotKey": "ops_gallery_bot",
    "sourceChatId": "-1001234567890",
    "sourceMessageId": "456",
    "mediaGroupId": "123456"
  },
  "files": [
    {
      "fileId": "AgACAg...",
      "fileUniqueId": "AQAD...",
      "filename": "001.jpg",
      "mimeType": "image/jpeg",
      "sortOrder": 0,
      "isCover": true
    }
  ]
}
```

接收成功响应：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "status": "pending_media_fetch",
  "receivedFileCount": 2
}
```

幂等重复响应：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "targetId": "gal_xxx",
  "status": "duplicate",
  "currentStatus": "draft_created",
  "message": "该 Telegram 消息已导入"
}
```

### 3.2 导入状态查询

`GET /api/imports/:importId`

认证：
- Header：`Authorization: Bearer <import_token>`。
- 只能查询同一 token 创建的导入记录。

响应：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "status": "draft_created",
  "targetId": "gal_xxx",
  "fileCount": 2,
  "fetchedCount": 2,
  "failedCount": 0,
  "files": [
    { "filename": "001.jpg", "status": "completed", "sortOrder": 0 }
  ],
  "createdAt": "2026-05-06T00:00:00.000Z",
  "completedAt": "2026-05-06T00:01:10.000Z"
}
```

### 3.3 Import Token 后台接口

挂载位置：`/api/admin/import-api-tokens`，仅 Owner 可访问。

接口：
- `GET /api/admin/import-api-tokens`：列出 token，不返回 `token_hash` 和明文 token。
- `POST /api/admin/import-api-tokens`：创建 token 并一次性返回明文。
- `PATCH /api/admin/import-api-tokens/:id`：更新名称、权限、允许的 `sourceBotKey`、过期时间或禁用状态。
- `DELETE /api/admin/import-api-tokens/:id`：软删除，实际设置 `status='disabled'`。

### 3.4 外部导入记录后台接口

挂载位置：`/api/admin/external-import-records`，Admin 可查看，Owner 可查看全部。

接口：
- `GET /api/admin/external-import-records`：支持 `source`、`targetType`、`status`、`sourceBotKey`、`page`、`pageSize`。
- `GET /api/admin/external-import-records/:id`：查看 metadata 快照、文件状态、错误详情和目标资源链接。
- `POST /api/admin/external-import-records/:id/retry`：v1.1 增加，重新拉取失败文件或重新执行失败导入。

## 4. 校验规则

### 4.1 通用 metadata 校验

- `type` 必须是 `gallery` 或 `testimonial_case`。
- `source` 必须是 `telegram`。
- `externalMessageId` 必填，长度 1-160 字符。
- `title` 必填，1-80 字。
- `slug` 必填，只允许小写字母、数字和短横线，长度 3-120 字符。
- `summary` 最多 160 字。
- `bodyMd` 最多 5000 字。
- `tags` 最多 30 个，每个标签名 1-30 字。
- `requiredLevelRank` 只允许 `0`、`10`、`20`，默认 `0`。
- `status` 字段即使传入也会被忽略，服务端固定写入 `draft`。

### 4.2 Telegram 来源校验

- `telegram.sourceBotKey` 必填，只允许小写字母、数字和下划线，长度 3-64 字符。
- `sourceBotKey` 必须在 token 的 `allowed_source_bot_keys` 中。
- `sourceChatId` 必填，保存为字符串，不做数字范围假设。
- `sourceMessageId` 必填，保存为字符串。
- `mediaGroupId` 可选，用于相册来源追踪。
- `files` 数组必填，按 `sortOrder ASC` 处理。
- 每个文件必须包含 `fileId`。
- `fileUniqueId` 可选但建议传入，用于来源追踪。

### 4.3 文件校验

提交时声明校验：
- `mimeType` 只允许 `image/jpeg`、`image/png`、`image/webp`。
- 图库单次 1-30 个文件引用。
- 真实案例单次 2-9 个文件引用。
- `sortOrder` 必须为 0 到 999 的整数，同一请求内不能重复。

拉取后真实校验：
- Telegram `getFile` 成功返回 `file_path`。
- 下载响应 `Content-Type` 或文件头必须匹配允许图片类型。
- 单张文件最大 10MB。
- 文件保存到 R2 后才允许创建目标媒体记录。

### 4.4 图库导入规则

- 权限要求：token 包含 `gallery:create`。
- slug 不得与现有 `galleries.slug` 冲突。
- 创建 `galleries.status='draft'`。
- 图片按 `sortOrder` 写入 `media_assets.sort_order`，从 `0` 开始。
- R2 key：`originals/{galleryId}/{assetId}.{ext}`。
- `isCover=true` 的第一张图片作为封面；没有 `isCover` 时默认第一张图片为封面。
- 标签按名称或 slug 查找；不存在时自动创建，默认类型为 `personality`，后续管理员可在后台修正。

### 4.5 真实案例导入规则

- 权限要求：token 包含 `testimonial:create`。
- slug 不得与现有 `testimonial_cases.slug` 冲突。
- 创建 `testimonial_cases.status='draft'`。
- 图片按 `sortOrder` 写入 `testimonial_case_images.sort_order`，从 `0` 开始。
- R2 key：`testimonials/{caseId}/{imageId}.{ext}`。
- `featured` 默认 `true`，但草稿不会进入公开 API。
- 发布仍走后台真实案例发布校验，必须保持 2-9 张图片。

## 5. 异步处理设计

首选：Cloudflare Queues。

```text
POST /api/imports/telegram-file-id
  -> 写 external_import_records / external_import_files
  -> send queue message { importId }
  -> 返回 pending_media_fetch

Queue consumer
  -> 加载 import record
  -> 状态改 fetching_media
  -> 逐个 file_id 调 Telegram getFile/download
  -> R2 put
  -> D1 创建草稿和媒体记录
  -> 状态改 draft_created / partial_failed / failed
```

MVP 备选：`ctx.waitUntil(processImport(importId))`。

限制：
- `waitUntil()` 适合低频导入验证，不适合高频生产导入。
- 如果 Worker runtime 更新或处理超过 grace period，任务可靠性弱于 Queues。
- 技术方案和实现应优先为 Queues 留出边界，即处理函数独立于 HTTP route。

失败策略：
- 首期目标是全量成功创建草稿。
- 任一文件拉取或校验失败时，不创建目标草稿，状态置为 `failed`。
- 如果草稿创建后发生后续写入失败，清理本次已上传 R2 对象和已创建 D1 记录，状态置为 `failed`。
- `partial_failed` 作为 v1.1 后台人工修复能力使用，MVP 可只返回 `failed`。

## 6. 服务端模块划分

新增文件建议：
- `packages/api/src/routes/imports.ts`：Bot 导入接口和状态查询，挂载 `/api/imports`。
- `packages/api/src/routes/admin/import-api-tokens.ts`：后台 token 管理。
- `packages/api/src/routes/admin/external-import-records.ts`：后台导入记录查询。
- `packages/api/src/services/telegram-file-id-import.ts`：导入编排逻辑。
- `packages/api/src/services/telegram-file-fetcher.ts`：Telegram `getFile` 和文件下载。
- `packages/api/src/utils/import-token.ts`：token 生成、hash、权限判断、过期判断。
- `packages/api/src/utils/import-validation.ts`：metadata、telegram 来源和文件引用校验。
- `packages/api/src/utils/import-errors.ts`：统一错误 code 和响应格式。

模块边界：
- 路由层只负责读取请求、调用 service、返回响应。
- `telegram-file-id-import` service 负责编排状态流、D1/R2 写入和清理。
- `telegram-file-fetcher` 不访问 D1，只根据 `sourceBotKey` 和 `fileId` 拉取文件。
- token 工具不依赖 Hono context，便于单测。
- validation 工具不访问 D1/R2，只做纯校验。

## 7. 安全与速率限制

- `/api/imports/telegram-file-id` 不经过普通 session 判定，但必须经过 Import Token middleware。
- Import Token middleware 不应把 token 明文写入日志。
- Telegram Bot Token 通过 Worker secret 或 Secrets Store 读取，不保存到 D1，不返回给任何 API。
- 对导入接口增加速率限制：默认每 token 每分钟 60 次，每 IP 每分钟 120 次。
- 每个 token 每天导入数量默认 500 条，超过后返回 `429 DAILY_IMPORT_LIMIT_EXCEEDED`。
- `metadata_json` 写库前限制长度，最大 20KB。
- 错误日志只记录文件名、声明 MIME、大小和错误原因，不记录完整 Telegram 下载 URL。
- `request_ip` 从 Cloudflare `CF-Connecting-IP` 获取；没有则使用 `x-forwarded-for` 的第一个 IP。

## 8. 测试策略

### 8.1 单元测试

- `import-token.test.ts`：token 生成格式、hash 一致性、权限判断、过期判断、sourceBotKey 判断。
- `import-validation.test.ts`：metadata 校验、telegram 来源校验、文件数量、声明 MIME、sortOrder。
- `telegram-file-fetcher.test.ts`：mock Telegram `getFile`、下载成功、下载失败、MIME 不匹配。
- `telegram-file-id-import.test.ts`：图库导入、真实案例导入、slug 冲突、重复 externalMessageId、失败清理。

### 8.2 路由测试

- 无 token 返回 `401`。
- 无权限 token 返回 `403`。
- disabled/expired token 返回 `403`。
- sourceBotKey 不在允许列表返回 `403`。
- 图库 JSON 请求成功返回 `pending_media_fetch`。
- 真实案例 JSON 请求成功返回 `pending_media_fetch`。
- 重复 `externalMessageId` 返回 duplicate，不新增目标记录。
- 状态查询只能查询同 token 创建的 importId。

### 8.3 手动验收

- 在 dev Worker 配置 Telegram Bot Token secret。
- 在 dev 后台创建 Import Token，并允许指定 `sourceBotKey`。
- 用 curl 提交图库 file_id 样例，轮询到 `draft_created`，后台确认草稿、封面、图片顺序和标签。
- 用 curl 提交真实案例 file_id 样例，轮询到 `draft_created`，后台确认草稿和 2-9 张图片。
- 重复提交同一 `externalMessageId`，确认没有重复草稿。
- 禁用 token 后再次提交，确认返回 `403`。

## 9. 部署与配置

新增环境变量或 secret：
- `IMPORT_TOKEN_DAILY_LIMIT`：默认 `500`。
- `TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT`：`sourceBotKey=ops_gallery_bot` 对应 Bot Token。

命名规则：
- `sourceBotKey` 使用小写下划线，例如 `ops_gallery_bot`。
- secret 名称使用大写下划线，例如 `TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT`。

部署步骤：
- 应用 D1 migration。
- 配置 dev Telegram Bot Token secret。
- 部署 API Worker dev 环境。
- 在 dev 后台创建 Import Token。
- 使用 API 文档样例完成导入验收。
- 验收通过后再部署生产 API。

生产注意事项：
- 不在文档、日志、Issue、PR 或聊天中粘贴真实 Import Token 或 Telegram Bot Token。
- 如果 Import Token 泄露，Owner 需立即禁用该 token 并创建新 token。
- 如果 Telegram Bot Token 泄露，需在 BotFather 轮换 token 并更新 Cloudflare secret。
- 首期 Web Worker 只需新增后台 Token/导入记录页面时才需要部署。
