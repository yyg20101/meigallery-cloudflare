# 代码与文档 Review 问题台账

更新时间：2026-05-26

本文记录 2026-05-26 对整个项目代码、配置和文档进行 review 后发现的问题、影响范围和修复方案。本文是整改台账，不替代 `docs/PROJECT_STATUS.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md` 和 `docs/PRD_QUALITY_REVIEW.md` 的当前状态说明。

当前整改执行计划见 `plan/process-code-review-remediation-1.md`。

## 0. 修复状态总览

更新时间：2026-05-26

| 编号 | 优先级 | 问题 | 状态 | 当前进度 | 下一步 |
|------|--------|------|------|----------|--------|
| P1-01 | P1 | Web 类型检查失败且 CI 未覆盖 | 已完成 | 已修复 shared 类型边界和前端严格类型错误；CI 已增加 Web typecheck；本地 Web typecheck 通过，仍有 Nuxt/Volar 非阻断警告 | 跟踪 `vue-router/volar/sfc-route-blocks` package export 警告，后续在依赖升级阶段处理 |
| P1-02 | P1 | 生产速率限制与文档承诺不一致 | 已完成 | 已对齐限流常量、API 挂载点和技术文档；已补应用内兜底限流测试和生产 WAF 配置说明 | 上线前按 Cloudflare Dashboard 当前计划确认 WAF Rate Limiting Rules 可用数量和周期 |
| P1-03 | P1 | 密码哈希实现与 PRD/技术文档不一致 | 已完成 | 已确认 PBKDF2 为当前 Workers 正式策略；文档已同步参数、版本化格式和重新哈希触发条件；校验已改为固定轮次字节比较并补测试 | 后续如提高迭代次数或切换算法，按哈希格式前缀做兼容迁移 |
| P2-01 | P2 | Worker 配置缺少生产可观测性，compatibility_date 偏旧 | 已完成 | 已按 Wrangler 4.86.0 schema 为 API/Web 生产和 dev 配置 Workers Logs，并将 Worker `compatibility_date` 与 Web `compatibilityDate` 更新到 2026-05-26；部署文档已记录更新和验证流程 | 后续每次更新兼容日期前先查阅 Cloudflare 官方 compatibility dates / flags 文档并完成 dry-run |
| P2-02 | P2 | zip 批量导入文档明显超前于当前实现 | 已完成 | 已将 PRD 和技术设计拆分为当前任务记录/manifest 解析/JSON `galleries` 处理能力，以及后续 R2 直传异步 zip 导入设计 | 后续实现完整 zip 导入时，先补 R2 上传入口、异步处理器、重试策略和验收测试 |
| P2-03 | P2 | 媒体访问文档写 R2 presigned URL，但代码实际为 Worker 代理 | 待处理 | 已纳入整改计划 Phase 4 | 更新技术设计并调整误导性命名或注释 |
| P2-04 | P2 | 前端自动化测试缺失 | 待处理 | 已纳入整改计划 Phase 4 | 接入 Playwright smoke 和多视口断言 |
| P2-05 | P2 | dev 环境复用正式 D1/R2 数据 | 待处理 | 已纳入整改计划 Phase 4 | 拆分 dev 资源或增加正式数据风险标识 |
| P2-06 | P2 | 文档中的 Turnstile 覆盖范围与当前实现不一致 | 待处理 | 已纳入整改计划 Phase 4 | 统一后台登录和敏感操作校验口径 |
| P2-07 | P2 | 审计日志覆盖整体较好，但旧站迁移批量入口仍需补齐确认 | 待处理 | 已纳入整改计划 Phase 4 | 建立后台写操作审计覆盖矩阵 |
| P2-08 | P2 | 公开 API、错误响应和前端错误处理格式不统一 | 待处理 | 已纳入整改计划 Phase 4 | 定义统一错误响应 helper |
| P3-01 | P3 | 文档中规划态、当前态和历史态混写 | 待处理 | 已纳入整改计划 Phase 5 | 为主要 PRD 和技术文档增加状态标签 |
| P3-02 | P3 | 文档中的文件大小和上传限制不统一 | 待处理 | 已纳入整改计划 Phase 5 | 统一图片上传限制或明确入口差异 |
| P3-03 | P3 | 缺少 lint / format 配置和 CI 约束 | 待处理 | 已纳入整改计划 Phase 5 | 接入 ESLint / 格式化策略 |
| P3-04 | P3 | 覆盖率未知 | 待处理 | 已纳入整改计划 Phase 5 | 增加 Vitest coverage 配置 |
| P3-05 | P3 | 后端路由文件过大，业务逻辑集中在路由层 | 待处理 | 已纳入整改计划 Phase 5 | 分阶段抽取 service/helper |
| P3-06 | P3 | Stream 字段和签名逻辑存在，但生产视频链路未接入 | 待处理 | 已纳入整改计划 Phase 5 | Stream 接入前保持 UI 隐藏或维护态，并补 API 配置错误 |

