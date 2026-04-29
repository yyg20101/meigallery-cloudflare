# MeiGallery Cloudflare 产品需求文档

## 1. Executive Summary

**Problem Statement**  
需要建设一个中文响应式图库平台，用于展示经过授权的写真、时尚、生活、艺术类图片和视频内容。平台需要支持标签化浏览、搜索、登录、会员等级解锁、后台发布和批量导入，同时保证媒体访问控制和内容合规。

**Proposed Solution**  
基于 Cloudflare Pages、Workers、D1、R2、Stream、Turnstile 建设前后台一体平台。前台提供桌面端和手机端浏览体验，后台提供图库管理、标签管理、批量导入、会员等级发放、有效期管理、资源权限控制和审计记录。

**Success Criteria**

- 首发版本桌面端和移动端核心页面 Lighthouse Performance >= 85。
- 在 100,000 条图库记录规模内，组合标签搜索 P95 响应时间 <= 500 ms；MVP 必须至少覆盖旧站 607 篇公开文章规模。
- 100 个图库目录的合法导入包，批量导入成功率 >= 98%。
- 图片原图、完整视频等受保护媒体的服务端权限校验覆盖率为 100%。
- 管理员完成“上传导入包 -> 校验 -> 草稿预览 -> 发布”的标准流程耗时 <= 3 分钟，不包含视频转码等待时间。
- 旧站导入后，100% 内容进入草稿或待审核状态，不允许未经审核直接发布。

## 2. User Experience & Functionality

### User Personas

- 访客：浏览公开图库、查看公开图片、观看试看视频、按标签筛选内容。
- 注册用户：登录后查看更多免费内容、查看会员状态、获取站长联系方式。
- 会员用户：按照会员等级和有效期解锁更多图片、高清视频或完整视频。
- 管理员：发布图库、批量导入资源、管理标签、发放会员等级、处理内容上下架。
- 站长：配置联系方式、制定会员等级、查看运营数据、把控合规和内容质量。

### Information Architecture

- 前台首页：推荐图库、最新图库、热门标签、视频专区、会员入口。
- 图库列表页：按地区、地区组、身份、性格、风格、职业、场景、内容类型等筛选。
- 标签结果页：展示单个标签或组合标签下的图库。
- 搜索页：支持关键词、标签、多条件组合。
- 图库详情页：标题、说明、标签、图片、视频、权限提示、相关推荐。
- 用户中心：账号信息、会员等级、有效期、站长联系方式。
- 管理后台：首页概览、图库管理、媒体管理、标签管理、会员管理、导入任务、系统设置、审计日志。

### Legacy Site Requirements

现有 `zuole.me` 为 WordPress 站点，公开 API 显示文章 607 篇、分类 54 个、标签 11 个。新系统需要支持从旧站迁移：

- 文章迁移为图库。
- WordPress 分类迁移为地区体系，至少包含国内、海外、港澳台、城市/国家。
- WordPress 标签迁移为结构化标签，至少支持身份、风格、场景、内容类型。
- WordPress 正文中的图片和视频迁移为媒体资源。
- 旧 URL 保留为 `legacy_url`，用于后台审计和 SEO 跳转。
- 敏感或不符合“面向所有人”定位的分类、标签、标题、正文必须进入待审核队列。

### User Stories

**Story 1: 浏览图库**
As a 访客, I want to 在桌面端和手机端浏览图库 so that 我可以快速发现公开内容。

Acceptance Criteria:

- 首页展示最新图库、推荐图库、热门标签和视频入口。
- 图库卡片展示封面、标题、主要标签、内容类型、是否需要会员。
- 移动端首屏不出现横向滚动，图片布局自适应。
- 公开内容无需登录即可查看。

**Story 2: 标签筛选与搜索**
As a 用户, I want to 按地区、性格、风格等标签组合筛选 so that 我可以找到符合偏好的内容。

Acceptance Criteria:

- 支持标签类型：地区范围、地区组、城市/国家、身份、性格、风格、职业、发型、服饰、场景、内容类型。
- 支持组合筛选，例如“广东 + 甜美 + 视频”。
- 搜索结果页展示当前筛选条件，并支持单独移除某个条件。
- 无结果时展示相近标签或热门标签。
- 标签 URL 可分享，例如 `/tags/region/guangdong` 或 `/search?tags=guangdong,sweet,video`。

**Story 3: 查看图库详情**
As a 用户, I want to 查看图库详情 so that 我可以阅读说明、浏览图片和观看视频。

Acceptance Criteria:

- 详情页展示标题、简介、正文、标签、发布时间、封面、图片列表、视频区域、相关推荐。
- 公开视频可试看，完整视频根据会员等级解锁。
- 未授权用户不能在 HTML、API 响应或播放器配置中拿到受保护资源的真实访问地址。
- 锁定内容展示所需等级和联系站长入口。
- 相关推荐基于共享标签生成。

**Story 4: 登录和会员状态**
As a 注册用户, I want to 登录并查看会员状态 so that 我知道自己能解锁哪些内容。

