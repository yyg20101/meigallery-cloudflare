# Phase 2 性能降本与 Cases 去 Testimonials 化设计

## 背景

Phase 1 已完成生产安全边界加固。Phase 2 继续处理性能与成本问题，同时把真实案例业务从 `testimonial(s)` 命名彻底迁移为 `case(s)`。本阶段采用破坏性清理：不保留 `/testimonials` 旧路由，不保留 `/api/testimonial-cases` 兼容 API，生产 D1 旧表和 R2 旧前缀也在校验后删除。

用户已确认前期缩略图业务仍允许使用原图替代。结合 Cloudflare Images Free 方案，本阶段可以在不迁移图片存储、不购买 Images Paid 的前提下启用 Transformations 作为优先优化路径，并保留原图 fallback。图片传输体积下降纳入优化目标，但不作为阻断发布的硬验收指标。

## 目标

- 首页 SSR API 请求数下降至少 30%。
- 公开列表和搜索避免高成本随机排序与不必要的昂贵统计。
- 保留 `/cases` 真实案例业务，但项目业务代码、API、后台路径、导入类型、D1 表和 R2 前缀不再使用 `testimonial(s)` 命名。
- 生产迁移完成后删除旧 D1 `testimonial_*` 表和 R2 `testimonials/` 前缀对象。

## 非目标

- 本阶段不接入 Cloudflare Images 存储能力，不迁移 R2 原图到 Images bucket。
- 本阶段不购买 Images Paid 方案。
- 本阶段不强制降低图片列表传输体积 50%，但会通过 Free Transformations 尽量降低列表图体积。
- 本阶段不新增 Cloudflare KV、Queue、Analytics Engine 或其他资源。
- 本阶段不保留 `/testimonials` 旧链接兼容。

## Phase 2 性能降本设计

### 首页请求收敛

首页当前包含图库列表、热门图库、精选真实案例和真实案例 fallback 多个 SSR 请求。迁移后首页移除真实案例双请求，仅保留图库主数据和必要的热门数据。若热门推荐可以从首个图库响应中推导，则优先合并为单次 `/api/galleries` 请求；如果需要保留热度排序，则最多保留两个图库请求。

验收口径：`packages/web/app/pages/index.vue` 首页 SSR 的业务 API 请求数从 4 个降到最多 2 个。

### 随机排序降本

公开图库和搜索中的 `ORDER BY RANDOM()` 会触发高成本全表排序。本阶段移除或替换公开随机排序：

- `/discover` 不再展示“随机”排序入口，保留“最新”和“最热”。
- API 收到 `sort=random` 时降级为 `newest` 或确定性排序，不再生成 `ORDER BY RANDOM()`。
- 更新对应测试，确保公开查询 SQL 不包含 `ORDER BY RANDOM()`。

### 公开统计查询降本

公开列表和搜索中存在 `COUNT(DISTINCT)`、多标签 `HAVING COUNT(DISTINCT)` 和模糊搜索组合。首期优化原则是避免在非必要场景计算精确总数：

- 普通公开列表优先使用简单 `COUNT(*)`。
- 带标签或搜索的复杂查询允许返回 `hasMore`，不强制返回精确 `total`。
- 前端无限加载以 `hasMore` 为准，`total` 仅作为可选展示。
- 保留现有行为需要时，复杂统计只在第一页或显式请求时执行。

### 图片策略

Cloudflare Images Free 每月包含 5,000 个 unique transformations，可用于优化 R2 等 Images 外部来源图片。首期图片策略如下：

- 启用 zone 级 Images Transformations 后，把生产 `IMAGE_RESIZING_ENABLED` 设置为 `true`。
- 只生成一个列表规格：`width=480`、`fit=scale-down`、`quality=80`、`format=auto`。如果 Workers `cf.image` 不支持 `format=auto`，则保持现有 `format=webp`。
- 详情页前期复用 `w=480`，不新增 `w=800` 等第二规格，避免免费额度被多规格快速消耗。
- transformation 成功时返回优化图，并设置长缓存。
- transformation 失败、未启用、或达到 Free 限额返回 `9422` 时，继续 fallback 到原图，保持业务可用。
- 不在本阶段使用响应式多尺寸 `srcset`，避免每张图片生成多个 unique transformations。

该策略可以在不新增付费资源的情况下减少列表图体积和后续 R2 回源读取，同时保留原图替代作为前期兜底。

## Cases 去 Testimonials 化设计

### 前端路由与组件

