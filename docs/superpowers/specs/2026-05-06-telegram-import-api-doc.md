# Telegram 导入 API 对接文档

本文档面向自定义 Telegram Bot 开发者，说明如何把 Telegram 消息解析为结构化字段，并通过 MeiGallery 导入 API 创建图库或真实案例草稿。

## 1. 接入概览

**Base URL**

- 生产：`https://api.616618.xyz`
- Dev：`https://meigallery-api-dev.250770503.workers.dev`

**Endpoint**

- `POST /api/imports/telegram`

**认证**

```http
Authorization: Bearer mgi_xxx
```

**Content-Type**

使用 `multipart/form-data`。不要手动拼接 boundary，交给 HTTP 客户端自动生成。

**请求字段**

- `metadata`：JSON 字符串，必填。
- `files`：图片文件，可重复出现，必填。

**结果**

- API 只创建草稿。
- API 不发布图库或真实案例。
- API 不保存 Telegram Bot Token。
- API 不接受 Telegram `file_id`，Bot 必须先下载文件，再 multipart 上传。

## 2. 限制

| 项目 | 限制 |
|------|------|
| 图片 MIME | `image/jpeg`、`image/png`、`image/webp` |
| 单张图片大小 | 最大 10MB |
| 图库图片数量 | 1-30 张 |
| 真实案例图片数量 | 2-9 张 |
| metadata 大小 | 最大 20KB |
| 默认总请求体安全上限 | 80MB |
| 创建状态 | 固定 `draft` |

Cloudflare 账户层也有请求体大小限制。当前官方文档显示 Free/Pro 为 100MB，Business 为 200MB，Enterprise 默认为 500MB。Bot 应避免一次上传接近上限的大量原图；如果总大小接近 80MB，建议压缩图片或拆分为多次导入。

## 3. 图库导入

### 3.1 Metadata Schema

```ts
type GalleryImportMetadata = {
  type: 'gallery'
  source: 'telegram'
  externalMessageId: string
  title: string
  slug: string
  summary?: string
  bodyMd?: string
  requiredLevelRank?: 0 | 10 | 20
  tags?: string[]
  coverFileName?: string
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 固定 `gallery` |
| `source` | 是 | 固定 `telegram` |
| `externalMessageId` | 是 | Telegram 来源消息唯一键，建议 `${chatId}:${messageId}` |
| `title` | 是 | 图库标题，1-80 字 |
| `slug` | 是 | 小写字母、数字、短横线，3-120 字符 |
| `summary` | 否 | 摘要，最多 160 字 |
| `bodyMd` | 否 | Markdown 正文，最多 5000 字 |
| `requiredLevelRank` | 否 | `0` 免费、`10` VIP、`20` SVIP，默认 `0` |
| `tags` | 否 | 标签名称数组，最多 30 个 |
| `coverFileName` | 否 | 封面文件名，必须匹配上传文件名；不传则默认第一张 |

### 3.2 curl 示例

```bash
curl -X POST "https://api.616618.xyz/api/imports/telegram" \
  -H "Authorization: Bearer mgi_xxx" \
  -F 'metadata={"type":"gallery","source":"telegram","externalMessageId":"-1001234567890:456","title":"加拿大-多伦多 172D Lina","slug":"toronto-lina-001","summary":"一句话摘要","bodyMd":"正文 Markdown","requiredLevelRank":10,"tags":["加拿大","多伦多","留学生","旅拍"],"coverFileName":"001.jpg"};type=application/json' \
  -F "files=@./001.jpg;type=image/jpeg" \
  -F "files=@./002.jpg;type=image/jpeg"
```

### 3.3 成功响应

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "targetId": "gal_abc123",
  "status": "draft",
  "uploadedCount": 2,
  "failedCount": 0,
  "files": [
    { "filename": "001.jpg", "id": "ma_001", "sortOrder": 0 },
    { "filename": "002.jpg", "id": "ma_002", "sortOrder": 1 }
  ]
}
```

## 4. 真实案例导入

### 4.1 Metadata Schema

```ts
type TestimonialImportMetadata = {
  type: 'testimonial_case'
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
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 固定 `testimonial_case` |
| `source` | 是 | 固定 `telegram` |
| `externalMessageId` | 是 | Telegram 来源消息唯一键，建议 `${chatId}:${messageId}` |
| `title` | 是 | 案例标题，1-80 字 |
| `slug` | 是 | 小写字母、数字、短横线，3-120 字符 |
| `summary` | 否 | 摘要，最多 160 字 |
| `bodyMd` | 否 | Markdown 正文，最多 5000 字 |
| `featured` | 否 | 是否首页精选，默认 `true`；草稿不会公开展示 |
| `sortOrder` | 否 | 后台排序，默认 `0` |
| `seoTitle` | 否 | SEO 标题 |
| `seoDescription` | 否 | SEO 描述 |

真实案例必须上传 2-9 张图片。Bot 需要确保图片已授权且已脱敏；API 只做格式和数量校验，不替代人工审核。

### 4.2 curl 示例

```bash
curl -X POST "https://api.616618.xyz/api/imports/telegram" \
  -H "Authorization: Bearer mgi_xxx" \
  -F 'metadata={"type":"testimonial_case","source":"telegram","externalMessageId":"-1001234567890:789","title":"会员反馈 2026-05-06","slug":"member-feedback-2026-05-06","summary":"已授权、已脱敏的反馈摘要。","bodyMd":"## 反馈说明\n\n正文已脱敏。","featured":true,"sortOrder":0};type=application/json' \
  -F "files=@./feedback-1.jpg;type=image/jpeg" \
  -F "files=@./feedback-2.jpg;type=image/jpeg"
