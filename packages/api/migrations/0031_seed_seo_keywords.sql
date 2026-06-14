-- 站点设置：按当前项目定位写入首版 SEO 关键词池。
INSERT INTO site_settings (key, value, updated_at)
VALUES (
  'seo_keywords',
  '"授权图库,写真图库,时尚写真,生活写真,艺术图片,图片合集,视频预览,精选图库,会员内容,真实案例,授权反馈,城市旅拍,户外写真,棚拍写真,清新风格,时尚大片,人像摄影,内容授权,图库平台"',
  datetime('now')
)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at
WHERE site_settings.value IS NULL
  OR trim(site_settings.value) IN ('', '""');
