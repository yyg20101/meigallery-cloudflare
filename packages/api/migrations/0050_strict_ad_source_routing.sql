ALTER TABLE analytics_tracking_sources
  ADD COLUMN ad_provider TEXT NOT NULL DEFAULT ''
  CHECK (ad_provider IN ('', 'meta', 'tiktok'));

ALTER TABLE analytics_conversion_actions
  ADD COLUMN attribution_provider TEXT NOT NULL DEFAULT ''
  CHECK (attribution_provider IN ('', 'meta', 'tiktok'));

-- 历史广告来源没有可信平台归属，禁止按名称猜测；停用后由后台明确重建。
UPDATE analytics_tracking_sources
SET status = 'disabled', updated_at = datetime('now')
WHERE channel = 'ad' AND ad_provider = '';

CREATE INDEX idx_tracking_sources_ad_provider
  ON analytics_tracking_sources(ad_provider, status, created_at);

CREATE INDEX idx_conversion_actions_attribution_provider
  ON analytics_conversion_actions(attribution_provider, date, action_type);

-- 新投递必须与业务事实上的可信来源一致，绕过应用服务也不能跨平台写入。
CREATE TRIGGER trg_0050_delivery_provider_insert_guard
BEFORE INSERT ON analytics_conversion_deliveries
WHEN COALESCE((
  SELECT attribution_provider
  FROM analytics_conversion_actions
  WHERE id = NEW.conversion_action_id
), '') <> ''
AND (
  SELECT attribution_provider
  FROM analytics_conversion_actions
  WHERE id = NEW.conversion_action_id
) <> NEW.provider
BEGIN
  SELECT RAISE(ABORT, 'AD_PROVIDER_SOURCE_MISMATCH');
END;

CREATE TRIGGER trg_0050_delivery_provider_update_guard
BEFORE UPDATE OF provider, conversion_action_id ON analytics_conversion_deliveries
WHEN COALESCE((
  SELECT attribution_provider
  FROM analytics_conversion_actions
  WHERE id = NEW.conversion_action_id
), '') <> ''
AND (
  SELECT attribution_provider
  FROM analytics_conversion_actions
  WHERE id = NEW.conversion_action_id
) <> NEW.provider
BEGIN
  SELECT RAISE(ABORT, 'AD_PROVIDER_SOURCE_MISMATCH');
END;

CREATE TRIGGER trg_0050_action_provider_immutable
BEFORE UPDATE OF attribution_provider ON analytics_conversion_actions
WHEN OLD.attribution_provider <> NEW.attribution_provider
BEGIN
  SELECT RAISE(ABORT, 'AD_PROVIDER_SOURCE_IMMUTABLE');
END;
