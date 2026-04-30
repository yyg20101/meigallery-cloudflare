-- 图库浏览量统计（用于 hot sort）
ALTER TABLE galleries ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_galleries_view_count ON galleries(view_count);
