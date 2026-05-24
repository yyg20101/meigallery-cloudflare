# PRD: 图库管理完善 — Bug 修复 + 媒体上传 + VIP 配置 + 前台资源加载

> 版本: 1.0 | 日期: 2026-04-30 | 状态: 草案，部分功能已落地；当前生产状态以 `docs/PROJECT_STATUS.md` 为准。

---

## 1. 执行摘要

### 问题陈述

后台图库管理系统存在 4 个层级的问题：

1. **编辑页空白（Bug）**：管理员 `GET /api/admin/galleries/:id` 返回 snake_case 字段（`body_md`、`required_level_rank`），但前端编辑页 `[id].vue` 用 camelCase 读取（`bodyMd`、`requiredLevelRank`），导致所有字段为 `undefined`，页面显示空白。
2. **发布后首页无图片（Bug）**：WordPress 迁移的 606 个图库中有 2831 张图片，其中已完成下载到 R2 的图片通过 `/api/media/cover/:galleryId` 代理访问，但 `media.ts` 的 cover 接口要求 `status = 'published'`，而图库发布流程可能存在 cover_key 缺失或状态不匹配的问题。此外，前台 `gallery.coverUrl` 对外部 URL 和 R2 key 的拼接逻辑需要覆盖所有场景。
3. **媒体上传功能缺失（Feature）**：后台编辑页无图片上传、视频上传、封面设置功能。管理员创建图库后无法添加任何媒体资源，整个内容发布流程中断。
4. **VIP 权限配置缺失（Feature）**：虽然数据库 `media_assets.required_rank` 字段存在，但后台无 UI 让管理员逐张设置图片/视频的可见等级。批量操作中也缺少针对单个媒体的权限配置。

### 解决方案

分三期实施：

- **Phase 1（Bug 修复）**：修复编辑页 snake_case 映射、cover 接口逻辑、前台图片加载、批量操作 Set 响应性 bug、首页视频专区逻辑。
- **Phase 2（媒体上传）**：图库编辑页内新增图片上传（R2）、视频上传（Stream）、封面设置、媒体排序/删除、单张 VIP 等级配置 UI。
- **Phase 3（迁移资源补全）**：批量将 WordPress 外部 URL 图片下载到 R2，替换外部依赖。

当前实现备注：图片上传、封面设置、媒体列表、排序、删除和单媒体 `required_rank` 配置已在后台媒体路由落地；Cloudflare Stream 视频上传仍未接入。

### 成功指标

| 指标 | 目标 |
|------|------|
| 编辑页正确渲染率 | 100%（所有字段正确显示） |
| 发布图库首页封面加载成功率 | >= 95%（R2 图片） |
| 图片上传成功率 | >= 98%（单张 <= 10MB） |
| 视频上传到 Stream 编码完成率 | >= 95% |
| 管理员完成"创建→上传→配置VIP→发布"全流程时间 | <= 10 分钟（含 10 张图） |
| 批量操作 checkbox 正确响应 | 100%（无 Set 响应性 bug） |

---

## 2. 用户体验 & 功能需求

### 2.1 用户角色

| 角色 | 本 PRD 中的操作 |
|------|-----------------|
| 管理员（Owner/Admin） | 创建/编辑图库、上传图片视频、设置 VIP 等级、发布 |
| 普通用户 | 浏览前台图库、查看有权限的图片/视频 |

### 2.2 Phase 1：Bug 修复

#### Bug A：编辑页显示空白

**根因**：管理员详情 API `GET /api/admin/galleries/:id` 使用 `SELECT *` 返回 D1 原始字段（snake_case），前端 `[id].vue` 用 camelCase 解构：

```
API 返回: { body_md, required_level_rank, cover_key, ... }
前端期望: { bodyMd, requiredLevelRank, coverKey, ... }
```

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| A1 | 作为管理员，我点击图库编辑，页面正确显示所有字段 | - API 返回值统一为 camelCase<br>- 标题、slug、摘要、正文、等级、标签全部正确回填<br>- 保存后数据正确提交 |

**修复方案**：在 `admin/galleries.ts` 的 `GET /:id` 中显式映射字段为 camelCase，与公开 API 保持一致。

#### Bug B：发布后首页无图片

**根因分析**（需逐项排查）：

