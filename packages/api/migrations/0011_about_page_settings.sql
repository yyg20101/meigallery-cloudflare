-- 关于我们页面配置（Markdown 富文本）
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('about_title', '"关于我们"', datetime('now')),
  ('about_summary', '"MeiGallery 专注精选女性写真、时尚、生活与艺术类视觉内容。"', datetime('now')),
  ('about_content', '"## 关于 MeiGallery\n\nMeiGallery 是一个精选女性写真、时尚、生活与艺术类视觉内容的平台。我们坚持合法授权、内容审核和会员访问控制，致力于提供清爽、高级、可持续的图库浏览体验。\n\n### 内容原则\n\n- 仅展示经过授权或具备明确版权来源的内容\n- 不开放用户上传，仅由管理员发布内容\n- 不发布露骨、侵权或侵犯隐私的素材\n\n### 会员访问\n\n部分高清图片和完整内容需要会员权限。你可以通过页面右下角的联系方式联系站长开通或咨询。"', datetime('now'));
