# 技术设计文档

## 0. 状态标签说明

本文使用以下状态标签区分当前代码事实、部分实现、后续设计和历史迁移背景：

- `[当前实现]`：仓库已有代码、配置、迁移或测试支撑。
- `[部分实现]`：已有数据结构、入口或辅助能力，但端到端流程仍未完整接入。
- `[后续规划]`：需要单独设计、实现和验收的目标态能力。
- `[历史参考]`：旧站、旧命名或迁移背景，不代表新增功能入口。

## 1. 技术目标 `[当前实现 / 后续规划]`

- 使用 Cloudflare 作为唯一部署和运行平台。
- 前台和后台共用同一套认证、权限、媒体访问控制能力。
- 所有受保护媒体都必须经过服务端授权，前端不持有真实资源地址。
- 批量导入当前实现为任务记录 + 已解析 JSON 数据处理；完整 zip 大文件导入按后续异步任务设计，避免大文件和视频处理阻塞请求。
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

运行时开关：`APP_AUTH_ENABLED`、`APP_AUTH_REGISTRATION_ENABLED`、四类文档版本、对应的 `APP_AUTH_TERMS_URL`、`APP_AUTH_PRIVACY_URL`、`APP_AUTH_PLATFORM_NOTICE_URL`、`APP_AUTH_ELIGIBILITY_URL` 和 `APP_AUTH_TURNSTILE_SITE_KEY`。production 还必须配置 `TURNSTILE_SECRET_KEY`；任一必要条件缺失、文档 URL 非 HTTPS 或 Turnstile Site Key/Secret 只配置一侧时，bootstrap 返回 `auth=false`。production/dev Wrangler 当前均显式保持关闭，不允许据此推断 G-01/G-03 已关闭。

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
- 本人列表以 `created_at DESC, profile_id ASC` 稳定分页，不透明游标绑定账号公开作用域和关系类型。资料已失效时只返回 `profileId`、关系时间和 `PROFILE_NOT_AVAILABLE`，不泄露历史封面、地区、标签或简介。
- bootstrap 只在 Auth 安全配置整体可用时返回 `interactions.like=true` 和 `interactions.follow=true`；`favorite` 与 `history` 继续为 false。production/dev 现有 Auth 开关默认关闭，本实现不改变上线状态。
- 不提供按目标资料查看互动者的产品 API，不创建匹配、会话、目标侧通知、关注更新事件或推荐信号。收藏/收藏夹与历史必须在后续独立冻结，不得由当前关系表替代。

完整跨仓边界与验收要求见 `docs/app/INTERACTION_1_CROSS_REPO_INTEGRATION.md`。

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
| 导入包 | `imports/{jobId}/source.zip` | 私有，后续完整 zip 导入能力使用 |
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
| GET | `/api/v2/discovery/feed` | 只读公开人物投影；推荐/热门/最新、地区筛选和不透明游标 |
| GET | `/api/v2/discovery/regions` | 只统计当前仍具公开资格的人物地区 |
| GET | `/api/v2/person-profiles/:profileId` | 按稳定公开资料 ID 重新校验并返回基础详情 |
| POST | `/api/v2/auth/email-challenges` | 默认关闭：申请注册邮箱验证码，统一响应不披露账号存在性 |
| POST | `/api/v2/auth/register` | 默认关闭：创建观看者账号、当前同意、设备和 App 会话 |
| POST | `/api/v2/auth/login` | 默认关闭：邮箱密码登录与当前同意校验 |
| POST | `/api/v2/auth/refresh` | 默认关闭：旋转 Access/Refresh Token，旧 Refresh 重放撤销会话 |
| POST | `/api/v2/auth/logout` | 默认关闭：撤销当前 App 会话 |
| GET | `/api/v2/me` | 默认关闭：当前账号和会员摘要 |
| GET | `/api/v2/me/devices` | 默认关闭：本人设备列表 |
| DELETE | `/api/v2/me/devices/:deviceId` | 默认关闭：幂等远程退出其他设备 |

App 公开人物查询统一要求：认证有效、发布有效、用途授权已开始且未到期、认证未到期、投影可见、来源图库仍为 `published`。任一条件失败时不得回退读取人物草稿或图库表。

