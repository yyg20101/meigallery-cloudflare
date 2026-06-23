# Telegram 外部导入 API 对接说明

本文档定义平台侧对外提供的 Telegram `file_id` 导入能力。当前项目不内置 Telegram Bot；Bot、Ops Hub 或其他自动化服务负责监听 Telegram、整理消息和提交结构化 JSON，平台负责鉴权、拉取媒体、写入 R2、创建草稿和记录状态。

## 1. 对接边界

平台侧负责：

- 管理 Import Token，并只保存 SHA-256 hash。
- 校验 `Authorization: Bearer <import_token>`、权限、过期时间和 `sourceBotKey` 白名单。
- 校验 payload、执行幂等去重、拉取 Telegram 文件、写入 R2。
- 创建 `gallery` 或 `case` 草稿。
- 提供导入状态查询、Bot 侧重试和后台失败重试。

Bot 侧负责：

- 监听 Telegram 消息、相册或命令。
- 解析标题、slug、摘要、标签、会员等级、目标类型和图片顺序。
- 使用 Bot 自己上下文中的 Telegram `file_id` 组装 payload。
- 处理接口返回、轮询状态，并在需要时调用重试接口。

## 2. 环境配置

每个 `sourceBotKey` 都必须对应一个 API Worker secret。命名规则：

```text
sourceBotKey: ops_gallery_bot
secret:       TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT
```

示例命令：

```bash
corepack pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT --env dev
corepack pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_CASE_BOT --env dev

corepack pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT
corepack pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_CASE_BOT
```

后台创建 Import Token 时，需要配置：

- `permissions`：图库导入使用 `gallery:create`，案例导入使用 `case:create`。
- `allowedSourceBotKeys`：只填写允许该 token 使用的 `sourceBotKey`，例如 `ops_gallery_bot`。
- `expiresAt`：建议生产 token 设置明确过期时间，并按运营周期轮换。

## 3. 创建导入

```http
POST /api/imports/telegram-file-id
Authorization: Bearer <import_token>
Content-Type: application/json
```

图库示例：

```json
{
  "metadata": {
    "type": "gallery",
    "source": "telegram",
    "externalMessageId": "-1001234567890:801",
    "title": "夏日写真",
    "slug": "summer-portrait-001",
    "summary": "户外清新风格写真",
    "bodyMd": "导入后由管理员审核正文。",
    "requiredLevelRank": 10,
    "tags": ["长发", "户外", "清新"]
  },
  "telegram": {
    "sourceBotKey": "ops_gallery_bot",
    "sourceChatId": "-1001234567890",
    "sourceMessageId": "801",
    "mediaGroupId": "album-801"
  },
  "files": [
    {
      "fileId": "AgACAgUAAxkBAAIB...",
      "fileUniqueId": "AQAD...",
      "filename": "001.jpg",
      "mimeType": "image/jpeg",
      "sortOrder": 0,
      "isCover": true
    }
  ]
}
```

案例示例：

```json
{
  "metadata": {
    "type": "case",
    "source": "telegram",
    "externalMessageId": "-1001234567890:901",
    "title": "会员反馈案例",
    "slug": "member-case-001",
    "summary": "真实案例摘要",
    "featured": true,
    "sortOrder": 10,
    "seoTitle": "会员反馈案例",
    "seoDescription": "真实案例导入示例"
  },
  "telegram": {
    "sourceBotKey": "ops_case_bot",
    "sourceChatId": "-1001234567890",
    "sourceMessageId": "901"
  },
  "files": [
    {
      "fileId": "AgACAgUAAxkBAAIC...",
      "mimeType": "image/jpeg",
      "sortOrder": 0,
      "isCover": true
    },
    {
      "fileId": "AgACAgUAAxkBAAID...",
      "mimeType": "image/jpeg",
      "sortOrder": 1
    }
  ]
}
```

