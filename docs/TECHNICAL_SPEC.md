# 技术设计文档

## 1. 技术目标

- 使用 Cloudflare 作为唯一部署和运行平台。
- 前台和后台共用同一套认证、权限、媒体访问控制能力。
- 所有受保护媒体都必须经过服务端授权，前端不持有真实资源地址。
- 批量导入以异步任务设计，避免大文件和视频处理阻塞请求。
- 会员等级使用 rank 数值比较，业务逻辑不硬编码等级名称。

## 2. 技术栈

- 前端框架：**Nuxt 3**（Vue 3 全栈框架，Nitro preset `cloudflare`，部署为 Cloudflare Worker）。
- 后端框架：**Hono**（部署为独立 Cloudflare Worker，纯 API 服务）。
- UI 层：Vue 3 + Composition API + Tailwind CSS v4（前台）+ Nuxt UI v3（后台）。
- 数据库：Cloudflare D1（SQLite 兼容，通过 Worker bindings 访问）。
- 对象存储：Cloudflare R2（通过 Worker bindings 访问）。
- 视频：Cloudflare Stream（REST API 调用）。**当前状态：未接入**，Stream secrets 为占位符，729 个视频待处理。
- 人机验证：Cloudflare Turnstile。
- CI/CD：**手动部署**：GitHub Actions 无配额，使用 `pnpm --filter @meigallery/api exec wrangler deploy` 和 `pnpm --filter @meigallery/web exec wrangler deploy`。
- 包管理器：pnpm（workspace monorepo）。
- 组件预览：Histoire。

### 架构决策

**前后端分离**：前端（`packages/web`）和后端（`packages/api`）各为独立 Worker，通过 HTTP 通信。这允许前后端并行开发，各自独立部署。

**Workers 而非 Pages**：Cloudflare 官方已推荐从 Pages 迁移到 Workers。Workers 功能集更完整（Durable Objects、Cron Triggers、Rate Limiting binding、Logpush、Gradual Deployments 等）。

### 选型依据

| 需求 | 满足方式 |
|------|----------|
| SEO（图库详情页需要被搜索引擎索引） | Nuxt 3 SSR，preset `cloudflare` |
| 前后端分离并行开发 | 独立 Worker：web + api |
| 后台 SPA | Nuxt `routeRules: { '/admin/**': { ssr: false } }` |
| API 类型安全 | Hono + `@meigallery/shared` 共享类型包 |
| D1/R2 绑定 | Hono 通过 `c.env.DB` / `c.env.R2` 访问 |
| 图片优化 | Cloudflare Images Free Transformations + R2 优先处理公开缩略图，首期固定 `w=480` 单规格；每月 5,000 unique transformations，未启用、转换失败或超限时回退原图响应 |

## 3. 应用模块（monorepo 结构）

| 包 | 路径 | 职责 |
|------|------|------|
| `@meigallery/web` | `packages/web/` | Nuxt 3 前端 Worker：首页、列表、搜索、详情、登录注册、用户中心、管理后台 UI |
| `@meigallery/api` | `packages/api/` | Hono API Worker：认证、图库 CRUD、搜索、媒体授权、后台管理、导入处理 |
| `@meigallery/shared` | `packages/shared/` | 共享类型定义、常量（会员 rank、标签类型、R2 key 前缀等） |

## 4. 认证模块

### 登录方式

邮箱 + 密码（首期唯一方式，后续可扩展 Magic Link）。

### 密码存储

使用 bcrypt 或 argon2 哈希，不存储明文密码。salt 自动生成，不复用。

### 会话管理

- 使用 HttpOnly + Secure + SameSite=Lax 的 cookie 存储 session token。
- session token 由服务端签发，使用 `SESSION_SECRET` 签名。
- 会话有效期 30 天，滑动续期：剩余不足 15 天时自动续期 30 天并同步刷新 cookie。
- 登出时服务端销毁 session 记录。

### Turnstile 集成

以下操作必须验证 Turnstile token：

- 登录
- 注册
- 后台登录
- 批量导入上传

服务端使用 `TURNSTILE_SECRET_KEY` 调用 Cloudflare siteverify API 校验 token。

### 速率限制

| 操作 | 限制 |
|------|------|
| 登录/注册 | 5 次/分钟/IP |
| 公开 API | 60 次/分钟/IP |
| 管理员 API | 120 次/分钟/session |
| 媒体访问签名 | 30 次/分钟/user |

## 5. 权限模型

### 用户角色

| 角色 | 权限范围 |
|------|----------|
| `visitor` | 浏览公开内容，无需登录（逻辑角色） |
| `user` | 登录后查看免费内容、查看会员状态 |
| `admin` | 管理图库、标签、会员发放、批量导入；导入强制为草稿 |
| `owner` | admin 全部权限 + 系统设置 + 导入可直接发布 + 管理员账号管理 |

### Owner 与 Admin 权限差异