### 外部导入 API `[当前实现]`

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/imports/telegram-file-id` | 接收外部 Bot 提交的 Telegram `file_id` JSON，创建导入记录并异步生成草稿 | Import Token |
| GET | `/api/imports/:importId` | 查询同一 Import Token 创建的导入状态 | Import Token |
| POST | `/api/imports/:importId/retry` | Bot 侧重试 failed 导入 | Import Token |

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
| POST | `/api/admin/app/persons/:personId/authorization` | 为当前内容版本登记 App 公开用途授权 | admin+ |
| POST | `/api/admin/app/persons/:personId/authorization/revoke` | 撤销授权并立即暂停引用它的公开投影 | admin+ |
| POST | `/api/admin/app/persons/:personId/verification/submit` | 提交当前内容版本认证复核 | admin+ |
| POST | `/api/admin/app/persons/:personId/verification/decision` | 记录四项认证通过或退回结论 | admin+ |
| POST | `/api/admin/app/persons/:personId/verification/revoke` | 撤销认证并立即暂停引用它的公开投影 | admin+ |
| POST | `/api/admin/app/persons/:personId/publication/submit` | 全门禁预检后提交发布复核 | admin+ |
| POST | `/api/admin/app/persons/:personId/publication/decision` | 发布时再次校验门禁并单向写公开投影，或退回草稿 | admin+ |
| POST | `/api/admin/app/persons/:personId/publication/pause` | 立即暂停公开投影，保留版本和审批历史 | admin+ |
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
| POST | `/api/admin/import-jobs` | 创建导入任务（需 Turnstile） | admin+ |
| GET | `/api/admin/import-jobs/:id` | 导入任务详情和进度 | admin+ |
| POST | `/api/admin/import-jobs/:id/process` | 处理导入任务（需 Turnstile） | admin+ |
| GET | `/api/admin/audit-logs` | 审计日志 | admin（仅自己）/ owner（全部） |
| GET | `/api/admin/import-api-tokens` | Import Token 列表，不返回 hash 或明文 token | owner |
| POST | `/api/admin/import-api-tokens` | 创建 Import Token，明文 token 仅返回一次 | owner |
| PATCH | `/api/admin/import-api-tokens/:id` | 修改 Import Token 权限、来源白名单、状态或过期时间 | owner |
| DELETE | `/api/admin/import-api-tokens/:id` | 禁用 Import Token | owner |
| GET | `/api/admin/external-import-records` | 外部导入记录列表，支持状态、类型和 sourceBotKey 筛选 | admin+ |
| GET | `/api/admin/external-import-records/:id` | 外部导入详情、文件状态、错误摘要和目标草稿链接 | admin+ |
| POST | `/api/admin/external-import-records/:id/retry` | 后台重试 failed 外部导入，复用原 token 权限和 sourceBotKey 校验 | admin+ |
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
| POST | `/api/admin/legacy-import/jobs` | 启动旧站迁移 | admin+ |
| GET | `/api/admin/legacy-import/jobs/:id` | 迁移任务详情 | admin+ |
| POST | `/api/admin/legacy-import/jobs/:id/execute` | 执行旧站迁移 | admin+ |
| GET | `/api/admin/legacy-import/items` | 迁移条目列表 | admin+ |
| PATCH | `/api/admin/legacy-import/items/:id/review` | 审核迁移条目 | admin+ |
| POST | `/api/admin/legacy-import/download-pending` | 批量下载旧站待处理图片 | admin+ |
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
  status TEXT NOT NULL DEFAULT 'queued', -- queued/processing/completed/failed
  source_key TEXT, -- R2 key
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_report_key TEXT, -- R2 key
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
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

## 9. 批量导入流程 `[部分实现 / 后续规划]`

### 当前实现范围 `[当前实现]`

当前后台导入接口提供任务记录和已解析数据处理能力，不直接接收、保存或解压 zip 文件。

```text
1. 管理员创建导入任务：POST /api/admin/import-jobs
2. API 检查 processing 状态任务数，超过 3 个返回 429
3. API 创建 import_jobs 记录，type = zip，status = queued
4. 管理员或后台工具提交已解析后的 JSON galleries 数据：POST /api/admin/import-jobs/:id/process
5. API 将任务置为 processing
6. API 逐条处理 galleries：
   - 校验 title、slug
   - 校验 slug 唯一性
   - Admin 强制 draft；Owner 可将 manifest 中的 published 写入发布状态
   - 创建 galleries、gallery_tags、media_assets 记录
   - 未存在标签按当前实现自动创建