成功响应：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "status": "pending_media_fetch",
  "receivedFileCount": 1
}
```

重复提交同一 `token_id + source + externalMessageId` 会返回 `duplicate`，不会创建第二条记录：

```json
{
  "importId": "eir_xxx",
  "type": "gallery",
  "targetId": null,
  "status": "duplicate",
  "currentStatus": "pending_media_fetch",
  "message": "该 Telegram 消息已导入"
}
```

## 4. Payload 规则

- `metadata.type` 只能是 `gallery` 或 `case`。
- `metadata.source` 必须是 `telegram`。
- `metadata.externalMessageId` 建议使用 `chat_id:message_id`，长度不超过 160。
- `metadata.title` 必填，最多 80 字。
- `metadata.slug` 只能包含小写字母、数字和短横线，长度 3-120。
- `metadata.requiredLevelRank` 只能是 `0`、`10`、`20`，缺省为 `0`。
- `metadata.tags` 最多 30 个，每个 1-30 字。
- `telegram.sourceBotKey` 只能包含小写字母、数字和下划线，长度 3-64。
- `gallery` 需要 1-30 张图片。
- `case` 需要 2-9 张图片。
- 图片 MIME 只支持 `image/jpeg`、`image/png`、`image/webp`。
- 单张图片下载后大小不能超过 10MB。
- `files[].sortOrder` 必须是 0-999 的整数，且不能重复。

## 5. 查询状态

```http
GET /api/imports/:importId
Authorization: Bearer <import_token>
```

只允许查询同一个 Import Token 创建的导入记录。状态包括：

| 状态 | 含义 |
|------|------|
| `pending_media_fetch` | 已接收，等待拉取 Telegram 文件 |
| `fetching_media` | 正在拉取并写入 R2 |
| `draft_created` | 已创建图库或案例草稿 |
| `failed` | 导入失败，已尽量清理中间资源 |
| `partial_failed` | 预留状态，当前实现不会主动产生 |

## 6. 重试

Bot 侧重试：

```http
POST /api/imports/:importId/retry
Authorization: Bearer <import_token>
```

后台重试：

```http
POST /api/admin/external-import-records/:id/retry
```

重试规则：

- 只允许重试 `failed` 状态。
- 仍会重新检查原 Import Token 的权限和 `sourceBotKey` 白名单。
- 如果失败记录仍有关联草稿、R2 key 或目标文件 ID，返回 `IMPORT_RETRY_CLEANUP_REQUIRED`。
- 重试成功后状态回到 `pending_media_fetch`，并异步重新处理。

## 7. 常见错误码

| code | HTTP | 说明 |
|------|------|------|
| `IMPORT_TOKEN_MISSING` | 401 | 缺少 Bearer token |
| `IMPORT_TOKEN_INVALID` | 401 | token 无效 |
| `IMPORT_TOKEN_DISABLED` | 403 | token 已禁用 |
| `IMPORT_TOKEN_EXPIRED` | 403 | token 已过期 |
| `IMPORT_PERMISSION_DENIED` | 403 | token 缺少 `gallery:create` 或 `case:create` |
| `IMPORT_SOURCE_BOT_NOT_ALLOWED` | 403 | `sourceBotKey` 不在 token 白名单 |
| `IMPORT_VALIDATION_FAILED` | 400 / 415 | payload 或 Content-Type 不符合要求 |
| `IMPORT_DAILY_LIMIT_EXCEEDED` | 429 | token 当日导入次数超过上限 |
| `TELEGRAM_BOT_TOKEN_MISSING` | 500 | API Worker 未配置对应 Bot Token secret |
| `TELEGRAM_FILE_FETCH_FAILED` | 502 | Telegram `getFile` 或文件下载失败 |
| `IMPORT_TARGET_SLUG_CONFLICT` | 409 | 目标图库或案例 slug 已存在 |
| `IMPORT_RETRY_NOT_ALLOWED` | 409 | 当前状态不允许重试 |
| `IMPORT_RETRY_CLEANUP_REQUIRED` | 409 | 失败记录仍有未清理资源 |

## 8. 验收口径

平台侧验收通过条件：

- 后台 Owner 能创建 Import Token，明文 token 只显示一次。
- 外部 Bot 使用有效 token 和允许的 `sourceBotKey` 调用创建接口后返回 `pending_media_fetch`。
- API 能根据 Telegram `file_id` 拉取图片、写入 R2，并创建 `gallery` 或 `case` 草稿。
- 重复 `externalMessageId` 不创建重复草稿。
- 失败记录可通过 Bot 侧或后台详情页重试。
- 后台外部导入记录能查看状态、文件、错误摘要和目标草稿链接。
- 日志、后台页面和响应体不输出 Import Token 明文、Telegram Bot Token、Telegram 文件下载 URL 或 R2 私有直链。
