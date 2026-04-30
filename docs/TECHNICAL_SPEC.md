# 技术设计初稿

## 1. 技术目标

- 使用 Cloudflare 作为默认部署和运行平台。
- 前台和后台共用同一套认证、权限、媒体访问控制能力。
- 所有受保护媒体都必须经过服务端授权。
- 批量导入以异步任务设计，避免大文件和视频处理阻塞请求。

## 2. 推荐技术栈

- Frontend: React 或 Vue，优先选择能稳定部署到 Cloudflare Pages 的框架。
- API Runtime: Cloudflare Workers 或 Pages Functions。
- Database: Cloudflare D1。
- Object Storage: Cloudflare R2。
- Video: Cloudflare Stream。
- Bot Protection: Cloudflare Turnstile。
- CI/CD: GitHub + Cloudflare Pages Git integration。

## 3. 应用模块

- `public-web`：首页、列表页、搜索页、详情页、登录注册、用户中心。
- `admin-web`：后台首页、图库管理、标签管理、会员管理、导入任务、系统设置、审计日志。
- `api`：认证、图库、搜索、媒体授权、后台管理、导入处理。
- `db`：D1 schema、migration、seed。
- `media`：R2 对象 key 规范、Stream UID 映射、签名访问。
- `migration`：WordPress REST/XML 导入、媒体抓取、字段映射、审核队列。

## 4. API 分组

公开 API：

- `GET /api/galleries`
- `GET /api/galleries/:slug`
- `GET /api/tags`
- `GET /api/search`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/media/:assetId/access`

管理员 API：

- `GET /api/admin/dashboard`
- `GET /api/admin/galleries`
- `POST /api/admin/galleries`
- `PATCH /api/admin/galleries/:id`
- `POST /api/admin/galleries/:id/publish`
- `POST /api/admin/galleries/:id/unpublish`
- `GET /api/admin/tags`
- `POST /api/admin/tags`
- `PATCH /api/admin/tags/:id`
- `GET /api/admin/users`
- `POST /api/admin/users/:id/memberships`
- `POST /api/admin/import-jobs`
- `GET /api/admin/import-jobs/:id`
- `GET /api/admin/audit-logs`
- `GET /api/admin/settings`
- `PATCH /api/admin/settings`
- `POST /api/admin/legacy-import-sources`
- `POST /api/admin/legacy-import-jobs`
- `GET /api/admin/legacy-import-jobs/:id`
- `GET /api/admin/legacy-import-items`
- `PATCH /api/admin/legacy-import-items/:id/review`

## 5. 权限模型

用户角色：

- `visitor`：未登录用户，逻辑角色。
- `user`：普通注册用户。
- `admin`：管理员，可管理内容和会员。
- `owner`：站长，可管理系统设置和高级权限。

会员等级：

- 使用 `membership_levels.rank` 判断访问能力。
- `free` rank = 0。
- `vip` rank = 10。
- `svip` rank = 20。
- 业务逻辑不要硬编码等级名，必须比较 rank 或权限配置。

媒体访问控制：

- 公开缩略图可直接 CDN 缓存。
- 公开试看视频可直接播放或短期签名播放。
- 私有图片原图通过 Worker 校验后返回短期 URL 或代理响应。
- 完整视频通过 Stream signed URL 或等价访问控制机制发放短期播放权限。

## 6. 批量导入流程

1. 管理员上传 zip。
2. API 将原始 zip 存入 R2。
3. 创建 `import_jobs` 记录，状态为 `queued`。
4. 后台任务解析 `manifest.csv` 和目录结构。
5. 校验每个图库目录。
6. 上传图片到 R2，上传视频到 Stream。
7. 写入图库、媒体、标签关联。
8. 生成错误报告并更新任务状态。
9. 管理员查看草稿并发布。

首期如果没有队列系统，可以先用分批处理接口实现，但接口设计要保留异步任务状态。

## 7. WordPress 迁移流程

旧站 `zuole.me` 当前可通过 WordPress REST API 获取公开数据。迁移模块需要支持：

1. 创建来源：记录旧站 base URL、导入模式、分类映射、标签映射。
2. 拉取元数据：读取文章总数、分类、标签、sitemap。
3. 拉取文章：分页读取 `/wp-json/wp/v2/posts`。
4. 解析正文：从 HTML 中提取图片、视频、正文段落和标题。
5. 媒体入库：图片下载到 R2，视频上传到 Stream。
6. 标签映射：分类转地区标签，post_tag 转身份、风格、场景等标签。
7. 风险标记：发现敏感词、年龄风险、授权未知、媒体失败时进入待审核。
8. 草稿生成：创建图库草稿并记录旧 URL。
9. SEO 映射：生成旧 URL 到新图库 URL 的 redirect 记录。

建议新增表：

- `legacy_import_sources`
- `legacy_import_jobs`
- `legacy_import_items`
- `legacy_url_redirects`
- `content_review_flags`

正文解析要求：

- 支持 WordPress block HTML。
- 支持 `<figure class="wp-block-image">`。
- 支持 `<figure class="wp-block-video">`。
- 保留原始 HTML 快照用于审计。
- 转换后的正文以 Markdown 或结构化 blocks 存储。

## 8. 缓存策略

- 首页和列表页可短缓存，发布内容后主动失效或等待短 TTL。
- 标签列表可缓存，标签变更后刷新。
- 公开缩略图可长期缓存，文件名包含内容 hash。
- 受保护媒体不做公共缓存，使用短期签名或鉴权代理。

## 9. 测试范围

- 权限测试：不同会员等级访问不同媒体。
- 到期测试：会员到期后立即失去权限。
- 导入测试：合法包、缺失文件、重复 slug、非法标签、部分失败。
- WordPress 迁移测试：分类映射、标签映射、图片解析、视频解析、媒体下载失败、敏感词审核。
- 搜索测试：单标签、多标签、关键词组合、空结果。
- 后台测试：发布、下架、会员发放、审计日志。
- 响应式测试：移动端、平板、桌面端关键页面。