1. `GET /api/media/cover/:galleryId` 要求 `status = 'published'`，如果查询时图库状态不匹配则返回 404。
2. WordPress 迁移图库的 `cover_key` 可能是外部 URL 而非 R2 key，cover 代理接口只处理 R2 key。
3. 公开 API 的 `coverUrl` 拼接逻辑对外部 URL 和 R2 key 的判断依赖 `startsWith('http')`，需确认迁移数据中 `cover_key` 的实际值格式。

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| B1 | 作为用户，发布的图库在首页显示封面缩略图 | - R2 存储的封面正确通过 `/api/media/cover/:id` 加载<br>- 外部 URL 封面直接渲染<br>- 无封面时显示占位图 |
| B2 | 作为用户，图库详情页显示所有公开图片 | - 图片缩略图通过 `/api/media/:assetId/thumbnail` 正确加载<br>- R2 中已下载的图片正常展示<br>- 外部 URL 图片降级直接加载 |

#### Bug C：批量操作 Set 响应性

**根因**：`admin/galleries/index.vue` 中 `selectedIds` 使用 `ref<Set<string>>(new Set())`，Vue 3 对 Set 的 `.add()` / `.delete()` 操作不触发 reactivity，导致 checkbox 状态和计算属性不更新。

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| C1 | 作为管理员，勾选/取消勾选图库时 UI 实时响应 | - 使用 `reactive(new Set())` 或数组替代<br>- 全选/取消全选正确联动<br>- 批量工具栏正确显示选中数量 |

#### Bug D：首页视频专区逻辑

**根因**：`index.vue` 取 `allGalleries.slice(-3)` 作为视频专区内容，实际是列表最后 3 条，并非有视频的图库。

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| D1 | 作为用户，首页视频专区展示真正包含视频的图库 | - API 提供 `hasVideo` 筛选参数或前端过滤带视频资源的图库<br>- 无视频图库时隐藏视频专区 |

#### Bug E：创建图库 slug 自动覆盖

**根因**：`new.vue` 中 `watch(form.title)` 的判断条件 `form.slug === slugify(form.title)` 使用新值比较，导致用户手动修改 slug 后仍被自动覆盖。

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| E1 | 作为管理员，手动修改 slug 后不被标题变更覆盖 | - 使用标志位跟踪用户是否手动编辑过 slug<br>- 仅在未手动编辑时自动生成 |

### 2.3 Phase 2：媒体上传 & VIP 配置

#### 功能 F：图库编辑页媒体管理

> 在图库编辑页 `/admin/galleries/:id` 内，新增完整的媒体管理区域。

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| F1 | 作为管理员，我在编辑页上传图片 | - 拖拽或点击选择区域，支持多选<br>- 格式：JPG/PNG/WebP，单张 <= 10MB<br>- 上传到 R2，key 格式 `originals/{galleryId}/{assetId}.{ext}`<br>- 上传进度条，支持并发 3 张<br>- 上传完成后自动创建 `media_assets` 记录<br>- 图片列表实时刷新 |
| F2 | 作为管理员，我在编辑页上传视频 | - 选择本地视频文件（MP4/WebM/MOV），单文件 <= 200MB<br>- 上传到 Cloudflare Stream（通过 API 代理 TUS 上传或直接创建链接）<br>- 显示上传进度和编码状态<br>- 编码完成后自动关联 `stream_uid` 到 `media_assets`<br>- 标记 role 为 `preview` 或 `full` |
| F3 | 作为管理员，我设置封面图 | - 从已上传的图片中选择作为封面<br>- 或单独上传封面图<br>- 更新 `galleries.cover_key`<br>- 编辑页顶部显示当前封面预览 |
| F4 | 作为管理员，我管理已有媒体 | - 查看所有关联的图片和视频列表<br>- 拖拽排序（更新 `sort_order`）<br>- 删除单个媒体（同时清理 R2/Stream）<br>- 查看每张图片的上传状态和尺寸信息 |
| F5 | 作为管理员，我为单张图片/视频设置 VIP 等级 | - 每张图片/视频旁边有等级下拉框（免费/VIP/SVIP）<br>- 修改即时保存（PATCH `/api/admin/media/:assetId`）<br>- 图库整体等级作为默认值，单张可覆盖为更高等级<br>- 前台展示时，低于等级要求的媒体显示模糊遮罩+锁定图标 |

#### 媒体管理 UI 布局

