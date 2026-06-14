# SEO 配置说明

更新时间：2026-06-15

## 配置入口

后台路径：`/admin/settings` → `SEO / 社交分享`。

| 设置项 | 用途 | 前台输出 |
|--------|------|----------|
| 站点名称 | 导航、页脚、默认标题和结构化数据品牌名 | `<title>` 兜底、`WebSite` / `Organization` JSON-LD |
| 站点描述 | 首页和默认页面摘要 | `meta description`、OG 描述 |
| SEO 标题 | 首页和默认页面标题 | `<title>` |
| SEO 关键词池 | 全站基础关键词策略 | JSON-LD `keywords`，并兼容输出 `meta keywords` |
| OG 标题 / 描述 / 封面图 | 社交平台分享卡片 | Open Graph / Twitter Card |
| 站点图标 | 浏览器标签和移动端图标 | favicon / apple-touch-icon |

`seo_keywords` 保存在 D1 `site_settings` 表，后台保存时会归一化为英文逗号分隔字符串。公开接口 `/api/settings/public` 会再次安全清洗，前台通过 `useSiteSettings().seoKeywords` 读取。

## 关键词建议

关键词池建议控制在 8-16 个，最多 30 个；单个关键词最多 24 个字符。支持中文逗号、英文逗号、顿号、分号和换行分隔，保存时会去重并去掉开头的 `#`。

| 类别 | 目的 | 示例 |
|------|------|------|
| 核心词 | 表达站点定位 | 授权图库、写真、时尚写真、艺术图片 |
| 场景词 | 覆盖内容语境 | 户外写真、棚拍、生活方式、清新风格 |
| 地区词 | 支持地区发现 | 广东写真、广州写真、上海写真、城市旅拍 |
| 类型词 | 覆盖页面类型 | 图片合集、视频预览、真实案例、会员内容 |

推荐首版关键词：

```text
授权图库, 写真图库, 时尚写真, 生活写真, 艺术图片, 图片合集, 视频预览, 精选图库, 会员内容, 真实案例, 授权反馈, 城市旅拍, 户外写真, 棚拍写真, 清新风格, 时尚大片, 人像摄影, 内容授权, 图库平台
```

当前生产首版填充值由 migration `0031_seed_seo_keywords.sql` 写入；若后台已存在非空 `seo_keywords`，migration 不会覆盖站长后续手动维护的关键词池。

## 页面使用规则

- 首页：使用后台 SEO 关键词池，写入 `WebSite` JSON-LD `keywords` 和兼容用 `meta keywords`。
- 图库详情：`SEO 关键词池 + 图库标签` 合并去重，写入 `ImageGallery` JSON-LD 和页面级 `meta keywords`。
- 真实案例详情：`SEO 关键词池 + 真实案例 + 授权反馈` 合并去重，写入 `Article` JSON-LD 和页面级 `meta keywords`。
- 搜索排名重点仍是页面标题、描述、正文内容、图片 alt、站内链接、canonical、sitemap 和结构化数据；不要堆叠无关关键词。

## 搜索引擎注意事项

Google Search Central 明确说明 Google 网页搜索不使用 `meta keywords` 作为排名信号。本站保留 `meta keywords` 是为了配置透明、兼容其他读取方，并让后台关键词策略可被页面级结构化数据复用。

参考：

- [Google 不使用 keywords meta tag 做网页排名](https://developers.google.com/search/blog/2009/09/google-does-not-use-keywords-meta-tag)
- [Google 搜索摘要和 meta description 文档](https://developers.google.com/search/docs/appearance/snippet)
- [Google 结构化数据简介](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data)
- [Google robots.txt 简介](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
