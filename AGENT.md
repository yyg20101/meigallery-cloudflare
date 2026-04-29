# MeiGallery Cloudflare Agent Guide

## Project Purpose

MeiGallery Cloudflare is a Chinese responsive gallery platform for curated model, portrait, fashion, lifestyle, and video content. The product supports public browsing, tag search, login, manual membership level assignment, protected media access, and an admin console for publishing and batch imports.

The project targets Cloudflare as the primary runtime and infrastructure platform.

## Product Boundaries

- The site is for all audiences. Keep content within lawful portrait, fashion, lifestyle, art, and non-explicit presentation.
- Only administrators can publish content. Public user uploads are out of scope.
- No online payment is required in the initial version. Users contact the site owner, and administrators manually grant membership levels and validity periods.
- Do not build scraping or automated third-party content collection. All media must have a clear authorization and copyright source.
- Do not implement features that bypass age, consent, copyright, or privacy requirements.

## Cloudflare Architecture

Use Cloudflare products as the default implementation path:

- Frontend: Cloudflare Pages.
- API: Cloudflare Workers or Pages Functions.
- Database: Cloudflare D1.
- Image and import package storage: Cloudflare R2.
- Video upload, encoding, playback, and access control: Cloudflare Stream.
- Bot protection: Cloudflare Turnstile.
- Security controls: Cloudflare WAF, rate limiting, signed URLs, and server-side permission checks.

When adding Cloudflare configuration, verify current product docs before relying on numeric limits, pricing, or API details.

## Core Domain Concepts

- Gallery: A published or draft content unit with title, description, cover image, tags, images, videos, and required membership level.
- Tag: A searchable category value, grouped by type such as region, personality, style, occupation, hair, clothing, scene, and media type.
- Membership Level: A manually managed access tier with an optional validity period.
- Protected Media: Any image or video that requires login or a membership level.
- Import Job: A batch upload workflow that parses a local package, validates its files, creates draft galleries, uploads media, and reports failures.

## Access Control Rules

- Never trust frontend checks for protected media.
- Gate private R2 objects and Stream playback behind server-side membership validation.
- Membership expiration must automatically remove privileged access.
- Admin routes must require authenticated administrator roles.
- All admin mutations must write audit logs.

## Batch Import Standard

The default import format is a zip package:

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

`manifest.csv` fields:

```csv
folder,title,region,personality,style,tags,required_level,status
gallery-001,夏日写真,广东,甜美,清新,"长发,户外,视频",vip,draft
```

Validation rules:

- `manifest.csv`, `content.md`, and `cover.jpg` are required.
- Each gallery must include at least one image.
- `videos/preview.mp4` and `videos/full.mp4` are optional.
- Unknown tags should be created automatically after validation.
- Imported galleries should default to draft unless explicitly published.
- One failed gallery must not block the rest of the package from importing.

## Engineering Guidelines

- Prefer small, typed, testable modules.
- Keep admin and public API permissions separate.
- Use database migrations for schema changes.
- Avoid hard-coded membership names in business logic; use level rank or configured permissions.
- Store raw media in private buckets or protected services; serve public variants through explicit URLs.
- Add focused tests for permission checks, import parsing, membership expiration, and search filters.

## Documentation

- Product requirements live in `docs/PRD.md`.
- Future implementation plans, schema drafts, API specs, and deployment notes should be added under `docs/`.