7. 单个图库失败时记录错误，继续处理下一个
8. 如有失败项，生成 imports/{jobId}/errors.csv 写入 R2
9. 更新 import_jobs 的 success_count、failure_count、total_count、error_report_key 和 completed_at
```

当前辅助解析能力：

- `packages/api/src/utils/import-parser.ts` 可解析 `manifest.csv` 文本。
- 当前解析校验覆盖必填列 `folder`、`title`、`slug`，以及 `slug` 格式、`required_level`、`status`。
- 当前不会在 API 内部解压 zip，也不会在 API 内部校验 zip 目录中的 `content.md`、`cover.jpg` 或图片文件存在性。

### 状态机 `[当前实现]`

```text
queued → processing → completed
                   ↘ failed（全部失败或系统错误）
```

图库级别状态：`pending → success / failed / partial`

### 后续完整 zip 异步流程 `[后续规划]`

完整 zip 导入不是当前上线阻断项。后续实现时，API 不直接承载大文件请求体，应使用 R2 直传和异步处理：

1. 管理员创建导入任务。
2. API 签发 R2 上传入口或等价的受控上传流程。
3. 管理员将 zip 源文件上传到 R2 `imports/{jobId}/source.zip`。
4. API 记录 source key，将任务状态置为 `queued`。
5. 后台异步处理器（Queues、Workflows 或分片任务）处理：
   - 解压 zip，读取 `manifest.csv`。
   - 校验图库数不超过 200。
   - 逐个图库目录校验：`content.md` 存在、`cover.jpg` 存在、至少一张图片。
   - 校验通过后写入图片到 R2；视频在 Stream 接入后上传到 Stream。
   - 创建 gallery 和 media_assets 记录。
   - 处理标签：已存在则关联，不存在且类型合法则自动创建。
   - 状态判定：Admin 强制 `draft`；Owner 可按 manifest 中的 `status` 设置。
6. 单个图库失败时记录错误，继续处理下一个。
7. 全部完成后更新 `import_jobs`（success_count、failure_count）。
8. 生成错误报告 CSV 存入 R2。
9. 管理员查看草稿 → 预览 → 发布。

### 并发控制 `[当前实现 / 后续规划]`

- 当前实现：新任务提交时检查 `processing` 状态任务数，超过 3 个返回 429。
- 后续完整 zip 异步导入：异步处理器继续沿用同时处理任务数 <= 3 的约束，并按 Cloudflare Queues / Workflows / 分片任务的实际能力设计重试和超时策略。

### Telegram 外部导入 `[当前实现]`

- Telegram 文件 ID 导入使用 `/api/imports/telegram-file-id`，请求必须携带有效 Import Token。
- 导入类型仅允许 `gallery` 和 `case`，真实案例使用 `case`。
- Import Token 权限使用 `gallery:create` 和 `case:create`，真实案例不再使用旧权限名。
- 当前项目不内置 Telegram Bot；外部 Bot / Ops Hub 负责监听 Telegram 和提交结构化 JSON，平台只提供接收、拉取、入库、状态查询和重试能力。
- Ops Hub 自动导入中的 `#gallery`、`#case`、`标题`、`slug`、`标签`、`等级` 是上游 caption 解析约定；MeiGallery API 不解析 caption，只校验标准化 JSON。
- 同一 `token + source + externalMessageId` 重复提交返回 `duplicate`，不创建第二个草稿；Ops Hub 需要继续查询原 `importId`。
- `sourceBotKey` 对应 API Worker secret，命名规则为 `TELEGRAM_BOT_TOKEN_${sourceBotKey.toUpperCase()}`，例如 `ops_gallery_bot` 对应 `TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT`。
- Bot 侧可调用 `/api/imports/:importId/retry` 重试失败记录；后台详情页也可调用 `/api/admin/external-import-records/:id/retry` 手动重试。
- `case` 导入写入 `cases` / `case_images`，R2 key 使用 `cases/{caseId}/{imageId}.{ext}`。
- 详细对接契约见 `docs/TELEGRAM_IMPORT_API.md`。

