# 技术设计文档

## 0. 状态标签说明

本文使用以下状态标签区分当前代码事实、部分实现、后续设计和历史迁移背景：

- `[当前实现]`：仓库已有代码、配置、迁移或测试支撑。
- `[开发实现，待统一验证]`：源码与 migration 已完成，但按当前开发顺序尚未执行配置、migration、构建、测试或环境 QA。
- `[部分实现]`：已有数据结构、入口或辅助能力，但端到端流程仍未完整接入。
- `[后续规划]`：需要单独设计、实现和验收的目标态能力。
- `[历史参考]`：旧站、旧命名或迁移背景，不代表新增功能入口。

## 1. 技术目标 `[当前实现 / 后续规划]`

- 所有用户可见页面、弹层、状态和跨页流程执行 Figma-first 门禁：先在正式 Figma 文件完成独立 Frame、Prototype、Delivery Index 与设计 QA，再进入 KMP 或 Nuxt 实现；缺少正式 Node ID 时不得用代码自行创造临时 UI。
- Page ID、设计路由、Figma Node ID 与状态 key 仅作为设计交付、实现映射和测试追踪元数据保留，KMP 与 Nuxt 的真实 UI 不得可见渲染这些标注；面向用户的业务编号必须由独立产品需求明确规定。
- 使用 Cloudflare 作为唯一部署和运行平台。
- 前台和后台共用同一套认证、权限、媒体访问控制能力。
- 所有受保护媒体都必须经过服务端授权，前端不持有真实资源地址。
- 批量导入源码已实现私有 R2 multipart 原包上传、ZIP 中央目录范围读取、逐项 Queue 处理、部分失败与安全重试；配置、migration 和统一验证后置，避免大文件、图片与视频处理阻塞请求。
- 会员等级使用 rank 数值比较，业务逻辑不硬编码等级名称。

## 2. 技术栈 `[当前实现 / 后续规划]`

- 前端框架：**Nuxt 4**（Vue 3 全栈框架，Nitro preset `cloudflare-module`，部署为 Cloudflare Worker）。
- 后端框架：**Hono**（部署为独立 Cloudflare Worker，纯 API 服务）。
- UI 层：Vue 3 + Composition API + Tailwind CSS v4（前台）+ Nuxt UI v4（后台）。
- 数据库：Cloudflare D1（SQLite 兼容，通过 Worker bindings 访问）。
- 对象存储：Cloudflare R2（通过 Worker bindings 访问）。
- 视频：Cloudflare Stream（REST API 调用）。**当前状态：未接入**，Stream secrets 为占位符，729 个视频待处理。
- 人机验证：Cloudflare Turnstile。
- CI/CD：**手动部署**：GitHub Actions 只做验证，生产使用 `corepack pnpm --filter @meigallery/api exec wrangler deploy --env=""` 和 `corepack pnpm --filter @meigallery/web exec wrangler deploy --env=""`。
- 包管理器：pnpm（workspace monorepo）。
- 组件预览：当前未配置 Histoire；历史文档中提到的 Histoire 属于规划项。

### 架构决策 `[当前决策]`

**前后端分离**：前端（`packages/web`）和后端（`packages/api`）各为独立 Worker，通过 HTTP 通信。这允许前后端并行开发，各自独立部署。

**Workers 而非 Pages**：当前项目统一使用 Workers + Workers Assets，Web 和 API 都通过 Wrangler Worker 配置部署，避免 Pages 与 Workers 双平台状态分叉。

### 选型依据 `[当前实现]`

| 需求 | 满足方式 |
|------|----------|
| SEO（图库详情页需要被搜索引擎索引） | Nuxt SSR，Nitro preset `cloudflare-module` |
| 前后端分离并行开发 | 独立 Worker：web + api |
| 后台 SPA | Nuxt `routeRules: { '/admin/**': { ssr: false } }` |
| API 类型安全 | Hono + `@meigallery/shared` 共享类型包 |
| D1/R2 绑定 | Hono 通过 `c.env.DB` / `c.env.R2` 访问 |
| 图片优化 | Cloudflare Images Free Transformations + R2 优先处理公开缩略图，首期固定 `w=480` 单规格；每月 5,000 unique transformations，未启用、转换失败或超限时回退原图响应 |

## 3. 应用模块（monorepo 结构） `[当前实现]`

| 包 | 路径 | 职责 |
|------|------|------|
| `@meigallery/web` | `packages/web/` | Nuxt 4 前端 Worker：首页、列表、搜索、详情、登录注册、用户中心、管理后台 UI |
| `@meigallery/api` | `packages/api/` | Hono API Worker：认证、图库 CRUD、搜索、媒体授权、后台管理、导入处理 |
| `@meigallery/shared` | `packages/shared/` | 共享类型定义、常量（会员 rank、标签类型、R2 key 前缀等） |

## 4. 认证模块 `[当前实现]`

### 登录方式 `[当前实现 / 后续规划]`

邮箱 + 密码（首期唯一方式，后续可扩展 Magic Link）。

### 密码存储 `[当前实现]`

当前实现使用 Cloudflare Workers 原生 Web Crypto PBKDF2，不存储明文密码。salt 自动生成且不复用。

- 哈希格式：`$pbkdf2$iterations$salt_base64$hash_base64`。
- 当前参数：PBKDF2-HMAC-SHA-256，100000 次迭代，16 字节随机 salt，32 字节派生 key。
- 校验时使用固定轮次字节比较，不使用普通字符串短路比较。
- 后续如提高迭代次数或切换算法，保留格式前缀作为版本识别；用户成功登录、重置密码或修改密码时可触发重新哈希。

### 会话管理 `[当前实现]`

- Web/Nuxt 会话继续使用下述 Cookie 方案；独立 App 不复用 Cookie，也不把 Web session token 当作移动端凭证。
- 使用 HttpOnly + Secure + SameSite=Lax 的 cookie 存储 session token。
- session token 由服务端签发，使用 `SESSION_SECRET` 签名。
- 会话有效期 30 天，滑动续期：剩余不足 15 天时自动续期 30 天并同步刷新 cookie。
- 登出时服务端销毁 session 记录。

### 独立 App 账号与设备会话 `[开发验证，默认关闭]`

`0069_app_account_access.sql` 和 App API v2 `1.2.0` 已建立 Auth-1 保守账号基线：

- 现有 `users` 继续作为唯一账号主体；`app_account_security.account_public_id` 提供不可枚举的 `acc_*` API ID，不向客户端暴露 D1 自增 ID。
- App 只启用邮箱开发适配器。旧 Web 账号只有在密码验证成功后才创建 `app_account_identities` 映射；相同邮箱、昵称或头像不能触发静默合并。
- 注册必须使用邮箱验证码并提交与 bootstrap 一致的条款、隐私、平台运营说明和必要资格说明版本；只创建观看者账号，不创建 Person/Profile。
- 每次登录建立服务端 `app_devices` 和 `app_sessions`。安装标识必须是客户端随机值，服务端只保存其 SHA-256 摘要，不使用广告 ID、硬件序列号或精确位置。
- Access Token 有效期 15 分钟；Refresh Token 旋转后重新获得 30 天有效期。两种 Token 均为 256-bit 随机不透明值，D1 只存 SHA-256 摘要。
- 刷新在同一会话行替换 Access/Refresh 摘要，旧 Access 立即无效；`app_refresh_token_history` 用于发现旧 Refresh 重放，命中后撤销整个会话并写 `app_account_security_events`。
- 每次 Bearer 鉴权都读取账号、设备、会话状态和两级 session version，并校验当前文档同意；账号禁用、设备远程退出、版本提升或文档更新在下一次 API 调用生效。
- 远程退出先验证设备属于当前账号，再区分当前设备；重复退出已撤销设备返回相同终态，不泄露其他账号设备是否存在。

运行时开关：`APP_AUTH_ENABLED`、`APP_AUTH_REGISTRATION_ENABLED`、四类文档版本、对应的 `APP_AUTH_TERMS_URL`、`APP_AUTH_PRIVACY_URL`、`APP_AUTH_PLATFORM_NOTICE_URL`、`APP_AUTH_ELIGIBILITY_URL` 和 `APP_AUTH_TURNSTILE_SITE_KEY`。production 还必须配置 `TURNSTILE_SECRET_KEY`；任一必要条件缺失、文档 URL 非 HTTPS 或 Turnstile Site Key/Secret 只配置一侧时，bootstrap 返回 `auth=false`。production Wrangler 继续显式关闭 Auth；dev 仅为内部 Safety-2 端到端联调开启 Auth，注册仍关闭，四类临时正文统一指向 dev Web `/rules`。该联调状态不允许推断 G-01/G-03 已关闭，也不得复制到 production。

### Turnstile 集成 `[当前实现]`

以下操作必须验证 Turnstile token：

- 登录
- 注册；邮箱验证码开启时，由发送验证码接口完成验证，注册提交验证码。
- 发送邮箱验证码。
- 后台登录复用普通登录入口，因此通过登录接口完成验证。
- 后台导入任务创建和处理。

App 使用 `GET /api/v2/auth/turnstile?purpose=...` 的受控 HTML 页面承载原生 WebView，不使用 JavaScript bridge。登录、请求注册验证码和注册提交分别使用 `app_login`、`app_email_challenge`、`app_register` action，token 不得复用。服务端使用 `TURNSTILE_SECRET_KEY` 调用 Cloudflare Siteverify，发送幂等 ID 和可信客户端 IP，校验 action；production 额外校验 hostname。Cloudflare 官方 always-pass 测试密钥的 `test`/缺失 action 只允许在 `APP_ENV=local` 兼容，不适用于 dev、production 或真实密钥。网络异常、非 2xx 和响应异常均 fail closed 为可重试 503。完整安全约束见 `docs/app/AUTH_1_CROSS_REPO_INTEGRATION.md`。

### 独立 App 单向互动 `[开发验证，默认随 Auth 关闭]`

`0070_app_viewer_interactions.sql` 和 App API v2 `1.3.0` 建立 Interaction-1 喜欢/关注保守基线：

- `app_viewer_interactions` 只保存 `account_id`、稳定 `profile_id`、`like|follow` 关系类型和 ISO 创建时间；复合主键保证幂等，migration 不 seed、不回填 legacy 互动、不生成聚合计数。
- `GET /api/v2/person-profiles/:profileId/interactions`、`PUT|DELETE .../like|follow` 和 `GET /api/v2/me/likes|follows` 全部复用 App Bearer 会话中间件，请求体不接收账号 ID。
- PUT 通过参数化条件写入在 D1 内重新校验当前资料的认证、发布、授权时间、可见性和来源图库状态；DELETE 不依赖资料仍公开，便于用户清理已失效关系。
- 本人列表以 `created_at DESC, profile_id ASC` 稳定分页。`GET /api/v2/me/likes|follows` 可选接收最长 40 字符的 `query`、地区 stable code `region` 与风格 stable term ID `styleTerm`；所有条件只作用于当前账号私有列表读取，不改变关系。搜索命中当前公开姓名、地区、公开标签与已发布 taxonomy 显示名/别名，地区和风格继续复用公开资格投影。
- 不透明游标绑定账号、关系类型、规范化搜索、地区和风格完整上下文；查询条件变化、游标版本变化或跨账号复用均拒绝，客户端必须按当前条件从首屏重读，不得跨版本混排。资料已失效时，无筛选列表只返回 `profileId`、关系时间和 `PROFILE_NOT_AVAILABLE`；带搜索或筛选时失效资料不参与匹配，绝不泄露历史封面、地区、标签或简介。
- bootstrap 只在 Auth 安全配置整体可用时返回 `interactions.like=true` 和 `interactions.follow=true`；收藏与历史由 Interaction-2 独立门禁控制，不随 Auth 或喜欢/关注自动开启。production 现有 Auth 开关保持关闭；dev 因内部 Safety-2 联调开启 Auth，会同时暴露既有喜欢/关注契约，但不开放注册且不改变生产上线状态。
- Interaction-1 本身不提供按目标资料查看互动者的产品 API，也不创建匹配、会话、目标侧通知或推荐信号。关注更新由 Interaction-3 独立读取发布事实；收藏/收藏夹与历史使用 Interaction-2 独立表族，不得写入当前关系表。

完整跨仓边界与验收要求见 `docs/app/INTERACTION_1_CROSS_REPO_INTEGRATION.md`。

### Interaction-2 收藏夹与浏览历史 `[跨仓开发完成，默认关闭]`

`0078_app_favorites_and_view_history.sql` 和 App API v2 `1.11.0` 建立收藏夹与浏览历史服务端开发基线；该切片在累计契约 `1.21.0` 与 `0096_app_favorite_folder_preserve_default.sql` 完成 Figma-first 对齐，仓库当前累计契约为 `1.26.0`：

- 收藏是独立于喜欢、关注的账号私有关系，使用默认收藏夹、自定义收藏夹和条目表，不向 `app_viewer_interactions` 增加临时 `favorite` 类型。同一人物可存在于多个文件夹；全局取消收藏才移除全部文件夹关系。
- 默认收藏夹按账号懒创建且不可删除；自定义收藏夹使用客户端随机稳定 ID 幂等创建，重命名、排序和删除要求 `expectedVersion`，名称最多 20 字。删除自定义收藏夹前，`0096` 触发器把其中条目保留到默认收藏，不能取消喜欢。文件夹数量读取可执行 `favorite.folder_count` entitlement，会员降级保留已有数据并只阻止继续超额创建。
- 收藏夹总览返回账号去重总数和每夹最多四张当前仍公开的预览图；收藏列表支持最多 40 字账号私有搜索、单地区 code 和单风格 taxonomy term ID。游标绑定账号、文件夹与完整筛选条件，条件变化必须重开分页。
- 浏览历史默认关闭。用户显式开启后，详情成功呈现才可提交带 `viewId + expectedHistoryVersion` 的记录命令；卡片曝光、预取和详情失败不记录。同一人物聚合为一行，最近同 `viewId` 重放不重复计数。
- 逐条删除与清空历史都会原子提升偏好版本并删除记录，使删除前的在途写请求失效；支持全部清除时同步关闭。列表同时检查行到期时间和当前可执行保留窗口，会员升级不会复活已过期记录。
- 人物被屏蔽时，在既有 Safety 条件批次中清理喜欢、关注、收藏和当前可见历史，并提升历史版本；解除屏蔽不恢复任何旧关系。
- Interaction-4 在不改变 API/UI 的前提下补齐浏览历史生命周期：只有显式策略 ID、`history_retention_decision_status=approved` 与 `purge_enabled=1` 同时有效时，每日任务才按 `expires_at, account_id, profile_id` 有界物理删除并报告积压；能力或记录开关关闭后不撤销既有删除义务。
- `APP_INTERACTION_COLLECTIONS_ENABLED`、策略版本和 production-ready 是独立运行门禁；当前未加入 Wrangler 配置，全部现有环境继续返回 `favorite=false`、`history=false`。OQ-014、OQ-020 与 OQ-023 未关闭，development 清理会安全跳过、不接推荐信号，也不把技术上限当作会员销售承诺。
- KMP 已实现严格 bootstrap/DTO Mapper、收藏状态与多文件夹 transport、文件夹页面、详情收藏/归属调整，以及浏览记录显式设置、成功详情展示后稳定事件 ID 写入、分页、逐条删除和版本化清空。`APP-INT-03/04/05/06` 的正式页、弹层、空态和失败态必须先有 Figma Node ID；`APP-INT-06` 以服务端结果更新勾选状态，更新失败保留旧值，移出唯一剩余收藏夹先二次确认。当前不存在独立“全部收藏”卡片。账号绑定设置缓存、降级保留和旧版本不重放均由客户端显式处理。
- 当前仍未修改环境配置、执行 `0078`/`0096` migration、切换会员 entitlement、运行构建、专项测试、Framework 链接、模拟器/真机、`android-cli` 截图或远端联调；所有现有环境保持 capability 关闭。

完整边界见 `docs/app/INTERACTION_2_FAVORITES_HISTORY_INTEGRATION.md`。

### Interaction-3 关注更新流与站内通知 `[Cloudflare 与 KMP 开发完成，默认关闭]`

`0079_app_follow_updates.sql` 和 App API v2 `1.12.0` 建立关注对象公开发布更新的服务端开发基线：

- `person_publication_reviews` 是唯一更新事件事实，不新增动态正文、媒体摘要或历史人物快照表。只有 `published` 且晚于当前关注关系和策略 `effective_at` 的记录可进入更新流。
- `GET /api/v2/me/follow-updates` 按 `reviewed_at DESC, publication_id DESC` 游标分页，游标绑定账号；响应携带事件版本与当前仍公开的人物投影，不返回草稿、内部审核信息或受保护媒体。
- `app_follow_update_policies` 只保存 feed、站内通知投影、生产门禁和生效下界；bootstrap 的 `interactions.followUpdates` 不从 `follow=true` 推导。
- 站内通知在用户执行 HTTP pull 时按账号惰性写入既有 Message-3 Outbox，以 `(account_id,event_type,event_ref)` 去重，避免发布事务同步枚举关注者。
- Outbox 投递前重验关注关系、屏蔽状态、发布、认证、用途授权、有效期、可见性和来源图库。取消关注、功能关闭或资料失效后标记 `suppressed`，恢复时不补发旧事件。
- KMP 已接入严格 transport；底部“关注”页按 Figma 收敛为“全部 / 有更新 / 最近关注”筛选，喜欢由独立 `APP-INT-02` 承载，并保留服务端取消关注、事件回收和通知目标跳转。当前未配置 `APP_FOLLOW_UPDATES_*`、未执行 `0079`、未接系统推送，也未运行专项测试或远端联调；所有现有环境 capability 保持关闭。

完整边界见 `docs/app/INTERACTION_3_FOLLOW_UPDATES_INTEGRATION.md`。

### Search-1 人物搜索与搜索历史 `[Cloudflare 与 KMP 开发完成，默认关闭]`

`0080_app_person_search_and_history.sql` 和 App API v2 `1.13.0` 建立登录后人物搜索与账号私有搜索历史的服务端开发基线：

- `POST /api/v2/person-profiles/search` 使用 JSON 正文接收搜索词，避免自由文本进入 URL 和访问日志；应用层不记录请求正文，也不把搜索词写入审计或分析事件。
- 搜索只读取 `profile_public_projections` 的审核展示昵称、公开地区和前 8 个公开标签，复用发现页认证、发布、用途授权、有效期、可见性和来源图库资格，并排除当前账号已屏蔽人物。
- 相关度排序使用确定性的昵称精确/前缀/包含、地区和标签层级；热门与最新复用公开投影分数和发布时间。游标绑定账号、搜索词 SHA-256 和排序，不保存原始搜索词。
- `app_person_search_policies` 把搜索与历史 capability 分开。production 可单独打开人物搜索；搜索历史还要求保留期审批、purge 和 `history_production_ready`，避免未决历史策略阻塞基础搜索。
- `app_search_history_preferences` 以默认关闭、乐观版本和 mutation token 管理账号选择；`app_person_search_history` 只在客户端成功呈现后显式命令写入，同一规范化搜索词聚合、`searchId` 幂等、容量裁剪并按行到期。
- 单条删除和全部清除都会原子提升设置版本，使旧在途记录命令失效；列表和删除只使用 Bearer 会话的内部账号 ID，不接受请求体账号 ID。
- 每日维护任务只在显式策略版本且 `purge_enabled=1` 时分批物理删除到期搜索历史；删除义务不依赖搜索 capability 继续开放，日志只记录数量与固定错误码。
- KMP 已实现 POST 正文搜索、三种排序、分页、命中说明、显式历史开关、成功展示后独立记录、逐条删除与版本化清空；搜索词不进入本地持久化、分析或推荐画像。当前未配置 `APP_PERSON_SEARCH_*`、未执行 `0080`，也未运行 migration/专项测试/模拟器或远端联调；热门词、联想词和隐式行为推荐信号仍后置。

完整边界见 `docs/app/SEARCH_1_PERSON_SEARCH_HISTORY_INTEGRATION.md`。

### Taxonomy-1 稳定目录与人物关联 `[Cloudflare 与 KMP 开发完成，默认关闭]`

`0081_app_taxonomy_catalog.sql` 和 App API v2 `1.14.0` 建立 Search-2 依赖的稳定分类事实与公开投影基线：

- `app_taxonomy_terms` 保存稳定 `term_id` 和编辑态事实，`app_taxonomy_term_revisions` 保存每次变更后的不可变修订；固定支持 11 类 taxonomy，不允许后台任意扩 schema 类型。
- 词条使用 `draft/pending_review/active/hidden/deprecated/merged/archived` 生命周期。创建/编辑校验 slug、父子类型、层级循环和同类型名称/别名冲突；merged 源 ID 永久保留并指向同类型 active 目标。
- `restricted` 敏感词在隐私/法务升级审批未实现前不能进入 active；只有 `active + public + standard + allowed_for_profile` 可用于新人物标注。
- `app_taxonomy_catalogs/items` 从当前有效词条生成不可变快照。公开 `GET /api/v2/taxonomy/catalog` 只在独立 capability 就绪时返回配置目录，支持基于 `catalogVersionId + versionCode` 的 ETag 和 300 秒公共短缓存。
- `app_taxonomy_legacy_mappings` 只允许 `exact/alias/split_required/unsupported/pending_review` 显式类型；未知值默认待复核，不能自动公开或进入搜索/推荐。
- `person_profile_taxonomy_assignments` 绑定人物内容版本、目录和词条版本。设置分类与普通资料编辑一样创建新内容版本、重置认证/发布草稿状态并保留线上投影；普通资料编辑会显式继承当前结构化分类。
- 人物发布新增 `TAXONOMY_ASSIGNMENTS_VALID` 门禁，并在同一 D1 batch 中刷新 `profile_public_projections` 与 `profile_public_taxonomy_terms`；公开 DTO 兼容新增 `taxonomyTerms`，legacy `tags` 只保留迁移期展示兼容。
- 后台 `/api/admin/app/taxonomy` 提供词条草稿/审核/生命周期/合并、目录快照/发布和旧标签映射 API；`PUT /api/admin/app/persons/:personId/taxonomy` 提供人物结构化标注。所有修改要求管理员认证、独立后台能力开关、乐观版本并写审计。
- KMP 已实现 Recommendation/Search 共用的通用目录领域、capability 校验、进程内缓存、ETag 条件重验证和稳定 ID/父级/重定向完整性校验。Nuxt 已实现 `ADM-TAX-01/02/03`，覆盖词条目录、编辑/审核/生命周期/合并、legacy 映射、快照生成、结构与客户端影响检查及不可变发布确认；`ADM-PER-03` 人物工作台已接入目录选择、稳定词条标注、失效项处理和草稿/线上投影对比。当前未配置 `APP_TAXONOMY_*`、未执行 `0081`、未导入 legacy 标签，也未运行 migration/专项测试/模拟器或远端联调；细粒度权限、敏感升级审批、跨域完整影响计数、多语言、灰度/显式回滚和迁移批次后置。

完整边界见 `docs/app/TAXONOMY_1_CATALOG_AND_PROFILE_INTEGRATION.md`。

### Search-2 结构化筛选、结果预估与保存条件 `[Cloudflare 与 KMP 开发完成，默认关闭]`

`0082_app_search_filters_and_saved_filters.sql` 和 App API v2 `1.15.0` 在 Search-1/Taxonomy-1 基线上建立可执行筛选闭环：

- `POST /api/v2/person-profiles/search` 兼容新增 `filters: { catalogVersionId, termIds }`。地区三类形成一个逻辑组；同组 OR、跨组 AND，目录父级包含后代。游标升级为内部 v2，并绑定账号、搜索词哈希、筛选哈希和排序。
- 基础筛选对登录观看者开放；`style/occupation/scene` 需要 `discovery.filter.advanced=basic|full`，`identity/personality/hair/clothing` 需要 `full`。权限每次从服务端会员快照解析，不从等级名称或 rank 推导。
- `POST /api/v2/person-profiles/search/preview` 与正式搜索共用公开资格、屏蔽和筛选 SQL 构造器。只有目录和权限均有效时返回当前精确快照数量；失效或受限条件返回诊断且不计算结果。
- `app_taxonomy_catalog_closure` 快照化父子/merged 闭包，使父级匹配后代，并让合并目标继续匹配仍引用源 stable ID 的公开人物投影。目录生成事务同步创建 closure。
- `app_saved_person_filters` 只保存账号私有名称、canonical taxonomy stable ID、目录和热门/最新默认排序，不保存自由搜索词。创建使用 SHA-256 幂等标识和条件 INSERT 原子限制 `discovery.saved_filter.max`，修改/删除使用乐观版本。
- 会员降级保留既有保存条件；列表按当前目录返回 `active/redirected/invalid` 和权限状态。删除保留最小 tombstone 并清空名称语义与词条内容，禁止旧幂等请求复活。
- `0082` 新增不可变会员开发目录 `amc_app_1_0_search_2_dev_1`，复制五级展示与非搜索权益，只以 canonical `discovery.filter.advanced`、`discovery.saved_filter.max` 提供 Search-2 可执行值；不会自动切换目录或迁移 grant。
- KMP 已实现结构化条件、400ms preview 防抖、服务端 entitlement、目录重定向/失效处理、保存条件 CRUD、使用前完整来源条件重验和乐观版本冲突确认。Nuxt `/admin/app/search` 与 `GET /api/admin/app/search/overview` 已提供只读运营核查：只返回非敏感运行版本和聚合健康计数，不返回搜索词、条件名称或用户明细，也不能直接修改开关、切换目录或迁移 grant。当前未配置 Search-2 策略、未执行 `0082`、未切换 taxonomy/会员目录，也未运行 migration/专项测试/模拟器或远端联调；所有现有环境继续返回 `search.filters=false`、`search.savedFilters=false`。

完整边界见 `docs/app/SEARCH_2_FILTERS_AND_SAVED_FILTERS_INTEGRATION.md`。

### Recommendation-1/2/3/4/5/6 版本化推荐、运营精选、自动停止与证据生命周期 `[Cloudflare 与 KMP 开发完成，默认关闭]`