## 1. 验证结果

| 验证项 | 命令 | 结果 |
|--------|------|------|
| API 类型检查 | `corepack pnpm --filter @meigallery/api exec tsc --noEmit` | 通过 |
| API 单元测试 | `corepack pnpm --filter @meigallery/api test` | 通过，31 个测试文件 / 201 个用例 |
| Web 构建 | `corepack pnpm --filter @meigallery/web exec nuxt build` | 通过，有 Nuxt/Tailwind sourcemap 警告 |
| API dry-run 构建 | `corepack pnpm --filter @meigallery/api build` | 通过，Wrangler 可识别 D1/R2/Email 绑定 |
| Shared 类型检查 | `corepack pnpm --filter @meigallery/shared exec tsc --noEmit` | 通过 |
| Web 类型检查 | `corepack pnpm --filter @meigallery/web typecheck` | 通过，有 `vue-router/volar/sfc-route-blocks` package export 非阻断警告 |

## 2. P1 问题

### P1-01 Web 类型检查失败且 CI 未覆盖

**状态**

- 已完成（2026-05-26）。
- shared 包不再从前后端共享出口暴露 `D1Database` / `R2Bucket`。
- 已修复 `TagFilterTabs.vue`、`admin/contact-methods.vue`、`admin/settings.vue`、`discover.vue` 的严格类型错误。
- `.github/workflows/ci.yml` 已新增 Web 类型检查。
- `corepack pnpm --filter @meigallery/web typecheck` 当前退出码为 0；仍打印 `vue-router/volar/sfc-route-blocks` package export 警告，未阻断类型检查。

**证据**

- `corepack pnpm --filter @meigallery/web typecheck` 失败。
- `packages/shared/src/types/index.ts` 暴露 `D1Database`、`R2Bucket` 等 Worker 全局类型。
- `packages/web/app/components/TagFilterTabs.vue` 存在 `noUncheckedIndexedAccess` 下的 `undefined` 风险。
- `packages/web/app/pages/admin/contact-methods.vue` 存在数组解构后元素可能为 `undefined` 的类型错误。
- `packages/web/app/pages/admin/settings.vue` 将 `string` 与 `boolean` 直接比较。
- `.github/workflows/ci.yml` 当前只跑 API typecheck、API test、Web build、API dry-run build。

**影响**

- 前端存在严格类型错误，但 PR 和 `dev` 推送不会被 CI 拦截。
- shared 包的 Worker binding 类型会污染 Web 类型检查边界。
- 后续升级 Nuxt、Vue、vue-router 或 Volar 时，类型错误可能变成构建或运行时问题。

**修复方案**

1. 将 shared 包拆分为纯前后端共享类型和 Worker-only env 类型，避免 Web 消费 `D1Database` / `R2Bucket`。
2. 修复 Vue 文件中的严格空值问题：数组索引、可选平台配置、类型收窄和 props 类型。
3. 处理 `vue-router/volar/sfc-route-blocks` package export 警告，优先确认 Nuxt/Vue language tooling 版本组合。
4. 在 CI 增加 `corepack pnpm --filter @meigallery/web typecheck`。

### P1-02 生产速率限制与文档承诺不一致

**状态**

- 已完成（2026-05-26）。
- 登录/注册应用内兜底限流已从 10 次/分钟/IP 对齐为 5 次/分钟/IP。
- 应用内兜底限流已覆盖公开 JSON API、管理员 API、媒体访问签名和外部导入 API。
- `docs/TECHNICAL_SPEC.md` 已明确应用内内存限流不提供生产全局强一致，生产强限流由 Cloudflare WAF / Rate Limiting Rules 承担。
- `docs/DEPLOYMENT.md` 已补充生产 WAF Rate Limiting Rules 配置表和 Free 计划规则数量不足时的最低保护口径。
- 已新增 `packages/api/src/middleware/rate-limit.test.ts` 覆盖限流桶隔离、用户级限流和 session 级限流。

