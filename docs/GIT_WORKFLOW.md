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
3. 需要联调或验收时，先部署到 Workers dev 子域，使用真实数据验证但不影响生产主域
4. 完成后合并回 `dev`：`git checkout dev && git merge feature/xxx`
5. 删除已合并的功能分支

### 上线后开发测试

- 已正式上线后，未完成或未验收功能不得直接部署到 `616618.xyz` / `api.616618.xyz`。
- 开发测试使用 `meigallery-web-dev` / `meigallery-api-dev` Worker 和 Workers dev 子域。
- Dev 环境允许读取正式 D1/R2 数据以复现真实内容，但后台写操作必须谨慎执行，并保留审计日志。
- Dev 页面必须带测试环境标识，并避免被生产页面、公开导航、sitemap 或搜索引擎收录。

### 发布上线

1. 从 `dev` 创建发布分支：`git checkout -b release/v0.x.0 dev`
2. 在发布分支上做最终验证和修复
3. 验证通过后，创建 PR 合入 `main`
4. 合入后打 tag：`git tag v0.x.0`
5. 将 `main` 合并回 `dev`：`git checkout dev && git merge main`
6. 删除发布分支

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
| 生产（production） | 手动 `wrangler deploy` | `main` | `meigallery-api` / `meigallery-web` |
| 开发（dev） | 手动 `wrangler deploy --env dev` 或 dev 专用配置 | `dev` / `feature/*` | `meigallery-api-dev` / `meigallery-web-dev` |
| 本地（local） | `pnpm dev` | 任意 | localhost:8787 / localhost:3000 |

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