`0083_app_recommendation_rules_and_editorial.sql` 和 App API v2 `1.16.0` 在统一公开人物资格与稳定 taxonomy 基线上建立推荐运营闭环：

- `POST /api/v2/discovery/recommendations` 提供 `auto|non_personalized|personalized` 三种请求模式；匿名只能执行非个性化，登录身份仅用于屏蔽过滤和读取本人已批准的显式偏好。既有 `GET /api/v2/discovery/feed` 保持兼容且不改变排序行为。
- 推荐候选复用 `app-discovery.ts` 的同一公开资格谓词：只有当前仍满足认证、发布、用途授权、有效期、可见性和来源图库发布要求的投影可返回；运营精选也不能绕过该谓词。
- 当前运行信号只允许资料质量、批准后的热度版本、时效、请求地区和本人主动选择的稳定 taxonomy。会员、金币、消息、搜索、浏览、关注、收藏、精确位置和内部审核字段不进入 Recommendation-1 排序。
- `app_recommendation_rule_versions` 保存模式、整数权重、范围、多样性、灰度、计划时间、最低客户端版本和回退引用。创建/复制幂等，草稿和状态流转使用乐观版本；创建人不能复核自己的规则或精选排期。
- `rolloutPercent=1..99` 必须绑定同入口、同模式、曾安全生效的回退版本；个性化目标/回退目录必须一致。服务端按规则与推荐会话稳定分桶，短期 HMAC 签名游标绑定实际执行规则，客户端不能伪造会话选择灰度桶，单页和跨页不混合两个版本。
- Recommendation-2 已把 KMP 固定发送的 `X-Client-Version` 接入 bootstrap capability、推荐流、本人偏好和实际规则选择：只接受两段/三段数字版本，高版本 scheduled 不覆盖旧客户端仍兼容的 active 版本，active 高于客户端时只使用显式登记且兼容的历史回退。规则最低版本高于策略基线时，即使全量启用也必须登记回退；无兼容规则时安全关闭而不放宽资格。
- Recommendation-3 已把 `targetRegionCodes` 前移到 scheduled/active/历史回退选择：空数组表示全局规则，非空数组只服务明确地区，未选择地区时不猜测。新排期不覆盖请求地区时继续尝试兼容 active；回退必须再次匹配当前地区。地区规则即使全量启用也必须登记回退，全局目标只能回退到全局规则，地区目标回退必须为全局或覆盖目标全部地区；非法范围安全关闭。
- Recommendation-4 让上述有序候选逐条加载完整不可变规则并校验权重、理由、App 渠道、taxonomy/heatVersion 和 production-ready 依赖；高优先规则失效时继续尝试下一条安全版本。个性化候选还绑定账号当前偏好目录，新目录排期不覆盖旧目录偏好；`auto` 的实际灰度回退若失效会重建非个性化执行上下文；bootstrap 只公布通过完整校验的实际规则。
- Recommendation-5 以 `0113_app_recommendation_guardrails.sql` 增加默认关闭的守护控制、经独立复核的目标/反指标策略、仅聚合整数评估、不可变停止事实和运行时回退。部分灰度只有在来源、保留、purge、策略和环境门禁全部满足时可执行；关键数据缺失或 stop 指标连续越线后，任何比例的新会话都排除该版本并只使用登记的 100% 回退。停止事实不伪造规则暂停或管理员动作，复投必须复制新版本。
- Recommendation-6 以 `0114_app_recommendation_evidence_lifecycle.sql` 为既有推荐会话增加账号摘要定位索引和会话/条目 UPDATE 不可变约束。既有 15 分钟调度只在策略显式配置、保留决策批准、天数有效且 purge 开启时有界删除到期会话并级联条目；推荐能力或证据写入后来关闭不取消既有删除义务。Privacy-2B 以同一分用途 HMAC 定位账号关联会话，把会话和条目纳入注销步骤前后零残留计数；开始/重试还会检查稳定 `SESSION_SECRET` 可用。
- 未来 `effectiveAt` 进入 `scheduled`，到点后只影响新会话；立即启用、暂停和回滚会重新校验目标与回退版本。同一入口和模式最多一个 active 与一个 scheduled 版本。
- 运营精选固定返回 `source=editorial`、`disclosure=平台精选`，披露文案不可改为认证、自然热门或未披露推荐；排期提交、批准、启用和每次用户请求均复核人物公开资格。
- `GET/PUT /api/v2/me/recommendation-preference` 管理本人显式偏好。开启必须引用当前可用的不可变 taxonomy 目录和稳定词条；关闭会清空选择，不能保留暗中画像。
- OQ-023 未关闭时服务端拒绝启用个性化；OQ-020 未关闭时不写推荐会话/条目证据；OQ-009 未关闭时热度权重保持 `0`，migration 只建立未批准的空热度版本。
- Nuxt 已实现规则列表、规则编辑、合成 Dry-run、精选排期四个后台页面，并提供提交、复核、启用/排期、暂停和回滚操作。页面按窄屏换行和表格横向容器处理，状态不只依赖颜色。
- KMP 已实现 Recommendation Domain/Repository、严格 `1.16.0` DTO、智能/通用推荐、实际模式与 fallback、推荐理由、固定精选披露、签名游标分页约束，以及本人主动 taxonomy 偏好页面；Android Debug APK 与 iOS Simulator Kotlin/Native 编译通过。
- 当前未配置 `APP_RECOMMENDATION_*`、未执行 `0083/0113/0114`、未批准真实聚合来源/阈值/保留期，也未运行 migration、专项测试、Framework 链接、模拟器/真机或远端联调；所有现有环境继续 fail closed。

完整边界见 `docs/app/RECOMMENDATION_1_RULES_AND_EDITORIAL_INTEGRATION.md`、`docs/app/RECOMMENDATION_2_CLIENT_VERSION_GUARD_INTEGRATION.md`、`docs/app/RECOMMENDATION_3_REGION_SCOPE_AND_FALLBACK_INTEGRATION.md`、`docs/app/RECOMMENDATION_4_EXECUTABLE_RULE_SELECTION_INTEGRATION.md`、`docs/app/RECOMMENDATION_5_GUARDRAIL_AND_AUTOMATIC_STOP_INTEGRATION.md` 与 `docs/app/RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md`。

### Privacy-1 数据权利控制面 `[Cloudflare 与 KMP 开发完成，默认关闭]`

`0094_app_data_rights_control_plane.sql` 和 App API v2 `1.17.0` 建立数据导出与账号注销的申请控制面，不执行尚未获批的真实数据处理：

- `app_data_rights_policies` 分别控制概览、导出申请、注销申请、导出处理、注销处理和取消，并保存 retention、Owner/SLA、region 三类治理决策。development seed 全部关闭且决策为 `unresolved`。
- 申请保存账号、类型和不可变策略快照，使用单调 `version + mutation_token`、受约束状态迁移和只追加事件；同账号同类型最多一条进行中申请。
- 新申请与取消先执行密码二次验证。短期 step-up token 和长期请求级状态 token 只存 SHA-256 摘要，前者单用途单次消费，后者只能查询/验证/取消绑定申请。
- 请求级状态 token 的失效时间以申请截止时间或注销计划执行时间中较晚者为锚点，再叠加不可变策略 TTL，避免等待期本身耗尽注销后唯一自助访问窗口。
- 注销提交原子进入 `deletion_pending`、撤销 App/Web 会话并写安全事件；D1 triggers 阻止新增互动、收藏、历史、搜索历史、话题、观看者消息、会员申请/发放和钱包调整。取消恢复提交前账号快照但强制重新登录。
- 注销创建前，KMP 仅在系统安全区暂存原幂等请求 token 与当次 Access Token。若服务端已提交注销并撤销该 session、但成功响应丢失，原注销 POST 可凭完全相同的幂等键和该已撤销 token 只读恢复原申请及未过期状态凭证；恢复分支重验 session 撤销原因、账号状态、原命令和申请绑定，不能创建新申请、恢复普通会话或访问其他 API。密码与 step-up token 不持久化。
- App API 提供本人概览、列表/详情、导出/注销申请、取消，以及普通会话失效后的三条请求级状态路径。账号 `restricted` 仍可访问必要 `/me` 与数据权利路径，其他能力继续逐请求拒绝。
- `/api/admin/app/data-rights` 和 Nuxt `ADM-PRI-01/02` 提供脱敏队列、领取、开始处理、失败、重试和证据核验取消；没有 Privacy-2 真实证据时不提供完成动作。
- Operations-1 只对超过 `deadline_at` 的非终态申请生成聚合 `data_rights_overdue` Incident，不复制账号或申请敏感内容，也不代替权威状态机。
- KMP 已实现严格 `1.17.0` DTO、系统安全状态凭证、手机单列/宽屏双栏、注销影响逐项确认、退出登录后的申请级访问，以及注销成功响应丢失时对原幂等命令的安全恢复。当前未修改 Wrangler、未执行 `0094`，也未运行 migration、专项测试、KMP 构建、模拟器/真机或远端联调。
- 本段是 Privacy-1 历史边界。Privacy-2A 已以默认关闭方式实现私有 R2 导出制品、一次性下载票据、到期清理与下载审计；Privacy-2B 已完成默认关闭的不可逆删除、保留隔离与完成证明源码，治理审批和运行验证继续后置。

完整边界见 `docs/app/PRIVACY_1_DATA_RIGHTS_CONTROL_PLANE_INTEGRATION.md`。

### Privacy-2A/2C 私有数据导出制品与覆盖补全 `[Cloudflare、Nuxt 与 KMP 开发完成，默认关闭]`

`0102_app_data_rights_private_exports.sql` 与 App API v2 `1.24.0` 在 Privacy-1 控制面上补齐可恢复个人数据副本：

- export profile 与 Privacy-1 policy 一一绑定且不可更新；development seed 为 `production_ready=0`，正式执行继续要求 policy/profile 双重发布、三项治理决策、Queue 和私有 R2 binding 全部就绪。
- 执行器只读取当前 41 个显式白名单分类。Privacy-2C 保持原 35 类 ordinal 不变，只在末尾追加推荐偏好、人物拉黑状态/事件、旧版图库点赞和推荐解释会话/条目；任务创建时冻结每类最大 `rowid` 作为纳入边界，再按小页生成 NDJSON。旧的 35-scope artifact 按自身 scope 数收尾，新 artifact 才生成 41 类。推荐证据以与写入相同的账号 HMAC 定位，但 `account_hash`、`context_hash`、密码、token、数据库数字内部 ID、内部备注和其他账号内容全部排除。
- Queue 消费使用 D1 短租约、generation token、分类游标和确定性 R2 key 恢复；分片、README、manifest 与 TAR 均核验 SHA-256、长度、ETag 和 metadata，只有完整事实一致才把申请推进到 `ready`。
- 申请详情新增 `exportArtifact`。`POST /api/v2/me/data-rights/requests/:requestId/download-tickets` 消费 `export_download` step-up 并签发 `drdl_` 一次性票据；`GET /api/v2/me/data-rights/requests/:requestId/download` 使用专用 `X-Data-Rights-Download-Ticket` Header，原子消费后返回 `application/x-tar` 私有流。
- 下载再次绑定当前普通 session、账号、申请/制品版本、manifest/aggregate SHA-256、R2 ETag、长度和到期时间；票据明文不落 D1、日志、URL 或客户端持久化状态。
- KMP 使用 Ktor `bodyAsChannel()` 以 64 KiB 流写平台文件，严格核验 MIME、文件名、Content-Length 和 manifest 摘要；Android 使用 MediaStore/应用 Documents，iOS 使用临时文件同步后原子移动，失败清理部分文件。
- 到期先使 D1 申请、制品与未消费票据失效，再删除固定前缀的 R2 对象并核验不存在；清理失败保留 `purging` 供定时恢复，不重新开放下载。
- 本段是 Privacy-2A 导出边界。Privacy-2B 已另行实现不可逆注销执行器；OQ-020/OQ-024/OQ-025 未关闭时 `deletionProcessing=false` 仍是硬门禁。
- Privacy-2C 交付时不改变当时累计 App API `1.25.0`、TAR schema、KMP、Nuxt 或 Figma；导出 readiness 额外要求稳定 `SESSION_SECRET`，避免推荐 scope 在快照和分页之间失去账号定位。完整边界见 `docs/app/PRIVACY_2C_DATA_COPY_COVERAGE_INTEGRATION.md`。

完整契约、状态机、Figma 与后置门禁见 `docs/app/PRIVACY_2A_PRIVATE_EXPORT_INTEGRATION.md`。

### Privacy-2B 账号不可逆注销 `[Cloudflare、Nuxt 与 KMP 源码开发完成，默认关闭]`

`0103_app_data_rights_irreversible_deletion.sql` 在 Privacy-1 控制面上补齐九步、可恢复且只能前向推进的注销执行器；该切片继续复用当时累计 `1.24.0` 的既有 deletion 状态和请求级访问形状，Membership-7 后仓库当前累计为 `1.26.0`：

- 不可变 deletion profile 精确冻结九步合同、五项治理决策、身份复用模式和每步治理引用。development profile `drdp_app_1_0_privacy_2b_dev_1` 为 `production_ready=0`，OQ-020/OQ-024/OQ-025 未关闭时不能启动。
- 执行顺序固定为撤销访问、清私有导出、清通知、清发现活动、清账号偏好、匿名化命名分析、关闭平台话题、隔离受监管事实和墓碑化账号。Recommendation-6 已把同一 HMAC 命中的推荐会话与条目纳入“清发现活动”；除保留隔离外，每步完成后剩余计数必须为零。
- Queue 只携带 execution ID；D1 以短租约、当前步骤和不可变 evidence 恢复。只有九步证据、七类保留域和账号墓碑全部核验后，执行器才能写 `completed`；管理员只能开始或重试。
- consent、membership、wallet、messaging evidence、safety、data rights、security audit 七域固定为 `compliance_only`；钱包在隔离前冻结，失败只允许前向修复，不恢复账号或产品写能力。
- `users` 行作为 FK 锚点保留但清除登录身份和可识别资料。可选 identity seal 只保存邮箱的独立 Secret HMAC，并支持 current/previous 密钥轮换。
- 待注销期间的身份、会话、设备、互动、偏好、通知、导出和命名分析重建继续由 D1 triggers 阻断或抑制，避免并发写回已经清除的事实。
- KMP 读到 completed 后清除请求级状态凭证、普通会话和账号域内存，轮换 installation ID，并退出到未登录“我的”。`APP-SET-10` 没有完成态正式 Figma Frame，客户端不创建自拟成功页。
- 当前未修改 Wrangler，未配置 `DATA_RIGHTS_DELETION_QUEUE`、`DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT/PREVIOUS`，未执行 `0103/0114`，也未运行构建、测试、设备 QA 或远端联调。

完整执行合同、保留域、后台行为、Figma 约束和后置门禁见 `docs/app/PRIVACY_2B_IRREVERSIBLE_DELETION_INTEGRATION.md`；推荐证据删除边界见 `docs/app/RECOMMENDATION_6_EVIDENCE_LIFECYCLE_INTEGRATION.md`。

### Media-1 人物图片与认证说明 `[Cloudflare 契约完成；APP-DSC-08 Figma/KMP 静态接线完成，默认关闭]`

App API v2 `1.18.0` 复用现有 `galleries`、`media_assets` 和 `profile_public_projections`，不新增 migration 或第二套媒体事实：

- `GET /api/v2/person-profiles/:profileId/media` 只列出来源图库中上传完成的 R2 图片，游标绑定公开投影版本；不返回 R2 key。
- `POST .../media/:mediaId/access` 以 HMAC 签发 5 分钟、绑定账号公开 ID、当前 App session、人物和单图的凭证；签发和取图两次检查当前会员 rank。
- `GET .../media/:mediaId/content` 每次重新执行统一人物公开资格谓词并由 Worker 代理 R2；只允许 JPEG/PNG/WebP/AVIF、最大 24 MiB、`no-store` 和 `nosniff`。
- `GET .../verification` 只返回四项认证范围、政策/时间/版本和运营主体，不返回 evidence、reviewer 或内部说明。
- `APP-DSC-08` 以 Figma 正式节点 `159:66285`、`159:66346`、`159:66400`、`159:66437` 和支持 Section `750:3580` 为唯一可见 UI 基线。KMP 媒体 token 仅在 Repository 局部变量存在，UI 只接收字节；会员图片授权到期、账号变化或退出页面后清空内存并重新请求。当前页面采用全屏主图、顶部操作、页码胶囊及底部说明/动作，更宽窗口只居中约束，不自行增加 Figma 未定义的缩略图条或侧栏。
- `APP_MEDIA_ENABLED`、`APP_PROTECTED_MEDIA_ENABLED`、production 的 `APP_MEDIA_PRODUCTION_READY` 均未配置；视频固定关闭，专项测试、Gradle、模拟器/真机和联调后置。

完整边界见 `docs/app/MEDIA_1_PERSON_MEDIA_AND_VERIFICATION_INTEGRATION.md`。

### App Core-1 运行策略、帮助与系统状态 `[Cloudflare 与 KMP 开发完成，配置和测试后置]`

App API v2 `1.19.0` 在既有 bootstrap 上兼容新增版本化 `runtime` 与 `support`：

- `runtime.client` 提供最低/最新客户端版本与受控更新 URL；KMP 在版本不足时先于所有业务页面展示强制升级。
- `runtime.service` 使用 `normal/maintenance/partial` 稳定枚举；显式启用但配置不完整或 production 门禁未通过时安全收敛为维护，而不是猜测正常。
- `runtime.region` 只读取 Cloudflare `CF-IPCountry` 和服务端允许国家集合；已配置白名单但国家未知时不开放业务入口。
- `GET /api/v2/app/support` 返回六类版本化帮助主题、公开联系方式和四类法律文档目录；恢复和系统状态页可以访问，但不返回内部风控、审核或账号敏感信息。
- `/me.restriction` 把内部原因映射为四类稳定用户原因，只允许帮助、必要数据权利和退出入口；受限账号不会继续加载设备或进入其他业务页。
- KMP 门禁优先级固定为强制升级 → 维护/部分恢复 → 地区不可用 → 账号受限 → 正常业务，并在人物对象失效时提供返回、重试和帮助。

本阶段不新增 migration，不写 Wrangler 值，不运行 Cloudflare/KMP 构建与专项测试。完整边界见 `docs/app/APP_CORE_1_RUNTIME_SUPPORT_SYSTEM_INTEGRATION.md`。

### Account/Settings-2 账号资料、初始偏好与会话设置 `[Cloudflare、Figma 与 KMP 开发完成，配置和测试后置]`

App API v2 `1.20.0` 以兼容新增方式补齐观看者私有账号资料与单会话设置：

- `0095_app_account_profile_and_conversation_settings.sql` 只新增账号头像样式表、会话免打扰表和会话/账号复合归属唯一键；不 seed、不回填公开真人，也不自动打开能力。
- `GET/PUT /api/v2/me/account-profile` 返回私有昵称、受控头像样式和脱敏邮箱。修改必须提交当前密码和 `expectedVersion`，成功后写账号安全事件；账号资料不会创建或认领 Person。
- `GET/PUT /api/v2/conversations/:conversationId/settings` 同时校验 Bearer 账号与会话归属，以乐观版本维护 `muted`；关闭会话固定锁定设置。
- 免打扰只抑制之后尚未投递的 `message.platform_reply` 站内通知，不删除消息、不改变消息接收主体，也不表示系统推送已实现。
- `APP_ACCOUNT_PROFILE_ENABLED`、`APP_INITIAL_PREFERENCES_ENABLED`、`APP_CONVERSATION_SETTINGS_ENABLED` 均默认关闭；bootstrap 与具体路由双重检查，底层 Auth、Recommendation/Taxonomy 或 Messaging 不可用时不能单独开启。
- Figma 已补齐 APP-AUTH-05、APP-SET-02、APP-MSG-03/04 的正常、失败、锁定、举报、屏蔽和关闭确认状态；KMP 必须按节点实现，设计缺口先补 Figma，禁止代码自行发明可见页面。

完整节点、状态机与跨仓边界见 `docs/app/ACCOUNT_SETTINGS_2_FIGMA_CROSS_REPO_INTEGRATION.md`。本阶段未运行 migration、构建、专项测试、模拟器/真机或远端联调。

### 独立 App 五级会员 `[开发验证，默认关闭]`

`0071_app_membership_catalog_and_grants.sql` 和 App API v2 `1.4.0` 建立 Membership-1 最小闭环：

- `app_membership_catalog_versions` 保存不可原地覆盖的目录版本及独立 `production_ready` 标记；开发 seed 只有 `amc_app_1_0_draft_1`，状态为 `development`。
- 心遇、心悦、心知、心契、心耀使用稳定 code/tier ID 和 `rank=10/20/30/40/50`。展示名称、颜色和文案不参与权限判断。
- entitlement 以稳定 key、schema 版本和值类型定义；当前支持 `boolean|integer|enum`。七项开发配置全部为 `planned`，只能展示，不能据此开放消息、筛选、历史或收藏夹业务。
- `GET /api/v2/membership/catalog` 提供公共五级目录；`GET /api/v2/me/entitlements` 使用 App Bearer 会话返回本人最高有效 App grant 和快照。`GET /api/v2/me` 复用同一摘要，不读取旧 Web `user_memberships`。
- Membership-7 在累计 App API `1.26.0` 为本人快照增加 `lifecycle`：服务端以统一时钟和可配置窗口返回 `active|expiring_soon|expired|revoked|free`。已结束 grant 只进入 `lifecycle.endedGrant`；顶层 `status/tier/grant` 与 entitlement 合并仍只接受当前有效、未撤销 grant，历史摘要不得用于授权。可选 `APP_MEMBERSHIP_EXPIRING_SOON_DAYS` 仅完成 Binding/解析，实际环境配置后置。
- 管理后台在现有用户详情页提供独立 App 会员面板，并以 `/admin/app/membership/grants/new` 提供 `ADM-MBR-04` 单账号变更工作台；支持账号搜索确认、预览、立即/预约发放、同级续期和撤销。`0088_app_membership_change_reviews.sql` 进一步交付 `ADM-MBR-05` 独立复核队列与逐单详情：发起人不得自审，批准时在 D1 条件批次内重验账号、当前 grant、业务单号和会员申请锁，并原子写入正式 grant/revocation、复核结果、事件和审计。没有已发布风险策略时服务端保守要求全部复核。
- `0089_app_membership_catalog_management.sql` 交付 `ADM-MBR-01/02` 管理平面：目录从稳定基线完整复制，使用乐观锁和管理员幂等命令维护五级与 typed entitlement；发布申请固化校验报告和内容哈希，只能由非创建人、非申请人的有效 Owner 决定。当前运行引用、已发布、待复核以及被 grant、申请或后继目录引用的版本不可原地修改。发布只生成不可变版本，不切换环境目录或迁移 grant。
- `APP_MEMBERSHIP_ENABLED` 与 `APP_MEMBERSHIP_ADMIN_ENABLED` 分离；production 还要求 `APP_MEMBERSHIP_PRODUCTION_READY=true` 且目录行同时为 `published + production_ready=1`。production/dev 当前都显式关闭。
- migration 不 seed 账号 grant、不回填 legacy 数据、不把 `vip/svip` 自动映射为五级会员。`0088` 同样不 seed 风险策略；正式阈值、migration 执行、配置和专项测试统一后置。`0098_app_membership_legacy_migrations.sql` 已实现旧会员显式映射、证据冻结、逐项独立复核、执行门禁与租约恢复，但默认关闭且尚未执行。
- `0104_app_membership_batch_grants.sql` 已实现 Membership-6 默认关闭的 CSV 批量编排：最多 200 行，每个有效行只创建普通 `app_membership_change_requests`，必须由另一管理员逐项复核；10 分钟租约和稳定逐行幂等键支持部分失败恢复，不会直接写 grant。OQ-018 未关闭且 Figma 没有正式批量页面，因此 D1 控制保持 `enabled=0`，不新增 Nuxt 页面或导航；`0104`、配置和验证后置。
- Message-1 的 `direct_message.new_threads_per_day` 上海自然日额度原子消耗已独立实现。

完整跨仓边界与验收要求见 `docs/app/MEMBERSHIP_1_CROSS_REPO_INTEGRATION.md`、`docs/app/MEMBERSHIP_3_CHANGE_REVIEW_INTEGRATION.md`、`docs/app/MEMBERSHIP_4_CATALOG_MANAGEMENT_INTEGRATION.md`、`docs/app/MEMBERSHIP_5_LEGACY_MIGRATION_INTEGRATION.md`、`docs/app/MEMBERSHIP_6_BATCH_GRANTS_INTEGRATION.md` 和 `docs/app/MEMBERSHIP_7_LIFECYCLE_PRESENTATION_INTEGRATION.md`。

### Membership-2 站内会员申请 `[开发验证，默认关闭]`

`0075_app_membership_applications.sql` 和 App API v2 `1.8.0` 在 Membership-1 上增加申请到人工发放的纵向闭环：

- 服务端只持久化 `submitted|processing|needs_information|approved|rejected|cancelled|expired`，未提交草稿只存在客户端进程。一个账号同时最多一条进行中申请。
- 申请保存提交时的不可变目录版本与 tier 快照。后台队列跨目录版本展示；新批准只能在申请目录仍是当前运行目录时开始，不能在切换目录后静默改发新等级。旧目录申请只能拒绝/过期/取消并要求重新提交；若 grant 已取得发放锁后才发生目录切换，同键恢复仍按原目录完成，避免 grant 与申请终态分叉。
- 联系方式固定引用账号已验证邮箱，不复制邮箱正文到申请表；列表只返回脱敏邮箱，管理员进入详情后才取得处理所需账号标识。申请说明最大 300 字，不进入分析或通用审计 JSON。
- 用户可提交、查看时间线、按管理员要求补充和取消尚未领取/发放锁定的申请。提交、补充和取消都要求稳定 `Idempotency-Key` 与 `expectedVersion`；重复请求返回原结果，旧版本安全冲突。
- 申请不会创建 grant、修改 rank 或下发 entitlement。管理员必须领取后处理；批准路径先取得不可并行的发放锁，再复用 Membership-1 grant 预览、幂等发放与审计。只有 grant 成功后才原子标记 `approved` 并关联 `grant_id`。
- Nuxt `/admin/app/membership/applications` 提供队列、筛选、最小账号信息、详情、领取、补充、拒绝、过期、取消和正式发放；用户可见状态与 App 时间线使用同一服务端事实。
- `APP_MEMBERSHIP_APPLICATIONS_ENABLED` 是用户申请独立开关，并继续依赖安全可用的 Auth、Membership 总开关、目录版本和 production-ready 门禁。production/dev 当前均显式为 `false`。
- OQ-010 未关闭，因此 bootstrap 只说明“人工处理、不承诺固定时效或必然通过”；OQ-020 未关闭，因此 migration 不创建自动清理任务，也不授权 production 保存真实申请。

