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

- 使用 HttpOnly + Secure + SameSite=Lax 的 cookie 存储 session token。
- session token 由服务端签发，使用 `SESSION_SECRET` 签名。
- 会话有效期 30 天，滑动续期：剩余不足 15 天时自动续期 30 天并同步刷新 cookie。
- 登出时服务端销毁 session 记录。

### Turnstile 集成 `[当前实现]`

以下操作必须验证 Turnstile token：

- 登录
- 注册；邮箱验证码开启时，由发送验证码接口完成验证，注册提交验证码。
- 发送邮箱验证码。
- 后台登录复用普通登录入口，因此通过登录接口完成验证。
- 后台导入任务创建和处理。

服务端使用 `TURNSTILE_SECRET_KEY` 调用 Cloudflare siteverify API 校验 token。

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
| GET | `/api/invites/:code/status` | 公开校验邀请码状态，只返回可展示字段和失败原因，不泄露 `code_hash` |
| GET | `/api/settings/public` | 公开站点设置和过滤后的首页广告数组 `home_ads` |

### 管理员 API `[当前实现 / 部分实现]`

| 方法 | 路径 | 说明 | 角色 |
|------|------|------|------|
| GET | `/api/admin/dashboard` | 数据概览 | admin+ |
| GET | `/api/admin/galleries` | 图库列表（含草稿） | admin+ |
| POST | `/api/admin/galleries` | 创建图库 | admin+ |
| PATCH | `/api/admin/galleries/:id` | 编辑图库 | admin+ |
| POST | `/api/admin/galleries/:id/publish` | 发布图库 | admin+ |
| POST | `/api/admin/galleries/:id/unpublish` | 下架图库 | admin+ |
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

以下为当前核心表摘要，完整结构以 `packages/api/migrations/` 中的顺序迁移为准。数据分析相关表已通过 `0023` 到 `0026` 建立 schema，并已接入公开采集 API、邀请码转化闭环和 Web 轻量 SDK；图库、搜索、联系、广告等核心业务埋点、聚合任务和后台分析页面仍属于后续接入阶段。

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

当前后台写操作审计覆盖矩阵维护在 `docs/CODE_AND_DOC_REVIEW_ISSUES.md` 的 P2-07 小节；新增 `POST` / `PUT` / `PATCH` / `DELETE` 管理端路由时必须同步补充 `writeAuditLog` 和测试断言。

### site_settings

```sql
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始配置
INSERT INTO site_settings (key, value) VALUES
  ('site_name', '"MeiGallery"'),
  ('seo_title', '"MeiGallery - 精选写真图库"'),
  ('seo_description', '""'),
  ('membership_description', '""'),
  ('email_verification_enabled', '"false"'),
  ('video_enabled', '"false"'),
  ('og_image_url', '""'),
  ('footer_text', '""'),
  ('footer_links', '"[]"');
```

旧 `home_ad_*` 站点设置仍保留为公开读取兼容兜底；当前主要首页广告配置使用独立 `home_ads` 表和 `/api/admin/ads` 后台页面维护。

### 数据分析表 `[部分实现]`

当前已通过 `0023_analytics_core.sql` 到 `0026_analytics_exports.sql` 建立数据分析 schema，并已接入 `/api/analytics/events`、`/api/analytics/session/end` 公开采集接口、邀请码转化闭环和 Web 轻量 SDK。采集接口默认受 `analytics_enabled=false` 保护，关闭时返回 disabled 且不写 D1；Web SDK 同样读取公开设置，关闭时不初始化 visitor/session，不写本地存储。在图库、搜索、联系、广告等核心业务埋点、聚合任务和后台页面接入前，生产数据分析能力仍未完整启用。

核心表分层：

