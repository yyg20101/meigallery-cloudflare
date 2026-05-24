# Telegram file_id 异步导入 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现受 Import Token 保护的 Telegram `file_id` JSON 异步导入 API，把 Telegram 图片引用安全拉取到 R2，并创建图库或真实案例草稿。

**Architecture:** Hono 新增 `/api/imports` 路由接收 Bot JSON 请求，导入记录先落 D1，再通过独立 service 使用 Queue 或 `waitUntil()` 处理媒体拉取、R2 写入和草稿创建。Import Token、payload 校验、Telegram fetcher 和导入编排拆成可单测模块，后台只负责 token 管理和导入记录查询，不暴露 Telegram Bot Token 或下载 URL。

**Tech Stack:** Cloudflare Workers、Hono、D1、R2、Cloudflare Queues 边界、Telegram Bot API、Vitest、Wrangler、TypeScript。

---

## 文件结构

- Create: `packages/api/migrations/0015_telegram_import_api.sql`，新增 Import Token、外部导入记录和外部导入文件表。
- Create: `packages/api/src/utils/import-token.ts`，生成 token、hash、权限、过期和 sourceBotKey 判断。
- Create: `packages/api/src/utils/import-token.test.ts`，覆盖 token 格式、hash、权限、过期和 sourceBotKey 判断。
- Create: `packages/api/src/utils/import-validation.ts`，纯函数校验 metadata、Telegram 来源和文件引用。
- Create: `packages/api/src/utils/import-validation.test.ts`，覆盖图库和真实案例 payload 校验。
- Create: `packages/api/src/utils/import-errors.ts`，统一导入错误码和 JSON 响应结构。
- Create: `packages/api/src/services/telegram-file-fetcher.ts`，根据 `sourceBotKey` 读取 Worker secret，调用 Telegram `getFile` 并下载图片。
- Create: `packages/api/src/services/telegram-file-fetcher.test.ts`，mock `fetch` 验证成功、下载失败、secret 缺失和 MIME 不匹配。
- Create: `packages/api/src/services/telegram-file-id-import.ts`，编排创建记录、幂等、状态查询、失败重试、媒体拉取、R2 写入、草稿创建和失败清理。
- Create: `packages/api/src/services/telegram-file-id-import.test.ts`，覆盖图库导入、真实案例导入、slug 冲突、duplicate、失败清理和 retry 状态重置。
- Create: `packages/api/src/routes/imports.ts`，公开给 Bot 的导入、状态查询和 retry API。
- Create: `packages/api/src/routes/imports.test.ts`，覆盖 token 鉴权、权限、sourceBotKey、duplicate、查询隔离和 retry 错误。
- Create: `packages/api/src/routes/admin/import-api-tokens.ts`，Owner 管理 Import Token。
- Create: `packages/api/src/routes/admin/import-api-tokens.test.ts`，覆盖 Owner 限制、创建只返回一次明文、禁用和不泄露 hash。
- Create: `packages/api/src/routes/admin/external-import-records.ts`，Admin 查看外部导入记录和详情。
- Create: `packages/api/src/routes/admin/external-import-records.test.ts`，覆盖列表筛选、详情文件状态和 token/secret 不泄露。
- Modify: `packages/api/src/index.ts`，挂载 `/api/imports`，扩展 `Bindings`，对导入接口增加速率限制。
- Modify: `packages/api/src/routes/admin/index.ts`，挂载 `/api/admin/import-api-tokens` 和 `/api/admin/external-import-records`。
- Modify: `packages/api/wrangler.toml`，预留 Queue binding 和 `IMPORT_TOKEN_DAILY_LIMIT` 环境变量。
- Modify: `docs/superpowers/specs/2026-05-06-telegram-import-api-doc.md`，实现后补充 dev 验收状态和实际错误码。

---

### Task 1: D1 schema 与基础工具

**Files:**
- Create: `packages/api/migrations/0015_telegram_import_api.sql`
- Create: `packages/api/src/utils/import-token.ts`
- Create: `packages/api/src/utils/import-token.test.ts`
- Create: `packages/api/src/utils/import-errors.ts`

- [ ] **Step 1: 编写 migration**

Create `packages/api/migrations/0015_telegram_import_api.sql`:

```sql
-- Telegram file_id 异步导入 API
CREATE TABLE IF NOT EXISTS import_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  allowed_source_bot_keys TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_import_api_tokens_status
  ON import_api_tokens(status, expires_at);

CREATE TABLE IF NOT EXISTS external_import_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES import_api_tokens(id),
  source_bot_key TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  media_group_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_media_fetch',
  metadata_json TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT,
  error_json TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (source IN ('telegram')),
  CHECK (target_type IN ('gallery', 'testimonial_case')),
  CHECK (status IN ('pending_media_fetch', 'fetching_media', 'draft_created', 'partial_failed', 'failed')),
  UNIQUE (token_id, source, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_external_import_records_token
  ON external_import_records(token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_status
  ON external_import_records(status, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_target
  ON external_import_records(target_type, target_id);

CREATE TABLE IF NOT EXISTS external_import_files (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES external_import_records(id) ON DELETE CASCADE,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  filename TEXT,
  declared_mime_type TEXT,
  actual_mime_type TEXT,
  file_size INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  target_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending', 'fetching', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_external_import_files_import
  ON external_import_files(import_id, sort_order);
```

- [ ] **Step 2: 编写 token 工具测试**

Create `packages/api/src/utils/import-token.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  createImportToken,
  hashImportToken,
  hasImportPermission,
  isImportTokenExpired,
  isSourceBotAllowed,
  parseJsonStringArray,
} from './import-token'

describe('import token utilities', () => {
  it('generates a one-time token with mgi prefix', () => {
    const token = createImportToken()

    expect(token).toMatch(/^mgi_[A-Za-z0-9_-]{43}$/)
  })

  it('hashes tokens with stable SHA-256 hex', async () => {
    const hash = await hashImportToken('mgi_test_token')

    expect(hash).toBe(await hashImportToken('mgi_test_token'))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('checks permissions from JSON array strings', () => {
    expect(hasImportPermission('["gallery:create"]', 'gallery:create')).toBe(true)
    expect(hasImportPermission('["gallery:create"]', 'testimonial:create')).toBe(false)
  })

  it('treats invalid JSON permissions as empty', () => {
    expect(parseJsonStringArray('{bad json')).toEqual([])
    expect(hasImportPermission('{bad json', 'gallery:create')).toBe(false)
  })

  it('checks sourceBotKey allowlist exactly', () => {
    expect(isSourceBotAllowed('["ops_gallery_bot"]', 'ops_gallery_bot')).toBe(true)
    expect(isSourceBotAllowed('["ops_gallery_bot"]', 'other_bot')).toBe(false)
    expect(isSourceBotAllowed('[]', 'ops_gallery_bot')).toBe(false)
  })

  it('detects expired token timestamps', () => {
    expect(isImportTokenExpired(null, new Date('2026-05-06T10:00:00.000Z'))).toBe(false)
    expect(isImportTokenExpired('2026-05-06T09:59:59.000Z', new Date('2026-05-06T10:00:00.000Z'))).toBe(true)
    expect(isImportTokenExpired('2026-05-06T10:01:00.000Z', new Date('2026-05-06T10:00:00.000Z'))).toBe(false)
  })
})
```

- [ ] **Step 3: 运行 token 测试确认失败**

Run: `pnpm --filter @meigallery/api test -- src/utils/import-token.test.ts`

Expected: FAIL，提示 `Cannot find module './import-token'`。

- [ ] **Step 4: 实现 token 工具**

Create `packages/api/src/utils/import-token.ts`:

