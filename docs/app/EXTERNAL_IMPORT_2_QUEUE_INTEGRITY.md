# External Import-2 Telegram 队列与运行完整性开发基线

更新时间：2026-08-20

状态：源码、migration 与 Wrangler Queue 契约已完成；dev Queue 已创建但未绑定；production 资源、migration 执行和环境验收受门禁后置

## 1. 目标与边界

本阶段收口既有 Telegram `file_id` 外部导入，不新增 Bot、不解析 caption，也不改变 `gallery` / `case` 草稿审核边界。主要解决四类运行风险：接收半写、HTTP `waitUntil` 中断、R2 孤儿对象和底层异常泄漏。

本阶段没有公共 App API v2、KMP、Nuxt 页面、Page ID 或 Figma 状态增量；当前页面事实仍为 99/408、Mobile 50/208、Admin 49/200。

## 2. 原子接收与幂等

- `external_import_records`、本次 payload 的全部 `external_import_files` 与 accepted 审计使用单个 D1 `batch` 写入。
- 任一文件行失败时整批回滚；不会留下 `file_count` 与实际文件行不一致的 pending 任务。
- `(token_id, source, external_message_id)` 继续作为唯一幂等键；并发冲突后重新读取既有记录并返回 `duplicate`。
- 权限和 `sourceBotKey` 白名单在落库前检查；每日 token 限额同时在 D1 原子 INSERT 条件内复核，竞争请求不能一起越过限额。
- JSON 请求体先按 64 KiB 有界流读取；payload 再从 `unknown` 逐字段校验并只返回白名单字段。超限/无效 JSON、畸形对象、错误运行时类型、空白必填值、超长 Telegram 标识、重复封面和规范化后重复标签均稳定返回 400，不落成意外 500 或额外 metadata。

## 3. 专用 Queue 与租约

- 新增可选 binding `TELEGRAM_IMPORT_QUEUE`，消息队列名为 `meigallery-import-telegram`，消息只包含 schema、kind、`importId` 和一次性 processing token。
- HTTP 接口不再用 `waitUntil` 处理远端媒体。Queue 未配置或发送失败时返回稳定 503；已接收记录保持 `pending_media_fetch`，调用方以相同 `externalMessageId` 重试即可重新入队。
- 入队前以条件更新保留 processing token 和 30 分钟派发租约；重复请求不会覆盖有效派发，已入队但始终未消费的过期 token 可被相同消息重试或 `recover-stale` 安全替换。
- 消费者从 pending 原子认领为 `fetching_media`，持有 30 分钟租约，并在远端读取、R2 写入和 D1 推进前后续租。
- 同一 Queue 消息只有在原 fetching 租约为空或已过期时才能条件接管续跑；有效租约期间的重复投递不抓取文件、不 ack，而是请求 Queue 延迟重试，避免两个执行器并行处理同一文件。不同 token、终态或已被恢复的旧执行器只能返回 superseded，不能覆盖新状态。
- failed 重试清理也持有可过期的 30 分钟租约；HTTP 中断不会永久留下不可重试的 processing token。

## 4. 文件与目标恢复

- 每个文件在请求 Telegram 前先持久化本次尝试的目标文件 ID 和确定性 R2 key。
- Worker 在 R2 写入后、D1 完成前中断时，原 Queue 消息重投会覆盖同一 key，不生成新的不可定位对象。
- `processing_target_id` 在开始处理时持久化；若 Worker 在图库/案例多语句创建中断，恢复器仍能定位并删除该尝试目标。
- Gallery/媒体/标签关系或 Case/图片本身使用 D1 batch 原子创建；若目标 batch 已提交但外部导入终态尚未落账，重投识别同一个 `processing_target_id` 并只完成终态收敛，不重复创建或把本次草稿误判为 slug 冲突。新标签按类型与规范化名称复用，并使用基于类型/名称摘要的稳定 ASCII slug 条件创建和同步审计，避免中文、空 slug 或标点标签碰撞到无关标签。
- failed 重试会先重新清理持久化 R2 key、媒体/案例行和处理中目标；R2 与 D1 任一清理失败时保持 failed，并以稳定 warning code 阻止重新排队。
- `pending_media_fetch` 未持有有效派发租约，或 `fetching_media` 的租约为空/已过期时，Bot 与后台都可调用 `recover-stale`。恢复先替换旧 token，再清理和重置；有效租约返回 409。
- 远端/R2 异常跨过租约边界时，执行器在破坏性清理和失败落账前重新条件续租；失去 token 的旧执行器不能清空新尝试的文件状态或写入 failed。

