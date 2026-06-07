# Admin Home Ad Upload Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build local image selection, pre-upload validation, realtime homepage preview, and default link verification for `/admin/ads`.

**Architecture:** Reuse the existing Owner-only `/api/admin/ads/:id/image` endpoint and R2 key layout. Add a small Web utility for image requirements and validation so the admin page stays readable and validation is unit-testable. The admin page stores a pending `File` plus object URL for realtime preview, then creates the ad record before auto-uploading the pending image.

**Tech Stack:** Nuxt 4, Vue 3 Composition API, Hono, Cloudflare D1/R2 bindings, Vitest, Vue Test Utils, Playwright.

---

### Task 1: API Upload Route Coverage

**Files:**
- Modify: `packages/api/src/routes/admin/ads.test.ts`

- [x] **Step 1: Add image upload success and replacement tests**

Add tests that submit `FormData(file)` to `POST /api/admin/ads/ad-1/image`, assert R2 `put`, old R2 `delete` when replacing, DB update, and `home_ad_image_upload` audit log.

```ts
it('上传广告大图时写入 R2、更新图片字段并记录审计日志', async () => {
  const executed: ExecutedSql = []
  const r2Put = vi.fn()
  const app = createApp()
  const env = {
    DB: createDb({
      first: () => adRow(),
      run: (sql, params) => {
        executed.push({ sql, params })
        return { success: true }
      },
    }),
    R2: { put: r2Put },
  } as unknown as Bindings
  const body = new FormData()
  body.set('file', new File(['image'], 'hero.webp', { type: 'image/webp' }))

  const res = await app.request('/api/admin/ads/ad-1/image', { method: 'POST', body }, env)
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.imageUrl).toMatch(/^\/api\/media\/public\/home-ads\/ad-1\/image_/)
  expect(r2Put).toHaveBeenCalledWith(expect.stringMatching(/^home-ads\/ad-1\/image_.*\.webp$/), expect.any(ArrayBuffer), expect.any(Object))
  expect(executed.some(item => item.sql.includes('UPDATE home_ads SET image_key = ?'))).toBe(true)
  expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs') && item.params[2] === 'home_ad_image_upload')).toBe(true)
})
```

- [x] **Step 2: Add invalid image tests**

Add tests for unsupported MIME type and over-3MB file. Expected result: `400`, no R2 write.

```ts
it('上传广告大图时拒绝不支持的格式和超过 3MB 的文件', async () => {
  const r2Put = vi.fn()
  const app = createApp()
  const env = {
    DB: createDb({ first: () => adRow() }),
    R2: { put: r2Put },
  } as unknown as Bindings

  const gif = new FormData()
  gif.set('file', new File(['gif'], 'hero.gif', { type: 'image/gif' }))
  const gifRes = await app.request('/api/admin/ads/ad-1/image', { method: 'POST', body: gif }, env)
  expect(gifRes.status).toBe(400)

  const oversized = new FormData()
  oversized.set('file', new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'hero.webp', { type: 'image/webp' }))
  const oversizedRes = await app.request('/api/admin/ads/ad-1/image', { method: 'POST', body: oversized }, env)
  expect(oversizedRes.status).toBe(400)
  expect(r2Put).not.toHaveBeenCalled()
})
```

- [x] **Step 3: Run API route tests**

Run: `corepack pnpm --filter @meigallery/api exec vitest run src/routes/admin/ads.test.ts`

Expected: PASS.

### Task 2: Web Image Validation Utility

**Files:**
- Create: `packages/web/app/utils/adminHomeAdImage.ts`
- Create: `packages/web/app/utils/adminHomeAdImage.test.ts`

- [x] **Step 1: Add failing utility tests**

Cover accepted MIME types, max size, minimum dimensions, and requirement text.

