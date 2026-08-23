# Legacy Import-2 旧站迁移运行完整性开发基线

更新时间：2026-08-20

状态：开发完成，migration、构建、测试与环境 QA 统一后置

## 1. 目标

本阶段修复旧 WordPress 导入后台长期存在的六类运行缺口：后台任务页复用了 ZIP 任务列表、任务级媒体下载端点不存在、批量辅助入口会误处理非 legacy 图库、单篇文章跨多表逐条写入可能留下半成品数据、失败只存在于短暂 HTTP 响应无法追溯，以及 Worker 中断后任务可能永久停留在 `processing`。

本阶段不改变任何正式 Figma 页面、App API 版本或 KMP 客户端契约，也不把 legacy Gallery 自动升级为 Person/Profile 或推荐候选。

## 2. 权威边界

- 旧站导入只产生 `Gallery` 草稿、标签关系、媒体待处理记录、旧 URL redirect 和私有迁移审核事实。
- 普通注册账号仍只是观看者；legacy 标题、分类、标签或媒体不能自动形成真人身份、认证或公开推荐资格。
- 条目审核只确认迁移内容可进入正常内容工作流，不发布 Gallery；发布仍必须走独立图库发布权限与审计。
- REST API 来源当前可执行；`xml` 只保留为未来来源类型，执行时明确返回不支持，不伪装成功。
- 远程视频仍只记录为待处理元数据；Cloudflare Stream 未配置前不上传或公开播放。

## 3. 后端闭环

### 3.1 专用任务与条目读取

- `GET /api/admin/legacy-import/jobs` 只返回 `type=legacy` 的安全展示字段，支持来源、状态、稳定分页与 `created_at + id` 排序。
- `GET /api/admin/legacy-import/jobs/:id` 不再以 `SELECT *` 暴露 ZIP package 私有字段。
- `GET /api/admin/legacy-import/items` 不返回可能包含原 HTML 的来源快照；`GET /api/admin/legacy-import/items/:id` 才显式返回单条私有快照。
- Owner 可查看全部 legacy 任务；普通 Admin 只能查看、执行、下载和审核自己创建任务关联的数据。

### 3.2 来源、任务与执行完整性

- 来源名称、HTTPS 地址、模式和映射对象都执行运行时校验；创建来源和创建任务分别与最小审计放入同一 D1 batch。
- 同一来源同一时刻只允许一个任务进入 `processing`，防止两个管理员并发导入相同 WordPress 数据。
- 执行领取使用不可猜测 token 和 30 分钟 D1 权威租约；文章、分类、标签每一页通过格式与分页完整性校验后同步续租，单篇写入阶段每 10 条续租，完成和失败收敛都必须持有当前 token。
- `POST /api/admin/legacy-import/jobs/:id/recover-stale` 只能把租约已过期或历史缺失租约的 `processing` 任务原子收敛为失败并写最小审计；有效租约不可被提前抢占。恢复不复用旧任务执行，管理员必须创建新任务，由来源 post ID 与 Gallery slug 去重保证已成功条目不重复。
- 重复判断同时使用来源内 `legacy_post_id` 和 Gallery slug；旧站修改 slug 后也不会再次创建同一文章。
- 来源 `category_mapping` / `tag_mapping` 会解析到既有权威 `tags.id` 并直接建立关联；JSON 损坏或目标标签不存在时任务在领取前失败，不悄悄回退为错误标签。
- WordPress 文章、分类和标签 JSON 使用 16 MiB 流式有界读取；响应未声明或谎报 Content-Length 时也会在越界处取消连接，不先整体缓冲到 Worker 内存。
- 每个 WordPress REST 请求携带 60 秒截止信号，超时会中止连接并把任务收敛为安全结构化失败，不能无限占用 processing 租约。
- 空标题、无效或超长 slug、过长标题/正文都有确定性规范化或人工复核标记。
- 文章链接和每个媒体 URL 在入库前都执行安全外部 HTTPS 校验；正文只保存清洗后的文本，不保留可绕过 R2/Stream 访问控制的源站媒体嵌入。

### 3.3 单篇原子写入

每篇文章的以下事实使用一个 `db.batch()` 原子提交：

1. Gallery 草稿；
2. 标签创建与 Gallery 关联；
3. 带正确 `storage`、角色、顺序和 pending 状态的媒体记录；
4. legacy 条目与不可变来源快照；
5. 旧 URL redirect；
6. `import_legacy_gallery_item` 管理审计。

任何语句失败时整篇回滚。随后以独立的单一 `db.batch()` 原子写入 `status=failed` 条目、结构化 `error_code/error_message`、私有失败快照和 `import_legacy_gallery_item_failed` 审计，外层任务才继续处理其他文章；失败事实 batch 自身失败时立即中止任务，不能只返回无法追溯的错误文字。任务响应只返回安全结构化错误，不透出底层 D1 异常。

媒体 INSERT 每条最多 14 行、98 个绑定参数，低于 Cloudflare D1 当前每条查询 100 个绑定参数的官方上限：[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)。

来源快照上限为 512 KiB，包含 schema 版本、旧 post ID/date/slug、分类 ID、标签 ID、经安全校验的媒体描述和原 HTML。原 HTML 越界时不进入媒体正则解析，避免放大 Worker CPU，并明确失败进入人工拆分；失败事实会改存显式的最小快照，记录原始字节数和 `rawHtml.omitted=true`，不把截断内容伪装成完整原件。无效链接不进入可执行媒体描述，失败条目的必填旧 URL 使用来源 REST post 地址安全兜底。

### 3.4 审核终态

