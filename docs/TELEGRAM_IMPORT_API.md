# Telegram 外部导入 API 对接说明

本文档定义平台侧对外提供的 Telegram `file_id` 导入能力。当前项目不内置 Telegram Bot；Bot、Ops Hub 或其他自动化服务负责监听 Telegram、整理消息和提交结构化 JSON，平台负责鉴权、拉取媒体、写入 R2、创建草稿和记录状态。

## 1. 对接边界

平台侧负责：

- 管理 Import Token，并只保存 SHA-256 hash。
- 校验 `Authorization: Bearer <import_token>`、权限、过期时间和 `sourceBotKey` 白名单。
- 校验 payload、执行幂等去重、拉取 Telegram 文件、写入 R2。
- 通过专用 Cloudflare Queue 执行媒体抓取；HTTP 请求只负责原子接收和入队。
- 创建 `gallery` 或 `case` 草稿。
- 提供导入状态查询、Bot 侧重试和后台失败重试。

Bot 侧负责：

- 监听 Telegram 消息、相册或命令。
- 解析标题、slug、摘要、标签、会员等级、目标类型和图片顺序。
- 使用 Bot 自己上下文中的 Telegram `file_id` 组装 payload。
- 处理接口返回、轮询状态，并在需要时调用重试接口。

Ops Hub 自动导入约定：

- Ops Hub 可以把授权 Telegram 源端中的图片消息或相册自动转成本文档定义的 JSON payload。
- MeiGallery 不解析 Telegram caption；`#gallery`、`#case`、`标题`、`slug`、`标签`、`等级` 等字段属于 Ops Hub 上游解析约定。
- MeiGallery 只接收标准化后的 `metadata.type=gallery` 或 `metadata.type=case`，旧 `testimonial_case` 会被拒绝。
- Ops Hub 应使用稳定 `externalMessageId` 和 slug；重复提交同一 `externalMessageId` 时 MeiGallery 返回 `duplicate`，不创建第二个草稿。
- 管理员可在 MeiGallery 后台 `/admin/external-import-records` 查看 Ops Hub 自动导入记录、文件状态、错误摘要和目标草稿链接。

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

API Worker 还必须配置 `TELEGRAM_IMPORT_QUEUE` producer/consumer，Queue 名为 `meigallery-import-telegram`。未配置时平台会保留已原子接收的 `pending_media_fetch` 记录并返回 `IMPORT_QUEUE_UNAVAILABLE`；调用方使用同一 `externalMessageId` 重试即可重新入队，不得改用 `waitUntil` 绕过队列。

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

主记录、全部 `files[]` 行和 accepted 审计由单个 D1 `batch` 原子写入。并发提交命中唯一键时返回已存在记录；任一文件行落库失败时整批回滚，不会留下文件数不完整的 pending 任务。每日 token 限额也在主记录 INSERT 条件内复核，不能通过并发请求超额。

## 4. Payload 规则

- `metadata.type` 只能是 `gallery` 或 `case`。
- `metadata.source` 必须是 `telegram`。
- 请求只保留文档声明的白名单字段；额外顶层、metadata、telegram 或 file 字段不会落库。
- JSON 请求体按字节流限制为 64 KiB；声明或实际读取超限、非法 UTF-8 和无效 JSON 均稳定返回 `IMPORT_VALIDATION_FAILED`，不会进入业务校验或 D1。
- `metadata.externalMessageId` 建议使用 `chat_id:message_id`，去除首尾空白后长度 1-160。
- `metadata.title` 必填，最多 80 字。
- `metadata.slug` 只能包含小写字母、数字和短横线，长度 3-120。
- `metadata.requiredLevelRank` 只能是 `0`、`10`、`20`，缺省为 `0`。
- `metadata.summary/bodyMd/seoTitle/seoDescription` 分别最多 160/5000/120/300 字；可选字段若提供必须是字符串。
- `metadata.featured` 必须是布尔值；`metadata.sortOrder` 必须是 0-1000000 的整数。
- `metadata.tags` 最多 30 个，每个 1-30 字；按 NFKC、空白和大小写规范化后去重。
- `telegram.sourceBotKey` 只能包含小写字母、数字和下划线，长度 3-64。
- `sourceChatId/sourceMessageId/mediaGroupId` 必须是字符串，长度分别不超过 128；`fileId/fileUniqueId/filename` 最长 512/256/255。
- `gallery` 需要 1-30 张图片。
- `case` 需要 2-9 张图片。
- 图片 MIME 只支持 `image/jpeg`、`image/png`、`image/webp`。
- 单张图片下载后大小不能超过 10MB。
- `files[].sortOrder` 必须是 0-999 的整数，且不能重复。
- `files[].isCover` 若提供必须是布尔值，单次 payload 最多一张封面。

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

`pending_media_fetch` 和 `fetching_media` 响应同时返回 `processingStartedAt`、`processingHeartbeatAt`、`processingLeaseExpiresAt` 和 `recoveryAvailable`。入队派发与处理中租约均为 30 分钟；处理时在每次 Telegram 请求、R2 写入和文件状态推进前后续租，租约仍有效时不得恢复。同一消息在有效 fetching 租约内重复投递时不会并行抓取或 ack，而会请求 Queue 延迟 60 秒重试；只有租约为空或已过期时才允许条件接管。

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

过期处理恢复：