Acceptance Criteria:

- 登录和注册表单接入 Turnstile。
- 用户中心展示当前等级、开始时间、到期时间、权益说明和站长联系方式。
- 会员到期后自动失去对应权限。
- 用户不能自行修改会员等级和有效期。

**Story 5: 手动发放会员等级**
As a 管理员, I want to 给用户设置会员等级和有效期 so that 用户联系站长后可以获得对应权限。

Acceptance Criteria:

- 管理员可按邮箱、昵称、用户 ID 搜索用户。
- 管理员可设置等级、开始时间、结束时间、内部备注。
- 保存后立即生效。
- 每次变更写入审计日志，记录管理员、目标用户、变更前后值和时间。

**Story 6: 后台发布图库**
As a 管理员, I want to 创建、编辑、预览、发布图库 so that 只有审核后的内容出现在前台。

Acceptance Criteria:

- 管理员可编辑标题、摘要、正文、封面、图片、视频、标签、所需等级、发布状态。
- 支持草稿、已发布、已下架、归档状态。
- 发布前可预览前台详情页效果。
- 普通用户没有上传、编辑、发布入口。

**Story 7: 批量导入内容**
As a 管理员, I want to 上传包含文案、图片、视频的本地导入包 so that 我可以高效创建多个图库草稿。

Acceptance Criteria:

- 支持上传 zip 导入包。
- 系统校验目录结构、必填文件、CSV 字段、文件类型、重复 slug、资源大小。
- 合法图库默认导入为草稿。
- 单个图库失败不影响其他图库继续导入。
- 导入结果展示总数、成功数、失败数、错误报告下载入口。

**Story 8: 内容和系统设置**
As a 站长, I want to 配置联系方式、默认会员等级和站点基础信息 so that 运营信息可以独立维护。

Acceptance Criteria:

- 后台可配置站点名称、SEO 默认标题、联系方式、会员说明。
- 联系方式至少支持自由文本，可填写微信、Telegram、邮箱或自定义说明。
- 配置变更写入审计日志。

**Story 9: 旧站迁移**
As a 管理员, I want to 从 WordPress 旧站导入公开文章和媒体 so that 我可以把现有资源迁移到新系统并重新审核。

Acceptance Criteria:

- 支持输入旧站 REST API 地址或上传 WordPress 导出 XML。
- 导入任务记录旧 `post_id`、旧 URL、旧标题、旧分类、旧标签、旧媒体 URL。
- 正文 HTML 自动解析为图片、视频和文本说明。
- 旧站分类按映射表转为地区标签。
- 旧站标签按映射表转为身份、风格、场景等标签类型。
- 含敏感词、缺少媒体、媒体下载失败或授权状态未知的内容进入待审核。
- 导入内容默认草稿，不允许直接公开发布。

### Non-Goals

- MVP 不实现在线支付。
- MVP 不开放普通用户上传或投稿。
- MVP 不做评论、私信、关注、动态流。
- MVP 不做爬虫采集。
- MVP 不做多语言。
- MVP 不让 AI 自动发布内容。

## 3. AI System Requirements

MVP 不需要 AI。

后续可选 AI 能力：

- 自动建议标签：根据正文和媒体元数据推荐地区、风格、场景等标签。
- 自动摘要：根据管理员提供的正文生成短摘要。
- 内容风险辅助检查：提示疑似版权、隐私、未成年人、露骨内容等风险。
- 相似图库推荐：基于标签、行为和媒体特征推荐内容。

Evaluation Strategy:

- 自动标签 Precision@10 >= 85%，使用人工标注样本验证。
- 内容风险辅助检查必须由管理员复核，不允许自动发布或自动下架。
- AI 生成内容必须保留人工编辑入口和变更记录。

## 4. Technical Specifications

### Architecture Overview

- 前端：Cloudflare Pages，承载前台和后台管理界面。
- API：Cloudflare Workers 或 Pages Functions，提供认证、图库、搜索、导入、媒体授权、后台管理接口。
- 数据库：Cloudflare D1，存储用户、会员、图库、标签、媒体、导入任务、审计日志。
- 对象存储：Cloudflare R2，存储导入包、图片原图、缩略图、导入错误报告。
- 视频：Cloudflare Stream，负责视频上传、转码、播放和受限访问。
- 安全：Cloudflare Turnstile、WAF、Rate Limiting、签名访问、服务端权限校验。

### Integration Points

- Auth：邮箱密码或 magic link，管理员角色独立授权。
- D1：结构化数据、搜索过滤、会员有效期判断。
- R2：私有图片和导入文件存储。
- Stream：试看视频、完整视频、签名播放。
- Turnstile：登录、注册、后台登录、批量导入表单防护。
- GitHub：代码仓库关联 Cloudflare Pages，推送 main 自动生产部署，PR 自动预览部署。

### Data Model Summary