| 表 | 状态 | 用途 |
|------|------|------|
| `analytics_visitors` | `[部分实现]` | 匿名访客事实，不保存原始 IP 或完整 user agent；可在登录后绑定内部 `user_id`。 |
| `analytics_sessions` | `[部分实现]` | session 入口、退出、来源、设备、国家和有效浏览摘要。 |
| `analytics_page_summaries` | `[部分实现]` | session 内页面级摘要，用于页面时长、跳出、入口/退出和滚动深度统计。 |
| `analytics_session_summaries` | `[部分实现]` | session 级摘要，用于默认后台报表避免扫描采样明细。 |
| `analytics_events` | `[部分实现]` | 关键转化事件和 1%-5% 采样明细；不作为默认后台报表的全量事件仓库。 |
| `analytics_ingest_health_daily` | `[部分实现]` | 每日 accepted/rejected/duplicate/sensitive blocked、采样、丢弃和 D1 预算估算。 |
| `invite_codes` | `[当前实现]` | 后台邀请码定义，保存 `code_hash` 和 `display_code`，创建响应返回明文 code，创建/修改/禁用写入审计日志。 |
| `invite_registrations` | `[当前实现]` | 邀请注册事实，关联 visitor、session、注册用户和首次会员发放回填；重复绑定不会重复增加 `used_count`。 |
| `analytics_daily_sources` | `[部分实现]` | 按日期、来源渠道、来源名称和邀请码聚合访问、注册、联系和会员发放。 |
| `analytics_daily_pages` | `[部分实现]` | 按日期、route、path 和业务实体聚合页面表现。 |
| `analytics_daily_events` | `[部分实现]` | 按日期、事件名和实体聚合关键事件计数。 |
| `analytics_path_edges` | `[部分实现]` | 按日期聚合 `from_route -> to_route` 路径边。 |
| `analytics_invite_daily` | `[部分实现]` | 按日期和邀请码聚合落地、注册、联系和会员发放。 |
| `analytics_click_daily` | `[部分实现]` | 按日期、元素和目标聚合 raw/effective/duplicate 点击。 |
| `analytics_export_jobs` | `[部分实现]` | Owner-only CSV 导出任务元数据，导出文件后续写入 R2 并设置过期时间。 |

成本与索引口径：

- 默认后台 7/30/90 天报表读取日报聚合表和摘要表，禁止首页看板直接扫描 `analytics_events`。
- 公开采集接口单批最多 20 个事件，payload 上限 16KB，并叠加 IP、visitor、session 三维应用内兜底限流。
- Web SDK 队列最多保留 50 条事件，达到 20 条、10 秒定时、路由切换、`visibilitychange=hidden` 或 `pagehide` 时 flush；`pagehide` 优先使用 `sendBeacon`，失败事件保存在 localStorage 下次重试。
- Web SDK 的 15 秒 heartbeat 只累计有效浏览时长，不单独发网络请求；`consent_state=limited` 时跳过非必要点击和曝光明细，保留注册、登录、邀请等关键转化事件。
- `analytics_events` 只保留事件名、session 和实体三类必要组合索引：`(event_name, occurred_at)`、`(session_id, occurred_at)`、`(entity_type, entity_id, occurred_at)`。
- 日报聚合表均以 `date` 加主要维度建立唯一索引，供 Cron 聚合任务幂等 upsert。
- 不给 `event_props` 任意 JSON 字段建索引，避免高基数属性导致写放大和存储成本失控。
- `site_settings` 已新增 `analytics_enabled=false`、`analytics_sample_rate=0.01`、`analytics_consent_mode=limited`，因此前端 SDK 后续接入时默认保持关闭态。

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
- `case` 导入写入 `cases` / `case_images`，R2 key 使用 `cases/{caseId}/{imageId}.{ext}`。

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
| 首页和列表页数据 | 短缓存，发布后失效 | 60 秒 |
| 标签列表 | 短缓存 | 300 秒 |
| 公开缩略图 | R2 公开访问 + CDN 缓存 | 7 天（文件名含 hash） |
| 受保护图片 | Worker 代理返回，用户端私有短缓存 | 600 秒 |
| 受保护视频 | Stream 接入后返回 signed token；未配置 Stream secrets 时返回 `STREAM_NOT_CONFIGURED` | 4 小时 |

## 12. 已实现功能补充 `[当前实现]`

- **图库创建两步流程**：第一步填写基本信息（标题、slug、描述、标签、等级），第二步上传媒体文件（封面、图片、视频）。
- **站点设置扩展**：新增 SEO/OG/页脚字段（`seo_description`、`og_image_url`、`footer_text`、`footer_links`），通过 migration 0009 添加。
- **无限滚动**：首页和发现页使用 IntersectionObserver 实现无限滚动加载。
- **浏览量统计**：galleries 表新增 `view_count` 字段（migration 0008），使用 `waitUntil` 异步增量更新，不阻塞请求。
- **图库互动**：galleries 表新增 `like_count`，`gallery_likes` 记录用户点赞关系（migration 0013）。
- **真实案例命名**：当前使用 `cases` / `case_images`、公开路由 `/cases`、后台路由 `/admin/cases`，旧 `testimonial_*` 命名已通过 migration 0017 清理。
- **Telegram 外部导入**：当前导入类型为 `gallery` / `case`，权限为 `gallery:create` / `case:create`，不再接受旧 `testimonial_case`。
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

### 端到端测试 `[当前实现 / 后续规划]`

- WordPress 迁移：分类映射、标签映射、图片解析、视频解析、媒体下载失败、敏感词触发审核。
- 响应式：移动端、平板端、桌面端关键页面布局。
