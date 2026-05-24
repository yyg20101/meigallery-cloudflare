-- 本地开发测试种子数据
-- 用法: pnpm exec wrangler d1 execute meigallery-db --local --file=scripts/seed-test-data.sql

-- ===== 标签 =====
INSERT OR IGNORE INTO tags (id, type, name, slug) VALUES
  -- 地区范围
  ('tag_region_cn', 'region_scope', '国内', 'domestic'),
  ('tag_region_oversea', 'region_scope', '海外', 'overseas'),
  -- 地区组
  ('tag_rg_south', 'region_group', '华南', 'south-china'),
  ('tag_rg_east', 'region_group', '华东', 'east-china'),
  ('tag_rg_north', 'region_group', '华北', 'north-china'),
  ('tag_rg_sw', 'region_group', '西南', 'southwest-china'),
  ('tag_rg_sea', 'region_group', '东南亚', 'southeast-asia'),
  -- 城市/国家
  ('tag_city_gz', 'city_country', '广州', 'guangzhou'),
  ('tag_city_sz', 'city_country', '深圳', 'shenzhen'),
  ('tag_city_sh', 'city_country', '上海', 'shanghai'),
  ('tag_city_bj', 'city_country', '北京', 'beijing'),
  ('tag_city_cd', 'city_country', '成都', 'chengdu'),
  ('tag_city_hz', 'city_country', '杭州', 'hangzhou'),
  ('tag_city_xm', 'city_country', '厦门', 'xiamen'),
  ('tag_city_bkk', 'city_country', '曼谷', 'bangkok'),
  -- 性格
  ('tag_p_sweet', 'personality', '甜美', 'sweet'),
  ('tag_p_cool', 'personality', '高冷', 'cool'),
  ('tag_p_lively', 'personality', '活泼', 'lively'),
  ('tag_p_gentle', 'personality', '温柔', 'gentle'),
  ('tag_p_sexy', 'personality', '性感', 'sexy'),
  -- 风格
  ('tag_s_fresh', 'style', '清新', 'fresh'),
  ('tag_s_retro', 'style', '复古', 'retro'),
  ('tag_s_urban', 'style', '都市', 'urban'),
  ('tag_s_artistic', 'style', '文艺', 'artistic'),
  ('tag_s_fashion', 'style', '时尚', 'fashion'),
  -- 场景
  ('tag_sc_outdoor', 'scene', '户外', 'outdoor'),
  ('tag_sc_indoor', 'scene', '室内', 'indoor'),
  ('tag_sc_street', 'scene', '街拍', 'street'),
  ('tag_sc_studio', 'scene', '棚拍', 'studio'),
  ('tag_sc_cafe', 'scene', '咖啡馆', 'cafe'),
  ('tag_sc_beach', 'scene', '海滩', 'beach'),
  -- 服饰
  ('tag_cl_dress', 'clothing', '连衣裙', 'dress'),
  ('tag_cl_jk', 'clothing', 'JK制服', 'jk-uniform'),
  ('tag_cl_hanfu', 'clothing', '汉服', 'hanfu'),
  ('tag_cl_casual', 'clothing', '休闲装', 'casual'),
  ('tag_cl_swimsuit', 'clothing', '泳装', 'swimsuit'),
  -- 发型
  ('tag_h_long', 'hair', '长发', 'long-hair'),
  ('tag_h_short', 'hair', '短发', 'short-hair'),
  ('tag_h_ponytail', 'hair', '马尾', 'ponytail'),
  -- 内容类型
  ('tag_ct_photo', 'content_type', '写真', 'portrait'),
  ('tag_ct_fashion', 'content_type', '时尚', 'fashion-photo'),
  ('tag_ct_lifestyle', 'content_type', '生活', 'lifestyle'),
  ('tag_ct_video', 'content_type', '视频', 'video');

