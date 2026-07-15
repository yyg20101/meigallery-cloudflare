INSERT OR IGNORE INTO attribution_conversion_facts (
  id,
  canonical_event,
  fact_origin,
  external_event_id,
  attribution_provider,
  attribution_source,
  attribution_context_id,
  occurred_at,
  dedupe_key,
  consent_snapshot_json,
  analytics_dimensions_json,
  created_at
)
SELECT
  action.id,
  CASE action.action_type
    WHEN 'contact' THEN 'Contact'
    WHEN 'complete_registration' THEN 'CompleteRegistration'
  END,
  'historical_backfill',
  NULL,
  CASE
    WHEN action.attribution_provider IN ('meta', 'tiktok', 'google') THEN action.attribution_provider
    ELSE NULL
  END,
  CASE
    WHEN action.attribution_provider IN ('meta', 'tiktok', 'google') THEN 'historical_backfill'
    ELSE 'none'
  END,
  NULL,
  action.occurred_at,
  action.dedupe_key,
  json_object(
    'consentVersion', 1,
    'marketingAllowed', json('false'),
    'adUserDataAllowed', json('false'),
    'adPersonalizationAllowed', json('false'),
    'decidedAt', action.occurred_at
  ),
  json_object(
    'visitorId', action.visitor_id,
    'sessionId', action.session_id,
    'userId', action.user_id,
    'routeName', action.route_name,
    'path', action.path,
    'sourceChannel', action.source_channel,
    'sourceName', action.source_name,
    'trackingSourceSlug', action.tracking_source_slug,
    'utmSource', action.utm_source,
    'utmMedium', action.utm_medium,
    'utmCampaign', action.utm_campaign,
    'utmContent', action.utm_content,
    'metadata', json(CASE WHEN json_valid(action.metadata) THEN action.metadata ELSE '{}' END),
    'methodType', action.method_type,
    'actionTarget', action.action_target
  ),
  action.created_at
FROM analytics_conversion_actions action
WHERE action.action_type IN ('contact', 'complete_registration');
