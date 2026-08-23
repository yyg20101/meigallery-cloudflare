# Privacy-2A 私有数据导出制品跨仓交付基线

更新时间：2026-08-20

App 版本：1.0

状态：开发接线完成；Privacy-2C 已扩充当前数据副本范围；migration、Queue/R2 配置、构建、测试、设备 QA 与生产审批统一后置

## 1. 本阶段结论

Privacy-2A 在 Privacy-1 的默认关闭控制面上补齐“可恢复生成、可核验就绪、重新验证后一次性下载”的个人数据副本链路：

- 本切片把 App API v2 累计契约以兼容新增方式提升到 `1.24.0`；Membership-7 后仓库当前累计版本为 `1.26.0`。申请详情新增 `exportArtifact`，bootstrap 固定声明下载票据 Header 和 `tar` 格式。
- `0102_app_data_rights_private_exports.sql` 新增不可变执行配置、制品、分类范围、分片、可恢复任务、一次性票据和票据幂等命令。
- Cloudflare Queue 按小页推进当前 41 个显式白名单分类；Privacy-2C 只在原 35 类末尾追加推荐偏好、拉黑状态/时间线、旧版图库点赞和推荐解释会话/条目。Message-4 的“实时连接票据摘要”仍不导出票据哈希、会话 ID 或内部账号 ID。租约失效、消息重试或 Worker 中断后从 D1 权威游标恢复，不在单次 Worker 内聚合完整账号历史。
- 每个 NDJSON 分片、`README.txt`、`manifest.json` 和最终 TAR 都写入私有 R2；申请只有在对象存在且 ETag、长度、摘要和版本事实一致后才能进入 `ready`。
- 后续 Message-5 以 `0109` 把同一批次完成的用户可见 `export_ready` 事件接入 Message-3 Outbox；Message-7 再以 `0110` 接入申请/制品/任务已收敛的 `processing_failed` 事实。两类通知都只提示回到数据权利页面，不包含制品引用、failure code、摘要或下载票据。
- 下载前必须以 `export_download` purpose 重新验证当前密码；服务端签发短期一次性票据，下载流开始前原子消费并再次核验当前会话、申请、制品和 R2 快照。
- KMP 通过 Ktor `ByteReadChannel` 以 64 KiB 块写入平台文件存储，不把 TAR 整体放入内存；Android 使用 MediaStore Downloads 或应用 Documents 回退，iOS 使用 Documents 临时文件和原子移动。
- `APP-SET-09` 的正式 ready 状态 `159:74172` 使用 Figma 文案“文件已就绪 · 需要重新验证”和“验证身份并安全下载”；确认弹层标题为“验证身份后下载”。
- `ADM-PRI-02` 继续以 Figma `944:16747` 为视觉基线，新增的任务进度、制品状态和摘要只展示服务端权威事实，不提供人工伪造完成动作。

Privacy-2A 本身**不实现**不可逆账号删除、匿名化执行器或法定保留隔离；这些能力已由后续 Privacy-2B 以独立执行器承接。OQ-020、OQ-024、OQ-025 未关闭前，deletion processing 继续硬关闭；“导出已完成”绝不代表“账号注销已完成”。

## 2. 默认关闭与启用边界

本阶段没有修改 Wrangler、环境变量、Queue binding、R2 binding 或任何环境值，也没有执行 migration。

`0102` 只 seed development 配置 `drxp_app_1_0_privacy_2a_dev_1`：

| 项目 | development 值 | 约束 |
|------|-----------------|------|
| `state` | `development` | production 必须是 `published` |
| `production_ready` | `0` | 默认禁止真实执行 |
| `schema_version` | `1` | 只允许已实现的固定 schema |
| `artifact_ttl_hours` | `24` | 仅开发默认值，不是正式保留承诺 |
| `download_ticket_ttl_seconds` | `300` | 受 60–900 秒数据库约束 |
| `page_size` | `250` | 单次分页 25–500 行 |
| `max_part_bytes` | `2,000,000` | 分片生成硬上限 |
| `max_parts` | `512` | 防止无界制品 |
| `max_artifact_bytes` | `100,000,000` | 服务端策略上限；客户端另有 250 MiB fail-closed 上限 |

开始导出必须同时满足：

1. Privacy-1 策略为 `published + production_ready`；
2. export request 与 export processing 均显式启用；
3. retention、Owner/SLA、region 三项治理决策全部为 `approved`；
4. 与当前策略一一绑定的 export profile 为 `published + production_ready`；
5. API 运行时具备私有 R2 和 `DATA_RIGHTS_EXPORT_QUEUE` binding；
6. 当前申请属于 export、处于允许状态且版本未变化；
7. `SESSION_SECRET` 满足推荐证据账号 HMAC 定位门禁，并在相关证据与导出任务存续期间保持稳定。

