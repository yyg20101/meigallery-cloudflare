-- 清理旧脚手架品牌默认值，避免公开 SEO、邮件和后台设置继续暴露项目代号。
UPDATE site_settings
SET value = '""', updated_at = datetime('now')
WHERE key = 'site_name'
  AND value IN ('"MeiGallery"', 'MeiGallery');

UPDATE site_settings
SET value = '""', updated_at = datetime('now')
WHERE key = 'seo_title'
  AND value IN ('"MeiGallery - 精选写真图库"', 'MeiGallery - 精选写真图库');

UPDATE site_settings
SET value = '""', updated_at = datetime('now')
WHERE key = 'home_ad_sponsor'
  AND value = '"MeiGallery 运营推荐"';

UPDATE site_settings
SET value = '"了解本站的内容边界、会员访问和联系方式说明。"', updated_at = datetime('now')
WHERE key = 'rules_page_summary'
  AND value = '"了解 MeiGallery 的内容边界、会员访问和联系方式说明。"';

UPDATE site_settings
SET value = '"## 内容边界\n\n本站仅展示经过授权的写真、时尚、生活与艺术类素材，不发布露骨、侵权或侵犯隐私的内容。\n\n## 会员访问\n\n部分高清图片和完整内容需要会员权限。会员等级由站长手动授予，到期后自动失去对应访问权限。\n\n## 联系站长\n\n如需开通会员、咨询授权或反馈问题，请使用页面右下角联系方式。"', updated_at = datetime('now')
WHERE key = 'rules_page_content'
  AND value = '"## 内容边界\n\nMeiGallery 仅展示经过授权的写真、时尚、生活与艺术类素材，不发布露骨、侵权或侵犯隐私的内容。\n\n## 会员访问\n\n部分高清图片和完整内容需要会员权限。会员等级由站长手动授予，到期后自动失去对应访问权限。\n\n## 联系站长\n\n如需开通会员、咨询授权或反馈问题，请使用页面右下角联系方式。"';