完整跨仓边界与验收要求见 `docs/app/MEMBERSHIP_2_APPLICATION_INTEGRATION.md`。

### 独立 App 平台话题 `[开发验证，默认关闭]`

`0072_app_managed_conversations.sql` 和 App API v2 `1.5.0` 建立 Message-1 仅文本 HTTP 权威闭环：

- 新目录 `amc_app_1_0_message_1_dev_1` 复制 Membership-1 五级结构，只把 `direct_message.create`、`direct_message.send` 与 `direct_message.new_threads_per_day` 标记为 `available`；目录仍是 `development` 且 `production_ready=0`，现有环境配置仍指向旧目录。
- 一个观看者账号对一个合格人物资料最多一个 `platform_managed` 会话。创建/发送强制幂等；创建在同一个 D1 `batch()` 中写会话、不可省略的接收主体系统消息、额度消耗和幂等结果。
- 每次创建与发送都在服务端重新解析当前有效 App grant 和 entitlement；人物必须继续满足认证、发布、用途授权、可见性和来源图库发布门禁。会员到期或资料失效后保留历史只读，不信任客户端缓存。
- 新话题额度按 `Asia/Shanghai` 自然日计算，消耗事实追加写入；同一个人物复用已有会话不重复消耗额度。观看者发送限 20 条/分钟/会话，运营发送限 60 条/分钟/会话，生产仍需配置 Cloudflare 边缘限流。
- 接收主体固定为“平台运营接收”，消息发送方只允许 `viewer|platform_operator|system`。管理员不能提交 `person` 身份；后台回复另有文案门禁，禁止冒充真人或承诺回复、见面与关系结果。
- 消息正文只存在业务消息表和受控正文响应中，不进入通用日志、分析事件或审计 JSON。管理员正文读取要求 `service_operation` 原因并写访问审计；回复审计只保存消息 ID、正文 SHA-256 与长度。
- KMP 使用 bootstrap 的 `messaging` capability、接收主体、披露版本、HTTP 拉取方式和文本上限决定入口；Message-1 当时只有手动刷新。后续 Message-4 只增加无正文刷新提示，不改变 D1/HTTP 权威，也不增加系统推送、媒体消息或假在线/输入状态。
- `APP_MESSAGING_ENABLED` 与 `APP_MESSAGING_ADMIN_ENABLED` 独立，production 还要求 `APP_MESSAGING_PRODUCTION_READY=true`；三项当前均不放行，不得随 migration 自动开启。

完整跨仓边界与验收要求见 `docs/app/MESSAGE_1_CROSS_REPO_INTEGRATION.md`。

### Message-2 安全与运营闭环 `[开发验证，默认关闭]`

`0073_app_messaging_safety_operations.sql` 和 App API v2 `1.6.0` 在 Message-1 上增加安全与运营最小闭环：

- 观看者可举报人物资料、媒体、本人话题或本人可见消息，查看本人举报列表/时间线，并屏蔽或解除屏蔽人物；举报不要求会员，但要求有效 App 会话。
- 屏蔽在同一 D1 条件批次中写状态/事件、清理喜欢与关注、关闭关联话题并记录幂等结果；登录发现页在服务端排除当前仍为 `blocked` 的人物。解除屏蔽不恢复旧关系或旧话题。
- 观看者可以幂等关闭本人话题；关闭、受限或安全暂停后历史仍可读，但每次写请求重新检查当前状态、屏蔽、会员、人物资格和全局运行控制。
- 会话正文要求操作员先取得限时 assignment；领取、续租、释放、正文访问、回复和关闭均由服务端重验租约并写审计。容量上限和新建/双方发送暂停由 D1 全局控制。
- `0084_app_conversation_collaboration.sql` 在 assignment 上增加追加式内部备注和显式转派：内部备注正文只在受控业务表和有效租约响应中出现，审计仅保存 SHA-256、长度和引用；转派要求当前 `expectedAssignmentVersion`、有效目标管理员和剩余容量，并在同一 D1 批次中更新租约归属、写交接备注、转派事实、幂等结果与审计。成功后原操作员立即失权。
- `0085_app_conversation_safety_escalations.sql` 增加独立于用户举报的运营安全升级案件：当前话题租约持有人只能创建案件和固定整个话题或目标消息前后一条的最小证据；发起人与审核人强制隔离。审核员领取后按 `safety_escalation_review` 读取内部说明，可形成无需动作、话题只读或关闭结论；内部说明和结论不进入用户响应，实际话题动作只通过固定系统消息对用户说明。
- `0086_app_conversation_routing_and_shifts.sql` 增加运营组、成员职责/容量、上海时区跨日班次、真人/地区/默认规则和路由分配事实。自动分配在观看者新消息提交成功后异步尝试，按“真人 > 地区 > 默认、最低负载、最久未分配、稳定管理员 ID”确定候选；规则、班次、个人/组容量、服务日首次响应额度和 assignment 版本在条件写入时再次校验。失败只保留未分配状态，不回滚用户消息、不产生虚假回复。
- `0087_app_conversation_quality_reviews.sql` 增加平台回复的实际操作员事实、确定性抽样批次、无正文样本队列、固定最小证据、限时质检租约、三维结论、改进任务和独立幂等结果。运营回复和操作员事实必须在同一 D1 批次中收敛；抽检人与实际回复人强制隔离，领取前不得读取正文，完成后立即关闭正文授权。安全结论只原子创建独立安全升级案件，不直接执行处罚。
- 举报队列默认只读取未结案案件；审核员领取后才可按 `safety_review` 读取举报说明及“目标消息前一条 + 目标 + 后一条”的最小证据窗口。结论和关联安全动作使用 `expectedVersion + mutation_token`，旧请求不能留下部分处置。
- 保留策略初始为 `unresolved`，消息/举报/证据天数为 `NULL` 且 `purge_enabled=0`。OQ-020、运营值班、合规和真机回归未完成前，不得把 safety 目录或运行开关设为 production-ready。

完整跨仓边界与验收要求见 `docs/app/MESSAGE_2_CROSS_REPO_INTEGRATION.md`。

### Safety-2 独立申诉复核 `[dev 受控联调，production 默认关闭]`

`0074_app_safety_appeals.sql` 和 App API v2 `1.7.0` 在 Message-2 上增加举报结论独立复核闭环：

- 仅本人举报的 `no_violation` 结论可申请 `report_no_violation_review`；请求必须携带当前举报 `version`，同一举报结论版本最多一条申诉。
- 观看者只提交 1–500 字说明，不上传媒体或证据。申请窗口、策略状态和 production-ready 由服务端版本化策略决定，客户端不得本地推导。
- 原举报结论管理员不能领取对应申诉；管理员领取后才可按 `appeal_review` 目的读取申诉详情，领取、敏感读取和结论都写审计。
- `upheld` 维持原举报结论；`changed` 在同一 D1 条件批次中把原举报重开为 `investigating`、分配给复核管理员并更新申诉，不自动认定违规或执行安全动作。
- `APP_SAFETY_APPEALS_ENABLED`、`APP_SAFETY_APPEALS_ADMIN_ENABLED` 与 `APP_SAFETY_APPEALS_PRODUCTION_READY` 相互独立；production 三项继续关闭。dev 只开启用户端与管理员端开关以执行隔离测试数据的完整 HTTP 联调，`production-ready` 仍为 `false`。开发策略的 30 天窗口不是生产承诺，且策略引用未关闭的保留决策。

完整跨仓边界与验收要求见 `docs/app/SAFETY_2_APPEAL_INTEGRATION.md`。

### Account/Settings-3 跨领域申诉 `[开发完成，默认关闭]`

`0100_app_cross_domain_appeals.sql` 与 App API v2 `1.23.0` 把 `APP-SET-08` 扩展为举报结论、账号限制和金币分录共用的独立复核入口：

- 举报结论继续使用 `app_safety_appeals`；账号限制和金币分录使用 `app_service_appeals`，不合并原领域事实，也不通过申诉业务双写原对象。
- 账号限制新增单调版本与用户安全业务引用；金币分录使用不可变 `entryId + sequence`。同一账号、来源类型、来源 ID 与来源版本最多一个案件。
- 创建与补充均要求幂等键；补充还要求 `expectedVersion`。事件、补充、命令和幂等结果追加写，服务申诉身份与来源快照不可变，终态不可再次修改。
- 统一 `review_state=normal|evidence_insufficient|needs_escalation`；补充、请求补充和升级可跨两类申诉复用工作流，但升级与终态均禁止继续补充。
- 用户 API 只返回本人来源摘要、用户可见说明和时间线；管理员列表不返回正文，领取后才按最小必要目的读取，且复核人不能是原业务决定管理员。
- 两类用户申诉列表均按 `updatedAt DESC, appealId ASC` 使用账号绑定游标分页；KMP 对具体账号限制或金币分录入口在首屏未命中时继续跨页查找，不能把已有案件误判成新建状态。
- `upheld|changed|closed` 只形成申诉结论；账号限制、举报和金币的任何后续业务变化仍必须进入各自权威服务。
- KMP `APP-SET-08` 已绑定九个 Figma 正式节点，包含补充、升级和三个独立终态；通用入口按 `updatedAt` 选择最近案件，具体业务入口只匹配自身来源。

`0100`、环境开关、策略 SLA、构建、专项测试、`android-cli`/真机验证和远端联调按当前开发顺序统一后置。完整边界见 `docs/app/ACCOUNT_SETTINGS_3_CROSS_DOMAIN_APPEAL_INTEGRATION.md`。

### Message-3/9 站内通知与内容生命周期 `[开发完成，默认关闭；新增验证后置]`

`0076_app_in_app_notifications.sql` 和 App API v2 `1.9.0` 建立统一站内通知中心：

- 五类稳定 category 为消息、互动、会员与金币、系统与安全、活动；消息/互动/活动是可选偏好，会员与金币、系统与安全是不可关闭的必要通知。
- 业务表 D1 trigger 只在策略 `generation_enabled=1` 时原子写 Outbox；migration 初始策略关闭、无 seed、无历史回填。会员到期恢复还受策略 `effective_at` 下界约束。
- Outbox 使用账号、事件类型和事件引用防重，支持处理租约、最多 5 次指数退避、dead letter 和 SHA-256 稳定通知 ID；App 拉取前定向消费，Worker cron 每 15 分钟做全局有界恢复。
- 用户 API 提供分类游标列表、安全详情、服务端未读数、单条/分类已读和版本化偏好；游标绑定账号与分类，已读更新和设备审计在同一 D1 batch 中收敛。
- Message-6 修复账号唯一偏好在策略切换时无法换绑的问题：初始化后发现 `policy_id` 落后于当前已就绪策略，会保留三个可选值，以旧策略 + 当前版本条件原子换绑并令版本加一；旧基线和新策略生效均追加偏好事件。并发已由其他请求完成时复用结果，无法收敛时可重试失败，绝不恢复默认值。
- 通知只保存固定模板快照，不复制平台话题正文、申请说明、内部备注、安全证据、IP、精确位置或 Token。受控目标动作在响应时重新验证账号归属、对象状态和 capability。
- Nuxt `/admin/app/notifications` 展示双门禁、事件、模板和投递状态；`0097_app_notification_template_governance.sql` 已增加变量目录、允许列表和模板草稿/独立复核/发布工作流。投递列表不返回用户消息正文或敏感业务说明。
- `APP_NOTIFICATIONS_ENABLED`、`APP_NOTIFICATIONS_ADMIN_ENABLED`、`APP_NOTIFICATIONS_POLICY_VERSION` 与 production-ready 门禁相互独立，production/dev 当前均不开放。OQ-020 未关闭前保留天数为空且不执行清理。
- KMP 使用严格 bootstrap 配置和 HTTP pull，不接入 APNs、FCM 或系统通知权限；Message-4 WebSocket 只触发 HTTP 补拉，未知或矛盾 capability 安全关闭。
- Message-9 以 `0115_app_notification_content_lifecycle.sql` 增加到期/legacy 索引和保留边界不可变触发器。批准策略下的新投递按原始事件时间写 `expires_at`，已超过窗口的延迟事件只收敛 Outbox；每日清理只有显式策略 ID、approved 保留天数和 `purge_enabled=1` 同时有效时，才有界删除正文与其单条已读事件。能力/generation 关闭不取消既有删除义务，Outbox 去重墓碑和分类已读聚合保留。

完整跨仓边界与启用清单见 `docs/app/MESSAGE_3_NOTIFICATION_INTEGRATION.md` 与 `docs/app/MESSAGE_9_NOTIFICATION_CONTENT_LIFECYCLE_INTEGRATION.md`。

### Message-4 账号级实时刷新 `[Cloudflare 与 KMP 源码开发完成，默认关闭]`

`0105_app_realtime_refresh_channel.sql` 与 App API v2 `1.25.0` 在 Message-1/3 的 HTTP 权威链路上增加最小刷新提示：

- `app_realtime_policies` 冻结一次性票据、账号连接数、DO 事件重放/保留和重连区间；development seed 固定为 `unresolved + disabled + production_ready=0`。
- `POST /api/v2/realtime/tickets` 使用当前 Bearer session 签发绑定账号、session、设备的一次性短票据；D1 只保存 SHA-256。`GET /api/v2/realtime/connect` 使用独立 Realtime scheme 升级 WebSocket。
- 一个内部账号映射一个 Hibernation Durable Object。DO SQLite 只保存去重哈希、六类刷新范围、发生时间和单调游标；不保存或发送消息/通知正文、账号资料、管理员信息、内部备注或 Token。
- 话题/消息/已读、通知投递/已读、会员生效状态和钱包实际入账在 D1 成功后以 `waitUntil` 尽力发布。失败不得回滚业务事实，幂等重放不重复广播。
- 退出、远程设备撤销、Refresh Token 重放和 Privacy-2B 注销会取消未消费票据并关闭对应 session/device/account 连接；不可逆注销执行同时清理该账号全部实时票据元数据。所有 HTTP API 仍独立重验权限。
- KMP 严格校验 bootstrap 和三类服务端帧，前台连接、后台停连，使用有界指数退避与游标补偿；仅刷新当前可见 HTTP 页面，并复用 `APP-MSG-05` 已有“实时离线”状态。
- OQ-028 未关闭，本阶段不写 Wrangler Durable Object binding/环境值，不执行 `0105`，也不运行构建、测试或设备 QA。

完整契约、安全边界和后置门禁见 `docs/app/MESSAGE_4_REALTIME_REFRESH_INTEGRATION.md`。

### Message-5 数据权利结果通知 `[Cloudflare 源码开发完成，默认关闭]`

`0109_app_data_rights_notifications.sql` 复用 Message-3 已冻结的 `data.export_ready`、`account.deletion_updated` 和 `data_task + open_data_task` 形状，不增加 API 版本或页面状态：

- 私有导出只有在申请、制品、任务和用户可见 `export_ready` 事件原子收敛后写通知 Outbox；固定模板不包含 R2 key、URL、下载票据、摘要或导出内容。
- 注销创建后继续由 `0103` 抑制全部新通知。只有已验证取消把账号从 `deletion_pending` 恢复为原安全状态后，才为同一申请版本写一条取消结果通知；scheduled、processing、failed 和 completed 仍只允许申请级状态访问。
- 通知目标返回前重新读取数据权利 overview capability 并验证申请属于当前账号；目标不可用时只保留安全历史正文，不执行动作。
- KMP 已有 `OpenDataTask` 进入 `APP-SET-09/10` 权威页面，无需新增 Figma Frame。页面总量保持 99/408，Mobile 保持 50/208。
- migration 不回填历史事件、不启用通知 generation、不改变 OQ-020 保留/清理门禁；`0109`、模板审批、配置、构建、测试与设备 QA 统一后置。

完整边界见 `docs/app/MESSAGE_5_DATA_RIGHTS_NOTIFICATION_INTEGRATION.md`。

### Message-6 通知偏好策略换绑 `[Cloudflare 源码开发完成，默认关闭]`

Message-6 交付时不改变当时累计 App API `1.25.0`、数据库结构或 KMP 页面，只修复策略版本切换后的账号偏好连续性：

- `app_notification_preferences` 继续按账号唯一，不为每个策略创建并行可写记录。
- 当前策略与偏好行不一致时，保留消息、互动和营销选择，`version + 1` 后换绑新 `policy_id`。
- 若旧版本没有事件，先补旧策略基线；新策略生效再写一条无设备的内部事件。账号 + version 唯一约束防止并发重复。
- GET、PUT 和可选通知投递抑制共用该逻辑；production-ready 策略门禁仍先于任何换绑写入。
- 无 migration、公共 DTO、Page ID 或 Figma 状态增量；构建、测试和并发验证统一后置。

完整边界见 `docs/app/MESSAGE_6_NOTIFICATION_POLICY_REBIND_INTEGRATION.md`。

### Message-7 数据导出失败必要通知 `[Cloudflare 源码开发完成，默认关闭]`

`0110_app_data_export_failure_notifications.sql` 在 Message-5 的 ready 通知之外补齐 export failed 必要结果，交付时不改变当时累计 App API `1.25.0`：

- `failExportJob` 的 D1 batch 先依次收敛申请、制品与执行任务，再插入用户可见失败事件；事件 SQL 重验三者 version、mutation token 和 failure code，避免 trigger 在制品尚未失败时提前读取。
- `data.export_failed` 固定为 `system_security + required + data_task + open_data_task`，使用无变量安全模板，不返回内部错误或对象引用。
- Outbox trigger 只接受系统生成的用户可见 `processing_failed`，并重验 export 申请、失败版本、账号归属和失败制品；通知策略关闭或任一事实不一致时 fail closed。
- KMP 与 Nuxt 复用 `APP-SET-09` 失败态和 `ADM-NTF-01/02/03` 通用行，无 Page ID/Figma/公共 DTO 增量。
- `0110`、模板审批、配置、构建、测试、Queue 失败注入和设备 QA 统一后置。

完整边界见 `docs/app/MESSAGE_7_DATA_EXPORT_FAILURE_NOTIFICATION_INTEGRATION.md`。

### Message-8 文本消息审核 `[Cloudflare 源码开发完成，默认关闭]`

`0112_app_message_moderation.sql` 在 Message-1 既有四态消息 DTO 上补齐服务端文本审核与人工复核，交付时不改变当时累计 App API `1.25.0`：

- `APP_MESSAGE_MODERATION_POLICY_VERSION` 未配置时保持原 accepted 行为；显式策略只有在 `evaluation_enabled=1` 且生效后执行，production 还要求 published、approved 与 production-ready。migration seed 为 unresolved/disabled，不写规则、不回填消息。
- 评估事实只保存消息引用、策略/规则、结论、正文 SHA-256 与长度；正文不复制到案件、事件、审计或通知。案件列表无正文，领取后仅按 `message_moderation_review` 用途读取并审计。
- 待审/拒绝消息保留内部 sequence，但不推进会话业务活跃时间，也不计入普通接收方、正常运营工作台、未读、queue flip 或自动分配；人工通过时原子重排到当前末尾并按发送方形成新的队列方向，避免迟到消息落在接收方已读/分页水位之前。观看者与运营摘要、游标使用各自可见投影，质检只消费 accepted 上下文，数据导出不会泄露未交付运营正文。运营发送者不能领取或裁决自己的案件。
- `/api/admin/app/message-moderation/cases*` 提供无正文列表、10 分钟租约、受控详情和幂等通过/拒绝；当前没有正式后台审核 Figma，故不新增 Nuxt 页面或导航。
- Privacy-2B 关闭账号话题前把该账号未完成审核案件系统收敛为 `cancelled`，清租约和审核幂等记录并追加 `account_deletion` 事件；保留原消息证据且不产生新的结果通知，管理员 API 不提供主动取消或恢复入口。
- Message-3 增加观看者审核结果、待审运营回复最终通过和管理员会话限制/关闭通知；先限制后关闭使用独立 Outbox 身份。裁决幂等重放会重新尝试由稳定 dedupe key 保护的派单与实时刷新，通知仍受 generation 与运行时双门禁。召回继续保留为 OQ-033/Figma 后续能力。
- 页面事实保持 99/408、Mobile 50/208、Admin 49/200；`0112`、真实策略/规则、配置、构建、测试和设备 QA 统一后置。

完整边界见 `docs/app/MESSAGE_8_TEXT_MODERATION_INTEGRATION.md`。

### Wallet-1 金币账本与管理员单笔调币 `[开发验证，默认关闭]`

`0077_app_wallet_ledger.sql` 和 App API v2 `1.10.0` 建立最小追加式金币账本：

- 每个 App 账号最多一个钱包；未发生过分录的账号读取时返回虚拟零余额，不因 GET 创建钱包、分录或调币申请。
- 用户 API 只提供本人权威余额、按方向筛选的游标明细和分录详情。明细使用整数金币、服务端 sequence、前后余额、固定原因与安全业务引用，不返回管理员身份、内部备注或其他账号数据。
- 管理员过渡路由 `/api/admin/app/wallets` 支持账号确认、加币、扣币、补偿和完整冲正的预览、申请、列表、详情及批准/拒绝；不提供批量、余额直改、自动修账、余额导入或复核绕过。
- OQ-018 未关闭前全部申请强制另一管理员独立复核；发起人不能批准自己的申请。批准时重新校验账号、钱包状态、预览余额和 sequence，过期预览返回冲突，不沿用旧结果。
- 生效操作在同一 D1 条件批次中追加不可变分录、更新钱包快照、记录复核与审计；数据库 trigger 阻止没有对应分录的余额变化，并禁止修改或删除已生效分录。
- 扣币和冲正均禁止负余额；当前冲正只允许对一条未被冲正的原分录做一次完整反向分录，原记录永久保留。
- 钱包分录生效后可复用 Message-3 `wallet.entry_posted` 必要通知；通知文案只由方向、数量和固定原因生成，不复制用户说明或内部备注。通知失败不回滚权威账本。
- `APP_WALLET_ENABLED`、`APP_WALLET_ADMIN_ENABLED`、`APP_WALLET_POLICY_VERSION` 与 `APP_WALLET_PRODUCTION_READY` 是独立门禁，production/dev 当前均关闭；development 策略自身也保持 `adjustments_enabled=0`、未决风险/保留/数据位置状态。
- KMP 客户端只实现余额和明细查询，不存在充值、支付、消费、赠礼、装扮购买、转赠、兑换、转账、提现或用户申诉入口；未知 capability、方向、原因或余额关系一律安全拒绝。
- `deploy.sh` 发现 `0077` 待执行时对 production 无条件阻断；dev 必须提供由 `prepare-dev-wallet1.mjs` 生成且仍有效的仓库外 SQL/manifest，并显式设置一次性放行变量。migration 和 Worker 部署完成后自动运行 `verify-dev-wallet1-schema.mjs`，只读校验 commit、契约、关闭能力、17 张预期表、15 个 trigger、安全策略、空业务账本和零钱包通知 Outbox。
- 已生效分录及复核事件不能普通删除，因此共享 dev 不承担写入型功能 smoke；加扣币、复核、冲正和通知恢复使用一次性 D1 + 临时 Worker，测试结束销毁整套资源。共享 dev Time Travel restore 只属于独占维护窗口下的事故恢复，不是测试清理手段。
- `run-wallet1-disposable-smoke.mjs` 以机器 gate、`HEAD==origin/dev`、显式确认和批准的数据位置为前置，只生成单 D1 binding 的 workers.dev 配置。它从真实 migration 建空库，以三个合成会话执行 16 类 HTTP/D1 断言，并在成功或失败时固定按 Worker → D1 清理；凭证不落盘，成功清理后只保留聚合证据。当前 gate 为未授权状态，工具和测试完成不构成远程执行授权。
- 一次性 smoke 聚合证据固定保留 30 天并携带 `deleteAfter`；恢复销毁成功后收口运行 manifest，显式 evidence prune 只删除严格匹配且已到期的 JSON。局部决策包推荐 `location=apac`，但明确其只是位置提示，不构成 jurisdiction 或 production 数据位置结论。
- Wallet 管理查询统一以 `app_account_security.account_id` 连接 `users.id`；测试 fixture 已与 `0069_app_account_access.sql` 的真实列契约对齐，不再使用会掩盖空库联调错误的 `user_id` 简化列。

完整跨仓边界与启用清单见 `docs/app/WALLET_1_LEDGER_INTEGRATION.md`，共享 dev 迁移操作见 `docs/app/WALLET_1_DEV_VALIDATION_RUNBOOK.md`，隔离功能验收见 `docs/app/WALLET_1_DISPOSABLE_SMOKE_RUNBOOK.md`。

### Wallet-2 批量调币与钱包对账 `[开发完成，默认关闭]`

`0099_app_wallet_batches_and_reconciliation.sql` 在 Wallet-1 上增加两个管理员控制面，但不改变追加式账本和独立复核规则：