- 只允许完整导入且 `review_status=pending` 的条目形成 `approved` 或 `rejected` 终态。
- 同结论重放返回幂等成功；不同结论不能原地改写。
- 审核备注不再覆盖原始 `review_flags`。
- 审核结论、备注、管理员和时间与追加式审计在同一 D1 batch 形成。
- API 明确返回 `galleryPublished=false`，迁移审核绝不直接修改 Gallery 发布状态。

### 3.5 媒体辅助任务

- `POST /api/admin/legacy-import/jobs/:id/download-media` 只处理指定已完成 legacy 任务关联的 pending 图片。
- 全局 `download-pending`、状态统计、失败重置和封面设置都通过 `legacy_import_items + import_jobs` 反向限定，不触碰 ZIP、手工上传或其他来源 Gallery。
- 普通 Admin 的全局入口进一步限制为本人任务；Owner 才能处理全部 legacy 数据。
- 下载使用稳定顺序、有界数量、5 并发和条件状态更新；并发竞争只记为 `skipped`，不会覆盖已经完成的媒体状态。
- 每张远程图片最多 10 MiB，并复用 ZIP 导入的魔数、容器、尺寸/像素和 JPEG/PNG/WebP 元数据净化规则；响应 Content-Type 不作为可信格式事实，HTML/GIF/损坏图片不能写入 R2。
- 远程媒体请求同样使用 60 秒截止信号；响应只返回稳定错误码与安全文案，R2、网络或 Stream SDK 的原始异常正文不会进入 HTTP 响应或审计。
- 每个媒体 completed/failed 状态变化与对应最小审计同批提交；R2 成功但 D1 batch 失败时数据库仍保持 pending，确定性 key 可安全重试。
- 审计只记录数量、范围和错误计数，不把外部 URL 或异常正文写入审计日志。

## 4. Schema

`0116_legacy_import_operational_integrity.sql`：

- 为 `legacy_import_items` 增加 `source_snapshot_json`、`review_note`、`reviewed_by`、`reviewed_at`、`error_code` 和 `error_message`；
- 为 `import_jobs` 增加 legacy 专用 `legacy_processing_token`、`legacy_processing_expires_at` 与过期任务查询索引；
- 从既有 `review_legacy_import_item` 追加日志安全补齐可确认的历史审核人、时间和备注；无证据记录保持 NULL，等待人工 forward-fix；
- 增加任务、来源 post、Gallery 媒体作用域所需索引；
- 增加 imported/failed 终态完整性、条目终态不可改写、审核终态不可改写、已存在审核/失败证据不可改写和来源快照不可改写触发器。

`0119_legacy_import_processing_lease_guards.sql` 在兼容代码发布后启用租约状态约束：legacy processing 必须同时持有 token 与到期时间，非 processing 和非 legacy 任务不得残留这两个字段。dev/production 远端账本均确认原约束版 `0117` 从未执行，因此收缩约束安全顺延到当前 migration 末尾；新的 `0117_legacy_import_processing_lease_guard_reservation.sql` 只执行 `SELECT 1`，用于保持全链序号连续，不修改 schema 或业务数据。`0119` 使用 `CREATE TRIGGER IF NOT EXISTS`，即使未来旧账本竞态留下同名且同义约束也能安全收敛。拆分并顺延 migration 是为了保持可发布顺序：先应用截至 `0118` 的兼容扩展，再发布会写租约的代码，最后单独启用强约束。

Migration 不创建任务、不导入真实旧站内容、不发布 Gallery，也不修改环境配置。

## 5. 已编写但尚未运行的验证源码

- 专用 legacy 任务列表范围、稳定排序、分页和 Admin 自有可见性；
- 全局及任务级媒体下载作用域、结果统计和最小审计；
- 审核不覆盖风险标记、不发布 Gallery，并写入终态证据；
- 单篇写入只调用一个 D1 batch，失败不降级为逐表写入；
- 单篇失败以第二个原子 batch 持久化结构化失败条目、最小审计和安全快照；超限原 HTML 保存显式省略证据；
- 15 个媒体分成 98/7 个绑定参数的两条语句；
- 不安全媒体 URL 在数据库 batch 前失败；
- 来源显式分类/标签映射命中权威标签，缺失目标时 fail closed；
- 分类/标签接口失败、异常响应或权威分页超过安全上限时终止任务，不把失败降级为空映射或部分成功；
- WordPress 每页完成校验后同步等待租约心跳，空分类/标签页也会续租；过期 processing 任务可恢复为带结构化错误的失败终态，有效租约拒绝恢复；
- WordPress JSON 实际流超过 16 MiB 时中止并取消上游响应；
- 每个 WordPress 分页请求都携带远程截止信号；
- 远程图片大小、格式、容器、尺寸、元数据净化和错误 Content-Type 场景；
- 无效 slug、空标题、正文远程媒体移除与来源 post ID 去重。

按当前用户要求，本阶段没有执行 migration、构建、测试、浏览器/设备 QA、部署、提交或推送。

## 6. 后置门禁

全部开发结束后统一执行：

1. 在隔离 D1 副本检查历史 terminal review 与审核日志可回填覆盖率；
2. 通过阶段执行器先应用截至 `0118` 的兼容扩展，再发布会写租约的兼容代码，最后单独应用 `0119` 租约约束；核对新增列、索引和触发器；
3. 运行 legacy route/service 定向测试、API 类型检查与 Web 构建；
4. 使用合成 WordPress 来源验证重复任务、分页续租、有效租约拒绝回收、过期任务恢复、部分失败、媒体重试、封面设置和审计完整性；
5. 在正式启用前补齐 XML 独立上传/解析设计和 Stream 配置，未完成时保持明确不可用。