```
图库编辑页 /admin/galleries/:id
├── 基本信息区域（标题、slug、摘要、正文、等级、标签）
├── 封面设置区域
│   ├── 当前封面预览（如有）
│   └── 上传新封面 / 从图片中选择
├── 图片管理区域
│   ├── 拖拽上传区
│   ├── 图片网格（排序、VIP 等级下拉、删除按钮）
│   └── 上传进度列表
├── 视频管理区域
│   ├── 上传视频按钮
│   ├── 视频列表（预览/完整标记、VIP 等级、编码状态）
│   └── 上传/编码进度
└── 操作栏（保存、发布/下架、删除）
```

#### API 新增/变更

| 接口 | 方法 | 说明 |
|------|------|------|
| `POST /api/admin/galleries/:id/media/upload` | POST | **新增** — 图片上传（multipart/form-data，支持批量） |
| `POST /api/admin/galleries/:id/media/video` | POST | **新增** — 视频上传初始化（返回 Stream 直传 URL 或代理上传） |
| `GET /api/admin/galleries/:id/media` | GET | **新增** — 获取图库所有媒体资源列表（含状态） |
| `PATCH /api/admin/media/:assetId` | PATCH | **新增** — 修改单个媒体属性（sort_order, required_rank, role） |
| `DELETE /api/admin/media/:assetId` | DELETE | **新增** — 删除单个媒体（R2 + DB） |
| `PATCH /api/admin/galleries/:id/cover` | PATCH | **新增** — 设置封面（从已有媒体选择或直接上传） |
| `POST /api/admin/galleries/:id/media/reorder` | POST | **新增** — 批量更新排序 |
| `GET /api/admin/galleries/:id` | GET | 变更 — 返回 camelCase 字段 + 包含媒体资源列表 |

#### 图片上传流程

```
前端：选择图片 → 校验格式/大小 → POST /api/admin/galleries/:id/media/upload (FormData)
后端：
  1. 验证文件格式（image/jpeg, image/png, image/webp）和大小（<= 10MB）
  2. 生成 asset ID 和 R2 key：originals/{galleryId}/{assetId}.{ext}
  3. 上传到 R2
  4. 创建 media_assets 记录（type=image, upload_status=completed）
  5. 更新 galleries.updated_at
  6. 返回 { assetId, r2Key, thumbnailUrl }
```

#### 视频上传流程

```
前端：选择视频文件 → 校验格式/大小 → POST /api/admin/galleries/:id/media/video
后端：
  1. 调用 Stream API 创建直传 URL（TUS 或 direct_upload）
  2. 创建 media_assets 记录（type=video, upload_status=uploading）
  3. 返回 { assetId, uploadUrl }
前端：
  4. 使用返回的 uploadUrl 直传到 Stream
  5. 上传完成后通知后端 PATCH /api/admin/media/:assetId（upload_status=processing）
后端：
  6. 轮询或 Webhook 检查 Stream 编码状态
  7. 编码完成后更新 stream_uid, upload_status=completed
```

### 2.4 Phase 3：迁移资源补全

| # | 用户故事 | 验收标准 |
|---|----------|----------|
| G1 | 作为管理员，WordPress 迁移图库的外部图片被下载到 R2 | - 批量下载 2831 张图片从外部 URL 到 R2<br>- 更新 `media_assets.r2_key` 为本地 R2 key<br>- 更新 `upload_status` 为 `completed`<br>- 下载失败的记录日志，不阻塞其他图片 |
| G2 | 作为管理员，迁移图库的封面正确设置 | - 每个图库的第一张图片作为封面<br>- 更新 `galleries.cover_key` 为 R2 key<br>- cover 代理接口正确返回图片 |

### 2.5 非目标（Not Goals）

- 不实现 Image Resizing 集成（首期用原图作为缩略图降级，后续迭代）
- 不实现视频在线裁剪/编辑
- 不实现图片批量水印
- 不实现 CDN 缓存清除（Cloudflare 自动管理）
- 不实现前台视频播放器（本 PRD 仅解决后台上传，前台播放器属于独立 PRD）
- 不实现图片 AI 审核（超出范围）

---

## 3. 技术规格

### 3.1 Bug 修复详细方案

#### A. 编辑页 snake_case 映射

文件：`packages/api/src/routes/admin/galleries.ts`，`GET /:id` 端点

