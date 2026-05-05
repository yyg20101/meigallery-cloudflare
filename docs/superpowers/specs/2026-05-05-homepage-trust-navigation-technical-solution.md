# 首页真实案例与导航体验技术方案

## 1. 方案摘要

本方案把首页改版拆成三个可独立验证的能力：真实案例内容系统、首页导航体验重构、规则/联系悬浮入口。后端继续使用 Hono + D1 + R2，前端继续使用 Nuxt + Vue 3 + Tailwind CSS v4；所有新增公开页面通过 SSR 获取 API 数据，后台写操作继续要求管理员权限并写审计日志。

核心原则：
- 真实案例是后台维护的运营内容，不开放普通用户上传。
- 真实案例图片进入 R2 私有 bucket，由 API Worker 公开代理读取，不向前端暴露 R2 key。
- 首页不再无限滚动，改为有限展示和明确“查看更多”入口。
- 关于页从主导航和后台配置移除，规则说明由规则弹窗和 `/rules` 页面承接。
- 未验收改版只部署到 Workers dev 子域，生产域不受影响。

## 2. 数据模型

新增 migration：`packages/api/migrations/0014_testimonial_cases.sql`。

### 2.1 testimonial_cases

```sql
CREATE TABLE IF NOT EXISTS testimonial_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  featured INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('draft', 'published'))
);
```

字段说明：
- `status='published'` 才进入公开 API。
- `featured=1` 才进入首页真实案例轮播。
- `sort_order` 越小越靠前，同分按 `published_at DESC`。
- `body_md` 用安全 Markdown 渲染，允许标题、段落、列表、加粗和 `https?://` 链接。

### 2.2 testimonial_case_images

