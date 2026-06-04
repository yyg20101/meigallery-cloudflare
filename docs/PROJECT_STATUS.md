# 项目当前状态

更新时间：2026-06-04

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
- D1 migrations：仓库当前维护到 `0021_home_ad_schedule.sql`；部署前需按目标环境执行所有未应用迁移。
- 对象存储：Cloudflare R2 `meigallery-media`。
- 视频：Cloudflare Stream 仍未接入，相关 secrets 为占位符，视频能力按规划保留；API 在缺少 Stream secrets 时返回 503 `STREAM_NOT_CONFIGURED`。
- 生产部署：PR 合入 `main` 后手动执行 `./scripts/deploy.sh production` 或等价 wrangler 命令。
- CI：`.github/workflows/ci.yml` 只做 PR/dev 推送的测试、类型检查和构建验证，不自动部署生产。

## 功能实现现状

- 已实现：公开图库/标签/搜索/真实案例、登录注册、用户名登录、邮箱验证开关、用户中心、个人设置、后台图库/标签/用户/设置/审计、首页广告位配置/排期/后台实时预览/文案长度约束、前后台同款广告位安全清洗、首页内容配置保存校验和公开读取兜底、图库批量操作、图片上传、封面设置、单媒体 rank 配置、WordPress 迁移辅助、Telegram `gallery` / `case` 外部导入、Facebook Pixel 设置。
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
- `P3-05 后端路由文件过大，业务逻辑集中在路由层` 持续收敛中：认证路由中的邮箱验证码业务已抽到 `services/email-verification.ts`，后台用户列表查询已抽到 `services/admin-users.ts`，后台图库列表/详情/创建/更新/发布/下架/归档/批量操作已抽到 `services/admin-galleries.ts`，后台媒体列表/上传/封面/排序/更新/删除已抽到 `services/admin-media.ts`，均已补 service 单测；后续继续拆用户写操作。
- `P3-06 Stream 字段和签名逻辑存在，但生产视频链路未接入` 已完成收敛：Stream 接入前 UI 继续默认隐藏视频入口，API 缺少 Stream secrets 时返回 503 `STREAM_NOT_CONFIGURED`，不触发未配置的签名请求。
- `corepack pnpm --filter @meigallery/web typecheck` 当前通过，但仍打印 `vue-router/volar/sfc-route-blocks` package export 非阻断警告，后续依赖升级阶段继续跟踪。
- P1/P2/P3 当前台账项已全部完成或完成首轮收敛；持续增强已推进 lint 零 warning、后台用户列表服务化、后台图库服务化、后台媒体服务化、Web 组件测试扩展、公开封面外链安全、后台媒体外链展示安全、邮件模板注入防护、规则 Markdown 链接安全、站点设置公开 URL 内部地址拦截、首页 SEO 读取后台站点设置、首页 SSR 原始 HTML 级 SEO 回归验收、生产部署后 SEO head 自动校验、后台保存站点 SEO 后即时刷新前台公开设置、后台强制刷新公开设置失败时提示当前会话可能仍为旧值、公开站点设置接口 no-store 避免 SEO/广告位配置旧值缓存、公开站点设置首次失败允许后续普通请求重试、公开站点设置单条历史损坏 JSON 容错、后台站点设置读取/保存历史损坏 JSON 容错、邮箱验证开关历史损坏 JSON 容错、首页广告位链接/排期/文案长度安全收敛、首页广告组件边界文案二次清洗、公开读取侧历史异常广告设置清洗、后台实时预览同款清洗、后台广告预览异常文案可感知提示、首页内容配置数量/slug/规则 Markdown 输入归一化和历史异常读取兜底、首页广告位四断点溢出验收、首页广告位含凭据 URL 拒绝、首页广告位反斜杠歧义 URL 拒绝、首页广告位后台/API/资源路径拒绝、真实案例图片 R2 key 所属校验、联系方式链接/二维码安全收敛、后台联系方式二维码预览安全兜底、图库媒体 R2 key 所属校验、后台旧站迁移外链安全兜底、导入错误报告 R2 key 所属校验和 Import Token 禁用审计收敛，后续工作以继续路由服务化、扩展后台复杂组件测试和按需收紧格式规则为主。
- 发布 PR #8 的 Playwright smoke 已补 mock API 站点设置重置入口，避免后台 SEO 保存测试污染后续断点的首页 SSR SEO 基线；由于 smoke 四个 viewport 共用同一个 mock API 可变状态，Playwright 当前固定单 worker 串行执行，避免跨 viewport 的 reset / PATCH 竞争。
- 首页广告位外链持续增强：前台 CTA 已补离站可感知名称、离站/隐私提示，并将广告外链 `rel` 扩展为 `noopener noreferrer nofollow sponsored`；Playwright smoke 已覆盖最终浏览器 DOM 中的外链安全属性、`no-referrer` 和离站提示。
- 规则 Markdown 外链持续增强：规则页和悬浮规则面板渲染的外链已统一输出 `noopener noreferrer nofollow` 与 `referrerpolicy="no-referrer"`，并拒绝带用户名/密码或反斜杠歧义的 URL。
- 联系方式链接持续增强：前台联系方式跳转和二维码弹层外链已拒绝带凭据、反斜杠歧义 URL，并统一输出 `noopener noreferrer nofollow` 与 `referrerpolicy="no-referrer"`。
- 联系方式二维码来源页保护增强：前台联系方式二维码图片预览已统一设置 `referrerpolicy="no-referrer"`，避免外部二维码图床收到当前页面路径。
- 后台安全外链持续增强：后台旧站迁移等共用外链展示已统一输出 `noopener noreferrer nofollow` 与 `referrerpolicy="no-referrer"`，媒体 URL 清洗同步拒绝带凭据和反斜杠歧义地址。
- 后台安全外链透明度增强：后台共用外链组件已补目标域名与不发送来源页提示，外链无障碍名称同步包含清洗后的目标域名，并允许长 URL/长域名在表格中自然断行。
- 旧站迁移来源展示增强：后台旧站迁移来源列表已兼容 API 返回的 `base_url` 字段并复用安全外链组件，避免来源地址显示为空，同时提供目标域名、不发送来源页和长 URL 断行提示。
- 后台错误提示持续增强：旧站迁移执行/下载媒体和图库媒体上传已统一优先读取 API 标准错误体 `message`，避免服务端安全校验原因被旧 `{ error }` 格式兼容逻辑吞掉；前端已无 `e.data.error` 读取残留。
- 图片类站点设置持续增强：`site_icon` 和 `og_image` 已从普通公开 URL 中拆分为图片类公开设置 URL，仅允许安全 HTTPS 图片地址或 `/api/media/public/site/` 站点公开媒体路径，避免 favicon/OG 图加载普通页面或非站点公开媒体路径。
- 非公网 IPv4 外链持续增强：旧站导入下载、公开站点设置、联系方式链接、前端媒体预览和规则 Markdown 外链已从传统 localhost/私网拦截扩展到运营商共享地址、文档/测试地址、链路本地、组播和保留 IPv4 段，避免外链配置指向非普通公网目标。
- 站点 SEO 保存持续增强：后台站点设置写入已改为 upsert，缺失 `site_settings` 行时也会自动补齐，避免后台显示保存成功但公开 SEO 仍回退默认标题。
- 生产 SEO 校验持续增强：`verify:seo:production` 已新增 API 侧默认 SEO 防回归和显式期望值校验，CI 已接入脚本测试，避免公开设置与首页同时回退到 `MeiGallery - 精选写真图库` 时误判通过。
- 公开 SEO 读取持续增强：`/api/settings/public` 会在整包公开设置响应阶段清空历史迁移写入的 `MeiGallery - 精选写真图库` SEO 默认值，前台改为回退到当前站点名；后台 SEO 输入框也已改为示例式 placeholder，避免旧标题再次误导保存。
- 后台图库图片预览持续增强：编辑/新建图库的媒体网格和封面预览已改走管理员鉴权预览接口，不再受公开缩略图“仅发布且免费内容可访问”的规则影响；管理员预览仍保留 R2 key 所属校验和安全外链清洗。
- 后台图库预览来源页保护增强：编辑/新建图库的媒体网格和封面预览图片已统一设置 `referrerpolicy="no-referrer"`，避免后台页面路径在加载外部图片或跨域 API 预览时作为来源页带出。
- 首页广告位语义持续增强：前台广告组件已补“推广”标识，外链 CTA 通过 `aria-describedby` 关联离站和不发送来源页提示；组件测试与 Playwright smoke 同步覆盖站内/外链差异，避免安全提示仅停留在视觉文本。
- 后台广告预览持续增强：站点设置页的首页广告实时预览已使用不可跳转预览模式，保留前台同款广告视觉和外链安全提示，但不渲染可点击链接，避免运营编辑配置时误点离开后台。
- 公开 URL 混淆地址回归增强：公开站点设置 URL、首页广告 URL 和广告组件边界测试已覆盖十进制、十六进制、八进制、短写 IPv4 与 IPv6 地址写法，确保浏览器归一化后的本机/非公网地址不会被误放行。
- CI 运行时持续增强：GitHub Actions 已在 workflow 顶层启用 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`，提前验证 checkout、setup-node、upload-artifact 和 pnpm action 在 Node 24 action runtime 下的兼容性；项目命令自身仍由 `setup-node` 固定使用 Node 20。
- 首页广告位外链透明度增强：前台广告 CTA 和后台实时预览已在离站提示中展示清洗后的目标域名，并将域名写入外链按钮无障碍名称，避免泛化按钮文案掩盖实际跳转目标。
- 首页广告位长域名响应式增强：前台广告离站提示、赞助来源和后台预览链接已允许长域名/长 URL 断行，Playwright smoke 使用长外链域名覆盖四个视口，避免安全提示本身造成横向溢出。
- 前端 API 错误解析持续增强：新增统一错误消息解析工具，注册、忘记密码和后台图库批量操作已移除内联 `JSON.parse(e.data)`，统一优先展示标准错误体 `message` 并兼容历史 `error` 字段。
- 后台 SEO 同步状态增强：站点设置页已展示首页公开读取到的站点名、SEO 标题、站点描述和 OG 信息，并在保存后即时刷新校验，Playwright smoke 覆盖“待同步 → 已同步 → 首页 head 更新”链路。
- 前端错误提示持续增强：登录、个人设置、后台图库/真实案例/标签/用户/站点设置/导入/联系方式/Import Token 等页面已统一使用 `resolveApiErrorMessage`，避免标准错误体、历史 `error` 字段或字符串 JSON 错误在页面层被吞掉。
- 首页广告位站内跳转透明度增强：站内广告 CTA 已补目标页面提示和包含精确路径的无障碍名称，前台 smoke 与组件测试覆盖站内/外链两类提示，避免外链有安全说明而站内跳转去向不明确。
- 首页广告位公开状态增强：`/api/settings/public` 已新增只读派生字段 `home_ad_active`，由服务端基于广告开关与排期统一判断当前是否展示；前台优先使用该字段，旧公开响应继续保留本地排期计算兜底。
- 公开 URL 凭证参数持续增强：站点图标、OG 封面图、首页广告链接和规则页链接已拒绝 `token`、`api_key`、`signature`、`access_token` 等凭证类 URL 参数，覆盖 query 与 hash 片段，API 写入、公开读取和前端预览同款兜底。
- 首页广告跳转参数持续增强：站内广告链接中的 `redirect`、`next`、`return_to` 等跳转目标已限制为公开前台路径，拒绝空目标、后台/API/资源路径、外站和嵌套危险跳转；登录页成功后的 `redirect` 参数已增加站内安全兜底，并保留后台正常登录回跳。
- Facebook Pixel 隐私持续增强：前端埋点在当前 URL query 或 hash 含 `token`、`api_key`、`signature`、`access_token` 等凭证类参数时会跳过 Pixel 初始化和事件上报，埋点文本清洗同步覆盖凭证参数，避免敏感 URL 被第三方脚本带出。
- Facebook Pixel 脚本加载隐私增强：前端加载 `fbevents.js` 时已统一设置 `referrerPolicy="no-referrer"`，减少第三方脚本请求携带当前页面 URL 的风险；工具测试覆盖脚本地址、异步加载和来源页策略。
- Web Worker 安全响应头增强：前端 Worker 已通过 Nuxt routeRules 为全站响应补充 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin` 和收紧的 `Permissions-Policy`，降低页面被嵌入、MIME 嗅探、来源页过度泄露和无关浏览器能力调用风险。
- Web SSR API 代理头部安全增强：`/api/**` 代理请求头已改为显式白名单，仅转发认证、内容协商和限流识别需要的头；API 响应头也只透传登录、限流、缓存、下载和跳转相关业务头，避免 `Origin`、`Referer`、`Sec-*`、`Server`、压缩和连接类头在 Web Worker 与 API Worker 之间不必要穿透。
- Web 图片来源页保护增强：公开图库、真实案例、首页媒体、用户头像、联系方式二维码和后台预览类 `<img>` 已统一设置 `referrerpolicy="no-referrer"`，避免图片请求携带当前页面路径；新增 Vue 模板静态回归测试，后续新增图片标签缺少该策略会直接失败。
- 后台导入下载链接安全增强：导入错误报告 CSV 下载地址已改为通过工具函数生成，任务 ID 仅允许安全字符并做路径编码，异常 API 基地址不渲染下载链接，下载请求统一设置 `referrerpolicy="no-referrer"`。

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