**证据**

- `packages/api/src/middleware/rate-limit.ts` 使用 Worker isolate 内存 `Map`。
- `packages/api/src/index.ts` 对 `/api/auth/*` 设置 10 次/分钟，而 `docs/TECHNICAL_SPEC.md` 和 `packages/shared/src/constants/index.ts` 写的是登录/注册 5 次/分钟。
- 文档还承诺公开 API、管理员 API、媒体签名限流，但代码只覆盖 auth、gallery like、imports 三类路径。

**影响**

- 多 isolate、跨边缘节点、重启或扩缩容后限流计数不一致。
- 登录、注册、媒体访问签名和管理员 API 的生产防护弱于文档承诺。
- 安全验收容易产生误判。

**修复方案**

1. 生产环境使用 Cloudflare WAF / Rate Limiting Rules 承担边缘限流。
2. 如需应用内强一致计数，引入 Durable Object、D1 计数表或 Cloudflare Turnstile/WAF 组合策略。
3. 统一 `RATE_LIMITS` 常量、`index.ts` 实际值和技术文档。
4. 补充测试：登录暴力尝试、媒体访问签名、管理员 API、公开 API。

### P1-03 密码哈希实现与 PRD/技术文档不一致

**状态**

- 已完成（2026-05-26）。
- 当前正式密码策略为 Cloudflare Workers 原生 Web Crypto PBKDF2。
- `docs/PRD.md` 和 `docs/TECHNICAL_SPEC.md` 已删除 bcrypt/argon2 当前态表述，并补充 PBKDF2 参数、格式前缀、升级和重新哈希口径。
- `verifyPassword` 已从普通字符串比较改为固定轮次字节比较。
- `packages/api/src/utils/password.test.ts` 已覆盖错误密码、非法格式、错误迭代次数、坏 base64、不同 salt 和 hash 长度不一致路径。

**证据**

- `packages/api/src/utils/password.ts` 当前使用 Web Crypto PBKDF2。
- `packages/api/src/utils/password.ts` 当前哈希格式为 `$pbkdf2$iterations$salt_base64$hash_base64`。
- `packages/api/src/utils/password.test.ts` 覆盖密码哈希与验证路径。

**影响**

- 整改前安全设计与实现不一致，后续审计或交接容易误判。
- 整改前如果团队预期是 argon2/bcrypt，需要迁移策略和兼容验证。
- 整改前普通字符串比较不是理想的 timing-safe 比较。

**修复方案**

1. 已确定当前正式接受 PBKDF2，使用 Web Crypto 原生能力。
2. 已将文档改为 PBKDF2，并明确迭代次数、salt、版本化格式和升级策略。
3. 已为密码校验实现固定轮次字节比较。
4. 已补充非法格式、错误密码、不同 salt 和 hash 长度不一致测试；后续算法切换时再补旧 hash 兼容迁移测试。

## 3. P2 问题

### P2-01 Worker 配置缺少生产可观测性，compatibility_date 偏旧

**状态**

- 已完成（2026-05-26）。
- `packages/api/wrangler.toml` 和 `packages/web/wrangler.toml` 的 `compatibility_date` 已更新为 `2026-05-26`。
- `packages/web/nuxt.config.ts` 的 `compatibilityDate` 已同步更新为 `2026-05-26`，确保 Nitro `cloudflare-module` 构建产物使用同一兼容日期。
- API/Web 的生产配置均已启用 `[observability] enabled = true` 和 `head_sampling_rate = 1`。
- API/Web 的 dev 环境均已通过 `[env.dev.observability]` 显式启用 Workers Logs。
- `docs/DEPLOYMENT.md` 已补充 Workers Logs、采样率、日志敏感信息约束和 compatibility date 更新流程。
- 已用 Wrangler 4.86.0 schema 与 `wrangler deploy --dry-run` 校验 API/Web 的 production/dev 配置，并用 Web 构建确认 Nitro 输出兼容日期。

**证据**

