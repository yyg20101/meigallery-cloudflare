# MeiGallery Cloudflare 开发指南

## 语言规范

本项目所有交互和产出统一使用**中文**，包括但不限于：

- AI 问答和对话
- 文档书写（PRD、技术设计、部署说明等）
- UI 设计稿和交互描述
- 代码注释和 commit message
- 前台界面文案和后台界面文案

仅以下内容保留英文：Cloudflare 产品名、代码标识符（变量名、组件名、API 路径）、通用技术缩写（API、URL、SEO 等）。

## 项目目标

MeiGallery Cloudflare 是一个中文响应式图库平台，展示经过授权的写真、时尚、生活、艺术类图片和视频内容。产品支持公开浏览、标签搜索、登录、手动会员等级发放、受保护媒体访问和后台管理控制台（含批量导入）。

项目以 Cloudflare 为唯一运行时和基础设施平台。

## 产品边界

- 内容定位：面向所有受众，仅限合法的写真、时尚、生活、艺术类素材，不允许露骨内容。
- 仅管理员可发布内容，不开放用户上传。
- 首期不接入在线支付，用户联系站长后由管理员手动授予会员等级和有效期。
- 不做爬虫或第三方自动采集，所有媒体必须有明确授权和版权来源。
- 不实现任何绕过年龄、知情同意、版权或隐私要求的功能。

## Cloudflare 架构

默认使用 Cloudflare 产品实现：

- 前端：Cloudflare Pages。
- API：Cloudflare Workers 或 Pages Functions。
- 数据库：Cloudflare D1。
- 图片和导入包存储：Cloudflare R2。
- 视频上传、编码、播放和访问控制：Cloudflare Stream。
- 人机验证：Cloudflare Turnstile。
- 安全控制：Cloudflare WAF、速率限制、签名 URL 和服务端权限校验。

添加 Cloudflare 配置时，务必核对当前官方文档，不要依赖过时的数字限制、价格或 API 细节。

## 核心领域概念

- 图库（Gallery）：已发布或草稿状态的内容单元，包含标题、描述、封面、标签、图片、视频和所需会员等级。
- 标签（Tag）：按类型分组的可搜索分类值，类型包括地区范围、地区组、城市/国家、身份、性格、风格、职业、发型、服饰、场景、内容类型。
- 会员等级（Membership Level）：手动管理的访问层级，可设置有效期。
- 受保护媒体（Protected Media）：需要登录或特定会员等级才能访问的图片或视频。
- 导入任务（Import Job）：批量上传工作流，解析本地包、校验文件、创建草稿图库、上传媒体并报告失败。

## 访问控制规则

- 受保护媒体绝不信任前端检查，必须由服务端验证会员资格。
- 私有 R2 对象和 Stream 播放必须经过服务端会员等级校验后发放短期访问凭证。
- 会员到期后必须自动失去对应权限。
- 后台路由必须要求已认证的管理员角色。
- 所有后台修改操作必须写入审计日志。
- 会员等级比较使用数字 `rank`，不硬编码等级名称（free=0、vip=10、svip=20）。

## 批量导入标准

默认导入格式为 zip 包：

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

`manifest.csv` 字段：

```csv
folder,title,slug,region,personality,style,tags,required_level,status
gallery-001,夏日写真,summer-portrait-001,广东,甜美,清新,"长发,户外,视频",vip,draft
```

校验规则：

- `manifest.csv`、`content.md`、`cover.jpg` 为必填。
- 每个图库目录至少包含一张图片。
- `videos/preview.mp4` 和 `videos/full.mp4` 可选。
- 未知标签在校验通过后自动创建。
- 导入图库默认为草稿，除非 Owner 角色显式设置 `status=published`。
- 单个图库失败不得阻塞包内其他图库的导入。

## 工程准则

- 优先使用小型、有类型、可测试的模块。
- 管理员 API 和公开 API 权限严格分离。
- 数据库变更使用 migration 管理。
- 业务逻辑中避免硬编码会员名称，使用等级 rank 或配置化权限判断。
- 原始媒体存储在私有 bucket 或受保护服务中，公开变体通过显式 URL 分发。
- 为权限校验、导入解析、会员到期和搜索过滤编写重点测试。

## 文档索引

- 产品需求：`docs/PRD.md`
- 技术设计：`docs/TECHNICAL_SPEC.md`
- UI 设计：`docs/UI_DESIGN.md`
- 部署说明：`docs/DEPLOYMENT.md`
- 旧站审计：`docs/SOURCE_SITE_AUDIT.md`
