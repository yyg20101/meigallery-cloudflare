-- contact_method_click 属于强制保留的关键原始事件，可以作为有效联系日报的唯一事实源。
-- 旧版曾按 UTC 日期增量写入，导致北京时间趋势错位；这里仅重建完整保留的联系事件，
-- 不使用抽样的页面浏览事件覆盖其全量聚合。
DELETE FROM analytics_daily_events
WHERE event_name = 'contact_method_click';

INSERT INTO analytics_daily_events (
  date, event_name, entity_type, entity_id, event_count, visitor_count,
  session_count, user_count, value_total, updated_at
)
SELECT
  date(datetime(occurred_at, '+8 hours')),
  event_name,
  entity_type,
  entity_id,
  COUNT(*),
  COUNT(DISTINCT visitor_id),
  COUNT(DISTINCT session_id),
  COUNT(DISTINCT user_id),
  COALESCE(SUM(value), 0),
  datetime('now')
FROM analytics_events
WHERE event_name = 'contact_method_click'
GROUP BY
  date(datetime(occurred_at, '+8 hours')),
  event_name,
  entity_type,
  entity_id;

-- 来源点击日报只保存具有来源维度的点击，direct 且没有来源名/邀请码的记录按既有契约排除。
-- contact_method_click 的 event_props 不暴露 element_id，写入时会回退到事件名。
DELETE FROM analytics_source_click_daily
WHERE element_id = 'contact_method_click';

INSERT INTO analytics_source_click_daily (
  date, source_channel, source_name, invite_code_id,
  element_id, element_type, location, target_type, target_id,
  raw_click_count, effective_click_count, duplicate_click_count,
  visitor_count, session_count, user_count, exposure_session_count, updated_at
)
WITH contact_events AS (
  SELECT
    date(datetime(event.occurred_at, '+8 hours')) AS date,
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id,
    'contact_method_click' AS element_id,
    'contact_method_click' AS element_type,
    COALESCE(
      NULLIF(
        CASE
          WHEN json_valid(event.event_props)
          THEN json_extract(event.event_props, '$.location')
          ELSE ''
        END,
        ''
      ),
      event.route_name
    ) AS location,
    event.entity_type AS target_type,
    event.entity_id AS target_id,
    event.visitor_id,
    event.session_id,
    event.user_id
  FROM analytics_events AS event
  JOIN analytics_session_summaries AS summary
    ON summary.session_id = event.session_id
  WHERE event.event_name = 'contact_method_click'
    AND (
      summary.source_channel != 'direct'
      OR summary.invite_code_id != ''
      OR (summary.source_name != '' AND summary.source_name != 'direct')
    )
)
SELECT
  date,
  source_channel,
  source_name,
  invite_code_id,
  element_id,
  element_type,
  location,
  target_type,
  target_id,
  COUNT(*),
  COUNT(*),
  0,
  COUNT(DISTINCT visitor_id),
  COUNT(DISTINCT session_id),
  COUNT(DISTINCT user_id),
  0,
  datetime('now')
FROM contact_events
GROUP BY
  date, source_channel, source_name, invite_code_id,
  element_id, element_type, location, target_type, target_id;