```ts
export type ImportPermission = 'gallery:create' | 'testimonial:create'

export function createImportToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('')
  const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `mgi_${base64}`
}

export async function hashImportToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function hasImportPermission(permissionsJson: string, permission: ImportPermission): boolean {
  return parseJsonStringArray(permissionsJson).includes(permission)
}

export function isSourceBotAllowed(allowedSourceBotKeysJson: string, sourceBotKey: string): boolean {
  return parseJsonStringArray(allowedSourceBotKeysJson).includes(sourceBotKey)
}

export function isImportTokenExpired(expiresAt: string | null, now = new Date()): boolean {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= now.getTime())
}
```

- [ ] **Step 5: 实现错误工具**

Create `packages/api/src/utils/import-errors.ts`:

```ts
export type ImportErrorCode =
  | 'IMPORT_TOKEN_MISSING'
  | 'IMPORT_TOKEN_INVALID'
  | 'IMPORT_TOKEN_DISABLED'
  | 'IMPORT_TOKEN_EXPIRED'
  | 'IMPORT_PERMISSION_DENIED'
  | 'IMPORT_SOURCE_BOT_NOT_ALLOWED'
  | 'IMPORT_VALIDATION_FAILED'
  | 'IMPORT_DUPLICATE'
  | 'IMPORT_NOT_FOUND'
  | 'IMPORT_RETRY_NOT_ALLOWED'
  | 'IMPORT_RETRY_CLEANUP_REQUIRED'
  | 'TELEGRAM_BOT_TOKEN_MISSING'
  | 'TELEGRAM_GET_FILE_FAILED'
  | 'TELEGRAM_DOWNLOAD_FAILED'
  | 'TELEGRAM_FILE_TOO_LARGE'
  | 'TELEGRAM_FILE_TYPE_UNSUPPORTED'
  | 'IMPORT_TARGET_SLUG_CONFLICT'
  | 'IMPORT_PROCESS_FAILED'

export type ImportErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    message: string,
    public readonly status: ImportErrorStatus = 400,
  ) {
    super(message)
  }
}

export function importErrorBody(error: ImportError) {
  return {
    statusCode: error.status,
    code: error.code,
    message: error.message,
  }
}
```

- [ ] **Step 6: 运行基础工具测试**

Run: `pnpm --filter @meigallery/api test -- src/utils/import-token.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交 Task 1**

Run:

```bash
git add packages/api/migrations/0015_telegram_import_api.sql packages/api/src/utils/import-token.ts packages/api/src/utils/import-token.test.ts packages/api/src/utils/import-errors.ts
git commit -m "feat: 新增 Telegram 导入基础模型"
```

Expected: commit 成功。

---

### Task 2: Payload 校验与 Telegram 文件拉取

**Files:**
- Create: `packages/api/src/utils/import-validation.ts`
- Create: `packages/api/src/utils/import-validation.test.ts`
- Create: `packages/api/src/services/telegram-file-fetcher.ts`
- Create: `packages/api/src/services/telegram-file-fetcher.test.ts`

- [ ] **Step 1: 编写 payload 校验测试**

Create `packages/api/src/utils/import-validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateTelegramImportPayload } from './import-validation'

const basePayload = {
  metadata: {
    type: 'gallery',
    source: 'telegram',
    externalMessageId: '-1001234567890:456',
    title: '加拿大-多伦多 172D Lina',
    slug: 'toronto-lina-001',
    summary: '一句话摘要',
    bodyMd: '正文 Markdown',
    requiredLevelRank: 10,
    tags: ['加拿大', '多伦多'],
  },
  telegram: {
    sourceBotKey: 'ops_gallery_bot',
    sourceChatId: '-1001234567890',
    sourceMessageId: '456',
    mediaGroupId: '123456',
  },
  files: [
    { fileId: 'AgACAg1', fileUniqueId: 'AQAD1', filename: '001.jpg', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
  ],
}

describe('validateTelegramImportPayload', () => {
  it('normalizes a valid gallery import payload', () => {
    const result = validateTelegramImportPayload(basePayload)

    expect(result.metadata.type).toBe('gallery')
    expect(result.metadata.requiredLevelRank).toBe(10)
    expect(result.files[0].isCover).toBe(true)
  })

  it('requires 2-9 images for testimonial_case', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, type: 'testimonial_case', requiredLevelRank: undefined },
    })

    expect(result).toThrow('真实案例导入需要 2-9 张图片')
  })

  it('rejects unsupported file MIME declarations', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      files: [{ ...basePayload.files[0], mimeType: 'video/mp4' }],
    })

    expect(result).toThrow('仅支持 JPEG、PNG、WebP 图片')
  })

  it('rejects duplicate sortOrder values', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      files: [basePayload.files[0], { ...basePayload.files[0], fileId: 'AgACAg2' }],
    })

    expect(result).toThrow('文件 sortOrder 不能重复')
  })

  it('rejects invalid sourceBotKey characters', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      telegram: { ...basePayload.telegram, sourceBotKey: 'Ops-Gallery-Bot' },
    })

    expect(result).toThrow('sourceBotKey 只能包含小写字母、数字和下划线')
  })
})
```

- [ ] **Step 2: 实现 payload 校验**

Create `packages/api/src/utils/import-validation.ts`:

```ts
import { ImportError } from './import-errors'

export type TelegramImportType = 'gallery' | 'testimonial_case'
export type AllowedImportMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export type TelegramImportPayload = {
  metadata: {
    type: TelegramImportType
    source: 'telegram'
    externalMessageId: string
    title: string
    slug: string
    summary?: string
    bodyMd?: string
    requiredLevelRank?: 0 | 10 | 20
    tags?: string[]
    featured?: boolean
    sortOrder?: number
    seoTitle?: string
    seoDescription?: string
  }
  telegram: {
    sourceBotKey: string
    sourceChatId: string
    sourceMessageId: string
    mediaGroupId?: string
  }
  files: Array<{
    fileId: string
    fileUniqueId?: string
    filename?: string
    mimeType: AllowedImportMimeType
    sortOrder: number
    isCover?: boolean
  }>
}

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export function validateTelegramImportPayload(input: unknown): TelegramImportPayload {
  const body = input as TelegramImportPayload
  if (!body || typeof body !== 'object') throw new ImportError('IMPORT_VALIDATION_FAILED', '请求 body 必须是 JSON 对象', 400)
  if (!body.metadata || typeof body.metadata !== 'object') throw new ImportError('IMPORT_VALIDATION_FAILED', 'metadata 为必填对象', 400)
  if (!body.telegram || typeof body.telegram !== 'object') throw new ImportError('IMPORT_VALIDATION_FAILED', 'telegram 为必填对象', 400)
  if (!Array.isArray(body.files)) throw new ImportError('IMPORT_VALIDATION_FAILED', 'files 为必填数组', 400)

  const metadata = body.metadata
  if (!['gallery', 'testimonial_case'].includes(metadata.type)) throw new ImportError('IMPORT_VALIDATION_FAILED', 'metadata.type 必须是 gallery 或 testimonial_case', 400)
  if (metadata.source !== 'telegram') throw new ImportError('IMPORT_VALIDATION_FAILED', 'metadata.source 必须是 telegram', 400)
  if (!metadata.externalMessageId || metadata.externalMessageId.length > 160) throw new ImportError('IMPORT_VALIDATION_FAILED', 'externalMessageId 为必填且不能超过 160 字符', 400)
  if (!metadata.title || metadata.title.trim().length > 80) throw new ImportError('IMPORT_VALIDATION_FAILED', '标题为必填且不能超过 80 字', 400)
  if (!metadata.slug || !/^[a-z0-9-]{3,120}$/.test(metadata.slug)) throw new ImportError('IMPORT_VALIDATION_FAILED', 'slug 只能包含小写字母、数字和短横线，长度 3-120 字符', 400)
  if (metadata.summary && metadata.summary.length > 160) throw new ImportError('IMPORT_VALIDATION_FAILED', '摘要不能超过 160 字', 400)
  if (metadata.bodyMd && metadata.bodyMd.length > 5000) throw new ImportError('IMPORT_VALIDATION_FAILED', '正文不能超过 5000 字', 400)
  if (metadata.requiredLevelRank !== undefined && ![0, 10, 20].includes(metadata.requiredLevelRank)) throw new ImportError('IMPORT_VALIDATION_FAILED', 'requiredLevelRank 只能是 0、10 或 20', 400)
  if (metadata.tags && (metadata.tags.length > 30 || metadata.tags.some(tag => typeof tag !== 'string' || tag.trim().length < 1 || tag.trim().length > 30))) throw new ImportError('IMPORT_VALIDATION_FAILED', 'tags 最多 30 个，每个标签 1-30 字', 400)

  const telegram = body.telegram
  if (!telegram.sourceBotKey || !/^[a-z0-9_]{3,64}$/.test(telegram.sourceBotKey)) throw new ImportError('IMPORT_VALIDATION_FAILED', 'sourceBotKey 只能包含小写字母、数字和下划线，长度 3-64 字符', 400)
  if (!telegram.sourceChatId) throw new ImportError('IMPORT_VALIDATION_FAILED', 'sourceChatId 为必填', 400)
  if (!telegram.sourceMessageId) throw new ImportError('IMPORT_VALIDATION_FAILED', 'sourceMessageId 为必填', 400)

  if (metadata.type === 'gallery' && (body.files.length < 1 || body.files.length > 30)) throw new ImportError('IMPORT_VALIDATION_FAILED', '图库导入需要 1-30 张图片', 400)
  if (metadata.type === 'testimonial_case' && (body.files.length < 2 || body.files.length > 9)) throw new ImportError('IMPORT_VALIDATION_FAILED', '真实案例导入需要 2-9 张图片', 400)

  const sortOrders = new Set<number>()
  for (const file of body.files) {
    if (!file.fileId) throw new ImportError('IMPORT_VALIDATION_FAILED', 'files[].fileId 为必填', 400)
    if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) throw new ImportError('IMPORT_VALIDATION_FAILED', '仅支持 JPEG、PNG、WebP 图片', 400)
    if (!Number.isInteger(file.sortOrder) || file.sortOrder < 0 || file.sortOrder > 999) throw new ImportError('IMPORT_VALIDATION_FAILED', 'sortOrder 必须是 0-999 的整数', 400)
    if (sortOrders.has(file.sortOrder)) throw new ImportError('IMPORT_VALIDATION_FAILED', '文件 sortOrder 不能重复', 400)
    sortOrders.add(file.sortOrder)
  }

  return {
    ...body,
    metadata: {
      ...metadata,
      title: metadata.title.trim(),
      slug: metadata.slug.trim(),
      summary: metadata.summary?.trim(),
      bodyMd: metadata.bodyMd?.trim(),
      requiredLevelRank: metadata.requiredLevelRank ?? 0,
      tags: metadata.tags?.map(tag => tag.trim()).filter(Boolean),
    },
    files: [...body.files].sort((a, b) => a.sortOrder - b.sortOrder),
  }
}