```ts
import { describe, expect, it } from 'vitest'
import {
  HOME_AD_IMAGE_REQUIREMENTS,
  validateHomeAdImageDimensions,
  validateHomeAdImageFile,
} from './adminHomeAdImage'

describe('adminHomeAdImage', () => {
  it('描述广告大图格式、大小和尺寸要求', () => {
    expect(HOME_AD_IMAGE_REQUIREMENTS.accept).toBe('image/png,image/jpeg,image/webp')
    expect(HOME_AD_IMAGE_REQUIREMENTS.maxBytes).toBe(3 * 1024 * 1024)
    expect(HOME_AD_IMAGE_REQUIREMENTS.minWidth).toBe(1200)
    expect(HOME_AD_IMAGE_REQUIREMENTS.minHeight).toBe(525)
  })

  it('选择阶段拒绝错误格式和超过 3MB 的文件', () => {
    expect(validateHomeAdImageFile(new File(['x'], 'ad.gif', { type: 'image/gif' }))).toEqual({
      valid: false,
      message: '广告大图仅支持 PNG、JPEG、WebP 格式',
    })
    expect(validateHomeAdImageFile(new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'ad.webp', { type: 'image/webp' })).valid).toBe(false)
  })

  it('选择阶段拒绝尺寸过小的图片', () => {
    expect(validateHomeAdImageDimensions(1199, 700).valid).toBe(false)
    expect(validateHomeAdImageDimensions(1600, 700)).toEqual({ valid: true })
  })
})
```

- [x] **Step 2: Implement utility**

```ts
export const HOME_AD_IMAGE_REQUIREMENTS = {
  accept: 'image/png,image/jpeg,image/webp',
  formatsLabel: 'PNG、JPEG、WebP',
  maxBytes: 3 * 1024 * 1024,
  maxLabel: '3MB',
  minWidth: 1200,
  minHeight: 525,
  recommendedWidth: 1600,
  recommendedHeight: 700,
  ratioLabel: '16:7',
} as const

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export interface HomeAdImageValidationResult {
  valid: boolean
  message?: string
}

export function validateHomeAdImageFile(file: File): HomeAdImageValidationResult {
  if (!ALLOWED_TYPES.has(file.type)) {
    return { valid: false, message: `广告大图仅支持 ${HOME_AD_IMAGE_REQUIREMENTS.formatsLabel} 格式` }
  }
  if (file.size > HOME_AD_IMAGE_REQUIREMENTS.maxBytes) {
    return { valid: false, message: `广告大图不能超过 ${HOME_AD_IMAGE_REQUIREMENTS.maxLabel}` }
  }
  return { valid: true }
}

export function validateHomeAdImageDimensions(width: number, height: number): HomeAdImageValidationResult {
  if (width < HOME_AD_IMAGE_REQUIREMENTS.minWidth || height < HOME_AD_IMAGE_REQUIREMENTS.minHeight) {
    return {
      valid: false,
      message: `广告大图尺寸不能低于 ${HOME_AD_IMAGE_REQUIREMENTS.minWidth}x${HOME_AD_IMAGE_REQUIREMENTS.minHeight}px`,
    }
  }
  return { valid: true }
}

export function formatHomeAdImageRequirement() {
  return `支持 ${HOME_AD_IMAGE_REQUIREMENTS.formatsLabel}，单张不超过 ${HOME_AD_IMAGE_REQUIREMENTS.maxLabel}；推荐 ${HOME_AD_IMAGE_REQUIREMENTS.ratioLabel}，建议 ${HOME_AD_IMAGE_REQUIREMENTS.recommendedWidth}x${HOME_AD_IMAGE_REQUIREMENTS.recommendedHeight}px 或更高，不低于 ${HOME_AD_IMAGE_REQUIREMENTS.minWidth}x${HOME_AD_IMAGE_REQUIREMENTS.minHeight}px。`
}
```

- [x] **Step 3: Run utility tests**

Run: `corepack pnpm --filter @meigallery/web exec vitest run app/utils/adminHomeAdImage.test.ts`

Expected: PASS.

### Task 3: Admin Ads Page Upload UX

**Files:**
- Modify: `packages/web/app/pages/admin/ads.vue`

- [x] **Step 1: Import the utility and add pending image state**

Add imports and refs for pending image file, preview URL, metadata, and validation error.

```ts
import {
  HOME_AD_IMAGE_REQUIREMENTS,
  formatHomeAdImageRequirement,
  validateHomeAdImageDimensions,
  validateHomeAdImageFile,
} from '~/utils/adminHomeAdImage'
```

