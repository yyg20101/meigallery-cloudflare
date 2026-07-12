# MeiGallery Cloudflare 开发指南

## 语言规范

本项目所有交互和产出统一使用**中文**，包括但不限于：

- AI 问答和对话
- 文档书写（PRD、技术设计、部署说明等）
- UI 设计稿和交互描述
- 代码注释和 commit message
- 前台界面文案和后台界面文案

仅以下内容保留英文：Cloudflare 产品名、代码标识符（变量名、组件名、API 路径）、通用技术缩写（API、URL、SEO 等）。

## 项目状态

脚手架已完成。仓库为 **pnpm monorepo**，前后端分离：
- `packages/web`：Nuxt 4 前端，部署为 Cloudflare Worker（Nitro preset `cloudflare-module`）。
- `packages/api`：Hono 后端 API，部署为独立 Cloudflare Worker。
- `packages/shared`：共享类型和常量。

## 项目目标

中文响应式图库平台，展示经过授权的写真、时尚、生活、艺术类图片和视频内容。支持公开浏览、标签搜索、登录、手动会员等级发放、受保护媒体访问和后台管理控制台（含批量导入）。以 Cloudflare 为唯一运行时和基础设施平台。

## 产品边界

- 内容定位：面向所有受众，仅限合法的写真、时尚、生活、艺术类素材，不允许露骨内容。
- 仅管理员可发布内容，不开放用户上传。
- 首期不接入在线支付，用户联系站长后由管理员手动授予会员等级和有效期。
- 不做爬虫或第三方自动采集，所有媒体必须有明确授权和版权来源。
- 不实现任何绕过年龄、知情同意、版权或隐私要求的功能。

## Cloudflare 架构

所有组件必须基于 Cloudflare，除非明确要求不得引入非 Cloudflare 基础设施：

- 前端：Cloudflare Workers（Nuxt 4，Nitro preset `cloudflare-module`，含 Workers Assets 静态资源托管）。
- API：Cloudflare Workers（Hono 框架，独立 Worker）。
- 数据库：Cloudflare D1。
- 图片和导入包存储：Cloudflare R2。
- 视频上传、编码、播放和访问控制：Cloudflare Stream（当前未接入，相关配置为规划能力）。
- 人机验证：Cloudflare Turnstile。
- 安全控制：Cloudflare WAF、速率限制、签名 URL 和服务端权限校验。

注意：**不使用 Cloudflare Pages**，所有部署均通过 Workers + Workers Assets。当前项目决策是把 Web 和 API 都作为独立 Worker 维护，避免 Pages 与 Workers 双平台状态分叉。

添加 Cloudflare 配置时，务必核对当前官方文档，不要依赖过时的数字限制、价格或 API 细节。

## 核心领域概念

- 图库（Gallery）：已发布或草稿状态的内容单元，包含标题、描述、封面、标签、图片、视频和所需会员等级。
- 标签（Tag）：按类型分组的可搜索分类值，类型包括地区范围、地区组、城市/国家、身份、性格、风格、职业、发型、服饰、场景、内容类型。
- 会员等级（Membership Level）：手动管理的访问层级，可设置有效期。
- 受保护媒体（Protected Media）：需要登录或特定会员等级才能访问的图片或视频。
- 导入任务（Import Job）：批量上传工作流，解析本地包、校验文件、创建草稿图库、上传媒体并报告失败。

## 访问控制规则（不可违反）

- 受保护媒体绝不信任前端检查，必须由服务端验证会员资格。
- 私有 R2 对象和 Stream 播放必须经过服务端会员等级校验后发放短期访问凭证。
- 会员到期后必须自动失去对应权限。
- 后台路由必须要求已认证的管理员角色。
- 所有后台修改操作必须写入审计日志。
- 会员等级比较使用数字 `rank`，不硬编码等级名称（free=0、vip=10、svip=20）。

## 批量导入标准

默认导入格式为 zip 包：

```text
gallery-import.zip
  manifest.csv
  gallery-001/
    content.md
    cover.jpg
    images/
      001.jpg
      002.jpg
    videos/
      preview.mp4
      full.mp4
```

`manifest.csv` 字段：

```csv
folder,title,slug,region,personality,style,tags,required_level,status
gallery-001,夏日写真,summer-portrait-001,广东,甜美,清新,"长发,户外,视频",vip,draft
```

校验规则：

- `manifest.csv`、`content.md`、`cover.jpg` 为必填。
- 每个图库目录至少包含一张图片。
- `videos/preview.mp4` 和 `videos/full.mp4` 可选。
- 未知标签在校验通过后自动创建。
- 导入图库默认为草稿，除非 Owner 角色显式设置 `status=published`。
- 单个图库失败不得阻塞包内其他图库的导入。

## 工程准则

- 优先使用小型、有类型、可测试的模块。
- 管理员 API 和公开 API 权限严格分离。
- 数据库变更使用 migration 管理。
- 业务逻辑中避免硬编码会员名称，使用等级 rank 或配置化权限判断。
- 原始媒体存储在私有 bucket 或受保护服务中，公开变体通过显式 URL 分发。
- 为权限校验、导入解析、会员到期和搜索过滤编写重点测试。

## Git 分支策略