-- ===== 图库（使用 picsum.photos 外部图片作为封面） =====
INSERT OR IGNORE INTO galleries (id, title, slug, summary, body_md, cover_key, status, required_level_rank, published_at, created_at, updated_at)
VALUES
  ('gal_001', '夏日清新写真 · 广州', 'summer-fresh-guangzhou',
   '广州夏日午后的清新人像写真，阳光透过树叶洒下斑驳光影。',
   '# 夏日清新写真\n\n广州夏日午后，阳光明媚。在老城区的林荫道上，光影交错，留下这组清新人像。',
   'https://picsum.photos/seed/mg001/800/1200', 'published', 0,
   '2026-04-28T10:00:00Z', '2026-04-28T09:00:00Z', '2026-04-28T10:00:00Z'),

  ('gal_002', '深圳都市风格街拍', 'shenzhen-urban-street',
   '深圳CBD街头的都市风格人像，现代建筑与时尚碰撞。',
   '# 深圳都市街拍\n\n在深圳南山CBD的街头，高楼林立间的都市风格人像。',
   'https://picsum.photos/seed/mg002/800/1200', 'published', 0,
   '2026-04-27T14:00:00Z', '2026-04-27T13:00:00Z', '2026-04-27T14:00:00Z'),

  ('gal_003', '上海法租界复古胶片', 'shanghai-retro-film',
   '上海法租界的复古胶片风格写真，梧桐树下的旧时光。',
   '# 上海法租界复古胶片\n\n穿过梧桐树荫的光线，胶片质感记录下的旧上海风情。',
   'https://picsum.photos/seed/mg003/800/1200', 'published', 0,
   '2026-04-26T16:00:00Z', '2026-04-26T15:00:00Z', '2026-04-26T16:00:00Z'),

  ('gal_004', '成都文艺咖啡馆', 'chengdu-cafe-artistic',
   '成都太古里旁的文艺咖啡馆，温暖的午后时光。',
   '# 成都文艺咖啡馆\n\n在太古里旁边的独立咖啡馆，暖色调的午后。',
   'https://picsum.photos/seed/mg004/800/1200', 'published', 0,
   '2026-04-25T11:00:00Z', '2026-04-25T10:00:00Z', '2026-04-25T11:00:00Z'),

  ('gal_005', '杭州西湖汉服写真', 'hangzhou-westlake-hanfu',
   '西湖边的汉服写真，古典与自然的完美融合。',
   '# 杭州西湖汉服\n\n在西湖苏堤边，穿上汉服，感受古典之美。',
   'https://picsum.photos/seed/mg005/800/1200', 'published', 10,
   '2026-04-24T09:00:00Z', '2026-04-24T08:00:00Z', '2026-04-24T09:00:00Z'),

  ('gal_006', '厦门海滩日落', 'xiamen-beach-sunset',
   '厦门环岛路海滩的日落时分，海风与余晖。',
   '# 厦门海滩日落\n\n傍晚时分的环岛路海滩，金色的阳光洒在海面上。',
   'https://picsum.photos/seed/mg006/800/1200', 'published', 10,
   '2026-04-23T17:00:00Z', '2026-04-23T16:00:00Z', '2026-04-23T17:00:00Z'),

  ('gal_007', '北京胡同日常', 'beijing-hutong-daily',
   '老北京胡同里的日常生活写真，青砖灰瓦间的故事。',
   '# 北京胡同日常\n\n走进南锣鼓巷的胡同深处，记录这里的烟火气。',
   'https://picsum.photos/seed/mg007/800/1200', 'published', 0,
   '2026-04-22T13:00:00Z', '2026-04-22T12:00:00Z', '2026-04-22T13:00:00Z'),

  ('gal_008', '曼谷街头时尚', 'bangkok-street-fashion',
   '曼谷暹罗广场附近的街头时尚拍摄，热带风情。',
   '# 曼谷街头时尚\n\n在曼谷的暹罗广场和考山路，感受东南亚的时尚活力。',
   'https://picsum.photos/seed/mg008/800/1200', 'published', 0,
   '2026-04-21T15:00:00Z', '2026-04-21T14:00:00Z', '2026-04-21T15:00:00Z'),

  ('gal_009', '广州JK制服日系', 'guangzhou-jk-japanese',
   '广州天河公园的JK制服日系写真，青春活力。',
   '# JK制服日系写真\n\n春天的天河公园，JK制服与樱花。',
   'https://picsum.photos/seed/mg009/800/1200', 'published', 10,
   '2026-04-20T10:00:00Z', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z'),

  ('gal_010', '深圳棚拍高级时装', 'shenzhen-studio-highfashion',
   '深圳专业影棚的高级时装拍摄，精致光影。',
   '# 深圳棚拍高级时装\n\n在深圳湾的专业影棚，一组高级时装大片。',
   'https://picsum.photos/seed/mg010/800/1200', 'published', 20,
   '2026-04-19T14:00:00Z', '2026-04-19T13:00:00Z', '2026-04-19T14:00:00Z'),

  ('gal_011', '上海外滩夜景人像', 'shanghai-bund-night',
   '上海外滩的夜景人像，霓虹灯下的都市魅力。',
   '# 上海外滩夜景\n\n华灯初上的外滩，黄浦江畔的夜色人像。',
   'https://picsum.photos/seed/mg011/800/1200', 'published', 0,
   '2026-04-18T20:00:00Z', '2026-04-18T19:00:00Z', '2026-04-18T20:00:00Z'),

  ('gal_012', '成都春日户外', 'chengdu-spring-outdoor',
   '成都春天的户外人像，油菜花田间的少女。',
   '# 成都春日户外\n\n三月的成都郊外，金灿灿的油菜花田。',
   'https://picsum.photos/seed/mg012/800/1200', 'published', 0,
   '2026-04-17T11:00:00Z', '2026-04-17T10:00:00Z', '2026-04-17T11:00:00Z'),

  ('gal_013', '杭州西溪湿地写真', 'hangzhou-xixi-wetland',
   '杭州西溪湿地的自然风光人像，水乡韵味。',
   '# 西溪湿地写真\n\n在西溪湿地的小桥流水间，一组自然风人像。',
   'https://picsum.photos/seed/mg013/800/1200', 'published', 10,
   '2026-04-16T09:00:00Z', '2026-04-16T08:00:00Z', '2026-04-16T09:00:00Z'),

  ('gal_014', '厦门鼓浪屿文艺', 'xiamen-gulangyu-artistic',
   '鼓浪屿的文艺风格写真，百年洋楼与小巷。',
   '# 鼓浪屿文艺写真\n\n漫步鼓浪屿，在百年洋楼和幽静小巷间取景。',
   'https://picsum.photos/seed/mg014/800/1200', 'published', 0,
   '2026-04-15T14:00:00Z', '2026-04-15T13:00:00Z', '2026-04-15T14:00:00Z'),

  ('gal_015', '深圳泳装海边大片', 'shenzhen-swimsuit-beach',
   '深圳大梅沙海滩的泳装写真，阳光沙滩海浪。',
   '# 大梅沙泳装大片\n\n盛夏的大梅沙，阳光、沙滩与碧海蓝天。',
   'https://picsum.photos/seed/mg015/800/1200', 'published', 20,
   '2026-04-14T16:00:00Z', '2026-04-14T15:00:00Z', '2026-04-14T16:00:00Z'),

  ('gal_016', '北京798艺术区', 'beijing-798-art',
   '北京798艺术区的创意人像，艺术与时尚交汇。',
   '# 798艺术区创意人像\n\n在798的涂鸦墙和装置艺术间，一组创意人像。',
   'https://picsum.photos/seed/mg016/800/1200', 'published', 0,
   '2026-04-13T10:00:00Z', '2026-04-13T09:00:00Z', '2026-04-13T10:00:00Z');

-- ===== 图库-标签关联 =====
INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES
  -- gal_001: 夏日清新广州
  ('gal_001', 'tag_region_cn'), ('gal_001', 'tag_rg_south'), ('gal_001', 'tag_city_gz'),
  ('gal_001', 'tag_p_sweet'), ('gal_001', 'tag_s_fresh'), ('gal_001', 'tag_sc_outdoor'),
  ('gal_001', 'tag_cl_dress'), ('gal_001', 'tag_h_long'), ('gal_001', 'tag_ct_photo'),
  -- gal_002: 深圳都市街拍
  ('gal_002', 'tag_region_cn'), ('gal_002', 'tag_rg_south'), ('gal_002', 'tag_city_sz'),
  ('gal_002', 'tag_p_cool'), ('gal_002', 'tag_s_urban'), ('gal_002', 'tag_sc_street'),
  ('gal_002', 'tag_cl_casual'), ('gal_002', 'tag_ct_photo'),
  -- gal_003: 上海复古胶片
  ('gal_003', 'tag_region_cn'), ('gal_003', 'tag_rg_east'), ('gal_003', 'tag_city_sh'),
  ('gal_003', 'tag_p_gentle'), ('gal_003', 'tag_s_retro'), ('gal_003', 'tag_sc_street'),
  ('gal_003', 'tag_cl_dress'), ('gal_003', 'tag_h_long'), ('gal_003', 'tag_ct_photo'),
  -- gal_004: 成都文艺咖啡馆
  ('gal_004', 'tag_region_cn'), ('gal_004', 'tag_rg_sw'), ('gal_004', 'tag_city_cd'),
  ('gal_004', 'tag_p_gentle'), ('gal_004', 'tag_s_artistic'), ('gal_004', 'tag_sc_cafe'),
  ('gal_004', 'tag_cl_casual'), ('gal_004', 'tag_ct_lifestyle'),
  -- gal_005: 杭州汉服
  ('gal_005', 'tag_region_cn'), ('gal_005', 'tag_rg_east'), ('gal_005', 'tag_city_hz'),
  ('gal_005', 'tag_p_gentle'), ('gal_005', 'tag_s_retro'), ('gal_005', 'tag_sc_outdoor'),
  ('gal_005', 'tag_cl_hanfu'), ('gal_005', 'tag_h_long'), ('gal_005', 'tag_ct_photo'),
  -- gal_006: 厦门海滩
  ('gal_006', 'tag_region_cn'), ('gal_006', 'tag_rg_east'), ('gal_006', 'tag_city_xm'),
  ('gal_006', 'tag_p_sexy'), ('gal_006', 'tag_s_fresh'), ('gal_006', 'tag_sc_beach'),
  ('gal_006', 'tag_cl_swimsuit'), ('gal_006', 'tag_h_ponytail'), ('gal_006', 'tag_ct_photo'),
  -- gal_007: 北京胡同
  ('gal_007', 'tag_region_cn'), ('gal_007', 'tag_rg_north'), ('gal_007', 'tag_city_bj'),
  ('gal_007', 'tag_p_lively'), ('gal_007', 'tag_s_artistic'), ('gal_007', 'tag_sc_street'),
  ('gal_007', 'tag_cl_casual'), ('gal_007', 'tag_h_short'), ('gal_007', 'tag_ct_lifestyle'),
  -- gal_008: 曼谷街头
  ('gal_008', 'tag_region_oversea'), ('gal_008', 'tag_rg_sea'), ('gal_008', 'tag_city_bkk'),
  ('gal_008', 'tag_p_lively'), ('gal_008', 'tag_s_fashion'), ('gal_008', 'tag_sc_street'),
  ('gal_008', 'tag_cl_casual'),   ('gal_008', 'tag_ct_fashion'),
  -- gal_009: 广州JK制服
  ('gal_009', 'tag_region_cn'), ('gal_009', 'tag_rg_south'), ('gal_009', 'tag_city_gz'),
  ('gal_009', 'tag_p_sweet'), ('gal_009', 'tag_p_lively'), ('gal_009', 'tag_sc_outdoor'),
  ('gal_009', 'tag_cl_jk'), ('gal_009', 'tag_h_ponytail'), ('gal_009', 'tag_ct_photo'),
  -- gal_010: 深圳棚拍时装
  ('gal_010', 'tag_region_cn'), ('gal_010', 'tag_rg_south'), ('gal_010', 'tag_city_sz'),
  ('gal_010', 'tag_p_cool'), ('gal_010', 'tag_s_fashion'), ('gal_010', 'tag_sc_studio'),
  ('gal_010', 'tag_cl_dress'), ('gal_010', 'tag_h_long'), ('gal_010', 'tag_ct_fashion'),
  -- gal_011: 上海外滩夜景
  ('gal_011', 'tag_region_cn'), ('gal_011', 'tag_rg_east'), ('gal_011', 'tag_city_sh'),
  ('gal_011', 'tag_p_sexy'), ('gal_011', 'tag_s_urban'), ('gal_011', 'tag_sc_street'),
  ('gal_011', 'tag_cl_dress'), ('gal_011', 'tag_h_long'), ('gal_011', 'tag_ct_photo'),
  -- gal_012: 成都春日户外
  ('gal_012', 'tag_region_cn'), ('gal_012', 'tag_rg_sw'), ('gal_012', 'tag_city_cd'),
  ('gal_012', 'tag_p_sweet'), ('gal_012', 'tag_s_fresh'), ('gal_012', 'tag_sc_outdoor'),
  ('gal_012', 'tag_cl_casual'), ('gal_012', 'tag_h_ponytail'), ('gal_012', 'tag_ct_photo'),
  -- gal_013: 杭州西溪湿地
  ('gal_013', 'tag_region_cn'), ('gal_013', 'tag_rg_east'), ('gal_013', 'tag_city_hz'),
  ('gal_013', 'tag_p_gentle'), ('gal_013', 'tag_s_artistic'), ('gal_013', 'tag_sc_outdoor'),
  ('gal_013', 'tag_cl_dress'), ('gal_013', 'tag_h_long'), ('gal_013', 'tag_ct_photo'),
  -- gal_014: 厦门鼓浪屿
  ('gal_014', 'tag_region_cn'), ('gal_014', 'tag_rg_east'), ('gal_014', 'tag_city_xm'),
  ('gal_014', 'tag_p_gentle'), ('gal_014', 'tag_s_artistic'), ('gal_014', 'tag_sc_street'),
  ('gal_014', 'tag_cl_dress'), ('gal_014', 'tag_ct_lifestyle'),
  -- gal_015: 深圳泳装
  ('gal_015', 'tag_region_cn'), ('gal_015', 'tag_rg_south'), ('gal_015', 'tag_city_sz'),
  ('gal_015', 'tag_p_sexy'), ('gal_015', 'tag_s_fresh'), ('gal_015', 'tag_sc_beach'),
  ('gal_015', 'tag_cl_swimsuit'), ('gal_015', 'tag_h_long'), ('gal_015', 'tag_ct_photo'),
  -- gal_016: 北京798
  ('gal_016', 'tag_region_cn'), ('gal_016', 'tag_rg_north'), ('gal_016', 'tag_city_bj'),
  ('gal_016', 'tag_p_cool'), ('gal_016', 'tag_s_fashion'), ('gal_016', 'tag_sc_indoor'),
  ('gal_016', 'tag_cl_casual'), ('gal_016', 'tag_h_short'), ('gal_016', 'tag_ct_fashion');

-- ===== 媒体资源（模拟数据，使用外部图片 URL） =====
-- 每个图库添加 3-6 张图片
INSERT OR IGNORE INTO media_assets (id, gallery_id, type, storage, r2_key, role, sort_order, required_rank, upload_status, created_at)
VALUES
  -- gal_001
  ('ma_001_01', 'gal_001', 'image', 'r2', 'https://picsum.photos/seed/mg001a/600/900', 'content', 1, 0, 'completed', '2026-04-28T09:00:00Z'),
  ('ma_001_02', 'gal_001', 'image', 'r2', 'https://picsum.photos/seed/mg001b/600/900', 'content', 2, 0, 'completed', '2026-04-28T09:00:00Z'),
  ('ma_001_03', 'gal_001', 'image', 'r2', 'https://picsum.photos/seed/mg001c/600/900', 'content', 3, 0, 'completed', '2026-04-28T09:00:00Z'),
  ('ma_001_04', 'gal_001', 'image', 'r2', 'https://picsum.photos/seed/mg001d/600/900', 'content', 4, 10, 'completed', '2026-04-28T09:00:00Z'),
  ('ma_001_05', 'gal_001', 'image', 'r2', 'https://picsum.photos/seed/mg001e/600/900', 'content', 5, 10, 'completed', '2026-04-28T09:00:00Z'),
  -- gal_002
  ('ma_002_01', 'gal_002', 'image', 'r2', 'https://picsum.photos/seed/mg002a/600/900', 'content', 1, 0, 'completed', '2026-04-27T13:00:00Z'),
  ('ma_002_02', 'gal_002', 'image', 'r2', 'https://picsum.photos/seed/mg002b/600/900', 'content', 2, 0, 'completed', '2026-04-27T13:00:00Z'),
  ('ma_002_03', 'gal_002', 'image', 'r2', 'https://picsum.photos/seed/mg002c/600/900', 'content', 3, 0, 'completed', '2026-04-27T13:00:00Z'),
  ('ma_002_04', 'gal_002', 'image', 'r2', 'https://picsum.photos/seed/mg002d/600/900', 'content', 4, 0, 'completed', '2026-04-27T13:00:00Z'),
  -- gal_003
  ('ma_003_01', 'gal_003', 'image', 'r2', 'https://picsum.photos/seed/mg003a/600/900', 'content', 1, 0, 'completed', '2026-04-26T15:00:00Z'),
  ('ma_003_02', 'gal_003', 'image', 'r2', 'https://picsum.photos/seed/mg003b/600/900', 'content', 2, 0, 'completed', '2026-04-26T15:00:00Z'),
  ('ma_003_03', 'gal_003', 'image', 'r2', 'https://picsum.photos/seed/mg003c/600/900', 'content', 3, 0, 'completed', '2026-04-26T15:00:00Z'),
  -- gal_005 VIP
  ('ma_005_01', 'gal_005', 'image', 'r2', 'https://picsum.photos/seed/mg005a/600/900', 'content', 1, 0, 'completed', '2026-04-24T08:00:00Z'),
  ('ma_005_02', 'gal_005', 'image', 'r2', 'https://picsum.photos/seed/mg005b/600/900', 'content', 2, 0, 'completed', '2026-04-24T08:00:00Z'),
  ('ma_005_03', 'gal_005', 'image', 'r2', 'https://picsum.photos/seed/mg005c/600/900', 'content', 3, 10, 'completed', '2026-04-24T08:00:00Z'),
  ('ma_005_04', 'gal_005', 'image', 'r2', 'https://picsum.photos/seed/mg005d/600/900', 'content', 4, 10, 'completed', '2026-04-24T08:00:00Z'),
  ('ma_005_05', 'gal_005', 'image', 'r2', 'https://picsum.photos/seed/mg005e/600/900', 'content', 5, 10, 'completed', '2026-04-24T08:00:00Z'),
  -- gal_010 SVIP
  ('ma_010_01', 'gal_010', 'image', 'r2', 'https://picsum.photos/seed/mg010a/600/900', 'content', 1, 0, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_010_02', 'gal_010', 'image', 'r2', 'https://picsum.photos/seed/mg010b/600/900', 'content', 2, 0, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_010_03', 'gal_010', 'image', 'r2', 'https://picsum.photos/seed/mg010c/600/900', 'content', 3, 20, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_010_04', 'gal_010', 'image', 'r2', 'https://picsum.photos/seed/mg010d/600/900', 'content', 4, 20, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_010_05', 'gal_010', 'image', 'r2', 'https://picsum.photos/seed/mg010e/600/900', 'content', 5, 20, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_010_06', 'gal_010', 'image', 'r2', 'https://picsum.photos/seed/mg010f/600/900', 'content', 6, 20, 'completed', '2026-04-19T13:00:00Z');

-- ===== 添加视频类型标签到部分图库（用于视频专区展示） =====
INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES
  ('gal_006', 'tag_ct_video'),
  ('gal_010', 'tag_ct_video'),
  ('gal_015', 'tag_ct_video');

-- 添加视频类型的媒体资源
INSERT OR IGNORE INTO media_assets (id, gallery_id, type, storage, r2_key, role, sort_order, required_rank, upload_status, created_at)
VALUES
  ('ma_006_v1', 'gal_006', 'video', 'r2', 'videos/gal006-preview.mp4', 'preview', 10, 0, 'completed', '2026-04-23T16:00:00Z'),
  ('ma_010_v1', 'gal_010', 'video', 'r2', 'videos/gal010-preview.mp4', 'preview', 10, 0, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_010_v2', 'gal_010', 'video', 'r2', 'videos/gal010-full.mp4', 'full', 11, 20, 'completed', '2026-04-19T13:00:00Z'),
  ('ma_015_v1', 'gal_015', 'video', 'r2', 'videos/gal015-preview.mp4', 'preview', 10, 0, 'completed', '2026-04-14T15:00:00Z');

-- ===== 初始人气数据 =====
-- 保留真实更高计数，只给演示内容补足热榜和卡片展示所需的初始热度。
UPDATE galleries
SET
  view_count = MAX(COALESCE(view_count, 0), CASE id
    WHEN 'gal_001' THEN 16880
    WHEN 'gal_002' THEN 14320
    WHEN 'gal_003' THEN 12860
    WHEN 'gal_004' THEN 11240
    WHEN 'gal_005' THEN 9860
    WHEN 'gal_006' THEN 8320
    WHEN 'gal_007' THEN 7240
    WHEN 'gal_008' THEN 6180
    WHEN 'gal_009' THEN 5420
    WHEN 'gal_010' THEN 4860
    WHEN 'gal_011' THEN 3920
    WHEN 'gal_012' THEN 3180
    WHEN 'gal_013' THEN 2860
    WHEN 'gal_014' THEN 2410
    WHEN 'gal_015' THEN 2180
    WHEN 'gal_016' THEN 1760
    ELSE COALESCE(view_count, 0)
  END),
  like_count = MAX(COALESCE(like_count, 0), CASE id
    WHEN 'gal_001' THEN 326
    WHEN 'gal_002' THEN 284
    WHEN 'gal_003' THEN 241
    WHEN 'gal_004' THEN 219
    WHEN 'gal_005' THEN 186
    WHEN 'gal_006' THEN 158
    WHEN 'gal_007' THEN 132
    WHEN 'gal_008' THEN 117
    WHEN 'gal_009' THEN 96
    WHEN 'gal_010' THEN 82
    WHEN 'gal_011' THEN 64
    WHEN 'gal_012' THEN 48
    WHEN 'gal_013' THEN 42
    WHEN 'gal_014' THEN 36
    WHEN 'gal_015' THEN 31
    WHEN 'gal_016' THEN 24
    ELSE COALESCE(like_count, 0)
  END),
  updated_at = datetime('now')
WHERE id IN (
  'gal_001', 'gal_002', 'gal_003', 'gal_004',
  'gal_005', 'gal_006', 'gal_007', 'gal_008',
  'gal_009', 'gal_010', 'gal_011', 'gal_012',
  'gal_013', 'gal_014', 'gal_015', 'gal_016'
);

-- ===== 测试用户 =====
-- 密码: test123456（PBKDF2 哈希需要在运行时生成，这里用占位符）
-- 管理员用户通过 API 创建更安全
