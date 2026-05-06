# Telegram file_id 异步导入 API PRD

## 1. Executive Summary

**Problem Statement**

- 当前图库和真实案例上传依赖后台手动创建、下载、整理、上传媒体，单条内容处理时间长，批量处理容易出现字段遗漏、标签错误和媒体顺序错乱。
- 自定义 Telegram Bot 如果在 Cloudflare Worker/Queues 上下载多图再 multipart 上传，会承担大文件处理、超时、重试和内存风险，不适合作为长期主路径。

**Proposed Solution**

- 新增受保护的 Telegram `file_id` JSON 导入 API，自定义 Bot 只提交结构化字段、Telegram 文件引用和来源信息。
- MeiGallery 后端根据 `sourceBotKey` 安全获取 Telegram Bot Token，异步拉取文件、保存到 R2，并创建图库或真实案例草稿。

**Success Criteria**

- Bot 侧单条导入请求 payload 控制在 50KB 内，不再上传图片二进制。
- 单个图库从 Telegram 消息提交到草稿创建完成的 P95 时间 <= 3 分钟。
- 单个真实案例从 Telegram 消息提交到草稿创建完成的 P95 时间 <= 2 分钟。
- API 对 50 条连续导入请求的接收成功率 >= 99%，最终草稿创建成功率 >= 95%。
- 所有导入内容 100% 创建为草稿，不允许 API 直接发布。

## 2. User Experience & Functionality

**User Personas**

- 站长/Owner：希望快速把 Telegram 收到的内容转成可审核草稿，减少重复下载和上传。
- 管理员/Admin：希望导入后只做审核、标签修正、会员等级确认和发布。
- 自定义 Bot 开发者：希望通过轻量 JSON API 提交 Telegram `file_id`，避免在 Bot 侧处理大文件。

**User Stories**

- As a 站长, I want my Telegram Bot to submit file references and metadata so that MeiGallery can asynchronously create draft galleries.
- As a 管理员, I want imported items to remain drafts so that I can review authorization, tags, member level, and media order before publishing.
- As a Bot 开发者, I want an idempotent JSON API with import status polling so that my Bot can retry safely without uploading large files.
- As a 站长, I want every import action recorded in audit logs so that I can trace which token, Bot, chat, and message created each draft.

**Acceptance Criteria**

- API supports `type=gallery` and `type=testimonial_case`.
- API accepts `application/json` with `metadata`、`telegram` and `files` sections.
- API requires `Authorization: Bearer <import_token>`.
- API rejects missing token, invalid token, disabled token, and expired token with `401` or `403`.
- API validates `sourceBotKey` against an allowlist configured on the Import Token or server settings.
- API creates an external import record immediately and returns `pending_media_fetch`.
- API processes media asynchronously and transitions status through `fetching_media` to `draft_created`、`partial_failed` or `failed`.
- API always creates imported content as `draft`.
- Gallery import creates a `galleries` row, related `media_assets`, optional cover, and tag relations after media fetch succeeds.
- Testimonial import creates a `testimonial_cases` row and 2-9 `testimonial_case_images` after media fetch succeeds.
- Gallery import supports 1-30 Telegram image references in one import request.
- Testimonial import requires 2-9 Telegram image references in one import request.
- Token permissions distinguish at least `gallery:create` and `testimonial:create`.
- Duplicate `externalMessageId` from the same token must not create duplicate content.
- Bot can query import status by `importId`.
- All successful and failed import attempts write audit logs.

**Non-Goals**

- 首期不内置官方 Telegram Bot。
- 首期不使用 multipart 作为主导入路径。
- 首期不做“纯保存 Telegram file_id 并展示”的临时方案；MeiGallery 必须最终保存真实图片到 R2。
- 首期不接 AI 自动解析 caption。
- 首期不自动发布内容。
- 首期不处理 Cloudflare Stream 视频入库；视频文件引用直接拒绝或标记为不支持。
- 首期不开放公开匿名上传。

## 3. AI System Requirements

**Tool Requirements**

- 首期不使用 AI。
- Bot 端负责把 Telegram 文案解析成结构化字段。
- MeiGallery API 只做字段校验、`file_id` 来源校验、Telegram 文件拉取、文件校验、slug 去重、标签匹配/创建和草稿入库。

**Evaluation Strategy**

- 用固定样例测试 20 条图库 metadata 和 10 条真实案例 metadata。
- 验证字段映射准确率达到 100%，包括标题、slug、标签、会员等级、摘要、正文、媒体顺序。
- 验证错误样例能返回明确错误，例如缺少标题、slug 冲突、图片数量不足、文件类型不支持、token 无效、sourceBotKey 不允许。
- 验证重复提交相同 `externalMessageId` 不会创建重复图库或真实案例。
- 验证异步状态最终能从 `pending_media_fetch` 进入 `draft_created` 或明确失败状态。