export function importPermissionForType(type: TelegramImportType) {
  return type === 'gallery' ? 'gallery:create' : 'testimonial:create'
}
```

- [ ] **Step 3: 编写 Telegram fetcher 测试**

Create `packages/api/src/services/telegram-file-fetcher.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTelegramImageFile } from './telegram-file-fetcher'

describe('fetchTelegramImageFile', () => {
  afterEach(() => vi.restoreAllMocks())

  it('downloads a Telegram image without exposing the file URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) {
        return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 4 } })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/jpeg' } })
    }))

    const result = await fetchTelegramImageFile({ TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, 'ops_gallery_bot', 'AgACAg1')

    expect(result.mimeType).toBe('image/jpeg')
    expect(result.bytes.byteLength).toBe(4)
  })

  it('fails when sourceBotKey secret is missing', async () => {
    await expect(fetchTelegramImageFile({}, 'ops_gallery_bot', 'AgACAg1')).rejects.toThrow('未配置 Telegram Bot Token')
  })

  it('rejects unsupported downloaded content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'videos/file.mp4', file_size: 4 } })
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'video/mp4' } })
    }))

    await expect(fetchTelegramImageFile({ TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, 'ops_gallery_bot', 'AgACAg1')).rejects.toThrow('Telegram 文件类型不支持')
  })
})
```

- [ ] **Step 4: 实现 Telegram fetcher**

Create `packages/api/src/services/telegram-file-fetcher.ts`:

```ts
import { ImportError } from '../utils/import-errors'

type TelegramSecretEnv = Record<string, string | undefined>

export type FetchedTelegramImage = {
  bytes: ArrayBuffer
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileSize: number
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MIME_TO_EXT: Record<FetchedTelegramImage['mimeType'], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function getTelegramSecretName(sourceBotKey: string): string {
  return `TELEGRAM_BOT_TOKEN_${sourceBotKey.toUpperCase()}`
}

export function getExtensionForMime(mimeType: FetchedTelegramImage['mimeType']): string {
  return MIME_TO_EXT[mimeType]
}

export async function fetchTelegramImageFile(env: TelegramSecretEnv, sourceBotKey: string, fileId: string): Promise<FetchedTelegramImage> {
  const secretName = getTelegramSecretName(sourceBotKey)
  const botToken = env[secretName]
  if (!botToken) throw new ImportError('TELEGRAM_BOT_TOKEN_MISSING', '未配置 Telegram Bot Token', 500)

  const getFileResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`)
  const getFileJson = await getFileResponse.json<{ ok: boolean; result?: { file_path?: string; file_size?: number }; description?: string }>()
  if (!getFileResponse.ok || !getFileJson.ok || !getFileJson.result?.file_path) throw new ImportError('TELEGRAM_GET_FILE_FAILED', 'Telegram getFile 调用失败', 502 as 500)
  if ((getFileJson.result.file_size ?? 0) > MAX_IMAGE_BYTES) throw new ImportError('TELEGRAM_FILE_TOO_LARGE', 'Telegram 文件超过 10MB', 400)

  const downloadResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${getFileJson.result.file_path}`)
  if (!downloadResponse.ok) throw new ImportError('TELEGRAM_DOWNLOAD_FAILED', 'Telegram 文件下载失败', 502 as 500)

  const contentType = downloadResponse.headers.get('Content-Type')?.split(';')[0]
  if (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') throw new ImportError('TELEGRAM_FILE_TYPE_UNSUPPORTED', 'Telegram 文件类型不支持', 400)

  const bytes = await downloadResponse.arrayBuffer()
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImportError('TELEGRAM_FILE_TOO_LARGE', 'Telegram 文件超过 10MB', 400)
  return { bytes, mimeType: contentType, fileSize: bytes.byteLength }
}
```

- [ ] **Step 5: 运行 Task 2 测试**

Run: `pnpm --filter @meigallery/api test -- src/utils/import-validation.test.ts src/services/telegram-file-fetcher.test.ts`

Expected: PASS。

- [ ] **Step 6: 修正 fetcher 状态码类型**

Modify `packages/api/src/utils/import-errors.ts`:

```ts
export type ImportErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502
```

Modify `packages/api/src/services/telegram-file-fetcher.ts` 的两个 `502 as 500` 为 `502`。

- [ ] **Step 7: 提交 Task 2**

Run:

```bash
git add packages/api/src/utils/import-validation.ts packages/api/src/utils/import-validation.test.ts packages/api/src/services/telegram-file-fetcher.ts packages/api/src/services/telegram-file-fetcher.test.ts packages/api/src/utils/import-errors.ts
git commit -m "feat: 新增 Telegram 导入校验与拉取工具"
```

Expected: commit 成功。

---

### Task 3: 导入编排 service

**Files:**
- Create: `packages/api/src/services/telegram-file-id-import.ts`
- Create: `packages/api/src/services/telegram-file-id-import.test.ts`

- [ ] **Step 1: 编写 service 类型和查询测试**

Create `packages/api/src/services/telegram-file-id-import.test.ts`，先覆盖不依赖真实 R2 的流程：

```ts
import { describe, expect, it } from 'vitest'
import { createExternalImportRecord, getExternalImportStatus, resetFailedImportForRetry } from './telegram-file-id-import'

function createDb() {
  const records: Record<string, any> = {}
  const files: any[] = []
  const executedSql: string[] = []
  return {
    records,
    files,
    executedSql,
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) { params.push(...values); return this },
        async first<T>() {
          if (sql.includes('FROM external_import_records') && sql.includes('WHERE id = ? AND token_id = ?')) return Object.values(records).find((r: any) => r.id === params[0] && r.token_id === params[1]) as T
          if (sql.includes('FROM external_import_records') && sql.includes('token_id = ?') && sql.includes('external_message_id = ?')) return Object.values(records).find((r: any) => r.token_id === params[0] && r.external_message_id === params[2]) as T
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM external_import_files')) return { results: files.filter(file => file.import_id === params[0]) as T[] }
          return { results: [] as T[] }
        },
        async run() {
          executedSql.push(sql)
          if (sql.includes('INSERT INTO external_import_records')) {
            records[String(params[0])] = { id: params[0], source: params[1], external_message_id: params[2], token_id: params[3], source_bot_key: params[4], target_type: params[8], status: 'pending_media_fetch', file_count: params[10], fetched_count: 0, failed_count: 0, retry_count: 0, target_id: null }
          }
          if (sql.includes('INSERT INTO external_import_files')) files.push({ id: params[0], import_id: params[1], filename: params[4], status: 'pending', sort_order: params[6] })
          if (sql.includes("status = 'pending_media_fetch'")) records[String(params[0])].status = 'pending_media_fetch'
          return { success: true }
        },
      }
    },
  }
}

