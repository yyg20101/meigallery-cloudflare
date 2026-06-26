# Telegram file_id 导入 API 对接文档

本文档面向自定义 Telegram Bot / Ops Hub 开发者，说明如何把 Telegram 消息解析为结构化字段，并通过 MeiGallery `file_id` 异步导入 API 创建图库或真实案例草稿。

> 当前实现类型已经统一为 `gallery` / `case`。旧 `testimonial_case` 仅属于历史命名，新的请求会被校验拒绝。

## 1. 接入概览

**Base URL**

- 生产：`https://api.616618.xyz`

**Endpoints**

- `POST /api/imports/telegram-file-id`：提交导入请求。
- `GET /api/imports/:importId`：查询导入状态。
- `POST /api/imports/:importId/retry`：重试失败导入。

**认证**

```http
Authorization: Bearer mgi_xxx
```

**Content-Type**

```http
Content-Type: application/json
```

**结果**

- API 接收请求后返回 `pending_media_fetch`。
- MeiGallery 异步拉取 Telegram 文件并保存到 R2。
- API 只创建草稿，不发布图库或真实案例。
- Bot 不需要下载图片，也不需要 multipart 上传。

## 2. 状态流

| 状态 | 含义 |
|------|------|
| `pending_media_fetch` | 已接收请求，等待异步任务拉取媒体 |
| `fetching_media` | 正在调用 Telegram API 下载并保存文件 |
| `draft_created` | 草稿和媒体均创建成功 |
| `failed` | 导入失败，未创建可用草稿；可调用 retry 接口重试 |
| `duplicate` | 相同 token/source/externalMessageId 已导入 |

Bot 端应在提交成功后轮询 `GET /api/imports/:importId`，直到状态进入 `draft_created` 或 `failed`。

`failed` 的含义是没有可用草稿：`targetId` 为 `null`，MeiGallery 不会保留可发布的图库/真实案例草稿，也不会保留目标媒体记录。状态响应里的文件级结果只用于排查本次尝试，不代表这些图片已可用。

## 3. 限制

| 项目 | 限制 |
|------|------|
| 支持文件来源 | Telegram `file_id` |
| 图片 MIME 声明 | `image/jpeg`、`image/png`、`image/webp` |
| 单张图片真实大小 | 最大 10MB，由 MeiGallery 拉取后校验 |
| 图库图片数量 | 1-30 个 file_id |
| 真实案例图片数量 | 2-9 个 file_id |
| metadata 大小 | 最大 20KB |
| 创建状态 | 固定 `draft` |

视频文件首期不支持。Bot 不应提交 `video/mp4` 或 Telegram video/document 视频引用。

## 4. 图库导入

### 4.1 Request Schema

```ts
type GalleryFileIdImportRequest = {
  metadata: {
    type: 'gallery'
    source: 'telegram'
    externalMessageId: string
    title: string
    slug: string
    summary?: string
    bodyMd?: string
    requiredLevelRank?: 0 | 10 | 20
    tags?: string[]
  }
  telegram: {
    sourceBotKey: string
    sourceChatId: string
    sourceMessageId: string
    mediaGroupId?: string
  }
  files: Array<{
    fileId: string
    fileUniqueId?: string
    filename?: string
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
    sortOrder: number
    isCover?: boolean
  }>
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `metadata.type` | 是 | 固定 `gallery` |
| `metadata.source` | 是 | 固定 `telegram` |
| `metadata.externalMessageId` | 是 | Telegram 来源消息唯一键，建议 `${chatId}:${messageId}` |
| `metadata.title` | 是 | 图库标题，1-80 字 |
| `metadata.slug` | 是 | 小写字母、数字、短横线，3-120 字符 |
| `metadata.requiredLevelRank` | 否 | `0` 免费、`10` VIP、`20` SVIP，默认 `0` |
| `telegram.sourceBotKey` | 是 | MeiGallery 预配置的 Bot key，例如 `ops_gallery_bot` |
| `telegram.sourceChatId` | 是 | Telegram chat id，字符串形式 |
| `telegram.sourceMessageId` | 是 | Telegram message id，字符串形式 |
| `telegram.mediaGroupId` | 否 | Telegram media group id |
| `files[].fileId` | 是 | Telegram `file_id` |
| `files[].fileUniqueId` | 否 | Telegram `file_unique_id`，建议传入用于追踪 |
| `files[].mimeType` | 是 | Bot 侧声明的 MIME，MeiGallery 下载后会再次校验 |
| `files[].sortOrder` | 是 | 图片排序，从 0 开始 |
| `files[].isCover` | 否 | 第一张 `true` 图片作为封面；未传则第一张为封面 |

### 4.2 curl 示例

```bash
curl -X POST "https://api.616618.xyz/api/imports/telegram-file-id" \
  -H "Authorization: Bearer mgi_xxx" \
  -H "Content-Type: application/json" \
  --data '{
    "metadata": {
      "type": "gallery",
      "source": "telegram",
      "externalMessageId": "-1001234567890:456",
      "title": "加拿大-多伦多 172D Lina",
      "slug": "toronto-lina-001",
      "summary": "一句话摘要",
      "bodyMd": "正文 Markdown",
      "requiredLevelRank": 10,
      "tags": ["加拿大", "多伦多", "留学生", "旅拍"]
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
  }'