- [x] **Step 2: Add image selection helpers**

Implement `handlePendingImageChange`, `readImageDimensions`, `clearPendingImage`, and `revokePendingImagePreview`. Use `URL.createObjectURL(file)` only after MIME/size validation, read dimensions with `Image`, reject below 1200x525, and revoke rejected object URLs immediately.

- [x] **Step 3: Update create/save flow**

When `selectedId` is empty and `pendingImageFile` exists, call `POST /api/admin/ads` first, then `uploadImageFile(createdId, pendingImageFile)`. If upload fails after create succeeds, keep `selectedId` on the created ad and show a specific toast: `广告位已创建，但大图上传失败，请重试上传。`

- [x] **Step 4: Update realtime preview**

Change `previewAds` image source priority to:

```ts
imageUrl: pendingImagePreviewUrl.value || form.imageUrl,
```

- [x] **Step 5: Update template**

Move upload controls into the main form and display:

```text
支持 PNG、JPEG、WebP，单张不超过 3MB；推荐 16:7，建议 1600x700px 或更高，不低于 1200x525px。
```

Use `accept="image/png,image/jpeg,image/webp"`. Show selected filename and dimensions. Show validation errors near the picker. Keep the URL input below as an alternate path.

- [x] **Step 6: Run Web typecheck for the edited page**

Run: `corepack pnpm --filter @meigallery/web typecheck`

Expected: PASS or only the existing non-blocking package export warnings already documented in the repo.

### Task 4: Smoke Coverage for Preview and Default Link

**Files:**
- Modify: `packages/web/tests/e2e/smoke.spec.ts`
- Modify only if needed: `packages/web/tests/e2e/mock-api.mjs`

- [x] **Step 1: Extend admin preview smoke**

In the existing `后台广告预览不渲染可跳转链接` test, assert that the default link input starts as `/discover?sort=hot` before editing.

```ts
await expect(page.locator('input[placeholder="/discover?sort=hot"]')).toHaveValue('/discover?sort=hot')
```

- [x] **Step 2: Confirm homepage real CTA click uses default link**

Add a smoke test that opens `/`, clicks the homepage ad CTA with default `/discover?sort=hot`, and expects the page URL to include `/discover?sort=hot`.

```ts
test('首页广告默认跳转链接可点击进入探索页', async ({ page }) => {
  await page.goto('/')
  const homeAd = page.getByRole('region', { name: '首页广告推荐' })
  await homeAd.getByRole('link', { name: /查看推荐，站内推荐/ }).click()
  await expect(page).toHaveURL(/\/discover\?sort=hot$/)
})
```

- [x] **Step 3: Run targeted smoke**

Run: `corepack pnpm --filter @meigallery/web exec playwright test --grep "首页广告|后台广告"`

Expected: PASS.

### Task 5: Final Verification

**Files:**
- Verify current git diff.

- [x] **Step 1: Run targeted test suite**

Run:

```bash
corepack pnpm --filter @meigallery/api exec vitest run src/routes/admin/ads.test.ts
corepack pnpm --filter @meigallery/web exec vitest run app/utils/adminHomeAdImage.test.ts
corepack pnpm --filter @meigallery/web exec playwright test --grep "首页广告|后台广告"
git diff --check
```

Expected: all commands pass.

- [x] **Step 2: Completion audit**

Check the implementation against all four user requirements:

1. New admin ad has local upload and visible format/size/dimension explanation.
2. Homepage preview updates in realtime with form text, default/edited link, and pending local image.
3. Default link remains `/discover?sort=hot`, preview does not jump, real homepage CTA jumps correctly.
4. File selection validates before preview/upload and rejects invalid files.

- [ ] **Step 3: Commit implementation**

```bash
git add packages/api/src/routes/admin/ads.test.ts \
  packages/web/app/utils/adminHomeAdImage.ts \
  packages/web/app/utils/adminHomeAdImage.test.ts \
  packages/web/app/pages/admin/ads.vue \
  packages/web/tests/e2e/smoke.spec.ts \
  packages/web/tests/e2e/mock-api.mjs
git commit -m "feat: 完善后台广告位上传预览"
```