- `ADM-WAL-05` 固定七列 CSV 逐行预览；批次内重复业务单号按行隔离，总额超过控制上限时保留校验证据但硬阻断提交。有效行使用确定性逐行幂等键创建普通 `pending_review` 申请。
- 批量提交使用 10 分钟处理租约、执行令牌和 D1 状态 guard；中断后仅任务创建人可以接管过期租约，已经创建的调币申请不会重复。
- `ADM-WAL-06` 比较钱包快照、最新 posted 分录、sequence 和前后余额链。扫描只生成差异案件，不直接改余额；同一时刻只允许一个有效扫描，过期或异常任务收敛为失败并写审计。
- 只有单纯余额差异、sequence 一致且不超过单笔上限时可创建追加式 forward-fix；它仍进入 Wallet-1 的另一管理员复核。其他差异必须按 Runbook 人工处理。
- `app_wallet_batch_controls.enabled` 默认 `0`，开启必须保存决策引用、批准人和批准时间；当前不执行 migration、不配置、不处理真实数据。
- 页面严格对应 Figma：`ADM-WAL-05` 节点 `159:110550`、`159:110754`、`159:110958`、`159:111162`；`ADM-WAL-06` 节点 `159:111365`、`159:111569`、`159:111772`。

完整边界见 `docs/app/WALLET_2_BATCH_AND_RECONCILIATION_INTEGRATION.md`。

### Wallet-3 钱包快照重建与受控解冻 `[开发完成，默认关闭]`

`0107_app_wallet_snapshot_recovery.sql` 把 Operations-1 的保护性冻结接回 Wallet-2 正式处置流，不引入第二套账本：

- `app_wallet_recovery_commands` 和 `app_wallet_recovery_case_links` 只追加保存 Owner、幂等请求、案件集合摘要、执行前快照、分录重建末态、恢复结论与证据引用。
- `GET .../recovery-preview` 重读同钱包全部未终结案件和完整分录链；`POST .../recover` 要求相同 `caseSetDigest`、锚点版本及 16–128 位幂等键。
- 所有未终结案件必须由当前 Owner 认领；分录数量、末 sequence 或前后余额链仍不完整时 fail-closed。已解决 forward-fix 对应的显式链覆盖仍按 Wallet-2 规则识别。
- D1 trigger 只允许精确匹配的 executing 恢复命令执行 `frozen -> active` 和快照重建，并在命令进入 `applied` 前验证钱包末态、案件版本、证据哈希和无剩余未终结案件。
- 快照、覆盖案件关闭、不可变案件事件、钱包解冻和 `admin_audit_logs` 在同一 D1 batch；任一条件写失败全部回滚。成功后只发布 Message-4 `wallet` scope 刷新，不携带余额正文。
- `ADM-WAL-06` 复用既有正常、钱包冻结、差异未解释三个 Figma 状态，没有新增 Page ID 或状态；全局仍为 99 页/408 状态、Mobile 50 页/208 状态。

完整边界见 `docs/app/WALLET_3_SNAPSHOT_RECOVERY_INTEGRATION.md`。

### Wallet-4 旧余额显式迁移 `[开发完成，默认关闭]`

`0111_app_wallet_legacy_migrations.sql` 为仓库外旧余额快照建立显式证据链，不从当前不存在的 legacy 金币字段或会员事实猜测余额：

- Dry-run 冻结来源系统、来源记录、`opaque:` 不透明账号引用、提取时间、映射规则、目标稳定 App 账号、整数余额和 SHA-256；目标不存在、重复映射、非空账本或已迁移来源逐项冲突。
- 创建人提交后，每个有效条目必须由另一位 Owner 独立批准或拒绝；正式执行另受默认关闭的迁移控制、Wallet-1 写策略与 Operations-1 `wallet_adjustments` 控制约束。
- 执行复用 Wallet-1 普通 `pending_review` 申请与原子不可变分录，不建立第二套余额事实；确定性创建/复核幂等键和 10 分钟租约避免中断后重复入账。
- 冻结申请形成后若目标事实变化，执行器先以迁移专属幂等键拒绝申请，再把条目收敛为 `stale`；若分录已经形成则转入租约恢复。已完成执行请求即使门禁后来关闭也只读重放原结果。
- `legacy:<itemId>` 保留业务引用与 `app_wallet_legacy_migration_links` 不可变侧表共同区分迁移和日常调币。普通调币接口不能创建该引用，也不能复核迁移链接申请。
- 迁移队列与详情读取会写用途化 `admin_audit_logs`；来源账号引用只允许 `opaque:` 不透明标识，不接受邮箱或手机号正文。
- 当前无 Wallet 迁移正式 Page ID，因此只增加受保护管理员 API 与 D1 治理结构，不新增 Nuxt/KMP/Figma 状态；全局仍为 99 页/408 状态、Mobile 50 页/208 状态。

完整边界见 `docs/app/WALLET_4_LEGACY_BALANCE_MIGRATION_INTEGRATION.md`。

### 速率限制 `[当前实现 / 外部配置]`

当前实现分两层：

- 应用内兜底限流：API Worker 使用 isolate 内存滑动窗口计数器，覆盖登录/注册、公开 JSON API、管理员 API、媒体访问接口和外部导入接口。该层在多 isolate、跨边缘节点或 Worker 重启后不保证全局强一致，只作为代码级兜底和本地验证能力。
- 生产边缘强限流：生产环境必须在 Cloudflare WAF / Rate Limiting Rules 中配置对应规则。Cloudflare 规则需按表达式、计数特征、周期、请求数、缓解时长和动作创建；规则数量和可选周期受当前 WAF 计划影响。若当前计划无法完整表达下表所有规则，必须优先保护登录/注册和媒体访问接口，并在上线风险说明中记录差异。

| 操作 | 限制 |
|------|------|
| 登录/注册 | 5 次/分钟/IP |
| 公开 API | 60 次/分钟/IP |
| 管理员 API | 120 次/分钟/session |
| 媒体访问接口 | 30 次/分钟/user |
| 外部导入 API | 120 次/分钟/IP |

## 5. 权限模型 `[当前实现]`

### 用户角色 `[当前实现]`

| 角色 | 权限范围 |
|------|----------|
| `visitor` | 浏览公开内容，无需登录（逻辑角色） |
| `user` | 登录后查看免费内容、查看会员状态 |
| `admin` | 管理图库、标签、会员发放、批量导入；导入强制为草稿 |
| `owner` | admin 全部权限 + 系统设置 + 导入可直接发布 + 管理员账号管理 |

### Owner 与 Admin 权限差异 `[当前实现]`

| 操作 | Admin | Owner |
|------|-------|-------|
| 导入包设置 `status=published` | 忽略，强制草稿 | 允许直接发布 |
| 修改系统设置（站名、联系方式） | 不可 | 可 |
| 管理其他管理员账号 | 不可 | 可 |
| 查看审计日志 | 仅自己操作 | 全部 |

### 会员等级 `[当前实现]`

| 等级 | rank | 说明 |
|------|------|------|
| free | 0 | 注册用户默认等级 |
| vip | 10 | 可访问 vip 内容 |
| svip | 20 | 可访问全部内容 |

等级判断逻辑：`user_membership.rank >= gallery.required_level_rank`。

### 会员有效期 `[当前实现]`

- `user_memberships` 记录包含 `starts_at` 和 `expires_at`。
- 每次资源请求校验：`NOW() BETWEEN starts_at AND expires_at`。
- 过期后等同 free 权限，不删除历史记录。
- 同一用户可有多条会员记录（如续费），取最高有效 rank。

## 6. 媒体访问控制 `[当前实现 / 后续规划]`

### 缩略图按需生成 `[当前实现]`

```text
请求流程：
1. 前端请求 /api/media/:assetId/thumbnail?w=480
2. Worker 校验请求宽度，仅允许当前公开规格 `w=480`
3. `IMAGE_RESIZING_ENABLED=true` 时优先通过 Cloudflare Images Transformations 读取 R2 原图并转换
4. Transformations 未启用、失败或 Free unique transformations 超限时回退返回原图
5. 返回公共缓存响应，保持业务可用，后续按监控结果决定是否扩展规格
```

缩略图规格：
- 列表页：宽 480px，webp 格式
- 详情页：首期复用 480px 规格，避免多规格消耗 Free unique transformations
- 存储路径：原图仍存放在 R2，Transformations 不迁移到 Cloudflare Images 存储

### 受保护图片访问 `[当前实现]`

```text
1. 前端请求 /api/media/:assetId/access
2. Worker 校验 session → 获取用户会员 rank
3. 比较 rank >= media_asset.required_rank
4. 通过 → Worker 从私有 R2 读取对象并代理返回响应体，不暴露 R2 原始地址
5. 响应使用 Cache-Control: private, max-age=600，允许用户端私有短缓存
6. 拒绝 → 返回 403 和所需等级信息
```

### 受保护视频访问 `[部分实现 / 后续规划]`

```text
1. 前端请求 /api/media/:assetId/access?type=video
2. Worker 校验 session → 获取用户会员 rank
3. 比较 rank >= media_asset.required_rank
4. 通过 → 调用 Stream API 签发 signed token（有效期 4 小时）
5. 返回 Stream 播放 URL（含 signed token）
6. 拒绝 → 返回 403
```

当前 Cloudflare Stream 生产链路仍未接入。API 在生成 signed token 前会检查 `STREAM_ACCOUNT_ID` 和 `STREAM_API_TOKEN`，任一缺失时返回 503 和错误码 `STREAM_NOT_CONFIGURED`，不尝试调用 Stream API；前台视频入口默认由 `video_enabled=false` 隐藏。

### R2 对象 key 规范 `[当前实现 / 后续规划]`

| 用途 | key 格式 | 访问方式 |
|------|----------|----------|
| 图片原图 | `originals/{galleryId}/{assetId}.{ext}` | 私有，Worker 代理 |
| 缩略图 | `thumbnails/{assetId}/w{width}.webp` | 公开或短缓存 |
| 封面图 | `covers/{galleryId}/cover.{ext}` | 公开 CDN |
| 导入包 | `imports/{jobId}/packages/{uuid}.zip` | 私有；8 MiB multipart 完成后成为不可变任务快照 |
| 错误报告 | `imports/{jobId}/errors.csv` | 私有，管理员下载 |

## 7. API 路由 `[当前实现 / 部分实现]`

### 错误响应 `[当前实现]`

所有 JSON 错误响应统一使用以下结构：

```ts
{
  statusCode: number
  message: string
  code?: string
  detail?: unknown
}
```

API 代码统一通过 `packages/api/src/utils/api-error.ts` 的 `apiError` / `errorJson` 生成错误体。业务错误码放在 `code` 字段，例如 `AUTH_REQUIRED`、`RATE_LIMITED`、`IMPORT_TOKEN_MISSING`；前端只展示人类可读的 `message`，不得再依赖历史 `{ error }` 字段。

### 公开 API `[当前实现]`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/galleries` | 图库列表，支持标签筛选和分页 |
| GET | `/api/galleries/:slug` | 图库详情 |
| GET | `/api/tags` | 标签列表，按类型分组 |
| GET | `/api/search` | 组合搜索（标签 + 关键词） |
| GET | `/api/cases` | 真实案例列表 |
| GET | `/api/cases/:slug` | 真实案例详情 |
| GET | `/api/cases/images/:imageId` | 真实案例公开图片 |
| POST | `/api/auth/register` | 注册（需 Turnstile） |
| POST | `/api/auth/login` | 登录（需 Turnstile） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/me` | 当前用户信息和会员状态 |
| GET | `/api/media/:assetId/access` | 媒体访问接口（需登录；图片代理响应，视频返回 Stream token） |
| GET | `/api/media/:assetId/thumbnail` | 缩略图（公开） |
| POST | `/api/analytics/events` | 站内一方数据分析批量采集，默认受 `analytics_enabled` 关闭态保护 |
| POST | `/api/analytics/session/end` | session 结束兜底采集，兼容 `sendBeacon` 简写 payload |
| POST | `/api/conversions/events` | 公开转化事件入口，仅接受有效联系；受限流保护，服务端清洗 metadata，明确拒绝完成注册、`Lead`、`StartTrial`、会员发放或敏感字段 |
| GET | `/api/invites/:code/status` | 公开校验邀请码状态，只返回可展示字段和失败原因，不泄露 `code_hash` |
| GET | `/api/settings/public` | 公开站点设置和过滤后的首页广告数组 `home_ads` |
| GET | `/api/v2/app/bootstrap` | App 1.0 能力开关与发现配置；M0 只读契约 |
| GET | `/api/v2/taxonomy/catalog` | 默认关闭：当前不可变公开分类目录，支持 ETag 条件读取 |
| GET | `/api/v2/discovery/feed` | 只读公开人物投影；推荐/热门/最新、地区筛选和不透明游标 |
| GET | `/api/v2/discovery/regions` | 只统计当前仍具公开资格的人物地区 |
| GET | `/api/v2/person-profiles/:profileId` | 按稳定公开资料 ID 重新校验并返回基础详情 |
| POST | `/api/v2/person-profiles/search` | 默认关闭：正文传输搜索词与可选稳定 taxonomy 条件，使用账号/搜索词/条件绑定游标 |
| POST | `/api/v2/person-profiles/search/preview` | 默认关闭：解析目录变化和筛选权限，仅在可执行时返回当前结果数 |
| POST | `/api/v2/auth/email-challenges` | 默认关闭：申请注册邮箱验证码，统一响应不披露账号存在性 |
| POST | `/api/v2/auth/register` | 默认关闭：创建观看者账号、当前同意、设备和 App 会话 |
| POST | `/api/v2/auth/login` | 默认关闭：邮箱密码登录与当前同意校验 |
| POST | `/api/v2/auth/refresh` | 默认关闭：旋转 Access/Refresh Token，旧 Refresh 重放撤销会话 |
| POST | `/api/v2/auth/logout` | 默认关闭：撤销当前 App 会话 |
| GET | `/api/v2/me` | 默认关闭：当前账号和会员摘要 |
| GET | `/api/v2/me/devices` | 默认关闭：本人设备列表 |
| DELETE | `/api/v2/me/devices/:deviceId` | 默认关闭：幂等远程退出其他设备 |
| GET/PUT/DELETE | `/api/v2/person-profiles/:profileId/favorite` | 默认关闭：本人收藏状态、加入默认收藏夹、取消全部收藏 |
| GET | `/api/v2/me/favorites` | 默认关闭：本人收藏去重聚合列表；支持 `query/region/styleTerm` |
| GET | `/api/v2/me/favorite-folders` | 默认关闭：本人收藏夹、去重总数、四图预览和当前额度 |
| PUT/PATCH/DELETE | `/api/v2/me/favorite-folders/:folderId` | 默认关闭：幂等创建、条件编辑或删除自定义收藏夹 |
| GET | `/api/v2/me/favorite-folders/:folderId/items` | 默认关闭：本人指定收藏夹条目分页与账号私有单选筛选 |
| PUT/DELETE | `/api/v2/me/favorite-folders/:folderId/items/:profileId` | 默认关闭：幂等加入或移出指定收藏夹 |
| GET/PUT | `/api/v2/me/view-history/settings` | 默认关闭：本人历史记录开关、版本和当前保留权益 |
| POST | `/api/v2/person-profiles/:profileId/view-history` | 默认关闭：详情成功呈现后的版本化有效浏览记录 |
| GET | `/api/v2/me/view-history` | 默认关闭：本人未到期浏览历史分页 |
| POST | `/api/v2/me/view-history/clear` | 默认关闭：原子清空历史并使旧版本写请求失效 |
| DELETE | `/api/v2/me/view-history/:profileId` | 默认关闭：幂等删除本人单条浏览历史 |
| GET/PUT | `/api/v2/me/search-history/settings` | 默认关闭：本人搜索历史独立开关与乐观版本 |
| GET/POST | `/api/v2/me/search-history` | 默认关闭：本人未到期搜索历史分页/显式幂等记录 |
| POST | `/api/v2/me/search-history/clear` | 默认关闭：原子清空搜索历史并使旧版本写请求失效 |
| DELETE | `/api/v2/me/search-history/:historyId` | 默认关闭：幂等删除本人单条搜索历史 |
| GET | `/api/v2/me/search-filter-capabilities` | 默认关闭：本人高级筛选档位、保存额度和 taxonomy 类型分层 |
| GET/POST | `/api/v2/me/saved-filters` | 默认关闭：本人保存条件列表/原子额度校验的幂等创建 |
| GET/PATCH/DELETE | `/api/v2/me/saved-filters/:filterId` | 默认关闭：本人保存条件详情、乐观并发修改和隐私清理式删除 |
| GET | `/api/v2/membership/catalog` | 默认关闭：Membership-1 五级开发目录与 typed entitlement |
| GET | `/api/v2/me/entitlements` | 默认关闭：当前 App 账号的权威会员权益快照 |
| GET | `/api/v2/me/membership-applications` | 默认关闭：本人最近会员申请与用户可见时间线 |
| GET | `/api/v2/membership-applications/:applicationId` | 默认关闭：按本人归属读取单条会员申请 |
| POST | `/api/v2/membership-applications` | 默认关闭：幂等提交申请，不产生 grant 或 entitlement |
| POST | `/api/v2/membership-applications/:applicationId/resubmit` | 默认关闭：待补充申请重新确认说明并入队 |
| POST | `/api/v2/membership-applications/:applicationId/cancel` | 默认关闭：取消尚未进入处理/发放锁定的申请 |
| POST | `/api/v2/conversations` | 默认关闭：幂等创建或复用 Message-1 平台话题并原子消耗日额度 |
| GET | `/api/v2/conversations` | 默认关闭：当前 App 账号的话题列表 |
| GET | `/api/v2/conversations/:conversationId` | 默认关闭：对象归属内的话题详情和当前可发送状态 |
| GET | `/api/v2/conversations/:conversationId/messages` | 默认关闭：按 sequence 正序补拉文本与系统消息 |
| POST | `/api/v2/conversations/:conversationId/messages` | 默认关闭：幂等发送观看者文本消息 |
| POST | `/api/v2/conversations/:conversationId/read` | 默认关闭：单调推进观看者已读 sequence |
| POST | `/api/v2/conversations/:conversationId/close` | 默认关闭：观看者幂等关闭本人话题并保留历史只读 |
| GET | `/api/v2/person-profiles/:profileId/safety` | 默认关闭：读取本人对人物的权威屏蔽状态 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/block` | 默认关闭：屏蔽/解除屏蔽并执行服务端联动 |
| GET | `/api/v2/me/blocks` | 默认关闭：本人当前屏蔽人物游标分页 |
| POST | `/api/v2/reports` | production 默认关闭、dev 联调：幂等举报人物、媒体、本人话题或本人消息 |
| GET | `/api/v2/me/reports` | production 默认关闭、dev 联调：本人举报游标分页与用户可见状态 |
| GET | `/api/v2/me/reports/:reportId` | production 默认关闭、dev 联调：本人举报必要详情、当前结论版本申诉资格和用户可见时间线 |
| POST | `/api/v2/appeals` | production 默认关闭、dev 联调：对本人未发现违规结论幂等申请一次独立复核 |
| GET | `/api/v2/me/appeals` | production 默认关闭、dev 联调：本人申诉游标分页与用户可见状态 |
| GET | `/api/v2/me/appeals/:appealId` | production 默认关闭、dev 联调：本人申诉说明、结论与用户可见时间线 |
| POST | `/api/v2/me/appeals/:appealId/supplements` | 默认关闭：对本人举报结论申诉幂等追加必要说明，要求 expectedVersion |
| POST | `/api/v2/service-appeals` | 默认关闭：对当前账号限制或本人金币分录幂等创建跨领域申诉 |
| GET | `/api/v2/me/service-appeals` | 默认关闭：本人账号限制/金币分录申诉游标分页 |
| GET | `/api/v2/me/service-appeals/:appealId` | 默认关闭：本人业务申诉详情、补充与用户可见时间线 |
| POST | `/api/v2/me/service-appeals/:appealId/supplements` | 默认关闭：对本人业务申诉幂等追加必要说明，要求 expectedVersion |

App 公开人物查询统一要求：认证有效、发布有效、用途授权已开始且未到期、认证未到期、投影可见、来源图库仍为 `published`。任一条件失败时不得回退读取人物草稿或图库表。

