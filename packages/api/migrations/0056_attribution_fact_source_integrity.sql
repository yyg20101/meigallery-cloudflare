-- 旧版曾允许仅凭 UTM 推测广告平台。最终架构只接受 click ID 或已验证管理链接，
-- 因此从活跃事实源移除不可信归因；历史仍保存在 migration 前 D1 备份与 Time Travel 中。
DELETE FROM attribution_provider_receipts
WHERE delivery_id IN (
  SELECT delivery.id
  FROM attribution_deliveries AS delivery
  JOIN attribution_conversion_facts AS fact ON fact.id = delivery.fact_id
  WHERE (
    fact.attribution_provider IS NULL
    AND fact.attribution_source NOT IN ('none', 'conflict')
  ) OR (
    fact.attribution_provider IS NOT NULL
    AND (
      fact.attribution_provider NOT IN ('meta', 'tiktok', 'google')
      OR fact.attribution_source NOT IN ('click_id', 'managed_link')
    )
  )
);

DELETE FROM attribution_outbox
WHERE delivery_id IN (
  SELECT delivery.id
  FROM attribution_deliveries AS delivery
  JOIN attribution_conversion_facts AS fact ON fact.id = delivery.fact_id
  WHERE (
    fact.attribution_provider IS NULL
    AND fact.attribution_source NOT IN ('none', 'conflict')
  ) OR (
    fact.attribution_provider IS NOT NULL
    AND (
      fact.attribution_provider NOT IN ('meta', 'tiktok', 'google')
      OR fact.attribution_source NOT IN ('click_id', 'managed_link')
    )
  )
);

DELETE FROM attribution_deliveries
WHERE fact_id IN (
  SELECT id
  FROM attribution_conversion_facts
  WHERE (
    attribution_provider IS NULL
    AND attribution_source NOT IN ('none', 'conflict')
  ) OR (
    attribution_provider IS NOT NULL
    AND (
      attribution_provider NOT IN ('meta', 'tiktok', 'google')
      OR attribution_source NOT IN ('click_id', 'managed_link')
    )
  )
);

DELETE FROM attribution_conversion_facts
WHERE (
  attribution_provider IS NULL
  AND attribution_source NOT IN ('none', 'conflict')
) OR (
  attribution_provider IS NOT NULL
  AND (
    attribution_provider NOT IN ('meta', 'tiktok', 'google')
    OR attribution_source NOT IN ('click_id', 'managed_link')
  )
);

CREATE TRIGGER attribution_fact_source_insert_guard
BEFORE INSERT ON attribution_conversion_facts
WHEN (
  NEW.attribution_provider IS NULL
  AND NEW.attribution_source NOT IN ('none', 'conflict')
) OR (
  NEW.attribution_provider IS NOT NULL
  AND (
    NEW.attribution_provider NOT IN ('meta', 'tiktok', 'google')
    OR NEW.attribution_source NOT IN ('click_id', 'managed_link')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_FACT_SOURCE_INVALID');
END;

CREATE TRIGGER attribution_fact_source_update_guard
BEFORE UPDATE OF attribution_provider, attribution_source ON attribution_conversion_facts
WHEN (
  NEW.attribution_provider IS NULL
  AND NEW.attribution_source NOT IN ('none', 'conflict')
) OR (
  NEW.attribution_provider IS NOT NULL
  AND (
    NEW.attribution_provider NOT IN ('meta', 'tiktok', 'google')
    OR NEW.attribution_source NOT IN ('click_id', 'managed_link')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_FACT_SOURCE_INVALID');
END;
