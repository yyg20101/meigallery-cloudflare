# MeiGallery Cloudflare PRD

## 1. Executive Summary

**Problem Statement**  
The product needs a responsive Chinese gallery website that can present curated image and video content, support structured discovery through categories and tags, and provide controlled access to premium media without online payments.

**Proposed Solution**  
Build a Cloudflare-based front and back office platform. The public site supports browsing, login, tag search, gallery details, and membership-gated media. The admin console supports content publishing, tag management, batch imports, manual membership grants, validity periods, and audit logs.

**Success Criteria**

- Desktop and mobile key pages reach Lighthouse Performance >= 85 before production launch.
- Combined tag search returns results within 500 ms for 100,000 gallery records under normal load.
- Batch import succeeds for >= 98% of valid galleries in a 100-gallery package.
- Protected video and image access has 100% server-side membership validation coverage.
- An administrator can import, review, and publish a valid gallery package within 3 minutes after upload processing completes.

## 2. User Experience & Functionality

### User Personas

- Visitor: Browses public galleries, searches by tags, views open images and previews.
- Registered User: Logs in, views more free content, checks membership status, and contacts the site owner.
- Member: Unlocks additional images or full videos according to membership level and validity period.
- Administrator: Publishes content, imports media packages, manages tags, and manually grants membership levels.
- Site Owner: Controls contact information, membership policy, content compliance, and operational metrics.

### User Stories

**Story 1: Browse Gallery Content**  
As a visitor, I want to browse curated galleries on desktop and mobile so that I can quickly discover interesting public content.

Acceptance Criteria:

- Homepage shows latest galleries, recommended galleries, popular tags, and video entries.
- Layout adapts to desktop, tablet, and mobile screens.
- Gallery cards show cover image, title, key tags, and membership requirement.
- Public content can be viewed without login.

**Story 2: Search and Filter by Tags**  
As a user, I want to filter galleries by tags such as region and personality so that I can find content matching my preferences.

Acceptance Criteria:

- Search supports tag types including region, personality, style, occupation, hair, clothing, scene, and media type.
- Users can combine multiple tags in one query.
- Search results show active filters and allow removing individual filters.
- Empty results provide related tag suggestions.

**Story 3: View Gallery Details**  
As a user, I want to open a gallery detail page so that I can read its description and view available photos or videos.

Acceptance Criteria:

- Detail page shows title, description, tags, cover, image list, video preview, publish time, and related galleries.
- Locked media is visibly marked with the required membership level.
- Unauthorized users see a login or contact-site-owner prompt instead of protected media URLs.
- Related galleries are based on shared tags.

**Story 4: Login and Membership Status**  
As a registered user, I want to log in and view my membership level so that I understand what content I can unlock.

Acceptance Criteria:

- Login and registration forms include bot protection.
- Account page shows current membership level, start time, expiration time, and site owner contact information.
- Expired memberships automatically lose premium access.
- Users cannot change their own membership level.

**Story 5: Manual Membership Grant**  
As an administrator, I want to assign membership levels and validity periods so that users can unlock premium content after contacting the site owner.

Acceptance Criteria:

- Admin can search users by account, nickname, or contact field.
- Admin can assign level, start time, end time, and internal note.
- Each change writes an audit log with admin ID, user ID, old value, new value, and timestamp.
- Membership level takes effect immediately after saving.

**Story 6: Admin Content Publishing**  
As an administrator, I want to create and edit galleries so that only approved content appears on the public site.

Acceptance Criteria:

- Admin can create draft galleries with title, description, tags, cover, images, videos, status, and required level.
- Admin can preview draft content before publishing.
- Admin can publish, unpublish, archive, or edit galleries.
- Public users cannot upload or publish content.

**Story 7: Batch Import**  
As an administrator, I want to upload a local package containing copy, images, and videos so that I can publish many galleries efficiently.

Acceptance Criteria:

- Admin can upload a zip package following the import specification.
- System validates required files, allowed file types, duplicate folders, and manifest fields.
- Valid galleries are imported as drafts by default.
- Failed gallery folders show row-level errors without blocking other valid galleries.
- Import history shows status, totals, success count, failure count, and error report.

### Non-Goals

- No online payment in the initial version.
- No public user uploads or creator accounts.
- No comments, private messages, or social feed.
- No crawler-based content collection.
- No multilingual experience in the initial version.
- No AI automation in the initial release.

## 3. AI System Requirements

AI is not required for the initial release.

Future optional AI capabilities:

- Auto-suggest tags from image metadata and gallery copy.
- Generate draft summaries from administrator-provided content.
- Assist content moderation by flagging possible copyright, privacy, or policy risks.
- Recommend similar galleries based on tags and user behavior.

Evaluation Strategy for future AI:

- Tag suggestion precision@10 >= 85% on a manually reviewed validation set.
- Moderation assistant false-negative rate must be reviewed before any automated workflow is allowed.
- AI output must remain advisory; administrators make final publishing decisions.

## 4. Technical Specifications

### Architecture Overview

