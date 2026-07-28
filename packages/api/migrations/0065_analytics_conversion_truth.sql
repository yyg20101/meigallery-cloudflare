-- Contact / CompleteRegistration 只由 attribution_conversion_facts 持有。
-- 清除旧前端分析事件曾累加出的第二套转化计数；流量和点击行为数据保持不变。

CREATE INDEX IF NOT EXISTS idx_attribution_conversion_facts_occurred_event
  ON attribution_conversion_facts(occurred_at, canonical_event);

DELETE FROM analytics_events
WHERE event_name = 'register_success';

DELETE FROM analytics_daily_events
WHERE event_name = 'register_success';

UPDATE analytics_session_summaries
SET
  contact_click_count = 0,
  register_success_count = 0,
  updated_at = datetime('now')
WHERE contact_click_count != 0 OR register_success_count != 0;

UPDATE analytics_daily_sources
SET
  contact_click_count = 0,
  register_count = 0,
  updated_at = datetime('now')
WHERE contact_click_count != 0 OR register_count != 0;

UPDATE analytics_daily_pages
SET
  contact_click_count = 0,
  register_count = 0,
  updated_at = datetime('now')
WHERE contact_click_count != 0 OR register_count != 0;

UPDATE analytics_source_page_daily
SET
  contact_click_count = 0,
  register_count = 0,
  updated_at = datetime('now')
WHERE contact_click_count != 0 OR register_count != 0;

UPDATE analytics_path_edges
SET
  conversion_count = 0,
  updated_at = datetime('now')
WHERE conversion_count != 0;