详细规范见 `docs/GIT_WORKFLOW.md`。核心要点：

| 分支 | 用途 | 部署方式 |
|------|------|----------|
| `main` | 生产分支 | PR 合入后手动部署生产 |
| `dev` | 开发主线 | 手动 `./scripts/deploy.sh dev` |
| `feature/*` | 功能分支（从 dev 创建） | 无部署 |
| `fix/*` | 修复分支 | 无部署 |

规则：
- **禁止直接推送 main**，必须通过 PR 从 dev/release/fix 分支合入。
- 日常开发在 `dev` 分支进行，功能分支从 `dev` 拉出。
- 非关键、非关联或阶段性文档/整理提交默认只保留本地提交，不单独推送远端；等一个功能闭环、需要远端 CI/协作、准备部署或用户明确要求时，再统一推送。
- 发布上线：从 `dev` 创建 `release/vX.Y.Z` 分支 → 验证 → PR 合入 `main` → 打 tag。
- 紧急修复：从 `main` 创建 `fix/urgent-xxx` → PR 合入 `main` → 合并回 `dev`。
- Commit message 格式：`类型: 简要描述`（中文），类型包括 feat/fix/refactor/test/docs/deploy/style/chore。

## 部署流程

| 环境 | 触发 | Worker 名称 |
|------|------|-------------|
| 生产 | 手动 `./scripts/deploy.sh production` 或等价 wrangler 命令 | `meigallery-api` / `meigallery-web` |
| 开发 | 手动 `./scripts/deploy.sh dev` | `meigallery-api-dev` / `meigallery-web-dev` |
| 本地 | `corepack pnpm dev` | localhost:8787 / localhost:3000 |

CI 配置位于 `.github/workflows/`：
- `ci.yml`：PR 和 dev 推送触发，运行测试 + 类型检查 + 构建验证
- 当前没有生产自动部署 workflow；GitHub Actions 不负责生产部署，避免合入 `main` 后自动影响线上用户。

首次部署前需执行 `./scripts/setup.sh` 创建 Cloudflare 资源。

## 任务完成流程

每完成一个任务阶段，必须按以下顺序执行：

1. **更新进度**：标记当前任务为已完成，记录产出物。
2. **验证构建**：运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit` 和 `corepack pnpm --filter @meigallery/web exec nuxt build` 确认无阻断性错误。
3. **提交代码**：`git add -A && git commit -m "..."` ，commit message 使用中文，格式为 `类型: 简要描述`。
4. **按需推送远端**：关键功能闭环、需要远端 CI/协作、准备部署或用户明确要求时执行 `git push`。在 `dev` 分支开发时推送到 `origin/dev`，上线通过 PR 合入 `main`。非关键、非关联或阶段性提交先保留本地，避免远端分支和 CI 被碎片化提交打扰。

不得跳过进度记录、验证和本地提交；不得为了“统一推送”而长期不提交本地改动。推送可以按功能闭环合并执行，但每个可回滚阶段仍需形成清晰 commit。

## 实现启动时的预期工具

- 前端框架：**Nuxt 4**（Nitro preset `cloudflare-module`）
- 后端框架：**Hono**（Cloudflare Workers 原生）
- UI 框架：前台 **Tailwind CSS v4** + 自定义组件，后台 **Nuxt UI v4**
- 组件预览：当前未配置 Histoire；如后续接入需同步更新依赖和脚本
- 包管理器：pnpm（workspace monorepo）；本机若没有裸 `pnpm` 命令，统一使用 `corepack pnpm`
- 本地开发：`corepack pnpm dev`（同时启动 web:3000 和 api:8787）
- 数据库迁移：D1 migrations，放在 `packages/api/migrations/`
- 部署：生产顶层环境显式使用 `corepack pnpm --filter ... exec wrangler deploy --env=""`（两个 Worker 各自独立部署），CI 仅通过 GitHub Actions 做验证
- 环境变量：`SESSION_SECRET`、`TURNSTILE_SECRET_KEY`、`STREAM_ACCOUNT_ID`、`STREAM_API_TOKEN`、`NUXT_PUBLIC_API_BASE_URL`

## 关键参考文档

| 文件 | 内容 |
|------|------|
| `docs/PROJECT_STATUS.md` | 当前实现、部署、分支和真实案例路径状态索引 |
| `docs/PRD.md` | 产品需求文档 |
| `docs/TECHNICAL_SPEC.md` | API 路由、权限模型、模块划分、迁移流程 |
| `docs/UI_DESIGN.md` | UI 设计初稿 |
| `docs/UI_DATA_ANALYTICS_DASHBOARD.md` | 后台数据分析看板设计 |
| `docs/DEPLOYMENT.md` | Cloudflare 部署方案、环境变量、域名结构 |
| `docs/GIT_WORKFLOW.md` | Git 分支策略、Commit 规范、版本号规范 |
| `docs/TELEGRAM_IMPORT_API.md` | Telegram 外部导入 API 对接契约 |
| `docs/SEO_CONFIGURATION.md` | SEO 关键词和运营配置说明 |

生成实现代码前，必须先阅读本文件和 `docs/TECHNICAL_SPEC.md`。

## 仓库信息

- GitHub：`yyg20101/meigallery-cloudflare`
- 生产分支：`main`