```sql
CREATE TABLE IF NOT EXISTS testimonial_case_images (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES testimonial_cases(id) ON DELETE CASCADE,
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

索引：
- `idx_testimonial_cases_public`：`(status, featured, sort_order, published_at)`。
- `idx_testimonial_images_case`：`(case_id, sort_order)`。

R2 key 规范：`testimonials/{caseId}/{imageId}.{ext}`。

### 2.3 site_settings 调整

新增规则入口设置：
- `rules_entry_enabled`
- `rules_entry_title`
- `rules_entry_summary`
- `rules_entry_icon`
- `rules_modal_content`
- `rules_page_title`
- `rules_page_summary`
- `rules_page_content`
- `rules_page_url`

移除公开和后台可配置 key：
- `about_title`
- `about_summary`
- `about_content`

迁移中保留新增规则默认值，并删除 about 旧设置行，避免后台继续展示旧范围。

## 3. API 设计

### 3.1 公开 API

`GET /api/testimonial-cases`

查询参数：
- `page`：默认 `1`。
- `pageSize`：默认 `12`，最大 `50`。
- `featured`：传 `true` 时只返回首页展示案例。

响应：

```json
{
  "data": [
    {
      "id": "tc_xxx",
      "title": "会员反馈精选",
      "slug": "member-feedback-001",
      "summary": "用户授权后的真实反馈摘要。",
      "imageCount": 4,
      "coverImageUrl": "/api/testimonial-cases/images/tci_xxx",
      "publishedAt": "2026-05-05T00:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 12
}
```

空数据响应：

```json
{
  "data": [],
  "total": 0,
  "page": 1,
  "pageSize": 12
}
```

空数据必须返回 HTTP 200，供首页和列表页渲染空状态；不得用 404 表示“暂无案例”。

`GET /api/testimonial-cases/:slug`

响应：

```json
{
  "id": "tc_xxx",
  "title": "会员反馈精选",
  "slug": "member-feedback-001",
  "summary": "用户授权后的真实反馈摘要。",
  "bodyMd": "## 体验说明\n\n反馈内容已脱敏。",
  "seoTitle": "会员反馈精选 - MeiGallery",
  "seoDescription": "用户授权后的真实反馈摘要。",
  "publishedAt": "2026-05-05T00:00:00.000Z",
  "images": [
    {
      "id": "tci_xxx",
      "url": "/api/testimonial-cases/images/tci_xxx",
      "alt": "会员反馈精选 1",
      "sortOrder": 0
    }
  ]
}
```

`GET /api/testimonial-cases/images/:imageId`

行为：
- 只返回所属案例为 `published` 的图片。
- 从 R2 读取 `r2_key` 并代理响应。
- 设置 `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`。
- 设置 `Content-Type` 为入库的 `mime_type`。

### 3.2 后台 API

挂载位置：`app.route('/api/admin/testimonial-cases', adminTestimonialCaseRoutes)`。

接口：
- `GET /api/admin/testimonial-cases`：管理员列表，支持 `status`、`page`、`pageSize`。
- `POST /api/admin/testimonial-cases`：创建案例。
- `PATCH /api/admin/testimonial-cases/:id`：编辑标题、slug、摘要、正文、状态、精选、排序、SEO。
- `DELETE /api/admin/testimonial-cases/:id`：删除案例并清理图片记录；R2 删除通过逐个 `r2.delete` 执行。
- `POST /api/admin/testimonial-cases/:id/images`：上传 1-9 张 JPG/PNG/WebP 图片。
- `PATCH /api/admin/testimonial-cases/:id/images/order`：保存图片排序。
- `DELETE /api/admin/testimonial-cases/:id/images/:imageId`：删除单张图片和 R2 对象。

校验规则：
- `title` 必填，1-80 字。
- `slug` 必填，只允许小写字母、数字和短横线。
- `summary` 最多 160 字。
- `body_md` 最多 5000 字。
- 发布时必须已有 2-9 张图片。
- 上传图片 MIME 只允许 `image/jpeg`、`image/png`、`image/webp`，单张最大 10MB。
- 所有后台写操作必须调用 `writeAuditLog()`。

## 4. 前端设计与页面结构

### 4.1 首页

修改 `packages/web/app/pages/index.vue`：
- 移除无限滚动状态、`loadMore()`、`IntersectionObserver` 和 sentinel。
- 首页图库只展示首批有限数据，底部显示“查看更多图库”跳转 `/discover`。
- `HomeEditorialHero` 不再接收和渲染 CTA 文案/链接。
- `RegionGuide` 替换为 `HomeTagNavigator` 和 `TestimonialCarousel`。

新增组件：
- `HomeTagNavigator.vue`：按热门城市、地区组、风格偏好分组展示标签。
- `TestimonialCarousel.vue`：首页真实案例轮播，桌面端多图杂志卡，移动端横向滑动。

标签分组策略：
- 热门城市：优先读取 `city`、`city_country`，前 8 个。
- 地区组：读取 `region_scope`、`region_group`，前 8 个。
- 风格偏好：读取 `style`、`personality`、`scene`，前 12 个。

### 4.2 真实案例公开页

新增：
- `packages/web/app/pages/testimonials/index.vue`
- `packages/web/app/pages/testimonials/[slug].vue`
- `packages/web/app/components/TestimonialCard.vue`
- `packages/web/app/components/TestimonialGallery.vue`

列表页：
- SSR 请求 `/api/testimonial-cases?pageSize=12`。
- 桌面 3 列，移动 1 列或 2 列。
- 卡片展示封面、标题、摘要、图片数量、发布时间。

详情页：
- SSR 请求 `/api/testimonial-cases/:slug`。
- 桌面左图右文，移动单栏。
- 图片使用 `loading="lazy"`，首图可 `fetchpriority="high"`。
- 复用 `ImageViewer` 实现放大浏览。
- slug 不存在、草稿或未公开时显示 404，用户文案为“真实案例不存在或暂未公开”。

空状态策略：
- 首页真实案例为空时保留区块标题，显示暖白空状态卡片：标题 `真实案例整理中`，说明 `我们正在整理已授权、已脱敏的用户反馈。你可以先浏览最新图库，或联系站长了解会员规则。`，主入口 `浏览最新图库` 指向 `/discover`。
- `/testimonials` 列表为空时返回 200 页面，显示标题 `真实案例整理中`、说明 `当前暂无公开案例，后续会展示经过授权和脱敏的用户反馈。`，入口 `返回首页` 和 `浏览图库`。
- 空状态不得展示假案例、虚构评价、外部图片或未授权素材。

### 4.3 规则与联系悬浮入口

调整 `ContactPanel.vue`：
- 主按钮变为消息 icon 样式，包含未读红点和“有新消息”。
- 规则入口固定在联系入口上方。
- 规则入口读取 `useSiteSettings()` 的规则配置。
- 弹窗显示安全 Markdown 渲染结果，并提供 `rules_page_url` 跳转。

新增：
- `packages/web/app/pages/rules.vue`
- `packages/web/app/utils/safeMarkdown.ts`

`safeMarkdown.ts` 负责把 Markdown 转换为白名单 HTML，避免在多个页面重复实现。

### 4.4 后台

新增后台导航：`真实案例`。

新增页面：
- `packages/web/app/pages/admin/testimonials/index.vue`
- `packages/web/app/pages/admin/testimonials/new.vue`
- `packages/web/app/pages/admin/testimonials/[id].vue`

后台功能：
- 列表：标题、状态、精选、图片数、排序、更新时间、编辑入口。
- 空列表：显示 `还没有真实案例`、`新建案例` 主按钮和 `发布前需上传 2-9 张已授权、已脱敏图片。` 提示。
- 新建/编辑：标题、slug、摘要、正文 Markdown、状态、精选、排序、SEO。
- 图片管理：上传、多图预览、排序、删除。
- 发布提示：图片少于 2 张或超过 9 张时阻止发布。

`packages/web/app/pages/admin/settings.vue` 移除“关于我们页面”字段，新增“规则与引导”字段。

## 5. Dev 环境隔离

调整 Wrangler 配置：
- API 新增 `[env.dev]`，Worker 名称 `meigallery-api-dev`，`APP_ENV="dev"`，`CORS_ORIGIN` 指向 Web dev 子域。
- Web 新增 `[env.dev]`，Worker 名称 `meigallery-web-dev`，`NUXT_PUBLIC_APP_ENV="dev"`，API binding 指向 `meigallery-api-dev`。
- Dev 环境不配置生产 custom domain，只使用 Workers dev 子域。

前端行为：
- 当 `NUXT_PUBLIC_APP_ENV !== 'production'` 时显示“DEV 测试环境”角标。
- 全局 `useHead()` 增加 `robots: noindex, nofollow` meta。
- API Worker 在 `APP_ENV !== 'production'` 时增加 `X-Robots-Tag: noindex, nofollow`。

## 6. 测试策略

API：
- `site-settings.test.ts`：确认 about keys 已移除、rules keys 已加入。
- `testimonial-cases.test.ts`：测试 slug、发布图片数量、排序白名单、公开图片 URL。
- 路由层用轻量 Hono 测试或 DB mock 覆盖公开列表、详情、发布校验和审计日志调用。

Web：
- 当前仓库没有前端单测框架；本轮以 `nuxt build`、浏览器响应式检查和手动 Workers dev 验收为主。
- 若后续引入 Playwright，可补充首页、案例列表、案例详情、规则弹窗的端到端冒烟。

验收命令：

```bash
pnpm --filter @meigallery/api test
pnpm --filter @meigallery/api exec tsc --noEmit
pnpm --filter @meigallery/web exec nuxt build
```

Dev 部署验证命令：

```bash
pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote --env dev
pnpm --filter @meigallery/api exec wrangler deploy --env dev
pnpm --filter @meigallery/web exec nuxt build
pnpm --filter @meigallery/web exec wrangler deploy --env dev
```

生产部署仍必须由确认后的本地命令执行，不由 GitHub Actions 自动部署。

## 7. 风险与缓解

- 授权风险：后台上传页必须展示“已确认授权并完成脱敏”的提示，发布前由管理员确认。
- 首页性能风险：首页案例只请求 `featured=true&pageSize=6`，图片非首屏 lazy load。
- R2 公开代理压力：图片响应使用边缘缓存头，后续可接入 Cloudflare Images Transformations。
- Dev 误操作风险：dev 页面显示环境角标，后台写操作仍需管理员权限并保留审计。
- 关于页移除后的信息缺口：规则弹窗、`/rules` 页面和页脚规则入口承接站点说明。