```http
POST /api/imports/:importId/recover-stale
Authorization: Bearer <import_token>

POST /api/admin/external-import-records/:id/recover-stale
```

重试规则：

- 只允许重试 `failed` 状态。
- 仍会重新检查原 Import Token 的权限和 `sourceBotKey` 白名单。
- 如果再次清理后仍有关联草稿、R2 key 或目标文件 ID，返回 `IMPORT_RETRY_CLEANUP_REQUIRED`。
- 重试会以可过期租约认领 failed 记录，再删除持久化 R2 key 和本次处理中目标；R2 与 D1 均清理成功后状态才回到 `pending_media_fetch` 并发送新 Queue token。HTTP 中断后，过期重试租约可由下一次 retry 替换。
- `recover-stale` 接受没有有效派发租约的 `pending_media_fetch`，或租约为空/已过期的 `fetching_media`；旧执行器 token 立即失效，不能覆盖恢复后的状态。有效租约或并发恢复返回 409。
- Queue 消息重投复用每个文件预先持久化的目标文件 ID 与 R2 key，不会因“R2 写入后 Worker 中断”生成新的孤儿 key。目标创建 batch 已成功但外部导入终态未落账时，重投识别同一个 `processing_target_id` 并直接完成 `draft_created` 收敛，不重复创建草稿。

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
| `IMPORT_QUEUE_UNAVAILABLE` | 503 | 专用 Telegram 导入 Queue 尚未配置 |
| `IMPORT_QUEUE_SEND_FAILED` | 503 | Queue 暂时无法接收消息；使用同一消息标识重试 |
| `TELEGRAM_BOT_TOKEN_MISSING` | 500 | API Worker 未配置对应 Bot Token secret |
| `TELEGRAM_GET_FILE_FAILED` | 502 | Telegram `getFile` 超时、失败或响应无效 |
| `TELEGRAM_DOWNLOAD_FAILED` | 502 | Telegram 文件下载超时或失败 |
| `TELEGRAM_FILE_TOO_LARGE` | 400 | 响应头或有界流读取超过 10MB |
| `TELEGRAM_FILE_EMPTY` | 400 | Telegram 文件没有内容 |
| `TELEGRAM_FILE_TYPE_UNSUPPORTED` | 400 | HTTP Content-Type 不是 JPEG/PNG/WebP |
| `TELEGRAM_FILE_CONTENT_INVALID` | 400 | 魔数、容器、尺寸或像素边界校验失败 |
| `TELEGRAM_FILE_MIME_MISMATCH` | 400 | 实际图片类型与 payload 声明 MIME 不一致 |
| `IMPORT_METADATA_INVALID` | 500 | 已接收的最小 metadata 快照损坏，需人工复核 |
| `IMPORT_FILE_STATE_INCOMPLETE` | 503 | 文件状态与接收数量不一致，可由 Queue 重投或过期恢复 |
| `IMPORT_TARGET_SLUG_CONFLICT` | 409 | 目标图库或案例 slug 已存在 |
| `IMPORT_TAG_RESOLUTION_FAILED` | 503 | 标签并发创建后无法解析到同类型权威记录 |
| `IMPORT_RETRY_NOT_ALLOWED` | 409 | 当前状态不允许重试 |
| `IMPORT_RETRY_CONFLICT` | 409 | failed 清理租约仍有效或状态已变化 |
| `IMPORT_RETRY_CLEANUP_REQUIRED` | 409 | 失败记录仍有未清理资源 |
| `IMPORT_RECOVERY_NOT_ALLOWED` | 409 | 当前记录不是 pending 或处理中状态 |
| `IMPORT_RECOVERY_NOT_AVAILABLE` | 409 | 处理租约仍有效或已被其他恢复请求认领 |
| `IMPORT_RECOVERY_CONFLICT` | 409 | 恢复收敛前状态已由另一执行器改变 |
| `IMPORT_RECOVERY_CLEANUP_REQUIRED` | 409 | 过期尝试的 R2/D1 资源尚未清理完成 |

## 8. 验收口径

平台侧验收通过条件：

- 后台 Owner 能创建 Import Token，明文 token 只显示一次。
- 外部 Bot 使用有效 token 和允许的 `sourceBotKey` 调用创建接口后返回 `pending_media_fetch`。
- API 能根据 Telegram `file_id` 拉取图片、写入 R2，并创建 `gallery` 或 `case` 草稿。
- 接收记录与文件行原子落库；专用 Queue 未配置或发送失败时安全保留 pending，使用同一消息标识可重新入队。
- 两段 Telegram 请求均有 60 秒超时，文件以 10MB 有界流读取并通过内容、容器、尺寸、像素和元数据净化校验。
- 重复 `externalMessageId` 不创建重复草稿。
- 旧 `metadata.type=testimonial_case` 被拒绝，Ops Hub 自动导入只能使用 `gallery` / `case`。
- 失败记录可通过 Bot 侧或后台详情页重试。
- Queue 重投复用确定性 key；30 分钟过期任务可显式恢复，有效租约、旧 token 与并发恢复不能覆盖新任务。
- 后台外部导入记录能查看状态、文件、错误摘要和目标草稿链接。
- 日志、后台页面和响应体不输出 Import Token 明文、Telegram Bot Token、Telegram 文件下载 URL 或 R2 私有直链。