任一条件未知、缺失或矛盾时都 fail closed；开发代码存在不构成生产开放授权。

## 3. D1 权威事实

| 表 | 责任 |
|----|------|
| `app_data_rights_export_profiles` | 与 Privacy-1 policy 一一绑定的不可变执行参数；禁止更新和删除 |
| `app_data_rights_export_artifacts` | 申请/版本绑定制品、生成 token、摘要、R2 key/ETag、到期与清理状态 |
| `app_data_rights_export_scopes` | 当前新制品 41 个分类的固定顺序、最大 rowid 边界、恢复游标和完成计数；旧制品保留创建时的 35 个 scope |
| `app_data_rights_export_parts` | 只追加 NDJSON 分片事实；记录文件名、R2 ETag、SHA-256、长度和 rowid 范围 |
| `app_data_rights_export_jobs` | 单任务租约、当前分类、下一分片序号、尝试次数和最后错误 |
| `app_data_rights_export_download_tickets` | 只存票据 SHA-256、请求/制品版本与完整性快照、到期和消费事实 |
| `app_data_rights_export_download_commands` | 签发票据的账号级幂等事实；禁止更新和删除 |

关键约束：

- 制品唯一绑定 `(request_id, request_version)`，重试不能把旧申请版本的对象冒充为当前结果。
- R2 key 只能位于 `data-rights/exports/{requestId}/{artifactId}/`；不保存也不返回公开 URL。
- 分片和票据幂等命令不可修改或删除；任务恢复通过新版本、租约和显式状态推进，而不是覆盖历史证据。
- `ready/expired/purging/purged` 制品必须已经具备完整 README、manifest、archive、摘要、ETag、长度及生成/到期时间。
- 明文 step-up token 与下载票据均不落 D1，数据库只保留 SHA-256。

## 4. 导出范围与快照语义

执行器只包含以下当前 41 个显式分类，新增业务表不会自动进入导出：

1. 账号资料、身份验证方式摘要、同意与确认记录、设备摘要、实时连接票据摘要；
2. 账号外观设置、站内通知设置、浏览记录设置、搜索记录设置、会话设置；
3. 喜欢与关注、收藏夹、收藏内容、人物浏览记录、搜索记录、保存的筛选条件；
4. 会员权益记录、会员撤销记录、会员申请；
5. 金币钱包摘要、金币明细；
6. 平台会话、本人平台会话消息、站内通知；
7. 本人举报、举报用户可见时间线、举报申诉、举报申诉用户可见时间线、举报申诉补充与升级时间线、举报申诉本人补充；
8. 账号与金币申诉、账号与金币申诉用户可见时间线、账号与金币申诉本人补充；
9. 数据权利申请、数据权利用户可见时间线；
10. 推荐偏好、人物拉黑状态、人物拉黑时间线、旧版图库点赞；
11. 推荐解释会话；
12. 推荐解释条目。

每个分类在任务创建时冻结当前账号可见行的最大 SQLite `rowid`，后续只读取 `rowid <= max_rowid_snapshot` 的记录，因此任务开始后新插入的记录不会混入本次包。为保持 Worker 可恢复和低内存，字段值在对应分页实际读取时序列化；这是一致的“纳入边界快照”，不是跨 41 个分类的数据库事务时点快照。`manifest.json` 明确记录生成时间、分类、rowid 边界、分片、记录数和摘要，消费方不得把它误解为法证级数据库备份。

Privacy-2C 保持前 35 个已持久化分类及其 ordinal 完全不变，只把 6 类追加到末尾。执行器以每个 artifact 已保存的 scope 数量作为终止边界：升级前已经创建的 35-scope 制品仍在第 35 类后正常 finalizing，新创建的制品才生成 41 个 scope，部署升级不会把旧制品误解释为缺少第 36–41 类。

推荐解释证据没有内部数字账号 ID，只保存分用途 HMAC。创建 scope 与后续分页都使用集中实现的 `HMAC-SHA-256(SESSION_SECRET, "recommendation-account-v1\\0" + accountPublicId)` 定位相同账号；导出内容只包含本人可解释的会话、规则/热度版本、推荐条目与理由，不包含 `account_hash`、`context_hash` 或密钥。密钥缺失时开始处理 fail closed；密钥在任务中途变化会破坏定位，因此任何轮换必须等待关联证据与在途导出清零。