```

### 4.3 接收成功响应

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "status": "pending_media_fetch",
  "receivedFileCount": 1
}
```

## 5. 真实案例导入

### 5.1 Request Schema

```ts
type CaseFileIdImportRequest = {
  metadata: {
    type: 'case'
    source: 'telegram'
    externalMessageId: string
    title: string
    slug: string
    summary?: string
    bodyMd?: string
    featured?: boolean
    sortOrder?: number
    seoTitle?: string
    seoDescription?: string
  }
  telegram: {
    sourceBotKey: string
    sourceChatId: string
    sourceMessageId: string
    mediaGroupId?: string
  }
  files: Array<{
    fileId: string
    fileUniqueId?: string
    filename?: string
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
    sortOrder: number
  }>
}
```

真实案例必须提交 2-9 个图片 `file_id`。Bot 需要确保图片已授权且已脱敏；API 只做格式、数量和下载后校验，不替代人工审核。

### 5.2 curl 示例

```bash
curl -X POST "https://api.616618.xyz/api/imports/telegram-file-id" \
  -H "Authorization: Bearer mgi_xxx" \
  -H "Content-Type: application/json" \
  --data '{
    "metadata": {
      "type": "case",
      "source": "telegram",
      "externalMessageId": "-1001234567890:789",
      "title": "会员反馈 2026-05-06",
      "slug": "member-feedback-2026-05-06",
      "summary": "已授权、已脱敏的反馈摘要。",
      "bodyMd": "## 反馈说明\n\n正文已脱敏。",
      "featured": true,
      "sortOrder": 0
    },
    "telegram": {
      "sourceBotKey": "ops_gallery_bot",
      "sourceChatId": "-1001234567890",
      "sourceMessageId": "789",
      "mediaGroupId": "987654"
    },
    "files": [
      {
        "fileId": "AgACAgFeedback1...",
        "fileUniqueId": "AQADFeedback1...",
        "filename": "feedback-1.jpg",
        "mimeType": "image/jpeg",
        "sortOrder": 0
      },
      {
        "fileId": "AgACAgFeedback2...",
        "fileUniqueId": "AQADFeedback2...",
        "filename": "feedback-2.jpg",
        "mimeType": "image/jpeg",
        "sortOrder": 1
      }
    ]
  }'
```

## 6. 状态查询

```bash
curl "https://api.616618.xyz/api/imports/eir_abc123" \
  -H "Authorization: Bearer mgi_xxx"
```

处理中响应：

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "status": "fetching_media",
  "targetId": null,
  "fileCount": 2,
  "fetchedCount": 1,
  "failedCount": 0,
  "files": [
    { "filename": "001.jpg", "status": "completed", "sortOrder": 0 },
    { "filename": "002.jpg", "status": "fetching", "sortOrder": 1 }
  ]
}
```

完成响应：

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "status": "draft_created",
  "targetId": "gal_abc123",
  "fileCount": 2,
  "fetchedCount": 2,
  "failedCount": 0,
  "files": [
    { "filename": "001.jpg", "status": "completed", "sortOrder": 0 },
    { "filename": "002.jpg", "status": "completed", "sortOrder": 1 }
  ]
}
```

失败响应：

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "status": "failed",
  "targetId": null,
  "fileCount": 2,
  "fetchedCount": 1,
  "failedCount": 1,
  "retryCount": 0,
  "message": "Telegram getFile 调用失败",
  "error": {
    "code": "TELEGRAM_GET_FILE_FAILED",
    "message": "Telegram getFile 调用失败"
  },
  "files": [
    { "filename": "001.jpg", "status": "completed", "sortOrder": 0 },
    { "filename": "002.jpg", "status": "failed", "sortOrder": 1, "errorMessage": "Telegram getFile 调用失败" }
  ]
}
```

## 7. 幂等与重试

API 使用 `token + source + externalMessageId` 做幂等判断。

同一个 token 重复提交同一个 `externalMessageId`：

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "targetId": "gal_abc123",
  "status": "duplicate",
  "currentStatus": "draft_created",
  "message": "该 Telegram 消息已导入"
}
```

