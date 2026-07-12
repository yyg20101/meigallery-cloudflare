ALTER TABLE meta_connection_verifications
  ADD COLUMN revision TEXT
  CHECK (
    revision IS NULL
    OR (length(revision) = 32 AND revision NOT GLOB '*[^0-9a-f]*')
  );

CREATE UNIQUE INDEX idx_meta_connection_verifications_revision
  ON meta_connection_verifications(revision)
  WHERE revision IS NOT NULL;

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN meta_connection_revision TEXT
  CHECK (
    meta_connection_revision IS NULL
    OR (
      length(meta_connection_revision) = 32
      AND meta_connection_revision NOT GLOB '*[^0-9a-f]*'
    )
  );
