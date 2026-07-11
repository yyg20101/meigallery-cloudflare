-- 将每条 Dataset Quality 快照绑定到 Owner 批准的精确 contract 内容。
ALTER TABLE meta_dataset_quality_snapshots
  ADD COLUMN contract_digest TEXT NOT NULL DEFAULT ''
  CHECK (
    contract_digest = ''
    OR (
      length(contract_digest) = 71
      AND substr(contract_digest, 1, 7) = 'sha256:'
      AND substr(contract_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE INDEX idx_meta_dataset_quality_contract
  ON meta_dataset_quality_snapshots(
    environment,
    contract_version,
    contract_digest,
    event_name,
    collected_at
  );