### 外部导入 API `[当前实现]`

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/imports/telegram-file-id` | 接收外部 Bot 提交的 Telegram `file_id` JSON，创建导入记录并异步生成草稿 | Import Token |
| GET | `/api/imports/:importId` | 查询同一 Import Token 创建的导入状态 | Import Token |
| POST | `/api/imports/:importId/retry` | Bot 侧重试 failed 导入 | Import Token |
| POST | `/api/imports/:importId/recover-stale` | 仅在 30 分钟处理租约已过期时清理原尝试并重新排队 | Import Token |

### 管理员 API `[当前实现 / 部分实现]`

| 方法 | 路径 | 说明 | 角色 |
|------|------|------|------|
| GET | `/api/admin/dashboard` | 数据概览 | admin+ |
| GET | `/api/admin/galleries` | 图库列表（含草稿） | admin+ |
| POST | `/api/admin/galleries` | 创建图库 | admin+ |
| PATCH | `/api/admin/galleries/:id` | 编辑图库 | admin+ |
| POST | `/api/admin/galleries/:id/publish` | 发布图库 | admin+ |
| POST | `/api/admin/galleries/:id/unpublish` | 下架图库 | admin+ |
| GET | `/api/admin/app/persons` | App 人物候选列表，返回授权/认证/发布三轴状态和线上版本 | admin+ |
| POST | `/api/admin/app/persons` | 从明确来源图库创建不可见人物候选 | admin+ |
| GET | `/api/admin/app/persons/:personId` | 人物供给工作台、发布门禁和审批历史 | admin+ |
| PATCH | `/api/admin/app/persons/:personId` | 以 `expectedVersion` 创建新内容草稿版本，不覆盖线上投影 | admin+ |
| PUT | `/api/admin/app/persons/:personId/taxonomy` | 以稳定目录/词条 ID 创建新结构化分类版本，不覆盖线上投影 | admin+ |
| POST | `/api/admin/app/persons/:personId/authorization` | 为当前内容版本登记 App 公开用途授权 | admin+ |
| POST | `/api/admin/app/persons/:personId/authorization/revoke` | 撤销授权并立即暂停引用它的公开投影 | admin+ |
| POST | `/api/admin/app/persons/:personId/verification/submit` | 提交当前内容版本认证复核 | admin+ |
| POST | `/api/admin/app/persons/:personId/verification/decision` | 记录四项认证通过或退回结论 | admin+ |
| POST | `/api/admin/app/persons/:personId/verification/revoke` | 撤销认证并立即暂停引用它的公开投影 | admin+ |
| POST | `/api/admin/app/persons/:personId/publication/submit` | 全门禁预检后提交发布复核 | admin+ |
| POST | `/api/admin/app/persons/:personId/publication/decision` | 发布时再次校验门禁并单向写公开投影，或退回草稿 | admin+ |
| POST | `/api/admin/app/persons/:personId/publication/pause` | 立即暂停公开投影，保留版本和审批历史 | admin+ |
| GET/POST | `/api/admin/app/taxonomy/terms` | 分类词条分页与草稿创建；独立后台能力默认关闭 | admin+ |
| GET/PATCH | `/api/admin/app/taxonomy/terms/:termId` | 词条详情、修订/目录引用与乐观版本编辑 | admin+ |
| POST | `/api/admin/app/taxonomy/terms/:termId/submit` | 提交分类词条复核 | admin+ |
| POST | `/api/admin/app/taxonomy/terms/:termId/decision` | 分类审核通过或退回；敏感升级审批未完成时拒绝 restricted | admin+ |
| POST | `/api/admin/app/taxonomy/terms/:termId/lifecycle` | hide/deprecate/archive/restore 生命周期操作 | admin+ |
| POST | `/api/admin/app/taxonomy/terms/:termId/merge` | 同类型词条合并并保留稳定重定向 | admin+ |
| GET/POST | `/api/admin/app/taxonomy/catalogs` | 目录历史与不可变快照生成 | admin+ |
| GET/POST | `/api/admin/app/taxonomy/catalogs/:catalogId[/publish]` | 查看或发布目录快照 | admin+ |
| GET/PUT | `/api/admin/app/taxonomy/legacy-mappings` | 旧标签显式映射查询与维护 | admin+ |
| GET | `/api/admin/cases` | 真实案例列表（含草稿） | admin+ |
| POST | `/api/admin/cases` | 创建真实案例草稿 | admin+ |
| GET | `/api/admin/cases/:id` | 真实案例详情 | admin+ |
| PATCH | `/api/admin/cases/:id` | 编辑真实案例 | admin+ |
| POST | `/api/admin/cases/:id/images` | 上传真实案例图片 | admin+ |
| DELETE | `/api/admin/cases/:id/images/:imageId` | 删除真实案例图片 | admin+ |
| POST | `/api/admin/cases/:id/publish` | 发布真实案例 | admin+ |
| GET | `/api/admin/tags` | 标签管理列表 | admin+ |
| POST | `/api/admin/tags` | 创建标签 | admin+ |
| PATCH | `/api/admin/tags/:id` | 编辑标签 | admin+ |
| GET | `/api/admin/users` | 用户列表和搜索 | admin+ |
| POST | `/api/admin/users/:id/memberships` | 发放会员等级 | admin+ |
| GET | `/api/admin/app/memberships/catalogs` | 读取全部目录版本、运行引用、事实依赖和最近发布复核摘要 | admin+ |
| POST | `/api/admin/app/memberships/catalogs` | 从基线完整复制会员目录草稿，要求幂等键 | admin+ |
| GET | `/api/admin/app/memberships/catalogs/:catalogId` | 读取五级、Entitlement、内容哈希与校验报告 | admin+ |
| PATCH | `/api/admin/app/memberships/catalogs/:catalogId` | 乐观锁修改未引用草稿设置 | admin+ |
| PUT | `/api/admin/app/memberships/catalogs/:catalogId/tiers` | 原子替换完整五级展示与 rank | admin+ |
| GET | `/api/admin/app/memberships/catalogs/:catalogId/compare` | 比较目录基线、Schema 与等级值差异 | admin+ |
| PUT | `/api/admin/app/memberships/catalogs/:catalogId/entitlements/:entitlementKey` | 原子保存 typed 定义与全部五级显式值 | admin+ |
| GET | `/api/admin/app/memberships/catalogs/:catalogId/entitlements/:entitlementKey/impact` | 查询 capability、服务依赖、grant 与基线影响 | admin+ |
| POST | `/api/admin/app/memberships/catalogs/:catalogId/publish-requests` | 固化 lock/哈希并提交目录发布独立复核 | admin+ |
| GET | `/api/admin/app/memberships/catalog-publish-reviews[/:requestId]` | 读取目录发布复核队列或单个详情 | admin+ |
| POST | `/api/admin/app/memberships/catalog-publish-reviews/:requestId/decision` | 有效 Owner 独立批准或拒绝目录发布 | owner |
| GET | `/api/admin/app/memberships/catalog` | 读取 Membership-1 当前配置目录 | admin+ |
| GET | `/api/admin/app/memberships/users/:userId` | 读取指定账号 App 会员状态与 grant 时间线 | admin+ |
| POST | `/api/admin/app/memberships/grants/preview` | 预览立即发放或续期，不产生写入 | admin+ |
| POST | `/api/admin/app/memberships/change-requests` | 幂等创建单账号发放/续期独立复核申请 | admin+ |
| POST | `/api/admin/app/memberships/grants/:grantId/revoke-preview` | 预览撤销目标、当前会员和复核策略 | admin+ |
| POST | `/api/admin/app/memberships/grants/:grantId/revoke-request` | 幂等创建单账号撤销独立复核申请 | admin+ |
| GET | `/api/admin/app/memberships/reviews` | 会员变更复核队列，不返回内部备注 | admin+ |
| GET | `/api/admin/app/memberships/reviews/:requestId` | 受控读取复核详情并写访问审计 | admin+ |
| POST | `/api/admin/app/memberships/reviews/:requestId/decision` | 独立复核批准/拒绝并原子执行 | admin+ |
| POST | `/api/admin/app/memberships/grants` | 策略允许时幂等直达创建单账号 App grant | admin+ |
| POST | `/api/admin/app/memberships/grants/:grantId/revoke` | 策略允许时追加式直达撤销 App grant | admin+ |
| GET | `/api/admin/app/memberships/applications` | 会员申请队列，支持状态、等级、时间和处理人筛选 | admin+ |
| GET | `/api/admin/app/memberships/applications/:applicationId` | 申请详情、当前会员和用户可见时间线 | admin+ |
| POST | `/api/admin/app/memberships/applications/:applicationId/claim` | 以乐观版本领取申请 | admin+ |
| POST | `/api/admin/app/memberships/applications/:applicationId/request-information` | 要求用户补充并写审计 | admin+ |
| POST | `/api/admin/app/memberships/applications/:applicationId/reject\|expire\|cancel` | 以标准原因形成终态并写审计 | admin+ |
| POST | `/api/admin/app/memberships/applications/:applicationId/approve` | 锁定申请并提交独立发放复核；复核原子执行成功后才显示已发放 | admin+ |
| GET | `/api/admin/app/conversations` | Message-1 平台话题队列，不返回正文 | admin+ |
| GET | `/api/admin/app/conversations/:conversationId` | 读取话题元数据；正文访问目的固定为 `service_operation` 并审计 | admin+ |
| GET | `/api/admin/app/conversations/:conversationId/messages` | 受控读取话题正文并写访问审计 | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/read` | 单调推进运营已读 sequence 并审计 | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/messages` | 以固定 `platform_operator` 身份幂等回复并记录无正文审计摘要 | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/claim` | 领取或续租限时话题 assignment | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/release` | 释放本人持有的话题 assignment | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/close` | 在有效 assignment 内关闭话题并审计 | admin+ |
| GET | `/api/admin/app/conversations/operators` | 可接收转派的有效管理员及聚合容量，不返回邮箱 | admin+ |
| GET | `/api/admin/app/conversations/:conversationId/internal-notes` | 有效 assignment 内读取内部备注并记录访问审计 | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/internal-notes` | 幂等追加内部备注，通用审计不复制正文 | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/transfer` | 使用 assignment 版本、稳定原因和交接说明原子转派 | admin+ |
| POST | `/api/admin/app/conversations/:conversationId/safety-escalations` | 当前租约内创建独立内部安全升级并固定最小证据 | admin+ |
| GET | `/api/admin/app/message-moderation/cases` | Message-8 无正文待审队列与租约状态 | admin+ |
| POST | `/api/admin/app/message-moderation/cases/:caseId/claim` | 按版本幂等领取文本审核案件；运营作者不可自领 | admin+ |
| GET | `/api/admin/app/message-moderation/cases/:caseId` | 当前领取人按 `message_moderation_review` 读取原消息并审计 | current reviewer |
| POST | `/api/admin/app/message-moderation/cases/:caseId/decision` | 独立通过/拒绝并原子更新消息、案件、队列、通知事实和审计 | current reviewer |
| GET | `/api/admin/app/conversation-groups` | 运营组、成员、班次、规则、容量和队列诊断快照 | admin+ |
| POST/PATCH | `/api/admin/app/conversation-groups`、`/:groupId` | 创建或乐观版本更新运营组 | owner / group lead |
| PUT | `/api/admin/app/conversation-groups/:groupId/members/:adminId` | 乐观版本新增或更新组成员职责与容量 | owner / group lead |
| POST/PATCH | `/api/admin/app/conversation-groups/:groupId/shifts`、`.../:shiftId` | 创建或乐观版本更新上海时区班次 | owner / group lead |
| PUT | `/api/admin/app/conversation-groups/policy` | 创建或乐观版本更新全局人工/自动分配策略 | owner |
| POST/PATCH | `/api/admin/app/conversation-groups/rules`、`/rules/:ruleId` | 创建或乐观版本更新真人、地区或默认规则 | owner |
| POST | `/api/admin/app/conversation-groups/dispatch` | 按策略上限补偿分配当前未领取队列并返回无正文结果 | owner |
| GET | `/api/admin/app/conversation-quality` | 无正文抽检队列、抽样批次、改进任务与范围诊断 | owner / group lead / quality |
| POST | `/api/admin/app/conversation-quality/selection-runs` | 按实际操作员轮转和最早未抽样回复创建确定性批次 | owner / scoped group lead / quality |
| POST | `/api/admin/app/conversation-quality/samples/:sampleId/claim` | 领取 60 分钟质检租约；实际回复人不得领取 | owner / scoped group lead / quality |
| GET | `/api/admin/app/conversation-quality/samples/:sampleId` | 仅当前质检租约内按 `quality_review` 读取固定最小正文证据 | current reviewer |
| POST | `/api/admin/app/conversation-quality/samples/:sampleId/decision` | 原子记录评分，并按结论创建改进任务或独立安全案件 | current reviewer |
| POST | `/api/admin/app/conversation-quality/samples/:sampleId/void` | 对范围错误或服务端确认的证据异常作废并留痕 | owner / scoped reviewer |
| PATCH | `/api/admin/app/conversation-quality/tasks/:taskId` | 乐观版本推进改进任务并写不可变事件 | assignee / owner / scoped group lead / quality |
| GET | `/api/admin/app/safety/reports` | 不含说明/正文的待处理举报队列及筛选 | admin+ |
| POST | `/api/admin/app/safety/reports/:reportId/claim` | 幂等领取举报案件 | admin+ |
| GET | `/api/admin/app/safety/reports/:reportId` | 领取后按 `safety_review` 读取最小证据并审计 | admin+ |
| POST | `/api/admin/app/safety/reports/:reportId/decision` | 使用 expectedVersion 记录结论及受控安全动作 | admin+ |
| GET | `/api/admin/app/safety/escalations` | 不含内部说明/正文的运营安全升级队列 | admin+ |
| POST | `/api/admin/app/safety/escalations/:escalationId/claim` | 独立审核员幂等领取，发起人不可领取 | admin+ |
| GET | `/api/admin/app/safety/escalations/:escalationId` | 领取后按 `safety_escalation_review` 读取最小证据并审计 | admin+ |
| POST | `/api/admin/app/safety/escalations/:escalationId/decision` | 使用 expectedVersion 记录无需动作或原子话题安全动作 | admin+ |
| GET | `/api/admin/app/safety/appeals` | 不含申诉正文的统一复核队列；按举报、账号限制、金币分录及工作流状态筛选 | admin+ |
| GET | `/api/admin/app/safety/appeals/:appealId/summary` | 不读取正文的队列行权威摘要 | admin+ |
| POST | `/api/admin/app/safety/appeals/:appealId/claim` | 幂等领取并强制原业务决定人与复核人隔离 | admin+ |
| GET | `/api/admin/app/safety/appeals/:appealId` | 领取后按 `appeal_review` 读取申诉说明与来源最小证据并审计 | admin+ |
| POST | `/api/admin/app/safety/appeals/:appealId/request-supplement` | 使用 expectedVersion 幂等请求用户补充必要说明 | admin+ |
| POST | `/api/admin/app/safety/appeals/:appealId/escalate` | 使用 expectedVersion 幂等升级至高级复核 | admin+ |
| POST | `/api/admin/app/safety/appeals/:appealId/decision` | 使用 expectedVersion 形成维持、成立或关闭结论；原业务变化另走权威工作流 | admin+ |
| GET | `/api/admin/app/safety/runtime-control` | 读取全局话题暂停、容量、租约和保留门禁 | admin+ |
| PATCH | `/api/admin/app/safety/runtime-control` | 幂等更新全局运行控制，要求版本/原因/审计 | owner |
| GET | `/api/admin/app/audit/events` | 选择用途后按 31 天受限范围、精确引用和稳定 sequence 游标查询；admin 仅本人、owner 跨域 | admin+ |
| GET | `/api/admin/app/audit/events/:eventId` | 重新校验对象范围并返回字段级脱敏差异与非敏感关联时间线；读取自身写审计 | admin+ |
| GET | `/api/admin/app/audit/integrity/overview` | 读取事实/索引、Action 登记和最近检查生产阻断摘要 | owner |
| GET | `/api/admin/app/audit/integrity/checks[/:checkId]` | 读取不可变完整性检查历史和最多前 50 条 finding | owner |
| POST | `/api/admin/app/audit/integrity/checks` | 幂等追加最多 5,000 sequence 的完整性清单，不修改原事件 | owner |
| GET/POST | `/api/admin/app/audit/exports[...]` | 受控导出申请、强认证、独立复核、一次性票据与 Worker 代理下载 | admin+ / 独立 owner 复核 |
| GET | `/api/admin/app/audit/registry/overview`、`/actions` | 发现真实 Action、治理状态、观察冲突和生产阻断 | owner |
| POST | `/api/admin/app/audit/registry/preview` | 只读规范化候选并核对历史影响与治理策略引用 | owner |
| GET/POST | `/api/admin/app/audit/registry/requests[...]` | 幂等提交发布/退休申请、读取详情并由不同 Owner 独立复核 | owner |
| POST | `/api/admin/import-jobs` | 创建导入任务（需 Turnstile） | admin+ |
| GET | `/api/admin/import-jobs/:id` | 导入任务详情和进度 | admin+ |
| POST | `/api/admin/import-jobs/:id/package/init` | 初始化私有 R2 multipart 上传会话 | admin（仅本人）/ owner（全部） |
| PUT | `/api/admin/import-jobs/:id/package/parts/:partNumber` | 流式上传固定计划中的单个 ZIP 分片 | admin（仅本人）/ owner（全部） |
| POST | `/api/admin/import-jobs/:id/package/complete` | 使用服务端持久化 ETag 合并并锁定原包 | admin（仅本人）/ owner（全部） |
| POST | `/api/admin/import-jobs/:id/process` | 处理导入任务（需 Turnstile） | admin+ |
| POST | `/api/admin/import-jobs/:id/retry` | 仅重试标记为 retryable 的失败项（需 Turnstile） | admin（仅本人）/ owner（全部） |
| POST | `/api/admin/import-jobs/:id/resume` | 恢复安全暂停任务（需 Turnstile） | admin（仅本人）/ owner（全部） |
| GET | `/api/admin/import-jobs/:id/errors` | Worker 代理下载当前任务错误 CSV | admin（仅本人）/ owner（全部） |
| GET | `/api/admin/audit-logs` | 审计日志 | admin（仅自己）/ owner（全部） |
| GET | `/api/admin/import-api-tokens` | Import Token 列表，不返回 hash 或明文 token | owner |
| POST | `/api/admin/import-api-tokens` | 创建 Import Token，明文 token 仅返回一次 | owner |
| PATCH | `/api/admin/import-api-tokens/:id` | 修改 Import Token 权限、来源白名单、状态或过期时间 | owner |
| DELETE | `/api/admin/import-api-tokens/:id` | 禁用 Import Token | owner |
| GET | `/api/admin/external-import-records` | 外部导入记录列表，支持状态、类型和 sourceBotKey 筛选 | admin+ |
| GET | `/api/admin/external-import-records/:id` | 外部导入详情、文件状态、错误摘要和目标草稿链接 | admin+ |
| POST | `/api/admin/external-import-records/:id/retry` | 后台重试 failed 外部导入，复用原 token 权限和 sourceBotKey 校验 | admin+ |
| POST | `/api/admin/external-import-records/:id/recover-stale` | 后台恢复处理租约过期的外部导入并写审计 | admin+ |
| GET | `/api/admin/settings` | 站点设置 | owner |
| PATCH | `/api/admin/settings` | 修改站点设置 | owner |
| GET | `/api/admin/ads` | 首页广告位列表 | owner |
| POST | `/api/admin/ads` | 创建首页广告位 | owner |
| PUT | `/api/admin/ads/:id` | 更新首页广告位 | owner |
| DELETE | `/api/admin/ads/:id` | 删除首页广告位 | owner |
| PATCH | `/api/admin/ads/reorder` | 调整首页广告位顺序 | owner |
| POST | `/api/admin/ads/:id/image` | 上传首页广告大图 | owner |
| DELETE | `/api/admin/ads/:id/image` | 删除首页广告大图 | owner |
| GET | `/api/admin/invite-codes` | 邀请码列表 | admin+ |
| POST | `/api/admin/invite-codes` | 创建邀请码，创建响应返回明文 code，审计日志不保存明文或 hash | admin+ |
| PATCH | `/api/admin/invite-codes/:id` | 修改或禁用邀请码，写入审计日志 | admin+ |
| GET | `/api/admin/tracking-sources` | 推广来源列表，返回可复制追踪链接 | admin+ |
| POST | `/api/admin/tracking-sources` | 创建推广来源，写入审计日志 | admin+ |
| PATCH | `/api/admin/tracking-sources/:id` | 修改或停用推广来源，写入审计日志 | admin+ |
| PUT | `/api/ad-attribution` | 解析 click ID 或数据库校验通过的受管 `mg_source`，继承最近一次付费来源，签发 30 天单一平台 HttpOnly 加密来源上下文，并在同一响应中返回该平台安全的 Browser 公开配置；普通 UTM 不决定平台，冲突来源清除上下文 | public |
| DELETE | `/api/ad-attribution` | 清除当前广告来源上下文 | public |
| GET | `/api/admin/analytics/overview` | 数据分析总览，读取聚合表和健康摘要 | admin+ |
| GET | `/api/admin/analytics/sources` | 来源质量报表，包含已创建推广来源表现 | admin+ |
| GET | `/api/admin/analytics/pages` | 页面和内容表现报表 | admin+ |
| GET | `/api/admin/analytics/paths` | 聚合访问路径边报表 | admin+ |
| GET | `/api/admin/analytics/clicks` | 点击排行和重复点击报表 | admin+ |
| GET | `/api/admin/analytics/durations` | 页面有效时长和跳出报表 | admin+ |
| GET | `/api/admin/analytics/invites` | 邀请码转化报表 | admin+ |
| GET | `/api/admin/analytics/health` | 采集健康和 D1 预算摘要 | admin+ |
| GET | `/api/admin/analytics/sessions/:id` | 单 session 脱敏事件明细，写审计日志 | owner |
| POST | `/api/admin/analytics/exports` | 创建 CSV 导出任务并写入 R2，写审计日志 | owner |
| GET | `/api/admin/analytics/exports/:id` | 查看导出任务状态 | owner |
| GET | `/api/admin/attribution/summary?provider=meta\|tiktok\|google` | 按平台返回事实与 Browser/Server 投递摘要；`provider` 必填 | admin+ |
| GET | `/api/admin/attribution/trends?provider=meta\|tiktok\|google` | 按平台返回逐日事实与投递趋势 | admin+ |
| GET | `/api/admin/attribution/quality?provider=meta\|tiktok\|google` | 按平台返回匹配覆盖和可用的平台质量指标 | admin+ |
| GET | `/api/admin/attribution/capacity?provider=meta\|tiktok\|google` | 返回平台调用量、预算与容量状态 | admin+ |
| GET | `/api/admin/attribution/breakdown?provider=meta\|tiktok\|google` | 按 campaign、utm_content 或追踪来源拆分 | admin+ |
| GET | `/api/admin/attribution/conversions?provider=meta\|tiktok\|google` | 返回平台隔离的 Contact / CompleteRegistration 明细 | admin+ |
| GET | `/api/admin/attribution/platforms` | 返回通用平台连接列表，不返回凭证明文 | admin+ |
| GET | `/api/admin/attribution/platforms/:provider` | 返回单个平台连接和事件映射，不返回凭证明文 | admin+ |
| PATCH | `/api/admin/attribution/platforms/:provider` | 原子保存公开配置、加密凭证、事件映射和通道开关 | owner |
| POST | `/api/admin/attribution/platforms/:provider/test` | 使用当前配置立即测试平台连接；临时测试参数不持久化 | owner |
| POST | `/api/admin/legacy-import/sources` | 创建旧站来源 | admin+ |
| GET | `/api/admin/legacy-import/sources` | 读取旧站来源列表 | admin+ |
| POST | `/api/admin/legacy-import/jobs` | 启动旧站迁移 | admin+ |
| GET | `/api/admin/legacy-import/jobs` | 读取专用 legacy 任务列表；Owner 全部、Admin 仅本人 | admin+ |
| GET | `/api/admin/legacy-import/jobs/:id` | 迁移任务详情 | admin+ |
| POST | `/api/admin/legacy-import/jobs/:id/execute` | 执行旧站迁移 | admin+ |
| POST | `/api/admin/legacy-import/jobs/:id/recover-stale` | 把过期或历史缺失租约的 processing 任务收敛为失败；有效租约拒绝回收 | admin+ |
| POST | `/api/admin/legacy-import/jobs/:id/download-media` | 下载指定已完成 legacy 任务的待处理图片 | admin+ |
| GET | `/api/admin/legacy-import/items` | 迁移条目列表 | admin+ |
| GET | `/api/admin/legacy-import/items/:id` | 读取单条迁移审核事实和私有来源快照 | admin+ |
| PATCH | `/api/admin/legacy-import/items/:id/review` | 审核迁移条目 | admin+ |
| POST | `/api/admin/legacy-import/download-pending` | 批量下载旧站待处理图片 | admin+ |
| GET | `/api/admin/legacy-import/migrate/status` | 读取 legacy 范围内媒体与封面状态 | admin+ |
| POST | `/api/admin/legacy-import/migrate/retry-failed` | 重置旧站下载失败图片 | admin+ |
| POST | `/api/admin/legacy-import/migrate/set-covers` | 批量设置旧站迁移图库封面 | admin+ |

## 8. D1 数据库 Schema `[当前实现]`

以下为当前核心表摘要，完整结构以 `packages/api/migrations/` 中的顺序迁移为准。数据分析相关表已通过 `0023` 到 `0027` 建立 schema，并已接入公开采集 API、邀请码转化闭环、推广来源管理、Web 轻量 SDK、核心业务埋点、Cron 聚合任务、后台分析 API、后台分析页面、端到端 smoke、性能成本 fixtures、上线顺序和回滚文档。站内行为分析采集仍不依赖 Cloudflare Queues 或 Workers Analytics Engine；广告平台 Server API 使用 Meta/TikTok/Google 三组独立 `AD_*_QUEUE`。

### users

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- 通过 migration 0007 从 TEXT UUID 迁移为自增整数
  email TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  avatar_key TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- visitor/user/admin/owner
  status TEXT NOT NULL DEFAULT 'active', -- active/disabled
  email_verified INTEGER NOT NULL DEFAULT 0,
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### membership_levels

```sql
CREATE TABLE membership_levels (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE, -- free/vip/svip
  name TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始数据
INSERT INTO membership_levels (id, code, name, rank) VALUES
  ('ml_free', 'free', '免费', 0),
  ('ml_vip', 'vip', 'VIP', 10),
  ('ml_svip', 'svip', 'SVIP', 20);
```

### user_memberships

```sql
CREATE TABLE user_memberships (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  level_id TEXT NOT NULL REFERENCES membership_levels(id),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  note TEXT,
  granted_by INTEGER NOT NULL REFERENCES users(id),
  expiry_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_user_memberships_user ON user_memberships(user_id);
CREATE INDEX idx_user_memberships_active ON user_memberships(user_id, expires_at);
```

### galleries

```sql
CREATE TABLE galleries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  cover_key TEXT, -- R2 对象 key
  status TEXT NOT NULL DEFAULT 'draft', -- draft/published/unpublished/archived
  required_level_rank INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  legacy_url TEXT,
  legacy_slug TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_galleries_status ON galleries(status);
CREATE INDEX idx_galleries_slug ON galleries(slug);
CREATE INDEX idx_galleries_published ON galleries(status, published_at);
```

### App 人物供给与公开投影 `[开发验证]`

`0067_app_public_profile_projection.sql` 创建空的 `profile_public_projections` 只读投影；`0068_app_person_supply_workflow.sql` 创建以下权威表并扩展投影追溯字段，两项 migration 均不包含人物 seed、图库自动映射或真实数据回填：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `persons` | 真人主体稳定 ID 与生命周期 | `per_*`；只允许 active/suspended/archived |
| `person_profiles` | 当前可编辑资料聚合 | `pp_*`；内容版本与并发锁版本分离；授权、认证、发布三轴独立 |
| `person_authorizations` | App 公开用途授权记录 | 绑定 `profile_id + profile_version`；证据仅存内部引用；支持开始、到期和撤销 |
| `person_verifications` | 认证提交与复核历史 | 绑定具体内容版本；记录身份存在、授权关系、资料一致性、媒体权利四项检查 |
| `person_publication_reviews` | 发布、退回和暂停历史 | 发布决定追溯到内容、授权、认证和投影版本 |
| `profile_public_projections` | App 公开只读快照 | 仅发布动作单向写入；公开 API 不回退权威草稿；暂停/撤销立即失去资格 |

版本规则：

- `content_version` 只在公开内容字段变化时递增，认证和授权必须绑定该版本。
- `lock_version` 在每次管理写操作后递增，所有命令必须提交 `expectedVersion`；不匹配返回 `VERSION_CONFLICT`。
- 已发布人物被编辑时，线上投影继续保留已审定的旧内容版本，新草稿不会静默覆盖线上。
- 发布前和发布写入时都校验人物、来源图库、封面、安全、运营披露、用途授权、认证与有效期；发布写入使用带随机 `mutation_token` 的条件批次，未取得并发锁的命令不能写审批、投影或审计记录。
- 授权/认证撤销和人工暂停会把投影改为不可见；到期无需后台任务，公开查询按请求时间动态拒绝。
- 当前开发验证只开放 `platform_managed`，公开披露为“消息由平台运营接收”；`self_managed` 只保留 schema 兼容位，不开放后台选择。

当前状态仍是开发验证：未执行 production migration，未导入真实人物或证据，认证正式声明、证据保留期和人员分离规则仍须在生产启用前完成专业门禁。

### App 账号访问表族 `[开发验证，默认关闭]`

`0069_app_account_access.sql` 不回填现有用户，只创建下列表与索引：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_account_security` | 内部用户到 `acc_*` 公共账号 ID、账号状态和 session version | 一名现有用户最多一条；不复制账号密码 |
| `app_account_identities` | 邮箱登录身份映射 | provider subject 只存 SHA-256；同一 provider subject 唯一 |
| `app_account_consents` | 条款、隐私、平台运营和资格说明的版本化决定 | 不保存硬编码年龄，只保存文档版本、决定和请求 ID |
| `app_devices` | 本人设备目录和设备级 session version | 安装标识只存 SHA-256；账号内唯一；支持 active/revoked |
| `app_sessions` | 可撤销 Access/Refresh 会话 | Token 只存摘要；每台设备最多一个 active 会话 |
| `app_refresh_token_history` | 已替换 Refresh 摘要 | 用于重放检测，不返回客户端 |
| `app_account_security_events` | 登录、刷新、退出、重放和设备撤销安全事件 | 不保存邮箱、Token、验证码或设备安装原值 |

该表族是可回滚开发基线，不替代未来经 G-01/G-03 冻结后的完整身份、隐私和数据权利模型；没有 production migration、seed 或真实同意数据。

### App 互动、收藏、历史与关注更新表族 `[服务端开发完成，默认关闭]`

`0070_app_viewer_interactions.sql` 保存 Interaction-1 喜欢/关注；`0078_app_favorites_and_view_history.sql` 另建 Interaction-2 收藏与历史表族，`0096_app_favorite_folder_preserve_default.sql` 保证删除自定义收藏夹时保留默认收藏。它们均不回填 legacy 数据，且收藏不得降级为 `app_viewer_interactions` 中的第三种关系：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_viewer_interactions` | 本人喜欢、关注私有关系 | 账号+资料+类型唯一；只允许 `like|follow` |
| `app_interaction_collection_policies` | 收藏与历史版本化运行策略 | development/production-ready 分离；保留期、个性化和 purge 独立门禁 |
| `app_favorite_folders` | 本人默认和自定义收藏夹 | 账号作用域 ID；默认夹唯一且不可删除；业务名称最多 20 字并归一化去重；单调 version |
| `app_favorite_folder_items` | 文件夹与人物资料关系 | 账号+文件夹+资料唯一；同一人物可属于多个文件夹 |
| `app_view_history_preferences` | 本人历史记录开关与并发版本 | 默认关闭；mutation token 绑定清除和屏蔽联动 |
| `app_profile_view_history` | 本人按人物聚合的浏览历史 | 账号+资料唯一；保存最近浏览、次数、最近 view ID 摘要和到期时间 |
| `app_follow_update_policies` | 关注更新流与通知投影版本化门禁 | 生效时间禁止历史回填；development/production-ready 分离；不复制发布事件 |