```diff
- const gallery = await db.prepare('SELECT * FROM galleries WHERE id = ?')
+ const gallery = await db.prepare(
+   'SELECT id, title, slug, summary, body_md, cover_key, status, required_level_rank, published_at, created_at, updated_at FROM galleries WHERE id = ?'
+ )

返回时显式映射：
{
  id, title, slug, summary,
  bodyMd: gallery.body_md,
  coverKey: gallery.cover_key,
  requiredLevelRank: gallery.required_level_rank,
  publishedAt: gallery.published_at,
  ...
  tags: [...]
}
```

#### B. Cover 接口兼容外部 URL

文件：`packages/api/src/routes/media.ts`，`GET /cover/:galleryId`

当前只查 `published` 状态并从 R2 读取。需要：
1. cover_key 以 `http` 开头时 → 302 重定向到外部 URL
2. cover_key 为 R2 key 时 → 从 R2 读取并返回
3. cover_key 为空时 → 返回占位图或 404

#### C. Set 响应性修复

文件：`packages/web/app/pages/admin/galleries/index.vue`

```diff
- const selectedIds = ref<Set<string>>(new Set())
+ const selectedIds = ref<string[]>([])
```

用数组替代 Set，Vue 3 对数组有完整的 reactivity 追踪。`.add()` → `.push()`，`.delete()` → `.filter()`，`.has()` → `.includes()`。

#### D. 视频专区逻辑

文件：`packages/web/app/pages/index.vue`

```diff
- const videoGalleries = computed(() => allGalleries.value?.slice(-3) ?? [])
+ // 方案 1：API 新增 hasVideo 参数
+ const videoGalleries = computed(() =>
+   allGalleries.value?.filter(g => g.videoCount > 0).slice(0, 3) ?? []
+ )
```

需要公开列表 API 在返回值中包含 `videoCount` 字段。

#### E. Slug 自动生成

文件：`packages/web/app/pages/admin/galleries/new.vue`

```diff
+ const slugManuallyEdited = ref(false)

  watch(() => form.title, (newTitle) => {
-   if (form.slug === slugify(form.title)) {
+   if (!slugManuallyEdited.value) {
      form.slug = slugify(newTitle)
    }
  })
```

### 3.2 媒体上传 API 设计

#### 图片上传接口

```
POST /api/admin/galleries/:galleryId/media/upload
Content-Type: multipart/form-data
Body: files[] (多文件)

Response 201:
{
  uploaded: [
    { assetId, r2Key, thumbnailUrl, sortOrder },
    ...
  ],
  failed: [
    { filename, error },
    ...
  ]
}
```

#### 视频上传初始化接口

```
POST /api/admin/galleries/:galleryId/media/video
Content-Type: application/json
Body: { filename, fileSize, role: 'preview' | 'full' }

Response 201:
{
  assetId,
  uploadUrl,     // Stream 直传 URL
  maxDuration,   // 最长时长限制
}
```

#### 媒体属性修改接口

```
PATCH /api/admin/media/:assetId
Content-Type: application/json
Body: { requiredRank?, sortOrder?, role? }

Response 200:
{ assetId, requiredRank, sortOrder, role }
```

#### 封面设置接口

```
PATCH /api/admin/galleries/:galleryId/cover
Content-Type: application/json 或 multipart/form-data
Body: { assetId } 或 FormData(file)

Response 200:
{ coverKey, coverUrl }
```

### 3.3 数据库现有结构（无需新增 migration）

`media_assets` 表已包含所有必要字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 媒体 ID |
| gallery_id | TEXT FK | 所属图库 |
| type | TEXT | image / video |
| role | TEXT | cover / gallery / preview / full |
| r2_key | TEXT | R2 对象 key（图片） |
| stream_uid | TEXT | Stream 视频 ID |
| original_url | TEXT | 原始外部 URL（迁移用） |
| sort_order | INTEGER | 排序序号 |
| required_rank | INTEGER | 单张 VIP 等级要求（0/10/20） |
| upload_status | TEXT | pending / uploading / processing / completed / failed |
| file_size | INTEGER | 文件大小 |
| width / height | INTEGER | 图片尺寸 |
| created_at | TEXT | 创建时间 |

### 3.4 安全 & 权限