```

### 4.3 成功响应

```json
{
  "importId": "eir_def456",
  "type": "testimonial_case",
  "targetId": "tc_def456",
  "status": "draft",
  "uploadedCount": 2,
  "failedCount": 0,
  "files": [
    { "filename": "feedback-1.jpg", "id": "tci_001", "sortOrder": 0 },
    { "filename": "feedback-2.jpg", "id": "tci_002", "sortOrder": 1 }
  ]
}
```

## 5. 幂等与重试

API 使用 `token + source + externalMessageId` 做幂等判断。

同一个 token 重复提交同一个 `externalMessageId`：

```json
{
  "importId": "eir_abc123",
  "type": "gallery",
  "targetId": "gal_abc123",
  "status": "duplicate",
  "message": "该 Telegram 消息已导入"
}
```

Bot 端建议：
- 每条 Telegram 消息固定生成一个 `externalMessageId`。
- 网络超时后可以用同一个 `externalMessageId` 重试。
- 如果确实需要把同一 Telegram 消息重新导入为新草稿，应使用新的 `externalMessageId`，例如追加 `:retry-1`。

## 6. 错误响应

### 6.1 错误格式

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

### 6.2 常见错误码

| HTTP | code | 说明 | Bot 处理建议 |
|------|------|------|-------------|
| 401 | `IMPORT_TOKEN_MISSING` | 未传 token | 检查 Authorization header |
| 401 | `IMPORT_TOKEN_INVALID` | token 不存在或格式错误 | 停止重试，重新配置 token |
| 403 | `IMPORT_TOKEN_DISABLED` | token 已禁用 | 停止重试，联系站长 |
| 403 | `IMPORT_TOKEN_EXPIRED` | token 已过期 | 停止重试，申请新 token |
| 403 | `IMPORT_PERMISSION_DENIED` | token 缺少权限 | 停止重试，调整 token 权限 |
| 400 | `VALIDATION_ERROR` | metadata 或文件不合法 | 修正字段后重试 |
| 409 | `SLUG_CONFLICT` | slug 已存在 | 换 slug 后重试 |
| 413 | `REQUEST_TOO_LARGE` | 请求体超过应用层或 Cloudflare 限制 | 压缩图片或减少文件数 |
| 429 | `RATE_LIMITED` | 触发速率限制 | 延迟后重试 |
| 429 | `DAILY_IMPORT_LIMIT_EXCEEDED` | token 达到每日导入上限 | 次日重试或联系站长 |
| 500 | `IMPORT_WRITE_FAILED` | 服务端写入失败 | 使用同一 `externalMessageId` 重试 |

## 7. Node.js Bot 示例

以下示例展示 Bot 已经把 Telegram 图片下载到本地路径后的上传方式。

```ts
import { createReadStream } from 'node:fs'
import FormData from 'form-data'
import fetch from 'node-fetch'

type ImportFile = {
  path: string
  filename: string
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
}

async function importGallery(files: ImportFile[]) {
  const metadata = {
    type: 'gallery',
    source: 'telegram',
    externalMessageId: '-1001234567890:456',
    title: '加拿大-多伦多 172D Lina',
    slug: 'toronto-lina-001',
    summary: '一句话摘要',
    bodyMd: '正文 Markdown',
    requiredLevelRank: 10,
    tags: ['加拿大', '多伦多', '留学生', '旅拍'],
    coverFileName: files[0]?.filename,
  }

  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' })
  for (const file of files) {
    form.append('files', createReadStream(file.path), {
      filename: file.filename,
      contentType: file.contentType,
    })
  }

  const response = await fetch('https://api.616618.xyz/api/imports/telegram', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MEIGALLERY_IMPORT_TOKEN}`,
      ...form.getHeaders(),
    },
    body: form as any,
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(`${result.code || response.status}: ${result.message || '导入失败'}`)
  }
  return result
}
```

## 8. Bot 端实现建议

- Bot 只处理指定 chat、指定 topic 或指定管理员转发的消息，避免误导入。
- Bot 下载 Telegram 文件后先检查 MIME 和大小，减少无效 API 请求。
- Bot 对图片按 Telegram media group 顺序排序，再按顺序 append `files`。
- Bot 生成 slug 时只使用小写字母、数字和短横线。
- Bot 保存 `externalMessageId -> importId/targetId` 映射，便于后续排查。
- Bot 遇到 `401`、`403`、`409` 不应无限重试。
- Bot 遇到 `429` 应指数退避，至少等待 30 秒后重试。
- Bot 遇到网络超时或 `500` 可用同一 `externalMessageId` 重试。

## 9. 上线前自测清单

- 使用 dev Base URL 完成一次图库导入。
- 使用 dev Base URL 完成一次真实案例导入。
- 重复提交同一个 `externalMessageId`，确认返回 `duplicate`。
- 禁用 token 后请求，确认返回 `403`。
- 上传不支持的 GIF，确认返回 `400 VALIDATION_ERROR`。
- 上传超过 80MB 总大小的请求，确认返回 `413 REQUEST_TOO_LARGE`。
- 登录后台确认导入内容均为草稿。
- 登录后台确认审计日志能看到导入来源和 token id。
