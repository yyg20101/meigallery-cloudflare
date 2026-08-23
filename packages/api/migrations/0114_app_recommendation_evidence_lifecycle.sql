-- Recommendation-6：推荐解释证据的物理到期清理与账号注销定位索引。
--
-- 本 migration 不启用证据记录、不决定保留天数，也不创建真实会话。清理执行器只有在
-- 0083 的 retention decision 与 purge 门禁完整时才会删除 expires_at 已到期的会话。

CREATE INDEX idx_app_recommendation_sessions_account_hash
  ON app_recommendation_sessions(account_hash, expires_at, session_id);

-- 0083 的顺序 CHECK 对非法日期会得到 NULL；补充写入时的严格 UTC 时间格式与可解析性。
CREATE TRIGGER trg_app_recommendation_session_time_guard
BEFORE INSERT ON app_recommendation_sessions
WHEN NEW.created_at NOT GLOB '????-??-??T??:??:??.???Z'
  OR NEW.expires_at NOT GLOB '????-??-??T??:??:??.???Z'
  OR julianday(NEW.created_at) IS NULL
  OR julianday(NEW.expires_at) IS NULL
  OR datetime(NEW.expires_at) <= datetime(NEW.created_at)
BEGIN
  SELECT RAISE(ABORT, 'recommendation_session_time_invalid');
END;

-- 会话及分页追加项在到期或账号注销删除前保持不可改写；分页仍可追加新 item。
CREATE TRIGGER trg_app_recommendation_session_immutable
BEFORE UPDATE ON app_recommendation_sessions
BEGIN
  SELECT RAISE(ABORT, 'recommendation_session_immutable');
END;

CREATE TRIGGER trg_app_recommendation_session_item_immutable
BEFORE UPDATE ON app_recommendation_session_items
BEGIN
  SELECT RAISE(ABORT, 'recommendation_session_item_immutable');
END;