白名单只返回面向本人可解释的公开引用、业务状态和时间，不包含：

- 密码、密码摘要、验证码、session/access/refresh/status/step-up/download token；
- 数据库数字内部账号 ID、管理员内部 ID、租约 token、R2 key 或 Secret；
- 推荐 `account_hash`、`context_hash`、原始推荐请求上下文或可用于反查账号的内部摘要；
- 管理员内部备注、风控规则、内部审核证据和其他账号内容；
- 服务端原始请求头、IP、通用日志和分析系统未批准数据。

## 5. 可恢复 Queue 状态机

```text
申请 collecting
    ↓ 创建 artifact / scopes / job
queued → collecting → finalizing → ready → expired → purging → purged
              │             │
              └─────────────┴→ failed → 管理员 retry → 新申请版本任务
```

- Queue 消息只携带稳定 `artifactId` 和 generation token，不携带账号明文、导出数据或下载凭证。
- 消费者先以 D1 条件更新取得短租约；重复消息、旧 generation token、已完成任务或有效租约不会并行生成同一分片。
- 每次只读取当前 scope 的一页，生成一个有字节和记录上限的 NDJSON 文件，R2 put 后再以 ETag/长度/自定义 metadata 校验，最后提交 D1 游标。
- Worker 异常前若 R2 已写入而 D1 尚未提交，重试会依据确定性 key 和对象完整性恢复，不把未核验对象计为完成。
- 定时恢复只重新派发失效租约和可恢复任务；Queue 自身重试与 D1 权威任务状态共同工作，消息投递次数不作为业务完成事实。
- 分类完成边界读取 artifact 自身已保存的 scope 数，不读取当前代码分类总数；因此 35-scope 与 41-scope 在途任务可以安全共存。
- 达到最大分片、制品大小或不可恢复完整性错误时，申请、制品与任务先进入 `failed`，再生成用户可见失败事件；申请展示安全失败原因，Message-7 生成必要站内提醒，不会截断后宣称 ready 或泄露内部错误。

## 6. 私有 R2 制品与完整性

最终目录固定为：

```text
data-rights/exports/{requestId}/{artifactId}/
  README.txt
  manifest.json
  data/
    0001-account.ndjson
    ...
  meigallery-data-export.tar
```

生成流程：

1. 对每个 NDJSON 分片计算 SHA-256、字节数、记录数和 rowid 范围；
2. 生成面向用户的 `README.txt`；
3. 生成确定性 `manifest.json`，列出 schema、分类、分片和各自摘要；
4. 按固定顺序流式组合标准 TAR，禁止路径穿越、绝对路径和重复文件名；
5. 对 README、manifest、TAR 分别执行 R2 `head/get` 完整性核验；
6. 只有 D1 记录与 R2 ETag、长度、自定义 metadata、SHA-256 全部一致，才原子推进 artifact 和申请到 ready。

客户端必须同时核验申请详情、票据响应和下载响应 Header 中的 `manifestSha256`，并要求 `Content-Length` 与 ready 制品长度完全一致。任何缺失、超限、MIME/文件名不符或流提前结束都中止保存并清理部分文件。

## 7. 一次性下载安全边界

### 7.1 App API v2 `1.24.0`

| 方法与路径 | 凭证 | 说明 |
|------------|------|------|
| `GET /api/v2/me/data-rights/requests/:requestId` | App Bearer | 详情新增服务端权威 `exportArtifact` |
| `POST /api/v2/me/data-rights/step-up` | App Bearer | `purpose=export_download` 且绑定当前申请 |
| `POST /api/v2/me/data-rights/requests/:requestId/download-tickets` | Bearer + step-up + `Idempotency-Key` | 签发短期一次性 `drdl_` 票据 |
| `GET /api/v2/me/data-rights/requests/:requestId/download` | Bearer + `X-Data-Rights-Download-Ticket` | 原子消费后流式返回 `application/x-tar` |

下载响应固定：

- `Cache-Control: private, no-store, max-age=0`；
- `Content-Disposition: attachment; filename="meigallery-data-export.tar"`；
- 权威 `Content-Length`；
- `X-Data-Rights-Manifest-SHA256`；
- `X-Content-Type-Options: nosniff`。

### 7.2 签发与消费

