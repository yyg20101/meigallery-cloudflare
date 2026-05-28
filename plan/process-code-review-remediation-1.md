---
goal: 按优先级修复代码与文档 Review 问题
version: 1.0
date_created: 2026-05-26
last_updated: 2026-05-29
owner: MeiGallery
status: 'In progress'
tags: [process, remediation, quality, ci, security]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

本计划用于按优先级修复 `docs/CODE_AND_DOC_REVIEW_ISSUES.md` 中记录的问题，并为每个阶段提供可验证的完成标准。当前执行顺序为 P1 工程阻断与安全一致性优先，随后处理 P2 架构、文档和测试缺口，最后收敛 P3 工程卫生和长期维护项。

## 1. Requirements & Constraints

- **REQ-001**: 所有交流、文档、提交信息和 UI 文案使用中文，Cloudflare 产品名、代码标识符和通用技术缩写可保留英文。
- **REQ-002**: 每个问题必须在 `docs/CODE_AND_DOC_REVIEW_ISSUES.md` 中维护状态、优先级、当前进度和下一步。
- **REQ-003**: 每个修复阶段完成后必须运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit` 和 `corepack pnpm --filter @meigallery/web exec nuxt build`。
- **REQ-004**: 涉及前端类型修复的阶段必须额外运行 `corepack pnpm --filter @meigallery/web typecheck`。
- **REQ-005**: 涉及 API 安全逻辑的阶段必须额外运行相关 API 单元测试或 `corepack pnpm --filter @meigallery/api test`。
- **SEC-001**: 受保护媒体、管理员路由、会员权限、密码校验、速率限制和 Turnstile 相关改动不得降低当前服务端校验强度。
- **SEC-002**: 新增日志、错误详情、审计字段或测试夹具不得泄露 token、cookie、Telegram Bot Token、R2 key 或用户密码。
- **CON-001**: 不引入非 Cloudflare 基础设施；生产限流、可观测性和异步能力优先使用 Cloudflare WAF、Rate Limiting Rules、Workers Logs、Queues、Workflows、D1、R2 或 Durable Objects。
- **CON-002**: 不直接修改 `main`；当前开发分支为 `dev`，阶段性提交后推送到 `origin/dev`。
- **GUD-001**: 每个阶段只修复一个优先级清晰的问题组，避免多个风险点混在同一个提交中。
- **PAT-001**: 修复代码前先确认真实失败输出和现有实现，避免只按文档推断。

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: 修复 P1-01 Web 类型检查失败，并将 Web typecheck 加入 CI。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 运行 `corepack pnpm --filter @meigallery/web typecheck`，记录当前失败点到 `docs/CODE_AND_DOC_REVIEW_ISSUES.md` 的 P1-01 状态说明。 | ✅ | 2026-05-26 |
| TASK-002 | 将 `packages/shared/src/types/index.ts` 中的 Cloudflare Worker binding 类型移动到 API-only 类型文件，确保 Web 不再消费 `D1Database` 和 `R2Bucket`。 | ✅ | 2026-05-26 |
| TASK-003 | 修复 `packages/web/app/components/TagFilterTabs.vue` 的数组索引和可选值类型错误。 | ✅ | 2026-05-26 |
| TASK-004 | 修复 `packages/web/app/pages/admin/contact-methods.vue` 的数组解构、平台配置可选值和模板类型错误。 | ✅ | 2026-05-26 |
| TASK-005 | 修复 `packages/web/app/pages/admin/settings.vue` 的字符串与布尔值比较错误。 | ✅ | 2026-05-26 |
| TASK-006 | 修复 `packages/web/app/pages/discover.vue` 的可选值和标签类型错误。 | ✅ | 2026-05-26 |
| TASK-007 | 在 `.github/workflows/ci.yml` 增加 `pnpm --filter @meigallery/web typecheck` 步骤。 | ✅ | 2026-05-26 |
| TASK-008 | 验证 `corepack pnpm --filter @meigallery/web typecheck`、API 类型检查和 Web 构建全部通过。 | ✅ | 2026-05-26 |

### Implementation Phase 2

- GOAL-002: 统一 P1-02 生产速率限制实现、配置和文档。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | 对齐 `packages/shared/src/constants/index.ts`、`packages/api/src/index.ts` 和 `docs/TECHNICAL_SPEC.md` 中登录/注册限流值。 | ✅ | 2026-05-26 |
| TASK-010 | 明确应用内内存限流仅作为本地和单 isolate 保护，生产强限流由 Cloudflare WAF / Rate Limiting Rules 承担。 | ✅ | 2026-05-26 |
| TASK-011 | 补充登录/注册、媒体访问接口、管理员 API 和公开 API 的限流测试或配置验收说明。 | ✅ | 2026-05-26 |
| TASK-012 | 更新 `docs/DEPLOYMENT.md` 的生产限流配置步骤和回滚说明。 | ✅ | 2026-05-26 |

### Implementation Phase 3

- GOAL-003: 统一 P1-03 密码哈希策略，并补强校验实现。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | 确认 Workers 当前使用 PBKDF2 作为正式策略，并在 `docs/PRD.md` 与 `docs/TECHNICAL_SPEC.md` 中删除 bcrypt/argon2 当前态表述。 | ✅ | 2026-05-26 |
| TASK-014 | 在 `packages/api/src/utils/password.ts` 中实现 timing-safe hash 比较。 | ✅ | 2026-05-26 |
| TASK-015 | 补充 `packages/api/src/utils/password.test.ts`，覆盖无效格式、错误密码、不同 salt、timing-safe 比较长度不一致路径。 | ✅ | 2026-05-26 |
| TASK-016 | 记录后续密码算法版本化升级策略和重新哈希触发条件。 | ✅ | 2026-05-26 |

### Implementation Phase 4

- GOAL-004: 处理 P2 文档、架构和测试缺口。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | P2-01：按当前 Wrangler schema 为 `packages/api/wrangler.toml` 和 `packages/web/wrangler.toml` 增加 observability 配置，并记录 compatibility date 更新流程。 | ✅ | 2026-05-26 |
| TASK-018 | P2-02：将 zip 批量导入文档拆为当前 JSON/校验任务实现和后续完整 R2 直传异步导入设计。 | ✅ | 2026-05-26 |
| TASK-019 | P2-03：明确受保护图片当前采用 Worker 代理流，更新 `docs/TECHNICAL_SPEC.md` 并调整误导性命名或注释。 | ✅ | 2026-05-26 |
| TASK-020 | P2-04：接入 Playwright smoke，覆盖 `/`、`/search`、图库详情、登录、用户中心和后台首页的多视口检查。 | ✅ | 2026-05-26 |
| TASK-021 | P2-05：拆分 dev D1/R2 资源，或在 dev 后台增加正式数据风险标识和二次确认。 | ✅ | 2026-05-29 |
| TASK-022 | P2-06：统一 Turnstile 覆盖范围文档和实现，明确后台复用普通登录或新增敏感操作校验。 | ✅ | 2026-05-29 |
| TASK-023 | P2-07：建立后台写操作审计覆盖矩阵，并补旧站迁移入口测试。 | ✅ | 2026-05-29 |
| TASK-024 | P2-08：定义统一 API 错误响应 helper，并逐步替换散落的 `{ error }` 响应。 | ✅ | 2026-05-29 |

### Implementation Phase 5

- GOAL-005: 处理 P3 工程卫生和长期维护项。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | P3-01：为主要 PRD 和技术文档段落增加当前状态标签。 |  |  |
| TASK-026 | P3-02：统一图片上传限制为当前 10MB，或明确不同入口差异。 |  |  |
| TASK-027 | P3-03：接入 ESLint / 格式化策略，并以渐进方式加入 CI。 |  |  |
| TASK-028 | P3-04：为 Vitest 增加 coverage provider、核心模块阈值和 CI artifact。 |  |  |
| TASK-029 | P3-05：逐步把大型后端路由中的业务流程抽到 service/helper。 |  |  |
| TASK-030 | P3-06：在 Stream 接入前保持 UI 隐藏或维护态，并让 API 在缺少 Stream secrets 时返回明确配置错误。 |  |  |

## 3. Alternatives

- **ALT-001**: 一次性修复全部 P1/P2/P3。未采用，因为安全、类型、文档和基础设施改动混合后验证成本高，回滚粒度差。
- **ALT-002**: 只更新文档，不修复代码。未采用，因为 P1-01、P1-02、P1-03 均包含真实实现风险。
- **ALT-003**: 先做 P2/P3 工程卫生。未采用，因为 Web typecheck 和安全一致性问题优先级更高。

## 4. Dependencies

- **DEP-001**: Node.js >= 20 和 pnpm 9.14.2。
- **DEP-002**: 当前 Nuxt 4、Vue 3、Vite、Hono、Wrangler 和 Vitest 版本组合。
- **DEP-003**: Cloudflare Dashboard 中的 D1、R2、Workers Logs、WAF / Rate Limiting Rules、Turnstile 和 Stream 当前配置。
- **DEP-004**: GitHub Actions 当前 workflow：`.github/workflows/ci.yml`。

## 5. Files

- **FILE-001**: `docs/CODE_AND_DOC_REVIEW_ISSUES.md`：主问题台账和状态跟踪。
- **FILE-002**: `docs/PROJECT_STATUS.md`：当前状态索引。
- **FILE-003**: `.github/workflows/ci.yml`：CI 类型检查、测试和构建步骤。
- **FILE-004**: `packages/shared/src/types/index.ts`：共享类型边界。
- **FILE-005**: `packages/api/src/**`：API 安全、密码、限流、媒体、审计和错误响应实现。
- **FILE-006**: `packages/web/app/**`：前端类型、UI 状态和 Playwright smoke 覆盖对象。
- **FILE-007**: `docs/PRD*.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`：当前态与规划态修正。
- **FILE-008**: `packages/api/wrangler.toml`、`packages/web/wrangler.toml`：Worker 配置。

## 6. Testing

- **TEST-001**: 每个阶段运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit`。
- **TEST-002**: 每个阶段运行 `corepack pnpm --filter @meigallery/web exec nuxt build`。
- **TEST-003**: P1-01 运行 `corepack pnpm --filter @meigallery/web typecheck`。
- **TEST-004**: P1-02 和 P1-03 运行 `corepack pnpm --filter @meigallery/api test` 或精确相关测试文件。
- **TEST-005**: P2-04 运行 Playwright smoke，并覆盖 360px、768px、1024px、1440px 视口。
- **TEST-006**: P3-04 生成 coverage 报告并确认核心安全模块阈值。

## 7. Risks & Assumptions

- **RISK-001**: Web typecheck 可能暴露更多由 Nuxt/Volar 版本组合带来的类型错误，需要保持小步修复。
- **RISK-002**: Cloudflare WAF / Rate Limiting Rules 属于 Dashboard 或账号级配置，代码仓库只能记录配置清单和验证步骤。
- **RISK-003**: dev D1/R2 拆分需要实际 Cloudflare 资源创建和迁移，可能需要运维确认。
- **RISK-004**: Playwright 引入可能增加 CI 时间，需要先做 smoke 范围。
- **ASSUMPTION-001**: 当前分支 `dev` 是日常开发主线，修复提交推送到 `origin/dev`。
- **ASSUMPTION-002**: 当前密码哈希实现可以接受 PBKDF2 作为 Workers 兼容策略，除非后续明确切换到 argon2/bcrypt。

## 8. Related Specifications / Further Reading

- `docs/CODE_AND_DOC_REVIEW_ISSUES.md`
- `docs/PROJECT_STATUS.md`
- `docs/TECHNICAL_SPEC.md`
- `docs/DEPLOYMENT.md`
- `docs/PRD_QUALITY_REVIEW.md`
- `docs/UI_QUALITY_REVIEW.md`