- 保留公开路由：`/cases`、`/cases/:slug`。
- 删除旧路由：`/testimonials`、`/testimonials/:slug`。
- 后台路由从 `/admin/testimonials` 改为 `/admin/cases`。
- 组件重命名：`TestimonialCard` -> `CaseCard`，`TestimonialCarousel` -> `CaseCarousel`，`TestimonialGallery` -> `CaseGallery`。
- 页面和组件变量、类型、空状态文案统一使用“案例”或 `case`。

### API 路由

- 公开 API 改为 `/api/cases`、`/api/cases/:slug`、`/api/cases/images/:imageId`。
- 后台 API 改为 `/api/admin/cases/**`。
- 删除 `/api/testimonial-cases` 和 `/api/admin/testimonial-cases` 注册。
- 路由文件和测试文件统一改名为 `cases.ts`、`cases.test.ts`。
- 工具文件从 `utils/testimonial-cases.ts` 改为 `utils/cases.ts`。

### Telegram 导入与 Import Token

- 导入类型从 `testimonial_case` 改为 `case`。
- 权限从 `testimonial:create` 改为 `case:create`。
- 旧类型和旧权限不再接受。
- 外部导入记录的 `target_type` 迁移为 `case`。
- 审计 action 从 `telegram_import.create_testimonial_case` 迁移为 `telegram_import.create_case`。

### D1 迁移

新增迁移负责数据库命名清理：

1. 创建 `cases` 表，字段与原 `testimonial_cases` 等价。
2. 创建 `case_images` 表，字段与原 `testimonial_case_images` 等价，外键指向 `cases(id)`。
3. 从 `testimonial_cases` 复制数据到 `cases`。
4. 从 `testimonial_case_images` 复制数据到 `case_images`，同时把 `r2_key` 的 `testimonials/` 前缀迁移为 `cases/`。
5. 更新 `external_import_records.target_type` 中的 `testimonial_case` 为 `case`。
6. 更新审计日志中明确的 testimonial action 和 target type。
7. 校验迁移行数后删除 `testimonial_case_images` 和 `testimonial_cases`。

迁移需要兼容空表场景。生产库应存在旧表；如果旧表不存在，部署前检查必须中止并提示人工确认，避免误判为已迁移。

### R2 对象迁移与删除

新增一次性脚本执行 R2 对象迁移：

1. 在 D1 切表前查询 `testimonial_case_images.r2_key`，生成 `testimonials/...` 到 `cases/...` 的复制清单。
2. dry-run 输出将复制和将删除的对象数量，不修改 R2 或 D1。
3. 正式执行复制，把每个 `testimonials/{caseId}/...` 对象复制到 `cases/{caseId}/...`。
4. 验证目标对象存在且大小一致。
5. 执行 D1 migration，把业务读取切到 `case_images.r2_key = cases/...`。
6. 二次验证所有 `case_images.r2_key` 对象可读。
7. 删除旧 `testimonials/` 前缀对象。

该脚本必须支持 dry-run，并输出复制数、跳过数、删除数和失败列表。生产执行必须先 dry-run，再正式执行。

## 测试与验证

- API 类型检查：`pnpm --filter @meigallery/api exec tsc --noEmit`。
- API 测试：覆盖 cases 公开路由、后台路由、导入类型、权限迁移、随机排序降级和 Images transformation fallback。
- Web 构建：`pnpm --filter @meigallery/web exec nuxt build`。
- R2 脚本验证：先 dry-run，再在 dev/测试 bucket 上验证复制和旧前缀删除。
- 迁移验证：本地或 dev D1 在 R2 复制完成后执行新迁移，确认旧表删除、新表行数一致。
- 生产 smoke：`/api/health`、`/`、`/cases`、`/api/cases` 返回正常；`/testimonials` 返回 404。

## 风险与回滚

- D1 旧表删除和 R2 旧对象删除不可逆。生产执行前必须确认备份或确认可接受不可逆清理。
- 旧链接 `/testimonials` 失效是预期行为，可能影响外部历史链接。
- Telegram Bot 或外部调用方如果仍发送 `testimonial_case`，会收到校验失败，需要同步改为 `case`。
- Images Free Transformations 每月只有 5,000 个 unique transformations。超过后新 transformation 会失败，因此必须保留原图 fallback。
- 图片仍允许使用原图 fallback，图片带宽成本下降幅度取决于免费 transformation 命中率和缓存命中率。

## 实施顺序

1. 先实现 cases 命名迁移和测试改名，确保业务可编译。
2. 再实现 D1 migration 和 R2 一次性迁移脚本。
3. 再实现 Phase 2 首页请求收敛、随机排序移除和统计查询降本。
4. 完整运行类型检查、测试和 Web 构建。
5. dev/本地按“R2 dry-run -> R2 复制 -> D1 迁移 -> R2 删除旧前缀”的顺序验证。
6. 提交、推送并按既定流程部署。
