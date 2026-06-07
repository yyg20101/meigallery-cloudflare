# 后台广告位上传与实时预览设计

## 1. Executive Summary

**Problem Statement**

- 后台广告位管理页已有大图 URL 字段和已保存广告的大图上传区，但新增广告位时缺少直接选择本地图片的入口，站长需要先创建记录再上传，体验割裂。
- 首页预览已复用 `HomeAdBand`，但不能预览尚未上传的本地图片；图片格式、大小和推荐尺寸说明也不够完整。

**Proposed Solution**

- 在 `/admin/ads` 的广告表单内加入统一的大图选择区：新建和编辑都可以选择本地图片，选择后立即进入首页预览。
- 新建广告位保存时先创建广告记录，再自动上传已选择的大图到现有 `/api/admin/ads/:id/image` 接口；已保存广告位继续支持上传和删除。
- 跳转链接保持默认 `/discover?sort=hot`，不修改也可以保存，并通过测试确认首页真实 CTA 可以正常跳转，后台预览模式仍不可跳转。

**Success Criteria**

- 新建广告位无需先保存，就可以选择本地图片并在首页预览中看到效果。
- 点击“创建广告位”后，如果存在待上传图片，系统自动完成创建和图片上传，成功后列表、表单和预览展示 R2 公开图片地址。
- UI 明确展示图片格式、大小和尺寸建议：PNG / JPEG / WebP，单张不超过 3MB，推荐 16:7，建议 1600x700 或更高，不低于 1200x525。
- 表单跳转链接未改动时保存为 `/discover?sort=hot`；首页真实广告 CTA 的 `href`、站内跳转行为和安全说明通过 smoke 覆盖。
- 后台预览继续使用不可跳转的 `HomeAdBand preview`，但实时反映标题、摘要、按钮、链接、赞助说明和本地待上传图片。

## 2. User Experience & Functionality

**User Personas**

- Owner：在后台新增首页广告，希望一次完成文案、链接、图片和效果确认。
- 运营人员：需要在保存前确认首页展示效果，避免上传后再回到首页反复检查。

**User Stories**

- As an Owner, I want to select a local ad image while creating a new ad so that I do not need to create an empty ad before uploading the image.
- As an Owner, I want the selected local image to appear in the homepage preview immediately so that I can judge visual fit before saving.
- As an Owner, I want clear image requirements near the upload control so that I can prepare the correct file format, size, and aspect ratio.
- As an Owner, I want the default target link to work without editing so that creating a basic ad does not require link configuration.

**Acceptance Criteria**

- The ad form contains a local image picker visible in both create and edit states.
- The picker accepts `image/png`, `image/jpeg`, and `image/webp`.
- Client-side validation rejects files over 3MB before sending a request.
- Client-side image inspection rejects images smaller than 1200x525 before preview/upload and shows a clear recommended 16:7 / 1600x700 guideline.
- Selecting a valid image updates `HomeAdBand` preview through a local object URL.
- Replacing or clearing the pending image revokes the previous object URL to avoid leaking browser memory.
- Creating a new ad with a pending image performs `POST /api/admin/ads`, then `POST /api/admin/ads/:id/image`.
- If the ad is created but image upload fails, the UI shows that the ad was created and the image upload failed, leaving the user on the created ad so they can retry.
- Editing an existing ad can still upload a new image through the existing image endpoint.
- The image URL field remains available for safe `/api/media/public/home-ads/...` or `https://` image URLs, but local upload is the primary path.
- The default target link remains `/discover?sort=hot`.
- Backend upload validation remains authoritative for MIME type and 3MB file size.

**Non-Goals**

- No temporary R2 upload before an ad exists.
- No image cropping UI.
- No server-side dimension validation in this iteration; browser-side dimension validation guides normal admin usage, while server still protects file type and size.
- No ad impression/click analytics changes.
- No new placement, audience targeting, or third-party ad SDK.

## 3. Technical Specifications

**Architecture Overview**

```text
/admin/ads form
  -> user selects local image
  -> client validates type, size, and dimensions
  -> client stores pending File + object URL
  -> HomeAdBand preview uses object URL immediately
  -> user clicks create/save

Create flow:
  -> POST /api/admin/ads with normalized text/link/schedule fields
  -> receive ad id
  -> if pending File exists, POST /api/admin/ads/:id/image as FormData(file)
  -> refresh ads list and select created ad

Edit flow:
  -> existing PUT /api/admin/ads/:id saves text/link/schedule fields
  -> pending File can be uploaded to /api/admin/ads/:id/image
  -> refresh ads list and update preview
```

**Frontend Changes**

- Add local state to `packages/web/app/pages/admin/ads.vue`:
  - `pendingImageFile`
  - `pendingImagePreviewUrl`
  - `pendingImageMeta`
  - `pendingImageError`
- Add helpers:
  - validate file MIME and size before upload.
  - read image dimensions through `Image` and object URL.
  - revoke object URLs when replacing, clearing, selecting an ad, resetting the form, or unmounting.
- Update `previewAds` to prefer `pendingImagePreviewUrl`, then `form.imageUrl`.
- Add an upload section inside the main form with clear requirements and current file metadata.
- Keep the existing saved-ad image delete action.
- Keep the image URL input, but label local upload as the recommended path.

**Backend Changes**

- Reuse existing `POST /api/admin/ads/:id/image`.
- Keep existing allowed MIME types: PNG, JPEG, WebP.
- Keep existing 3MB size limit.
- Add API tests for the image endpoint because the current route test file does not directly cover upload success, unsupported MIME type, oversized file, and R2 key replacement.

**Testing**

- Web unit tests cover local file selection validation failures, valid image preview state, and object URL cleanup.
- API tests cover successful image upload, unsupported MIME type, oversized file, and R2 key replacement.
- Playwright smoke must cover:
  - `/admin/ads` default target link remains `/discover?sort=hot`.
  - preview CTA is not a real link in preview mode.
  - homepage real CTA has `href="/discover?sort=hot"` when link is not modified.
  - choosing or simulating an uploaded image updates the preview without leaking private R2 keys.

## 4. Risks & Handling

- **Created ad but image upload failed**: show a specific warning and keep the newly created ad selected so the user can retry image upload.
- **Large images causing slow local preview**: reject files over 3MB before preview/upload.
- **Wrong aspect ratio**: show dimensions and enforce minimum dimensions; recommended 16:7 communicates the homepage frame clearly.
- **Object URL memory leaks**: revoke URLs on replacement, reset, selection change, and unmount.
- **Unsafe image URL input**: existing API normalization continues to reject unsafe non-ad media paths and unsafe external URLs.

## 5. Implementation Notes

- The approved approach is "local select -> realtime preview -> create record -> auto upload image".
- Existing `HomeAdBand preview` remains the source of truth for preview appearance.
- Existing backend upload endpoint and R2 key layout remain unchanged: `home-ads/{adId}/{imageId}.{ext}`.
- The implementation should favor the existing admin page style: dense, utilitarian, quiet, and task-focused.
