# AGENTS.md

## 项目状态

预实现阶段。仓库目前仅包含规划文档，没有源代码、package.json 或构建工具。前端框架尚未选定（技术规格中列出 React 或 Vue 为候选，但未做最终决定）。

## 架构约束

所有组件必须基于 Cloudflare：Pages（前端 + Functions）、D1（数据库）、R2（对象存储）、Stream（视频）、Turnstile（人机验证）。除非明确要求，不得引入非 Cloudflare 基础设施。

## 关键参考文档

| 文件 | 内容 |
|------|------|
| `AGENT.md` | 领域规则、访问控制、批量导入格式、工程准则 |
| `docs/TECHNICAL_SPEC.md` | API 路由、权限模型、模块划分、迁移流程 |
| `docs/PRD.md` | 产品需求文档 |
| `docs/UI_DESIGN.md` | UI 设计初稿 |
| `docs/DEPLOYMENT.md` | Cloudflare 部署方案、环境变量、域名结构 |
| `docs/SOURCE_SITE_AUDIT.md` | 旧站 `zuole.me` WordPress 审计记录 |

生成实现代码前，必须先阅读 `AGENT.md` 和 `docs/TECHNICAL_SPEC.md`，它们定义了 API 结构、权限等级和导入格式。

## 领域规则（不可违反）

- 受保护媒体必须使用服务端会员验证，绝不信任前端检查。
- 会员等级使用数字 `rank` 比较，不硬编码等级名（free=0、vip=10、svip=20）。
- 批量导入格式：zip 包含 `manifest.csv` + 图库目录。单个图库失败不得阻塞其余导入。
- 所有后台修改操作必须写入审计日志。
- 内容边界：仅限合法的写真/时尚/生活/艺术类素材，禁止露骨内容。
- 不开放用户上传，仅管理员可发布。

## 实现启动时的预期工具

（来自部署文档）：
- 包管理器：未选定（优先选择与 Cloudflare Pages 配合最佳的方案）
- 本地开发：Wrangler CLI（`npx wrangler dev` 或框架 dev server）
- 数据库迁移：D1 migrations，放在 `db/` 或类似目录
- 部署：GitHub → Cloudflare Pages Git 集成，生产分支 `main`
- 环境变量：`APP_ENV`、`SESSION_SECRET`、`TURNSTILE_SECRET_KEY`、`R2_BUCKET_NAME`、`STREAM_ACCOUNT_ID`、`STREAM_API_TOKEN`

## 仓库信息

- GitHub：`yyg20101/meigallery-cloudflare`
- 生产分支：`main`
- 语言：中文（内容、UI 文案和文档均使用中文）