## 5. 远端媒体安全

- Telegram `getFile` 与文件下载各自使用 60 秒 `AbortSignal.timeout`。
- `getFile` JSON 最多读取 256 KiB；图片最多 10 MiB，并同时检查 `Content-Length` 与实际流大小。
- 下载路径只接受短的相对安全字符路径，不接受绝对路径、`..` 或查询片段。
- HTTP Content-Type 必须是 JPEG、PNG 或 WebP；文件内容继续经过魔数、容器结束、尺寸和像素量校验，并剥离元数据。
- 实际内容 MIME 必须与 payload 声明一致；空文件、伪装图片和超限流均以稳定错误码失败。

## 6. 错误与审计边界

- 对外状态、文件错误和 `error_json` 只保存稳定 code、用户安全说明、`cleanupRequired` 与 warning code。
- 读取升级前历史记录时按 code 重建固定说明；未知 code、任意历史 message 和文件错误原文统一降为通用失败说明，避免旧数据继续透传底层异常。
- D1/R2/网络异常原文、Bot Token、Telegram 下载 URL 和私有 R2 key 不进入响应或审计 afterValue。
- 结构化日志只记录固定 event、`importId`、稳定 code 和异常类型名。
- 接收、Bot/后台重试、过期恢复、草稿创建、失败和清理失败均把审计与对应权威状态放入同一条件 D1 batch。

## 7. 数据库与发布顺序

`0118_external_import_queue_integrity.sql` 只追加：

- `processing_token`
- `processing_started_at`
- `processing_heartbeat_at`
- `processing_lease_expires_at`
- `processing_target_id`
- `(status, processing_lease_expires_at, created_at)` 恢复索引

安全顺序为：

1. 应用 `0118`；旧运行时忽略新增兼容列。
2. 发布新运行时；Queue 未配置时接口 fail closed 为 503，记录仍可幂等恢复。
3. `wrangler.toml` 已声明 production `meigallery-import-telegram` 与隔离 dev `meigallery-import-telegram-dev` 的 `TELEGRAM_IMPORT_QUEUE` producer/consumer、有界单并发和诊断 DLQ；初始化脚本负责幂等创建。dev 主 Queue/DLQ 已创建但尚无 producer/consumer；只有 Worker 绑定与 migration 均完成后才启用外部调用。

当前只额外创建了隔离 dev Queue/DLQ，不执行 migration、部署 Worker、创建 production Queue 或启用外部调用。

## 8. 后置验收

远端门禁通过后继续执行以下环境专项验证；源码级回归已纳入 2026-08-24 全仓门禁：

- D1 batch 中途失败无半条任务；并发重复只保留一条记录。
- Queue 未配置、发送失败、派发后未消费、重复投递、处理中 Worker 中断和旧 token 重放。
- fetching 有效租约下重复投递必须只触发延迟重试；空/过期租约只能由一个重复消息条件接管。
- 并发每日限额、畸形 JSON 类型、超长标识、重复封面、标签规范化/稳定 slug 冲突。
- 单文件成功、多文件中途失败、R2 清理失败、D1 清理失败和清理后重试。
- 目标创建 batch 成功而最终状态落账中断时，Queue 重投复用同一目标并完成 `draft_created` 收敛。
- pending/fetching/failed 有效租约拒绝覆盖，过期/空租约只能被一个请求认领。
- 伪装图片、MIME 不一致、空响应、声明超限、流式超限、超时和异常响应。
- API/后台响应、审计和日志不含 Bot Token、下载 URL、R2 key 或底层异常消息。