Interaction-2/3 策略都只 seed 默认关闭的 development 配置，不 seed 收藏夹、收藏条目、偏好、历史、更新或通知。Interaction-4 复用 `0078` 已有到期索引，不新增 migration；保留策略未决或环境未显式配置策略 ID 时清理器跳过。当前没有执行 `0078`/`0079`/`0096` migration，也不允许 production-ready。

### App 搜索、分类与保存条件表族 `[服务端开发完成，默认关闭]`

`0080`、`0081` 与 `0082` 依次建立隐私搜索、稳定 taxonomy 和 Search-2 筛选闭环，不回填旧搜索记录、legacy 标签或用户保存条件：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_person_search_policies` | 搜索、历史、筛选、预估和保存条件版本化门禁 | production-ready 与历史保留门禁分离；默认历史关闭；筛选最多 12 项 |
| `app_search_history_preferences` / `app_person_search_history` | 本人私有搜索历史 | 显式开启与显式记录；乐观版本清除；搜索词不进入审计/分析 |
| `app_taxonomy_terms` / `app_taxonomy_term_revisions` | 稳定词条编辑事实和不可变修订 | 生命周期、父子同类型、合并目标和敏感状态受约束 |
| `app_taxonomy_catalogs` / `app_taxonomy_catalog_items` | 不可变客户端目录快照 | 目录版本唯一；公开只包含受控快照，不混合版本 |
| `app_taxonomy_catalog_closure` | 目录父子与合并闭包 | ancestor/descendant 三元组唯一；父级包含后代，合并目标兼容旧投影 ID |
| `person_profile_taxonomy_assignments` / `profile_public_taxonomy_terms` | 人物内容版本标注与可重建公开投影 | 发布门禁校验目录/词条版本；公开查询不读取编辑态 |
| `app_taxonomy_legacy_mappings` | legacy 值显式迁移决策 | 未知值待复核；split/unsupported 不进入人物公开投影 |
| `app_saved_person_filters` | 本人账号私有结构化保存条件 | 不保存自由搜索词；幂等摘要、原子 quota、同名唯一、乐观版本、删除清空内容 |

Search-2 新会员目录是独立不可变快照；在配置切换前没有账号 grant 指向它。目录切换必须与 grant 迁移策略一起评审，不能只修改环境变量。

### App 五级会员表族 `[开发验证，默认关闭]`

`0071_app_membership_catalog_and_grants.sql` 只 seed 开发目录，不迁移 legacy 会员或账号数据：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_membership_catalog_versions` | 版本化目录及生产门禁 | 版本 code 唯一；`state` 与 `production_ready` 双状态 |
| `app_membership_tiers` | 五级品牌、rank 和服务说明 | 目录内 tier ID、code、rank、顺序均唯一 |
| `app_entitlement_definitions` | 按目录版本快照的 typed entitlement schema | 目录内稳定 key、值类型、安全默认值、合并策略和客户端 capability；新版本不覆盖旧定义 |
| `app_membership_tier_entitlements` | 每级目录值 | 目录/等级/权益唯一；`planned|available` 明确分离 |
| `app_membership_grants` | 不可变账号发放事实 | 快照化等级、有效区间、原因、用户说明、发放人；账号内业务单号唯一 |
| `app_membership_grant_revocations` | 追加式撤销 | 每个 grant 最多一条；不更新或删除原 grant |
| `app_membership_admin_requests` | 后台写操作幂等结果 | 幂等键唯一；绑定规范化请求哈希、目标账号和结果 grant |

`0089_app_membership_catalog_management.sql` 在上述业务快照上增加管理平面，但不修改既有目录内容或运行配置：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_membership_catalog_metadata` | 基线、lock、摘要、生产决策和责任人 | 基线/创建身份不可变；创建人与发布人分离；后继目录冻结基线 |
| `app_membership_catalog_commands` | 管理写命令幂等事实 | 管理员 + 幂等键唯一；请求哈希绑定操作与结果 lock；不可修改/删除 |
| `app_membership_catalog_publish_requests` | 固化内容哈希、校验报告和发布状态 | 每目录最多一个待复核申请；申请人与复核人分离 |
| `app_membership_catalog_publish_events` | 提交、批准、拒绝和失效时间线 | 申请内 sequence 唯一；不可修改/删除 |
| `app_membership_catalog_publish_decisions` | Owner 决定幂等结果 | reviewer + 幂等键唯一；不可修改/删除 |

目录服务只允许未被当前环境、发布申请、grant、会员申请或后继目录引用的 `development` 草稿原地编辑。发布批准在同一 D1 条件批次内重新检查 Owner、职责分离、目录 lock、内容哈希和校验结果；成功只更新为不可变 `published`，不会改 Wrangler 或当前目录 ID。真实 production-ready 决策、`0089` 执行、配置和专项测试统一后置。

### App Membership-2 申请表族 `[开发验证，默认关闭]`

`0075_app_membership_applications.sql` 不创建申请 seed、不迁移旧站咨询，也不创建保留期清理任务：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_membership_applications` | 申请权威状态与意向等级快照 | 账号进行中状态部分唯一；`approved` 当且仅当关联正式 grant；发放锁阻止并行终态 |
| `app_membership_application_events` | 用户可见业务时间线 | 申请内 sequence 唯一；只保存状态和用户可见说明，不复制申请正文 |
| `app_membership_application_requests` | 用户提交、补充和取消幂等结果 | 账号 + key 唯一；绑定规范化请求哈希和原申请 |

管理员状态写入使用 `expectedVersion` 条件更新，并在同一个 D1 `batch()` 中通过后续 `INSERT ... SELECT` 绑定事件与审计；调用方检查每条语句 `changes=1`。批准先以稳定幂等键取得 `approval_request_key`，再执行不可变 grant，最后关联 `grant_id`；若响应中断，使用同一键可恢复原 grant 并完成申请终态，不能换键重复发放。

当前解析只选择未撤销且满足 `starts_at <= now < expires_at` 的最高 `rank` grant。客户端快照不构成授权；未来接入受限业务 API 时仍须在服务端按请求重新解析并完成额度原子消耗。

### App 平台话题表族 `[开发验证，默认关闭]`

`0072_app_managed_conversations.sql` 不创建真实会话、账号或 grant seed：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_conversations` | 账号与合格人物之间的平台话题事实 | `account_id + profile_id` 唯一；仅 `platform_managed`；保存单调 sequence/read 高水位 |
| `app_conversation_quota_consumptions` | 新话题日额度追加消耗 | 每个新会话恰好一条；绑定 grant、目录、等级、entitlement 与上海日键 |
| `app_conversation_messages` | 文本和系统消息权威顺序 | 会话内 sequence/client message ID 唯一；发送身份与 actor 外键组合受 CHECK 限制 |
| `app_messaging_idempotency` | 创建与双端发送的幂等结果 | `actor_scope + operation + idempotency_key` 唯一；绑定规范化请求哈希 |

会话正文不是分析或审计载荷。当前 D1 是 Message-1 的唯一消息事实源；只有未来完成独立实时/可靠性设计后，才能引入 Durable Objects 或 Queue，且不得形成第二条业务事实链路。

### App Message-2 安全表族 `[开发验证，默认关闭]`

`0073_app_messaging_safety_operations.sql` 不创建账号、grant、会话、举报或屏蔽业务 seed，也不执行自动清理：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_safety_retention_policies` | 消息、举报、证据保留决策版本 | 未决策略不允许 production-ready；当前天数为空、purge 关闭 |
| `app_safety_reason_catalogs` / `app_safety_reason_definitions` | 版本化用户举报原因 | 原因稳定 code、优先级与用户可见性受目录约束 |
| `app_profile_blocks` / `app_profile_block_events` | 当前屏蔽状态与追加事件 | 账号+人物唯一、单调 version、mutation token 条件写 |
| `app_safety_reports` | 举报案件权威状态 | 目标字段互斥、原因外键、用户状态与内部状态分离、版本条件写 |
| `app_safety_report_evidence` | 提交时最小证据引用与摘要 | 不接受客户端正文快照；消息只固定目标及相邻引用和 SHA-256 |
| `app_safety_report_events` | 用户可见/内部案件时间线 | 案件内 sequence 唯一，actor 类型与账号字段组合受 CHECK 限制 |
| `app_safety_idempotency` | 安全、assignment 与运行控制幂等结果 | actor scope + operation + key 唯一，绑定规范化请求哈希 |
| `app_conversation_assignment_state` / `app_conversation_assignment_events` | 当前限时运营分配与追加历史 | 单会话最多一个状态；租约到期即失权；mutation token 防并发残留 |
| `app_messaging_runtime_controls` | 全局暂停、容量、租约和保留引用 | 单例 scope、版本条件写；只有 owner 可修改且必须审计 |

所有安全联动在 D1 条件批次中通过同一 mutation token 或前置消息事实串联。SQL 执行成功但条件未命中时，调用方必须检查幂等结果并返回冲突，不能把“零行变更”当作成功。

### App 话题内部协作表族 `[开发完成，migration 待执行]`

`0084_app_conversation_collaboration.sql` 不创建管理员、话题、备注或转派业务 seed，也不启用任何运行时开关：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_conversation_internal_notes` | 追加式运营、交接和质量备注 | 正文限 1000 字；作者不可为空；通用审计只保存哈希、长度与引用 |
| `app_conversation_transfer_events` | 显式转派不可变事实 | 会话+assignment version 唯一；来源与目标不同；绑定交接备注和新租约到期时间 |
| `app_conversation_admin_idempotency` | 内部备注与转派幂等结果 | 管理员+操作+key 唯一；绑定规范化请求哈希、会话和结果版本 |

转派不会伪造 `released + claimed` 两次独立成功，而以单次 assignment 版本跃迁作为权威事实；原租约持有人在批次成功后不能再读取正文、备注或执行写操作。安全升级案件由 `0085` 独立实现，运营组、班次与自动分配由 `0086` 独立实现；质量抽检不属于 `0084`。

### App 话题内部安全升级表族 `[开发完成，migration 待执行]`

`0085_app_conversation_safety_escalations.sql` 不复用用户举报表，不创建业务 seed，也不启用任何运行时开关：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_conversation_safety_escalations` | 内部升级案件和独立审核结论 | 发起人/审核人隔离；乐观 version；说明限 1000 字；动作只允许 none/只读/关闭 |
| `app_conversation_safety_escalation_evidence` | 创建时最小证据引用 | 可固定整个话题或单条消息及前后一条；保存正文摘要和 evidence digest，不复制正文 |
| `app_conversation_safety_escalation_events` | 追加式内部时间线 | 案件内 sequence 唯一；只记录稳定状态、原因和 actor 引用 |
| `app_conversation_safety_escalation_idempotency` | 创建、领取和结论幂等结果 | 管理员+操作+key 唯一；绑定规范化请求哈希与案件版本 |

队列列表不返回内部说明或消息正文。实际话题动作与案件结论在同一 D1 条件批次中收敛；如果 assignment、话题 sequence、案件 version 或证据状态发生竞争，不得留下未绑定系统消息、会话限制、案件结论或审计。

### App 话题运营组、班次与路由表族 `[开发完成，migration 待执行]`

`0086_app_conversation_routing_and_shifts.sql` 只创建空表，不创建运营组、成员、班次或路由规则，也不启用自动分配：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_conversation_groups` | 稳定运营组及组级容量 | 固定 `Asia/Shanghai`；状态、双容量和乐观 version 均由服务端校验 |
| `app_conversation_group_members` | 组内职责与个人容量 | 仅有效 admin/owner；operator/lead 才可接单，quality 不进入候选 |
| `app_conversation_group_shifts` | 周期班次 | 星期+分钟表达，开始大于结束表示跨日；无生效班次时不分配 |
| `app_conversation_assignment_policies` | 全局人工/自动模式 | 固定最低负载最久未分配算法；未命中固定保留未分配 |
| `app_conversation_routing_rules` | 真人、地区与默认路由 | 生效匹配唯一；真人优先于地区，地区优先于默认，同类型按 priority+ID |
| `app_conversation_routing_assignment_events` | 自动与受路由人工领取事实 | 绑定 assignment version、规则/策略、组/管理员、服务日与分配前容量快照 |
| `app_conversation_routing_idempotency` | 后台配置和补偿分配幂等 | 管理员+操作+key 唯一；绑定规范请求哈希、结果 ID/version |

自动分配由观看者消息成功响应后的 Worker `waitUntil` 尝试；它是消息写入之后的可恢复运营副作用，失败不得改变消息成功事实。Owner 可在工作台按 `max_dispatch_batch` 对积压执行补偿分配。人工领取在尚未创建策略时保持旧行为；策略一旦存在，就必须命中当前最具体规则、属于目标组且处于有效班次，条件写入还会重新检查成员/规则版本、个人和组容量以及服务日首次响应额度。所有路径都复用 `app_conversation_assignment_state` 作为唯一租约权威，不创建第二套 assignment 状态。

### App 话题质量抽检表族 `[开发完成，migration 待执行]`

`0087_app_conversation_quality_reviews.sql` 只创建空表，不回填历史运营回复、不创建抽样批次或质检配置，也不启用运行时开关：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_conversation_operator_message_facts` | 运营回复的实际操作员与发送时上下文事实 | 与消息同批写入；固定 assignment version、组、披露版本、正文哈希，不复制正文 |
| `app_conversation_quality_selection_runs` | 确定性抽样批次 | 单次 1–50 条、窗口不超过 31 天；按实际操作员轮转后选择最早未抽样回复 |
| `app_conversation_quality_samples` | 样本状态、限时领取和最终评分 | 消息唯一；实际回复人与质检人隔离；乐观 version；完成后不再授权正文 |
| `app_conversation_quality_sample_evidence` | 创建时固定的最小证据引用 | 目标消息、前后一条与披露卡；仅保存 ID、哈希和整体 digest，不复制正文 |
| `app_conversation_quality_sample_events` | 样本追加式时间线 | 样本内 sequence 唯一；选择、领取、结论、作废和任务创建均留痕 |
| `app_conversation_quality_improvement_tasks` | 可执行改进任务 | 负责人必须是有效操作员/组长；指导正文只在受控任务响应中返回；乐观 version |
| `app_conversation_quality_improvement_task_events` | 改进任务追加式时间线 | 开始、完成、取消均保留稳定原因和 actor 引用 |
| `app_conversation_quality_idempotency` | 抽样、领取、结论、作废和任务更新幂等结果 | 管理员+操作+key 唯一；绑定规范化请求哈希和结果版本 |

队列、批次和通用审计不得返回消息正文、用户账号信息或内部结论正文。质检员领取样本时服务端重新校验有效 `lead|quality` 范围并签发 60 分钟租约；敏感详情仅向当前租约持有人开放且记录 `quality_review` 访问审计。提交结论时再次校验证据哈希、范围、版本和职责；披露缺失或不一致不能判定通过。`coaching_required` 必须与改进任务同批创建，`safety_referral` 必须与独立内部安全案件同批创建，但不得替代安全审核或直接处罚。

### App Safety-2 申诉表族 `[dev 受控联调，production 默认关闭]`

`0074_app_safety_appeals.sql` 不创建举报、申诉或管理员业务 seed：

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_safety_appeal_policies` | 版本化申请窗口、文本上限和保留策略引用 | development 与 production-ready 分离；生产策略必须引用已就绪保留策略 |
| `app_safety_appeals` | 举报结论复核权威状态 | 举报 ID + 原结论版本唯一；固定申诉类型；原审核人与复核人分离；单调 version/mutation token |
| `app_safety_appeal_events` | 用户可见与内部复核时间线 | 申诉内 sequence 唯一；actor 类型与账号/管理员字段组合受 CHECK 限制 |
| `app_safety_appeal_idempotency` | 观看者创建、管理员领取和结论幂等结果 | actor scope + operation + key 唯一；绑定规范化请求哈希和结果版本 |

`changed` 路径通过 D1 `batch()` 串联举报更新、举报事件、申诉更新、申诉事件、幂等结果和审计；后续语句依赖前序 mutation token。批次完成后仍必须读取幂等结果与目标版本确认条件命中，零行更新不能视为成功。

### media_assets

```sql
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id),
  type TEXT NOT NULL, -- image/video
  storage TEXT NOT NULL, -- r2/stream
  r2_key TEXT,
  stream_uid TEXT,
  required_rank INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'content', -- cover/content/preview/full
  sort_order INTEGER NOT NULL DEFAULT 0,
  upload_status TEXT NOT NULL DEFAULT 'completed', -- completed/upload_failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_media_assets_gallery ON media_assets(gallery_id);
```

### tags

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- region_scope/region_group/city_country/identity/personality/style/occupation/hair/clothing/scene/content_type
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tags_type ON tags(type);
```

### gallery_tags

```sql
CREATE TABLE gallery_tags (
  gallery_id TEXT NOT NULL REFERENCES galleries(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (gallery_id, tag_id)
);

CREATE INDEX idx_gallery_tags_tag ON gallery_tags(tag_id);
```

### gallery_likes

```sql
CREATE TABLE gallery_likes (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gallery_id, user_id)
);
```

### import_jobs

```sql
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'zip', -- zip/legacy
  status TEXT NOT NULL DEFAULT 'queued', -- queued/uploading/validating/processing/finalizing/partial_failure/paused/completed
  source_key TEXT, -- 私有 R2 原包 key
  source_name TEXT,
  package_size INTEGER,
  package_etag TEXT,
  multipart_upload_id TEXT,
  upload_session_id TEXT,
  upload_part_size INTEGER,
  upload_part_count INTEGER,
  schema_version TEXT NOT NULL DEFAULT 'gallery_zip_v1',
  mapping_version TEXT NOT NULL DEFAULT 'gallery_mapping_v1',
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_report_key TEXT, -- R2 key
  created_by INTEGER NOT NULL REFERENCES users(id),
  processing_requested_by INTEGER REFERENCES users(id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  legacy_processing_token TEXT, -- 仅 legacy processing 执行租约使用
  legacy_processing_expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_at TEXT,
  started_at TEXT,
  updated_at TEXT,
  completed_at TEXT
);

CREATE TABLE import_job_upload_parts (
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  upload_session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  part_size INTEGER NOT NULL,
  PRIMARY KEY (job_id, upload_session_id, part_number)
);

CREATE TABLE import_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  folder TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL, -- pending/processing/completed/failed
  stage TEXT NOT NULL, -- preflight/content/media/commit/completed
  gallery_id TEXT REFERENCES galleries(id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(job_id, folder)
);
```

### import_api_tokens / external_import_records / external_import_files

```sql
CREATE TABLE import_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL, -- JSON: gallery:create / case:create
  allowed_source_bot_keys TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE external_import_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'telegram',
  external_message_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES import_api_tokens(id),
  source_bot_key TEXT NOT NULL,
  target_type TEXT NOT NULL, -- gallery/case
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_media_fetch',
  metadata_json TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  processing_token TEXT,
  processing_started_at TEXT,
  processing_heartbeat_at TEXT,
  processing_lease_expires_at TEXT,
  processing_target_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE external_import_files (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES external_import_records(id) ON DELETE CASCADE,
  telegram_file_id TEXT NOT NULL,
  filename TEXT,
  actual_mime_type TEXT,
  file_size INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  target_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### admin_audit_logs

```sql
CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL, -- gallery.create / process_import / legacy_media_download_pending / settings_change 等
  target_type TEXT NOT NULL, -- gallery/case/tag/user/media_asset/import_job/import_api_token/settings 等
  target_id TEXT,
  before_value TEXT, -- JSON
  after_value TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_logs_admin ON admin_audit_logs(admin_id);
CREATE INDEX idx_audit_logs_time ON admin_audit_logs(created_at);
```

后台写操作必须写入 `admin_audit_logs` 并补测试。普通单步写入可调用 `writeAuditLog`；高风险多语句工作流应把审计 `INSERT` 与状态变更放入同一受控 `db.batch`，并通过条件 `INSERT ... SELECT` 确保未取得并发锁时不会生成假审计。新增 `POST` / `PUT` / `PATCH` / `DELETE` 管理端路由时必须同步添加审计日志断言。

Audit-1 继续把 `admin_audit_logs` 作为唯一事实源。`0090_app_audit_query_and_integrity.sql` 通过 `app_audit_event_index` 自动赋予稳定 sequence，通过可选 `app_audit_event_contexts` 追加 request/trace/业务/审批引用；历史事实、索引、上下文、Action 版本和检查清单均由 trigger 禁止更新或删除。Action registry 使用追加 `(action_key, schema_version)`，最高版本决定当前 active/retired 状态，不允许原地改定义。

审计列表默认 7 天、最大 31 天，游标绑定管理员可见范围与完整筛选指纹。admin 只能查询本人操作，owner 才能跨域；详情读取重新校验对象范围并对消息、备注、证据、凭据、邮箱、电话、精确位置、私有 key、疑似 JWT/私钥/签名 URL 和长文本进行服务端脱敏。查询和详情读取本身追加审计，不提供修改、回滚或重放入口。

Owner 完整性检查默认最近 1,000、单次最多 5,000 个连续 sequence，生成带 `manifest_version` 的 SHA-256 链式 manifest；摘要覆盖原事实、稳定索引和结构化上下文，并只与同范围同算法版本旧清单比较。检查检测序号缺口、源事实缺少索引、非法 JSON、敏感字段、未登记生产 Action、同范围 manifest 变化，以及会员发放、钱包入账、运营回复、人物发布四类关键业务事实是否缺少对应审计。反向检查只读取既有权威表并保存摘要 finding，不复制业务载荷、不猜测操作者、不自动补写审计。检查结果和 finding 只追加，不修复源事实；正式 Action/治理策略配置、保留期、自动调度、告警和专项测试统一后置。完整边界见 `docs/app/AUDIT_1_QUERY_AND_INTEGRITY_INTEGRATION.md`。

Audit-2 在 `0091_app_audit_controlled_exports.sql` 中新增受控导出工作流，不复制 `admin_audit_logs`。核心请求保存不可变 Audit-1 查询 JSON、绑定当前角色的权限指纹、事件数量、首末 sequence 和范围 SHA-256；admin 只能冻结本人事件，Owner 可冻结跨域事件，但复核人必须是不同的有效 Owner。申请、复核和下载票据签发分别要求密码 step-up，凭证仅存 SHA-256、绑定单一动作并只能消费一次。复核和发票前以申请人的当前角色重算同一范围，指纹或事件集合变化会把申请推进到 `scope_changed`，不会生成或读取文件。

复核通过后，API Worker 最多读取 5,000 行，复用 Audit-1 before/after 脱敏器并为每行写申请、生成、申请人、复核人、用途、案件和范围水印；CSV 全字段引用、转义并阻断公式前缀，最大 25,000,000 字节。Worker 以已知长度 `Uint8Array`、SHA-256 checksum、`no-store` metadata 写入既有私有 R2 固定 key `audit/exports/{requestId}/events.csv`，D1 只保存 key、ETag、SHA、大小、行数和有效期，管理 API 不返回 key/ETag 或对象 URL。原申请人重新验证密码后取得五分钟一次性 HMAC 票据；下载使用 header 提交给 Worker，Worker 核对管理员、申请版本/有效期、文件/范围摘要及 R2 metadata，在 D1 条件消费票据并追加审计后才流式响应。当前文件逻辑有效期 24 小时只是开发安全默认值，正式保留与物理清理、`0091` 执行和专项测试统一后置。完整契约见 `docs/app/AUDIT_2_CONTROLLED_EXPORT_INTEGRATION.md`。

Operations-1 在 `0092_app_operations_and_incidents.sql` 中新增指标定义/快照、Runbook、检测运行/finding、事件/时间线、跨域安全控制和管理员幂等命令。指标定义与快照只追加，每项值必须携带 `known / unknown / delayed / partial / invalid / unconfigured`，只有 `known` 可以返回数值；首批 18 项定义的保留决策仍为 `unresolved`、`production_ready=0`。Operations-4 已为 Cloudflare Worker/D1/R2 三项技术指标补齐采集器：配置缺失/非法时为 `unconfigured`，来源或空样本为 `unknown`，结构/数值违约为 `invalid`。事件使用稳定 `incident_key` 聚合重复检测，状态通过 D1 trigger 和服务端 `expectedVersion` 双重限制；关闭必须提供结论摘要和证据。

当前 `operations-detectors-v3` 累计覆盖 10 类 D1 权威检测和 1 类 Cloudflare 官方公共状态检测。`0106_app_operations_membership_expiry_detector.sql` 只为观看者消息反向核权增加局部覆盖索引；检测把正常自然到期与“到期后仍产生新话题或观看者消息”分开，只保存聚合数量且不自动改 grant、撤销记录、话题或消息。Operations-3 并行读取无需鉴权的官方 Status API Summary，只匹配 API、D1、Durable Objects、Email Sending、Queues、R2、Turnstile、Workers 与 Workers Assets；相关组件或未解决事件异常时复用 `platform_health_anomaly`，来源不可读或载荷不合法时不制造事故，只令本次运行 `partial` 且 `unavailableDetectorCount=1`。来源健康时为 `completed / 0`。`0108_app_operations_cloudflare_status_runbook.sql` 只追加第八份不可变 Runbook，不增加 secret 或 binding。公共状态不替代账户级遥测；Operations-4 的 `operations-metrics-v2` 通过一次有界 GraphQL 请求采集指定 Worker 最近 5 分钟错误率、D1 当日 UTC `queryBatchTimeMsP95` 和指定 R2 最近 5 分钟内部错误率，HTTP 200 但含 GraphQL errors 时也拒绝整次账户级结果，空样本不按 0。D1 P95 在配置阶段必须经 introspection 复核，不允许悄然降为 P90。钱包不平仍只保护性冻结，不自动补账或修改分录。完整增量边界见 `docs/app/OPERATIONS_2_MEMBERSHIP_EXPIRY_INTEGRITY.md`、`docs/app/OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md` 与 `docs/app/OPERATIONS_4_CLOUDFLARE_ANALYTICS_INTEGRATION.md`；`0106/0108` 执行、Analytics 凭据/资源配置、调度、构建和专项验证统一后置。

五类安全控制为 `person_publication`、`recommendation_delivery`、`operator_messaging`、`membership_grants` 和 `wallet_adjustments`。每个受控写路径在服务入口 fail-closed 读取控制，并在最终业务 SQL 以 `EXISTS state='available'` 原子重验；暂停不影响下线、撤销、拒绝、回滚、调查或只读对账。只有 Owner 可用未关闭 P0/P1 事件暂停控制，恢复必须来自原事件且有验证证据；平台状态检测和账户级指标都不会自动暂停任一控制。管理 API 位于 `/api/admin/app/operations`，所有响应 `private, no-store`；普通 admin 可读/领取并仅处置本人事件，Owner 可跨事件且独占刷新、检测和控制。账户级 Analytics Token 只允许 Account Analytics Read，Token 与账号/资源标识不得进入快照、日志或审计详情。完整数据表、路由、交互与 Runbook 见 `docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md`；`0092/0108` 执行、正式指标/Action/保留政策、Cloudflare Analytics 配置、调度、专项测试和恢复演练统一后置。

Audit-3 在 `0093_app_audit_action_registry_governance.sql` 中补齐受控 Action Registry：`app_audit_governance_policy_registry` 以不可变版本登记 retention/quality 稳定引用，`app_audit_production_action_registry` 只暴露当前 active、两类引用均已批准且 production-ready、并包含 Owner 可见角色的 Action。当前 migration 不 seed 策略；任意引用字符串都不会被隐式视为已批准。

Owner-only `/api/admin/app/audit/registry` 工作区合并真实 `admin_audit_logs.action` 与前置登记 Action，预览观察业务域、风险、缺索引和历史影响，再提交发布或退休申请。申请人与复核人分离；批准在服务预览和最终 `INSERT ... SELECT` 两处重验当前 Action 版本、观察摘要以及两类治理引用，变化时只把申请推进到 `stale`。普通 admin 的审计列表、筛选项、详情、关联时间线和受控导出统一使用生产 Registry，并继续要求本人归属与 `visibleRoles` 包含 `admin`；Owner 保留未登记事实的治理可见性。完整契约见 `docs/app/AUDIT_3_ACTION_REGISTRY_GOVERNANCE_INTEGRATION.md`；`0093`、真实策略/Action、配置和专项测试统一后置。

### site_settings

```sql
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始配置
INSERT INTO site_settings (key, value) VALUES
  ('site_name', '""'),
  ('seo_title', '""'),
  ('seo_keywords', '""'),
  ('site_description', '""'),
  ('site_icon', '""'),
  ('og_title', '""'),
  ('og_description', '""'),
  ('og_image', '""'),
  ('membership_description', '""'),
  ('email_verification_enabled', '"false"'),
  ('video_enabled', '"false"'),
  ('footer_text', '""');
