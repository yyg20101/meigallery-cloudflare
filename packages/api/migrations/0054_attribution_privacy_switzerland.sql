UPDATE attribution_privacy_policy
SET prior_consent_country_codes_json = json_insert(
      prior_consent_country_codes_json,
      '$[#]',
      'CH'
    ),
    policy_version = policy_version + 1,
    updated_at = datetime('now')
WHERE id = 'global'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(attribution_privacy_policy.prior_consent_country_codes_json)
    WHERE upper(CAST(value AS TEXT)) = 'CH'
  );