const payload = {
  metadata: { type: 'gallery' as const, source: 'telegram' as const, externalMessageId: '-100:1', title: '标题', slug: 'title-001', requiredLevelRank: 0 },
  telegram: { sourceBotKey: 'ops_gallery_bot', sourceChatId: '-100', sourceMessageId: '1' },
  files: [{ fileId: 'AgACAg1', mimeType: 'image/jpeg' as const, sortOrder: 0, isCover: true }],
}

describe('telegram file_id import service', () => {
  it('creates an external import record before async media fetch', async () => {
    const db = createDb()
    const result = await createExternalImportRecord(db as any, 'iat_1', payload, '127.0.0.1', 'vitest')

    expect(result.status).toBe('pending_media_fetch')
    expect(result.receivedFileCount).toBe(1)
    expect(db.files).toHaveLength(1)
  })

  it('returns existing import as duplicate without creating a second record', async () => {
    const db = createDb()
    const first = await createExternalImportRecord(db as any, 'iat_1', payload, null, null)
    const second = await createExternalImportRecord(db as any, 'iat_1', payload, null, null)

    expect(second.status).toBe('duplicate')
    expect(second.importId).toBe(first.importId)
  })

  it('returns status for the same token only', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as any, 'iat_1', payload, null, null)
    const status = await getExternalImportStatus(db as any, created.importId, 'iat_1')

    expect(status.importId).toBe(created.importId)
    expect(status.files).toHaveLength(1)
  })

  it('resets failed imports for retry', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as any, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'

    const retry = await resetFailedImportForRetry(db as any, created.importId, 'iat_1')

    expect(retry.status).toBe('pending_media_fetch')
  })
})
```

- [ ] **Step 2: 实现 service 基础状态机**

Create `packages/api/src/services/telegram-file-id-import.ts`:

```ts
import { generateId } from '../utils/db'
import { ImportError } from '../utils/import-errors'
import type { TelegramImportPayload } from '../utils/import-validation'

export type ExternalImportStatus = 'pending_media_fetch' | 'fetching_media' | 'draft_created' | 'partial_failed' | 'failed'

export type CreateImportResult = {
  importId: string
  type: TelegramImportPayload['metadata']['type']
  status: ExternalImportStatus | 'duplicate'
  currentStatus?: ExternalImportStatus
  targetId?: string | null
  receivedFileCount?: number
  message?: string
}

export async function createExternalImportRecord(
  db: D1Database,
  tokenId: string,
  payload: TelegramImportPayload,
  requestIp: string | null,
  userAgent: string | null,
): Promise<CreateImportResult> {
  const existing = await db.prepare(`
    SELECT id, target_type, target_id, status
    FROM external_import_records
    WHERE token_id = ? AND source = 'telegram' AND external_message_id = ?
  `).bind(tokenId, payload.metadata.externalMessageId).first<{ id: string; target_type: TelegramImportPayload['metadata']['type']; target_id: string | null; status: ExternalImportStatus }>()

  if (existing) {
    return {
      importId: existing.id,
      type: existing.target_type,
      targetId: existing.target_id,
      status: 'duplicate',
      currentStatus: existing.status,
      message: '该 Telegram 消息已导入',
    }
  }

  const importId = generateId('eir')
  await db.prepare(`
    INSERT INTO external_import_records
      (id, source, external_message_id, token_id, source_bot_key, source_chat_id, source_message_id, media_group_id, target_type, metadata_json, file_count, request_ip, user_agent)
    VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    importId,
    payload.metadata.externalMessageId,
    tokenId,
    payload.telegram.sourceBotKey,
    payload.telegram.sourceChatId,
    payload.telegram.sourceMessageId,
    payload.telegram.mediaGroupId ?? null,
    payload.metadata.type,
    JSON.stringify(payload.metadata),
    payload.files.length,
    requestIp,
    userAgent,
  ).run()

  for (const file of payload.files) {
    await db.prepare(`
      INSERT INTO external_import_files
        (id, import_id, telegram_file_id, telegram_file_unique_id, filename, declared_mime_type, sort_order, is_cover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('eif'),
      importId,
      file.fileId,
      file.fileUniqueId ?? null,
      file.filename ?? null,
      file.mimeType,
      file.sortOrder,
      file.isCover ? 1 : 0,
    ).run()
  }

  return { importId, type: payload.metadata.type, status: 'pending_media_fetch', receivedFileCount: payload.files.length }
}

export async function getExternalImportStatus(db: D1Database, importId: string, tokenId: string) {
  const record = await db.prepare(`
    SELECT id, target_type, status, target_id, file_count, fetched_count, failed_count, retry_count, created_at, completed_at
    FROM external_import_records
    WHERE id = ? AND token_id = ?
  `).bind(importId, tokenId).first<{
    id: string
    target_type: string
    status: string
    target_id: string | null
    file_count: number
    fetched_count: number
    failed_count: number
    retry_count: number
    created_at: string
    completed_at: string | null
  }>()
  if (!record) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)

  const files = await db.prepare(`
    SELECT filename, status, sort_order, error_message
    FROM external_import_files
    WHERE import_id = ?
    ORDER BY sort_order ASC
  `).bind(importId).all<{ filename: string | null; status: string; sort_order: number; error_message: string | null }>()

  return {
    importId: record.id,
    type: record.target_type,
    status: record.status,
    targetId: record.target_id,
    fileCount: record.file_count,
    fetchedCount: record.fetched_count,
    failedCount: record.failed_count,
    retryCount: record.retry_count,
    files: files.results.map(file => ({ filename: file.filename, status: file.status, sortOrder: file.sort_order, errorMessage: file.error_message })),
    createdAt: record.created_at,
    completedAt: record.completed_at,
  }
}

