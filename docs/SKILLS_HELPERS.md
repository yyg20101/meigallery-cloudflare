# Skills 帮手规划

## 1. 使用原则

- 需求、范围、验收标准：使用 `prd`。
- Cloudflare 架构、部署、Workers、D1/R2/Stream：使用 `cloudflare:cloudflare`，必要时追加 `cloudflare:wrangler`、`cloudflare:workers-best-practices`、`cloudflare:web-perf`。
- 寻找新技能：使用 `find-skills`，优先查找高安装量、可信来源、活跃维护的技能。
- UI、可访问性、测试、代码审查使用专门技能，避免一个助手承担所有判断。

## 2. 当前推荐技能组合

产品和文档:

- `prd`：PRD、用户故事、验收标准、路线图。
- `api-documentation-generator`：后续生成 API 文档。
- `architecture-decision-records`：记录重要技术决策。

Cloudflare 和部署:

- `cloudflare:cloudflare`：Cloudflare 平台总体方案。
- `cloudflare:wrangler`：Wrangler 配置、D1/R2 bindings、本地开发和部署。
- `cloudflare:workers-best-practices`：Workers API 设计和运行时实践。
- `cloudflare:web-perf`：缓存、性能、Core Web Vitals。

前端和 UI:

- `design-system-patterns`：设计系统、组件规范、视觉一致性。
- `accessibility` 或 `accessibility-compliance`：无障碍检查。
- `design-to-code`：将 UI 设计转为可实现页面。
- `app-builder`：搭建可用的前后台应用体验。

后端和数据:

- `database-design`：D1 表结构、索引、关系设计。
- `api-design-principles`：REST API 和权限边界。
- `auth-implementation-patterns`：登录、会话、角色权限。
- `backend-patterns`：服务端模块组织。

测试和质量:

- `e2e-testing-patterns`：端到端测试。
- `code-review-excellence`：代码审查。
- `debugging-strategies`：问题定位。
- `SEO Optimizer`：前台 SEO 和元信息。

## 3. 后续阶段建议

阶段 1：需求和设计

- 使用 `prd` 维护需求。
- 使用 `design-system-patterns` 和 `accessibility` 产出 UI 规范。
- 使用 `database-design` 产出 schema。

阶段 2：技术落地

- 使用 `cloudflare:wrangler` 配置 Workers、Workers Assets、D1、R2。
- 使用 `api-design-principles` 定义 API。
- 使用 `auth-implementation-patterns` 设计登录和权限。

阶段 3：开发和验证

- 使用 `app-builder` 实现前后台。
- 使用 `e2e-testing-patterns` 编写关键流程测试。
- 使用 `cloudflare:web-perf` 优化页面和缓存。

阶段 4：发布和运营

- 使用 `cloudflare:cloudflare` 完成域名、CDN、安全和部署配置。
- 使用 `SEO Optimizer` 完成前台 SEO。
- 使用 `code-review-excellence` 做上线前审查。

## 4. find-skills 搜索计划

后续如果需要安装更多技能，按以下关键词搜索：

- `npx skills find react ui design`
- `npx skills find cloudflare workers`
- `npx skills find playwright e2e`
- `npx skills find accessibility audit`
- `npx skills find api documentation`
- `npx skills find database schema`
- `npx skills find seo`

推荐前必须核验：

- 安装量优先选择 1K+。
- 来源优先选择官方、知名组织或高星仓库。
- 查看 README 是否清楚说明适用场景。
- 不安装来源不明且权限要求过大的技能。
