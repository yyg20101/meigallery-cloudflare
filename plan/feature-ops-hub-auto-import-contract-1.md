---
goal: 验证 MeiGallery 与 Ops Hub 自动导入契约
version: 1.0
date_created: 2026-06-26
last_updated: 2026-06-26
owner: MeiGallery
status: 'Planned'
tags: [feature, telegram-import, ops-hub, contract, tests]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

本计划用于确认 MeiGallery 作为 Ops Hub 自动导入接收端的能力完整性。当前 MeiGallery 不实现 Telegram Bot，也不解析 caption；平台只接收 Ops Hub 已标准化的 `gallery` / `case` JSON payload，校验 Import Token、`sourceBotKey`、幂等键和文件约束，并创建图库或真实案例草稿。

## 1. Requirements & Constraints

- **REQ-001**: `metadata.type` 只接受 `gallery` / `case`，必须拒绝旧 `testimonial_case`。
- **REQ-002**: Import Token 权限继续使用 `gallery:create` / `case:create`。
- **REQ-003**: `sourceBotKey` 必须命中 Import Token 的 `allowedSourceBotKeys`。
- **REQ-004**: MeiGallery 不解析 `#gallery`、`#case` 或 Telegram caption；caption parser 属于 Ops Hub 仓库。
- **REQ-005**: 重复 `token + source + externalMessageId` 返回 `duplicate`，不创建第二个草稿。
- **REQ-006**: 后台 `/admin/external-import-records` 必须可查看导入记录、文件状态、错误摘要和目标草稿链接。
- **SEC-001**: API 响应、后台页面、审计日志和测试 fixture 不得泄露 Import Token 明文、Telegram Bot Token、Telegram 下载 URL 或 R2 私有 key。
- **SEC-002**: `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>` 只能作为 Worker secret 配置，不写入仓库、D1、日志或响应体。
- **CF-001**: 继续使用 Cloudflare Workers、D1、R2 和 `waitUntil`，不引入 Cloudflare Pages 或非 Cloudflare 运行时。
- **CON-001**: 不在 MeiGallery 中新增 Telegram Bot 监听器、Webhook 或 caption parser。
- **CON-002**: 不改变现有公开 API 路径：`POST /api/imports/telegram-file-id`、`GET /api/imports/:importId`、`POST /api/imports/:importId/retry`。
- **GUD-001**: 接收端改动以测试守护和文档回填为主；除非测试暴露缺口，否则不扩大业务实现范围。

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: 补强接收端 payload 校验和权限回归测试。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 扩展 `packages/api/src/utils/import-validation.test.ts`，覆盖有效 `case` 2 张图片、`case` 10 张图片拒绝、`gallery` 31 张图片拒绝、`requiredLevelRank=20` 接受、`requiredLevelRank=15` 拒绝。 | | |
| TASK-002 | 保留并强化 `packages/api/src/utils/import-validation.test.ts` 中旧 `testimonial_case` 拒绝断言，错误文案必须是 `metadata.type 必须是 gallery 或 case`。 | | |
| TASK-003 | 扩展 `packages/api/src/routes/imports.test.ts`，覆盖 `case` payload 使用 `case:create` 权限成功创建 pending 导入。 | | |
| TASK-004 | 扩展 `packages/api/src/routes/imports.test.ts`，覆盖 token 只有 `gallery:create` 时提交 `case` 返回 `IMPORT_PERMISSION_DENIED`。 | | |
| TASK-005 | 扩展 `packages/api/src/routes/imports.test.ts`，覆盖 `sourceBotKey` 不在 allowlist 时返回 `IMPORT_SOURCE_BOT_NOT_ALLOWED`。 | | |

### Implementation Phase 2

- GOAL-002: 补强幂等、后台记录和敏感值脱敏测试。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 扩展 `packages/api/src/routes/imports.test.ts`，覆盖重复 `externalMessageId` 返回 `duplicate`，响应包含原 `importId` / `currentStatus`，且 mock DB 记录创建次数仍为 0。 | | |
| TASK-007 | 扩展 `packages/api/src/routes/admin/external-import-records.test.ts`，覆盖列表接口不输出 Import Token、Telegram Bot Token、Telegram 下载 URL、R2 私有 key。 | | |
| TASK-008 | 扩展 `packages/api/src/routes/admin/external-import-records.test.ts`，覆盖详情接口展示 `sourceBotKey`、target type、文件状态、错误摘要和 targetId，但不展示 token 或下载 URL。 | | |
| TASK-009 | 扩展 `packages/api/src/services/telegram-file-id-import.test.ts`，覆盖 `case` 导入写入 `cases` / `case_images`，R2 key 使用 `cases/{caseId}/{imageId}.{ext}`。 | | |

### Implementation Phase 3

- GOAL-003: 对齐部署和运维验收说明。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | 更新 `docs/TELEGRAM_IMPORT_API.md`，确认示例 payload、错误码和验收口径与测试一致，保留 Ops Hub caption 属于上游约定的说明。 | | |
| TASK-011 | 更新 `docs/DEPLOYMENT.md`，确认 `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>`、Import Token 权限、allowlist 和 Ops Hub 自测顺序与实现一致。 | | |
| TASK-012 | 更新 `docs/codebase/TESTING.md`，把新增测试文件和命令加入证据列表。 | | |
| TASK-013 | 更新 `docs/PROJECT_STATUS.md`，在 Telegram 外部导入段落中标注接收端契约已通过回归测试守护。 | | |