export async function resetFailedImportForRetry(db: D1Database, importId: string, tokenId: string) {
  const record = await db.prepare('SELECT id, target_type, target_id, status, retry_count FROM external_import_records WHERE id = ? AND token_id = ?')
    .bind(importId, tokenId)
    .first<{ id: string; target_type: string; target_id: string | null; status: string; retry_count: number }>()
  if (!record) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)
  if (record.status !== 'failed') throw new ImportError('IMPORT_RETRY_NOT_ALLOWED', '当前导入状态不允许重试', 409)
  if (record.target_id) throw new ImportError('IMPORT_RETRY_CLEANUP_REQUIRED', '失败导入仍有待清理资源，暂不能重试', 409)

  const dirtyFiles = await db.prepare(`
    SELECT id FROM external_import_files
    WHERE import_id = ? AND (r2_key IS NOT NULL OR target_file_id IS NOT NULL)
    LIMIT 1
  `).bind(importId).first<{ id: string }>()
  if (dirtyFiles) throw new ImportError('IMPORT_RETRY_CLEANUP_REQUIRED', '失败导入仍有待清理资源，暂不能重试', 409)

  await db.prepare(`
    UPDATE external_import_records
    SET status = 'pending_media_fetch', fetched_count = 0, failed_count = 0, retry_count = retry_count + 1,
        last_retry_at = datetime('now'), error_json = NULL, completed_at = NULL
    WHERE id = ?
  `).bind(importId).run()
  await db.prepare(`
    UPDATE external_import_files
    SET status = 'pending', error_message = NULL, r2_key = NULL, target_file_id = NULL,
        actual_mime_type = NULL, file_size = NULL, updated_at = datetime('now')
    WHERE import_id = ?
  `).bind(importId).run()

  return { importId, type: record.target_type, status: 'pending_media_fetch' as const, retryCount: record.retry_count + 1, message: '导入重试已开始' }
}
```

- [ ] **Step 3: 运行 service 基础测试**

Run: `pnpm --filter @meigallery/api test -- src/services/telegram-file-id-import.test.ts`

Expected: PASS。

- [ ] **Step 4: 增加异步处理函数骨架**

Modify `packages/api/src/services/telegram-file-id-import.ts`，新增 `processTelegramFileIdImport`：

```ts
export async function processTelegramFileIdImport(db: D1Database, r2: R2Bucket, env: Record<string, string | undefined>, importId: string): Promise<void> {
  const record = await db.prepare('SELECT * FROM external_import_records WHERE id = ?')
    .bind(importId)
    .first<{ id: string; source_bot_key: string; target_type: 'gallery' | 'testimonial_case'; metadata_json: string }>()
  if (!record) return

  await db.prepare("UPDATE external_import_records SET status = 'fetching_media' WHERE id = ? AND status = 'pending_media_fetch'").bind(importId).run()

  const files = await db.prepare('SELECT * FROM external_import_files WHERE import_id = ? ORDER BY sort_order ASC')
    .bind(importId)
    .all<{ id: string; telegram_file_id: string; filename: string | null; declared_mime_type: string | null; sort_order: number; is_cover: number }>()

  const uploadedKeys: string[] = []
  try {
    const metadata = JSON.parse(record.metadata_json) as TelegramImportPayload['metadata']
    const targetId = record.target_type === 'gallery' ? generateId('gal') : generateId('tc')
    const fetchedFiles: Array<{ fileId: string; bytes: ArrayBuffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; fileSize: number; r2Key: string; sortOrder: number; isCover: boolean }> = []

    for (const file of files.results) {
      await db.prepare("UPDATE external_import_files SET status = 'fetching', updated_at = datetime('now') WHERE id = ?").bind(file.id).run()
      const fetched = await import('./telegram-file-fetcher').then(mod => mod.fetchTelegramImageFile(env, record.source_bot_key, file.telegram_file_id))
      const extension = await import('./telegram-file-fetcher').then(mod => mod.getExtensionForMime(fetched.mimeType))
      const targetFileId = record.target_type === 'gallery' ? generateId('med') : generateId('tci')
      const r2Key = record.target_type === 'gallery' ? `originals/${targetId}/${targetFileId}.${extension}` : `testimonials/${targetId}/${targetFileId}.${extension}`
      await r2.put(r2Key, fetched.bytes, { httpMetadata: { contentType: fetched.mimeType } })
      uploadedKeys.push(r2Key)
      fetchedFiles.push({ fileId: targetFileId, ...fetched, r2Key, sortOrder: file.sort_order, isCover: Boolean(file.is_cover) })
      await db.prepare(`
        UPDATE external_import_files
        SET status = 'completed', actual_mime_type = ?, file_size = ?, r2_key = ?, target_file_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(fetched.mimeType, fetched.fileSize, r2Key, targetFileId, file.id).run()
    }

    if (record.target_type === 'gallery') await createImportedGallery(db, targetId, metadata, fetchedFiles)
    else await createImportedTestimonialCase(db, targetId, metadata, fetchedFiles)

    await db.prepare(`
      UPDATE external_import_records
      SET status = 'draft_created', target_id = ?, fetched_count = ?, failed_count = 0, completed_at = datetime('now')
      WHERE id = ?
    `).bind(targetId, fetchedFiles.length, importId).run()
  } catch (error) {
    await cleanupFailedImport(db, r2, importId, uploadedKeys)
    const message = error instanceof Error ? error.message : '导入处理失败'
    await db.prepare(`
      UPDATE external_import_records
      SET status = 'failed', target_id = NULL, failed_count = file_count, error_json = ?, completed_at = datetime('now')
      WHERE id = ?
    `).bind(JSON.stringify({ message }), importId).run()
  }
}
```

- [ ] **Step 5: 新增草稿创建和清理 helper**

Modify `packages/api/src/services/telegram-file-id-import.ts`，追加 helper：

```ts
async function createImportedGallery(
  db: D1Database,
  galleryId: string,
  metadata: TelegramImportPayload['metadata'],
  files: Array<{ fileId: string; r2Key: string; mimeType: string; sortOrder: number; isCover: boolean }>,
) {
  const existing = await db.prepare('SELECT id FROM galleries WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
  if (existing) throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '图库 slug 已存在', 409)

  const cover = files.find(file => file.isCover) ?? files[0]
  await db.prepare(`
    INSERT INTO galleries (id, title, slug, summary, body_md, cover_key, status, required_level_rank)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `).bind(galleryId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, cover.r2Key, metadata.requiredLevelRank ?? 0).run()

  for (const file of files) {
    await db.prepare(`
      INSERT INTO media_assets (id, gallery_id, type, storage, r2_key, required_rank, role, sort_order, upload_status)
      VALUES (?, ?, 'image', 'r2', ?, ?, 'gallery_image', ?, 'completed')
    `).bind(file.fileId, galleryId, file.r2Key, metadata.requiredLevelRank ?? 0, file.sortOrder).run()
  }

  for (const tagName of metadata.tags ?? []) {
    const slug = tagName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '-')
    let tag = await db.prepare('SELECT id FROM tags WHERE slug = ? OR name = ?').bind(slug, tagName).first<{ id: string }>()
    if (!tag) {
      const tagId = generateId('tag')
      await db.prepare('INSERT INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)').bind(tagId, 'personality', tagName, slug).run()
      tag = { id: tagId }
    }
    await db.prepare('INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(galleryId, tag.id).run()
  }
}

async function createImportedTestimonialCase(
  db: D1Database,
  caseId: string,
  metadata: TelegramImportPayload['metadata'],
  files: Array<{ fileId: string; r2Key: string; mimeType: string; fileSize: number; sortOrder: number }>,
) {
  const existing = await db.prepare('SELECT id FROM testimonial_cases WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
  if (existing) throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '真实案例 slug 已存在', 409)

  await db.prepare(`
    INSERT INTO testimonial_cases
      (id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, 1)
  `).bind(caseId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, metadata.featured === false ? 0 : 1, metadata.sortOrder ?? 0, metadata.seoTitle ?? null, metadata.seoDescription ?? null).run()

  for (const file of files) {
    await db.prepare(`
      INSERT INTO testimonial_case_images (id, case_id, r2_key, alt_text, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(file.fileId, caseId, file.r2Key, `${metadata.title} 图片`, file.mimeType, file.fileSize, file.sortOrder).run()
  }
}

async function cleanupFailedImport(db: D1Database, r2: R2Bucket, importId: string, uploadedKeys: string[]) {
  if (uploadedKeys.length > 0) await r2.delete(uploadedKeys)
  const fileRows = await db.prepare('SELECT target_file_id, r2_key FROM external_import_files WHERE import_id = ?').bind(importId).all<{ target_file_id: string | null; r2_key: string | null }>()
  const persistedKeys = fileRows.results.map(row => row.r2_key).filter((key): key is string => Boolean(key))
  if (persistedKeys.length > 0) await r2.delete(persistedKeys)
  await db.prepare("UPDATE external_import_files SET r2_key = NULL, target_file_id = NULL WHERE import_id = ?").bind(importId).run()
}
```

- [ ] **Step 6: 运行 service 测试和类型检查**

Run: `pnpm --filter @meigallery/api test -- src/services/telegram-file-id-import.test.ts`

Expected: PASS。

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS。

- [ ] **Step 7: 提交 Task 3**

Run:

```bash
git add packages/api/src/services/telegram-file-id-import.ts packages/api/src/services/telegram-file-id-import.test.ts
git commit -m "feat: 新增 Telegram 导入状态机"
```

Expected: commit 成功。

---

### Task 4: Bot 导入 API 路由

**Files:**
- Create: `packages/api/src/routes/imports.ts`
- Create: `packages/api/src/routes/imports.test.ts`
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: 编写路由测试**

Create `packages/api/src/routes/imports.test.ts`，覆盖鉴权和响应语义：

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { importRoutes } from './imports'
import { hashImportToken } from '../utils/import-token'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/imports', importRoutes)
  return app
}

function createDb(tokenHash: string) {
  return {
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) { params.push(...values); return this },
        async first<T>() {
          if (sql.includes('FROM import_api_tokens')) return { id: 'iat_1', token_hash: tokenHash, permissions: '["gallery:create","testimonial:create"]', allowed_source_bot_keys: '["ops_gallery_bot"]', status: 'active', expires_at: null } as T
          if (sql.includes('FROM external_import_records')) return null as T
          return null as T
        },
        async all<T>() { return { results: [] as T[] } },
        async run() { return { success: true } },
      }
    },
  }
}

const payload = {
  metadata: { type: 'gallery', source: 'telegram', externalMessageId: '-100:1', title: '标题', slug: 'title-001', requiredLevelRank: 0 },
  telegram: { sourceBotKey: 'ops_gallery_bot', sourceChatId: '-100', sourceMessageId: '1' },
  files: [{ fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true }],
}

describe('Telegram 导入 API', () => {
  it('requires bearer import token', async () => {
    const res = await createApp().request('/api/imports/telegram-file-id', { method: 'POST', body: JSON.stringify(payload) }, { DB: createDb('') } as unknown as Bindings)

    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('IMPORT_TOKEN_MISSING')
  })

  it('accepts valid token and returns pending_media_fetch', async () => {
    const token = 'mgi_valid_token'
    const res = await createApp().request('/api/imports/telegram-file-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { DB: createDb(await hashImportToken(token)) } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(202)
    expect(body.status).toBe('pending_media_fetch')
    expect(body.importId).toMatch(/^eir_/) 
  })
})
```

- [ ] **Step 2: 实现导入路由**

Create `packages/api/src/routes/imports.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { createExternalImportRecord, getExternalImportStatus, processTelegramFileIdImport, resetFailedImportForRetry } from '../services/telegram-file-id-import'
import { ImportError, importErrorBody } from '../utils/import-errors'
import { hashImportToken, hasImportPermission, isImportTokenExpired, isSourceBotAllowed } from '../utils/import-token'
import { importPermissionForType, validateTelegramImportPayload } from '../utils/import-validation'

export const importRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type ImportTokenRow = {
  id: string
  permissions: string
  allowed_source_bot_keys: string
  status: 'active' | 'disabled'
  expires_at: string | null
}

async function requireImportToken(c: { req: any; env: Bindings }) {
  const authorization = c.req.header('Authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/)
  if (!match) throw new ImportError('IMPORT_TOKEN_MISSING', '缺少 Import Token', 401)
  const tokenHash = await hashImportToken(match[1])
  const row = await c.env.DB.prepare('SELECT id, permissions, allowed_source_bot_keys, status, expires_at FROM import_api_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<ImportTokenRow>()
  if (!row) throw new ImportError('IMPORT_TOKEN_INVALID', 'Import Token 无效', 401)
  if (row.status !== 'active') throw new ImportError('IMPORT_TOKEN_DISABLED', 'Import Token 已禁用', 403)
  if (isImportTokenExpired(row.expires_at)) throw new ImportError('IMPORT_TOKEN_EXPIRED', 'Import Token 已过期', 403)
  await c.env.DB.prepare("UPDATE import_api_tokens SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(row.id).run()
  return row
}

function clientIp(c: { req: any }) {
  return c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null
}

importRoutes.post('/telegram-file-id', async (c) => {
  try {
    const token = await requireImportToken(c)
    const payload = validateTelegramImportPayload(await c.req.json())
    const permission = importPermissionForType(payload.metadata.type)
    if (!hasImportPermission(token.permissions, permission)) throw new ImportError('IMPORT_PERMISSION_DENIED', 'Import Token 权限不足', 403)
    if (!isSourceBotAllowed(token.allowed_source_bot_keys, payload.telegram.sourceBotKey)) throw new ImportError('IMPORT_SOURCE_BOT_NOT_ALLOWED', 'sourceBotKey 不在允许列表中', 403)

    const result = await createExternalImportRecord(c.env.DB, token.id, payload, clientIp(c), c.req.header('User-Agent') || null)
    if (result.status !== 'duplicate') c.executionCtx.waitUntil(processTelegramFileIdImport(c.env.DB, c.env.R2, c.env as unknown as Record<string, string | undefined>, result.importId))
    return c.json(result, result.status === 'duplicate' ? 200 : 202)
  } catch (error) {
    if (error instanceof ImportError) return c.json(importErrorBody(error), error.status)
    return c.json(importErrorBody(new ImportError('IMPORT_PROCESS_FAILED', '导入请求处理失败', 500)), 500)
  }
})

importRoutes.get('/:importId', async (c) => {
  try {
    const token = await requireImportToken(c)
    return c.json(await getExternalImportStatus(c.env.DB, c.req.param('importId'), token.id))
  } catch (error) {
    if (error instanceof ImportError) return c.json(importErrorBody(error), error.status)
    return c.json(importErrorBody(new ImportError('IMPORT_PROCESS_FAILED', '导入状态查询失败', 500)), 500)
  }
})

importRoutes.post('/:importId/retry', async (c) => {
  try {
    const token = await requireImportToken(c)
    const result = await resetFailedImportForRetry(c.env.DB, c.req.param('importId'), token.id)
    c.executionCtx.waitUntil(processTelegramFileIdImport(c.env.DB, c.env.R2, c.env as unknown as Record<string, string | undefined>, result.importId))
    return c.json(result, 202)
  } catch (error) {
    if (error instanceof ImportError) return c.json(importErrorBody(error), error.status)
    return c.json(importErrorBody(new ImportError('IMPORT_PROCESS_FAILED', '导入重试失败', 500)), 500)
  }
})
```

- [ ] **Step 3: 挂载公开导入路由并扩展 Bindings**

Modify `packages/api/src/index.ts`:

```ts
import { importRoutes } from './routes/imports'
```

Update `Bindings`:

```ts
export type Bindings = CloudflareEnv & {
  APP_ENV: string
  SESSION_SECRET: string
  TURNSTILE_SECRET_KEY: string
  STREAM_ACCOUNT_ID: string
  STREAM_API_TOKEN: string
  EMAIL_FROM: string
  EMAIL: SendEmail
  IMAGE_RESIZING_ENABLED: string
  IMPORT_TOKEN_DAILY_LIMIT?: string
  TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT?: string
}
```

Mount route before admin route:

```ts
app.use('/api/imports/*', rateLimiter({ limit: 120, windowMs: 60_000 }))
app.route('/api/imports', importRoutes)
```

- [ ] **Step 4: 运行路由测试**

Run: `pnpm --filter @meigallery/api test -- src/routes/imports.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交 Task 4**

Run:

```bash
git add packages/api/src/routes/imports.ts packages/api/src/routes/imports.test.ts packages/api/src/index.ts
git commit -m "feat: 新增 Telegram 导入 API 路由"
```

Expected: commit 成功。

---

### Task 5: 后台 Token 与导入记录 API

**Files:**
- Create: `packages/api/src/routes/admin/import-api-tokens.ts`
- Create: `packages/api/src/routes/admin/external-import-records.ts`
- Create: `packages/api/src/routes/admin/import-api-tokens.test.ts`
- Create: `packages/api/src/routes/admin/external-import-records.test.ts`
- Modify: `packages/api/src/routes/admin/index.ts`

- [ ] **Step 1: 实现 Import Token 后台路由**

Create `packages/api/src/routes/admin/import-api-tokens.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { generateId } from '../../utils/db'
import { createImportToken, hashImportToken } from '../../utils/import-token'
import { writeAuditLog } from '../../utils/permission'

export const adminImportApiTokenRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminImportApiTokenRoutes.use('*', requireOwner)

adminImportApiTokenRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT id, name, permissions, allowed_source_bot_keys, status, expires_at, last_used_at, created_at, updated_at
    FROM import_api_tokens
    ORDER BY created_at DESC
  `).all()
  return c.json({ data: rows.results })
})

adminImportApiTokenRoutes.post('/', async (c) => {
  const ownerId = c.get('userId')!
  const body = await c.req.json<{ name?: string; permissions?: string[]; allowedSourceBotKeys?: string[]; expiresAt?: string | null }>()
  if (!body.name || body.name.trim().length > 60) return c.json({ statusCode: 400, message: 'Token 名称为必填且不能超过 60 字' }, 400)
  const permissions = (body.permissions ?? []).filter(permission => permission === 'gallery:create' || permission === 'testimonial:create')
  if (permissions.length === 0) return c.json({ statusCode: 400, message: '至少选择一个导入权限' }, 400)
  const allowedSourceBotKeys = body.allowedSourceBotKeys ?? []
  if (allowedSourceBotKeys.some(key => !/^[a-z0-9_]{3,64}$/.test(key))) return c.json({ statusCode: 400, message: 'sourceBotKey 只能包含小写字母、数字和下划线' }, 400)

  const token = createImportToken()
  const id = generateId('iat')
  await c.env.DB.prepare(`
    INSERT INTO import_api_tokens (id, name, token_hash, permissions, allowed_source_bot_keys, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, body.name.trim(), await hashImportToken(token), JSON.stringify(permissions), JSON.stringify(allowedSourceBotKeys), body.expiresAt ?? null, ownerId).run()

  await writeAuditLog(c.env.DB, { adminId: ownerId, action: 'import_token.create', targetType: 'import_api_token', targetId: id, afterValue: { name: body.name, permissions, allowedSourceBotKeys, expiresAt: body.expiresAt ?? null } })
  return c.json({ id, token, message: 'Import Token 已创建，请立即保存，刷新后无法再次查看' }, 201)
})

adminImportApiTokenRoutes.patch('/:id', async (c) => {
  const ownerId = c.get('userId')!
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; permissions?: string[]; allowedSourceBotKeys?: string[]; status?: 'active' | 'disabled'; expiresAt?: string | null }>()
  const before = await c.env.DB.prepare('SELECT * FROM import_api_tokens WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!before) return c.json({ statusCode: 404, message: 'Import Token 不存在' }, 404)

  await c.env.DB.prepare(`
    UPDATE import_api_tokens
    SET name = ?, permissions = ?, allowed_source_bot_keys = ?, status = ?, expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    body.name?.trim() || before.name,
    JSON.stringify(body.permissions ?? JSON.parse(String(before.permissions))),
    JSON.stringify(body.allowedSourceBotKeys ?? JSON.parse(String(before.allowed_source_bot_keys))),
    body.status ?? before.status,
    body.expiresAt === undefined ? before.expires_at : body.expiresAt,
    id,
  ).run()

  await writeAuditLog(c.env.DB, { adminId: ownerId, action: 'import_token.update', targetType: 'import_api_token', targetId: id, beforeValue: before, afterValue: body })
  return c.json({ message: 'Import Token 已更新' })
})

adminImportApiTokenRoutes.delete('/:id', async (c) => {
  const ownerId = c.get('userId')!
  const id = c.req.param('id')
  await c.env.DB.prepare("UPDATE import_api_tokens SET status = 'disabled', updated_at = datetime('now') WHERE id = ?").bind(id).run()
  await writeAuditLog(c.env.DB, { adminId: ownerId, action: 'import_token.disable', targetType: 'import_api_token', targetId: id })
  return c.json({ message: 'Import Token 已禁用' })
})
```

- [ ] **Step 2: 实现外部导入记录后台路由**

Create `packages/api/src/routes/admin/external-import-records.ts`:

```ts
import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminExternalImportRecordRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminExternalImportRecordRoutes.use('*', requireAdmin)

adminExternalImportRecordRoutes.get('/', async (c) => {
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, Number.parseInt(c.req.query('pageSize') || '20', 10)))
  const offset = (page - 1) * pageSize
  const conditions: string[] = []
  const params: unknown[] = []
  for (const [queryKey, column] of [['source', 'source'], ['targetType', 'target_type'], ['status', 'status'], ['sourceBotKey', 'source_bot_key']] as const) {
    const value = c.req.query(queryKey)
    if (value) { conditions.push(`${column} = ?`); params.push(value) }
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const total = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM external_import_records ${where}`).bind(...params).first<{ total: number }>()
  const rows = await c.env.DB.prepare(`
    SELECT id, source, external_message_id, source_bot_key, target_type, target_id, status, file_count, fetched_count, failed_count, retry_count, created_at, completed_at
    FROM external_import_records
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, pageSize, offset).all()
  return c.json({ data: rows.results, total: total?.total ?? 0, page, pageSize })
})

adminExternalImportRecordRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const record = await c.env.DB.prepare(`
    SELECT id, source, external_message_id, source_bot_key, source_chat_id, source_message_id, media_group_id,
           target_type, target_id, status, metadata_json, file_count, fetched_count, failed_count, retry_count,
           error_json, request_ip, user_agent, created_at, completed_at
    FROM external_import_records
    WHERE id = ?
  `).bind(id).first<Record<string, unknown>>()
  if (!record) return c.json({ statusCode: 404, message: '外部导入记录不存在' }, 404)
  const files = await c.env.DB.prepare(`
    SELECT id, filename, declared_mime_type, actual_mime_type, file_size, sort_order, is_cover, status, error_message
    FROM external_import_files
    WHERE import_id = ?
    ORDER BY sort_order ASC
  `).bind(id).all()
  return c.json({ ...record, files: files.results })
})
```

- [ ] **Step 3: 挂载后台路由**

Modify `packages/api/src/routes/admin/index.ts`:

```ts
import { adminImportApiTokenRoutes } from './import-api-tokens'
import { adminExternalImportRecordRoutes } from './external-import-records'
```

Add routes:

```ts
adminRoutes.route('/import-api-tokens', adminImportApiTokenRoutes)
adminRoutes.route('/external-import-records', adminExternalImportRecordRoutes)
```

- [ ] **Step 4: 编写后台路由最小测试**

Create `packages/api/src/routes/admin/import-api-tokens.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminImportApiTokenRoutes } from './import-api-tokens'

function app(role: string | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => { c.set('userId', role ? 1 : null); c.set('userRole', role); await next() })
  app.route('/api/admin/import-api-tokens', adminImportApiTokenRoutes)
  return app
}

const db = { prepare: () => ({ bind() { return this }, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ success: true }) }) }

describe('后台 Import Token API', () => {
  it('requires owner role', async () => {
    const res = await app('admin').request('/api/admin/import-api-tokens', {}, { DB: db } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('returns plaintext token only on create response', async () => {
    const res = await app('owner').request('/api/admin/import-api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops Bot', permissions: ['gallery:create'], allowedSourceBotKeys: ['ops_gallery_bot'] }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.token).toMatch(/^mgi_/)
  })
})
```

Create `packages/api/src/routes/admin/external-import-records.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminExternalImportRecordRoutes } from './external-import-records'

function app(role: string | null = 'admin') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => { c.set('userId', role ? 1 : null); c.set('userRole', role); await next() })
  app.route('/api/admin/external-import-records', adminExternalImportRecordRoutes)
  return app
}

describe('后台外部导入记录 API', () => {
  it('does not expose Telegram token or download URL', async () => {
    const db = { prepare: () => ({ bind() { return this }, first: async () => ({ id: 'eir_1', source_bot_key: 'ops_gallery_bot', metadata_json: '{}', error_json: '{"message":"失败"}' }), all: async () => ({ results: [{ filename: '001.jpg', status: 'failed' }] }) }) }
    const res = await app().request('/api/admin/external-import-records/eir_1', {}, { DB: db } as unknown as Bindings)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('api.telegram.org/file')
    expect(text).not.toContain('123:secret')
  })
})
```

- [ ] **Step 5: 运行后台路由测试**

Run: `pnpm --filter @meigallery/api test -- src/routes/admin/import-api-tokens.test.ts src/routes/admin/external-import-records.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 Task 5**

Run:

```bash
git add packages/api/src/routes/admin/import-api-tokens.ts packages/api/src/routes/admin/external-import-records.ts packages/api/src/routes/admin/import-api-tokens.test.ts packages/api/src/routes/admin/external-import-records.test.ts packages/api/src/routes/admin/index.ts
git commit -m "feat: 新增导入令牌后台接口"
```

Expected: commit 成功。

---

### Task 6: Queue 边界、配置与验收

**Files:**
- Modify: `packages/api/wrangler.toml`
- Modify: `packages/api/src/index.ts`
- Modify: `docs/superpowers/specs/2026-05-06-telegram-import-api-doc.md`

- [ ] **Step 1: 在 wrangler 配置预留 Queue 和每日限制**

Modify `packages/api/wrangler.toml`，在生产和 dev 环境增加变量：

```toml
[vars]
IMPORT_TOKEN_DAILY_LIMIT = "500"

[env.dev.vars]
IMPORT_TOKEN_DAILY_LIMIT = "50"
```

如果当前范围无法创建 Cloudflare Queue，保留 `waitUntil()` 处理；如果可以创建 Queue，追加：

```toml
[[queues.producers]]
binding = "TELEGRAM_IMPORT_QUEUE"
queue = "meigallery-telegram-import"

[[queues.consumers]]
queue = "meigallery-telegram-import"
max_batch_size = 5
max_batch_timeout = 30

[[env.dev.queues.producers]]
binding = "TELEGRAM_IMPORT_QUEUE"
queue = "meigallery-telegram-import-dev"

[[env.dev.queues.consumers]]
queue = "meigallery-telegram-import-dev"
max_batch_size = 2
max_batch_timeout = 30
```

- [ ] **Step 2: 配置 dev Telegram Bot Token secret**

Run:

```bash
pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT --env dev
```

Expected: Wrangler 提示输入 secret，粘贴 BotFather 提供的 dev Bot Token；命令输出包含 secret created 或 updated。

- [ ] **Step 3: 应用 dev D1 migration**

Run:

```bash
pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote --env dev
```

Expected: `0015_telegram_import_api.sql` applied，或显示已应用。

- [ ] **Step 4: 部署 dev API Worker**

Run:

```bash
pnpm --filter @meigallery/api exec wrangler deploy --env dev
```

Expected: 部署到 `https://meigallery-api-dev.250770503.workers.dev`，不绑定生产域名。

- [ ] **Step 5: curl 验证缺少 token 返回 401**

Run:

```bash
curl -i -X POST "https://meigallery-api-dev.250770503.workers.dev/api/imports/telegram-file-id" \
  -H "Content-Type: application/json" \
  --data '{"metadata":{"type":"gallery","source":"telegram","externalMessageId":"-100:1","title":"标题","slug":"title-001"},"telegram":{"sourceBotKey":"ops_gallery_bot","sourceChatId":"-100","sourceMessageId":"1"},"files":[{"fileId":"AgACAg1","mimeType":"image/jpeg","sortOrder":0}]}'
```

Expected: HTTP 401，body 包含 `IMPORT_TOKEN_MISSING`。

- [ ] **Step 6: 创建 dev Import Token 并执行真实导入验收**

在后台或 D1 临时插入 Import Token 后，使用 API 文档中的 curl 样例提交真实 Telegram `file_id`。预期：

```json
{
  "status": "pending_media_fetch"
}
```

然后轮询：

```bash
curl "https://meigallery-api-dev.250770503.workers.dev/api/imports/eir_xxx" \
  -H "Authorization: Bearer mgi_xxx"
```

Expected: 最终状态为 `draft_created` 或可解释的 `failed`；如果失败，`targetId` 必须为 `null`。

- [ ] **Step 7: 更新 Bot 对接文档实际状态**

Modify `docs/superpowers/specs/2026-05-06-telegram-import-api-doc.md`，在第 1 节后追加：

```md
## 1.1 Dev 验收状态

- Dev API 已支持 `POST /api/imports/telegram-file-id`、`GET /api/imports/:importId`、`POST /api/imports/:importId/retry`。
- Dev 环境仅使用 dev Import Token 和 dev Telegram Bot Token。
- Bot 开发方不得把生产 Import Token 或 Telegram Bot Token 写入日志、Issue、PR 或聊天记录。
```

- [ ] **Step 8: 提交 Task 6**

Run:

```bash
git add packages/api/wrangler.toml packages/api/src/index.ts docs/superpowers/specs/2026-05-06-telegram-import-api-doc.md
git commit -m "deploy: 配置 Telegram 导入开发验收"
```

Expected: commit 成功。

---

## 最终验证

- [ ] **Step 1: 运行 API 全量测试**

Run: `pnpm --filter @meigallery/api test`

Expected: PASS，现有真实案例、认证、搜索、会员和 Telegram 导入测试全部通过。

- [ ] **Step 2: 运行 API 类型检查**

Run: `pnpm --filter @meigallery/api exec tsc --noEmit`

Expected: PASS，无 TypeScript 错误。

- [ ] **Step 3: 运行 Web 构建保护检查**

Run: `pnpm --filter @meigallery/web exec nuxt build`

Expected: PASS；允许 Nuxt/Tailwind sourcemap warning，不允许构建失败。

- [ ] **Step 4: 检查没有泄露敏感信息**

Run: `git diff --cached`

Expected: diff 中不得出现真实 Import Token、Telegram Bot Token、Telegram 下载 URL、R2 私有对象直链。

- [ ] **Step 5: 推送 dev 分支**

Run: `git push origin dev`

Expected: 推送成功。

---

## 实施注意事项

- 所有导入目标固定写入 `draft`，不得允许请求 payload 覆盖为 `published`。
- `failed` 必须表示没有可用目标草稿，`target_id` 必须为 `NULL`，目标草稿、目标媒体记录和已上传 R2 对象必须清理。
- `duplicate` 响应必须返回原 `importId`，不能创建新的导入记录。
- Import Token 数据库只保存 SHA-256 hash，后台列表和详情不返回 `token_hash`。
- Telegram Bot Token 只从 Worker secret 或 Secrets Store 读取，不进入 D1、R2、API 响应、审计日志和 worker log。
- `waitUntil()` 是 MVP 低频处理方式；如果创建 Cloudflare Queues，HTTP route 只发送 `{ importId }`，处理逻辑继续复用 `processTelegramFileIdImport`。
- Dev 部署必须保持 `workers_dev = true` 和 `routes = []`，避免 dev Worker 绑定生产域名。