duplicate 响应中的 `importId` 是原导入记录 ID。Bot 应继续使用该 `importId` 查询状态：

```bash
curl "https://api.616618.xyz/api/imports/eir_abc123" \
  -H "Authorization: Bearer mgi_xxx"
```

Bot 端建议：
- 每条 Telegram 消息或 media group 固定生成一个 `externalMessageId`。
- 网络超时后可以用同一个 `externalMessageId` 重试。
- 异步处理进入 `failed` 后，优先调用 `POST /api/imports/:importId/retry`，不要重新提交同一个 metadata。
- 如果确实需要把同一 Telegram 消息重新导入为新草稿，应使用新的 `externalMessageId`，例如追加 `:retry-1`。

### 7.1 重试失败导入

只有 `failed` 状态可以重试。`pending_media_fetch`、`fetching_media`、`draft_created` 和 `duplicate` 都不允许重试。

```bash
curl -X POST "https://api.616618.xyz/api/imports/eir_abc123/retry" \
  -H "Authorization: Bearer mgi_xxx"
```

成功响应：

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "status": "pending_media_fetch",
  "retryCount": 1,
  "message": "导入重试已开始"
}
```

不允许重试响应：

```json
{
  "statusCode": 409,
  "code": "IMPORT_RETRY_NOT_ALLOWED",
  "message": "当前导入状态不允许重试"
}
```

如果失败导入仍有待清理资源，API 会拒绝重试：

```json
{
  "statusCode": 409,
  "code": "IMPORT_RETRY_CLEANUP_REQUIRED",
  "message": "失败导入仍有待清理资源，暂不能重试"
}
```

Bot 端建议：
- 只有状态查询返回 `failed` 后才调用 retry。
- retry 成功后继续轮询 `GET /api/imports/:importId`。
- retry 不会创建新的 `externalMessageId`，也不会创建新的 `importId`。
- 如果返回 `IMPORT_RETRY_CLEANUP_REQUIRED`，不要自动重试，标记为人工处理。
- 如果 retry 多次仍失败，应标记为人工处理，不要无限重试。

## 8. 错误响应

### 8.1 错误格式

```json
{
  "statusCode": 400,
  "code": "IMPORT_VALIDATION_FAILED",
  "message": "标题为必填且不能超过 80 字"
}
```

### 8.2 常见错误码

| HTTP | code | 说明 | Bot 处理建议 |
|------|------|------|-------------|
| 401 | `IMPORT_TOKEN_MISSING` | 未传 token | 检查 Authorization header |
| 401 | `IMPORT_TOKEN_INVALID` | token 不存在或格式错误 | 停止重试，重新配置 token |
| 403 | `IMPORT_TOKEN_DISABLED` | token 已禁用 | 停止重试，联系站长 |
| 403 | `IMPORT_TOKEN_EXPIRED` | token 已过期 | 停止重试，申请新 token |
| 403 | `IMPORT_PERMISSION_DENIED` | token 缺少权限 | 停止重试，调整 token 权限 |
| 403 | `IMPORT_SOURCE_BOT_NOT_ALLOWED` | sourceBotKey 不允许 | 停止重试，调整 token 允许列表 |
| 400 | `IMPORT_VALIDATION_FAILED` | metadata、telegram 或 files 不合法 | 修正字段后重试 |
| 409 | `IMPORT_TARGET_SLUG_CONFLICT` | slug 已存在；通过状态查询的 `error.code` 返回 | 换 slug 后使用新的 `externalMessageId` 重新提交 |
| 409 | `IMPORT_RETRY_NOT_ALLOWED` | 当前导入状态不允许重试 | 仅在 `failed` 状态调用 retry |
| 409 | `IMPORT_RETRY_CLEANUP_REQUIRED` | 失败导入仍有待清理资源 | 停止自动重试，人工处理 |
| 500 | `IMPORT_PROCESS_FAILED` | 导入处理失败 | 使用同一 `externalMessageId` 查询状态或人工处理 |
| 500 | `TELEGRAM_BOT_TOKEN_MISSING` | MeiGallery 未配置对应 sourceBotKey 的 Bot Token | 停止重试，联系站长配置 Worker secret |
| 502 | `TELEGRAM_GET_FILE_FAILED` | Telegram getFile 调用失败 | 可在 `failed` 后调用 retry |
| 502 | `TELEGRAM_DOWNLOAD_FAILED` | Telegram 文件下载失败 | 可在 `failed` 后调用 retry |
| 400 | `TELEGRAM_FILE_TOO_LARGE` | Telegram 文件超过 10MB | 停止自动重试，压缩或替换图片 |
| 400 | `TELEGRAM_FILE_TYPE_UNSUPPORTED` | 下载后的真实 MIME 不支持 | 停止自动重试，替换图片 |

当前版本未实现按 token 的每日额度限制；Bot 端仍应自行做指数退避，避免网络异常时循环提交。

异步阶段的 Telegram 下载失败不会通过提交接口直接返回；Bot 应通过状态查询读取 `failed` 状态和文件级错误，然后调用 `POST /api/imports/:importId/retry` 发起重试。

## 9. Node.js Bot 示例

```ts
type TelegramFileRef = {
  fileId: string
  fileUniqueId?: string
  filename?: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  sortOrder: number
  isCover?: boolean
}