- 整改前 `packages/api/wrangler.toml` 和 `packages/web/wrangler.toml` 的 `compatibility_date` 为 `2024-11-01`。
- 整改前 `packages/web/nuxt.config.ts` 的 `compatibilityDate` 为 `2024-11-01`。
- 整改前两个 Worker 配置均未设置 observability / Workers Logs。
- Wrangler 4.86.0 本地 schema 支持 `observability.enabled`、`observability.head_sampling_rate` 和环境级 `env.*.observability`。

**影响**

- 整改前生产运行时问题定位依赖 `console` 和 Dashboard 手动排查。
- 整改前兼容日期长期不更新会累积运行时行为差异和升级风险。

**修复方案**

1. 已按当前 Wrangler schema 增加 Worker observability 配置。
2. 已在部署文档中制定 compatibility date 更新和 dry-run 回归流程。
3. 已记录日志敏感信息约束；后续新增结构化日志时不得泄露 token、cookie、Telegram Bot Token、R2 私有 key 或用户密码。

参考：

- https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/

### P2-02 zip 批量导入文档明显超前于当前实现

**状态**

- 已完成（2026-05-26）。
- `docs/PRD.md` 已明确当前批量导入验收范围为 manifest CSV 解析工具、后台导入任务记录、JSON `galleries` 处理入口、结构化错误返回和错误 CSV。
- `docs/PRD.md` 已将 zip 上传、R2 源文件保存、解压、目录结构校验、媒体上传、失败项重试和完整异步导入成功率标记为后续能力。
- `docs/TECHNICAL_SPEC.md` 已拆分“当前实现范围”和“后续完整 zip 异步流程”。
- 后续完整 zip 导入设计已明确 API 不直接承载大文件请求体，应通过 R2 直传源文件，并由 Queues、Workflows 或分片任务异步处理。

**证据**

- 整改前 `docs/PRD.md` 和 `docs/TECHNICAL_SPEC.md` 描述 2GB zip、大文件异步、媒体上传、错误报告、失败重试等完整链路。
- `packages/api/src/routes/admin/import-jobs.ts` 当前主要创建任务，并通过 JSON `galleries` 数据处理，不是真正的 zip 上传、解压和异步处理入口。
- `docs/PROJECT_STATUS.md` 已标注 zip 导入为部分实现。

**影响**

- 整改前使用者可能误以为已经支持完整大文件 zip 导入。
- 2GB zip 与 Worker 请求体、CPU、内存限制存在天然冲突，必须异步化和分阶段上传。

**修复方案**

1. 已在 PRD 和技术规格中统一标注当前范围：manifest CSV 解析、任务记录、JSON `galleries` 处理、结构化错误和错误 CSV。
2. 已将完整 zip 导入改为后续 R2 直传源文件设计，API 只创建任务和签发上传入口。
3. 已记录后续使用 Queues、Workflows 或分片任务处理解压、校验、媒体写入和错误报告。
4. 已将单包图库数、zip 大小、目录结构校验、失败重试和错误报告归入后续完整 zip 导入验收范围。

### P2-03 媒体访问文档写 R2 presigned URL，但代码实际为 Worker 代理

**证据**

- `docs/TECHNICAL_SPEC.md` 写受保护图片通过后签发 R2 presigned URL。
- `packages/api/src/routes/media.ts` 当前在权限校验通过后直接 `R2.get()` 并返回 object body。
- `packages/api/src/routes/media.ts` 注释写“预签名 URL 或直接 stream”，实现只覆盖代理流。

**影响**

- 架构、安全模型和缓存模型描述不准确。
- 后续实现者可能按 presigned URL 设计前端或缓存策略，造成重复实现或权限绕过风险。

**修复方案**

1. 如果继续 Worker 代理流，更新 `TECHNICAL_SPEC.md`，明确“不暴露 R2 原始地址，服务端代理返回短缓存响应”。
2. 如果必须 presigned URL，补真正签名实现、TTL、撤销策略和 referer/cookie 无关的权限测试。
3. 将 `SIGNED_URL_TTL.IMAGE` 命名改为更贴近实现的 `PROTECTED_IMAGE_CACHE_TTL` 或类似名称。

### P2-04 前端自动化测试缺失

**证据**

- `packages/web` 未发现前端单测、组件测试或 Playwright E2E 配置。
- `docs/UI_QUALITY_REVIEW.md` 已提出多视口、可访问性、锁定态和后台状态验收，但目前主要依赖人工验收。

**影响**

- 首页、图库详情、搜索、用户中心、后台媒体管理等高变更页面容易出现回归。
- 媒体锁定态和“不暴露真实私有地址”的前端表现缺少自动化证明。

