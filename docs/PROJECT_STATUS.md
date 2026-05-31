# 项目当前状态

更新时间：2026-06-01

本文档是当前实现和部署状态的索引。若历史计划或早期 PRD 与本文冲突，以本文、`AGENTS.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/GIT_WORKFLOW.md` 为准。

## 技术栈现状

- Monorepo：pnpm workspace，包为 `@meigallery/web`、`@meigallery/api`、`@meigallery/shared`。
- 前端：`packages/web` 当前依赖 `nuxt@4.4.4`、`@nuxt/ui@4.7.1`、`tailwindcss@4.2.4`，Nitro preset 为 `cloudflare-module`。
- 后端：`packages/api` 使用 Hono，入口为 `packages/api/src/index.ts`，通过 Cloudflare Worker bindings 访问 D1/R2/Email。
- 共享包：`packages/shared` 提供共享类型、会员 rank、标签类型、联系方式平台和用户名工具。
- 组件预览：仓库当前没有 Histoire 依赖或配置；历史文档中的 Histoire 是规划项。

## 运行时和部署

- 运行平台：仅使用 Cloudflare Workers + Workers Assets，不使用 Cloudflare Pages。
- 前端 Worker：`meigallery-web`，生产域名 `616618.xyz` / `www.616618.xyz`。
- API Worker：`meigallery-api`，生产域名 `api.616618.xyz`。
- 开发 Worker：`meigallery-web-dev` / `meigallery-api-dev`，仅使用 Workers dev 子域，不绑定生产域名。
- 数据库：Cloudflare D1 `meigallery-db`。
- D1 migrations：仓库当前维护到 `0020_home_ad_settings.sql`；部署前需按目标环境执行所有未应用迁移。
- 对象存储：Cloudflare R2 `meigallery-media`。
- 视频：Cloudflare Stream 仍未接入，相关 secrets 为占位符，视频能力按规划保留；API 在缺少 Stream secrets 时返回 503 `STREAM_NOT_CONFIGURED`。
- 生产部署：PR 合入 `main` 后手动执行 `./scripts/deploy.sh production` 或等价 wrangler 命令。
- CI：`.github/workflows/ci.yml` 只做 PR/dev 推送的测试、类型检查和构建验证，不自动部署生产。

## 功能实现现状

- 已实现：公开图库/标签/搜索/真实案例、登录注册、用户名登录、邮箱验证开关、用户中心、个人设置、后台图库/标签/用户/设置/审计、首页广告位配置、图库批量操作、图片上传、封面设置、单媒体 rank 配置、WordPress 迁移辅助、Telegram `gallery` / `case` 外部导入、Facebook Pixel 设置。
- 部分实现：zip 导入任务有 API 和后台入口，但当前重点实现和测试集中在解析/校验与任务记录；大文件异步完整处理仍需按后续阶段继续收敛。
- 未接入：Cloudflare Stream 生产视频上传、编码和播放链路；相关字段、secret、媒体签名逻辑保留为规划能力。
- 已完成迁移口径：真实案例当前统一为 `cases` / `case_images`、`/cases`、`/api/cases`、`case:create`；旧 `testimonial_*` 仅存在于历史文档、迁移脚本说明或兼容拒绝测试中。

## PRD 质量状态

- 当前 PRD 质量审阅和整改索引见 `docs/PRD_QUALITY_REVIEW.md`。
- 当前可验收能力、部分实现能力和规划能力必须按 `docs/PRD_QUALITY_REVIEW.md` 的需求状态矩阵区分，不得把历史 PRD 中的规划项当作上线阻断项。
- Cloudflare Stream、Email Service、zip 大文件异步导入、旧站内容审核状态机属于需要单独补齐验收标准的重点区域。
- 后续新增或修改 PRD 时，必须为成功指标补充测试环境、数据规模、采样方法和失败路径。

## UI 质量状态

- 当前 UI 质量审阅和页面/组件验收清单见 `docs/UI_QUALITY_REVIEW.md`。
- `docs/UI_DESIGN.md` 已补充页面级完成定义、组件状态矩阵、响应式验收和可访问性检查方法。
- Stream 接入前，视频入口、视频专区、视频角标和播放器均按规划能力处理，不作为当前上线阻断项。
- 线框图留存规则见 `docs/ui/wireframes/README.md`，后续关键线框图需导出到该目录或以截图、PDF、HTML 快照形式保存。

## 代码质量整改状态

