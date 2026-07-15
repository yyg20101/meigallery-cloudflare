# Git 版本管理和分支策略

## 分支结构

| 分支 | 用途 | 保护规则 | 部署目标 |
|------|------|----------|----------|
| `main` | 生产分支 | 必须通过 PR 合入，禁止直接推送 | 本地手动部署到生产环境 |
| `dev` | 开发主线 | 允许直接推送，推荐 PR | 本地手动部署到 Workers dev 子域 |
| `feature/*` | 功能分支 | 无保护 | 无自动部署 |
| `fix/*` | 修复分支 | 无保护 | 无自动部署 |
| `release/*` | 发布分支 | 临时创建 | 手动部署验证 |

## 分支流程

### 日常开发

```
main (生产)
  └── dev (开发主线)
        ├── feature/xxx (功能开发)
        └── fix/xxx (缺陷修复)
```

1. 从 `dev` 创建功能分支：`git checkout -b feature/xxx dev`
2. 在功能分支上开发和提交
3. 需要联调或验收时，先部署到 Workers dev 子域，使用独立 dev Cloudflare 资源验证，不影响生产主域和生产数据
4. 完成后合并回 `dev`：`git checkout dev && git merge feature/xxx`
5. 删除已合并的功能分支

### 提交和推送节奏

- 每个可回滚阶段都应及时本地提交，避免未提交改动长时间堆积。
- 非关键、非关联或阶段性文档/整理提交默认不单独推送远端，先保留在本地分支。
- 一个功能闭环完成、需要远端 CI/协作、准备部署，或用户明确要求时，再统一推送到远端。
- 不得为了减少推送而混合无关改动；如果本地已有多个 commit，推送前应确认它们属于同一功能闭环或同一发布批次。
- 生产发布、部署、PR、远端 CI 验证相关变更仍必须按发布流程推送。

### 上线后开发测试

- 已正式上线后，未完成或未验收功能不得直接部署到 `616618.xyz` / `api.616618.xyz`。
- 开发测试使用 `meigallery-web-dev` / `meigallery-api-dev` Worker 和 Workers dev 子域。
- Dev 环境使用独立的 `meigallery-db-dev`、`meigallery-media-dev`，不得回连生产 D1/R2；Meta Queue、Meta secret 和真实 Graph API 调用仅允许 production。
- Dev 页面必须带测试环境标识，并避免被生产页面、公开导航、sitemap 或搜索引擎收录。

### 发布上线

常规发布遵循以下放行链。`Contact`、`Lead`、`CompleteRegistration` 是唯一正式 Meta 事件，`StartTrial` 不支持：

1. 从 `dev` 创建 `release/vX.Y.Z`，完成本地测试、类型检查、构建和 Worker dry-run。
2. 推送 release 分支，通过 GitHub CI 后以 PR 合入 `main`，生产部署只允许从干净的 `main` 执行。
3. release PR/CI 完成完整测试、覆盖率、类型检查、构建和归因隔离门禁；`./scripts/deploy.sh production` 不重复执行整套 `verify:release`。
4. production 只允许从干净 `main` 执行。`0051` 首次切换按 `verify:quick -> preflight -> backup -> Expand -> API/Web -> backfill -> reconcile -> smoke` 执行，任一步失败按阶段停止。
5. 普通业务发布在 `0051` 已应用后跳过一次性旧系统关闭态 preflight、备份和历史回填，不使已验证的平台连接或证据失效。
6. 部署后严格校验两个 Worker 的 release commit 与当前 `main` HEAD 一致。
7. 部署脚本不得修改 Meta/TikTok 的 enabled、mode、rollout、incident 或凭证；新接入平台必须保持默认关闭，待独立验证后再人工启用。
8. 部署后核对 Meta 连接、rollout、Queue/DLQ 和 incident 与部署前一致，并确认 TikTok 仍为关闭态。
9. 稳定后打 tag，将 `main` 合并回 `dev`，再删除 release 分支。

### 紧急修复

1. 从 `main` 创建修复分支：`git checkout -b fix/urgent-xxx main`
2. 修复并验证
3. 创建 PR 合入 `main`
4. 将 `main` 合并回 `dev`

## Commit 规范

### 格式

```
类型: 简要描述

可选的详细说明（多行）
```

### 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat: 实现图库详情页` |
| `fix` | 缺陷修复 | `fix: 修复登录状态丢失` |
| `refactor` | 重构 | `refactor: 提取媒体下载为独立服务` |
| `test` | 测试 | `test: 补充会员到期校验测试` |
| `docs` | 文档 | `docs: 更新部署说明` |
| `deploy` | 部署 | `deploy: 配置 GitHub Actions CI/CD` |
| `style` | 格式 | `style: 统一缩进格式` |
| `chore` | 杂务 | `chore: 升级依赖版本` |

### 规则

- Commit message 使用中文
- 标题行不超过 50 字
- 标题行不以句号结尾
- 每个 commit 只做一件事
- 不得提交包含敏感信息的文件（.env、credentials 等）

## 版本号规范

采用语义化版本（SemVer）：`主版本.次版本.修订号`

- **主版本**：不兼容的 API 变更
- **次版本**：向下兼容的功能新增
- **修订号**：向下兼容的缺陷修复

当前版本：`v0.1.0`（MVP 阶段）

示例标签：
- `v0.1.0` — MVP 首次部署
- `v0.2.0` — 新增 WordPress 迁移
- `v1.0.0` — 正式上线

## 部署环境

| 环境 | 触发方式 | 分支 | Worker 名称 |
|------|----------|------|-------------|
| 生产（production） | 手动 `corepack pnpm --filter ... exec wrangler deploy --env=""` | `main` | `meigallery-api` / `meigallery-web` |
| 开发（dev） | 手动 `./scripts/deploy.sh dev` 或 dev 专用配置 | `dev` / `feature/*` | `meigallery-api-dev` / `meigallery-web-dev` |
| 本地（local） | `corepack pnpm dev` | 任意 | localhost:8787 / localhost:3000 |

## 代码审查

### 合入 main 的 PR 要求

1. 至少通过 CI 检查（构建 + 测试）
2. 描述清楚变更内容和原因
3. 关联相关 issue（如有）

### 审查要点

- 是否符合访问控制规则（服务端校验、rank 比较）
- 是否有审计日志
- 是否有测试覆盖
- 是否影响现有功能
- commit message 是否规范

## .gitignore 规范

以下目录和文件不得提交：

```
node_modules/
.output/
.wrangler/
.nuxt/
dist/
.env
.env.local
.dev.vars
```
