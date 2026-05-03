-- 图库互动数据：点赞计数与用户点赞关系
ALTER TABLE galleries ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS gallery_likes (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (gallery_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_galleries_like_count ON galleries(like_count);
CREATE INDEX IF NOT EXISTS idx_gallery_likes_user_id ON gallery_likes(user_id);
