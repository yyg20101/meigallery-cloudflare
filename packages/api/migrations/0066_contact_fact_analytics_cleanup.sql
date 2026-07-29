-- Contact 只由 attribution_conversion_facts 提供。删除旧行为流中的重复记录与派生聚合，
-- 不补造历史事实，也不修改任何平台凭证或投递状态。

UPDATE analytics_session_summaries
SET click_count = MAX(
      0,
      click_count - (
        SELECT COUNT(*)
        FROM analytics_events event
        WHERE event.session_id = analytics_session_summaries.session_id
          AND event.event_name = 'contact_method_click'
      )
    ),
    updated_at = datetime('now')
WHERE EXISTS (
  SELECT 1
  FROM analytics_events event
  WHERE event.session_id = analytics_session_summaries.session_id
    AND event.event_name = 'contact_method_click'
);

UPDATE analytics_sessions
SET event_count = MAX(
      0,
      event_count - (
        SELECT COUNT(*)
        FROM analytics_events event
        WHERE event.session_id = analytics_sessions.id
          AND event.event_name = 'contact_method_click'
      )
    ),
    updated_at = datetime('now')
WHERE EXISTS (
  SELECT 1
  FROM analytics_events event
  WHERE event.session_id = analytics_sessions.id
    AND event.event_name = 'contact_method_click'
);

DELETE FROM analytics_events
WHERE event_name = 'contact_method_click';

DELETE FROM analytics_daily_events
WHERE event_name = 'contact_method_click';

DELETE FROM analytics_click_daily
WHERE element_id = 'contact_method_click';

DELETE FROM analytics_source_click_daily
WHERE element_id = 'contact_method_click';

UPDATE analytics_invite_daily
SET contact_click_count = 0,
    updated_at = datetime('now')
WHERE contact_click_count != 0;

DROP TRIGGER IF EXISTS analytics_contact_event_insert_guard;
CREATE TRIGGER analytics_contact_event_insert_guard
BEFORE INSERT ON analytics_events
WHEN NEW.event_name = 'contact_method_click'
BEGIN
  SELECT RAISE(ABORT, 'ANALYTICS_CONTACT_EVENT_REMOVED');
END;