- step-up token 必须未消费、未过期，并绑定 `export_download`、当前账号、当前普通 session 和 request ID。
- 票据 HMAC 绑定 ticket、request、artifact、account 和 expiresAt；数据库只保存票据 SHA-256。
- 幂等重放只返回同一张仍未消费、仍有效且制品版本不变的票据；相同键不同申请返回冲突。
- 下载前重新核验普通 session、申请版本、artifact 版本、manifest/aggregate SHA-256、R2 ETag、长度和到期时间。
- 票据在返回 R2 body 前通过 D1 条件写原子消费；并发第二次使用、过期或状态变化均失败。
- 流开始后的网络失败不恢复旧票据。用户需要重新验证并创建新票据，避免可重放下载凭证。
- ticket、step-up token 和密码不得进入 URL、日志、审计上下文、UI 状态持久化或分析事件。

## 8. KMP 保存行为

- Repository 只在 bootstrap 同时声明 `downloadTicketHeader=X-Data-Rights-Download-Ticket`、`exportFormat=tar` 且申请 artifact 权威可下载时开放 CTA。
- 进程内 pending request 只保存 request ID 和票据签发幂等键；不保存密码、step-up token 或下载票据。票据响应已经明确后即清除幂等恢复状态。
- Ktor 使用 `bodyAsChannel()` / `readAvailable()` 分块读取，并在平台 sink 中边读边写；完整 TAR 不进入 `ByteArray` 或普通 UI state。
- Android 29+ 写入 `MediaStore.Downloads/MeiGallery`，先 `IS_PENDING=1`，长度一致且同步成功后再公开；Android 26–28 写入应用 Documents。失败时删除未完成条目。
- iOS 写入应用 Documents/MeiGallery 的唯一临时文件，长度一致并同步关闭后原子移动为正式文件；失败时删除临时文件。
- iOS 若要让用户通过 Files 直接浏览应用 Documents，还需在后续配置阶段审查并设置 `UIFileSharingEnabled` 与 `LSSupportsOpeningDocumentsInPlace`；本阶段不提前修改配置。
- 客户端硬拒绝大于 250 MiB、缺少长度、长度与 artifact 不一致、错误文件名、错误 MIME、manifest 摘要不一致或提前 EOF 的响应。

## 9. 管理后台与 Figma

`ADM-PRI-02` 详情新增：

- export profile 是否就绪及拒绝原因；
- artifact 状态、已完成分类/总分类、记录数、分片数、字节数；
- manifest SHA-256、生成时间、到期时间；
- `begin_processing` / `retry` 的 Queue 派发结果。

管理员只能触发服务端允许的动作。`begin_processing` 原子创建 artifact/scopes/job 后才派发 Queue；响应丢失或重复点击复用权威申请/制品，不生成并行导出。后台仍没有“手工完成”按钮，ready 只能来自 R2 完整性事实。

移动端严格复用 Figma：

| 页面 | 状态 | Node ID / 文案 |
|------|------|----------------|
| `APP-SET-09` | ready / verification required | `159:74172`；“文件已就绪 · 需要重新验证” |
| `APP-SET-09` | 主 CTA | “验证身份并安全下载” |
| `APP-SET-09` | 下载确认支持态 | “验证身份后下载” / “开始验证并下载” / “稍后下载” |
| `ADM-PRI-02` | 正常详情 | `944:16747`；布局不新增 Figma 外页面状态 |

## 10. 到期与清理

到期采用两阶段策略：

1. 先在 D1 把 ready artifact 和申请推进到 expired，并使所有未消费票据立即失效；
2. 再删除该 artifact 固定前缀下已登记的 parts、README、manifest 和 TAR；
3. 逐个核验 R2 对象不存在后推进 `purged`，失败保留 `purging` 供下次定时任务恢复。

清理失败不能重新开放下载，也不能删除 D1 审计/摘要事实。运行期恢复、dead letter 或 incident 只用于诊断和补偿，不把紧急修复部署锁死。

## 11. 明确后置事项

按照当前“先完成全部开发，再统一配置与验证”的顺序，本阶段没有执行：

- `0102` 或完整 D1 migration 链；
- Queue/R2/cron/Wrangler 配置与 dev/production capability 开放；
- TypeScript/Kotlin 构建、单元/集成/E2E/并发/失败注入测试；
- Android/iOS 模拟器、真机、`android-cli` 截图和 Figma 像素验收；
- 大账号性能、Queue 重试、R2 局部失败、过期清理与事故恢复演练；
- 正式 retention、地区、Owner/SLA、导出范围和法律文案审批。

Privacy-2B 已另行冻结删除/匿名化分类、法定保留排除、依赖顺序、可恢复边界、账本与安全证据保留和完成证明；它继续是独立执行链，不得复用本导出任务假装删除已经完成。Privacy-2C 的范围扩充与兼容边界见 `docs/app/PRIVACY_2C_DATA_COPY_COVERAGE_INTEGRATION.md`。