## 4. Technical Specifications

**Architecture Overview**

```text
Telegram Bot / Ops Hub
  -> 读取指定消息或 media group
  -> 提取 file_id、file_unique_id、文件名、MIME 声明、顺序和来源信息
  -> 解析并组装结构化 metadata
  -> application/json 调用 MeiGallery 导入 API

MeiGallery API Worker
  -> 校验 Import Token、sourceBotKey、权限和幂等键
  -> 创建 external import record，返回 pending_media_fetch
  -> 通过 Queue 或 waitUntil 异步处理媒体
  -> 使用 sourceBotKey 对应 Bot Token 调 Telegram getFile 并下载文件
  -> 校验 MIME、大小、数量和顺序
  -> 保存真实图片到 R2
  -> 创建图库或真实案例草稿
  -> 写入 external import record 和 audit log

MeiGallery 后台
  -> 管理员查看导入记录和失败原因
  -> 管理员审核草稿
  -> 修正标签、会员等级、封面和图片顺序
  -> 手动发布
```

**Integration Points**

- 新增 API：`POST /api/imports/telegram-file-id`
- 新增 API：`GET /api/imports/:importId`
- 新增后台 API：管理 Import Token，包括创建、禁用、查看最近使用时间和允许的 `sourceBotKey`。
- 新增后台 API：查看外部导入记录、失败原因和目标资源链接。
- 新增 D1 表：`import_api_tokens`，保存 token hash、名称、权限、状态、过期时间、允许的 `sourceBotKey`。
- 新增 D1 表：`external_import_records`，保存 token id、source、externalMessageId、Telegram 来源信息、target type、target id、状态。
- 新增 D1 表：`external_import_files`，保存 Telegram `file_id`、`file_unique_id`、声明 MIME、排序、拉取状态和 R2 key。
- 新增 Worker secret：按环境配置 `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>` 或使用 Cloudflare Secrets Store 保存 Bot Token。
- 复用 R2：图库图片存入 `originals/{galleryId}/{assetId}.{ext}`。
- 复用 R2：真实案例图片存入 `testimonials/{caseId}/{imageId}.{ext}`。
- 复用审计日志：记录 `telegram_import.accepted`、`telegram_import.create_gallery`、`telegram_import.create_testimonial_case`、`telegram_import.failed`。

**Suggested Request Shape**

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
}
```

**Security & Privacy**

- Import Token 只显示一次，数据库只保存 hash。
- Telegram Bot Token 不保存到 D1，不在后台显示原文、前缀或后缀。
- Token 可设置名称、权限范围、过期时间、启用/禁用状态、允许的 `sourceBotKey`。
- Token 权限至少区分 `gallery:create` 和 `testimonial:create`。
- API 限制单次最多 30 张图库图片、真实案例 2-9 张图片。
- Telegram 文件下载后仍需校验真实 MIME 和大小，允许 `image/jpeg`、`image/png`、`image/webp`，单张最大 10MB。
- 所有内容强制草稿，防止 Telegram 内容绕过后台审核。
- API 必须写审计日志，包含 token id、来源、sourceBotKey、externalMessageId、IP、User-Agent。
- 日志中不记录 Import Token 明文、Telegram Bot Token、完整 Telegram 下载 URL 或图片二进制内容。

## 5. Risks & Roadmap

**Phased Rollout**

- MVP：`file_id` JSON 导入 API、Import Token、sourceBotKey secret 映射、图库/真实案例草稿创建、R2 保存、幂等、防重复、状态查询、审计日志。
- v1.1：后台增加“外部导入记录”列表，展示成功/失败详情和重试入口。
- v2.0：官方 Telegram Bot webhook、caption 规则解析、AI 辅助字段建议、视频接入 Cloudflare Stream。

**Technical Risks**

- Telegram `file_id` 依赖 Bot 上下文，`sourceBotKey` 与 Bot Token 配错会导致文件拉取失败。
- 异步任务失败可能停留在 `fetching_media`，需要超时恢复和重试机制。
- D1/R2 部分成功可能产生脏数据，需要按导入记录追踪并支持后台清理。
- slug 冲突需要在异步处理前尽早发现，不能自动覆盖已有图库。
- 如果使用 `waitUntil()` 做 MVP，可靠性弱于 Cloudflare Queues；生产高频导入建议使用 Queues。
- 如果未来支持视频，需要单独设计 Cloudflare Stream 上传和异步状态回写。