**修复方案**

1. 先接入 Playwright smoke：`/`、`/search`、图库详情、登录、用户中心、后台首页。
2. 覆盖 360px、768px、1024px、1440px 视口。
3. 增加断言：无横向滚动、锁定内容不含私有 R2 key、核心按钮可见、后台表格可扫读。
4. 再补 Vitest component 测试覆盖核心组件状态。

### P2-05 dev 环境复用正式 D1/R2 数据

**证据**

- `packages/api/wrangler.toml` 的 dev 环境使用同一个 `meigallery-db` 和 `meigallery-media`。
- `docs/DEPLOYMENT.md` 明确 dev 可以连接正式 D1/R2 数据。

**影响**

- dev 后台写操作可能影响真实内容。
- 外部导入、媒体上传、批量操作、会员发放等功能在 dev 误操作后会污染生产数据。

**修复方案**

1. 优先拆出 `meigallery-db-dev` 和 `meigallery-media-dev`。
2. 如短期继续复用生产资源，必须固定测试账号、测试标签和测试内容前缀。
3. Dev 后台页面加明显环境标识，写操作二次确认中提示“连接正式数据”。
4. 每次 dev 写操作必须可通过审计日志追踪。

### P2-06 文档中的 Turnstile 覆盖范围与当前实现不一致

**证据**

- `docs/TECHNICAL_SPEC.md` 和 `docs/DEPLOYMENT.md` 写后台登录、批量导入上传需要 Turnstile。
- 当前实现中的 Turnstile 主要覆盖登录、注册、验证码发送。
- 后台没有独立登录端点，批量导入入口未见 Turnstile 校验。

**影响**

- 安全验收标准与实际实现不一致。
- 管理后台敏感操作可能被误认为已经有人机验证保护。

**修复方案**

1. 明确后台是否复用普通登录；若复用，文档改为“登录入口统一验证”。
2. 对批量导入上传、外部导入 token 管理等高风险操作增加 Turnstile 或更强的 admin session 校验策略。
3. 为敏感后台操作建立单独的安全验收清单。

### P2-07 审计日志覆盖整体较好，但旧站迁移批量入口仍需补齐确认

**证据**

- 大多数后台写操作已调用 `writeAuditLog`。
- `packages/api/src/routes/admin/legacy-import.ts` 中仍存在批量下载、迁移相关入口，需要逐项确认审计记录和字段完整性。

**影响**

- 旧站迁移和批量任务失败时，可能难以还原操作者、输入参数和影响范围。
- 合规审计对内容来源、审核和迁移操作的追踪不完整。

**修复方案**

1. 为所有 `POST`、`PATCH`、`PUT`、`DELETE` 后台路由建立审计覆盖矩阵。
2. 审计日志记录影响对象数量、筛选条件、执行结果、失败数量和错误报告 key。
3. 对旧站迁移相关入口补充单元测试，断言写入 `admin_audit_logs`。

### P2-08 公开 API、错误响应和前端错误处理格式不统一

**证据**

- API 同时使用 `{ error }` 和 `{ statusCode, message }`。
- `docs/codebase/CONCERNS.md` 已记录统一错误响应不完全一致。

**影响**

- 前端需要兼容多种错误格式，异常路径容易显示空白或错误信息不清晰。
- 后续 API SDK 或共享类型难以稳定。

**修复方案**

1. 定义统一错误响应：`{ statusCode, message, code?, detail? }`。
2. 新增错误 helper，逐步替换散落的 `{ error }`。
3. 前端 `useApi` 统一解析错误体，避免页面重复处理。

## 4. P3 问题

### P3-01 文档中规划态、当前态和历史态混写

**证据**

- `docs/PROJECT_STATUS.md` 已说明历史计划和 superpowers 文档可能包含旧路由、旧表名、Nuxt 3、`testimonial_*` 等内容。
- `docs/PRD.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md` 仍有 Stream、WAF、Rate Limiting、签名 URL、zip 完整导入等目标态描述。

**影响**

- 新贡献者可能把规划项当作上线阻断项或已实现能力。
- Review 和验收容易围绕旧设计反复对齐。

**修复方案**