- Cloudflare Pages hosts the responsive frontend and admin frontend.
- Cloudflare Workers or Pages Functions expose API endpoints for auth, galleries, search, media access, imports, and admin operations.
- Cloudflare D1 stores structured data such as users, memberships, galleries, tags, assets, import jobs, and audit logs.
- Cloudflare R2 stores imported zip packages, private image originals, generated thumbnails, and import error reports.
- Cloudflare Stream stores, encodes, and serves video assets with access control.
- Cloudflare Turnstile protects login, registration, and sensitive forms.
- Cloudflare WAF and rate limiting protect public and admin endpoints.

### Integration Points

- Auth: Email/password or magic link login, with role-based access for administrators.
- D1: Relational records for domain data and queryable tag search.
- R2: Object storage for image assets and import packages.
- Stream: Video upload, preview playback, full video playback, and signed access.
- Turnstile: Bot protection for public forms and admin login.
- Contact: Configurable site owner contact methods displayed to registered users.

### Suggested Data Model

`users`

- `id`
- `email`
- `nickname`
- `password_hash`
- `role`
- `status`
- `created_at`
- `updated_at`

`membership_levels`

- `id`
- `code`
- `name`
- `rank`
- `description`
- `created_at`

`user_memberships`

- `id`
- `user_id`
- `level_id`
- `starts_at`
- `expires_at`
- `admin_note`
- `created_by`
- `created_at`

`galleries`

- `id`
- `title`
- `slug`
- `summary`
- `body_md`
- `cover_asset_id`
- `required_level_id`
- `status`
- `published_at`
- `created_at`
- `updated_at`

`media_assets`

- `id`
- `gallery_id`
- `type`
- `storage_provider`
- `r2_key`
- `stream_uid`
- `access_level_id`
- `sort_order`
- `created_at`

`tags`

- `id`
- `type`
- `name`
- `slug`
- `created_at`

`gallery_tags`

- `gallery_id`
- `tag_id`

`import_jobs`

- `id`
- `status`
- `source_r2_key`
- `total_count`
- `success_count`
- `failure_count`
- `error_report_r2_key`
- `created_by`
- `created_at`
- `completed_at`

`admin_audit_logs`

- `id`
- `admin_id`
- `action`
- `target_type`
- `target_id`
- `before_json`
- `after_json`
- `created_at`

### Batch Import Specification

Default package:

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
  gallery-002/
    content.md
    cover.jpg
    images/
      001.jpg
    videos/
```

`manifest.csv`:

```csv
folder,title,region,personality,style,tags,required_level,status
gallery-001,夏日写真,广东,甜美,清新,"长发,户外,视频",vip,draft
gallery-002,城市街拍,上海,高冷,都市,"短发,街拍",free,published
```

`content.md`:

```md
# 夏日写真

这里是图库文字说明。

- 地区：广东
- 性格：甜美
- 风格：清新
```

Validation rules:

- `manifest.csv`, `content.md`, and `cover.jpg` are required.
- Each gallery folder must include at least one image.
- Supported image formats: jpg, jpeg, png, webp.
- Supported video format for import: mp4.
- `videos/preview.mp4` is optional and may be available to public users.
- `videos/full.mp4` is optional and must respect gallery or asset-level membership requirements.
- Unknown tags are created automatically after validation.
- Invalid rows produce error messages with folder and field names.
- Import defaults to draft unless `status=published` is explicitly allowed by admin permission.

### Security & Privacy

- Content must only include lawful, authorized, all-audience model, portrait, lifestyle, fashion, or art material.
- The platform must not publish underage, non-consensual, private, leaked, explicit, or copyright-infringing content.
- Protected R2 objects must not be publicly listable.
- Full video playback requires server-side membership validation and signed access.
- Admin routes require role-based authorization.
- Sensitive admin actions require audit logs.
- Login, registration, and admin forms use Turnstile and rate limiting.
- Public search endpoints must limit query complexity and request rate.

## 5. Risks & Roadmap

### Phased Rollout

MVP:

- Responsive public gallery pages.
- Login and membership status.
- Manual admin membership grants with expiration.
- Gallery, tag, and media management.
- Batch import from local zip package.
- Protected image and video access.
- Basic audit logs.

v1.1:

- Favorites and browsing history.
- SEO metadata management.
- Import validation preview before processing.
- Operational dashboard for views, plays, searches, and membership conversions.
- Better related-gallery recommendations.

v2.0:

- AI-assisted tagging and summaries.
- AI-assisted content risk review.
- Advanced analytics and A/B testing.
- Multi-language support if needed.

### Technical Risks

- Video storage and bandwidth costs can grow quickly; monitor Stream usage from the start.
- Large imports may exceed synchronous request limits; design import processing as asynchronous jobs.
- Tag taxonomy can become inconsistent; admin UI needs controlled tag types and merge tools.
- Media protection must be enforced at the API and storage layer, not only through hidden frontend UI.
- Compliance risk is high for people-focused media; authorization records and review workflows should be preserved.

### Open Questions

- Which login method should be used first: email/password or magic link?
- What exact membership levels should launch: free, vip, svip, or a custom set?
- Which site owner contact methods should be displayed: email, Telegram, WeChat, WhatsApp, or a custom contact page?
- Should image thumbnails be generated during import or lazily on first request?
- Should published imports be allowed, or should all imported content require manual review first?
