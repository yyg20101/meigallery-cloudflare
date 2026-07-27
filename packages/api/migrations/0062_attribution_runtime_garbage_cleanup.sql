DELETE FROM attribution_quality_snapshots
WHERE EXISTS (
  SELECT 1
  FROM attribution_platform_connections AS connection
  WHERE connection.id = attribution_quality_snapshots.connection_id
    AND julianday(attribution_quality_snapshots.collected_at) < julianday(connection.updated_at)
);

DROP TABLE IF EXISTS attribution_usage_daily;
