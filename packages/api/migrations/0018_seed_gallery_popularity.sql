-- 给已发布图库补充初始浏览基线，避免上线初期热榜和卡片计数全部为 0。
-- 只抬高低于基线的浏览量，不覆盖已经积累的真实浏览数据。
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
    MAX(1200, 18000 - rank_no * 260 + (rank_no % 7) * 73) AS baseline_view_count
  FROM ranked_published
)
UPDATE galleries
SET
  view_count = MAX(
    COALESCE(view_count, 0),
    (SELECT baseline_view_count FROM popularity_baselines WHERE popularity_baselines.id = galleries.id)
  ),
  updated_at = CASE
    WHEN COALESCE(view_count, 0) < (
      SELECT baseline_view_count FROM popularity_baselines WHERE popularity_baselines.id = galleries.id
    )
    THEN datetime('now')
    ELSE updated_at
  END
WHERE id IN (SELECT id FROM popularity_baselines);
