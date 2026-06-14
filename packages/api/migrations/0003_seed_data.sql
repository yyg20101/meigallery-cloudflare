-- 种子数据：会员等级
INSERT OR IGNORE INTO membership_levels (id, code, name, rank, description)
VALUES
  ('lvl_free', 'free', '免费会员', 0, '基础浏览权限'),
  ('lvl_vip', 'vip', 'VIP 会员', 10, '可访问 VIP 内容'),
  ('lvl_svip', 'svip', 'SVIP 会员', 20, '可访问全部内容');

-- 种子数据：默认站点设置
INSERT OR IGNORE INTO site_settings (key, value)
VALUES
  ('site_name', '""'),
  ('site_description', '"精选写真、时尚、生活、艺术类图库平台"'),
  ('contact_email', '""'),
  ('registration_enabled', 'true'),
  ('items_per_page', '20');