- 所有 `/api/admin/` 接口要求已认证的 admin 或 owner 角色
- 上传文件严格校验 MIME type（不信任前端 Content-Type）
- 图片大小限制 10MB，视频 200MB
- R2 key 不允许 `..` 路径遍历
- 视频上传使用 Stream 直传 URL，不经过 API Worker；上线前按 Cloudflare Workers 当前限制确认请求体和内存边界。
- 所有媒体修改操作写审计日志

---

## 4. 风险 & 路线图

### 4.1 分期路线图

| 阶段 | 内容 | 预计工作量 | 前置条件 |
|------|------|-----------|---------|
| **Phase 1** | Bug 修复（5 个 Bug）✅ 已完成 | 1-2 小时 | 无 |
| **Phase 2A** | 图片上传 + 封面设置 + 媒体列表（图库创建已改为两步流程：基本信息→媒体上传）✅ 已实现 | 3-4 小时 | Phase 1 |
| **Phase 2B** | 视频上传 + Stream 集成（⚠️ Cloudflare Stream 当前未接入） | 2-3 小时 | Phase 2A + Stream API token 就绪 |
| **Phase 2C** | 单张 VIP 配置 + 排序 + 删除 ✅ 已实现 | 1-2 小时 | Phase 2A |
| **Phase 3** | WordPress 图片迁移到 R2 ✅ 已完成 2811 张图片恢复 | 1-2 小时 | Phase 1 |

建议执行顺序：**Phase 1 → Phase 2A → Phase 2C → Phase 3 → Phase 2B**

（Phase 2B 依赖 Cloudflare Stream API token 就绪，可后置）

### 4.2 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Worker 运行时限制 | 大文件上传可能 OOM 或被请求体限制拦截 | 图片限 10MB，视频用 Stream 直传绕过 Worker；上线前按 Cloudflare 官方 limits 复核 |
| Stream API token 未就绪 | 视频上传功能无法测试 | Phase 2B 独立，不阻塞图片功能 |
| WordPress 外部 URL 失效 | 迁移图片下载失败 | 已有 2831 completed 记录说明大部分已下载，对失败的记录日志并跳过 |
| R2 用量增长 | 大量图片可能带来存储和请求成本 | 监控用量，上线前按 Cloudflare 官方 pricing 复核并决定是否升级 |
| Cloudflare Workers 请求体限制 | 大视频上传被拒 | 视频必须走 Stream 直传，不经过 Worker；具体限制以上线前官方文档为准 |

### 4.3 依赖项

| 依赖 | 状态 | 影响 |
|------|------|------|
| D1 migrations | 已维护到 `0019_seed_member_activity.sql` | 部署前需按环境执行所有未应用 migration |
| Cloudflare Stream API token | 占位符 | Phase 2B 视频上传功能 |
| Workers/Email 计划要求 | 待按官方当前状态确认 | 邮箱验证、更大请求体或其他运行时限制 |

---

## 5. 附录

### 5.1 现有文件清单（需修改）

| 文件 | Phase | 修改内容 |
|------|-------|----------|
| `packages/api/src/routes/admin/galleries.ts` | 1+2 | 修复 GET /:id 字段映射，新增媒体上传/管理接口 |
| `packages/api/src/routes/media.ts` | 1 | 修复 cover 接口兼容外部 URL |
| `packages/api/src/routes/galleries.ts` | 1 | 公开列表 API 返回 videoCount |
| `packages/web/app/pages/admin/galleries/index.vue` | 1 | 修复 Set 响应性 |
| `packages/web/app/pages/admin/galleries/[id].vue` | 1+2 | 修复字段映射 + 新增媒体管理 UI |
| `packages/web/app/pages/admin/galleries/new.vue` | 1 | 修复 slug 自动覆盖 |
| `packages/web/app/pages/index.vue` | 1 | 修复视频专区逻辑 |

### 5.2 新增文件

| 文件 | Phase | 说明 |
|------|-------|------|
| `packages/api/src/routes/admin/media.ts` | 2 | 媒体管理 API（独立路由文件） |
| `packages/web/app/components/admin/MediaUploader.vue` | 2 | 图片拖拽上传组件 |
| `packages/web/app/components/admin/MediaGrid.vue` | 2 | 媒体网格管理组件（排序/删除/VIP） |
| `packages/web/app/components/admin/VideoUploader.vue` | 2B | 视频上传组件 |