- 当前整改执行计划见 `plan/process-code-review-remediation-1.md`。
- `P1-01 Web 类型检查失败且 CI 未覆盖` 已完成：shared 不再暴露 Worker binding 类型给 Web，前端严格类型错误已修复，CI 已新增 Web typecheck。
- `P1-02 生产速率限制与文档承诺不一致` 已完成：API 内置兜底限流已对齐常量和技术文档，部署文档已补生产 Cloudflare WAF / Rate Limiting Rules 配置口径。
- `P1-03 密码哈希实现与 PRD/技术文档不一致` 已完成：当前正式策略为 Workers 原生 Web Crypto PBKDF2，文档已同步参数和升级口径，密码校验已改为固定轮次字节比较并补测试。
- `P2-01 Worker 配置缺少生产可观测性，compatibility_date 偏旧` 已完成：API/Web 已启用 Workers Logs，生产和 dev 配置均显式设置 observability，Worker `compatibility_date` 与 Web `compatibilityDate` 已更新到 `2026-05-26`，部署文档已记录更新和 dry-run 验证流程。
- `P2-02 zip 批量导入文档明显超前于当前实现` 已完成：PRD 和技术设计已拆分当前任务记录、manifest 解析、JSON `galleries` 处理能力，以及后续 R2 直传异步 zip 导入设计。
- `P2-03 媒体访问文档写 R2 presigned URL，但代码实际为 Worker 代理` 已完成：受保护图片访问已统一为服务端权限校验后 Worker 代理返回 R2 对象，文档、常量、路由注释和测试均已同步。
- `P2-04 前端自动化测试缺失` 已完成：Web 已接入 Playwright smoke，使用本地 mock API 覆盖首页、搜索、图库详情、登录、用户中心和后台首页，并在 360/768/1024/1440 视口检查核心渲染、私有 key 不泄露和横向溢出。
- `P2-05 dev 环境复用正式 D1/R2 数据` 已完成代码侧防护：dev 后台显示正式数据风险标识，管理端写请求统一弹出二次确认；后续如需更强隔离再拆分独立 dev D1/R2 资源。
- `P2-06 文档中的 Turnstile 覆盖范围与当前实现不一致` 已完成：后台复用普通登录入口，后台导入任务创建/处理已补 Turnstile 校验并更新文档口径。
- `P2-07 审计日志覆盖整体较好，但旧站迁移批量入口仍需补齐确认` 已完成：已建立后台写操作审计覆盖矩阵，旧站迁移批量下载入口和导入任务处理完成态已补审计日志与单元测试。
- `P2-08 公开 API、错误响应和前端错误处理格式不统一` 已完成：API 已新增统一错误 helper，后台图库/媒体/旧站迁移、鉴权、限流、全局 404/500 和外部导入错误均输出 `{ statusCode, message, code?, detail? }`。
- `P3-01 文档中规划态、当前态和历史态混写` 已完成：PRD 和技术设计文档已增加统一状态标签说明，并对主要章节标注当前实现、部分实现、后续规划或历史参考。
- `P3-02 文档中的文件大小和上传限制不统一` 已完成：当前内容图片上传口径统一为 10MB；头像 2MB、联系方式二维码 2MB、站点图标 1MB 按独立入口限制记录。
- `P3-03 缺少 lint / format 配置和 CI 约束` 已完成：根级 ESLint flat config、`.editorconfig`、`pnpm lint` 和 CI lint 步骤已接入，当前 lint 以 `--max-warnings=0` 零 warning 通过。
- `P3-04 覆盖率未知` 已完成首轮收敛：API 已接入 Vitest v8 coverage，核心安全/导入模块设置基线阈值，CI 上传覆盖率 artifact。
- `P3-05 后端路由文件过大，业务逻辑集中在路由层` 持续收敛中：认证路由中的邮箱验证码业务已抽到 `services/email-verification.ts`，后台用户列表查询已抽到 `services/admin-users.ts`，均已补 service 单测；后续继续拆图库、媒体和用户写操作。
- `P3-06 Stream 字段和签名逻辑存在，但生产视频链路未接入` 已完成收敛：Stream 接入前 UI 继续默认隐藏视频入口，API 缺少 Stream secrets 时返回 503 `STREAM_NOT_CONFIGURED`，不触发未配置的签名请求。
- `corepack pnpm --filter @meigallery/web typecheck` 当前通过，但仍打印 `vue-router/volar/sfc-route-blocks` package export 非阻断警告，后续依赖升级阶段继续跟踪。
- P1/P2/P3 当前台账项已全部完成或完成首轮收敛；持续增强已推进 lint 零 warning、后台用户列表服务化、Web 组件测试扩展、公开封面外链安全、后台媒体外链展示安全、邮件模板注入防护、规则 Markdown 链接安全、站点设置公开 URL 内部地址拦截和真实案例图片 R2 key 所属校验收敛，后续工作以继续路由服务化、扩展后台复杂组件测试和按需收紧格式规则为主。

## Git 状态

- `main`：生产分支，必须通过 PR 合入，禁止直接推送。
- `dev`：开发主线，当前变更先推送到 `origin/dev`。
- 合入生产：从 `dev` 创建 PR 到 `main`，验证通过后合并。

## 真实案例命名和路径

- 当前业务命名：`cases` / `case_images`。
- 当前公开路由：`/cases`、`/cases/:slug`。
- 当前公开 API：`/api/cases`、`/api/cases/:slug`、`/api/cases/images/:imageId`。
- 当前后台路由：`/admin/cases`。
- 当前 R2 key：`cases/{caseId}/{imageId}.{ext}`。
- 旧 `testimonial_*` 表已迁移并删除；旧 `testimonials/` R2 对象可以作为回滚备份保留，不参与当前读取。

## 文档说明

- 当前状态权威文档：`AGENTS.md`、本文档、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/GIT_WORKFLOW.md`。
- 产品和设计文档：`docs/PRD*.md`、`docs/PRD_QUALITY_REVIEW.md` 与 `docs/UI_DESIGN.md` 保留产品需求、路线图、验收口径和设计约束；其中标注为草案、规划或后续阶段的内容不代表当前生产状态。
- 代码与文档 review 问题台账：`docs/CODE_AND_DOC_REVIEW_ISSUES.md` 记录全项目代码、配置和文档审查发现的问题、影响和修复方案。
- 代码库分析文档：`docs/codebase/*.md` 记录从代码和配置验证出的栈、结构、架构、约定、集成、测试和风险。
- 历史归档：`docs/plans/**` 与 `docs/superpowers/**` 为历史计划、规格和实现记录，可能包含 Nuxt 3、`testimonial_*`、旧路由或旧权限名，不代表当前生产状态。
