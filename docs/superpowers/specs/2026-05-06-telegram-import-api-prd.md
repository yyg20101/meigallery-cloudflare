# Telegram 导入 API PRD

## 1. Executive Summary

**Problem Statement**

- 当前图库和真实案例上传依赖后台手动创建、下载、整理、上传媒体，单条内容处理时间长，批量处理容易出现字段遗漏、标签错误和媒体顺序错乱。
- Telegram 已经是内容流转入口之一，但 MeiGallery 目前缺少安全、可审计、可幂等的自动导入通道。

**Proposed Solution**

- 新增受保护的导入 API，允许自定义 Telegram Bot 将解析后的结构化字段和媒体文件通过 `multipart/form-data` 上传到 MeiGallery。
- API 统一创建图库或真实案例草稿，后台继续负责授权确认、脱敏检查、标签修正、会员等级确认和发布。

**Success Criteria**

- 单个图库草稿创建耗时从手动 10-15 分钟降低到 2 分钟内。
- 单个真实案例草稿创建耗时降低到 1 分钟内。
- API 对 50 条连续导入请求的成功处理率 >= 95%。
- 字段缺失、媒体顺序错误、标签遗漏等导入错误率低于 5%。
- 所有导入内容 100% 创建为草稿，不允许 API 直接发布。

## 2. User Experience & Functionality

**User Personas**

- 站长/Owner：希望快速把 Telegram 收到的内容转成可审核草稿，减少重复下载和上传。
- 管理员/Admin：希望导入后只做审核、标签修正、会员等级确认和发布。
- 自定义 Bot 开发者：希望通过稳定 API 接入 Telegram 消息解析和媒体上传。

**User Stories**

- As a 站长, I want to use a Telegram Bot to submit structured gallery data and images so that I can create draft galleries without manually uploading each file.
- As a 管理员, I want imported items to remain drafts so that I can review authorization, tags, member level, and media order before publishing.
- As a Bot 开发者, I want a token-based API with clear validation errors so that my Bot can retry failed imports safely.
- As a 站长, I want every import action recorded in audit logs so that I can trace which Bot/token created each draft.

**Acceptance Criteria**

- API supports `type=gallery` and `type=testimonial_case`.
- API accepts `multipart/form-data` with one JSON `metadata` field and multiple media files.
- API requires `Authorization: Bearer <import_token>`.
- API rejects missing token, invalid token, disabled token, and expired token with `401` or `403`.
- API always creates imported content as `draft`.
- Gallery import creates a `galleries` row, related `media_assets`, optional cover, and tag relations.
- Testimonial import creates a `testimonial_cases` row and 2-9 `testimonial_case_images` if enough images are supplied.
- Gallery import supports up to 30 images in one request.
- Testimonial import requires 2-9 images in one request.
- Token permissions distinguish at least `gallery:create` and `testimonial:create`.
- API returns created resource id, status, uploaded file count, failed file details, and retry-safe import id.
- Duplicate `externalMessageId` from the same token must not create duplicate content.
- All successful and failed import attempts write audit logs.

**Non-Goals**

- 首期不内置官方 Telegram Bot。
- 首期不让 MeiGallery 使用 Telegram Bot Token 拉取 `file_id`。
- 首期不接 AI 自动解析 caption。
- 首期不自动发布内容。
- 首期不处理 Cloudflare Stream 视频入库，视频仍标记为待处理或直接拒绝，除非现有 Stream 接入完成。
- 首期不开放公开匿名上传。

## 3. AI System Requirements

**Tool Requirements**

- 首期不使用 AI。
- Bot 端负责把 Telegram 文案解析成结构化字段。
- MeiGallery API 只做字段校验、slug 去重、文件校验、标签匹配/创建和草稿入库。

**Evaluation Strategy**

- 用固定样例测试 20 条图库 metadata 和 10 条真实案例 metadata。
- 验证字段映射准确率达到 100%，包括标题、slug、标签、会员等级、摘要、正文、媒体顺序。
- 验证错误样例能返回明确错误，例如缺少标题、slug 冲突、图片数量不足、文件类型不支持、token 无效。
- 验证重复提交相同 `externalMessageId` 不会创建重复图库或真实案例。

## 4. Technical Specifications

**Architecture Overview**

```text
Telegram Bot
  -> 读取指定消息
  -> 下载 Telegram 图片/文件
  -> 解析并组装结构化 metadata
  -> multipart/form-data 调用 MeiGallery 导入 API

MeiGallery API Worker
  -> 校验 Import Token
  -> 校验 token 权限、过期状态、幂等键
  -> 校验 metadata 与文件
  -> 上传图片到 R2
  -> 创建图库或真实案例草稿
  -> 写入 external import record 和 audit log

MeiGallery 后台
  -> 管理员审核草稿
  -> 修正标签、会员等级、封面和图片顺序
  -> 手动发布
```

**Integration Points**

- 新增 API：`POST /api/imports/telegram`
- 新增后台 API：管理 Import Token，包括创建、禁用、查看最近使用时间。
- 新增 D1 表：`import_api_tokens`，保存 token hash、名称、权限、状态、过期时间。
- 新增 D1 表：`external_import_records`，保存 token id、source、externalMessageId、target type、target id、状态。
- 复用 R2：图库图片存入 `originals/{galleryId}/{assetId}.{ext}`。
- 复用 R2：真实案例图片存入 `testimonials/{caseId}/{imageId}.{ext}`。
- 复用审计日志：记录 `telegram_import.create_gallery`、`telegram_import.create_testimonial_case`、`telegram_import.failed`。

**Suggested Metadata Shape**

```json
{
  "type": "gallery",
  "source": "telegram",
  "externalMessageId": "chatId:messageId",
  "title": "加拿大-多伦多 172D Lina",
  "slug": "toronto-lina-001",
  "summary": "一句话摘要",
  "bodyMd": "正文 Markdown",
  "requiredLevelRank": 10,
  "tags": ["加拿大", "多伦多", "留学生", "旅拍"],
  "coverFileName": "001.jpg"
}
```

**Security & Privacy**

- Import Token 只显示一次，数据库只保存 hash。
- Token 可设置名称、权限范围、过期时间、启用/禁用状态。
- Token 权限至少区分 `gallery:create` 和 `testimonial:create`。
- API 限制单次最多 30 张图库图片、真实案例 2-9 张图片。
- 单张图片最大 10MB，允许 `image/jpeg`、`image/png`、`image/webp`。
- 所有内容强制草稿，防止 Telegram 内容绕过后台审核。
- API 必须写审计日志，包含 token id、来源、externalMessageId、IP、User-Agent。
- 不信任 Bot 传入的 R2 key、用户角色、发布状态或私有资源 URL。

## 5. Risks & Roadmap

**Phased Rollout**

- MVP：导入 API、Import Token、图库/真实案例草稿创建、图片上传、幂等、防重复、审计日志。
- v1.1：后台增加“外部导入记录”列表，展示成功/失败详情和重试入口。
- v2.0：官方 Telegram Bot webhook、caption 规则解析、AI 辅助字段建议、视频接入 Cloudflare Stream。

**Technical Risks**

- Worker 请求体大小限制可能影响多图上传，需要限制单次文件数量和单张文件大小。
- Telegram Bot 端下载失败可能导致部分文件缺失，需要 Bot 端重试和 API 端明确错误。
- D1/R2 部分成功可能产生脏数据，需要按导入记录追踪并支持后台清理。
- slug 冲突需要返回可操作错误，不能自动覆盖已有图库。
- 如果未来支持视频，需要单独设计 Cloudflare Stream 上传和异步状态回写。
