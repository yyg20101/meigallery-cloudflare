# Person-4 / ADM-PER-04 ZIP 导入开发交付

更新时间：2026-08-20

状态：源码开发完成；配置、migration、构建、测试与环境 QA 后置

## 1. 交付范围

本阶段按正式 Figma `ADM-PER-04` 实现后台 ZIP 导入闭环：

| Figma 状态 | Node ID | 运行态映射 |
|---|---|---|
| 正常 | `159:90838` | `queued` |
| 校验中 | `159:91042` | `uploading / validating / processing / finalizing` |
| 部分失败 | `159:91248` | `partial_failure`；legacy `failed` 安全收敛到同一视觉态 |
| 已暂停 | `159:91451` | `paused` |
| 已完成 | `159:91655` | `completed` |

页面路由为 `/admin/app/imports` 与 `/admin/app/imports/{jobId}`。列表、上传区、三项指标、逐项表格、状态提示和玫红主操作均来自上述 Figma 状态，不新增可见状态。

## 2. Cloudflare 上传架构

Cloudflare 当前官方限制中，Worker 请求体上限按账户方案分别为 Free/Pro 100 MB、Business 200 MB、Enterprise 默认 500 MB；不能让 256 MiB 应用上限依赖某一账户方案。R2 官方支持 `createMultipartUpload` / `resumeMultipartUpload`，除最后一片外最小 5 MiB，并明确可用于上传超过 Worker 单请求上限的对象。

因此当前实现使用现有私有 R2 binding：

1. API 生成随机对象 key、R2 multipart 和一次性 upload session。
2. 浏览器按服务端计划切分为固定 8 MiB 分片，经同源 Web/API Worker 流式上传；单片远低于最低账户方案限制。
3. R2 `uploadId` 和每片 ETag 只保存在 D1，浏览器不能提供或覆盖合并清单。
4. API 对流中实际字节计数，持久化分片大小；完成时验证连续序号、单片大小、总大小和最终 R2 对象大小。
5. 同一分片可安全重传；新会话会使旧会话失效并中止旧 multipart，防止两个页面把不同文件混入同一对象。

官方依据：

- [Cloudflare Workers 请求体限制](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 multipart 上传](https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload)
- [从 Worker 使用 R2 multipart](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)

## 3. ZIP 与媒体安全边界

- 原包上限 256 MiB；中央目录 4 MiB、1,024 个条目、200 个 Gallery、解压总量 512 MiB、压缩比 200。
- 不支持 Zip64、分卷、加密、符号链接、路径穿越、控制字符、大小写重复路径或非 stored/deflate 压缩。
- 通过 EOCD/中央目录索引和 R2 range 流式读取单个条目，不整体缓冲 ZIP，也不同时保留整份压缩输入与解压输出。
- 每个条目验证本地头、名称、范围、压缩输入字节、解压输出硬上限、声明大小和 CRC；恶意 deflate 不能在事后大小检查前无限扩张内存。
- `manifest.csv` 使用精确九列表头和严格 CSV 引号语法；`content.md` 与 manifest 各不超过 1 MiB。
- 图片不超过 10 MiB，支持 JPEG/PNG/WebP；校验魔数、扩展名、容器、尺寸和像素量。提取后的媒体剥离 EXIF、定位、设备、作者、文本、ICC/XMP 等元数据，原 ZIP 继续私有留存。
- MP4 单文件不超过 48 MiB。Stream 未配置时不伪造媒体成功，项目进入 retryable 失败；配置完成后上传时强制 `requireSignedURLs=true`。
- 私有 R2 key、R2 uploadId、分片 ETag 和 manifest 快照均不进入 Web 响应或错误 CSV。

## 4. Queue、部分失败与审计

- 完成原包后，`process` 先进行包级校验并为每个 manifest 行创建 `import_job_items`。
- `IMPORT_QUEUE` 每条消息只领取一个 `pending` 项，完成后链式发送下一条，运行期最多自动尝试 3 次。
- 可恢复错误保留 `retryable=1`，终态 `partial_failure` 只重试失败项；永久格式/业务错误要求修正原包后新建任务。
- Queue、汇总或外部服务故障进入 `paused`，`resume` 会回收卡住的 `processing` 项和可恢复失败项；暂停更新同时绑定预期状态、执行轮次或上传会话，过期执行器不能覆盖新状态，审计只在真实迁移成功后写入。
- Gallery、媒体、标签关联、项目完成标记和 `gallery.create` 审计在同一 D1 batch；新增标签另写条件 `create_tag` 审计，分片初始化、每片上传、原包完成、执行、重试、暂停/继续均审计。
- Admin 只能操作本人任务；Owner 可跨任务。越权写尝试也记录 `import_job.access_denied`；错误 CSV 对表格公式前缀做显式文本化处理。
- 同时处于 `validating / processing / finalizing` 的任务最多 3 个；状态认领 SQL 内原子检查，multipart 上传不占处理槽位。
- dev 后台一次上传操作只进行一次写入确认；后续受同一已确认会话约束的分片与合并请求不会为 32 个分片重复弹窗。

## 5. Gallery 与 Person/Profile 不等价

当前 ZIP 是既有 `gallery-import.zip` Gallery schema，只包含展示内容与基础标签，不包含真人主体的授权来源、身份校验、认证版本、证据保留或独立发布决定。

因此：

- 导入成功只创建 Gallery、媒体和标签关系。
- 不根据 folder、title、图片或标签自动创建 Person/Profile。
- 不把导入结果直接放入推荐、搜索或公开真人投影。
- 成功项从后台进入 Gallery 编辑；若管理员要把 Gallery 作为真人候选来源，必须另行显式选择并完成来源、授权、认证与发布双门禁，之后才可进入 `ADM-PER-03`。

这同时保持“普通注册者只是观看者”和“只有管理员认证/上传并完成门禁的真人资料可被推荐”的产品不变量。

## 6. 主要代码与数据

- migration：`packages/api/migrations/0101_zip_import_packages.sql`
- ZIP parser：`packages/api/src/services/admin-zip-package.ts`
- 上传/Queue/导入状态机：`packages/api/src/services/admin-zip-import.ts`
- Admin API：`packages/api/src/routes/admin/import-jobs.ts`
- Queue dispatch：`packages/api/src/index.ts`
- Web 同源流式代理：`packages/web/server/api/[...].ts`
- Web 分片客户端：`packages/web/app/utils/adminImportUpload.ts`
- Figma 页面：`packages/web/app/pages/admin/import/index.vue`、`[id].vue`
- 测试源码：`admin-zip-package.test.ts`、`import-jobs.test.ts`、`apiProxyHeaders.test.ts`

## 7. 当前后置项

按当前开发顺序，本阶段没有执行以下动作：

- 不执行 `0101` migration。
- 不修改/应用 `wrangler` Queue producer/consumer 或 Stream 配置。
- 不运行 TypeScript 检查、Nuxt build、单元/集成测试。
- 不运行浏览器、模拟器、真机或截图 QA。
- 不部署，不提交，不推送。

全部开发任务结束后统一完成上述配置与验证，并以 Figma 五态逐项验收。