| 操作 | Admin | Owner |
|------|-------|-------|
| 导入包设置 `status=published` | 忽略，强制草稿 | 允许直接发布 |
| 修改系统设置（站名、联系方式） | 不可 | 可 |
| 管理其他管理员账号 | 不可 | 可 |
| 查看审计日志 | 仅自己操作 | 全部 |

### 会员等级

| 等级 | rank | 说明 |
|------|------|------|
| free | 0 | 注册用户默认等级 |
| vip | 10 | 可访问 vip 内容 |
| svip | 20 | 可访问全部内容 |

等级判断逻辑：`user_membership.rank >= gallery.required_level_rank`。

### 会员有效期

- `user_memberships` 记录包含 `starts_at` 和 `expires_at`。
- 每次资源请求校验：`NOW() BETWEEN starts_at AND expires_at`。
- 过期后等同 free 权限，不删除历史记录。
- 同一用户可有多条会员记录（如续费），取最高有效 rank。

## 6. 媒体访问控制

### 缩略图按需生成

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

### 受保护图片访问

```text
1. 前端请求 /api/media/:assetId/access
2. Worker 校验 session → 获取用户会员 rank
3. 比较 rank >= media_asset.required_rank
4. 通过 → 签发 R2 presigned URL（有效期 10 分钟）
5. 拒绝 → 返回 403 和所需等级信息
```

### 受保护视频访问

```text
1. 前端请求 /api/media/:assetId/access?type=video
2. Worker 校验 session → 获取用户会员 rank
3. 比较 rank >= media_asset.required_rank
4. 通过 → 调用 Stream API 签发 signed token（有效期 4 小时）
5. 返回 Stream 播放 URL（含 signed token）
6. 拒绝 → 返回 403
```

### R2 对象 key 规范

| 用途 | key 格式 | 访问方式 |
|------|----------|----------|
| 图片原图 | `originals/{galleryId}/{assetId}.{ext}` | 私有，Worker 代理 |
| 缩略图 | `thumbnails/{assetId}/w{width}.webp` | 公开或短缓存 |
| 封面图 | `covers/{galleryId}/cover.{ext}` | 公开 CDN |
| 导入包 | `imports/{jobId}/source.zip` | 私有 |
| 错误报告 | `imports/{jobId}/errors.csv` | 私有，管理员下载 |

## 7. API 路由

### 公开 API

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
| GET | `/api/media/:assetId/access` | 媒体访问签名（需登录） |
| GET | `/api/media/:assetId/thumbnail` | 缩略图（公开） |

### 管理员 API

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
| POST | `/api/admin/import-jobs` | 创建导入任务 | admin+ |
| GET | `/api/admin/import-jobs/:id` | 导入任务详情和进度 | admin+ |
| GET | `/api/admin/audit-logs` | 审计日志 | admin（仅自己）/ owner（全部） |
| GET | `/api/admin/settings` | 站点设置 | owner |
| PATCH | `/api/admin/settings` | 修改站点设置 | owner |
| POST | `/api/admin/legacy-import-sources` | 创建旧站来源 | admin+ |
| POST | `/api/admin/legacy-import-jobs` | 启动旧站迁移 | admin+ |
| GET | `/api/admin/legacy-import-jobs/:id` | 迁移任务详情 | admin+ |
| GET | `/api/admin/legacy-import-items` | 迁移条目列表 | admin+ |
| PATCH | `/api/admin/legacy-import-items/:id/review` | 审核迁移条目 | admin+ |

## 8. D1 数据库 Schema

### users

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- 通过 migration 0007 从 TEXT UUID 迁移为自增整数
  email TEXT NOT NULL UNIQUE,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- visitor/user/admin/owner
  status TEXT NOT NULL DEFAULT 'active', -- active/disabled
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
  user_id TEXT NOT NULL REFERENCES users(id),
  level_id TEXT NOT NULL REFERENCES membership_levels(id),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  note TEXT,
  granted_by TEXT NOT NULL REFERENCES users(id),
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
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

### admin_audit_logs

```sql
CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL, -- create/update/delete/publish/unpublish/grant_membership/import/settings_change
  target_type TEXT NOT NULL, -- gallery/tag/user/membership/import_job/settings
  target_id TEXT,
  before_value TEXT, -- JSON
  after_value TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_logs_admin ON admin_audit_logs(admin_id);
CREATE INDEX idx_audit_logs_time ON admin_audit_logs(created_at);
```

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
  ('membership_description', '""'),
  ('contact_wechat', '""'),
  ('contact_telegram', '""'),
  ('contact_email', '""'),
  ('contact_custom_note', '""');
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

## 9. 批量导入流程

### 状态机

```text
queued → processing → completed
                   ↘ failed（全部失败或系统错误）
```

图库级别状态：`pending → success / failed / partial`

### 详细流程