1. 所有 PRD 和技术文档的功能段落增加状态标签：`已实现`、`部分实现`、`规划`、`废弃`。
2. 历史计划统一归档说明，不作为当前生产状态依据。
3. 在 `README.md` 和 `docs/PROJECT_STATUS.md` 中补充本文链接。

### P3-02 文档中的文件大小和上传限制不统一

**证据**

- `docs/PRD.md` 写单张图片 MVP 上限 20MB。
- 后台媒体上传和真实案例图片上传代码限制为 10MB。
- Telegram 导入图片限制为 10MB。

**影响**

- 管理员和实现者对上传失败原因预期不一致。
- 测试用例和 UI 文案容易冲突。

**修复方案**

1. 统一当前图片上限为 10MB，或明确不同入口的上限差异。
2. 更新 PRD、图库管理 PRD、UI 文案和测试。
3. 如提高到 20MB，需重新评估 Worker 内存、请求体和 R2 上传策略。

### P3-03 缺少 lint / format 配置和 CI 约束

**证据**

- 未发现 `.eslintrc`、`eslint.config.*`、`.prettierrc` 或 `prettier.config.*`。
- CI 未执行 lint / format。

**影响**

- 代码风格、Vue 模板、类型断言和错误处理容易继续分叉。
- 一些低级问题只能靠人工 review 发现。

**修复方案**

1. 接入 Nuxt/TypeScript 兼容的 ESLint 配置。
2. 增加 Prettier 或统一格式策略。
3. CI 增加 lint，并先以 warning 或只检查变更文件方式渐进启用。

### P3-04 覆盖率未知

**证据**

- Vitest 未配置 coverage 命令和阈值。
- `docs/codebase/TESTING.md` 已标注覆盖率为 `[TODO]`。

**影响**

- 无法量化权限校验、导入解析、会员过期、搜索过滤等重点测试覆盖。
- 后续重构大型路由时风险难以评估。

**修复方案**

1. 增加 Vitest coverage provider。
2. 先对核心安全模块设置较低阈值并逐步提高。
3. 覆盖率报告纳入 CI artifact。

### P3-05 后端路由文件过大，业务逻辑集中在路由层

**证据**

- `packages/api/src/routes/admin/galleries.ts`、`auth.ts`、`admin/users.ts`、`admin/media.ts` 均超过或接近 400 行。
- 批量操作、媒体上传、用户活动查询、认证流程等业务逻辑直接写在路由中。

**影响**

- 后续修改容易引入回归。
- 单元测试粒度被迫依赖路由级 mock，复用和局部测试成本较高。

**修复方案**

1. 将批量图库操作、媒体上传、会员发放、验证码等流程抽到 service/helper。
2. 路由层保留参数校验、权限中间件和响应映射。
3. 每次抽取保持现有路由测试全绿，再增加 service 单测。

### P3-06 Stream 字段和签名逻辑存在，但生产视频链路未接入

**证据**

- `.env.example`、`packages/api/src/routes/media.ts` 和文档中存在 Stream 配置与 token 逻辑。
- `docs/PROJECT_STATUS.md` 标注 Cloudflare Stream 未接入。

**影响**

- 运营或前端可能误以为视频已可用。
- 如果某些数据意外带有 `stream_uid`，可能触发未完整验收的视频访问路径。

**修复方案**

1. Stream 接入前，UI 保持隐藏或维护态。
2. API 对 Stream secrets 缺失时返回明确配置错误，避免 500。
3. Stream 接入需单独 PRD，覆盖上传、编码、signed token、播放、成本监控和回滚。

## 5. 后续整改顺序建议

1. 修复 Web typecheck，并把 Web typecheck 加入 CI。
2. 统一安全文档和实现：速率限制、密码哈希、Turnstile 覆盖范围。
3. 明确媒体访问模式：Worker 代理或 R2 短期签名 URL。
4. 将 zip 导入文档拆成“当前实现”和“后续完整异步导入”。
5. 增加 Worker observability 和 compatibility date 更新流程。
6. 接入前端 Playwright smoke 和 lint/coverage。
7. 清理文档状态标签，降低规划态和当前态混淆。

## 6. 当前未处理事项

- P1-01 已完成并进入提交验证流程。
- P1-02、P1-03 仍为下一批 P1 待处理问题。
- Web typecheck 仍打印 `vue-router/volar/sfc-route-blocks` package export 非阻断警告；后续依赖升级时需确认 Nuxt、Vue、vue-router 和 Vue language tooling 的版本组合。