- `users`：账号、昵称、密码哈希、角色、状态。
- `membership_levels`：等级 code、名称、排序、说明。
- `user_memberships`：用户、等级、生效时间、到期时间、备注、创建管理员。
- `galleries`：标题、slug、摘要、正文、封面、状态、所需等级、发布时间。
- `media_assets`：图库、媒体类型、存储服务、R2 key、Stream UID、访问等级、排序。
- `tags`：标签类型、名称、slug。
- `gallery_tags`：图库标签关联。
- `import_jobs`：导入状态、源文件、总数、成功数、失败数、错误报告。
- `admin_audit_logs`：管理员操作审计。
- `site_settings`：站点配置、联系方式、SEO 默认值。
- `legacy_import_sources`：旧站来源、类型、API 地址、导入配置。
- `legacy_import_items`：旧 post ID、旧 URL、映射图库、导入状态、审核状态。

### Batch Import Specification

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
folder,title,slug,region,personality,style,tags,required_level,status
gallery-001,夏日写真,summer-portrait-001,广东,甜美,清新,"长发,户外,视频",vip,draft
gallery-002,城市街拍,city-snap-002,上海,高冷,都市,"短发,街拍",free,draft
```

`content.md`:

```md
# 夏日写真

这里是图库文字说明。

- 地区：广东
- 性格：甜美
- 风格：清新
```

Validation Rules:

- `manifest.csv`、`content.md`、`cover.jpg` 必填。
- 每个图库目录至少包含一张图片。
- 图片格式支持 jpg、jpeg、png、webp。
- 视频导入格式首期支持 mp4。
- `videos/preview.mp4` 可选，默认可公开视频。
- `videos/full.mp4` 可选，默认按图库等级或资源等级保护。
- 未存在标签可自动创建，但标签类型必须合法。
- `status=published` 需要管理员具备直接发布权限；否则强制导入为草稿。

### WordPress Migration Specification

旧站迁移支持两种来源：

- WordPress REST API：`/wp-json/wp/v2/posts`、`categories`、`tags`、`media`。
- WordPress XML export：用于 REST API 不完整或需要离线迁移时。

迁移字段映射：

- `post.id` -> `legacy_import_items.legacy_post_id`
- `post.link` -> `galleries.legacy_url`
- `post.slug` -> `galleries.legacy_slug`
- `post.title.rendered` -> `galleries.title`
- `post.excerpt.rendered` -> `galleries.summary`
- `post.content.rendered` -> `galleries.body_md` 和 `media_assets`
- `post.categories` -> 地区标签映射
- `post.tags` -> 普通标签映射

迁移处理规则：

- WordPress HTML 中的 `<img>` 解析为图片资源。
- WordPress HTML 中的 `<video>` 解析为视频资源。
- 远程图片迁移到 R2。
- 远程视频迁移到 Stream。
- 旧站公开 URL 生成 SEO redirect 记录。
- 旧站敏感分类名不直接作为新站前台标签展示，必须通过映射表重命名。

### Security & Privacy

- 内容必须为合法、授权、全龄可展示的写真、时尚、生活、艺术类素材。
- 禁止发布未成年人、非自愿、偷拍、泄露隐私、露骨色情、侵权内容。
- 旧站导入内容必须经过合规审核；含敏感交易、暗示性服务、年龄风险或授权不明的文案不得直接发布。
- R2 私有资源不得公开列目录。
- 受保护图片和完整视频必须经服务端校验后签发短期访问地址。
- 后台接口必须做角色校验和审计记录。
- 登录、注册、后台敏感操作必须有 Turnstile 和速率限制。

## 5. Risks & Roadmap

### Phased Rollout

MVP:

- 响应式前台：首页、列表、搜索、详情、用户中心。
- 登录、注册、会员状态。
- 管理员手动发放会员等级和有效期。
- 后台图库、标签、媒体、站点设置管理。
- zip 批量导入。
- WordPress 旧站导入和迁移预览。
- 受保护图片和视频访问控制。
- 基础审计日志。

v1.1:

- 收藏、浏览历史。
- SEO 元信息管理。
- 导入前预览和二次确认。
- 运营看板：浏览量、播放量、搜索词、会员转化线索。
- 标签合并和标签别名。

v2.0:

- AI 辅助标签和摘要。
- AI 辅助内容风险检查。
- 高级推荐。
- 多语言。

### Technical Risks

- 视频存储和播放成本可能快速增长，需要从 MVP 起记录 Stream 用量。
- 大导入包可能超过同步请求能力，应设计为异步导入任务。
- 标签体系容易失控，需要后台限制标签类型并提供合并工具。
- 媒体防盗链不能只靠前端隐藏，必须由 API 和存储层共同控制。
- 人像类内容存在合规风险，需要保存授权来源和审核记录。

### Open Questions

- 首期登录方式选邮箱密码还是 magic link？
- 初始会员等级是否采用 free、vip、svip？
- 站长联系方式展示微信、Telegram、邮箱，还是自定义富文本？
- 缩略图在导入时生成，还是首次访问时生成？
- 导入包是否允许直接发布，还是全部强制进入草稿审核？
