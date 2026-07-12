ALTER TABLE meta_live_challenges
  ADD COLUMN registration_email_covered INTEGER NOT NULL DEFAULT 0
  CHECK (registration_email_covered IN (0, 1));

ALTER TABLE meta_live_challenges
  ADD COLUMN registration_external_id_covered INTEGER NOT NULL DEFAULT 0
  CHECK (registration_external_id_covered IN (0, 1));

ALTER TABLE meta_live_challenges
  ADD COLUMN contact_registration_identity_absent INTEGER NOT NULL DEFAULT 0
  CHECK (contact_registration_identity_absent IN (0, 1));
