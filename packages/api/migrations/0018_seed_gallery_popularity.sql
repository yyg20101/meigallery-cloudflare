-- 给已发布图库补充初始人气基线，避免上线初期热榜和卡片计数全部为 0。
-- 只抬高低于基线的计数，不覆盖已经积累的真实浏览和点赞数据。
WITH ranked_published AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      ORDER BY COALESCE(published_at, created_at) DESC, id ASC
    ) AS rank_no
  FROM galleries
  WHERE status = 'published'
),
popularity_baselines AS (
  SELECT
    id,
    CASE ((rank_no - 1) % 12)
      WHEN 0 THEN 16880
      WHEN 1 THEN 14320
      WHEN 2 THEN 12860
      WHEN 3 THEN 11240
      WHEN 4 THEN 9860
      WHEN 5 THEN 8320
      WHEN 6 THEN 7240
      WHEN 7 THEN 6180
      WHEN 8 THEN 5420
      WHEN 9 THEN 4860
      WHEN 10 THEN 3920
      ELSE 3180
    END AS baseline_view_count,
    CASE ((rank_no - 1) % 12)
      WHEN 0 THEN 326
      WHEN 1 THEN 284
      WHEN 2 THEN 241
      WHEN 3 THEN 219
      WHEN 4 THEN 186
      WHEN 5 THEN 158
      WHEN 6 THEN 132
      WHEN 7 THEN 117
      WHEN 8 THEN 96
      WHEN 9 THEN 82
      WHEN 10 THEN 64
      ELSE 48
    END AS baseline_like_count
  FROM ranked_published
)
UPDATE galleries
SET
  view_count = MAX(
    COALESCE(view_count, 0),
    (SELECT baseline_view_count FROM popularity_baselines WHERE popularity_baselines.id = galleries.id)
  ),
  like_count = MAX(
    COALESCE(like_count, 0),
    (SELECT baseline_like_count FROM popularity_baselines WHERE popularity_baselines.id = galleries.id)
  ),
  updated_at = CASE
    WHEN COALESCE(view_count, 0) < (
      SELECT baseline_view_count FROM popularity_baselines WHERE popularity_baselines.id = galleries.id
    )
      OR COALESCE(like_count, 0) < (
        SELECT baseline_like_count FROM popularity_baselines WHERE popularity_baselines.id = galleries.id
      )
    THEN datetime('now')
    ELSE updated_at
  END
WHERE id IN (SELECT id FROM popularity_baselines);