1. 管理员上传 zip（最大 2 GB）。
2. API 校验文件大小，存入 R2 `imports/{jobId}/source.zip`。
3. 创建 `import_jobs` 记录，状态为 `queued`。
4. Worker 异步处理：
   - 解压 zip，读取 `manifest.csv`。
   - 校验图库数不超过 200。
   - 逐个图库目录校验：`content.md` 存在、`cover.jpg` 存在、至少一张图片。
   - 校验通过 → 上传图片到 R2、视频到 Stream。
   - 创建 gallery 和 media_assets 记录。
   - 处理标签：已存在则关联，不存在且类型合法则自动创建。
   - 状态判定：Admin 强制 `draft`；Owner 可按 manifest 中的 `status` 设置。
5. 单个图库失败时记录错误，继续处理下一个。
6. 全部完成后更新 `import_jobs`（success_count、failure_count）。
7. 生成错误报告 CSV 存入 R2。
8. 管理员查看草稿 → 预览 → 发布。

### 并发控制

- 同时进行的导入任务 <= 3。
- 新任务提交时检查当前 `processing` 状态任务数，超限返回 429。

### Telegram 外部导入

- Telegram 文件 ID 导入使用 `/api/imports/telegram-file-id`，请求必须携带有效 Import Token。
- 导入类型仅允许 `gallery` 和 `case`，真实案例使用 `case`。
- Import Token 权限使用 `gallery:create` 和 `case:create`，真实案例不再使用旧权限名。
- `case` 导入写入 `cases` / `case_images`，R2 key 使用 `cases/{caseId}/{imageId}.{ext}`。

## 10. WordPress 迁移流程

旧站 `zuole.me` 当前可通过 WordPress REST API 获取公开数据。

### 迁移步骤

1. 创建来源：记录旧站 base URL、导入模式、分类映射、标签映射。
2. 拉取元数据：读取文章总数、分类、标签、sitemap。
3. 拉取文章：分页读取 `/wp-json/wp/v2/posts`（每页 100 条）。
4. 解析正文：从 HTML 中提取图片、视频、正文段落。
5. 媒体入库：图片下载到 R2，视频上传到 Stream。
6. 标签映射：分类转地区标签，post_tag 转身份、风格、场景等标签。
7. 风险标记：发现敏感词、年龄风险、授权未知、媒体失败时进入待审核。
8. 草稿生成：创建图库草稿并记录旧 URL。
9. SEO 映射：生成旧 URL → 新图库 URL 的 redirect 记录。

### 正文解析要求

- 支持 WordPress block HTML（`<figure class="wp-block-image">`、`<figure class="wp-block-video">`）。
- 保留原始 HTML 快照用于审计。
- 转换后的正文以 Markdown 存储到 `galleries.body_md`。
- `<img>` 提取为 `media_assets`（type=image）。
- `<video>` 提取为 `media_assets`（type=video）。

### 审核机制

触发待审核的条件：
- 标题或正文包含敏感词（需维护敏感词列表）。
- 旧站分类名暗示年龄/服务/交易风险。
- 媒体 URL 下载失败。
- 授权来源不明确。

审核操作：通过 / 退回 / 修改标签 / 修改标题 / 删除敏感文案。

## 11. 缓存策略

| 资源类型 | 缓存策略 | TTL |
|----------|----------|-----|
| 前台静态资源 | Workers Assets 自动缓存 | 长期（hash 文件名） |
| 首页和列表页数据 | 短缓存，发布后失效 | 60 秒 |
| 标签列表 | 短缓存 | 300 秒 |
| 公开缩略图 | R2 公开访问 + CDN 缓存 | 7 天（文件名含 hash） |
| 受保护媒体 | 不缓存，短期签名 URL | 不适用 |

## 12. 已实现功能补充

- **图库创建两步流程**：第一步填写基本信息（标题、slug、描述、标签、等级），第二步上传媒体文件（封面、图片、视频）。
- **站点设置扩展**：新增 SEO/OG/页脚字段（`seo_description`、`og_image_url`、`footer_text`、`footer_links`），通过 migration 0009 添加。
- **无限滚动**：首页和发现页使用 IntersectionObserver 实现无限滚动加载。
- **浏览量统计**：galleries 表新增 `view_count` 字段（migration 0008），使用 `waitUntil` 异步增量更新，不阻塞请求。
- **生产域名**：Web 站点 `616618.xyz`，API 服务 `api.616618.xyz`。
- **Dev 环境 Worker**：**已删除**，需要时重新创建。

## 13. 测试范围

### 单元测试（必须覆盖）

- 权限校验：不同 rank 访问不同等级媒体。
- 会员有效期：过期后立即失效。
- 导入校验：合法包、缺失文件、重复 slug、非法标签类型、部分失败。
- 标签搜索：单标签、多标签组合、空结果。
- 密码哈希与验证。
- Turnstile token 校验。

### 集成测试

- 完整导入流程：上传 → 校验 → 草稿生成 → 发布。
- 完整迁移流程：拉取 → 解析 → 入库 → 审核。
- 媒体签名流程：请求 → 校验 → 签发 → 过期。
- 审计日志：admin 操作后检查日志记录。

### 端到端测试

- WordPress 迁移：分类映射、标签映射、图片解析、视频解析、媒体下载失败、敏感词触发审核。
- 响应式：移动端、平板端、桌面端关键页面布局。
