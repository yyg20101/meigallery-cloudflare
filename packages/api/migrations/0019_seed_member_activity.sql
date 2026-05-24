-- 补充运营初始化用户与点赞关系，让公开点赞计数有对应用户数据支撑。
-- 这些账号不用于真实登录运营，通知默认关闭；会员记录仅在已有管理员/Owner 时补充。

WITH RECURSIVE seed_user_numbers(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seed_user_numbers WHERE n < 360
)
INSERT OR IGNORE INTO users (
  email,
  username,
  nickname,
  password_hash,
  role,
  status,
  email_verified,
  notification_enabled,
  created_at,
  updated_at
)
SELECT
  printf('seed-user-%03d@users.616618.xyz', n),
  printf('seeduser%03d', n),
  '社区用户' || printf('%03d', n),
  '$pbkdf2$100000$fD8J7MDYSn/4WjVs0y3kgA==$NehcVwZ56tXlUYdC4dAmxc9iwfFqp0l3WvfgZ2mG1pY=',
  'user',
  'active',
  1,
  0,
  datetime('now', printf('-%d days', 180 - (n % 120))),
  datetime('now', printf('-%d days', 180 - (n % 120)))
FROM seed_user_numbers;

WITH
granter AS (
  SELECT id
  FROM users
  WHERE role IN ('owner', 'admin')
  ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id
  LIMIT 1
),
vip_level AS (
  SELECT id FROM membership_levels WHERE code = 'vip' LIMIT 1
),
svip_level AS (
  SELECT id FROM membership_levels WHERE code = 'svip' LIMIT 1
)
INSERT OR IGNORE INTO user_memberships (
  id,
  user_id,
  level_id,
  starts_at,
  expires_at,
  note,
  granted_by,
  expiry_notified,
  created_at
)
SELECT
  'seed_membership_' || u.username,
  u.id,
  CASE
    WHEN CAST(substr(u.username, length('seeduser') + 1) AS INTEGER) <= 30 THEN svip_level.id
    ELSE vip_level.id
  END,
  datetime('now', '-30 days'),
  datetime('now', '+180 days'),
  '运营初始化用户会员数据',
  granter.id,
  0,
  datetime('now', '-30 days')
FROM users u
JOIN granter
JOIN vip_level
JOIN svip_level
WHERE u.username BETWEEN 'seeduser001' AND 'seeduser120';

WITH
ranked_galleries AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      ORDER BY COALESCE(published_at, created_at) DESC, id ASC
    ) AS rank_no
  FROM galleries
  WHERE status = 'published'
),
target_galleries AS (
  SELECT
    id,
    rank_no,
    MAX(18, 340 - rank_no * 4 + (rank_no % 5) * 3) AS target_like_count
  FROM ranked_galleries
  WHERE rank_no <= 72
),
seed_users AS (
  SELECT
    id,
    CAST(substr(username, length('seeduser') + 1) AS INTEGER) AS seed_no
  FROM users
  WHERE username BETWEEN 'seeduser001' AND 'seeduser360'
)
INSERT OR IGNORE INTO gallery_likes (
  id,
  gallery_id,
  user_id,
  created_at
)
SELECT
  'seed_like_' || target_galleries.id || '_' || printf('%03d', seed_users.seed_no),
  target_galleries.id,
  seed_users.id,
  datetime('now', printf('-%d minutes', target_galleries.rank_no * 37 + seed_users.seed_no))
FROM target_galleries
JOIN seed_users ON seed_users.seed_no <= target_galleries.target_like_count;

UPDATE galleries
SET
  like_count = (
    SELECT COUNT(*)
    FROM gallery_likes
    WHERE gallery_likes.gallery_id = galleries.id
  ),
  updated_at = datetime('now')
WHERE status = 'published';