async function submitGalleryImport(files: TelegramFileRef[]) {
  const body = {
    metadata: {
      type: 'gallery',
      source: 'telegram',
      externalMessageId: '-1001234567890:456',
      title: '加拿大-多伦多 172D Lina',
      slug: 'toronto-lina-001',
      summary: '一句话摘要',
      bodyMd: '正文 Markdown',
      requiredLevelRank: 10,
      tags: ['加拿大', '多伦多', '留学生', '旅拍'],
    },
    telegram: {
      sourceBotKey: 'ops_gallery_bot',
      sourceChatId: '-1001234567890',
      sourceMessageId: '456',
      mediaGroupId: '123456',
    },
    files,
  }

  const response = await fetch('https://api.616618.xyz/api/imports/telegram-file-id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MEIGALLERY_IMPORT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(`${result.code || response.status}: ${result.message || '导入提交失败'}`)
  }
  return result as { importId: string; status: string }
}

async function pollImport(importId: string) {
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`https://api.616618.xyz/api/imports/${importId}`, {
      headers: { Authorization: `Bearer ${process.env.MEIGALLERY_IMPORT_TOKEN}` },
    })
    const result = await response.json()
    if (result.status === 'draft_created' || result.status === 'failed') return result
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  throw new Error(`导入超时: ${importId}`)
}

async function retryImport(importId: string) {
  const response = await fetch(`https://api.616618.xyz/api/imports/${importId}/retry`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MEIGALLERY_IMPORT_TOKEN}` },
  })
  const result = await response.json()
  if (!response.ok) {
    throw new Error(`${result.code || response.status}: ${result.message || '导入重试失败'}`)
  }
  return result as { importId: string; status: string; retryCount: number }
}
```

## 10. Bot 端实现建议

- Bot 只处理指定 chat、指定 topic 或指定管理员转发的消息，避免误导入。
- Bot 对 Telegram media group 先聚合完整，再提交一次导入请求。
- Bot 对图片按 Telegram media group 顺序排序，并生成连续 `sortOrder`。
- Bot 生成 slug 时只使用小写字母、数字和短横线。
- Bot 保存 `externalMessageId -> importId/status` 映射，便于后续排查。
- Bot 遇到 `401`、`403`、`409` 不应无限重试。
- Bot 遇到 `429` 应指数退避，至少等待 30 秒后重试。
- Bot 遇到提交接口网络超时或 `500` 可用同一 `externalMessageId` 重试。
- Bot 查询到 `failed` 后应调用 `POST /api/imports/:importId/retry`，不要重新提交同一个导入请求。
- Bot 收到 duplicate 时，应使用响应里的 `importId` 查询原导入状态。
- Bot 提交成功后应轮询状态；如果超过 3 分钟仍未完成，应标记为待人工查看。

## 11. 上线前自测清单

- 使用生产 Base URL 和测试 Token 完成一次图库 file_id 导入。
- 使用生产 Base URL 和测试 Token 完成一次真实案例 file_id 导入。
- 轮询状态直到 `draft_created`。
- 构造一次失败导入并调用 `POST /api/imports/:importId/retry`，确认状态回到 `pending_media_fetch`。
- 重复提交同一个 `externalMessageId`，确认返回 `duplicate`。
- 使用 duplicate 响应的 `importId` 查询状态，确认可读取原导入记录。
- 禁用 token 后请求，确认返回 `403`。
- 使用未授权 `sourceBotKey` 请求，确认返回 `403 IMPORT_SOURCE_BOT_NOT_ALLOWED`。
- 提交 GIF MIME 声明，确认返回 `400 IMPORT_VALIDATION_FAILED`。
- 提交视频 MIME 声明，确认返回 `400 IMPORT_VALIDATION_FAILED`。
- 登录后台确认导入内容均为草稿。
- 登录后台确认审计日志能看到导入来源、sourceBotKey 和 token id。
