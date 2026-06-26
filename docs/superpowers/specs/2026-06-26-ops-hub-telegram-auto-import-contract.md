# Ops Hub Telegram 自动导入对接契约

> 本文档从 MeiGallery 侧定义与 Telegram Ops Hub 自动导入功能的边界。目标是避免 Ops Hub 入口、MeiGallery API、后台记录和测试口径之间出现遗漏或旧命名混用。

## 1. 当前结论

- MeiGallery 只提供 Telegram `file_id` 外部导入 API，不内置 Telegram Bot。
- Ops Hub 负责监听授权 Telegram 源端、解析 caption、聚合相册、生成 slug 和组装 JSON。
- MeiGallery 只接收标准化 JSON，不解析 `#gallery` / `#case` caption。
- `metadata.type` 只允许 `gallery` / `case`，旧 `testimonial_case` 必须拒绝。
- 导入只创建草稿，不自动发布。

## 2. 入口与后台

Ops Hub 入口：

- Telegram 授权源端中的 photo 或 media group。
- caption 必须显式包含 `#gallery` 或 `#case`。
- caption 至少提供 `标题`；`slug` 可由 Ops Hub 自动生成。

MeiGallery 入口：

- API：`POST /api/imports/telegram-file-id`。
- 状态查询：`GET /api/imports/:importId`。
- Bot 侧重试：`POST /api/imports/:importId/retry`。
- 后台记录：`/admin/external-import-records`。
- 后台重试：`POST /api/admin/external-import-records/:id/retry`。

## 3. Payload 契约

Ops Hub 提交给 MeiGallery 的核心字段：

| 字段 | 要求 |
|------|------|
| `metadata.type` | `gallery` 或 `case` |
| `metadata.source` | 固定 `telegram` |
| `metadata.externalMessageId` | 同一 Telegram 单图或相册必须稳定 |
| `metadata.title` | 必填，最多 80 字 |
| `metadata.slug` | 必填；如 caption 缺省，由 Ops Hub 生成 |
| `metadata.requiredLevelRank` | 图库可选，`0/10/20` |
| `metadata.tags` | 图库可选，最多 30 个 |
| `telegram.sourceBotKey` | MeiGallery Import Token allowlist 和 Worker secret 的连接键 |
| `files[].fileId` | Telegram 图片 `file_id` |
| `files[].mimeType` | `image/jpeg`、`image/png`、`image/webp` |
| `files[].sortOrder` | 从 0 开始且不重复 |

数量约束：

- `gallery`：1-30 张图片。
- `case`：2-9 张图片。

## 4. 鉴权与密钥

- Import Token 只在 MeiGallery 后台创建，明文只显示一次，D1 只保存 hash。
- Import Token 权限使用 `gallery:create` / `case:create`。
- `allowedSourceBotKeys` 必须包含 Ops Hub 提交的 `sourceBotKey`。
- 每个 `sourceBotKey` 对应 API Worker secret：`TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>`。
- MeiGallery 响应、后台、日志和审计不得暴露 Import Token 明文、Telegram Bot Token、Telegram 下载 URL 或 R2 私有 key。

## 5. 幂等和失败

- MeiGallery 以 `token + source + externalMessageId` 做幂等。
- 重复提交返回 `duplicate`，带回原 `importId`、当前状态和目标草稿 ID，不创建第二个草稿。
- 401/403、权限不足、sourceBotKey 不允许、旧类型、payload 校验失败和 slug 冲突都不适合自动重试。
- Telegram 拉取失败或异步处理失败进入 `failed`，可由 Bot 侧或后台重试。
- 重试仍复用原 Import Token 权限和 `sourceBotKey` allowlist。

## 6. 双方测试口径

MeiGallery 必测：

- `gallery` 单图导入成功并创建草稿。
- `case` 2-9 图导入成功并创建草稿。
- 旧 `testimonial_case` 被拒绝。
- Import Token 缺失、无效、禁用、过期、权限不足分别返回正确错误。
- `sourceBotKey` 不在 allowlist 时返回 `IMPORT_SOURCE_BOT_NOT_ALLOWED`。
- 重复 `externalMessageId` 返回 `duplicate`，不创建重复草稿。
- 后台 `/admin/external-import-records` 列表和详情不泄露 token、Telegram 下载 URL 或 R2 私有 key。

Ops Hub 必测：

- `#gallery` / `#case` caption 解析、标题必填、等级映射、标签拆分和自动 slug。
- 未带标记的图片消息不调用 MeiGallery。
- 相册聚合后排序连续，`case` 数量限制生效。
- Queue 重复消费、网络超时和 MeiGallery `duplicate` 都复用同一 `externalMessageId`。
- 不把 Import Token、Bot Token、webhook secret 或完整 `file_id` 写入日志、Queue 或后台响应。

## 7. 上线验收

1. 在 MeiGallery 后台创建 Import Token，权限包含 `gallery:create` / `case:create`，allowlist 包含 Ops Hub 使用的 `sourceBotKey`。
2. 为每个 `sourceBotKey` 配置 `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>` secret。
3. 用 Ops Hub 发送 `#gallery` 单图，确认 MeiGallery 外部导入记录进入 `draft_created`。
4. 用 Ops Hub 发送 `#case` 相册，确认目标写入 `cases` / `case_images`。
5. 重复同一消息，确认 MeiGallery 返回 `duplicate` 且不生成第二个草稿。
6. 提交旧 `testimonial_case` 或未授权 `sourceBotKey`，确认失败路径可见且不会自动重试。