```

旧 `home_ad_*` 站点设置仍保留为公开读取兼容兜底；当前主要首页广告配置使用独立 `home_ads` 表和 `/api/admin/ads` 后台页面维护。

`seo_keywords` 为后台 SEO 关键词池，配置入口为 `/admin/settings` 的 `SEO / 社交分享` 区块。API 保存时归一化中英文分隔符、去重并限制最多 30 个关键词、单个关键词 24 个字符；公开接口 `/api/settings/public` 返回清洗后的逗号分隔字符串。前台将该关键词池用于首页 `WebSite` JSON-LD `keywords`、页面级兼容 `meta keywords`，并在图库详情和真实案例详情中叠加页面标签或案例语境词。`0031_seed_seo_keywords.sql` 会在该设置为空时写入当前项目首版关键词池，不覆盖后续后台手动维护的非空值。关键词池不是 Google 排名信号的替代品，SEO 验收仍以标题、描述、正文内容、canonical、sitemap 和结构化数据为主；运营配置说明见 `docs/SEO_CONFIGURATION.md`。

### 数据分析表 `[部分实现]`

当前已通过 `0023_analytics_core.sql` 到 `0026_analytics_exports.sql` 建立数据分析 schema，并已接入 `/api/analytics/events`、`/api/analytics/session/end` 公开采集接口、邀请码转化闭环、Web 轻量 SDK、核心业务埋点、Cron 聚合任务、后台分析 API、后台分析页面、端到端 smoke、性能成本 fixtures、上线顺序和回滚文档。采集接口默认受 `analytics_enabled=false` 保护，关闭时返回 disabled 且不写 D1；Web SDK 同样读取公开设置，关闭时不初始化 visitor/session，不写本地存储。当前前台已覆盖首页广告、图库卡片、图库详情、图片查看器、会员 CTA、点赞成功、搜索、筛选、排序、加载更多、联系面板和规则入口事件；联系悬浮入口仅在客户端 mounted 后显示，避免 SSR 未绑定事件时丢失关键点击。媒体授权成功/拒绝由 API Worker 侧写入可信 `media_access_granted` / `media_access_denied`，不信任前端伪造授权结果。后台分析 API 的流量、页面和点击读取行为聚合表，`Contact / CompleteRegistration` 则统一从 `attribution_conversion_facts` 的只读指标服务获取，禁止把前端点击或 `register_success` 再累加为第二套业务转化；单 session 明细和 CSV 导出使用相同口径。后台已新增 `/admin/analytics` 总览、来源、内容、链路、点击、时长、邀请、健康页面和 `/admin/invite-codes` 跳转入口；生产启用仍必须按部署文档的开关顺序由 Owner 显式打开。后台来源中的 `fb`、`facebook`、`meta` 表示站内 UTM、推广链接或 referrer 归因，不代表 Meta Pixel 回传；Meta Pixel 仅用于向 Meta 后台同步清洗后的转化事件。

核心表分层：

| 表 | 状态 | 用途 |
|------|------|------|
| `analytics_visitors` | `[部分实现]` | 匿名访客事实，不保存原始 IP 或完整 user agent；可在登录后绑定内部 `user_id`。 |
| `analytics_sessions` | `[部分实现]` | session 入口、退出、来源、设备、国家和有效浏览摘要。 |
| `analytics_page_summaries` | `[部分实现]` | session 内页面级摘要，用于页面时长、跳出、入口/退出和滚动深度统计。 |
| `analytics_session_summaries` | `[部分实现]` | session 级摘要，用于默认后台报表避免扫描采样明细。 |
| `analytics_events` | `[部分实现]` | 必要的安全/行为明细和 1%-5% 采样明细；Contact 与完成注册不写入此表。 |
| `analytics_ingest_health_daily` | `[部分实现]` | 每日 accepted/rejected/duplicate/sensitive blocked、采样、丢弃和 D1 预算估算。 |
| `invite_codes` | `[当前实现]` | 后台邀请码定义，保存 `code_hash` 和 `display_code`，创建响应返回明文 code，创建/修改/禁用写入审计日志。 |
| `invite_registrations` | `[当前实现]` | 邀请注册事实，关联 visitor、session、注册用户和首次会员发放回填；重复绑定不会重复增加 `used_count`。 |
| `analytics_daily_sources` | `[部分实现]` | 按日期、来源渠道、来源名称和邀请码聚合访问与会员发放；后台注册和有效联系由转化事实读模型覆盖。 |
| `analytics_daily_pages` | `[部分实现]` | 按日期、route、path 和业务实体聚合页面表现。 |
| `analytics_daily_events` | `[部分实现]` | 按日期、事件名和实体聚合关键事件计数。 |
| `analytics_path_edges` | `[部分实现]` | 按日期聚合 `from_route -> to_route` 路径边。 |
| `analytics_invite_daily` | `[部分实现]` | 按日期和邀请码聚合落地、注册、联系和会员发放。 |
| `analytics_click_daily` | `[部分实现]` | 按日期、元素和目标聚合 raw/effective/duplicate 点击。 |
| `analytics_export_jobs` | `[当前实现]` | Owner-only CSV 导出任务元数据，导出文件写入 R2 并设置过期时间。 |

### 转化账本与归因中心表 `[当前实现]`

归因只在 API Worker 内运行。`attribution_conversion_facts` 是唯一站内事实源，Browser Pixel 与 Server API 只是投递渠道；不存在独立归因 Worker、双写桥、运行时所有权、cutover、候选版本、rollout、revision、lease 或 commit 绑定。

后台归因 UI 使用 `总览 / 平台连接 / 事件绑定 / 投递质量 / 连接诊断 / 审计日志`。平台选择通过 URL `provider` 显式传递，API 不提供隐式默认平台。连接公开配置、事件映射、通道开关和加密凭证在一个事务中保存；凭证明文不回显。连接测试是同步、幂等的即时诊断，不创建验证任务，也不改变生产配置。

#### 归因事实所有权 `[当前实现]`

| 事实 | 唯一所有者与命名入口 | 可信触发 | 派生与投递关系 |
|------|------|------|------|
| `Contact` | API conversion service 的 `recordContact()` | URL 通过安全校验后发起原生联系跳转，由公开联系命令进入服务端校验 | 写入 `contact` 事实；不派生 `Lead`。只有服务端签名来源命中的单一平台可生成同平台 Browser / Server delivery。二维码展开、复制和无效 URL 不创建 Contact。 |
| `CompleteRegistration` | 注册 API 在用户、邀请码和 session 事务成功后调用 `recordRegistration()`；事实修复只允许 `recordRegistrationFactOnly()` | 服务端已持久化的正整数 `userId`，客户端不能声明事件类型或注册成功 | 写入 `complete_registration` 事实并以 `userId` 去重；注册响应可携带 Pixel 指令，浏览器只能执行指令，不能通过公开 conversion API 创建注册事实。 |
| QR 展开 | Web `ContactPanel` 通过 `useAnalytics()` 记录 `contact_qr_expand`，由 analytics ingest 所有 | 用户展开通过安全 URL 校验的二维码 | 仅是一方行为分析事件；不创建 Contact、不进入 conversion 账本，也不生成广告平台 delivery。 |

归因 API 的活动 `totals`、趋势、风险空态和比率只使用 Contact / CompleteRegistration。`Lead`、`StartTrial` 和会员发放不属于当前广告转化事实。

| 表 | 状态 | 用途 |
|------|------|------|
| `attribution_conversion_facts` | `[当前实现]` | Contact / CompleteRegistration 唯一事实源；记录唯一 provider、可信来源和分析维度。 |
| `attribution_deliveries` | `[当前实现]` | Browser/Server 投递账本；记录 provider、event ID、状态、错误和重试。 |
| `attribution_outbox` | `[当前实现]` | 按 provider 隔离的加密临时匹配上下文；发送成功或安全终止后删除。 |
| `attribution_platform_connections` | `[当前实现]` | 平台公开配置、Browser/Server 开关和稳定 Outbox scope。 |
| `attribution_event_bindings` | `[当前实现]` | 标准事件到 Browser/Server destination 的映射。 |
| `attribution_credentials` | `[当前实现]` | 通用主密钥加密的平台 Token 或 Service Account；每个连接只保留一份当前凭证。 |
| `attribution_provider_receipts` | `[当前实现]` | 平台响应和质量诊断证据，不保存明文凭证。 |
| `attribution_incidents` | `[当前实现]` | 平台运行故障与降级记录。 |
| `attribution_quality_snapshots` | `[当前实现]` | 匹配覆盖与平台质量指标。 |

实现约束：

- `0051_unified_attribution_expand.sql` 建立统一归因表；`0052_unified_attribution_contract.sql` 迁移仍有价值的 Meta 质量历史；`0060_attribution_control_plane_cleanup.sql` 删除旧控制面；`0061_attribution_source_router_cleanup.sql` 物理删除 consent、region、rollout、mode、revision 和冗余 provider 字段；`0062_attribution_runtime_garbage_cleanup.sql` 删除旧连接质量快照和空的 usage 表；`0063_attribution_tracking_source_contract.sql` 删除推广来源的旧 proof 列；`0065_analytics_conversion_truth.sql` 清除行为分析历史上重复累加的联系与注册计数；`0066_contact_fact_analytics_cleanup.sql` 删除旧 Contact 行为副本和派生聚合，并禁止再次写入。最终结构保留有效连接、最新加密凭证、事实、Delivery、Outbox、平台回执、事故、当前质量数据和全部推广来源。
- `0055_attribution_tracking_integrity.sql` 是历史升级步骤，曾使用 `contact_method_click` 重建有效联系；其运行时口径已由 `0065`、`0066` 完全取代。当前只接受数据库中启用且唯一的受管 `mg_source` 建立平台来源，普通 UTM 和自然流量不做推测性回填。
- `0056_attribution_fact_source_integrity.sql` 从活跃事实源清除旧版仅凭 UTM 推测出的平台归因及其 Delivery/Receipt/Outbox，并在 D1 层强制事实来源组合：无平台事实只能使用 `none/conflict`，Meta/TikTok/Google 平台事实只能使用 `click_id/managed_link`。migration 前 production D1 备份与 Time Travel 保留原始审计证据。
- `0057_contact_aggregate_integrity.sql` 是历史升级步骤，曾从旧 Contact 点击事件重建联系日报；`0066` 已删除这些副本。当前后台联系趋势、点击、来源、邀请、Session 和 CSV 全部读取 `attribution_conversion_facts`。
- 历史 migration 只负责升级路径和空库顺序建库，应用运行时不得访问后续 migration 已删除的结构。
- 新增平台必须通过 adapter registry 接入，不得复制业务事实、来源路由、Planner、Queue 状态机或恢复逻辑。
- TikTok Events API 使用官方 v1.3 Web Events endpoint、`Access-Token` header、`event_source=web`、Pixel ID、`event/event_time/event_id/user/page` 契约；生产 payload 不带 `test_event_code`。Browser Pixel 与 Events API 对同一业务事实使用相同 event name 与 event ID 进行去重。
- Google Data Manager `events:ingest` 的 `events[].transactionId` 与 Browser `transaction_id` 共用同一外部事件编号。HTTP 2xx 必须返回安全 `requestId` 才进入 `accepted`；Cron 再通过 `requestStatus.retrieve` 收口为 `processed` 或 `rejected`。Google 请求体要求的 Consent 字段属于平台适配器协议，不是项目自建授权状态。
- API 只返回 provider-aware `trackingInstructions`，前端通过广告平台 adapter registry 执行，不保留 `pixelEvents` 兼容响应。
- 广告来源解析优先级固定为 `fbclid > ttclid > gclid/gbraid/wbraid > 后台受管投放链接 > 最近一次有效来源`。优先级只描述信号类别；同一次请求同时出现多个平台信号时直接 `conflict`。
- `PUT /api/ad-attribution` 签发 30 天 `HttpOnly` 加密来源上下文。普通 UTM、referrer、前端 `provider` 或其他 body 字段不能决定平台；Contact、注册和 Pixel 初始化共用同一服务端路由器。当前请求中有效的官方 click ID 或 active 受管 `mg_source` 覆盖历史 Cookie，没有新来源时才继承 Cookie；Cookie 缺失时可按站内已归一化的 active `mg_source` 恢复。无效的可选参数不能关闭另一个已验证来源，只有同时命中多个有效平台才进入 `conflict`。
- 浏览器 adapter registry 同一时刻只允许一个 active provider。SPA 解析结果改变平台或变为空时整页刷新，避免旧平台脚本残留；自然流量且没有历史来源时不加载营销 Pixel。
- 一个 `attribution_conversion_facts` 最多属于一个广告平台。每个平台只读取自身连接、凭证、Queue 和 receipt；空来源事实不进入任何广告平台。禁止 fan-out、广播或按启用平台枚举投递。
- 正式活动事件严格限定为 `Contact`、`CompleteRegistration`；sender 与 recovery 不接受 `Lead` 或 `StartTrial`。
- `/api/conversions/events` 为公开联系命令入口，仅允许提交 `contact`；完成注册由注册 API 的服务端事务创建。`lead`、`complete_registration`、`start_trial` 和 `membership_grant` 的公开提交均返回明确 4xx。
- 公开转化入口复用应用内兜底限流，并在服务端白名单清洗 metadata；请求不得携带邮箱、手机号、联系方式明文、token、私有 R2 key、完整敏感 URL 或任意广告账户密钥。
- 当前归因运行时不包含地区判断、营销授权页面、Banner、Consent Cookie、授权 API 或地区策略表。若后续需要合规控制，只能在来源路由之后接入单一 `allow/deny` 输入，不得在平台 adapter 内复制地区逻辑。
- 首屏 SSR 通过唯一 `PUT /api/ad-attribution` 同时取得可信来源、当前平台公开配置与 Browser 事件目标，并在客户端页面可交互前初始化唯一平台队列；响应不返回 Server destination 或凭证。Contact 外链点击在浏览器同步事件阶段生成严格格式的 `external_event_id`，先写入当前 active provider 的 Pixel 队列，再通过 `keepalive` 请求交给同一个公开 Contact 命令入口；API 独占来源判定、事实去重、Planner、后台指标投影和 Server 投递，不存在第二条分析事实或响应后 Browser 补发路径。
- 每个平台的 Browser / Server delivery 使用同一 `external_event_id`。Server delivery 只有在平台响应满足严格成功契约时才进入 `accepted`；Google 还必须等待异步诊断进入 `processed`。平台接收或处理完成仍不代表广告归因成功。
- 仅在存在可信签名来源上下文或服务端已通过同一来源路由器恢复来源时，从 Cloudflare `CF-Connecting-IP` 与原始 `User-Agent` 读取完整网络匹配上下文；两者只能进入 24 小时加密 Outbox。原始 IP/UA 不得进入事实表、分析维度、日志、响应或审计。
- `/api/admin/attribution/*` 需要 admin+；连接、凭证和事件映射修改需要 owner，并写入 `admin_audit_logs`。
- Meta/TikTok/Google Server API 仅在 production 通过各自 `AD_META_QUEUE`、`AD_TIKTOK_QUEUE`、`AD_GOOGLE_QUEUE` 异步投递；主 Queue/DLQ 固定为 6 条 `meigallery-ad-*` 资源。dev/local 不绑定广告 Queue、不配置平台凭证、不调用真实平台 API。
- 三个平台共享通用 Planner、加密 Outbox、D1 CAS 和恢复算法，但物理 Queue、destination、稳定 Outbox scope 与凭证加密上下文独立；所有读写必须限定唯一 provider，禁止交叉解密、投递、恢复或 fan-out。
- 平台 Token/OAuth 凭证由 Owner 通过统一后台写入 D1 加密凭证库；Worker secret 只保存 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT/PREVIOUS`。凭证明文不返回前端、不写审计或日志。
- Meta/TikTok Test Event Code 是单次连接测试参数，不属于长期凭据；代码不落 D1、不进入审计和响应，正式事件禁止携带测试码。
- Queue 发送失败不得阻塞站内转化账本写入；delivery 使用 `planned`、`queued`、`retrying`、`accepted`、`processed`、`rejected`、`dead_letter`、`cancelled` 状态，并用 `last_error_code` 区分缺失 Queue、凭证、过期或平台拒绝。
- Queue consumer 使用状态与 attempt count 的 D1 CAS；CAS loser 不请求外部平台，重试复用原 event ID，`accepted/processed` 不可回归。
- 平台质量必须按真实证据展示：Meta 由 Dataset Quality collector 自动采集；TikTok 在没有项目可安全调用的质量 API 时明确要求 Events Manager 人工证据；Google 使用 `requestStatus.retrieve` 结果写入处理质量。无数据或不支持不得显示为 0 分。

### 生产发布约束

- CI 对完整代码执行一次测试、类型检查和构建。生产发布不重复全量 CI，只验证受影响 Worker、执行必要 migration、部署并做生产 smoke。
- API 与 Web 可以独立发布，二者 commit 不要求相同；普通功能提交不会改变归因连接、凭证或事件映射。
- production 存在待执行 migration 时必须先创建 D1 export；失败时 migration 整体回滚。删除列或表的 contract migration 必须在运行时代码停止依赖后使用独立发布执行。
- 精简功能禁止发布关闭所有 Pixel 的中间版本。生产 smoke 检查最终归因表结构、连接配置完整、三平台测试链接只请求来源平台；dead letter、过期 Outbox、质量告警和 incident 进入诊断告警，不阻止紧急修复发布。
- 连接测试只验证当前配置和平台响应，不修改通道开关，不创建长期状态，不与 Git commit 绑定。

成本与索引口径：

- 默认后台 7/30/90 天报表读取日报聚合表和摘要表，禁止首页看板直接扫描 `analytics_events`。
- 后台总览、来源、页面、点击、时长和邀请 6 个接口已用 100,000 事件规模 fixture 验证 30 天范围 P95 <= 1 秒，且默认查询不扫描 `analytics_events`。
- 公开采集写入按批次归并 visitor、session、session summary、page summary 和 click daily，避免同一批内每个事件重复写多张摘要表；10,000 sessions/day、平均 3 PV/session、2 clicks/session fixture 要求 D1 rows written <= 80,000/day。
- Cron 每天按运营自然日重建昨天和当天的来源、页面、事件、路径、邀请和点击聚合；聚合任务使用删除指定日期旧数据再插入的幂等口径。
- 公开采集接口单批最多 20 个事件，payload 上限 16KB，并叠加 IP、visitor、session 三维应用内兜底限流。
- Web SDK 队列最多保留 50 条事件，达到 20 条、10 秒定时、路由切换、`visibilitychange=hidden` 或 `pagehide` 时 flush；`pagehide` 优先使用 `sendBeacon`，失败事件保存在 localStorage 下次重试。
- Web SDK 的 15 秒 heartbeat 只累计有效浏览时长，不单独发网络请求；站内分析只受统一 `analytics_enabled` 开关和原始事件采样率控制，不包含自建 consent 状态。
- `analytics_events` 只保留事件名、session 和实体三类必要组合索引：`(event_name, occurred_at)`、`(session_id, occurred_at)`、`(entity_type, entity_id, occurred_at)`。
- 日报聚合表均以 `date` 加主要维度建立唯一索引，供 Cron 聚合任务幂等 upsert。
- 不给 `event_props` 任意 JSON 字段建索引，避免高基数属性导致写放大和存储成本失控。
- `site_settings` 保留 `analytics_enabled=false`、`analytics_sample_rate=0.01`；前端 SDK 默认保持关闭态，需由 Owner 按上线顺序显式开启。
- 回滚优先关闭 `analytics_enabled`：新页面不会初始化 SDK，API 接收旧页面缓存事件时返回 disabled 且不写 D1；如果需要回滚 Web Worker，API 仍保留采集接口兼容旧缓存页面发送的批量事件和 session end 简写 payload。

### home_ads

```sql
CREATE TABLE home_ads (
  id TEXT PRIMARY KEY,
  placement TEXT NOT NULL DEFAULT 'home_after_hero',
  eyebrow TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT '查看详情',
  target_url TEXT NOT NULL DEFAULT '/discover?sort=hot',
  sponsor TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT NOT NULL DEFAULT '',
  ends_at TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

首页广告位当前仅支持 `home_after_hero` 位置。公开读取会过滤停用、排期无效、标题异常或跳转链接不安全的广告；广告大图仅允许 `/api/media/public/home-ads/` 或安全 `https://` 图片地址。后台上传的大图存储在 R2 `home-ads/{adId}/{imageId}.{ext}`，删除前必须校验 key 属于当前广告。

### contact_methods

```sql
CREATE TABLE contact_methods (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  qr_image_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### cases / case_images

```sql
CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft/published
  featured INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE case_images (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt_text TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### legacy_import_sources

```sql
CREATE TABLE legacy_import_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rest_api', -- rest_api/xml
  category_mapping TEXT, -- JSON: {wp_cat_id: tag_id}
  tag_mapping TEXT, -- JSON: {wp_tag_id: tag_id}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### legacy_import_items

```sql
CREATE TABLE legacy_import_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES legacy_import_sources(id),
  job_id TEXT REFERENCES import_jobs(id),
  legacy_post_id INTEGER NOT NULL,
  legacy_url TEXT NOT NULL,
  legacy_title TEXT,
  gallery_id TEXT REFERENCES galleries(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending/imported/failed
  review_status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected
  review_flags TEXT, -- JSON: ["sensitive_word", "missing_media", ...]
  source_snapshot_json TEXT, -- 私有 JSON，最大 512 KiB
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  error_code TEXT, -- failed 条目必填
  error_message TEXT, -- failed 条目必填，安全摘要
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_legacy_items_source ON legacy_import_items(source_id);
CREATE INDEX idx_legacy_items_review ON legacy_import_items(review_status);
```

### legacy_url_redirects

```sql
CREATE TABLE legacy_url_redirects (
  old_path TEXT PRIMARY KEY,
  new_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 9. ZIP 批量导入流程 `[开发实现，待统一验证]`

### 当前源码范围

`ADM-PER-04` 已实现完整的服务端 ZIP 导入链路；当前阶段只完成开发，不代表环境已启用。`0101_zip_import_packages.sql`、Queue binding、Cloudflare Stream 配置、构建、测试和环境 QA 统一后置。

```text
创建任务 queued
  → 初始化 multipart uploading
  → 8 MiB 分片上传与服务端 ETag 持久化
  → R2 合并并锁定不可变原包 queued
  → ZIP 校验 validating
  → Queue 逐项处理 processing
  → 汇总 finalizing
  → completed / partial_failure / paused
```

1. `POST /api/admin/import-jobs` 创建 `type=zip` 的任务并写审计。
2. `POST .../package/init` 生成随机 R2 key 和一次性 upload session；真实 R2 `uploadId` 仅保存在 D1，不返回浏览器。
3. 浏览器把文件切成 8 MiB 分片，经同源 Web 代理和 API Worker 流式写入 R2。每片实际字节数由 `TransformStream` 计数，ETag 与大小写入 `import_job_upload_parts`；分片重传为幂等覆盖。
4. `POST .../package/complete` 只使用服务端保存的 ETag 清单合并对象，核对连续序号、单片大小、总大小和 R2 对象大小后清空 multipart 会话。256 MiB 应用上限不依赖 Free/Pro 100 MB 或 Business 200 MB 的单请求上限。
5. `POST .../process` 读取 ZIP EOCD 与中央目录，仅按 R2 range 流式读取条目；压缩输入不整体驻留内存，解压流在超过中央目录声明大小时立即终止，不把事后大小检查当作压缩炸弹防线。
6. 包级拒绝 Zip64、分卷、加密、符号链接、路径穿越、大小写重复路径、不支持压缩方式、异常压缩比和越界偏移。应用边界为 1,024 个 ZIP 条目、200 个 manifest 行、512 MiB 解压总量、1 MiB 文本、10 MiB 图片、48 MiB 其他媒体。
7. `manifest.csv` 必须精确包含 `folder,title,slug,region,personality,style,tags,required_level,status`；逐项目录必须包含 `content.md`、`cover.jpg` 和至少一张 `images/` 图片，可选 `videos/preview.mp4`、`videos/full.mp4`。
8. 图片校验扩展名、魔数、容器结束、尺寸和像素量，并从提取后的 JPEG/PNG/WebP 中剥离 EXIF、定位、作者、文本、ICC/XMP 等元数据；私有 ZIP 原包继续作为受控证据快照。
9. Queue 每次领取一个 `pending` 项。图片写入私有 R2；视频仅在 Stream 配置完整时上传并强制 signed URL，否则该项以 retryable 错误收敛。
10. Gallery、媒体、标签关联、项目完成标记和 `gallery.create` 审计使用同一个 D1 batch。未知标签先按 `type + name` 复用，否则生成稳定纯 ASCII slug，并条件写 `create_tag` 审计。
11. Admin 导入永远强制 Gallery 为 `draft`；仅 Owner 可遵守 manifest 的 `published`。单项失败不回滚其他成功项，最多自动尝试 3 次；可恢复失败支持手动 retry，运行时故障转为 paused 后 resume。
12. 汇总生成 `imports/{jobId}/errors.csv`，包含 folder、stage、retryable、错误码、说明和修复建议，并对表格公式前缀做文本化处理；下载始终经鉴权 Worker 代理，不返回私有 R2 key。

### Gallery 与 Person 的边界

ZIP schema 是 Gallery 内容包，不包含真人主体所需的授权来源、身份校验、认证版本与独立发布证据。因此导入成功只创建 Gallery 和媒体，不自动创建 Person/Profile，也绝不直接进入公开推荐。若要把某个 Gallery 用作真人候选来源，管理员必须在独立的人物来源/授权/认证工作流中显式选择并完成双重发布门禁。

### 状态与恢复

- 任务状态：`queued → uploading → queued → validating → processing → finalizing → completed|partial_failure`；可恢复故障进入 `paused`。
- 项目状态：`pending → processing → completed|failed`，阶段为 `preflight → content → media → commit → completed`。
- upload session 防止旧页面与新页面的分片混入同一 multipart；新会话会中止旧 multipart，未完成 multipart 仍受 R2 默认生命周期兜底。
- 暂停迁移必须同时匹配预期状态，并按场景匹配执行轮次或 upload session；过期执行器不能把新会话、终态或后续轮次覆盖为 paused，暂停审计只在条件更新真实生效后写入。
- 成功项目永不因失败项重试而重复创建；替换原包仅允许尚无成功项目的 queued、uploading 或 paused 任务。
- `validating|processing|finalizing` 的同时运行任务最多 3 个，状态认领 SQL 内再次检查上限，避免仅在创建时检查造成竞态。

### Telegram 外部导入 `[当前实现]`

- Telegram 文件 ID 导入使用 `/api/imports/telegram-file-id`，请求必须携带有效 Import Token。
- 导入类型仅允许 `gallery` 和 `case`，真实案例使用 `case`。
- Import Token 权限使用 `gallery:create` 和 `case:create`，真实案例不再使用旧权限名。
- 当前项目不内置 Telegram Bot；外部 Bot / Ops Hub 负责监听 Telegram 和提交结构化 JSON，平台只提供接收、拉取、入库、状态查询和重试能力。
- Ops Hub 自动导入中的 `#gallery`、`#case`、`标题`、`slug`、`标签`、`等级` 是上游 caption 解析约定；MeiGallery API 不解析 caption，只校验标准化 JSON。
- 同一 `token + source + externalMessageId` 重复提交返回 `duplicate`，不创建第二个草稿；Ops Hub 需要继续查询原 `importId`。
- 接收记录、全部文件行与 accepted 审计通过单个 D1 `batch` 原子写入；每日 token 限额也在 INSERT 条件内复核，唯一键并发冲突重新读取既有记录，不能并发超额或留下只有主记录/缺文件行的半成品。
- JSON 请求体按 64 KiB 有界流读取；payload 从 `unknown` 逐字段验证并只构造白名单 DTO。超限/无效 JSON、错误运行时类型、空白必填值、长度越界、重复封面与规范化后重复标签不得变成 500 或进入 metadata 快照。
- `sourceBotKey` 对应 API Worker secret，命名规则为 `TELEGRAM_BOT_TOKEN_${sourceBotKey.toUpperCase()}`，例如 `ops_gallery_bot` 对应 `TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT`。
- 异步处理只使用专用 `TELEGRAM_IMPORT_QUEUE`；HTTP 请求不再用 `waitUntil` 承担媒体抓取。Queue 消息携带一次性 processing token，pending 派发、failed 清理和 fetching 处理均持有可过期的 30 分钟租约；处理中在每次远端读取、R2 写入和 D1 状态推进前后续租。fetching 租约仍有效时的重复投递只请求 Queue 延迟重试，不并行抓取；租约为空或过期后才可通过条件更新接管。
- 每个文件在远端抓取前先持久化本次尝试的目标文件 ID 与确定性 R2 key；同一 Queue 消息重投时复用该 key，避免“R2 已写入、D1 未落账”形成不可定位孤儿。
- Gallery/媒体/标签关系或 Case/图片使用 D1 batch 原子创建；目标 batch 已成功但导入终态响应中断时，重投以同一 `processing_target_id` 幂等完成收敛。缺失标签先按类型/规范化名称复用，新增项使用稳定 ASCII 摘要 slug，条件创建与审计同批提交并在竞争后重新读取权威标签 ID。
- Telegram `getFile` 与文件下载均为 60 秒超时、有界流读取；实际图片必须通过 JPEG/PNG/WebP 魔数、容器、尺寸和像素边界校验并剥离元数据，且必须与 payload 声明 MIME 一致。
- Bot 侧可调用 `/api/imports/:importId/retry` 重试失败记录；后台详情页也可调用 `/api/admin/external-import-records/:id/retry` 手动重试。重试会先按持久化 key/处理中目标再次清理，只有 R2 与 D1 均清理成功才回到 pending。
- `pending_media_fetch` 没有有效派发租约，或 `fetching_media` 的租约为空/已过期时，Bot/后台可调用对应 `recover-stale`；有效租约必须返回 409。远端异常后的旧执行器在清理/失败落账前必须重新证明 token 所有权，不能覆盖新尝试。
- 对外状态和后台错误摘要只保存稳定 code 与用户安全说明；D1、R2、Telegram SDK/网络异常原文、Bot Token、下载 URL 和私有 R2 key 不得进入响应、文件错误、审计 afterValue 或结构化日志。
- 升级前历史 `error_json/error_message` 读取时也必须经过固定 code/message 白名单；未知历史文本降为通用错误，不因数据库已有旧值继续泄漏。
- `case` 导入写入 `cases` / `case_images`，R2 key 使用 `cases/{caseId}/{imageId}.{ext}`。
- `0118_external_import_queue_integrity.sql` 仅增加兼容列与租约索引，发布顺序必须是 `0118 → 新运行时 → TELEGRAM_IMPORT_QUEUE 配置/启用`；当前按统一开发要求只完成源码和 migration 文件，不执行 migration 或 Queue 配置。
- 详细对接契约见 `docs/TELEGRAM_IMPORT_API.md`。

## 10. WordPress 迁移流程 `[开发实现，待统一验证 / 历史参考 / 后续规划]`

旧站 `zuole.me` 当前可通过 WordPress REST API 获取公开数据。

### 迁移步骤 `[开发实现，待统一验证 / 后续规划]`

1. 创建来源：记录旧站 base URL、导入模式、分类映射、标签映射。
2. 拉取元数据：读取文章总数、分类、标签、sitemap。
3. 拉取文章：分页读取 `/wp-json/wp/v2/posts`（当前每页 50 条，最多 100 页）。
4. 解析正文：从 HTML 中提取图片、视频、正文段落。
5. 媒体入库：图片以安全外部 URL 进入 pending，后续有界下载到 R2；视频只保留待处理元数据，Stream 接入后再上传。
6. 标签映射：分类转地区标签，post_tag 转身份、风格、场景等标签。
7. 风险标记：发现敏感词、年龄风险、授权未知、媒体失败时进入待审核。
8. 草稿生成：创建图库草稿并记录旧 URL。
9. SEO 映射：生成旧 URL → 新图库 URL 的 redirect 记录。

### 正文解析要求 `[开发实现，待统一验证]`

- 支持 WordPress block HTML（`<figure class="wp-block-image">`、`<figure class="wp-block-video">`）。
- `0116` 以不超过 512 KiB 的 `source_snapshot_json` 私有保存原始 HTML、旧分类/标签 ID 与媒体描述，用于单条审核；列表接口不返回该快照。
- `galleries.body_md` 只保存清洗后的文本说明，不保留源站图片/视频 Markdown，防止绕过 R2/Stream 访问控制。
- `<img>` 提取为 `media_assets`（type=image）。
- `<video>` 提取为 `media_assets`（type=video）。

### 运行完整性 `[开发实现，待统一验证]`

- 后台任务页使用专用 `GET /api/admin/legacy-import/jobs`，不再复用 ZIP 导入列表；任务和条目按 Owner 全部、Admin 本人边界读取与操作。
- 同一来源最多一个 processing 任务；已迁移内容同时按 `source_id + legacy_post_id` 和 Gallery slug 去重。
- legacy 执行使用 30 分钟 D1 权威租约和不可猜测 token；WordPress 文章/分类/标签每页通过完整性校验后同步续租，逐篇落库每 10 条续租，完成与失败状态都以当前 token 条件收敛。`recover-stale` 只回收已过期或历史缺失租约的 processing 任务并要求创建新任务安全重试，不能抢占有效执行。
- 来源显式分类/标签映射解析到既有权威 `tags.id`；损坏 JSON、缺失目标标签、分类/标签接口失败、异常响应或分页超过安全上限都 fail closed，不产生无标签的伪成功。
- WordPress JSON 采用 16 MiB 流式有界读取；即使 Content-Length 缺失或不可信，也会在实际越界时取消上游响应。
- 每个 WordPress REST 请求携带 60 秒截止信号；超时中止上游读取并进入带安全错误的任务失败收敛，不允许请求无限占用 processing 租约。
- 单篇 Gallery、标签、媒体、legacy 条目、redirect 和最小审计在同一 D1 batch 中提交；任一语句失败整篇回滚，再以独立原子 batch 持久化 `failed` 条目、结构化错误、安全失败快照和最小审计后继续。失败事实无法提交时任务整体失败，不返回无法追溯的部分成功。
- 媒体 INSERT 按每条 14 行/98 个绑定参数分块，遵守 D1 每条查询最多 100 个绑定参数的当前限制。
- 任务级和全局媒体入口、状态、失败重置、封面设置都限定到 legacy 任务关联 Gallery，不能误处理 ZIP 或手工上传内容。
- 远程图片限制为 10 MiB 和单请求 60 秒，只接受通过魔数、容器、尺寸/像素检查的 JPEG/PNG/WebP，并在写 R2 前剥离元数据；Content-Type 不作为可信格式依据。媒体状态变化与最小审计同批提交，网络、R2 与 Stream 原始异常不进入 HTTP 响应或审计。
- `0116_legacy_import_operational_integrity.sql` 增加来源快照、结构化审核/失败证据、兼容回填、查询索引、终态完整性、不可改写触发器和 legacy 租约列；`0117_legacy_import_processing_lease_guards.sql` 在兼容代码发布后约束 processing 与租约字段一致。两者尚未执行，部署顺序固定为 `0116 → 兼容代码 → 0117`。
- 完整开发边界见 `docs/app/LEGACY_IMPORT_2_OPERATIONAL_INTEGRITY.md`。

### 审核机制 `[开发实现，待统一验证 / 后续规划]`

触发待审核的条件：
- 标题或正文包含敏感词（需维护敏感词列表）。
- 旧站分类名暗示年龄/服务/交易风险。
- 媒体 URL 下载失败。
- 授权来源不明确。

当前审核操作形成通过/拒绝不可改写终态，保存审核人、时间、备注和追加审计，但不会直接发布 Gallery。修改标签、标题、删除敏感文案与最终发布继续使用独立 Gallery 管理流程。XML 上传/解析仍为后续规划；REST API 是当前唯一可执行旧站来源模式。

## 11. 缓存策略 `[当前实现 / 后续规划]`

| 资源类型 | 缓存策略 | TTL |
|----------|----------|-----|
| 前台静态资源 | Workers Assets 自动缓存 | 长期（hash 文件名） |
| 公开站点设置 | 生产短缓存，后台强制刷新使用 cache-busting query | 60 秒，stale-while-revalidate 300 秒 |
| 首页和列表页数据 | 短缓存，发布后失效 | 60 秒 |
| 标签列表 | 短缓存 | 300 秒 |
| 公开缩略图 | R2 公开访问 + CDN 缓存 | 7 天（文件名含 hash） |
| 受保护图片 | Worker 代理返回，用户端私有短缓存 | 600 秒 |
| 受保护视频 | Stream 接入后返回 signed token；未配置 Stream secrets 时返回 `STREAM_NOT_CONFIGURED` | 4 小时 |

## 12. 已实现功能补充 `[当前实现]`

- **图库创建两步流程**：第一步填写基本信息（标题、slug、描述、标签、等级），第二步上传媒体文件（封面、图片、视频）。
- **站点设置扩展**：新增 SEO/OG/页脚字段（`site_description`、`site_icon`、`og_title`、`og_description`、`og_image`、`footer_text`），通过 migration 0009 添加；`seo_keywords` 通过 migration 0030 添加，并由 migration 0031 在空值时写入首版关键词池，用于后台关键词池和前台 JSON-LD `keywords` 输出。
- **无限滚动**：首页和发现页使用 IntersectionObserver 实现无限滚动加载。
- **浏览量统计**：galleries 表新增 `view_count` 字段（migration 0008），使用 `waitUntil` 异步增量更新，不阻塞请求。
- **图库互动**：galleries 表新增 `like_count`，`gallery_likes` 记录用户点赞关系（migration 0013）。
- **真实案例命名**：当前使用 `cases` / `case_images`、公开路由 `/cases`、后台路由 `/admin/cases`，旧 `testimonial_*` 命名已通过 migration 0017 清理。
- **Telegram 外部导入**：当前导入类型为 `gallery` / `case`，权限为 `gallery:create` / `case:create`，不再接受旧 `testimonial_case`。
- **External Import-2 运行完整性**：`0118` 追加 Queue processing token、30 分钟租约、心跳和处理中目标；主记录/文件行/accepted 审计及每日限额原子接收，payload 只保留逐字段验证后的白名单，专用 Queue 替代 HTTP `waitUntil`。pending/failed/fetching 租约、确定性 R2 key、稳定标签 slug 与旧执行器所有权复核支持安全重投恢复；远端请求使用 60 秒超时、有界图片验证和安全错误码。Queue 配置、migration、构建与专项验证后置。
- **Ops Hub 自动导入对接**：MeiGallery 只接收 Ops Hub 已解析好的 JSON payload；caption 触发、slug 缺省生成、图片排序和类型选择由 Ops Hub 保证，平台侧通过 Import Token、`sourceBotKey`、payload 校验和幂等约束兜底。
- **生产域名**：Web 站点 `616618.xyz`，API 服务 `api.616618.xyz`。
- **Dev 环境 Worker**：当前配置为 `meigallery-web-dev` / `meigallery-api-dev`，仅使用 Workers dev 子域，不绑定生产域名。
- **Interaction-2/4 跨仓开发基线**：能力引入于 App API v2 `1.11.0`；累计 `1.21.0` 已补齐收藏夹四图预览、搜索/地区/风格筛选、20 字名称上限和删除保留默认收藏语义。KMP 已按 Figma `APP-INT-03/04/05/06` 完成收藏夹、人物归属、浏览记录与成功详情记录闭环；Interaction-4 又补齐批准后有界到期清理，能力关闭不撤销既有删除义务。无 API、KMP 或 Figma 增量；配置、migration、构建、专项测试、模拟器/真机、`android-cli` 截图与远端联调后置。
- **Interaction-3 跨仓开发基线**：App API v2 `1.12.0` 已完成关注后公开发布更新流、独立 capability、惰性去重站内通知和投递前资格复核；KMP 已按 Figma 接入“全部 / 有更新 / 最近关注”筛选、取消关注回收与通知目标跳转，喜欢由独立 `APP-INT-02` 承载。配置、migration、专项测试、模拟器/真机与远端联调后置，所有环境继续默认关闭。
- **Search-1 跨仓开发基线**：App API v2 `1.13.0` 已完成 POST 人物搜索、公开字段/屏蔽边界、账号绑定游标和默认关闭、版本化清除的私有搜索历史；KMP 已完成严格 transport、搜索分页和账号历史全交互，配置、migration、专项测试、模拟器/真机与远端联调后置。
- **Taxonomy-1 跨仓开发基线**：App API v2 `1.14.0` 已完成稳定词条、不可变目录、合并重定向、legacy 待复核映射、公共 ETag 目录、人物内容版本关联和发布投影；KMP 已完成 Recommendation/Search 共用目录、缓存和 ETag 重验证；Nuxt 已完成 `ADM-TAX-01/02/03` 目录、词条和发布工作区，并在 `ADM-PER-03` 接通稳定分类标注。真实目录、配置、migration、专项测试、模拟器/真机与远端联调后置。
- **Search-2 跨仓开发基线**：App API v2 `1.15.0` 已完成 taxonomy 分组筛选、父子/合并闭包、会员分层、结果预估和本人保存条件；KMP 已完成筛选、预估、权益、保存条件和完整来源重验交互；Nuxt 已完成只读搜索运营核查、跨目录引用诊断和 entitlement 矩阵。真实目录与 grant 迁移、配置、migration、专项测试、模拟器/真机与远端联调后置。
- **Recommendation-1/2/3/4/5/6 跨仓开发基线**：App API v2 `1.16.0` 已完成版本化推荐、主动 taxonomy 偏好、运营精选固定披露、稳定灰度、计划生效、Dry-run、职责分离、暂停和回滚；Recommendation-2/3/4 在不改变 DTO 的前提下补齐客户端版本、地区作用域、完整依赖与安全回退，Recommendation-5 以 `0113` 补齐默认关闭的目标/反指标策略、聚合评估、不可变自动停止和运行时完整回退，Recommendation-6 再以 `0114` 补齐批准后的有界到期清理、证据不可改写和 Privacy-2B 账号关联零残留删除。KMP 无需解析内部守护或生命周期事实；配置、`0083/0113/0114`、真实来源/阈值/保留决策、专项测试与远端联调后置。
- **Privacy-1/2A/2B/2C 跨仓开发基线**：App API v2 `1.17.0` 已完成二次验证、数据副本/注销申请、请求级状态访问和取消；D1 已建立默认关闭策略、不可变事件、幂等与注销待处理写入阻断；Nuxt 已完成 `ADM-PRI-01/02` 队列和详情，KMP 已完成系统安全凭证与响应式页面。真实制品和不可逆删除分别由 Privacy-2A/2B 承接，Privacy-2C 把当前副本范围补齐到 41 类并兼容旧 35-scope artifact；配置、migration、专项测试与联调后置。
- **Privacy Figma 门禁**：`ADM-PRI-01/02` 已在正式 Figma Section `936:15995` 完成 13 个状态、125 个页面动作和 17 个流程动作，并进入 Delivery Index 与 QA。Privacy-2B 复用现有后台 executor 区；移动端 `APP-SET-10` 没有 completed 正式 Frame，因此完成后必须退出到未登录“我的”。任何完成证明下载、批量处置或新门禁 UI 都必须先取得正式 Figma Node ID。
- **Message-5 数据权利通知基线**：`0109` 已把 Privacy-2A 的导出就绪事实和 Privacy-2B 可恢复取消结果接入 Message-3 可靠 Outbox；不可逆注销期间/完成后的通知继续抑制，KMP 复用已有 `open_data_task` 权威跳转。无新增公共 DTO、Page ID 或 Figma 状态，migration、模板审批、配置与验证后置。
- **Message-7 导出失败通知基线**：`0110` 新增 `data.export_failed` 必要事件与固定模板；Privacy-2A 失败批次改为申请、制品、任务先收敛，再插入用户可见失败事件并由 trigger 写 Outbox。内部 failure code、R2 引用和查询细节不进入通知；无公共 DTO、Page ID 或 Figma 状态增量，migration、模板审批、配置与验证后置。
- **Message-8 文本审核基线**：`0112` 以默认关闭策略把既有消息四态接到无正文评估、人工复核租约和审核结果/会话限制通知。正常会话查询只读取 accepted/recalled，发送者仍可看本人待审/拒绝状态；没有正式 Figma 的后台审核工作台和召回动作均未自行补 UI。无公共 DTO 或状态增量，migration、真实规则、配置与验证后置。
- **Message-9 通知内容生命周期基线**：`0115` 为新投递增加不可变到期边界，并为 explicit/legacy 通知提供批准后有界清理；延迟过期事件不再生成正文，单条已读事件先行清理而 Outbox 去重墓碑保留。无公共 DTO、KMP、Nuxt、Page ID 或 Figma 增量；OQ-020、migration、配置、构建与专项验证后置。
- **Media-1 跨仓开发基线**：App API v2 `1.18.0` 复用现有图库和公开人物投影，完成图片清单、公开/会员取图、5 分钟会话绑定凭证和四项认证说明；KMP 已完成严格二进制校验、仅内存受保护图片、自适应媒体页、认证页和媒体举报。无新增 migration，视频、配置、专项测试、Gradle 与联调后置。

## 13. 测试范围 `[当前实现 / 后续规划]`

### 单元测试（必须覆盖） `[当前实现 / 后续规划]`

- 权限校验：不同 rank 访问不同等级媒体。
- 会员有效期：过期后立即失效。
- ZIP 导入校验：multipart 会话隔离、分片大小/连续性/ETag、EOCD 与中央目录、路径和压缩炸弹边界、CRC、精确 manifest schema、重复 folder/slug、缺失必需文件、图片容器/尺寸/元数据净化、可选 MP4、标签去重与纯 ASCII slug、部分失败、幂等重试和暂停恢复。
- 标签搜索：单标签、多标签组合、空结果。
- 密码哈希与验证。
- Turnstile token 校验：登录、发送验证码、无邮箱验证码注册、后台导入任务创建和处理。
- App 人物供给：未认证不公开、授权/认证版本绑定、四项认证完整性、双重发布门禁、草稿与线上版本隔离、授权/认证到期、撤销/暂停立即下线、`expectedVersion` 并发冲突和审计完整性。
- App 账号访问：能力默认关闭、注册不创建 Person、旧账号需密码验证、当前文档同意、Token 摘要、刷新轮换/重放撤权、会话过期、设备归属、当前设备限制、远程退出幂等和安全事件完整性。

### 上传限制验收 `[当前实现]`

| 入口 | 当前上限 | 格式 | 证据 |
|------|----------|------|------|
| 后台图库图片 | 10MB/张 | JPG/PNG/WebP | `packages/api/src/routes/admin/media.ts`、`packages/web/app/components/admin/MediaUploader.vue` |
| 真实案例图片 | 10MB/张 | JPG/PNG/WebP | `packages/api/src/routes/admin/cases.ts` |
| Telegram 外部导入图片 | 10MB/张 | JPG/PNG/WebP | `packages/api/src/services/telegram-file-fetcher.ts` |
| 用户头像 | 2MB/张 | JPG/PNG/WebP | `packages/api/src/routes/me.ts`、`packages/web/app/pages/settings.vue` |
| 联系方式二维码 | 2MB/张 | PNG/JPEG/WebP | `packages/api/src/routes/admin/contact-methods.ts` |
| 站点图标 | 1MB/张 | PNG/JPEG/WebP/ICO | `packages/api/src/routes/admin/settings.ts` |
| ZIP 导入原包 | 256MiB/包，8MiB/分片 | ZIP（stored/deflate；不支持 Zip64/分卷/加密） | `admin-zip-package.ts`、`admin-zip-import.ts`、`0101_zip_import_packages.sql` |

### 集成测试 `[部分实现 / 后续规划]`

- ZIP 导入流程：创建任务 → R2 multipart → 服务端合并 → range 校验 → Queue 逐项导入 → 部分失败/安全重试 → 错误报告。
- 完整迁移流程：拉取 → 解析 → 入库 → 审核。
- 媒体签名流程：请求 → 校验 → 签发 → 过期。
- 审计日志：admin 写操作后检查日志记录；重点覆盖导入任务处理结果、旧站迁移批量入口、会员发放、媒体变更和站点设置。
- App 人物发布：候选草稿 → 用途授权 → 认证提交/复核 → 发布提交/复核 → 公开 API 可见；编辑线上资料后 App 继续读取旧投影，重新发布后才切换版本。
- App 账号访问：Web 账号密码验证 → 当前同意 → App 设备会话 → Bearer 本人信息 → Token 轮换 → 远程退出/重放撤权；生产配置缺失时 bootstrap 和所有账号命令保持关闭。

### 端到端测试 `[当前实现 / 后续规划]`

- WordPress 迁移：分类映射、标签映射、图片解析、视频解析、媒体下载失败、敏感词触发审核。
- 响应式：移动端、平板端、桌面端关键页面布局。