### Implementation Phase 4

- GOAL-004: 完成接收端验证命令和上线前契约检查。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | 运行 `corepack pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts src/routes/imports.test.ts src/routes/admin/external-import-records.test.ts src/services/telegram-file-id-import.test.ts`。 | | |
| TASK-015 | 运行 `corepack pnpm --filter @meigallery/api test`。 | | |
| TASK-016 | 运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit`。 | | |
| TASK-017 | 运行 `corepack pnpm --filter @meigallery/api run build`，确认 Wrangler dry-run build 通过。 | | |
| TASK-018 | 运行 `corepack pnpm lint`，确认文档或测试改动没有引入 lint 失败。 | | |
| TASK-019 | 运行 `rg -n "TBD|TODO|FIXME" docs packages`，确认没有新增占位；旧历史说明命中必须在最终记录中说明。 | | |

## 3. Alternatives

- **ALT-001**: 在 MeiGallery 内实现 Telegram Bot webhook 和 caption parser。未采用，因为当前架构明确由 Ops Hub 监听 Telegram，MeiGallery 只作为接收端。
- **ALT-002**: 暂时兼容 `testimonial_case`。未采用，因为当前真实案例命名已统一为 `case`，兼容旧类型会让双方契约继续分裂。
- **ALT-003**: 通过公网下载 URL 接收图片。未采用，因为当前方案是 Telegram `file_id` 异步解析，避免 Ops Hub 下载和上传大文件。

## 4. Dependencies

- **DEP-001**: Ops Hub 自动导入提交的标准 JSON payload。
- **DEP-002**: MeiGallery Import Token、`allowedSourceBotKeys` 和 API Worker secret `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>`。
- **DEP-003**: Cloudflare Workers、D1、R2、Hono、Vitest 和 Wrangler。
- **DEP-004**: 当前 `packages/api/src/utils/import-validation.ts`、`packages/api/src/routes/imports.ts` 和 `packages/api/src/services/telegram-file-id-import.ts` 实现。

## 5. Files

- **FILE-001**: `packages/api/src/utils/import-validation.ts`：payload 类型、数量、MIME、slug 和 sourceBotKey 校验。
- **FILE-002**: `packages/api/src/utils/import-validation.test.ts`：payload 校验回归测试。
- **FILE-003**: `packages/api/src/routes/imports.ts`：Bot/Ops Hub 外部导入 API。
- **FILE-004**: `packages/api/src/routes/imports.test.ts`：鉴权、权限、allowlist、幂等和旧类型拒绝测试。
- **FILE-005**: `packages/api/src/services/telegram-file-id-import.ts`：导入状态机、草稿创建和 retry。
- **FILE-006**: `packages/api/src/services/telegram-file-id-import.test.ts`：导入 service 回归测试。
- **FILE-007**: `packages/api/src/routes/admin/external-import-records.ts`：后台外部导入记录 API。
- **FILE-008**: `packages/api/src/routes/admin/external-import-records.test.ts`：后台脱敏、详情和 retry 测试。
- **FILE-009**: `docs/TELEGRAM_IMPORT_API.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/codebase/TESTING.md`、`docs/PROJECT_STATUS.md`：接收端契约和验证文档。

## 6. Testing

- **TEST-001**: `corepack pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts src/routes/imports.test.ts src/routes/admin/external-import-records.test.ts src/services/telegram-file-id-import.test.ts`
- **TEST-002**: `corepack pnpm --filter @meigallery/api test`
- **TEST-003**: `corepack pnpm --filter @meigallery/api exec tsc --noEmit`
- **TEST-004**: `corepack pnpm --filter @meigallery/api run build`
- **TEST-005**: `corepack pnpm lint`
- **TEST-006**: `rg -n "TBD|TODO|FIXME" docs packages`

## 7. Risks & Assumptions

- **RISK-001**: Ops Hub 可能提交缺少 slug 或错误类型的 payload；MeiGallery 必须继续服务端拒绝。
- **RISK-002**: `sourceBotKey` allowlist 配置错误会导致导入失败；错误码必须便于 Ops Hub 停止自动重试并提示人工处理。
- **RISK-003**: 后台错误详情如果包含上游原始错误，可能泄露 Telegram 下载 URL 或 R2 key；测试必须覆盖脱敏。
- **ASSUMPTION-001**: MeiGallery 当前不负责 Telegram caption 解析，也不维护 Ops Hub 源端配置。
- **ASSUMPTION-002**: API Worker 中已按 `sourceBotKey` 配置对应 Telegram Bot Token secret。
- **ASSUMPTION-003**: Ops Hub 会使用稳定 `externalMessageId`，并在重复提交后继续查询返回的原 `importId`。

## 8. Related Specifications / Further Reading

- `docs/superpowers/specs/2026-06-26-ops-hub-telegram-auto-import-contract.md`
- `docs/TELEGRAM_IMPORT_API.md`
- `docs/TECHNICAL_SPEC.md`
- `docs/DEPLOYMENT.md`
- `docs/codebase/TESTING.md`
- `packages/api/src/utils/import-validation.ts`
- `packages/api/src/routes/imports.ts`
- `packages/api/src/services/telegram-file-id-import.ts`