## 10. WordPress 迁移流程 `[部分实现 / 历史参考 / 后续规划]`

旧站 `zuole.me` 当前可通过 WordPress REST API 获取公开数据。

### 迁移步骤 `[部分实现 / 后续规划]`

1. 创建来源：记录旧站 base URL、导入模式、分类映射、标签映射。
2. 拉取元数据：读取文章总数、分类、标签、sitemap。
3. 拉取文章：分页读取 `/wp-json/wp/v2/posts`（每页 100 条）。
4. 解析正文：从 HTML 中提取图片、视频、正文段落。
5. 媒体入库：图片下载到 R2，视频上传到 Stream。
6. 标签映射：分类转地区标签，post_tag 转身份、风格、场景等标签。
7. 风险标记：发现敏感词、年龄风险、授权未知、媒体失败时进入待审核。
8. 草稿生成：创建图库草稿并记录旧 URL。
9. SEO 映射：生成旧 URL → 新图库 URL 的 redirect 记录。

### 正文解析要求 `[当前实现 / 部分实现]`

- 支持 WordPress block HTML（`<figure class="wp-block-image">`、`<figure class="wp-block-video">`）。
- 保留原始 HTML 快照用于审计。
- 转换后的正文以 Markdown 存储到 `galleries.body_md`。
- `<img>` 提取为 `media_assets`（type=image）。
- `<video>` 提取为 `media_assets`（type=video）。

### 审核机制 `[部分实现 / 后续规划]`

触发待审核的条件：
- 标题或正文包含敏感词（需维护敏感词列表）。
- 旧站分类名暗示年龄/服务/交易风险。
- 媒体 URL 下载失败。
- 授权来源不明确。

审核操作：通过 / 退回 / 修改标签 / 修改标题 / 删除敏感文案。

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
- **Ops Hub 自动导入对接**：MeiGallery 只接收 Ops Hub 已解析好的 JSON payload；caption 触发、slug 缺省生成、图片排序和类型选择由 Ops Hub 保证，平台侧通过 Import Token、`sourceBotKey`、payload 校验和幂等约束兜底。
- **生产域名**：Web 站点 `616618.xyz`，API 服务 `api.616618.xyz`。
- **Dev 环境 Worker**：当前配置为 `meigallery-web-dev` / `meigallery-api-dev`，仅使用 Workers dev 子域，不绑定生产域名。

## 13. 测试范围 `[当前实现 / 后续规划]`

### 单元测试（必须覆盖） `[当前实现 / 后续规划]`

- 权限校验：不同 rank 访问不同等级媒体。
- 会员有效期：过期后立即失效。
- 导入校验当前范围：manifest CSV 解析、必填字段、slug 格式、required_level/status 枚举、重复 slug、部分失败。
- 后续完整 zip 导入校验：合法包、缺失 `content.md`、缺失 `cover.jpg`、缺失图片、非法文件类型、资源大小限制。
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

### 集成测试 `[部分实现 / 后续规划]`

- 当前导入流程：创建任务 → 提交已解析 JSON → 校验 → 草稿生成 → 错误报告。
- 后续完整 zip 导入流程：R2 直传 zip → 异步解压校验 → 草稿生成 → 预览发布。
- 完整迁移流程：拉取 → 解析 → 入库 → 审核。
- 媒体签名流程：请求 → 校验 → 签发 → 过期。
- 审计日志：admin 写操作后检查日志记录；重点覆盖导入任务处理结果、旧站迁移批量入口、会员发放、媒体变更和站点设置。
- App 人物发布：候选草稿 → 用途授权 → 认证提交/复核 → 发布提交/复核 → 公开 API 可见；编辑线上资料后 App 继续读取旧投影，重新发布后才切换版本。
- App 账号访问：Web 账号密码验证 → 当前同意 → App 设备会话 → Bearer 本人信息 → Token 轮换 → 远程退出/重放撤权；生产配置缺失时 bootstrap 和所有账号命令保持关闭。

### 端到端测试 `[当前实现 / 后续规划]`

- WordPress 迁移：分类映射、标签映射、图片解析、视频解析、媒体下载失败、敏感词触发审核。
- 响应式：移动端、平板端、桌面端关键页面布局。
